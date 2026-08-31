# Reviewed-PR lifecycle

Read this reference before spawning a reviewed-pr build, reviewer, forwarding review findings, extending rounds, or resuming a build.

## Candidate and review loop

1. A reviewed-pr build owns `crew/<id>` and submits non-terminating, versioned candidates through `crew_submit_candidate`. It must not call `crew_complete`.
2. Collect the exact sequential `build-id@candidate-N` inbox key. Candidate collection is the acknowledgement boundary.
3. Spawn exactly one distinct reviewer with `crew_spawn_review`, binding `parentTaskId` and the candidate's full 40-character `reviewedHead`. Use the default `standard` depth and a low/medium profile for ordinary features. Use `reviewDepth: deep` explicitly only for high-risk security, authorization, concurrency, persistence, destructive, cryptographic, or public-contract work; xhigh/max profiles are refused for standard review.
4. Crewdeck creates SHA-256-bound, shell-free context from the pinned base through the exact candidate. It includes feature scope, candidate summary/tests/risks, changed files, and separately hashed patches. Later rounds lead with prior findings and the correction delta while retaining the full patch as fallback. Crewdeck attaches and verifies the evidence digest automatically. The reviewer returns one of `approved`, `changes-requested`, `blocked`, or `inconclusive` with structured findings.
5. Collect the reviewer result. Crewdeck copies the exact payload into the parent's durable `reviewInbox` before reviewer cleanup.
6. Any build HEAD change invalidates current review and SHA-bound CI authority.
7. For `changes-requested`, call `crew_forward_review`. Never retype or send reviewer findings directly to the build.
8. The same build agent remains sole writer and submits the next candidate. Never stack reviewers.

A standard reviewer starts with the correction delta when present, then examines changed code, direct callers, and associated tests. It does not audit unrelated repository areas or attempt to rerun tests without a shell. Prefer concise actionable findings and stop after one focused pass when no concrete defect remains.

## Escalation and recovery

- `blocked`, `inconclusive`, or a non-approved final round escalates instead of silently spawning another round.
- Extend rounds only through separately confirmed `crew_extend_review_rounds`, with expected current max, larger max, and a durable reason. The extension is monotonic and does not rewrite history.
- If the writer is specifically proven absent, `crew_resume_build` may adopt the intact owned branch/workspace with durable review context. Uncertain or existing writers are refused.
- A dead reviewer may be retired through separately confirmed `crew_retire_agent`; never discard build work to replace a reviewer.

## Approval handoff

After collecting approval for the current exact HEAD:

1. Inspect `crew_diff`.
2. Read [publication.md](publication.md).
3. Publish only through `crew_publish_pr` with explicit remote, repository, base, owned head, title, and body.

Publication is not completion. An externally merged reviewed PR is terminalized only through the separately confirmed reconciliation described in [reconciliation.md](reconciliation.md).
