# Crewdeck

Crewdeck is a lightweight Pi/Herdr orchestrator for visible coding agents in isolated Git worktrees. Workers load the target project's own `AGENTS.md`; the orchestrator keeps task authority, durable delivery, exact-SHA review, and controlled Git/GitHub operations.

## v0.3 scope

- YAML-configured `report` and `change` lifecycles plus an explicit `review` contract
- direct builds remain compatible with immutable, terminating `crew_complete`
- reviewed-pr builds submit versioned exact-HEAD candidates without terminating their agent
- one distinct read-only reviewer per candidate, bound to `parentTaskId` and `reviewedHead`
- durable review inbox, completion-queue wakeup, orchestrator follow-up, and lossless steering back to the original build
- current review/CI authority becomes stale when build HEAD changes; an already posted exact-SHA verdict comment remains immutable audit history
- one writer on `crew/<id>`; safe adoption only after Crewdeck proves the previous agent absent
- detached branchless worktrees for scouts/reviewers; branch worktrees for builds
- deterministic/idempotent push and GitHub draft-PR create/update after exact-SHA approval
- one bounded, immutable, append-only GitHub verdict comment per approved SHA, with durable dispatch intent and fail-closed ambiguity
- explicit, confirmed reconciliation when that exact published PR was merged externally, producing terminal `pr-merged` history without local integration
- no automatic merge, no PR-ready transition, no GitHub approval review, no stacked reviewers, and no no-mistakes integration
- preserved scout, historical task, direct prepare/merge, abandonment, and orphan-report lifecycles

The Herdr 0.8 API was verified rather than assumed: `worktree create` without `--branch` creates a random branch, while a Git `worktree add --detach` followed by Herdr `worktree open --path` reports `is_detached: true`. Crewdeck uses only that proven detached path and otherwise fails closed.

## Layout and durable state

```text
~/projects/crewdeck/                                      orchestrator cwd
~/.local/share/crewdeck/worktrees/<project>/<task>/      worker cwd
~/.local/state/crewdeck/state.json                       tasks, inbox, publication
~/.local/state/crewdeck/reports/<task>.json              final scout/review/direct result
~/.local/state/crewdeck/reports/<task>.candidates.json   reviewed-pr candidate journal
~/.local/state/crewdeck/reports/<review>.review-evidence.json  exact-SHA bounded review evidence
~/.local/state/crewdeck/reports/<task>.rounds.json       live per-task round authority
```

State uses atomic writes under a verifiable PID/boot/start-time/token lock with dead-owner recovery and confirmed diagnostics for unverifiable stale locks. Candidate versions, collection acknowledgements, structured review findings, forwarding attempts, escalation, remote SHA, PR URL/number, exact-SHA verdict dispatch intents/comment identities, external merge evidence/reconciliation attempts, and timestamps survive orchestrator restart. The completion watcher rescans the durable inbox at session start, so missed filesystem events still generate a Pi follow-up.

## Configuration

Configuration is split between **tracked templates** and **machine-local runtime files**:

| Tracked in Git | Local runtime file (git-ignored) | Owns |
| --- | --- | --- |
| `crewdeck.json.example` | `crewdeck.json` | projects, worker/review limits, file pointers |
| `config/profiles.yml.example` | `config/profiles.yml` | provider/model/thinking profiles |
| `config/kinds.yml` | — (shared, tracked) | lifecycles, contracts, permissions, tools |

`crewdeck.json` and `config/profiles.yml` are machine-specific (local project paths, locally available providers/models) and are never committed. Bootstrap a fresh checkout:

```bash
cp crewdeck.json.example crewdeck.json
cp config/profiles.yml.example config/profiles.yml
```

then edit `crewdeck.json` to register this machine's projects and `config/profiles.yml` to name providers/models that actually exist in this machine's Pi model registry with usable authentication. The templates contain no local paths or projects; the profiles template uses placeholders and makes no claim that any provider or model is universally available.

