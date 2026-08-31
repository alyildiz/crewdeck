# Status and durable results

Read this reference for restart recovery, status pagination, diagnostics, or selective result reinspection.

## Completion boundary

A `CREWDECK COMPLETION` follow-up names at most 20 exact durable inbox keys. Call `crew_collect_results` directly with exactly those keys. Do not call status first. Collection validates and acknowledges each event and returns each exact token-redacted payload once.

Reviewed builds require sequential `build-id@candidate-N` keys. A bare reviewed build id never collects candidate history. Restart intentionally reannounces every still-pending durable key.

## Status modes

- Default action status returns identity, observed state, stable next-action code, and only fields required for that action.
- `mode: detail` returns the bounded operational projection.
- `mode: diagnostic` is explicit single-task troubleshooting only. Never use it for normal completion or `/crew`.

Without an id, status returns active tasks by default, 20 per page and at most 50. Explicit `history` and `all` pages use opaque generation-bound cursors. A task creation or scope movement can stale a cursor; restart pagination instead of guessing.

CLI equivalents are `status`, `status --detail`, and `status --diagnostic <id>`. Legacy `--summary` aliases `--detail`.

Safe `result:<id>` and `candidates:<id>` identifiers replace model-facing paths. Use `crew_read_result` only for explicit selective token-redacted reinspection of one report or exact candidate, not normal completion.

## Observer state

The authenticated PR observer rescans on startup and a bounded cadence. `merged-awaiting-confirmed-reconciliation` is notification only. Missing, open, closed-unmerged, unknown, malformed, or lookup-failed observations never imply merge or cleanup authority.
