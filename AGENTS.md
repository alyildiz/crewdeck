# Crewdeck orchestrator

This repository is the control deck for coordinating coding workers through Herdr.

- Do not modify registered projects directly; delegate implementation to workers in isolated Git worktrees.
- Run this orchestrator through `bin/crewdeck-pi`; `crewdeck` is its only authorized skill. If any other skill is advertised, stop and ask the user to restart with the launcher.
- Use the `crewdeck` skill when work should be delegated or parallelized.
- Declare every task with a kind from `config/kinds.yml`; its code-enforced `report` or `change` lifecycle owns permissions and completion criteria. The defaults are `scout` and `build`, and a report recommendation never authorizes a change.
- Choose model execution from `config/profiles.yml` (local runtime copy of the tracked `config/profiles.yml.example`; both `crewdeck.json` and `config/profiles.yml` are git-ignored and bootstrapped from their `*.example` templates); profiles never grant tools, skills, or filesystem permissions.
- Parallelize independently testable work, but integrate completed build branches one at a time.
- Never merge, remove unintegrated work, or force cleanup without the user's explicit approval.
- Keep worker prompts task-specific; project conventions come from the target worktree's own `AGENTS.md`.
- Keep worktrees outside this repository so workers never inherit these orchestrator instructions.
- For implementation work in Crewdeck itself, read `docs/architecture.md` first, then inspect only the routed domain and focused tests. Do not read all of `src/core.mjs` or the full README unless the task crosses those boundaries.
- Use the focused `npm run test:*` command during iteration, then run both `npm test` and `npm run check` before claiming completion.
