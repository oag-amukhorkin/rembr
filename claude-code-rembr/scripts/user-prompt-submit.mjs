#!/usr/bin/env node
// UserPromptSubmit hook: auto-capture memory-worthy prompts and (optionally,
// REMBR_PROMPT_RECALL=true) inject prompt-relevant Rembr memories.
import { loadConfig, readStdin, userPromptActions, emit } from "./lib.mjs"

// Recursion guard: headless child sessions spawned by the Stop-hook
// distiller must not recall or capture (REMBR_CAPTURE_DISABLE=1 in their env).
if (process.env.REMBR_CAPTURE_DISABLE) {
  emit({})
  process.exit(0)
}

try {
  const input = await readStdin()
  const { additionalContext } = await userPromptActions(loadConfig(), input)
  if (additionalContext) {
    emit({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext,
      },
    })
  } else {
    emit({})
  }
} catch {
  emit({})
}
