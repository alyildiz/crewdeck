---
name: crewdeck
description: Coordinate multiple coding agents through Crewdeck and Herdr. Use whenever the user asks to delegate project work, run workers or scouts, parallelize coding tasks, review exact build candidates, publish or reconcile an externally merged reviewed PR, inspect worker progress, collect results, integrate or abandon worker branches, or clean completed worktrees.
compatibility: Requires Pi inside Herdr 0.8+, Git, and the Crewdeck Pi extension.
---

# Crewdeck

Use Crewdeck as a thin delegation layer. This is the orchestrator's only authorized skill: do not perform target-project implementation yourself or emulate specialist skills. Keep task classification, decomposition, profile selection, reviewed-PR control, result synthesis, and integration judgment here; leave project work to workers and deterministic Herdr/Git/GitHub operations to `crew_*` tools.

## Task kinds and workflows

Every task declares an immutable kind from `config/kinds.yml`. Read it at intake. Kinds own lifecycle, contract, permissions, tools, explicit skills, and cleanup; profiles only select provider/model/thinking and allowed kinds.

- `report`: strict read-only, shell-free investigation. A recommendation never authorizes code changes.
- `change`: owns one writable `crew/<id>` branch and may implement/commit.
- `contract: review`: a report kind bound to one `parentTaskId` and one full `reviewedHead`. It emits only `approved`, `changes-requested`, `blocked`, or `inconclusive` plus structured findings.

Defaults are `scout`, `review`, and `build`. Scouts and reviewers use detached, branchless Git worktrees opened by Herdr because that exact Herdr 0.8 path is proven; builds retain `crew/<id>`. Reviewers never have a communication path to builds.

A build has one of two workflows:

- `direct` (default, backward compatible): terminating immutable `crew_complete`, then the existing prepare/confirmed-local-merge lifecycle.
- `reviewed-pr`: non-terminating, versioned `crew_submit_candidate`; exact-SHA review rounds; deterministic draft-PR publication followed by one immutable append-only verdict comment per approved SHA. It is never prepared for local merge by this workflow.

## Intake and dispatch

1. Resolve a registered project from `crewdeck.json`; ask one short question only if ambiguous/unregistered.
2. Split by independently testable outcome. Serialize semantic dependencies and external-state mutations.
3. Give every task a stable lowercase id, configured kind, concrete outcome, acceptance criteria, constraints, and exclusions.
4. Use only a profile whose `allowedKinds` includes the kind. Never silently substitute a model.
5. Select `workflow: reviewed-pr` only when exact-SHA review and draft-PR publication are requested; otherwise preserve `direct`.
6. Call `crew_spawn_batch` once for independent work. Never put a review kind in this batch: use `crew_spawn_review` after collecting a candidate.

After dispatch, report task names, kinds, workflows, profiles, and purposes. Do not poll. Herdr workspaces stay visible.

## Durable inbox and wakeups

`crew_submit_candidate` stores `build-id@candidate-N` without terminating the build. `crew_complete` still terminates direct builds, scouts, and reviewers and remains immutable for historical tasks.

The completion watcher reconciles durable inbox events on writes and restart, then necessarily wakes this orchestrator with `CREWDECK COMPLETION`. On that follow-up:

1. Call `crew_status` for the named task ids (strip `@candidate-N` from inbox keys).
2. Call `crew_collect_results` with the exact inbox keys from the follow-up.
3. Treat collection as acknowledgement. Never infer completion from Herdr `idle`/`done` alone.

Report kinds configured `after-collection` close only after their durable result is collected and their immutable worktree is clean.

## Reviewed-PR loop

For one reviewed-pr build:

1. Collect its current `build-id@candidate-N`. Confirm the worktree is clean and HEAD equals the full candidate SHA.
2. Call `crew_spawn_review` with a distinct id, the build `parentTaskId`, and that exact 40-character `reviewedHead`. Crewdeck refuses duplicate/concurrent reviewers and stale candidates.
3. When the reviewer wakes the orchestrator, collect it. Crewdeck copies the exact verdict/findings into the parent's durable `reviewInbox` before reviewer cleanup.
4. Re-check status. Any HEAD change invalidates the review (and any SHA-bound CI evidence).
5. For `changes-requested`, call `crew_forward_review` with the review id. This is the only allowed path: durable inbox → orchestrator follow-up → Herdr steering tool. It forwards the stored JSON without lossy retyping. Never send a reviewer message directly to the build.
6. The same build agent remains sole writer and submits the next candidate after corrections. If its agent is provably absent, `crew_resume_build` may adopt the intact owned branch/workspace; it refuses an existing/uncertain writer.
7. `blocked`/`inconclusive`, or `changes-requested` at `maxReviewRounds`, produces durable escalation rather than silently starting another round. Never stack several reviewers.
8. After a collected `approved` verdict for the current HEAD, inspect `crew_diff`, then call `crew_publish_pr` with explicit `remote`, GitHub `owner/name`, `base`, owned `head=crew/<id>`, title, and body.
9. Publication is not completion. If that exact PR is later merged externally on GitHub, call `crew_reconcile_merged_pr` only with the user's explicit intent and accept its independent confirmation. Never substitute `crew_merge`, `crew_cleanup`, or `crew_abandon`.

