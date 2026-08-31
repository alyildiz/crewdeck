# Crewdeck architecture map

Use this map before reading implementation files. Start with the domain named by the task, its focused tests, and only the dependencies listed here. Do not read all of `src/core.mjs` or the full README by default.

## Public entry points

| Area | Entry point | Notes |
| --- | --- | --- |
| CLI | `bin/crewdeck` | Argument parsing only; delegates to the core facade |
| Pi orchestrator | `.pi/extensions/crewdeck/index.ts` | Tool schemas, compact serialization, completion wakeups, `/crew` |
| Worker reporter | `worker/reporter.ts` | Worker-side completion and candidate contracts |
| Core facade | `src/core.mjs` | Stable public exports and remaining lifecycle domains |

## Domain routing

| Domain | Implementation | Focused verification |
| --- | --- | --- |
| Status, action projection, pagination | `src/core/status.mjs` | `npm run test:status` |
| Completion wakeup and collection boundary | `src/completion-wake.mjs`, `.pi/extensions/crewdeck/index.ts` | `tests/completion-wake.test.mjs`, `tests/completion-boundary.test.mjs` |
| Configuration, profiles, kinds, project registration | `src/core.mjs` configuration section | `npm run test:core` |
| Worker spawn and detached worktrees | `src/core.mjs` spawn section | `tests/core.test.mjs`, `tests/fresh-remote-base.test.mjs`, `tests/reviewed-pr.test.mjs` |
| Review context, differential patches, and evidence verification | `src/core/review.mjs` | `npm run test:review` |
| Results, candidates, review spawning, and forwarding | `src/core.mjs`, `worker/reporter.ts` | `npm run test:review` |
| Draft PR publication and verdict comments | `src/core/publication.mjs` | `npm run test:publication` |
| External merge and base-advance reconciliation | `src/core/reconciliation.mjs` | `npm run test:reconciliation` |
| Orphan report reconciliation | `src/core.mjs` orphan section | `tests/orphan-reconcile.test.mjs` |
| Direct prepare, merge, abandonment, cleanup | `src/core.mjs` integration sections | `tests/abandon.test.mjs`, `tests/core.test.mjs` |
| `/crew` widget formatting | `src/crew-view.mjs` | `tests/crew-view.test.mjs` |

## Status module boundary

`src/core/status.mjs` owns:

- action, detail, and diagnostic status views
- active/history/all pagination and cursors
- token-safe projections and output budgets
- operator action classification
- live status composition from durable, Herdr, Git, result, review, and PR observations

`src/core.mjs` remains the public compatibility facade. It injects private persistence, process, Git, and validation helpers into the domain service factories so extraction does not expose raw state primitives or create circular imports.

The same boundary applies to `src/core/review.mjs`, `src/core/publication.mjs`, and `src/core/reconciliation.mjs`: they own domain policy and operations, while the facade supplies shared low-level capabilities. The review module currently owns bounded context and cryptographic evidence; task spawning and forwarding remain in the facade.

## Verification workflow

During implementation, run the narrowest matching command first:

```bash
npm run test:status
npm run test:core
npm run test:review
npm run test:publication
npm run test:reconciliation
```

Before claiming completion, always run:

```bash
npm test
npm run check
```

Focused commands accelerate iteration. They do not replace the final full suite.

## Change boundaries

- Preserve exports from `src/core.mjs` unless a versioned API change is explicitly requested.
- Keep Git, Herdr, and GitHub mutations fail-closed and independently confirmed where required.
- Keep model-facing variable output bounded and token-redacted.
- Add domain code to its domain module instead of growing the facade when a suitable module exists.
- Extract remaining domains incrementally, with unchanged observable behavior and the full suite passing after each extraction.
