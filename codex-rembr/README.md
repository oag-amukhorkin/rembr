# codex-rembr

Rembr long-term memory for [OpenAI Codex](https://developers.openai.com/codex). The
integration has five pieces: a **config recipe** (native remote MCP), an **agent skill**
that teaches Codex when to recall/store, an optional **stdio MCP bridge** with a curated
tool surface, a native **Stop hook** that distills Codex JSONL transcripts, and a
fallback **watcher** for environments where hooks are not available.

## 1. Register Rembr in Codex (recommended — zero code)

Codex supports streamable-HTTP MCP servers natively. Add to `~/.codex/config.toml`:

```toml
[mcp_servers.rembr]
url = "https://rembr.ai/mcp"
env_http_headers = { "x-api-key" = "REMBR_API_KEY" }
```

`env_http_headers` reads the value from your `REMBR_API_KEY` environment variable — no
secret in the file. Or via CLI: `codex mcp add rembr --url https://rembr.ai/mcp`. For OAuth
instead of an API key, run `codex mcp login rembr` (Rembr supports Dynamic Client
Registration).

To curate the tool surface, filter per server:

```toml
[mcp_servers.rembr]
url = "https://rembr.ai/mcp"
env_http_headers = { "x-api-key" = "REMBR_API_KEY" }
enabled_tools = ["memory", "search"]
```

## 2. Install the skill

Codex discovers skills in `.agents/skills` (per repo) or `~/.agents/skills` (global):

```bash
mkdir -p ~/.agents/skills
cp -r skills/rembr-memory ~/.agents/skills/
```

The skill ([skills/rembr-memory/SKILL.md](./skills/rembr-memory/SKILL.md)) tells Codex to
recall before re-deriving decisions, store durable facts/preferences/decisions, treat
recalled memories as untrusted data, and never store secrets. You can also add a line to
your `AGENTS.md`:

> Use Rembr memory tools: search memory before re-deriving past decisions, and store
> durable facts, preferences, and decisions when they come up.

## 3. The stdio bridge (optional)

`codex-rembr` is also a stdio MCP server exposing the curated trio
`memory_recall` / `memory_store` / `memory_forget` — the same surface as Rembr's OpenClaw
plugin. Use it when a client only speaks stdio, when outbound HTTP is restricted to the
bridge host, or when you want exactly three memory tools with agent-friendly descriptions
and built-in prompt-injection screening.

```toml
[mcp_servers.rembr]
command = "npx"
args = ["-y", "codex-rembr"]
env = { "REMBR_API_KEY" = "mb_live_..." }
```

Bridge environment variables: `REMBR_API_KEY` (required), `REMBR_URL`
(default `https://rembr.ai/mcp`), `REMBR_RECALL_LIMIT` (10), `REMBR_MIN_SIMILARITY` (0.5),
`REMBR_TIMEOUT_MS` (15000).

The bridge works with any stdio MCP client, not just Codex (Gemini CLI, older clients,
editor integrations).

## 4. Session distillation (native Stop hook)

Codex supports native lifecycle hooks, including `Stop`. Configure a Stop hook to pass
Codex's `transcript_path` into `codex-rembr-distill` when a turn stops. This gives the
same distillation semantics as the Claude Code Stop hook without running a background
poller.

Example `.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "powershell.exe -NoProfile -ExecutionPolicy Bypass -File \"C:\\Source\\Repos\\ai-work\\.codex\\hooks\\rembr-stop-distill.ps1\"",
            "timeout": 300,
            "statusMessage": "Distilling session into Rembr"
          }
        ]
      }
    ]
  }
}
```

The hook wrapper should read hook JSON from stdin, extract `transcript_path`, load the
Rembr environment, call:

```bash
codex-rembr-distill ~/.codex/sessions/2026/07/08/rollout-....jsonl
```

The distiller reads only new JSONL records since the per-session cursor under
`~/.rembr/cursors/`, skips Codex metadata/world-state/developer instructions, builds a
compact digest from user, assistant, and tool result content, asks `codex exec` to extract
durable memories, and stores them in Rembr with `distilled: true` metadata. The cursor
advances only after a successful pass, so failures are retried on the next run.

Environment variables:

| Env var | Default | Meaning |
|---|---|---|
| `REMBR_DISTILL` | `true` | Set to `false` to disable the distiller |
| `REMBR_DISTILL_MODEL` | Codex default | Model passed to `codex exec --model` |
| `REMBR_DISTILL_MIN_RECORDS` | `10` | Minimum new JSONL records before distillation runs |
| `REMBR_DISTILL_TIMEOUT_MS` | `120000` | Distiller timeout |
| `REMBR_CAPTURE_EXCLUDE` | - | Comma-separated cwd substrings that are never distilled |
| `REMBR_CAPTURE_DISABLE` | - | Recursion kill-switch for the child `codex exec` process |
| `REMBR_STATE_DIR` | `~/.rembr` | Cursor state and capture log location |
| `CODEX_SESSIONS_DIR` | `~/.codex/sessions` | Codex transcript root watched by `codex-rembr-watch` |
| `REMBR_CODEX_WATCH_POLL_MS` | `10000` | Watcher polling interval |
| `REMBR_CODEX_WATCH_IDLE_MS` | `30000` | How long a session file must be unchanged before distillation |

Content inside `<private>...</private>` spans is stripped before distillation, and
memories that look like secrets are dropped before storage.

Codex also has `PreCompact` and `PostCompact` hooks. Those are useful for future
checkpoint integration with `/precompact`, but the default memory capture path should be
`Stop`, because it runs at the end of every turn and does not require manual compaction.

## 5. Watcher fallback

If hooks are unavailable or disabled, start the watcher in a separate terminal:

```bash
codex-rembr-watch
```

It polls `~/.codex/sessions`, waits until a JSONL transcript has been idle for
`REMBR_CODEX_WATCH_IDLE_MS` (default 30000), then runs the same cursor-based
distillation pass. Failures leave the cursor unchanged and are retried on the next pass.

Prefer the Stop hook for normal local Codex use. The watcher can replay old sessions if
started without a cutoff policy, so use it deliberately.

## Development

```bash
npm install
npm test        # MCP bridge + distiller + watcher unit tests
npm run build   # tsc → dist/, bins: codex-rembr, codex-rembr-distill, codex-rembr-watch
```

The Rembr transport is the vendored stateless MCP client
([src/rembr-client.ts](./src/rembr-client.ts)) shared across all Rembr agent plugins.
