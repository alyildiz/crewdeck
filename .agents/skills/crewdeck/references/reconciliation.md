# Reconciliation and base advances

Read this reference before `crew_reconcile_merged_pr`, `crew_forward_base_advance`, or orphan reconciliation.

## Externally merged reviewed PR

Observation only notifies. It never authorizes cleanup or terminalization. Call `crew_reconcile_merged_pr` only after explicit user intent and its independent confirmation.

Reconciliation requires:

- reviewed-pr change lifecycle and exact durable publication identity
- one latest collected candidate and one exact durable approval
- valid published immutable verdict evidence, or the narrowly bounded legacy-absent exception
- exact same-repository GitHub PR in `MERGED`
- approved SHA contained by merge commit or current remote base
- passing exact-SHA checks unless explicitly disabled
- settled or provably absent writer
- clean exact worktree and no newer candidate
- no publication ambiguity

It never pushes, merges, updates either base, edits comments, or claims local integration. On success it closes only isolated resources, deletes only the exact contained crew branch, preserves reports/candidates/reviews/publication evidence, and writes terminal `pr-merged` plus `merged-reconciled` evidence.

On proof or cleanup failure, state remains nonterminal and dirty/uncontained work is preserved. Retry a `cleanup-failed` operation through the same confirmed tool, never raw cleanup.

The legacy exception applies only when `publication.verdictComments` is completely absent from a pre-verdict publication. A present empty, partial, invalid, divergent, dispatched, or ambiguous journal is not legacy. Exact-marker lookup must also prove no untracked verdict comment exists.

## Base advances

A merged observed publication can create durable base-advance notifications for eligible same-project change tasks. Use action `crew_status` by id, then `crew_forward_base_advance` for a known compatible/conflicting classification.

- Unknown classification fails closed and must not be forwarded or mutated.
- Compatible already-contained or published work may be settled without rewriting the candidate.
- Otherwise forward to the sole writer, invalidate prior review authority, adapt/rebase without discarding work, verify, and submit a new candidate if SHA changes.
- If the writer is absent, resume the sole writer before forwarding.

## Orphan reports

For a report whose Herdr workspace and Git worktree were removed manually, use separately confirmed `crew_reconcile_orphan_report` with a concrete durable reason. It proves resources absent, preserves report/history, and refuses uncertainty, dirty data, change tasks, or unintegrated commits. Never edit durable state or use raw Herdr/Git cleanup as a substitute.
