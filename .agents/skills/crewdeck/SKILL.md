---
name: crewdeck
description: Coordinate multiple coding agents through Crewdeck and Herdr. Use whenever the user asks to delegate project work, run workers or scouts, parallelize coding tasks, review exact build candidates, publish or reconcile an externally merged reviewed PR, inspect worker progress, collect results, integrate or abandon worker branches, or clean completed worktrees.
compatibility: Requires Pi inside Herdr 0.8+, Git, and the Crewdeck Pi extension.
---

# Crewdeck

Use Crewdeck as a thin delegation layer. This is the orchestrator's only authorized skill. Do not implement target-project changes yourself or emulate specialist skills. Keep classification, decomposition, profile selection, review control, synthesis, and integration judgment here. Leave project work to workers and deterministic lifecycle operations to `crew_*` tools.

## Authority model

Read `config/kinds.yml` at intake. Every task declares one immutable configured kind:

- `report`: shell-free, read-only investigation. A recommendation never authorizes a change.
- `change`: one writable `crew/<id>` branch.
- `contract: review`: read-only report bound to one parent and exact full SHA.

Profiles select provider/model/thinking and allowed kinds only. They never grant tools or permissions. Scouts/reviewers use detached immutable worktrees; builds retain their owned crew branch. A build uses `direct` unless exact-SHA review plus draft-PR publication was requested, in which case use `reviewed-pr`.

## Dispatch

1. Resolve one registered project from local `crewdeck.json`; ask one short question only if ambiguous or unregistered.
2. Split by independently testable outcome. Serialize semantic dependencies and external-state mutations.
3. Give each task a stable lowercase id, configured kind, concrete outcome, acceptance criteria, constraints, and exclusions.
4. Select only a profile whose `allowedKinds` includes the task kind. Never silently substitute a model.
5. Spawn independent tasks once with `crew_spawn_batch`. Never include a review kind there.
6. Report ids, kinds, workflows, profiles, and purposes. Do not poll. Herdr workspaces remain visible.

## Completion

When `CREWDECK COMPLETION` announces exact inbox keys, call `crew_collect_results` directly with exactly those keys. Do not call status first. Collection is acknowledgement and returns each payload once. Never infer completion from Herdr `idle` or `done`.

Use action `crew_status` only when the next action is unclear, after restart without a completion event, or when inspection is requested. Read [status.md](references/status.md) before pagination, diagnostics, or result reinspection.

## Load detailed procedures only when needed

Before performing an operation, read its reference:

| Operation | Required reference |
| --- | --- |
| reviewed candidate, reviewer, findings, rounds, build resume | [reviewed-pr.md](references/reviewed-pr.md) |
| draft PR, checks, immutable verdict, verdict reconciliation | [publication.md](references/publication.md) |
| merged PR, base advance, orphan reconciliation | [reconciliation.md](references/reconciliation.md) |
| direct prepare/merge/abandon/cleanup, steering, agent/lock recovery | [recovery.md](references/recovery.md) |
| status, restart recovery, collection details | [status.md](references/status.md) |

Follow cross-references before calling the corresponding tool. Do not load unrelated references.

## Hard safety invariants

- Never merge, push, remove unintegrated work, or force cleanup without the lifecycle's explicit user approval and independent confirmation.
- Never bypass Crewdeck with raw Git, Herdr, GitHub, lock-file, report-file, or durable-state mutations.
- Never use no-mistakes, add extra reviewers, stack reviewers, or create reviewer-to-build communication.
- Never call GitHub approval, ready, or merge commands. Reviewed-pr merge occurs externally; Crewdeck only observes and separately reconciles it.
- Never edit, delete, replace, or compensate an immutable verdict comment. Ambiguous dispatch stays fail-closed until confirmed read-only reconciliation.
- Missing or uncertain agents, PRs, checks, workspaces, refs, evidence, or locks are not mutation authority.
- Keep worker prompts task-specific. Target-project conventions come from that isolated worktree's own `AGENTS.md`.
- Keep workers outside this repository so they do not inherit orchestrator instructions.
