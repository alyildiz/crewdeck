# Direct integration and recovery

Read this reference before preparing, merging, abandoning, cleaning, steering, retiring an agent, or recovering a state lock.

## Direct build integration

For each selected direct change task, serialize integration:

1. Collect its immutable result and confirm a settled agent, clean worktree, commits ahead, and reported commit matching HEAD.
2. Inspect bounded `crew_diff`.
3. Run `crew_prepare_integration`, which rebases and runs configured verification.
4. Present verified outcome and risk.
5. Call `crew_merge` only after an explicit user request and independent confirmation. It is local fast-forward only and never pushes.
6. Call `crew_cleanup` only after integration.

Use confirmed `crew_abandon` for a clean, settled, obsolete unintegrated change. It never changes the base or pushes. Never merge or remove unintegrated work without explicit approval.

## Steering

Use `crew_steer` for ordinary missing requirements or conflict instructions. Use `crew_forward_review` for collected review findings, never direct reviewer-to-build messaging.

## Agent retirement

Use separately confirmed `crew_retire_agent` with a durable reason only when an agent is proven absent, or with explicit termination confirmation. It never discards dirty or unintegrated change work. It may close a clean dead report/reviewer checkout so replacement work can proceed.

Missing alone is not deletion authority. Unavailable or uncertain agent state fails closed.

## State locks

Inspect locks with `crew_state_lock`. Confirmed recovery requires a durable reason and never steals a lock whose PID, boot identity, and process start time prove an active owner. Never delete or edit lock/state files manually.

## Cleanup boundaries

- Report cleanup requires collected durable output and immutable checkout identity.
- Change cleanup requires integration or explicit abandonment.
- Reviewed-pr publication is never cleaned through direct integration tools.
- Externally merged reviewed PRs use only `crew_reconcile_merged_pr` as described in [reconciliation.md](reconciliation.md).
