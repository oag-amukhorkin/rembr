# opencode-rembr

Persistent, cross-session memory for [OpenCode](https://opencode.ai) agents, backed by
[Rembr](https://github.com/radicalgeek/rembr) — an MCP-native, self-hostable memory service
with server-side embeddings and hybrid text + semantic search.

There are two ways to use Rembr with OpenCode. They compose: most users will want both.

## Layer 1 — plain MCP registration (zero code)

Rembr is an MCP server, and OpenCode speaks MCP natively. Add this to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "rembr": {
      "type": "remote",
      "url": "https://rembr.ai/mcp",
      "headers": { "x-api-key": "{env:REMBR_API_KEY}" },
      "oauth": false
    }
  }
}
```

Your agent immediately gets Rembr's full tool surface: `memory`, `search`, `context`,
`snapshot`, and (depending on your plan) the analytics tools (`graph`, `contradictions`,
`temporal`, `causality`, …).

**OAuth instead of an API key** — Rembr supports Dynamic Client Registration, so you can drop
the `headers` and `oauth` lines and run:

```sh
opencode mcp auth rembr
```

No plaintext credentials touch your workspace. For self-hosted Rembr, change `url` to your
instance's `/mcp` endpoint.

## Layer 2 — this plugin (memory automation)

The plugin adds the lifecycle behaviors that raw MCP registration can't:

- **Recall on session start** — the first message of every session is enriched with relevant
  memories from past sessions. URLs are removed before semantic search, structured results are
  reranked by embedding similarity, prompt-term coverage, recency, client affinity, and diversity
  instead of graph-boosted server score. Up to five entries are injected; stale overlapping
  decisions are demoted rather than reducing the available context budget. Vague continuity
  prompts such as "current status" or "what was done" use the newest current-workspace memories
  instead of weak semantic matches. OpenCode keeps injected
  context synthetic and hidden, so the transcript instead shows `Rembr: injected N relevant
  memories` followed by compact previews (category, short ID, and up to 180 characters of each
  memory). Use `rembr_recall` when the agent needs the full matching result.
  When the prompt has no semantic matches, the plugin loads recent memories from the current
  workspace and injects up to five compact continuity entries. It prioritizes `reminders`,
  `decisions`, `goals`, `workflows`, and `projects` over generic facts and learnings.
- **Auto-capture** — when a session goes idle, its title and outcome are persisted to Rembr
  automatically (deduped; `category: "conversations"`).
- **Curated tools** — `rembr_remember`, `rembr_recall`, `rembr_forget`: three focused tools
  instead of the full 18-tool surface, with agent-friendly descriptions and error strings.
- **Graceful degradation** — if Rembr is unreachable, hooks no-op with a logged warning and
  tools return readable errors. Your agent keeps working.

### Install

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-rembr"]
}
```

```sh
export REMBR_API_KEY="mb_live_..."
```

That's it. For a self-hosted server, also set `REMBR_URL="https://your-host/mcp"`.

### Configuration

Precedence (lowest → highest): defaults → `~/.config/opencode/rembr.json` →
`<project>/.opencode/rembr.json` → `REMBR_*` env vars → inline plugin options.

| Option | Env var | Default | Meaning |
|---|---|---|---|
| `url` | `REMBR_URL` | `https://rembr.ai/mcp` | Rembr MCP endpoint |
| `apiKey` | `REMBR_API_KEY` | — | API key (plugin is disabled without one) |
| `autoRemember` | `REMBR_AUTO_REMEMBER` | `true` | Persist a session summary on idle |
| `distillModel` | `REMBR_DISTILL_MODEL` | server default | Distiller model as `provider/model` |
| `maxRecall` | `REMBR_MAX_RECALL` | `10` | Memories injected at session start (`0` = off) |
| `minSimilarity` | `REMBR_MIN_SIMILARITY` | `0.5` | Recall similarity threshold |
| `captureCategory` | — | `conversations` | Category for auto-captured summaries |
| `timeoutMs` | — | `15000` | Request timeout |
| — | `REMBR_DISTILL` | `true` | LLM distillation on session idle (replaces the naive title+last-message capture) |
| — | `REMBR_DISTILL_MIN_MESSAGES` | `10` | Minimum new messages before a distillation pass runs |
| — | `REMBR_DISTILL_TIMEOUT_MS` | `120000` | Distiller timeout |
| — | `REMBR_CAPTURE_EXCLUDE` | — | Comma-separated directory substrings that are never captured or distilled |
| — | `REMBR_CAPTURE_DISABLE` | — | Set to any value to disable all automatic capture (recursion kill-switch) |
| — | `REMBR_STATE_DIR` | `~/.rembr` | Cursor state + capture log location |

Inline options in `opencode.json`:

```json
{
  "plugin": [["opencode-rembr", { "autoRemember": false, "maxRecall": 5 }]]
}
```

> **Note on auto-capture**: with `autoRemember` enabled, session content is sent to your
> configured Rembr server. Set `REMBR_AUTO_REMEMBER=false` (or `"autoRemember": false`)
> to keep sessions local.

### Session distillation

When a session goes idle, the plugin digests the messages added since the last pass
(per-session cursor under `~/.rembr/cursors/`) and asks the same opencode server —
via a throwaway side session, no subprocess — to extract durable memories: decisions,
root causes, verified fixes, preferences, project facts. Valid memories are stored
with `distilled: true` metadata; the cursor advances only after a fully successful
pass, so failures are retried on the next idle. Content inside `<private>...</private>`
spans is never captured, memories that look like secrets are dropped, and passes with
fewer than `REMBR_DISTILL_MIN_MESSAGES` new messages are deferred. Progress and
failures are logged to `~/.rembr/capture.log`. Set `REMBR_DISTILL=false` to fall back
to the previous title + last-message capture.

### Tools

| Tool | Use |
|---|---|
| `rembr_remember(content, category?)` | Store a decision, preference, learning, or fact |
| `rembr_recall(query, limit?)` | Hybrid text + semantic search over past memories |
| `rembr_forget(id)` | Delete a memory by ID |

Tip: add a line to your `AGENTS.md` such as *"Use rembr_remember to persist important
decisions and preferences, and rembr_recall before re-deriving past decisions."*

## Development

```sh
npm install
npm test        # vitest unit tests (mocked fetch — no live server needed)
npm run build   # tsc → dist/
```

Architecture notes and roadmap: [PLAN.md](./PLAN.md). The plugin talks to Rembr with a
~150-line stateless MCP client (`src/rembr-client.ts`) — one JSON-RPC `tools/call` POST per
operation, JSON or SSE responses, one retry on network failure/5xx. No MCP SDK dependency.
