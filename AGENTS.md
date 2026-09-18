# AGENTS.md

## AxiaCraft push-left workflow

- The PM owns planning, assignment, review coordination and the final remote publication. The PM must not implement tickets directly.
- At the start of a checkout, run `scripts/setup-agent-workspace.sh`. Only the PM's integration checkout may use `scripts/setup-agent-workspace.sh --allow-push`.
- Developers work only in their assigned Git worktrees. They run the pre-commit hook, commit locally and hand the resulting SHA to the merge agent. Developers never push.
- The merge agent accepts only reviewed developer SHAs, runs `scripts/run-hooks.sh pre-merge`, integrates onto local main and records the tested integration SHA. The merge agent never pushes.
- After required review approval, the PM runs the pre-push hook and pushes the exact tested main SHA. The remote push triggers CI and deployment.
- A failing local hook or remote pipeline is delivery feedback. Fix the originating ticket and repeat the same gates; do not bypass hooks with `--no-verify`.
