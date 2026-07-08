import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  loadDistillConfig,
  extractLines,
  buildDigest,
  parseDistillerOutput,
  stripPrivate,
  looksLikeSecret,
  readCursor,
  writeCursor,
  DIGEST_CAP,
  CATEGORIES,
} from "./distill-lib.mjs"

let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "rembr-distill-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  vi.unstubAllGlobals()
})

function config(env = {}) {
  return loadDistillConfig({ REMBR_STATE_DIR: tmpDir, ...env })
}

describe("loadDistillConfig", () => {
  it("applies defaults and reads env overrides", () => {
    const cfg = config()
    expect(cfg.enabled).toBe(true)
    expect(cfg.minNewRecords).toBe(10)
    expect(cfg.excludeCwd).toEqual([])

    const custom = config({
      REMBR_DISTILL: "false",
      REMBR_DISTILL_MODEL: "opus",
      REMBR_DISTILL_MIN_RECORDS: "3",
      REMBR_CAPTURE_EXCLUDE: "client-a, client-b",
    })
    expect(custom.enabled).toBe(false)
    expect(custom.model).toBe("opus")
    expect(custom.minNewRecords).toBe(3)
    expect(custom.excludeCwd).toEqual(["client-a", "client-b"])
  })
})

describe("extractLines", () => {
  it("extracts user, assistant, tool call and tool result lines", () => {
    const records = [
      { type: "user", message: { content: "fix the login bug" } },
      {
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "Found the cause." },
            { type: "tool_use", name: "Read", input: { file_path: "/x" } },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [{ type: "tool_result", content: [{ type: "text", text: "line 1\nline 2" }] }],
        },
      },
      { type: "summary", summary: "ignored" },
    ]
    const { lines, excluded } = extractLines(records)
    expect(excluded).toBe(false)
    expect(lines).toEqual([
      "USER: fix the login bug",
      "ASSISTANT: Found the cause.",
      'TOOL CALL Read: {"file_path":"/x"}',
      "TOOL RESULT: line 1 line 2",
    ])
  })

  it("returns excluded when a record cwd matches the exclusion list", () => {
    const records = [
      { type: "user", cwd: "/home/me/client-a/repo", message: { content: "secret work" } },
    ]
    const { lines, excluded } = extractLines(records, ["client-a"])
    expect(excluded).toBe(true)
    expect(lines).toEqual([])
  })

  it("strips <private> spans from every text kind", () => {
    const records = [
      { type: "user", message: { content: "keep this <private>drop this</private> too" } },
    ]
    const { lines } = extractLines(records)
    expect(lines).toEqual(["USER: keep this  too"])
  })
})

describe("buildDigest", () => {
  it("passes short digests through unchanged", () => {
    expect(buildDigest(["a", "b"])).toBe("a\nb")
  })

  it("truncates the middle of oversized digests", () => {
    const digest = buildDigest(["x".repeat(DIGEST_CAP * 2)])
    expect(digest.length).toBeLessThan(DIGEST_CAP + 100)
    expect(digest).toContain("[... middle of session truncated ...]")
  })
})

describe("parseDistillerOutput", () => {
  it("parses a plain JSON reply and filters invalid entries", () => {
    const reply = JSON.stringify({
      memories: [
        { content: "User prefers tabs", category: "preferences", tags: [] },
        { content: "", category: "facts", tags: [] },
        { content: "bad category", category: "nope", tags: [] },
        "not an object",
      ],
    })
    const memories = parseDistillerOutput(reply)
    expect(memories).toHaveLength(1)
    expect(memories[0].content).toBe("User prefers tabs")
  })

  it("tolerates a fenced code block around the JSON", () => {
    const reply = '```json\n{"memories": [{"content": "x", "category": "facts", "tags": []}]}\n```'
    expect(parseDistillerOutput(reply)).toHaveLength(1)
  })

  it("returns null for non-JSON or missing memories array", () => {
    expect(parseDistillerOutput("I could not find anything.")).toBeNull()
    expect(parseDistillerOutput('{"other": 1}')).toBeNull()
    expect(parseDistillerOutput(undefined)).toBeNull()
  })

  it("accepts every documented category", () => {
    const reply = JSON.stringify({
      memories: CATEGORIES.map((c) => ({ content: `about ${c}`, category: c, tags: [] })),
    })
    expect(parseDistillerOutput(reply)).toHaveLength(CATEGORIES.length)
  })
})

describe("secret and private filters", () => {
  it("flags common secret shapes", () => {
    expect(looksLikeSecret("the key is mb_live_abcdefgh123")).toBe(true)
    expect(looksLikeSecret("password: hunter22")).toBe(true)
    expect(looksLikeSecret("ghp_" + "a".repeat(24))).toBe(true)
    expect(looksLikeSecret("user prefers dark mode")).toBe(false)
  })

  it("stripPrivate removes spans case-insensitively across lines", () => {
    expect(stripPrivate("a <PRIVATE>x\ny</private> b")).toBe("a  b")
  })
})

describe("cursor state", () => {
  it("round-trips and defaults to 0", () => {
    const cfg = config()
    expect(readCursor(cfg, "session-1")).toBe(0)
    expect(writeCursor(cfg, "session-1", 42)).toBe(true)
    expect(readCursor(cfg, "session-1")).toBe(42)
  })

  it("sanitizes session ids used as filenames", () => {
    const cfg = config()
    expect(writeCursor(cfg, "../weird/../id", 7)).toBe(true)
    expect(readCursor(cfg, "../weird/../id")).toBe(7)
    expect(fs.readdirSync(path.join(tmpDir, "cursors"))).toHaveLength(1)
  })
})
