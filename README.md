# Crewdeck

Crewdeck is a lightweight Pi and Herdr orchestrator for running visible coding agents in isolated Git worktrees.

You talk to one Pi session in this repository. Its project-local skill decides how to divide work; its extension performs deterministic Herdr and Git operations. Workers start inside target-project worktrees, so Pi loads each project's own `AGENTS.md` instead of Crewdeck's instructions.

## v0.2 scope

- configurable task kinds in human-editable YAML, backed by safe `report` and `change` lifecycles
- per-kind tool and explicit skill allowlists; skill discovery is disabled for every worker
- provider/model/thinking profiles in a separate human-editable YAML file
- profile validation against Pi's effective model registry
- up to five Pi workers per batch on Herdr 0.8+
- one visible Herdr worktree workspace per task
- strict scouts with only `read`, `grep`, `find`, `ls`, and `crew_complete`
- durable structured scout reports and build results outside worktrees
- durable result reconciliation plus an automatic Pi follow-up whenever a worker completes
- automatic safe report-task cleanup after result collection when configured
- sequential build rebase, verification, local fast-forward merge, and safe cleanup
- orchestrator skill allowlist: only the project-local `crewdeck` skill
- no push, PR creation, remote workers, forced cleanup, or background LLM polling

Conflict reconciliation between two concurrently developed build branches is the next milestone and intentionally remains outside v0.2.

## Layout

```text
~/projects/crewdeck/                         orchestrator cwd
~/.local/share/crewdeck/worktrees/<project>/<task>/
                                            worker cwd
~/.local/state/crewdeck/state.json          durable runtime state
~/.local/state/crewdeck/reports/<task>.json durable worker results
```

Worktrees deliberately live outside this repository. Pi loads context files from its current directory and parents; nesting workers below Crewdeck would leak the orchestrator's `AGENTS.md` into worker contexts.

## Configuration

[`crewdeck.json`](crewdeck.json) owns projects and general behavior:

```json
{
  "maxWorkers": 5,
  "worktreeRoot": "~/.local/share/crewdeck/worktrees",
  "profilesFile": "config/profiles.yml",
  "kindsFile": "config/kinds.yml",
  "projects": {
    "my-project": {
      "path": "/absolute/path/to/my-project",
      "base": "main",
      "trustProjectResources": true,
      "verify": ["npm test"]
    }
  }
}
```

[`config/kinds.yml`](config/kinds.yml) defines task behavior independently from model selection:

```yaml
version: 1
kinds:
  scout:
    lifecycle: report
    description: Strictly read-only investigation that produces an evidence-based report
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

Every worker starts with `--no-skills`. A kind may opt into reviewed skills by listing file or directory paths under `skills`; relative paths resolve from the directory containing `kinds.yml` and are passed as repeatable explicit `--skill` arguments. Report lifecycles are always read-only and shell-free. Change lifecycles must allow writes and shell, include `bash` plus `edit` or `write`, and use integration-gated cleanup. Crewdeck rejects kind definitions that weaken these invariants.

[`config/profiles.yml`](config/profiles.yml) maps friendly profile names to Pi's canonical provider plus model id:

```yaml
version: 1
defaultProfile: cloud-medium
profiles:
  local-fast:
    provider: vllm_qwen38
    model: qwen3.8-27b-fp8
    thinking: low
    allowedKinds: [scout]

  cloud-medium:
    provider: openai-codex
    model: gpt-5.6-sol
    thinking: medium
    allowedKinds: [scout, build]
```

Crewdeck launches `provider/model`, for example `vllm_qwen38/qwen3.8-27b-fp8`. Pi's effective model registry is the runtime authority; a model may originate from `~/.pi/agent/models.json`, a built-in provider, or an extension. Crewdeck refuses unavailable models and profile/kind mismatches instead of silently falling back.

A profile selects model execution only. The kind owns permissions: listing a report kind in `allowedKinds` never grants it write or shell tools.

Set a report kind's `cleanup` to `manual` to preserve collected workers until explicit cleanup. `after-collection` closes only a clean report task with a valid durable result and no commits.

## Setup

Requirements:

- Pi
- Herdr 0.8 or newer
- Git
- Node.js

Install the one runtime dependency and verify Crewdeck:

```bash
cd /home/baris/projects/crewdeck
npm install
npm test
```

Register another project:

```bash
bin/crewdeck project add my-project /absolute/path/to/project --base main --trust
```

`--trust` applies only to change-lifecycle workers. Report workers launch with `--no-approve`. All workers disable discovered extensions and skills, explicitly load Crewdeck's reporter plus only the skills listed by their kind, and still receive the project's `AGENTS.md` because Pi context files load independently of project trust.

Start the orchestrator inside a Herdr pane through its dedicated launcher:

```bash
cd /home/baris/projects/crewdeck
bin/crewdeck-pi --model <orchestrator-model> --thinking xhigh
```

The launcher uses Pi's official `--no-skills` plus one explicit `--skill` path. Consequently, only the `crewdeck` skill is visible to the orchestrator; global skills such as `frontend-design`, `harness-creator`, or `skill-creator` cannot trigger or consume its context. Additional `--skill` arguments are refused. Workers also disable skill discovery, but each kind may explicitly allow reviewed skill paths in `config/kinds.yml`.

Do not start the orchestrator with bare `pi`. Trust Crewdeck when Pi asks, then restart through `bin/crewdeck-pi` so its project extension loads.

Example:

```text
On my-project, use local-fast to analyze the pricing page without changing code, and use cloud-medium to build the already-approved expiration test.
```

Use `/crew` to display active or actionable workers without an LLM turn, `/crew all` to display the complete durable task history, and `/crew clear` to hide the widget. The default view hides terminal `report-collected`, `integrated`, and `cleaned` tasks; a missing Herdr agent remains visible when its task is not terminal. When `crew_complete` stores a result, the orchestrator extension reconciles all durable uncollected reports, groups nearby completions, and calls `pi.sendUserMessage(..., { deliverAs: "followUp" })`. This necessarily wakes the orchestrator so it can inspect status and collect the named results. The same reconciliation runs at session start, so results produced while Pi was stopped or missed by `fs.watch` are delivered at least once; collection is the acknowledgement.

## Task contracts

The default kinds map to these two lifecycle contracts.

### Scout (`report` lifecycle)

```text
running → report-ready → report-collected → cleaned
```

A scout cannot call `write`, `edit`, or `bash`. It must submit `crew_complete` with conclusion, findings, file/line evidence, recommendations, and open questions. Collecting the durable report normally closes and removes the clean scout immediately.

### Build (`change` lifecycle)

```text
running → candidate → ready → integrated → cleaned
```

A build must commit and call `crew_complete` with its exact HEAD, tests, risks, and open questions. `candidate` additionally requires a settled agent, clean worktree, at least one commit, and a result commit matching HEAD. Builds remain alive for integration and possible correction.

## Manual CLI

```bash
bin/crewdeck project list
bin/crewdeck spawn my-project scout pricing-analysis "Analyze column Z without changing code" --profile local-fast
bin/crewdeck spawn my-project build pricing-fix "Fix the price shown in column Z" --profile cloud-medium
bin/crewdeck status
bin/crewdeck collect pricing-analysis
# Add --keep-reports to preserve an auto-cleanup report kind
bin/crewdeck diff pricing-fix
bin/crewdeck prepare pricing-fix
bin/crewdeck merge pricing-fix --confirm
bin/crewdeck cleanup pricing-fix --confirm
```

The CLI's `--confirm` is intended for a human at a shell. The Pi extension independently displays an interactive confirmation before build merge and manual cleanup.
