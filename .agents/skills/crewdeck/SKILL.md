---
name: crewdeck
description: Coordinate multiple coding agents through Crewdeck and Herdr. Use whenever the user asks to delegate project work, run workers or scouts, parallelize several coding tasks, inspect worker progress, collect analysis, integrate worker branches, or clean completed worktrees. Also use when one request contains several independently actionable project changes.
compatibility: Requires Pi inside Herdr 0.8+, Git, and the Crewdeck Pi extension.
---

# Crewdeck

Use Crewdeck as a thin delegation layer. Keep judgment here; leave worktree, Herdr, Git, state, model validation, and safety mechanics to the `crew_*` tools.

## Task kinds

Every task must explicitly declare one immutable kind:

- `scout`: strict read-only investigation. The worker receives only `read`, `grep`, `find`, `ls`, and `crew_complete`; it cannot edit files or run shell commands. Its durable result is a structured report.
- `build`: implementation. The worker may modify and test the project, must commit, and submits a structured result bound to its exact HEAD. Its durable result is the branch plus its report.

A profile is orthogonal to kind. Profiles in `config/profiles.yml` select provider, model, thinking level, and allowed kinds; they never grant filesystem permissions.

Explicit language such as "analyze", "audit", "investigate", "explain", "do not change code", or "read-only" selects `scout`. Explicit implementation language such as "fix", "add", "implement", or "change" selects `build`. When analysis may recommend later implementation but implementation is not already unambiguous, dispatch only a scout; a recommendation is evidence, not authorization to change code.

## Intake

1. Resolve the target from the registered names in `crewdeck.json`. Ask one short question if the project is ambiguous or unregistered.
2. Split the request by independently testable outcome, not by file. Two workers may edit the same file; their branches remain isolated.
3. Serialize only when one task semantically depends on another's result, both mutate the same external state, or independent validation would be misleading.
4. Give each task a stable lowercase id, explicit kind, concrete outcome, acceptance criteria, relevant constraints, and exclusions. Do not copy project conventions: workers load the target worktree's own `AGENTS.md`.
5. Choose only a profile whose `allowedKinds` includes the task kind. Never silently substitute another model when a configured profile is unavailable.

## Dispatch and results

Call `crew_spawn_batch` once for the whole independent batch. Crewdeck creates visible Herdr workspaces outside the orchestrator tree, starts each Pi process in its project worktree, and validates the configured model against Pi's effective registry.

After dispatch, report the task names, kinds, profiles, and purposes. Do not poll repeatedly. The user can inspect every workspace directly in Herdr. Crewdeck displays a token-free notification when a worker submits `crew_complete`; use `crew_status` when asked or before collection/integration.

Call `crew_collect_results` for ready results. It returns the durable structured reports and marks them collected. By default, collected scouts with clean, commit-free worktrees are closed and removed immediately; builders remain available through integration. A Herdr `idle` or `done` state alone is never completion evidence.

## Steering

Use `crew_steer` for a missing requirement, a concrete correction, or later conflict resolution. Keep messages short because the worker already has its task and project context. Do not use steering for routine progress checks.

## Build integration

Development may run in parallel; integration is sequential.

For each selected build task:

1. Collect its structured result and confirm Crewdeck reports `candidate`: the agent settled, the worktree is clean, at least one commit exists, and the reported commit matches HEAD.
2. Call `crew_diff` and inspect the bounded commits, diffstat, and patch before merge.
3. Call `crew_prepare_integration`. It rebases onto the current local base and runs configured verification commands.
4. Present the verified outcome and meaningful risk to the user.
5. Call `crew_merge` only when the user explicitly asks to merge. The tool independently requests interactive confirmation and performs a local fast-forward only.
6. Integrate the next branch against the newly advanced base.
7. Call `crew_cleanup` only after integration. It refuses dirty or unintegrated build work.

Conflict reconciliation between concurrent build branches is intentionally deferred to the next Crewdeck milestone. Never bypass a current refusal with raw Git or Herdr commands.

## Recovery

Use `crew_status` after restarting the orchestrator. Durable records and reports preserve task identity and outcomes. If Herdr reports an agent missing, preserve the worktree and inspect Git before proposing recovery; absence of an agent is never permission to delete work.
