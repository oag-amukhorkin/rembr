#!/usr/bin/env node
// SessionStart hook: inject relevant Rembr memories as additional context.
import { loadConfig, readStdin, sessionStartContext, emit } from "./lib.mjs"

// Recursion guard: headless child sessions spawned by the Stop-hook
// distiller must not recall or capture (REMBR_CAPTURE_DISABLE=1 in their env).
if (process.env.REMBR_CAPTURE_DISABLE) {
  emit({})
  process.exit(0)
}

try {
  const input = await readStdin()
  const context = await sessionStartContext(loadConfig(), input)
  if (context) {
    emit({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    })
  } else {
    emit({})
  }
} catch {
  emit({})
}
