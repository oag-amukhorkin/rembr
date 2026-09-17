import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { FileMemory } from "./file-memory.js"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

let testDir: string

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-rembr-file-memory-"))
})

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true })
})

function makeStore(fileName = "mem.jsonl") {
  return new FileMemory({
    storePath: path.join(testDir, fileName),
    cachePath: path.join(testDir, "cache", `${fileName}.json`),
  })
}

describe("FileMemory", () => {
  it("stores an entry and returns the same recall lines Rembr returns", () => {
    const store = makeStore()
    const entry = store.store("deploys happen on fridays", "facts", { importance: 0.9 })
    const results = store.search("deploys fridays")
    expect(results).toContain(`- [${entry.id}] deploys happen on fridays`)
  })

  it("returns a matching line when the category matches", () => {
    const store = makeStore()
    const entry = store.store("user prefers tabs", "preferences", {})
    const results = store.search("preferences")
    expect(results).toContain(`- [${entry.id}] user prefers tabs`)
  })

  it("deletes an entry by id and returns the id", () => {
    const store = makeStore()
    const entry = store.store("delete me", "facts", {})
    expect(store.delete(entry.id)).toBe(entry.id)
    expect(store.search("delete me")).toBe("")
    expect(store.delete("missing")).toBe("")
  })

  it("persists across instances (durable JSONL append)", () => {
    const store = makeStore()
    store.store("durable entry", "facts", {})
    const reopened = makeStore()
    expect(reopened.search("durable")).toContain("durable entry")
  })

  it("skips corrupt lines without losing the store", () => {
    const store = makeStore()
    store.store("good entry", "facts", {})
    fs.appendFileSync(path.join(testDir, "mem.jsonl"), "not-json\n")
    const reopened = makeStore()
    expect(reopened.search("good entry")).toContain("good entry")
    expect(reopened.search("not-json")).toBe("")
  })

  it("respects the limit option", () => {
    const store = makeStore()
    store.store("alpha one", "facts", {})
    store.store("beta two", "facts", {})
    const results = store.search("facts", { limit: 1 })
    expect(results.split("\n")).toHaveLength(1)
  })

  it("reports size", () => {
    const store = makeStore()
    expect(store.size()).toBe(0)
    store.store("entry one", "facts", {})
    expect(store.size()).toBe(1)
  })
})
