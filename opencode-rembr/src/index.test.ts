import { describe, it, expect, vi, beforeEach } from "vitest"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import RembrPluginDefault, { RembrPlugin } from "./index.js"

function toolResult(text: string) {
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  )
}

function makeOpencodeClient() {
  return {
    app: { log: vi.fn().mockResolvedValue({}) },
    session: {
      get: vi.fn().mockResolvedValue({ data: { title: "Fix OAuth token refresh" } }),
      messages: vi.fn().mockResolvedValue({
        data: [
          { info: { role: "user" }, parts: [{ type: "text", text: "fix the bug" }] },
          { info: { role: "assistant" }, parts: [{ type: "text", text: "Fixed by rotating the refresh token." }] },
        ],
      }),
    },
  }
}

function makeInput(client = makeOpencodeClient()) {
  return { client, directory: "/proj", worktree: "/proj" } as never
}

const PLUGIN_OPTIONS = { apiKey: "test-key", url: "https://rembr.test/mcp" }

/** Last fetch call made to the Rembr /mcp endpoint (skips /health). */
function lastMcpBody(fetchMock: ReturnType<typeof vi.fn>) {
  const call = [...fetchMock.mock.calls].reverse().find(([url]) => String(url).endsWith("/mcp"))
  return call ? JSON.parse(call[1].body) : undefined
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  // Isolate from the host machine: a developer's real REMBR_* variables must
  // not leak into plugin config under test.
  vi.stubEnv("REMBR_API_KEY", "")
  vi.stubEnv("REMBR_URL", "")
  vi.stubEnv("REMBR_DISTILL", "false")
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("ok")))
})

