#!/usr/bin/env sh
set -eu

root="$(git rev-parse --show-toplevel)"
cd "$root"
git config extensions.worktreeConfig true
git config core.hooksPath .githooks
if [ "${1:-}" = "--allow-push" ]; then
  git config --worktree axiacraft.pushAuthorized true
  printf '%s\n' "hooks installed; this checkout is authorised for the PM's final push"
else
  git config --worktree axiacraft.pushAuthorized false
  printf '%s\n' "hooks installed; remote pushes are blocked in this checkout"
fi
