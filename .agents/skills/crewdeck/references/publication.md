# Draft PR publication

Read this reference before `crew_publish_pr` or `crew_reconcile_verdict`.

## Preconditions

Publication requires a collected approved review for the current clean exact candidate HEAD, a settled or provably absent sole writer, the pinned reviewed base, and explicit values for remote, GitHub `owner/name`, base, owned `crew/<id>` head, title, and body.

Crewdeck fails closed on stale or dirty state, mismatched repository/ref identity, unavailable credentials, missing or moved base, fork/cross-repository PRs, ambiguous PR lookup, non-draft PRs, and missing, pending, stale, failing, malformed, or unavailable exact-SHA GitHub checks. A project may bypass checks only with explicit `githubChecks: none`.

## Side effects and idempotence

- Push only the approved SHA to the owned remote crew ref using a lease. Never push the base.
- Create one open draft PR or update its title/body/base through the GitHub REST API.
- Re-read authoritative PR identity and exact head after mutation.
- Never invoke GitHub approval, ready, merge, or local merge operations.
- Retry reconciles a prior push or PR creation/update instead of duplicating it.

## Immutable verdict comment

After exact PR verification, Crewdeck publishes one bounded audit comment for `taskId + full SHA` with marker:

```text
<!-- crewdeck-verdict:<task-id>:<full-sha> -->
```

The comment includes verdict, SHA, reviewer, candidate version, summary, checks, findings, and open questions. Reviewer text is escaped, mention-neutralized, truncated, and byte-capped. It explicitly is not an official GitHub approval.

Rules:

- Never PATCH, DELETE, edit, or roll back a verdict comment.
- A later approved SHA appends a new comment; old exact-SHA history remains immutable.
- Before POST, paginate the exact PR's comments and search the marker. Adopt one exact body; refuse collisions or divergent content.
- Crewdeck writes a durable `dispatched` intent immediately before the only permitted POST.
- Concurrent callers may relist/adopt only.
- If a lost POST response left the exact comment, retry adopts it.
- If the comment is absent after an uncertain POST, intent becomes durably `ambiguous`; never automatically POST again.

For an ambiguous dispatch, use only separately confirmed `crew_reconcile_verdict` with a durable reason. It performs read-only marker/body lookup and adopts exact evidence. Absence, divergence, or collision remains fail-closed. Never edit durable state to bypass this contract.