If the default `crewdeck.json` is missing, Crewdeck fails with a `missing_config` error that prints exactly those copy commands. An explicitly configured `CREWDECK_CONFIG` pointing at a missing file keeps the plain `Cannot read` error without bootstrap guidance.

`crewdeck.json` owns projects and review limits:

```json
{
  "maxWorkers": 5,
  "maxReviewRounds": 3,
  "worktreeRoot": "~/.local/share/crewdeck/worktrees",
  "profilesFile": "config/profiles.yml",
  "kindsFile": "config/kinds.yml",
  "projects": {
    "my-project": {
      "path": "/absolute/path/to/my-project",
      "base": "main",
      "baseRemote": "upstream",
      "githubChecks": "required",
      "trustProjectResources": true,
      "verify": ["npm test"]
    }
  }
}
```

`maxReviewRounds` is 1–10 and defaults to 3 for historical configs. `prObserverIntervalSeconds` defaults to 60 and is bounded to 30–900 seconds.

`githubChecks` is fail-closed and defaults to `required`. Publication and merged reconciliation query both check runs and commit status contexts for the exact approved SHA. Pending, missing, failing, stale-SHA, malformed, ambiguous, or unavailable results refuse completion. Successful, neutral, and skipped completed check runs are accepted; status contexts must be successful. Checks are CI evidence only and never imply reviewer or GitHub approval. Projects intentionally configured without checks must explicitly set `githubChecks: "none"`; status records this disabled escape hatch.

`baseRemote` is optional and is never inferred. When present, every batch containing a `change` task reads only the configured `base` branch from that named remote, fetches it with tags and `FETCH_HEAD` updates disabled, verifies that the advertised ref stayed stable during the fetch, proves the fetched object is the exact commit, and pins one SHA for the whole batch. Each `crew/<id>` change branch is then created from that SHA. The task state exposes `baseSource` (`mode`, `remote`, and full ref) plus `baseSha`.

If `baseRemote` is absent, existing projects retain local-base behavior; Crewdeck resolves and pins the configured local branch at spawn time. A remote lookup, fetch, ref, race, or object-verification failure aborts before any change worktree is created. Fetching may add Git objects, but Crewdeck does not update the primary checkout's branch, working tree, local base ref, remote-tracking refs, tags, or `FETCH_HEAD`.

[`config/kinds.yml`](config/kinds.yml) separates permissions from model selection:

```yaml
version: 1
kinds:
  scout:
    lifecycle: report
    description: Strictly read-only investigation
    permissions: { filesystem: read-only, shell: false }
    tools: [read, grep, find, ls]
    skills: []
    cleanup: after-collection

  review:
    lifecycle: report
    contract: review
    description: Read-only review of one exact build candidate SHA
    permissions: { filesystem: read-only, shell: false }
    tools: [read, grep, find, ls]
    skills: []
    cleanup: after-collection

  build:
    lifecycle: change
    description: Implement, test, and commit an approved change
    permissions: { filesystem: write, shell: true }
    tools: [read, grep, find, ls, bash, edit, write]
    skills: []
    cleanup: after-integration
```

A review contract must be a shell-free, read-only report. Crewdeck requires exactly one configured review kind when spawning a reviewer. Every worker starts with discovered skills disabled; only explicit kind skills are loaded.

`config/profiles.yml` (local copy of the tracked `config/profiles.yml.example`) maps profile names to provider/model/thinking and `allowedKinds`. Profiles never grant permissions. Pi's effective model registry and provider authentication remain runtime authority.

## Setup

Requirements: Node.js, Git, Pi, Herdr 0.8+, and `gh` for draft-PR publication/reconciliation.

```bash
npm install
npm test
npm run check
```

