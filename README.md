# Crewdeck

Crewdeck is a lightweight Pi and Herdr orchestrator for running visible coding agents in isolated Git worktrees.

You talk to one Pi session in this repository. Its project-local skill decides how to divide work; its extension performs deterministic Herdr and Git operations. Workers start inside target-project worktrees, so Pi loads each project's own `AGENTS.md` instead of Crewdeck's instructions.

## v0.1 scope

- Pi orchestrator and Pi workers
- Herdr 0.8+ only
- up to five workers per batch
- one visible Herdr worktree workspace per task
- configurable worker model and thinking level
- read-only scout and implementation profiles
- durable local task state
- sequential rebase, verification, local fast-forward merge, and safe cleanup
- no push, PR creation, remote workers, forced cleanup, or background LLM polling

## Layout

```text
~/projects/crewdeck/                         orchestrator cwd
~/.local/share/crewdeck/worktrees/<project>/<task>/
                                            worker cwd
~/.local/state/crewdeck/state.json          durable runtime state
```

Worktrees deliberately live outside this repository. Pi loads context files from its current directory and parents; nesting workers below Crewdeck would leak the orchestrator's `AGENTS.md` into worker contexts.

## Setup

Requirements:

- Pi
- Herdr 0.8 or newer
- Git

Edit [`crewdeck.json`](crewdeck.json):

```json
{
  "maxWorkers": 5,
  "worktreeRoot": "~/.local/share/crewdeck/worktrees",
  "defaultProfile": "worker",
  "profiles": {
    "worker": {
      "kind": "pi",
      "model": "openai-codex/gpt-5.6-sol",
      "thinking": "medium"
    }
  },
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

Register another project from the control directory:

```bash
bin/crewdeck project add my-project /absolute/path/to/project --base main --trust
```

`--trust` makes worker Pi processes load project-local settings, extensions, and skills without an interactive trust prompt. `AGENTS.md` itself loads regardless, but only register and trust repositories you control.

Start the orchestrator inside a Herdr pane:

```bash
cd /home/baris/projects/crewdeck
pi --model <orchestrator-model> --thinking xhigh
```

Trust this repository when Pi asks, then restart or `/reload` so its extension and skill load. The startup header should list the Crewdeck resources.

Example request:

```text
On my-project, run these in parallel: fix the pricing column, add regression tests for expired prices, and scout the import path for related risks.
```

Use `/crew` to display current workers without an LLM turn and `/crew clear` to hide the widget.

## Manual CLI

The extension owns the normal model-facing interface. The CLI is useful for diagnostics:

```bash
bin/crewdeck project list
bin/crewdeck spawn my-project pricing "Fix the price shown in column Z"
bin/crewdeck status
bin/crewdeck prompt pricing "Also cover the empty-value case"
bin/crewdeck prepare pricing
bin/crewdeck merge pricing --confirm
bin/crewdeck cleanup pricing --confirm
```

The CLI's `--confirm` is intended for a human at a shell. The Pi extension instead displays an interactive confirmation dialog before merge and cleanup.

## Integration model

Workers develop concurrently. Branches integrate one at a time:

1. settle and commit;
2. rebase onto the current local base;
3. return conflicts to the original worker;
4. run project verification;
5. ask for merge approval;
6. fast-forward locally;
7. prepare the next branch against the new base.

This v0.1 never pushes. GitHub PR support can be layered on after the local lifecycle is reliable.