describe("RembrPlugin", () => {
  it("exports the plugin as the default module entry point", () => {
    expect(RembrPluginDefault).toBe(RembrPlugin)
  })

  it("registers the three curated tools", async () => {
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    expect(Object.keys(hooks.tool ?? {})).toEqual(["rembr_remember", "rembr_recall", "rembr_forget"])
  })

  it("tools explain how to configure when no API key is set", async () => {
    const hooks = await RembrPlugin(makeInput(), { url: "https://rembr.test/mcp" })
    const result = await hooks.tool!.rembr_remember.execute({ content: "x" } as never, {} as never)
    expect(String(result)).toContain("REMBR_API_KEY")
    // and no fetch was attempted
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).endsWith("/mcp"))).toBe(true)
  })

  it("rembr_remember stores with category and source metadata", async () => {
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const result = await hooks.tool!.rembr_remember.execute(
      { content: "prefer pnpm", category: "preferences" } as never,
      {} as never,
    )
    expect(result).toBe("ok")
    const body = lastMcpBody(vi.mocked(fetch))
    expect(body.params.name).toBe("memory")
    expect(body.params.arguments).toMatchObject({
      operation: "create",
      content: "prefer pnpm",
      category: "preferences",
      metadata: { source: "opencode-rembr", directory: "/proj" },
    })
  })

  it("rembr_recall returns a friendly message when nothing matches", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("")))
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const result = await hooks.tool!.rembr_recall.execute({ query: "anything" } as never, {} as never)
    expect(result).toBe("No matching memories found.")
  })

  it("tool errors are returned as strings, not thrown", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")))
    const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
    const result = await hooks.tool!.rembr_recall.execute({ query: "x" } as never, {} as never)
    expect(String(result)).toContain("Failed to search memories")
  })

  describe("chat.message recall injection", () => {
    it("injects recalled memories once per session", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("- [mem_1] user prefers tabs")))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)

      const output = {
        message: { id: "msg_1", sessionID: "ses_1" },
        parts: [{ type: "text", text: "help me format this file" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_1" } as never, output as never)

      expect(output.parts).toHaveLength(3)
      const statusPart = output.parts[1] as { text: string; synthetic?: boolean }
      expect(statusPart.text).toContain("Rembr: injected 1 relevant memory")
      expect(statusPart.text).toContain("user prefers tabs")
      expect(statusPart.synthetic).toBeUndefined()
      const injectedPart = output.parts[2] as { id: string; text: string; synthetic?: boolean }
      expect(injectedPart.id).toMatch(/^prt/)
      expect(injectedPart.synthetic).toBe(true)
      expect(injectedPart.text).toContain("<rembr-memories>")
      expect(injectedPart.text).toContain("user prefers tabs")

      // second message in the same session: no further injection
      const output2 = {
        message: { id: "msg_2", sessionID: "ses_1" },
        parts: [{ type: "text", text: "now run the tests" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_1" } as never, output2 as never)
      expect(output2.parts).toHaveLength(1)
    })

    it("uses recent workspace context for a vague status prompt with a Teams URL", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "old-project", category: "projects", content: "Older project state.", created_at: "2026-07-10T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "current-project", category: "projects", content: "Current Rembr starter injection work is ready for review.", created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "other-project", category: "projects", content: "Other workspace status.", created_at: "2026-07-14T11:00:00Z", metadata: { directory: "/other" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_status", sessionID: "ses_status" },
        parts: [{
          type: "text",
          text: "Okay, let's share current status with Ben https://teams.microsoft.com/l/message/example, draft concise information about what was done",
        }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_status" } as never, output as never)

      expect((output.parts[1] as { text: string }).text).toContain("continuity prompt; injected 2 recent context memories")
      expect((output.parts[1] as { text: string }).text.indexOf("Current Rembr")).toBeLessThan((output.parts[1] as { text: string }).text.indexOf("Older project"))
      expect((output.parts[1] as { text: string }).text).not.toContain("Other workspace status")
      const mcpBodies = vi.mocked(fetch).mock.calls
        .filter(([url]) => String(url).endsWith("/mcp"))
        .map((call) => JSON.parse(call[1].body))
      expect(mcpBodies).toHaveLength(1)
      expect(mcpBodies[0].params).toMatchObject({ name: "memory", arguments: { operation: "list", limit: 50 } })
    })

    it("does not repeat near-duplicate memories in recent continuity context", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "newest", category: "decisions", content: "Use semantic recall with workspace context for a resumed session.", created_at: "2026-07-14T16:00:00Z", metadata: { directory: "/proj" } },
          { id: "duplicate", category: "decisions", content: "Use workspace context with semantic recall when a session is resumed.", created_at: "2026-07-14T15:00:00Z", metadata: { directory: "/proj" } },
          { id: "preference", category: "preferences", content: "Keep the five-memory context budget while improving relevance.", created_at: "2026-07-14T14:00:00Z", metadata: { directory: "/proj" } },
          { id: "other", category: "projects", content: "The local console runs through Docker Compose on port 8081.", created_at: "2026-07-14T13:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_diverse", sessionID: "ses_diverse" },
        parts: [{ type: "text", text: "Okay, let's see how it works." }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_diverse" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("injected 3 recent context memories")
      expect(status).toContain("Use semantic recall")
      expect(status).not.toContain("Use workspace context with semantic recall")
      expect(status).toContain("five-memory context budget")
      expect(status).toContain("local console")
    })

    it("uses continuity for an underspecified conversational opener", async () => {
      const recentJson = JSON.stringify({
        success: true,
        data: [
          { id: "current", category: "projects", content: "Current OpenCode Rembr ranking work is ready to validate.", created_at: "2026-07-14T15:00:00Z", metadata: { directory: "/proj" } },
          { id: "codex", category: "facts", content: "Codex recall implementation detail.", created_at: "2026-07-14T16:00:00Z", metadata: { directory: "/other" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(recentJson)),
      ))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_restart", sessionID: "ses_restart" },
        parts: [{ type: "text", text: "Okay, let's see how it works." }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_restart" } as never, output as never)

      expect((output.parts[1] as { text: string }).text).toContain("continuity prompt; injected 1 recent context memory")
      expect((output.parts[1] as { text: string }).text).toContain("Current OpenCode Rembr ranking work")
      expect((output.parts[1] as { text: string }).text).not.toContain("Codex recall")

      const anotherOpener = {
        message: { id: "msg_after_restart", sessionID: "ses_after_restart" },
        parts: [{ type: "text", text: "Can we carry on from before?" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_after_restart" } as never, anotherOpener as never)
      expect((anotherOpener.parts[1] as { text: string }).text).toContain("continuity prompt; injected 1 recent context memory")
    })

    it("removes URLs and reranks structured results by semantic similarity", async () => {
      const results = JSON.stringify({
        success: true,
        data: [
          { id: "graph-winner", category: "facts", content: "Graph-boosted but weak result.", score: 0.9, semantic_similarity: 0.31 },
          { id: "semantic-winner", category: "projects", content: "Relevant semantic result.", score: 0.4, semantic_similarity: 0.62, metadata: { directory: "/proj" } },
          { id: "semantic-near", category: "decisions", content: "Closely related result.", score: 0.3, semantic_similarity: 0.57 },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_rank", sessionID: "ses_rank" },
        parts: [{ type: "text", text: "Draft guidance for https://example.test/private/path about Rembr search ranking" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_rank" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("injected 2 relevant memories")
      expect(status.indexOf("Relevant semantic result")).toBeLessThan(status.indexOf("Closely related result"))
      expect(status).not.toContain("Graph-boosted but weak result")
      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.arguments.query).toBe("Draft guidance for about Rembr search ranking")
      expect(body.params.arguments.limit).toBe(20)
    })

    it("keeps five detailed memories while demoting an older overlapping decision", async () => {
      const longDetail = "x".repeat(300)
      const results = JSON.stringify({
        success: true,
        data: [
          { id: "ui-current", category: "facts", content: `OpenCode Rembr injects detailed model context and a visible status preview. ${longDetail}`, semantic_similarity: 0.60, created_at: "2026-07-13T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "old-decision", category: "decisions", content: "The Rembr OpenCode starter recall uses semantic matches and injects three compact memories for continuity context.", semantic_similarity: 0.61, created_at: "2026-07-10T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "new-decision", category: "decisions", content: "The Rembr OpenCode starter recall uses semantic matches and injects five compact memories for continuity context with URL removal and raw similarity reranking.", semantic_similarity: 0.57, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "preview", category: "projects", content: "OpenCode shows compact Rembr memory previews while retaining detailed synthetic context.", semantic_similarity: 0.56, created_at: "2026-07-13T11:00:00Z", metadata: { directory: "/proj" } },
          { id: "preference", category: "preferences", content: "Retain the five-memory Rembr context budget while improving ranking quality.", semantic_similarity: 0.55, created_at: "2026-07-14T11:00:00Z", metadata: { directory: "/proj" } },
          { id: "codex", category: "facts", content: "Codex UserPromptSubmit injects Rembr context through additionalContext.", semantic_similarity: 0.59, created_at: "2026-07-13T12:00:00Z", metadata: { directory: "/proj" } },
          { id: "ranking", category: "insights", content: "Rembr semantic ranking should resist graph-score noise.", semantic_similarity: 0.54, created_at: "2026-07-14T09:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_quality", sessionID: "ses_quality" },
        parts: [{ type: "text", text: "What Rembr features inject context into my OpenCode prompt?" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_quality" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      const injected = (output.parts[2] as { text: string }).text
      expect(status).toContain("injected 5 relevant memories")
      expect(injected).toContain("injects five compact memories")
      expect(injected).not.toContain("injects three compact memories")
      expect(injected).toContain(longDetail)
    })

    it("does not pad a specific operational prompt with weaker adjacent memories", async () => {
      const results = JSON.stringify({
        success: true,
        data: [
          { id: "console", category: "facts", content: "A local rembr-console package exists at C:\\Source\\Repos\\rembr\\rembr-console; it is a lightweight local proxy/static UI and not Mark's published Rembr UI.", semantic_similarity: 0.82, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "recall", category: "facts", content: "The OpenCode Rembr plugin injects searchable long-term memories into the first prompt.", semantic_similarity: 0.69, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
          { id: "capture", category: "facts", content: "OpenCode Rembr idle distillation captures durable session outcomes.", semantic_similarity: 0.67, created_at: "2026-07-14T10:00:00Z", metadata: { directory: "/proj" } },
        ],
      })
      vi.stubGlobal("fetch", vi.fn().mockImplementation((url) =>
        Promise.resolve(String(url).endsWith("/health")
          ? new Response("ok", { status: 200 })
          : toolResult(results)),
      ))
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, minSimilarity: 0.3 })
      const output = {
        message: { id: "msg_console", sessionID: "ses_console" },
        parts: [{ type: "text", text: "Why rembr ui is down, please wire it into C:\\Source\\Repos\\ai-work\\local-deployment\\docker-compose.yml and run it" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_console" } as never, output as never)

      const status = (output.parts[1] as { text: string }).text
      expect(status).toContain("injected 1 relevant memory")
      expect(status).toContain("local rembr-console package")
      expect(status).not.toContain("idle distillation")
    })

    it("does not inject when recall returns nothing", async () => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(toolResult("")))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_1", sessionID: "ses_2" },
        parts: [{ type: "text", text: "hello" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_2" } as never, output as never)
      expect(output.parts).toHaveLength(1)
    })

    it("injects compact recent context when semantic recall returns an empty JSON result set", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(new Response("ok", { status: 200 }))
        .mockResolvedValueOnce(toolResult('{"success":true,"data":[]}'))
        .mockResolvedValueOnce(toolResult('{"success":true,"data":[{"id":"fact-001","category":"facts","content":"A generic fact.","metadata":{"directory":"/proj"}},{"id":"decision-001","category":"decisions","content":"Use Syft for SBOM generation.","metadata":{"directory":"/proj"}},{"id":"other-001","category":"reminders","content":"Other workspace reminder.","metadata":{"directory":"/other"}}]}')))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_empty", sessionID: "ses_empty" },
        parts: [{ type: "text", text: "Find the SBOM generation decision" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_empty" } as never, output as never)

      expect(output.parts).toHaveLength(3)
      expect((output.parts[1] as { text: string }).text).toContain("no prompt matches; injected 2 recent context memories")
      expect((output.parts[1] as { text: string }).text).toContain("Use Syft for SBOM generation.")
      expect((output.parts[1] as { text: string }).text).not.toContain("Other workspace reminder.")
      expect((output.parts[1] as { text: string }).text.indexOf("Use Syft for SBOM generation.")).toBeLessThan((output.parts[1] as { text: string }).text.indexOf("A generic fact."))
      expect((output.parts[2] as { text: string }).text).toContain("<rembr-recent-context>")
    })

    it("swallows recall failures and leaves the message untouched", async () => {
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("down")))
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      const output = {
        message: { id: "msg_1", sessionID: "ses_3" },
        parts: [{ type: "text", text: "hello" }],
      }
      await expect(hooks["chat.message"]!({ sessionID: "ses_3" } as never, output as never)).resolves.toBeUndefined()
      expect(output.parts).toHaveLength(1)
    })

    it("respects maxRecall: 0 as an off switch", async () => {
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, maxRecall: 0 })
      const output = {
        message: { id: "msg_1", sessionID: "ses_4" },
        parts: [{ type: "text", text: "hello" }],
      }
      await hooks["chat.message"]!({ sessionID: "ses_4" } as never, output as never)
      expect(output.parts).toHaveLength(1)
    })
  })

  describe("session.idle auto-capture", () => {
    const idleEvent = { type: "session.idle", properties: { sessionID: "ses_9" } }

    it("stores title + last assistant message on idle", async () => {
      const client = makeOpencodeClient()
      const hooks = await RembrPlugin(makeInput(client), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.name).toBe("memory")
      expect(body.params.arguments.operation).toBe("create")
      expect(body.params.arguments.content).toContain('OpenCode session "Fix OAuth token refresh"')
      expect(body.params.arguments.content).toContain("rotating the refresh token")
      expect(body.params.arguments.category).toBe("conversations")
      expect(body.params.arguments.metadata.sessionID).toBe("ses_9")
    })

    it("dedupes repeated idles with the same summary", async () => {
      const client = makeOpencodeClient()
      const hooks = await RembrPlugin(makeInput(client), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })
      const callsAfterFirst = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp")).length
      await hooks.event!({ event: idleEvent as never })
      const callsAfterSecond = vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp")).length

      expect(callsAfterSecond).toBe(callsAfterFirst)
    })

    it("does nothing when autoRemember is false", async () => {
      const hooks = await RembrPlugin(makeInput(), { ...PLUGIN_OPTIONS, autoRemember: false })
      await hooks.event!({ event: idleEvent as never })
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })

    it("ignores unrelated events", async () => {
      const hooks = await RembrPlugin(makeInput(), PLUGIN_OPTIONS)
      await hooks.event!({ event: { type: "session.created", properties: {} } as never })
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })
  })

  describe("session.idle distillation", () => {
    const idleEvent = { type: "session.idle", properties: { sessionID: "ses_d" } }

    function makeDistillClient(reply: string) {
      const client = makeOpencodeClient() as ReturnType<typeof makeOpencodeClient> & {
        session: ReturnType<typeof makeOpencodeClient>["session"] & {
          create: ReturnType<typeof vi.fn>
          prompt: ReturnType<typeof vi.fn>
          delete: ReturnType<typeof vi.fn>
        }
      }
      // Ten messages to clear the default debounce threshold.
      client.session.messages = vi.fn().mockResolvedValue({
        data: Array.from({ length: 10 }, (_, i) => ({
          info: { role: i % 2 ? "assistant" : "user" },
          parts: [{ type: "text", text: `message ${i}` }],
        })),
      })
      client.session.create = vi.fn().mockResolvedValue({ data: { id: "ses_side" } })
      client.session.prompt = vi.fn().mockResolvedValue({
        data: { info: { role: "assistant" }, parts: [{ type: "text", text: reply }] },
      })
      client.session.delete = vi.fn().mockResolvedValue({ data: true })
      return client
    }

    it("distills via a side session and stores the memories", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": [{"content": "Team prefers pnpm", "category": "preferences", "tags": []}]}')
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(client.session.create).toHaveBeenCalled()
      expect(client.session.prompt).toHaveBeenCalledWith(
        expect.objectContaining({ path: { id: "ses_side" } }),
      )
      expect(client.session.delete).toHaveBeenCalled()
      const body = lastMcpBody(vi.mocked(fetch))
      expect(body.params.arguments.content).toBe("Team prefers pnpm")
      expect(body.params.arguments.category).toBe("preferences")
      expect(body.params.arguments.metadata.distilled).toBe(true)
    })

    it("polls for the assistant when prompt returns the user message", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": [{"content": "OpenCode polling works", "category": "facts"}]}')
      const sourceMessages = Array.from({ length: 10 }, (_, i) => ({
        info: { role: i % 2 ? "assistant" : "user" },
        parts: [{ type: "text", text: `message ${i}` }],
      }))
      client.session.prompt.mockResolvedValue({
        data: { info: { role: "user" }, parts: [{ type: "text", text: "observer prompt" }] },
      })
      client.session.messages = vi
        .fn()
        .mockResolvedValueOnce({ data: sourceMessages })
        .mockResolvedValue({
          data: [
            {
              info: { role: "assistant", time: { completed: Date.now() } },
              parts: [
                {
                  type: "text",
                  text: '{"memories": [{"content": "OpenCode polling works", "category": "facts"}]}',
                },
              ],
            },
          ],
        })
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(lastMcpBody(vi.mocked(fetch)).params.arguments.content).toBe("OpenCode polling works")
    })

    it("debounces below the minimum message threshold", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": []}')
      client.session.messages = vi.fn().mockResolvedValue({
        data: [{ info: { role: "user" }, parts: [{ type: "text", text: "hi" }] }],
      })
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(client.session.create).not.toHaveBeenCalled()
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })

    it("advances the cursor so a repeated idle is a no-op", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_STATE_DIR", mkdtempSync(join(tmpdir(), "rembr-idx-")))
      const client = makeDistillClient('{"memories": []}')
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })
      expect(client.session.create).toHaveBeenCalledTimes(1)
      await hooks.event!({ event: idleEvent as never })
      expect(client.session.create).toHaveBeenCalledTimes(1)
    })

    it("does not capture when REMBR_CAPTURE_DISABLE is set", async () => {
      vi.stubEnv("REMBR_DISTILL", "true")
      vi.stubEnv("REMBR_CAPTURE_DISABLE", "1")
      const client = makeDistillClient('{"memories": []}')
      const hooks = await RembrPlugin(makeInput(client as never), PLUGIN_OPTIONS)

      await hooks.event!({ event: idleEvent as never })

      expect(client.session.create).not.toHaveBeenCalled()
      expect(vi.mocked(fetch).mock.calls.filter(([u]) => String(u).endsWith("/mcp"))).toHaveLength(0)
    })
  })
})
