// Distillation library for the Stop hook: read new transcript lines since the
// per-session cursor, extract durable memories with a headless `claude -p`
// call (same harness the plugin runs in), and store them in Rembr.
//
// Zero dependencies, like lib.mjs. Every entry point is fail-silent: a failed
// pass logs one line and returns without advancing the cursor, so the same
// lines are retried at the next Stop. The cursor advances ONLY after a fully
// successful pass.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { callTool } from "./lib.mjs"

export const CATEGORIES = [
  "facts",
  "preferences",
  "conversations",
  "projects",
  "learning",
  "goals",
  "context",
  "reminders",
  "patterns",
  "decisions",
  "workflows",
  "insights",
]

// Over this many chars the digest keeps 60% head / 30% tail — the start
// (task framing) and end (conclusions) of a session distill better than
// the middle.
export const DIGEST_CAP = 24_000

const SECRET_PATTERNS = [
  /AKIA[0-9A-Z]{16}/,
  /(bearer|token|api[_-]?key|password|secret)\s*[=:]\s*\S+/i,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
  /\b(mb_live_|sk-)[A-Za-z0-9_-]{8,}/,
  /ghp_[A-Za-z0-9]{20,}/,
]

export const OBSERVER_PROMPT = `You are an observer creating searchable long-term memory for future AI sessions. You are NOT the one doing the work described below.

Read the session digest and extract ONLY durable conclusions worth recalling weeks later: decisions made, root causes found, fixes verified, preferences stated, lasting project facts. Skip routine operations, intermediate steps, failed attempts that led nowhere, and session-local details (temporary paths, one-off values).

Each memory must be ONE self-contained statement understandable without the session. Categories: ${CATEGORIES.join(", ")}. An empty memories array is a valid and common answer.

Reply with ONLY a JSON object of the shape {"memories": [{"content": "...", "category": "...", "tags": ["..."]}]} and nothing else.

Session digest:
`

export function loadDistillConfig(env = process.env) {
  const stateDir = env.REMBR_STATE_DIR || path.join(os.homedir(), ".rembr")
  return {
    enabled: !["false", "0", "no", "off"].includes(String(env.REMBR_DISTILL ?? "true").toLowerCase()),
    model: env.REMBR_DISTILL_MODEL || "haiku",
    minNewRecords: Number(env.REMBR_DISTILL_MIN_RECORDS) || 10,
    timeoutMs: Number(env.REMBR_DISTILL_TIMEOUT_MS) || 120_000,
    // Comma-separated cwd substrings that must never be distilled
    // (e.g. a client workspace whose content may not leave the machine).
    excludeCwd: (env.REMBR_CAPTURE_EXCLUDE || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    stateDir,
    logFile: env.REMBR_LOG || path.join(stateDir, "capture.log"),
  }
}

export function log(config, msg) {
  try {
    fs.mkdirSync(config.stateDir, { recursive: true })
    const stamp = new Date().toISOString().replace("T", " ").slice(0, 19)
    fs.appendFileSync(config.logFile, `${stamp} distill ${msg}\n`)
  } catch {
    // fail-silent
  }
}

export function stripPrivate(text) {
  return text.replace(/<private>[\s\S]*?<\/private>/gi, "")
}

export function looksLikeSecret(text) {
  return SECRET_PATTERNS.some((pattern) => pattern.test(text))
}

function summarizeToolInput(value) {
  let s
  try {
    s = JSON.stringify(value)
  } catch {
    s = String(value)
  }
  return (s ?? "").replace(/\s+/g, " ").slice(0, 200)
}

/**
 * Digest lines from Claude Code transcript records (one parsed JSONL object
 * each). Returns { lines, excluded } — excluded is true when any record's cwd
 * matches the exclusion list, in which case nothing may be distilled.
 */
export function extractLines(records, excludeCwd = []) {
  const lines = []
  for (const rec of records) {
    const cwd = rec?.cwd || ""
    if (excludeCwd.some((marker) => cwd.includes(marker))) {
      return { lines: [], excluded: true }
    }
    const content = rec?.message?.content
    if (rec?.type === "user") {
      if (typeof content === "string") {
        const text = stripPrivate(content).trim()
        if (text) lines.push(`USER: ${text}`)
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === "text") {
            const text = stripPrivate(block.text ?? "").trim()
            if (text) lines.push(`USER: ${text}`)
          } else if (block?.type === "tool_result") {
            const inner = block.content
            const raw = Array.isArray(inner)
              ? inner
                  .filter((b) => b?.type === "text")
                  .map((b) => b.text ?? "")
                  .join(" ")
              : typeof inner === "string"
                ? inner
                : ""
            const text = stripPrivate(raw).replace(/\s+/g, " ").trim().slice(0, 300)
            if (text) lines.push(`TOOL RESULT: ${text}`)
          }
        }
      }
    } else if (rec?.type === "assistant" && Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === "text") {
          const text = stripPrivate(block.text ?? "").trim()
          if (text) lines.push(`ASSISTANT: ${text}`)
        } else if (block?.type === "tool_use") {
          lines.push(`TOOL CALL ${block.name ?? "?"}: ${summarizeToolInput(block.input)}`)
        }
        // thinking blocks deliberately skipped
      }
    }
    // other record types (summary, system, ...) deliberately skipped
  }
  return { lines, excluded: false }
}

export function buildDigest(lines) {
  const digest = lines.join("\n")
  if (digest.length <= DIGEST_CAP) return digest
  const head = Math.floor(DIGEST_CAP * 0.6)
  const tail = Math.floor(DIGEST_CAP * 0.3)
  return `${digest.slice(0, head)}\n[... middle of session truncated ...]\n${digest.slice(-tail)}`
}

