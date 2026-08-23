---
name: crewdeck
description: Coordinate multiple coding agents through Crewdeck and Herdr. Use whenever the user asks to delegate project work, run workers or scouts, parallelize several coding tasks, inspect worker progress, integrate worker branches, or clean completed worktrees. Also use when one request contains several independently actionable project changes.
compatibility: Requires Pi inside Herdr 0.8+, Git, and the Crewdeck Pi extension.
---

# Crewdeck

Use Crewdeck as a thin delegation layer. Keep judgment here; leave worktree, Herdr, Git, state, and safety mechanics to the `crew_*` tools.

## Intake

1. Resolve the target from the registered names in `crewdeck.json`. Ask one short question if the project is ambiguous or unregistered.
2. Split the request by independently testable outcome, not by file. Two workers may edit the same file; their branches remain isolated.
3. Serialize only when one task semantically depends on another's result, both mutate the same external state, or independent validation would be misleading.
4. Give each task a stable lowercase id, a concrete outcome, acceptance criteria, relevant constraints, and explicit exclusions. Do not copy project conventions: workers load the target worktree's own `AGENTS.md`.
5. Use `scout` for read-only investigation and `worker` for implementation. Do not launch implementation when the user requested only analysis.

## Dispatch

Call `crew_spawn_batch` once for the whole independent batch. Crewdeck creates visible Herdr workspaces outside the orchestrator tree, starts each Pi process in its project worktree, and applies the configured model profile.

After dispatch, report the task names and purpose. Do not poll repeatedly. The user can inspect every workspace directly in Herdr; use `crew_status` when asked or before integration.

## Steering

Use `crew_steer` for a missing requirement, a concrete correction, or conflict resolution. Keep messages short because the worker already has its task and project context. Do not use steering for routine progress checks.

A Herdr `idle` or `done` state means the worker settled, not that its implementation is valid. Check the Git snapshot: implementation work should have a clean worktree and at least one commit.

## Integration

Development may run in parallel; integration is sequential.

For each selected implementation task:

1. Confirm the worker has settled and review its summary or recent terminal output when needed.
2. Call `crew_prepare_integration`. It rebases onto the current local base and runs configured verification commands.
3. If rebase conflicts, use `crew_steer` to return resolution to the original worker. Ask it to preserve the accepted intent of both the new base and its task, finish the rebase, rerun relevant tests, and report the result. Then prepare again.
4. Present the verified outcome and meaningful risk to the user.
5. Call `crew_merge` only when the user explicitly asks to merge. The tool independently requests interactive confirmation and performs a local fast-forward only.
6. Integrate the next branch against the newly advanced base.
7. Call `crew_cleanup` only after integration. It refuses dirty or unintegrated work.

Never bypass a refusal with raw Git or Herdr commands. Version 0.1 intentionally does not push, create PRs, force cleanup, or discard work.

## Recovery

Use `crew_status` after restarting the orchestrator. Durable task records contain project, branch, worktree, workspace, pane, and agent identities. If Herdr reports an agent missing, preserve the worktree and inspect Git before proposing recovery; absence of an agent is never permission to delete work.

## User-facing summaries

Prefer outcomes over mechanics:

- dispatch: which outcomes are running;
- blocker: the evidence, consequence, and needed decision;
- ready: changed behavior, tests, and risk;
- merged: task and local base advanced;
- failure: exact task and preserved work location.
