# claude-code-rembr (`rembr`)

Persistent, cross-session memory for [Claude Code](https://code.claude.com), backed by
[Rembr](https://github.com/radicalgeek/rembr). One plugin gives you:

- **The Rembr MCP server**, bundled — `memory`, `search`, `context`, `snapshot` tools
  available as `mcp__rembr__*` (remote streamable HTTP, no local process)
- **First-prompt recall** — a `UserPromptSubmit` hook runs once per session. Specific prompts
  receive curated semantic matches; vague or continuation prompts restore up to five memories
  from the newest prior same-workspace session. Empty semantic results fall back to prioritized
  recent workspace context. The exact injected block is also shown to the user
- **Auto-capture** — a `UserPromptSubmit` hook stores memory-worthy prompts ("remember…",
  "I prefer…") automatically
- **Session distillation** — an async `Stop` hook reads the new transcript lines since the
  last pass and uses a headless `claude -p` call to extract durable conclusions (decisions,
  root causes, verified fixes, preferences) into Rembr — no manual "remember" needed
- **Skills** — `/rembr:remember` and `/rembr:recall` for explicit memory operations
- **Zero dependencies** — hook scripts are plain Node ESM; nothing to build or install

## Install

```bash
# From the marketplace manifest at this repo's root:
/plugin marketplace add radicalgeek/rembr
/plugin install rembr@rembr
```

Then set your API key (and URL if self-hosting) in your shell:

```bash
export REMBR_API_KEY="mb_live_..."
# export REMBR_URL="https://your-host/mcp"   # self-hosted only
```

That's it — the MCP server, hooks, and skills are all active. No literal secrets are stored
anywhere: the bundled [.mcp.json](./.mcp.json) uses `${REMBR_API_KEY}` /
`${REMBR_URL:-https://rembr.ai/mcp}` expansion.

### Without the plugin (MCP only)

```bash
claude mcp add --transport http rembr https://rembr.ai/mcp --header "x-api-key: ${REMBR_API_KEY}"
```

This gives you the tools but no first-prompt recall, auto-capture, or skills.

## Configuration (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `REMBR_API_KEY` | — | Required. Without it, hooks no-op silently and the MCP server won't authenticate. |
| `REMBR_URL` | `https://rembr.ai/mcp` | Rembr MCP endpoint |
| `REMBR_AUTO_RECALL` | `true` | Enable automatic first-prompt recall |
| `REMBR_AUTO_CAPTURE` | `true` | Store trigger-phrase prompts automatically |
| `REMBR_PROMPT_RECALL` | `true` | Route the first prompt to semantic recall or prior-session restoration |
| `REMBR_RECALL_LIMIT` | `5` | Max memories per recall |
| `REMBR_MIN_SIMILARITY` | `0.5` | Recall similarity threshold |
| `REMBR_TIMEOUT_MS` | `3000` | Hook request timeout |
| `REMBR_DISTILL` | `true` | Distill sessions into memories at each Stop |
| `REMBR_DISTILL_MODEL` | `haiku` | Model for the headless distiller call |
| `REMBR_DISTILL_MIN_RECORDS` | `10` | Debounce: skip passes with fewer new transcript records (tiny increments distill poorly) |
| `REMBR_DISTILL_TIMEOUT_MS` | `120000` | Distiller call timeout |
| `REMBR_CAPTURE_EXCLUDE` | — | Comma-separated cwd substrings that must never be distilled (e.g. a workspace whose content may not leave the machine) |
| `REMBR_STATE_DIR` | `~/.rembr` | Recall flags, cursor state, and capture log location |

## How it behaves

- **First prompt**: claims the session atomically, then follows the OpenCode routing contract.
  A specific prompt strips URLs, requests an expanded candidate pool, and curates by raw
  semantic similarity, freshness, workspace/client affinity, supersession, and diversity.
  A vague or continuation prompt restores the newest prior session in the same workspace.
  Semantic emptiness falls back to prioritized recent workspace context. At most five entries
  are injected, wrapped as untrusted historical data, and shown visibly through `systemMessage`.
- **Each prompt**: if the prompt contains a memory trigger ("remember", "my name is",
  "I prefer", "from now on", …) it's stored to Rembr with `autoCaptured: true` metadata.
  Content that looks like prompt injection is never stored. Capture remains active after the
  first-prompt recall flag has been claimed.
- **Session stop**: an async hook digests the transcript lines added since the previous
  pass (per-session cursor in `~/.rembr/cursors/`) and asks a headless `claude -p` session,
  acting as an observer, to extract only durable conclusions. Extracted memories are
  category-validated and secret-filtered before storing; `<private>…</private>` spans are
  stripped from the digest. The cursor advances only after a fully successful pass, so a
  failed distillation is retried at the next Stop. The child session runs with
  `REMBR_CAPTURE_DISABLE=1` so its own hooks never recall or capture recursively.
- **Failure**: every hook is fail-silent with a hard timeout — if Rembr is unreachable,
  hooks emit `{}` and your session continues at full speed. The distiller logs one line to
  `~/.rembr/capture.log` per outcome.

## Development

```bash
npm install   # vitest only — the plugin itself has zero dependencies
npm test
```

Hook logic lives in [scripts/lib.mjs](./scripts/lib.mjs) (shared, tested);
[user-prompt-submit.mjs](./scripts/user-prompt-submit.mjs) is a thin stdin/stdout wrapper.
The Rembr transport is the same stateless MCP `tools/call` pattern used by the
[opencode-rembr](../opencode-rembr) and [openclaw-rembr](../openclaw-rembr) plugins.
