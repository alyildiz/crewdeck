# Crewdeck

Crewdeck is a lightweight Pi and Herdr orchestrator for running visible coding agents in isolated Git worktrees.

You talk to one Pi session in this repository. Its project-local skill decides how to divide work; its extension performs deterministic Herdr and Git operations. Workers start inside target-project worktrees, so Pi loads each project's own `AGENTS.md` instead of Crewdeck's instructions.

## v0.2 scope

- explicit `scout` and `build` task kinds with different permissions and completion contracts
- provider/model/thinking profiles in human-editable YAML
- profile validation against Pi's effective model registry
- up to five Pi workers per batch on Herdr 0.8+
- one visible Herdr worktree workspace per task
- strict scouts with only `read`, `grep`, `find`, `ls`, and `crew_complete`
- durable structured scout reports and build results outside worktrees
- token-free TUI notification when a result arrives
- automatic safe scout cleanup after result collection
- sequential build rebase, verification, local fast-forward merge, and safe cleanup
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
  "scoutCleanup": "after-collection",
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

A profile selects model execution only. Task kind owns permissions: allowing a profile for `scout` never gives that scout write tools.

Set `scoutCleanup` to `manual` to preserve collected scouts until explicit cleanup; the default `after-collection` closes only a clean scout with a valid durable report and no commits.

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

`--trust` applies only to build workers. Strict scouts launch with `--no-approve`, disable discovered extensions and skills, explicitly load only Crewdeck's reporter, and still receive the project's `AGENTS.md` because Pi context files load independently of project trust.

Start the orchestrator inside a Herdr pane:

```bash
cd /home/baris/projects/crewdeck
pi --model <orchestrator-model> --thinking xhigh
```

Trust Crewdeck when Pi asks, then restart or `/reload` so its extension and skill load.

Example:

```text
On my-project, use local-fast to analyze the pricing page without changing code, and use cloud-medium to build the already-approved expiration test.
```

Use `/crew` to display current workers without an LLM turn and `/crew clear` to hide the widget. Result files trigger a TUI notification without waking the LLM.

## Task contracts

### Scout

```text
running → report-ready → report-collected → cleaned
```

A scout cannot call `write`, `edit`, or `bash`. It must submit `crew_complete` with conclusion, findings, file/line evidence, recommendations, and open questions. Collecting the durable report normally closes and removes the clean scout immediately.

### Build

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
bin/crewdeck diff pricing-fix
bin/crewdeck prepare pricing-fix
bin/crewdeck merge pricing-fix --confirm
bin/crewdeck cleanup pricing-fix --confirm
```

The CLI's `--confirm` is intended for a human at a shell. The Pi extension independently displays an interactive confirmation before build merge and manual cleanup.