`crew_publish_pr` is fail-closed and idempotent. It validates the GitHub remote/repository/base/head, exact current candidate and approval, clean worktree, settled/provably absent writer, credentials, forge repository, remote ref ownership, and same-repository non-fork draft PR identity. It pushes the approved SHA (never the base), uses a lease, creates or updates one draft PR, and durably stores URL, number, remote head/SHA, and timestamps. Retry reconciles a PR created before an interrupted response.

After successful draft create/update it posts one bounded immutable audit comment for `taskId+full SHA`. The deterministic marker and exact expected body are searched on that exact PR before POST. One exact match is adopted; marker collision or divergent content is refused. A local durable `dispatched` intent is written immediately before the only allowed POST, so concurrent calls only relist. A lost response with an applied exact comment is adopted on retry; if absent, the intent becomes durably ambiguous and Crewdeck fails closed without a second POST. A later approved SHA intentionally appends another comment, while prior comments remain immutable history even if HEAD advances. Reviewer text is escaped, mention-neutralized, truncated, and capped before POST. The comment explicitly is not an official GitHub approval.

Never edit/delete/roll back a verdict comment, never compensate an ambiguous dispatch, and never bypass the bounded model with a multi-host lease, heartbeat, global freeze, or durable-state edits. This contract does not promise general exactly-once delivery. `crew_publish_pr` never calls GitHub review approval, marks a PR ready, or merges.

Do not use no-mistakes or add extra reviewers. Merge is outside reviewed-pr publication and remains governed by the existing explicit local merge authorization for direct tasks; never call GitHub merge commands.

`crew_reconcile_merged_pr` is the only reviewed-pr terminalization path for an externally merged publication. It requires lifecycle `change`, `workflow=reviewed-pr`, exact durable publication/approval/candidate identity, an exact same-repository GitHub PR in `MERGED`, approved-SHA ancestry in its merge commit or current remote base, a settled/provably absent agent, clean exact worktree, no newer candidate, and no publication ambiguity. It never pushes, merges, updates either base, or claims local integration. On success it closes only isolated resources, deletes only the exact contained crew branch, preserves every candidate/review/report/publication record, and writes terminal `pr-merged` plus `merged-reconciled` evidence. On proof or cleanup failure it remains nonterminal and preserves dirty/uncontained work. The operation is separately confirmed and idempotent after success; `/crew` hides `pr-merged`, while `/crew all` retains it.

## Direct build integration

For each selected direct change task, sequentially:

1. Collect its structured result and confirm `candidate`: settled agent, clean worktree, commits ahead, reported commit matching HEAD.
2. Call `crew_diff` and inspect bounded commits/diffstat/patch.
3. Call `crew_prepare_integration` to rebase and run configured verification.
4. Present verified outcome and risk.
5. Call `crew_merge` only after explicit user request and its independent confirmation. It is local fast-forward only and never pushes.
6. Call `crew_cleanup` only after integration.

Use `crew_abandon` for a clean settled obsolete unintegrated change. It has independent confirmation and never changes base or pushes.

## Steering and recovery

Use `crew_steer` for ordinary missing requirements or conflict instructions. Use `crew_forward_review` instead for collected review findings.

Use `crew_status` after restart; state, candidate journals, review inboxes, delivery acknowledgements, escalation, publication metadata, and merged-PR reconciliation attempts are durable. A `cleanup-failed` merged-PR attempt must be retried through the same confirmed tool, never bypassed with raw cleanup. Missing agents alone are never deletion authority.

For a report whose Herdr workspace and Git worktree were already removed manually, `crew_reconcile_orphan_report` requires a concrete reason and independent confirmation, proves resources absent, preserves reports/history, and refuses uncertainty, dirty data, or unintegrated commits. Never edit durable state directly or bypass Crewdeck with raw Herdr/Git/GitHub commands.
