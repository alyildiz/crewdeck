---
name: crewdeck
description: Coordinate multiple coding agents through Crewdeck and Herdr. Use whenever the user asks to delegate project work, run workers or scouts, parallelize several coding tasks, inspect worker progress, collect analysis, integrate or abandon worker branches, or clean completed worktrees. Also use when one request contains several independently actionable project changes.
compatibility: Requires Pi inside Herdr 0.8+, Git, and the Crewdeck Pi extension.
---

# Crewdeck

Use Crewdeck as a thin delegation layer. This is the orchestrator's only authorized skill: do not perform target-project domain analysis or implementation yourself, and do not emulate specialist skills. Keep task classification, decomposition, profile selection, result synthesis, and integration judgment here; leave domain work to workers and worktree, Herdr, Git, state, model validation, and safety mechanics to the `crew_*` tools.

## Task kinds

Every task must explicitly declare one immutable kind configured in `config/kinds.yml`. Read that file at intake; it owns each kind's description, lifecycle, permissions, tool allowlist, explicit skill allowlist, and cleanup policy. Skill discovery is disabled for every worker, so `skills: []` means no skills and only listed skill paths are loaded.

Kinds use one of two code-enforced lifecycle families:

- `report`: strict read-only investigation. It cannot receive write or shell tools, cannot be integrated, and submits a structured evidence-based report.
- `change`: implementation. It may modify and test the project, must commit, and submits a structured result bound to its exact HEAD.

The default configuration provides `scout` as a report kind and `build` as a change kind. A profile is orthogonal to kind. Profiles in `config/profiles.yml` select provider, model, thinking level, and allowed kinds; they never grant filesystem permissions.

Choose the best matching configured kind while respecting lifecycle authority. With the default kinds, explicit language such as "analyze", "audit", "investigate", "explain", "do not change code", or "read-only" selects `scout`; explicit implementation language such as "fix", "add", "implement", or "change" selects `build`. When analysis may recommend later implementation but implementation is not already unambiguous, dispatch only a report-lifecycle task; a recommendation is evidence, not authorization to change code.

## Intake

1. Resolve the target from the registered names in `crewdeck.json`. Ask one short question if the project is ambiguous or unregistered.
2. Split the request by independently testable outcome, not by file. Two workers may edit the same file; their branches remain isolated.
3. Serialize only when one task semantically depends on another's result, both mutate the same external state, or independent validation would be misleading.
4. Give each task a stable lowercase id, explicit kind, concrete outcome, acceptance criteria, relevant constraints, and exclusions. Do not copy project conventions: workers load the target worktree's own `AGENTS.md`.
5. Choose only a profile whose `allowedKinds` includes the task kind. Never silently substitute another model when a configured profile is unavailable.

## Dispatch and results

Call `crew_spawn_batch` once for the whole independent batch. Crewdeck creates visible Herdr workspaces outside the orchestrator tree, starts each Pi process in its project worktree, and validates the configured model against Pi's effective registry.

After dispatch, report the task names, kinds, profiles, and purposes. Do not poll repeatedly. The user can inspect every workspace directly in Herdr. When a worker submits `crew_complete`, Crewdeck durably reconciles the result and necessarily wakes this orchestrator with a follow-up naming every newly ready task.

On a `CREWDECK COMPLETION` follow-up, call `crew_status` for the named ids and then `crew_collect_results`; do not merely tell the user that workers finished. Collection acknowledges delivery. It returns the durable structured reports. Report kinds configured with `cleanup: after-collection` are closed only when clean and commit-free; change kinds remain available through integration. A Herdr `idle` or `done` state alone is never completion evidence.

## Steering

Use `crew_steer` for a missing requirement, a concrete correction, or later conflict resolution. Keep messages short because the worker already has its task and project context. Do not use steering for routine progress checks.

## Build integration

Development may run in parallel; integration is sequential.

For each selected change-lifecycle task:

1. Collect its structured result and confirm Crewdeck reports `candidate`: the agent settled, the worktree is clean, at least one commit exists, and the reported commit matches HEAD.
2. Call `crew_diff` and inspect the bounded commits, diffstat, and patch before merge.
3. Call `crew_prepare_integration`. It rebases onto the current local base and runs configured verification commands.
4. Present the verified outcome and meaningful risk to the user.
5. Call `crew_merge` only when the user explicitly asks to merge. The tool independently requests interactive confirmation and performs a local fast-forward only.
6. Integrate the next branch against the newly advanced base.
7. Call `crew_cleanup` only after integration. It also permits resuming interrupted cleanup for an already explicitly abandoned task, but refuses all other unintegrated change work.

For a report task only, when its Herdr workspace and Git worktree were already removed manually and normal cleanup cannot run, call `crew_reconcile_orphan_report`. Never infer this from `agent missing` or `git unavailable`: obtain a concrete reason and use the tool's independent confirmation. It proves resource absence, refuses surviving or uncertain resources, dirty worktrees, and unintegrated branch commits, preserves reports/history, and records the terminal `orphan-reconciled` outcome. Use it to finish a collected report whose cleanup failed with `workspace_not_found`; never edit durable state directly.

When a non-integrated change task is obsolete or superseded, call `crew_abandon` rather than pretending it was integrated or bypassing cleanup with raw Git/Herdr. This operation has its own interactive confirmation, refuses reports, active workers, dirty worktrees, and terminal tasks, records the distinct durable `abandoned` outcome, and removes only the isolated worktree and branch without changing base or pushing.

Conflict reconciliation between concurrent build branches is intentionally deferred to the next Crewdeck milestone. Never bypass a current refusal with raw Git or Herdr commands.

## Recovery

Use `crew_status` after restarting the orchestrator. Durable records and reports preserve task identity and outcomes; `/crew` hides terminal abandoned and orphan-reconciled tasks while `/crew all` shows them. If Herdr reports an agent missing, preserve the worktree and inspect Git before proposing recovery; absence of an agent is never permission to delete work.
