import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { loadConfig, MEMORY_CATEGORIES, type RembrConfig } from "./config.js"
import { RembrClient } from "./rembr-client.js"
import {
  buildDigest,
  extractLines,
  loadDistillConfig,
  logLine,
  looksLikeSecret,
  parseDistillerOutput,
  parseModelRef,
  readCursor,
  writeCursor,
  OBSERVER_PROMPT,
  type SessionMessage,
} from "./distill.js"

export { loadConfig, MEMORY_CATEGORIES } from "./config.js"
export type { RembrConfig } from "./config.js"
export { RembrClient, RembrError } from "./rembr-client.js"

const SERVICE = "opencode-rembr"

function countRecalledMemories(memories: string): number {
  try {
    const parsed = JSON.parse(memories) as { data?: unknown; memories?: unknown; results?: unknown }
    for (const value of [parsed.data, parsed.memories, parsed.results]) {
      if (Array.isArray(value)) return value.length
    }
  } catch {
    // Older Rembr endpoints can return a Markdown result rather than JSON.
  }

  const markdownMatches = memories.match(/^\s*[-*]\s+\[/gm)
  return markdownMatches?.length ?? 1
}

type RecallEntry = {
  id?: unknown
  content?: unknown
  category?: unknown
  created_at?: unknown
  score?: unknown
  semantic_similarity?: unknown
  text_match?: unknown
  metadata?: { directory?: unknown }
}

function parseRecallEntries(memories: string): RecallEntry[] | undefined {
  try {
    const parsed = JSON.parse(memories) as { data?: unknown; memories?: unknown; results?: unknown }
    return [parsed.data, parsed.memories, parsed.results].find(Array.isArray) as RecallEntry[] | undefined
  } catch {
    return undefined
  }
}

function formatMemory(entry: RecallEntry, maxContent: number): string {
  const category = typeof entry.category === "string" ? entry.category : "memory"
  const id = typeof entry.id === "string" ? entry.id.slice(0, 8) : "unknown"
  const content = (entry.content as string).replace(/\s+/g, " ").trim()
  return `- [${category} | ${id}] ${clip(content, maxContent)}`
}

const SEARCH_STOP_WORDS = new Set([
  "about", "after", "again", "all", "also", "and", "are", "but", "can", "could", "for",
  "does", "from", "have", "how", "into", "its", "just", "let", "message", "more", "my", "not",
  "of", "okay", "on", "or", "our", "please", "see", "should", "that", "the", "their", "this",
  "through", "to", "was", "what", "when", "where", "which", "will", "with", "work", "would", "your",
])

function searchTerms(text: string): Set<string> {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(terms.map((term) => {
    if (term.length > 5 && term.endsWith("ies")) return `${term.slice(0, -3)}y`
    if (term.length > 5 && term.endsWith("ing")) return term.slice(0, -3)
    if (term.length > 4 && term.endsWith("ed")) return term.slice(0, -2)
    if (term.length > 4 && term.endsWith("s")) return term.slice(0, -1)
    return term
  }).filter((term) => term.length > 2 && !SEARCH_STOP_WORDS.has(term)))
}

function termOverlap(left: Set<string>, right: Set<string>): number {
  if (!left.size || !right.size) return 0
  let intersection = 0
  for (const term of left) if (right.has(term)) intersection++
  return intersection / new Set([...left, ...right]).size
}

function createdAt(entry: RecallEntry): number {
  const timestamp = typeof entry.created_at === "string" ? Date.parse(entry.created_at) : 0
  return Number.isFinite(timestamp) ? timestamp : 0
}

function selectDiverseMemories(entries: RecallEntry[], limit: number): RecallEntry[] {
  const selected: RecallEntry[] = []
  const terms = new Map(entries.map((entry) => [entry, searchTerms(entry.content as string)]))
  for (const entry of entries) {
    const duplicate = selected.some((chosen) => termOverlap(terms.get(entry)!, terms.get(chosen)!) >= 0.3)
    if (!duplicate) selected.push(entry)
    if (selected.length === limit) break
  }
  return selected
}

function compactRelevantMemories(
  memories: string,
  query: string,
  directory: string | undefined,
  maxRecall: number,
  minSimilarity: number,
): string {
  const entries = parseRecallEntries(memories)
  if (!entries) return memories

  const candidates = entries.filter((entry) => typeof entry.content === "string")
  if (!candidates.length) return ""
  const bestSimilarity = Math.max(
    ...candidates.map((entry) =>
      typeof entry.semantic_similarity === "number" ? entry.semantic_similarity : Number.NEGATIVE_INFINITY,
    ),
  )
  const similarityFloor = Number.isFinite(bestSimilarity)
    ? Math.max(minSimilarity, bestSimilarity - 0.08)
    : minSimilarity
  const queryTerms = searchTerms(query)
  const contentTerms = new Map(candidates.map((entry) => [entry, searchTerms(entry.content as string)]))
  const remaining = candidates.filter(
    (entry) =>
      entry.text_match === true ||
      typeof entry.semantic_similarity !== "number" ||
      entry.semantic_similarity >= similarityFloor,
  )
  const now = Date.now()
  const rank = (entry: RecallEntry) => {
    const content = (entry.content as string).toLowerCase()
    const ageDays = createdAt(entry) ? Math.max(0, (now - createdAt(entry)) / 86_400_000) : 365
    const freshness = 0.05 / (1 + ageDays / 14)
    const clientAffinity = content.includes("opencode")
      ? 0.06
      : /\b(?:codex|claude-code|claude code|openclaw)\b/.test(content) ? -0.05 : 0
    const olderOverlappingDecision = entry.category === "decisions" && remaining.some((other) =>
      other !== entry &&
      other.category === "decisions" &&
      createdAt(other) > createdAt(entry) &&
      termOverlap(contentTerms.get(entry)!, contentTerms.get(other)!) >= 0.22
    )

    return (typeof entry.semantic_similarity === "number" ? entry.semantic_similarity : 0) +
      (entry.text_match === true ? 0.15 : 0) +
      (directory && entry.metadata?.directory === directory ? 0.04 : 0) +
      termOverlap(queryTerms, contentTerms.get(entry)!) * 0.12 +
      freshness +
      clientAffinity -
      (olderOverlappingDecision ? 0.15 : 0)
  }
  const rankScores = new Map(remaining.map((entry) => [entry, rank(entry)]))
  const ranked: RecallEntry[] = []
  while (remaining.length) {
    remaining.sort((left, right) => {
      const diversityPenalty = (entry: RecallEntry) => ranked.length
        ? Math.max(...ranked.map((chosen) => termOverlap(contentTerms.get(entry)!, contentTerms.get(chosen)!))) * 0.1
        : 0
      return (rankScores.get(right)! - diversityPenalty(right)) - (rankScores.get(left)! - diversityPenalty(left))
    })
    ranked.push(remaining.shift()!)
  }

  return selectDiverseMemories(ranked, Math.min(maxRecall, 5))
    .map((entry) => formatMemory(entry, 500))
    .join("\n")
}

function compactRecentMemories(memories: string, directory?: string, newestFirst = false): string {
  try {
    const entries = parseRecallEntries(memories)
    if (!entries?.length) return ""
    const categoryPriority = ["reminders", "decisions", "goals", "workflows", "projects"]
    const workspaceEntries = directory
      ? entries.filter((entry) => entry.metadata?.directory === directory)
      : entries
    const candidates = workspaceEntries.filter((entry) => typeof entry.content === "string")
    const ranked = candidates
      .sort((left, right) => {
        if (newestFirst) {
          const leftTime = typeof left.created_at === "string" ? Date.parse(left.created_at) : 0
          const rightTime = typeof right.created_at === "string" ? Date.parse(right.created_at) : 0
          return rightTime - leftTime
        }
        const leftPriority = categoryPriority.indexOf(typeof left.category === "string" ? left.category : "")
        const rightPriority = categoryPriority.indexOf(typeof right.category === "string" ? right.category : "")
        return (leftPriority === -1 ? categoryPriority.length : leftPriority) -
          (rightPriority === -1 ? categoryPriority.length : rightPriority)
      })
    const selected = selectDiverseMemories(ranked, 5)
    return selected.map((entry) => formatMemory(entry, 500)).join("\n")
  } catch {
    return ""
  }
}

function isContinuityPrompt(prompt: string): boolean {
  return [
    /\b(?:current|latest|recent)\s+(?:status|progress|update)\b/i,
    /\bwhat\s+(?:we(?:'ve| have)?|was|has been)\s+(?:done|completed|working on)\b/i,
    /\bwhere\s+(?:are|were)\s+we\b/i,
    /\b(?:continue|resume|pick up)\s+(?:our\s+)?(?:work|where we left off|from last time)\b/i,
  ].some((pattern) => pattern.test(prompt))
}

function isUnderspecifiedPrompt(prompt: string): boolean {
  // A new session's conversational opener carries too little task information
  // for semantic retrieval; continuity is more useful than arbitrary matches.
  return searchTerms(recallQuery(prompt)).size <= 2
}

function recallQuery(prompt: string): string {
  return prompt.replace(/https?:\/\/\S+/gi, " ").replace(/\s+/g, " ").trim()
}

function previewMemories(memories: string): string {
  try {
    const parsed = JSON.parse(memories) as { data?: unknown; memories?: unknown; results?: unknown }
    const entries = [parsed.data, parsed.memories, parsed.results].find(Array.isArray) as
      | Array<{ id?: unknown; content?: unknown; category?: unknown }>
      | undefined
    if (!entries?.length) return ""
    return entries
      .filter((entry) => typeof entry.content === "string")
      .map((entry) => {
        const category = typeof entry.category === "string" ? entry.category : "memory"
        const id = typeof entry.id === "string" ? entry.id.slice(0, 8) : "unknown"
        return `- [${category} | ${id}] ${clip(entry.content as string, 180)}`
      })
      .join("\n")
  } catch {
    return memories
      .split("\n")
      .filter((line) => /^\s*[-*]\s+\[/.test(line))
      .map((line) => clip(line, 220))
      .join("\n")
  }
}
const NOT_CONFIGURED =
  "Rembr is not configured. Set the REMBR_API_KEY environment variable (and REMBR_URL " +
  "for self-hosted servers), or pass options via opencode.json: " +
  '"plugin": [["opencode-rembr", { "apiKey": "...", "url": "..." }]]'

/** Truncate to a budget without splitting surrogate pairs mid-way. */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

export const RembrPlugin: Plugin = async ({ client, directory, worktree }, options) => {
  const config: RembrConfig = loadConfig({
    options: options as Record<string, unknown> | undefined,
    worktree,
  })

  const rembr = config.apiKey
    ? new RembrClient({ url: config.url, apiKey: config.apiKey, timeoutMs: config.timeoutMs })
    : null

  const log = async (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) => {
    try {
      await client.app.log({ body: { service: SERVICE, level, message, extra } })
    } catch {
      // logging must never break the agent loop
    }
  }

  if (!rembr) {
    void log("warn", "no API key found; Rembr memory is disabled", { url: config.url })
  } else {
    void rembr.health().then((ok) => {
      if (ok) return log("info", "connected to Rembr", { url: config.url })
      return log("warn", "Rembr health check failed; memory operations may not work", { url: config.url })
    })
  }

  const distillConfig = loadDistillConfig()
  // Directory-level exclusion and the recursion kill-switch apply to the whole
  // plugin instance: no capture, no distillation.
  const captureDisabled =
    !!process.env.REMBR_CAPTURE_DISABLE ||
    distillConfig.excludeDirs.some((marker) => (worktree || directory || "").includes(marker))

  /** Sessions that already had memories injected into their first message. */
  const injected = new Set<string>()
  /** Last auto-captured summary per session, to avoid storing duplicates on repeated idles. */
  const captured = new Map<string, string>()
  /** Side sessions we created as distillers; never inject into or distill them. */
  const distillerSessions = new Set<string>()

  /** Build a short summary of the session for auto-capture. */
  const summarizeSession = async (sessionID: string): Promise<string | undefined> => {
    const session = (await client.session.get({ path: { id: sessionID } }))?.data as
      | { title?: string }
      | undefined
    const title = session?.title?.trim()
    if (!title) return undefined

    let lastAssistant = ""
    try {
      const messages = (await client.session.messages({ path: { id: sessionID } }))?.data as
        | Array<{ info?: { role?: string }; parts?: Array<{ type?: string; text?: string }> }>
        | undefined
      const assistant = [...(messages ?? [])].reverse().find((m) => m.info?.role === "assistant")
      lastAssistant = (assistant?.parts ?? [])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("\n")
        .trim()
    } catch {
      // title-only capture is still useful
    }

    return lastAssistant
      ? `OpenCode session "${title}"\n\nOutcome:\n${clip(lastAssistant, 1500)}`
      : `OpenCode session "${title}"`
  }

  /**
   * LLM distillation pass for an idle session: digest the messages added
   * since the cursor, ask a throwaway side session on the SAME opencode
   * server to extract durable memories, store them in Rembr. Fail-silent;
   * the cursor advances only after a fully successful pass.
   */
  const distillSession = async (sessionID: string): Promise<void> => {
    if (!rembr || distillerSessions.has(sessionID)) return

    const messages = ((await client.session.messages({ path: { id: sessionID } }))?.data ??
      []) as SessionMessage[]
    const cursor = readCursor(distillConfig, sessionID)
    const fresh = messages.slice(cursor)
    if (!fresh.length) return
    // Debounce: distilling tiny increments produces distorted memories. Below
    // the threshold the cursor stays put, so the messages join the next pass.
    if (fresh.length < distillConfig.minNewMessages) {
      logLine(distillConfig, `debounce: ${fresh.length} new messages < ${distillConfig.minNewMessages}, session ${sessionID}`)
      return
    }
    const lines = extractLines(fresh)
    if (!lines.length) {
      logLine(distillConfig, `no distillable content in ${fresh.length} new messages, session ${sessionID}`)
      return
    }

    const side = (await client.session.create({ body: { title: "rembr-distill (auto)" } }))?.data as
      | { id?: string }
      | undefined
    if (!side?.id) {
      logLine(distillConfig, `side session create failed, session ${sessionID}`)
      return
    }
    const sideID = side.id
    distillerSessions.add(sideID)

    let reply: string | undefined
    try {
      const modelRef = parseModelRef(distillConfig.model)
      const textFromParts = (parts: Array<{ type?: string; text?: string }> | undefined) =>
        (parts ?? [])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n")
      const deadline = Date.now() + distillConfig.timeoutMs

      const requestReply = async () => {
        const response = (await client.session.prompt({
          path: { id: sideID },
          body: {
            ...(modelRef ? { model: modelRef } : {}),
            parts: [{ type: "text", text: OBSERVER_PROMPT + buildDigest(lines) }],
          },
        })) as {
          data?: {
            info?: { role?: string }
            parts?: Array<{ type?: string; text?: string }>
          }
        }
        if (response?.data?.info?.role === "assistant") return textFromParts(response.data.parts)

        // OpenCode 1.17 can return the created user message immediately when
        // prompting from a session.idle hook. Keep the hook alive and poll the
        // side session until its assistant response is complete.
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 250))
          const sideMessages = ((await client.session.messages({ path: { id: sideID } }))?.data ?? []) as Array<{
            info?: { role?: string; time?: { completed?: number } }
            parts?: Array<{ type?: string; text?: string }>
          }>
          const assistant = [...sideMessages]
            .reverse()
            .find((message) => message.info?.role === "assistant" && message.info.time?.completed)
          if (assistant) return textFromParts(assistant.parts)
        }
        throw new Error(`distiller timed out after ${distillConfig.timeoutMs}ms`)
      }

      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        reply = await Promise.race([
          requestReply(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error(`distiller timed out after ${distillConfig.timeoutMs}ms`)),
              distillConfig.timeoutMs,
            )
          }),
        ])
      } finally {
        if (timer) clearTimeout(timer)
      }
    } catch (error) {
      logLine(distillConfig, `distiller failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    } finally {
      try {
        await client.session.delete({ path: { id: sideID } })
      } catch {
        // leftover side session is cosmetic
      }
    }

    const memories = parseDistillerOutput(reply)
    if (memories === null) {
      logLine(distillConfig, `distiller result unusable: ${String(reply).slice(0, 200)}`)
      return
    }

    let failed = false
    for (const memory of memories) {
      if (looksLikeSecret(memory.content)) {
        logLine(distillConfig, `skipped-secret-shape: ${memory.content.slice(0, 80)}`)
        continue
      }
      try {
        await rembr.remember(memory.content, memory.category as (typeof MEMORY_CATEGORIES)[number], {
          source: SERVICE,
          distilled: true,
          sessionID,
          directory,
          tags: memory.tags ?? [],
        })
        logLine(distillConfig, `stored: ${memory.content.slice(0, 120)}`)
      } catch (error) {
        failed = true
        logLine(distillConfig, `store failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (failed) {
      logLine(distillConfig, `partial failure, cursor kept at ${cursor}, session ${sessionID}`)
      return
    }
    if (!memories.length) logLine(distillConfig, `nothing durable this pass, session ${sessionID}`)
    if (writeCursor(distillConfig, sessionID, messages.length)) {
      logLine(distillConfig, `cursor ${cursor} -> ${messages.length}, session ${sessionID}`)
    }
  }

  return {
    tool: {
      rembr_remember: tool({
        description:
          "Store a memory in Rembr so it persists across sessions and projects. Use for " +
          "decisions, user preferences, learnings, and project facts worth keeping long-term.",
        args: {
          content: tool.schema.string().describe("The content to remember"),
          category: tool.schema
            .enum(MEMORY_CATEGORIES)
            .optional()
            .describe("Category for organizing memories (defaults to 'facts')"),
        },
        async execute(args) {
          if (!rembr) return NOT_CONFIGURED
          try {
            const result = await rembr.remember(args.content, args.category ?? "facts", {
              source: SERVICE,
              directory,
            })
            return result || "Memory stored."
          } catch (error) {
            return `Failed to store memory: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      }),

      rembr_recall: tool({
        description:
          "Search Rembr long-term memory (hybrid text + semantic search) for relevant " +
          "memories from past sessions. Use before re-deriving decisions or preferences.",
        args: {
          query: tool.schema.string().describe("What to search for"),
          limit: tool.schema.number().int().min(1).max(50).optional().describe("Max results (default 10)"),
        },
        async execute(args) {
          if (!rembr) return NOT_CONFIGURED
          try {
            const result = await rembr.recall(args.query, {
              limit: args.limit ?? config.maxRecall,
              minSimilarity: config.minSimilarity,
            })
            return result || "No matching memories found."
          } catch (error) {
            return `Failed to search memories: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      }),

      rembr_forget: tool({
        description: "Delete a memory from Rembr by its ID (IDs appear in rembr_recall results).",
        args: {
          id: tool.schema.string().describe("The memory ID to delete"),
        },
        async execute(args) {
          if (!rembr) return NOT_CONFIGURED
          try {
            const result = await rembr.forget(args.id)
            return result || "Memory deleted."
          } catch (error) {
            return `Failed to delete memory: ${error instanceof Error ? error.message : String(error)}`
          }
        },
      }),
    },

    // Recall injection: on the first user message of a session, search Rembr with the
    // prompt text and append the matches as an extra context part (Mem0/Supermemory pattern).
    "chat.message": async (input, output) => {
      if (!rembr || config.maxRecall <= 0) return
      const sessionID = input.sessionID ?? output.message?.sessionID
      if (!sessionID || injected.has(sessionID) || distillerSessions.has(sessionID)) return
      injected.add(sessionID)

      const prompt = (output.parts ?? [])
        .filter((part) => part.type === "text" && typeof (part as { text?: unknown }).text === "string")
        .map((part) => (part as { text: string }).text)
        .join("\n")
        .trim()
      if (!prompt) return

      try {
        const continuityPrompt = isContinuityPrompt(prompt) || isUnderspecifiedPrompt(prompt)
        let recentFallback = continuityPrompt
          ? compactRecentMemories(await rembr.recent(50), directory, true)
          : ""
        const query = recallQuery(prompt)
        const recalled = !recentFallback && query
          ? await rembr.recall(clip(query, 2000), {
              limit: Math.min(config.maxRecall * 2, 50),
              minSimilarity: config.minSimilarity,
            })
          : ""
        const memories = recalled
          ? compactRelevantMemories(recalled, query, directory, config.maxRecall, config.minSimilarity)
          : ""
        const memoryCount = memories ? countRecalledMemories(memories) : 0
        if (!memoryCount && !recentFallback) {
          recentFallback = compactRecentMemories(await rembr.recent(50), directory)
        }
        const injectedText = recentFallback
          ? `<rembr-recent-context>\nRecent working context from previous sessions:\n${recentFallback}\n</rembr-recent-context>`
          : `<rembr-memories>\nRelevant long-term memories from previous sessions (via Rembr):\n${memories}\n</rembr-memories>`
        if (!memoryCount && !recentFallback) return
        const preview = recentFallback || previewMemories(memories)
        output.parts.push({
          id: `prt_rembr_status_${output.message.id}`,
          sessionID,
          messageID: output.message.id,
          type: "text",
          text: recentFallback
            ? `Rembr: ${continuityPrompt ? "continuity prompt" : "no prompt matches"}; injected ${recentFallback.split("\n").length} recent context ${recentFallback.split("\n").length === 1 ? "memory" : "memories"}.\n${preview}`
            : `Rembr: injected ${memoryCount} relevant ${memoryCount === 1 ? "memory" : "memories"}.\n${preview}`,
        } as (typeof output.parts)[number])
        output.parts.push({
          id: `prt_rembr_${output.message.id}`,
          sessionID,
          messageID: output.message.id,
          type: "text",
          synthetic: true,
          text: injectedText,
        } as (typeof output.parts)[number])
        void log("debug", "injected memories into session start", { sessionID })
      } catch (error) {
        void log("warn", "memory recall failed; continuing without injection", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },

    // Auto-capture: when a session goes idle, persist its title + last assistant
    // message as a "conversations" memory. Deduped per session per summary.
    event: async ({ event }) => {
      if (!rembr || !config.autoRemember || captureDisabled) return
      if (event.type !== "session.idle") return
      const sessionID = (event as { properties?: { sessionID?: string } }).properties?.sessionID
      if (!sessionID) return

      // LLM distillation replaces the naive title+last-message capture when
      // enabled (REMBR_DISTILL, default true).
      if (distillConfig.enabled) {
        try {
          await distillSession(sessionID)
        } catch (error) {
          logLine(distillConfig, `distill pass threw: ${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }

      try {
        const summary = await summarizeSession(sessionID)
        if (!summary || captured.get(sessionID) === summary) return
        captured.set(sessionID, summary)
        await rembr.remember(summary, config.captureCategory, {
          source: SERVICE,
          sessionID,
          directory,
          capturedAt: new Date().toISOString(),
        })
        void log("debug", "auto-captured session summary", { sessionID })
      } catch (error) {
        void log("warn", "session auto-capture failed", {
          sessionID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  }
}

export default RembrPlugin
