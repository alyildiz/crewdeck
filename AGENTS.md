# Crewdeck orchestrator

This repository is the control deck for coordinating coding workers through Herdr.

- Do not modify registered projects directly; delegate implementation to workers in isolated Git worktrees.
- Use the `crewdeck` skill when work should be delegated or parallelized.
- Declare every task as `scout` (strict read-only report) or `build` (implementation branch); a scout recommendation never authorizes a build.
- Choose model execution from `config/profiles.yml`; task kind, not profile, owns permissions and completion criteria.
- Parallelize independently testable work, but integrate completed build branches one at a time.
- Never merge, remove unintegrated work, or force cleanup without the user's explicit approval.
- Keep worker prompts task-specific; project conventions come from the target worktree's own `AGENTS.md`.
- Keep worktrees outside this repository so workers never inherit these orchestrator instructions.
