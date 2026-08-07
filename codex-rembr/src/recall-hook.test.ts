import { describe, expect, it, vi } from "vitest"
import { loadRecallHookConfig, runRecallHook } from "./recall-hook.js"
import type { RecallClient } from "./recall.js"

const ENV = {
  REMBR_API_KEY: "test-key",
  REMBR_URL: "https://rembr.test/mcp",
}

describe("Codex prompt hook", () => {
  it("uses OpenCode-compatible local defaults", () => {
    const config = loadRecallHookConfig(ENV)
    expect(config.recallLimit).toBe(10)
    expect(config.minSimilarity).toBe(0.3)
  })

  it("injects once per session", async () => {
    const client: RecallClient = {
      recall: vi.fn().mockResolvedValue(JSON.stringify({
        data: [{ id: "one", category: "facts", content: "Relevant result.", semantic_similarity: 0.7 }],
      })),
      recent: vi.fn().mockResolvedValue('{"data":[]}'),
    }
    const claim = vi.fn().mockReturnValueOnce(true).mockReturnValue(false)
    const input = { session_id: "ses-1", prompt: "Explain the relevant deployment result", cwd: "/repo" }

    const first = await runRecallHook(input, ENV, client, claim)
    const second = await runRecallHook(input, ENV, client, claim)

    expect(first.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit")
    expect(first.hookSpecificOutput?.additionalContext).toContain("Relevant result")
    expect(second).toEqual({ continue: true })
    expect(client.recall).toHaveBeenCalledTimes(1)
  })

  it("honors recursion and recall disable guards", async () => {
    const client: RecallClient = {
      recall: vi.fn(),
      recent: vi.fn(),
    }
    const input = { session_id: "ses-1", prompt: "Explain the deployment architecture", cwd: "/repo" }
    expect(await runRecallHook(input, { ...ENV, REMBR_CAPTURE_DISABLE: "1" }, client)).toEqual({ continue: true })
    expect(await runRecallHook(input, { ...ENV, REMBR_PROMPT_RECALL: "false" }, client)).toEqual({ continue: true })
    expect(client.recall).not.toHaveBeenCalled()
  })
})