/** Parse the distiller's reply into a memories array, or null when unusable. */
export function parseDistillerOutput(text) {
  if (typeof text !== "string") return null
  const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim()
  let payload
  try {
    payload = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!Array.isArray(payload?.memories)) return null
  return payload.memories.filter(
    (m) =>
      m &&
      typeof m.content === "string" &&
      m.content.trim() &&
      CATEGORIES.includes(m.category),
  )
}

/**
 * Run the harness's own CLI headlessly as the distiller. The digest goes in
 * via stdin (no arg-length limits); REMBR_CAPTURE_DISABLE=1 in the child env
 * keeps the child session's hooks from capturing or distilling itself.
 * Resolves to a memories array, or null when the call failed (retry later).
 */
export function runDistiller(config, digest) {
  return new Promise((resolve) => {
    const args = ["-p", "--output-format", "json", "--model", config.model]
    const child = spawn("claude", args, {
      shell: process.platform === "win32",
      env: { ...process.env, REMBR_CAPTURE_DISABLE: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let settled = false
    const finish = (value, note) => {
      if (settled) return
      settled = true
      if (note) log(config, note)
      resolve(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null, `distiller timed out after ${config.timeoutMs}ms`)
    }, config.timeoutMs)
    child.on("error", (err) => {
      clearTimeout(timer)
      finish(null, `distiller spawn failed: ${err.message}`)
    })
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        return finish(null, `distiller exited ${code}: ${stderr.trim().slice(0, 300)}`)
      }
      let wrapper
      try {
        wrapper = JSON.parse(stdout)
      } catch {
        return finish(null, `distiller output not JSON: ${stdout.trim().slice(0, 200)}`)
      }
      const memories = parseDistillerOutput(wrapper?.result)
      if (memories === null) {
        return finish(null, `distiller result unusable: ${String(wrapper?.result).slice(0, 200)}`)
      }
      finish(memories)
    })
    child.stdin.on("error", () => {})
    child.stdin.end(OBSERVER_PROMPT + digest)
  })
}

function cursorFile(config, sessionId) {
  return path.join(config.stateDir, "cursors", sessionId.replace(/[^\w.-]/g, "_"))
}

export function readCursor(config, sessionId) {
  try {
    const n = parseInt(fs.readFileSync(cursorFile(config, sessionId), "utf8").trim(), 10)
    return Number.isFinite(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

export function writeCursor(config, sessionId, value) {
  try {
    const file = cursorFile(config, sessionId)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, String(value))
    return true
  } catch (err) {
    log(config, `cursor write failed: ${err.message}`)
    return false
  }
}

async function postMemory(rembrConfig, mem, sessionId) {
  const text = await callTool(rembrConfig, "memory", {
    operation: "create",
    content: mem.content,
    category: mem.category,
    tags: Array.isArray(mem.tags) ? mem.tags : [],
    metadata: {
      source: "claude-code-rembr",
      distilled: true,
      session_id: sessionId,
    },
  })
  if (text === null) return "failed"
  return text.includes("duplicate_of") ? "duplicate" : "stored"
}

/**
 * One full distillation pass for a session's transcript. Never throws.
 * The cursor advances only when every extracted memory was stored (or the
 * pass legitimately found nothing) — any failure leaves it for the next Stop.
 */
export async function distillTranscript(config, rembrConfig, transcriptPath, sessionId) {
  let raw
  try {
    raw = fs.readFileSync(transcriptPath, "utf8")
  } catch {
    log(config, `transcript not readable: ${transcriptPath}`)
    return
  }
  const allLines = raw.split("\n")
  const totalLines = allLines.length - (allLines.at(-1) === "" ? 1 : 0)
  const cursor = readCursor(config, sessionId)
  const records = []
  for (let i = cursor; i < totalLines; i++) {
    const line = allLines[i].trim()
    if (!line) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // skip malformed lines
    }
  }
  if (!records.length) return

  const { lines, excluded } = extractLines(records, config.excludeCwd)
  if (excluded) {
    log(config, `excluded cwd, skipping session ${sessionId}`)
    return
  }
  // Debounce: distilling tiny increments produces distorted memories. Below
  // the threshold the cursor stays put, so the lines join the next pass.
  if (records.length < config.minNewRecords) {
    log(config, `debounce: ${records.length} new records < ${config.minNewRecords}, session ${sessionId}`)
    return
  }
  if (!lines.length) {
    log(config, `no distillable content in ${records.length} new records, session ${sessionId}`)
    return
  }

  const memories = await runDistiller(config, buildDigest(lines))
  if (memories === null) return // logged already; cursor untouched -> retried next Stop

  let failed = false
  for (const mem of memories) {
    if (looksLikeSecret(mem.content)) {
      log(config, `skipped-secret-shape: ${mem.content.slice(0, 80)}`)
      continue
    }
    const status = await postMemory(rembrConfig, mem, sessionId)
    log(config, `${status}: ${mem.content.slice(0, 120)}`)
    if (status === "failed") failed = true
  }
  if (failed) {
    log(config, `partial failure, cursor kept at ${cursor}, session ${sessionId}`)
    return
  }
  if (!memories.length) log(config, `nothing durable this pass, session ${sessionId}`)
  if (writeCursor(config, sessionId, totalLines)) {
    log(config, `cursor ${cursor} -> ${totalLines}, session ${sessionId}`)
  }
}