Bootstrap the local runtime config from the tracked templates (see [Configuration](#configuration)):

```bash
cp crewdeck.json.example crewdeck.json
cp config/profiles.yml.example config/profiles.yml
```

Existing installations that already have local `crewdeck.json` and `config/profiles.yml` keep them unchanged; the files are now git-ignored instead of tracked.

Register a project:

```bash
bin/crewdeck project add my-project /absolute/path/to/project --base main --base-remote upstream --trust
```

Launch only through the restricted launcher:

```bash
bin/crewdeck-pi --model <orchestrator-model> --thinking xhigh
```

It disables skill discovery and loads only [`.agents/skills/crewdeck/SKILL.md`](.agents/skills/crewdeck/SKILL.md). Workers disable extension/skill discovery, load only the reporter and configured skills, and receive permissions from their kind.

## Contracts

### Historical/direct result

Scouts and direct builds retain the v0.2 contract. `crew_complete` writes one immutable result and returns `terminate: true`; a second call is refused. Historical records without `contract`, `workflow`, or `maxReviewRounds` normalize to `standard`, `direct`, and the configured default.

```text
scout:       running → report-ready → report-collected → cleaned
direct build running → candidate → ready → integrated → cleaned
                                      ↘ conflict/obsolete → abandoned
```

Local merge still requires the existing explicit user request plus independent confirmation and never pushes.

### Reviewed-pr candidate

A build spawned with `workflow: reviewed-pr` owns `crew/<id>`. Its active tool is `crew_submit_candidate`, not `crew_complete`. Submission verifies:

- branch is exactly `crew/<id>`
- worktree is clean
- supplied 40-character commit equals exact HEAD
- HEAD contains at least one commit ahead of the configured base
- candidate count is within `maxReviewRounds`

It atomically appends candidate `vN`. Repeating an identical HEAD/payload is idempotent; changing the payload for an already submitted SHA is refused. The result has no `terminate`, so the same build remains available for review steering.

```text
running → candidate v1 → exact-SHA review
                     approved ───────────────→ draft PR publication
                                                  externally merged → confirmed reconciliation → pr-merged
                     changes-requested ──────→ durable inbox → steering → candidate v2
                     blocked/inconclusive ───→ escalation
                     final round not approved → escalation
```

Candidate events use keys such as `build-id@candidate-1` in the existing completion queue.

### Review

`crew_spawn_review` requires the parent reviewed-pr build, a collected current candidate, and its full SHA. It refuses a moving writer, stale SHA, duplicate reviewer, another open reviewer, or exhausted rounds. The review task is detached at that exact commit and exposes no shell/write/steering tool.

Before launch Crewdeck precomputes an authoritative bounded evidence document from the pinned `baseSha...reviewedHead`: full commit identities, diffstat, and a patch capped at 40 KiB. The document includes parent/reviewer/base/candidate identity and a SHA-256 digest, is outside the build worktree, and is exposed read-only to the shell-free reviewer. The reviewer attests `evidenceSha256`; collection recomputes the digest and refuses stale or tampered evidence.

Its terminating result contains:

```json
{
  "parentTaskId": "build-id",
  "reviewedHead": "0123456789abcdef0123456789abcdef01234567",
  "verdict": "approved | changes-requested | blocked | inconclusive",
  "evidenceSha256": "<64 hex characters>",
  "summary": "...",
  "findings": [{
    "severity": "blocking | major | minor | nit",
    "title": "...",
    "detail": "...",
    "location": "path:line",
    "recommendation": "..."
  }],
  "checks": ["..."],
  "openQuestions": []
}
```

Approval cannot contain a blocking finding; `changes-requested` requires a finding. Collection copies this exact payload into the parent's durable `reviewInbox`, recording whether parent HEAD was still current. There is no reviewer-to-build message path.

`crew_forward_review` accepts only a collected, current `changes-requested` review. It persists a forwarding attempt, then sends the stored structured JSON through Herdr's agent prompt. Retry is idempotent after confirmed delivery and at-least-once if interruption leaves a pending attempt. `blocked`, `inconclusive`, and exhausted rounds record escalation instead.

`crew_resume_build` is a fail-closed recovery operation. It accepts only reviewed-pr builds, proves the old agent is specifically absent (not merely unreachable), verifies the expected worktree/path/branch/workspace, then starts one replacement writer with durable review context. Any existing or uncertain agent is refused.

## Draft PR publication

After collecting `approved` for the **current** candidate, call `crew_publish_pr` with explicit values:

- remote name, for example `origin`
- GitHub repository `owner/name`
- base branch, equal to the task's configured base
- remote head, exactly `crew/<id>`
- title and body

Before side effects, publication refuses:

- non-reviewed, terminal, dirty, moving, missing, or stale builds
- candidate not collected or current review missing/not approved/stale/escalated
- invalid or mismatched remote/repository/base/head
- any request where head is base or is not the owned Crewdeck branch
- a non-GitHub remote, missing remote base, unavailable `gh` credentials/repository
- an unowned/diverged remote head, ambiguous PR, cross-repository/fork head, non-draft PR, or wrong PR repository/base/head

Crewdeck pushes the approved SHA explicitly to `refs/heads/crew/<id>` with `--force-with-lease`; it never pushes the base. It verifies remote SHA, rechecks local HEAD/cleanliness, creates an open draft PR with `gh pr create`, or updates its title/body/base through `gh api` and the GitHub REST API. Before verdict dispatch it re-reads authoritative PR state and verifies those exact fields, the same-repository draft identity, and the exact head SHA. State records `remote`, `repo`, `base`, `remoteHead`, `remoteSha`, `pushedAt`, `number`, `url`, `prCreatedAt`, `updatedAt`, and verification/attempt timestamps.

After that PR create/update succeeds, Crewdeck publishes one immutable issue comment for the approved SHA. Its deterministic marker is `<!-- crewdeck-verdict:<task-id>:<full-sha> -->`. The bounded comment includes the `approved` verdict, full SHA, reviewer task id, candidate version, summary, checks, structured findings, open questions, and an explicit notice that it is **not an official GitHub approval**. Reviewer-controlled text is JSON-rendered inside escaped `<pre>` blocks, mention-neutralized, section-truncated, and capped at 48 KiB before POST.

Verdict comments are strict append-only audit records:

- Crewdeck never PATCHes or DELETEs a verdict comment and never compensates/rolls one back.
- A later approved SHA intentionally appends a second comment; the prior SHA comment remains valid history even after PR HEAD advances.
- Before the sole possible POST, Crewdeck paginates comments on the exact PR and searches the exact marker. One exact body is adopted/no-op; duplicate marker occurrences or divergent body refuse publication.
- Under the local durable state lock, Crewdeck writes a SHA-bound `dispatched` intent immediately before POST. Concurrent callers seeing it may only relist/adopt, never POST.
- If the POST response is lost, retry relists. An exact comment is adopted; absence changes the intent to durable `ambiguous` and fails closed forever for automatic reposting.
- After a returned/adopted comment, only its GitHub identity is attached to the intent. If HEAD becomes stale after POST, the historical comment is retained and the returned `currentVerdictState` reports the current/stale relationship.

This is deliberately bounded idempotence, not general exactly-once delivery. Crewdeck adds no multi-host lease, heartbeat, global freeze, distributed compensation, or automatic ambiguity recovery. An operator may resolve external ambiguity outside this automatic contract, but must not edit durable state or ask Crewdeck to replace an immutable comment.

PR retry remains deterministic: if push succeeded before interruption, the lease/remote SHA is reconciled; if PR creation succeeded but its response was lost, lookup by exact head/base adopts the unique matching draft. Publication never runs `gh pr review --approve`, `gh pr ready`, `gh pr merge`, or a local merge.

## Recovery and observation controls

State locks are directories with an atomic owner record containing host, PID, Linux boot ID, process start ticks, random token, and acquisition time. Active identity-matching locks are never stolen. After a bounded grace period, same-host dead/PID-reused locks are atomically quarantined and recovered; malformed or otherwise unverifiable locks require `lock-status` followed by separately confirmed `recover-lock --reason ...`. Recovery is audited in `last-lock-recovery.json` and cannot remove a successor lock.

An ambiguous verdict dispatch can be handled only by separately confirmed `reconcile-verdict --reason ...`. It re-lists comments on the exact durable PR and adopts only the exact marker and byte-identical body. It never POSTs, PATCHes, or DELETEs. Exact absence, divergence, collision, and lookup failure produce durable refused reconciliation evidence and remain fail-closed.

`retire-agent --reason ...` retires only an agent proven absent, unless `--terminate` is independently confirmed. Dirty work is always preserved. Change worktrees/branches remain intact for safe adoption; a clean exact detached reviewer may have its isolated workspace closed and becomes replaceable without bypassing Herdr/Git. `extend-review-rounds` requires the expected current maximum, a larger maximum, confirmation, and a durable reason; decisions are monotonic and append-only and never rewrite candidate/review history.

Crewdeck polls exact published PR identities at startup and every configured interval. It records `open`, `closed-unmerged`, `lookup-failed`, `unknown`, or `merged-awaiting-confirmed-reconciliation`; only the last produces a completion notification, and still requires the separate confirmed reconciliation. Polling never merges or mutates GitHub.

### Cross-task base advances

When the authenticated observer **newly** verifies an exact published PR as merged, it fans out only to nonterminal `change` tasks in the same registered project and on the same configured base. The merged source task, reports/reviewers, terminal tasks, and other projects are excluded. Each affected task receives one durable event keyed by source task, prior pinned base SHA, and merge commit SHA; repeated scans and restarts cannot create another event, while a later merge commit creates a new monotonic sequence.

Classification uses only local Git objects and does not touch a worktree: Crewdeck proves the pinned base is an ancestor of the merge commit, then uses `git merge-tree` against the affected exact HEAD. Results are `compatible`, `conflicting`, or fail-closed `unknown`. Status and `/crew` show the latest sequence/classification/delivery state and next action.

`crew_forward_base_advance` (CLI: `forward-base-advance`) is the only delivery path. It never addresses review agents. Unknown evidence is refused. A compatible task with an already published exact-SHA PR is settled as `compatible-preserved` without rebasing, pushing, rewriting the PR, or invalidating its approval. Otherwise Crewdeck durably reserves delivery, advances the task's pinned/required base, marks prior collected reviews and approvals stale, and prompts only the recorded sole writer to preserve work, rebase/adapt, rerun verification, commit, and submit a new exact-HEAD candidate when its SHA changes. An absent writer produces `awaiting-writer` and must be safely resumed first; an uncertain agent state fails closed. Interrupted prompt delivery is explicitly at-least-once on retry, while completed or preserved events are idempotent.

A refreshed reviewed-PR candidate cannot be reviewed or published until its HEAD contains the required advanced base. Existing candidate, review, verdict-comment, and publication history remains immutable; a changed SHA requires a new candidate and exact-SHA review. The observer itself never rebases, mutates worktrees, pushes, stacks reviewers, or reuses stale approval.

## Externally merged PR reconciliation

If a published reviewed PR is merged outside Crewdeck, the build deliberately remains `running` until an operator invokes the separately confirmed `crew_reconcile_merged_pr` (CLI: `reconcile-merged-pr ... --confirm`). Reconciliation is read-only toward GitHub and both base branches: it never pushes, merges, marks ready, updates a base ref, or claims local integration.

Before cleanup it fails closed unless all of these agree:

- the task is a `change` with `workflow=reviewed-pr`, status `running`, expected `crew/<id>` branch/worktree/repository paths, and no active adoption or reviewer;
- one complete durable publication has an exact GitHub remote/repository/base/head/PR URL and number, no dispatched/ambiguous/duplicate/divergent/partial verdict intent, and its SHA equals the latest collected candidate;
- the exact collected approval, reviewer task/report, publication SHA, remote SHA, and candidate version match; when `publication.verdictComments` is present, every entry must be a complete unique `published` intent bound to its exact durable candidate/approval/rendered content and the current candidate must have exactly one matching comment identity;
- `gh pr view` reports that exact same-repository PR as `MERGED` with the exact number, URL, base, head, head OID, merge commit, and merge timestamp;
- the approved SHA is a Git ancestor of the merge commit or the currently advertised remote base SHA (objects are fetched without updating refs or `FETCH_HEAD`);
- the worker is specifically absent or settled (`idle`/`done`), never working, blocked, unknown, or merely unreachable; and the worktree is clean at the exact approved SHA with no newer branch/candidate.

A narrowly bounded bootstrap compatibility applies to publications completed by a session that loaded the pre-verdict implementation: only an entirely absent `publication.verdictComments` field may pass without a verdict comment, and only after every other reconciliation proof above succeeds and an exact-marker lookup finds no untracked GitHub verdict. A present empty/non-array journal, any invalid or partial entry, any `dispatched`/`ambiguous` entry (especially for the current SHA), any metadata/content divergence, or an untracked matching comment still fails closed. Reconciliation never POSTs, PATCHes, or DELETEs GitHub comments. Terminal evidence records this exceptional verdict state as `legacy-absent`; normal append-only publications are recorded as `published`, so history never claims that a legacy comment was posted.

Crewdeck then reserves the attempt durably, rechecks state and remote base, closes the isolated agent/workspace, verifies worktree removal, and deletes `refs/heads/crew/<id>` only with an exact-old-SHA update after containment proof. Any proof or cleanup failure leaves the task nonterminal as `running` with `cleanup-failed` recovery evidence; dirty data, changed branches, and uncontained commits are preserved. A confirmed retry can finish a partially completed cleanup. Only after every cleanup check succeeds does state atomically become `pr-merged` with nested `merged-reconciled` evidence: PR URL/number/base/head, GitHub merge timestamp/commit, approved candidate SHA/version/reviewer, verdict status/identity, remote-base containment proof, cleanup timestamps, and reconciliation time. Candidate journals, reviews, reports, and publication history are never deleted. Repeating the operation after success is idempotent.

`pr-merged` is hidden from `/crew` and retained in `/crew all` and `crew_status` history. It is deliberately distinct from `integrated`, `abandoned`, and generic `cleaned`.

## Pi extension API

The project extension exposes:

- `crew_spawn_batch` (`workflow` may be `direct` or `reviewed-pr`)
- `crew_spawn_review`
- `crew_status` (bounded active or targeted summary by default; explicit paginated `history`/`all`; full single-task troubleshooting only with `mode=diagnostic`), `crew_collect_results`, explicit selective `crew_read_result`, `crew_diff`
- `crew_steer`, `crew_forward_review`, `crew_resume_build`
- `crew_publish_pr`, read-only `crew_observe_prs`, controlled `crew_forward_base_advance`
- separately confirmed `crew_reconcile_verdict`, `crew_extend_review_rounds`, `crew_retire_agent`, and state-lock recovery
- separately confirmed `crew_reconcile_merged_pr`
- existing `crew_prepare_integration`, confirmed `crew_merge`, confirmed `crew_abandon`, confirmed `crew_reconcile_orphan_report`, and confirmed `crew_cleanup`

When durable events arrive, the extension uses `pi.sendUserMessage(..., { deliverAs: "followUp" })`. Completion keys are announced in chunks of 20. Announcement memory is session-local by design: every restart reconciles and reannounces still-pending durable keys, so a delivered message can never hide an uncollected event after restart. The orchestrator calls bounded targeted status and then collection; no background LLM polling occurs. Merged-PR base-advance notices use the same 20-item chunk ceiling.

`crew_status` is bounded by default. With an `id` it returns one targeted token-safe projection and does not inline result payloads, candidate journals, task descriptions, or raw paths. Without an id it returns an active/actionable page of 20; `scope=history|all` and `limit` up to 50 are explicit. Returned opaque cursors bind scope and a task-membership generation, and fail visibly with `invalid_status_cursor` after creation or scope transitions instead of silently skipping work. Legacy non-negative safe-integer offsets remain accepted as best-effort input, but every new continuation is opaque. The actual indented UTF-8 Pi/CLI boundary has a 128 KiB hard budget, including Unicode and JSON escaping. Terminal summaries expose safe `result:<id>` and `candidates:<id>` references where relevant; `pr-merged.terminalAt` is local `mergedReconciledAt`, while `remotePrMergedAt` is GitHub's merge time.

Full historical behavior remains available only as explicit troubleshooting: Pi uses `crew_status { id, mode: "diagnostic" }`; CLI uses `crewdeck status --diagnostic <id>`. The old CLI `--summary` flag remains a bounded no-op for compatibility, but `status [id]` now defaults safe. Raw report/candidate paths are never model-facing. Use `crew_read_result { key }` or `crewdeck read-result <key>` to selectively read one token-redacted report or one exact candidate version.

`crew_collect_results` accepts at most 20 exact keys. For explicit keys, the backward-compatible result array contains each report/candidate payload exactly once plus a minimal task projection. Omitted ids return one bounded `{ items, pagination }` page with `remaining/hasMore` metadata. A reviewed build id never means all candidate versions: use sequential exact `build-id@candidate-N` keys. Duplicate, out-of-order, oversized, missing, and already-collected requests fail clearly.

## Manual CLI

```bash
# Direct compatibility
bin/crewdeck spawn my-project scout inspect "Inspect without changing code" --profile local-fast
bin/crewdeck spawn my-project build direct-fix "Implement the accepted fix" --profile cloud-medium
bin/crewdeck collect inspect
bin/crewdeck status --scope active --limit 20
# explicit troubleshooting only:
bin/crewdeck status --diagnostic direct-fix
bin/crewdeck prepare direct-fix
bin/crewdeck merge direct-fix --confirm

# Reviewed PR
bin/crewdeck spawn my-project build reviewed-fix "Implement the accepted fix" --profile cloud-medium --reviewed-pr
bin/crewdeck collect reviewed-fix@candidate-1
bin/crewdeck review reviewed-fix reviewed-fix-r1 <40-char-sha> "Review correctness and regressions" --profile cloud-deep
bin/crewdeck collect reviewed-fix-r1
bin/crewdeck forward-review reviewed-fix-r1
# after a later approved current SHA:
bin/crewdeck publish reviewed-fix \
  --remote origin --repo owner/repo --base main --head crew/reviewed-fix \
  --title "Reviewed fix" --body "Draft PR body"
# only after that exact PR was merged externally on GitHub:
bin/crewdeck observe-prs reviewed-fix
# for each affected task reported by the observer/status:
bin/crewdeck forward-base-advance another-build --sequence 1
bin/crewdeck reconcile-merged-pr reviewed-fix --confirm

# Recovery/control
bin/crewdeck reconcile-verdict reviewed-fix --confirm --reason "lost POST response"
bin/crewdeck extend-review-rounds reviewed-fix --current-max 3 --new-max 4 --confirm --reason "one correction cycle approved"
bin/crewdeck retire-agent reviewed-fix-r1 --confirm --reason "agent is absent"
bin/crewdeck lock-status
bin/crewdeck recover-lock --confirm --reason "owner record interrupted before completion"
bin/crewdeck resume reviewed-fix
bin/crewdeck abandon obsolete-fix --confirm --reason "superseded"
bin/crewdeck reconcile-orphan old-report --confirm --reason "manual removal during maintenance"
```

Use `/crew` for a bounded active/actionable page, `/crew all [cursor]` for one bounded all-task page with visible continuation metadata, and `/crew clear` to hide the widget. Active cleanup work includes `integrated`, `report-collected`, and other records that have not reached durable cleanup terminalization. Do not bypass refusals by editing state or issuing raw Git, Herdr, or GitHub commands.
