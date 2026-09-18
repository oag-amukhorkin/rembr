#!/usr/bin/env sh
set -eu

phase="${1:-pre-commit}"
root="$(git rev-parse --show-toplevel)"
cd "$root"

git diff --check
git diff --check --cached

components="rembr-mcp rembr-console claude-code-rembr codex-rembr openclaw-rembr opencode-rembr"
for component in $components; do
  [ -f "$component/package.json" ] || continue
  npm --prefix "$component" run --if-present build
  if [ "$phase" != pre-commit ]; then
    if [ "$component" = "rembr-mcp" ]; then
      npm --prefix "$component" run test:unit
    else
      npm --prefix "$component" test
    fi
  fi
done
case "$phase" in
  pre-commit|pre-merge|pre-push) ;;
  *) echo "unknown hook phase: $phase" >&2; exit 2 ;;
esac

printf '%s\n' "push-left gate passed: $phase"
