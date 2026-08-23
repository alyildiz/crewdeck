import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin/crewdeck");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture({ collected = false, removeResources = true, workspacePresent = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-orphan-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "demo", "old-report");
  const stateDir = path.join(root, "state");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "Fixture");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "initial");
  const baseHead = git(repo, "rev-parse", "main");
  await mkdir(path.dirname(worktree), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "crew/old-report", worktree, "main");

  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "config.json");
  await writeFile(kindsPath, "version: 1\nkinds:\n  scout:\n    lifecycle: report\n    description: Read-only fixture report\n    permissions: { filesystem: read-only, shell: false }\n    tools: [read]\n    skills: []\n    cleanup: after-collection\n  build:\n    lifecycle: change\n    description: Fixture change\n    permissions: { filesystem: write, shell: true }\n    tools: [bash, edit]\n    skills: []\n    cleanup: after-integration\n");
  await writeFile(profilesPath, "version: 1\ndefaultProfile: worker\nprofiles:\n  worker:\n    provider: test\n    model: model\n    thinking: low\n    allowedKinds: [scout, build]\n");
  await writeFile(configPath, JSON.stringify({
    maxWorkers: 2,
    worktreeRoot: path.join(root, "worktrees"),
    kindsFile: kindsPath,
    profilesFile: profilesPath,
    projects: { demo: { path: repo, base: "main", verify: [] } },
  }));

  const token = "b".repeat(48);
  const record = {
    id: "old-report", project: "demo", description: "Old report fixture", kind: "scout",
    lifecycle: "report", cleanup: "after-collection", profile: "worker", status: "running",
    branch: "crew/old-report", base: "main", repo, worktree, workspaceId: "missing-workspace",
    agentName: "cd_old-report", sourceWorkspaceId: "fixture-source", sourceWorkspaceOwned: false,
    reportToken: token, createdAt: new Date().toISOString(),
  };
  if (collected) record.resultCollectedAt = new Date().toISOString();
  await mkdir(path.join(stateDir, "reports"), { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1, tasks: { "old-report": record } }));
  const reportPath = path.join(stateDir, "reports", "old-report.json");
  if (collected) {
    await writeFile(reportPath, JSON.stringify({
      schemaVersion: 1, taskId: "old-report", kind: "scout", lifecycle: "report", token,
      payload: { summary: "preserved report", findings: [], recommendations: [], openQuestions: [] },
    }));
  }
  if (removeResources) await rm(worktree, { recursive: true, force: true });

  const fakeBin = path.join(root, "bin");
  const herdrLog = path.join(root, "herdr.log");
  await mkdir(fakeBin);
  const herdr = path.join(fakeBin, "herdr");
  await writeFile(herdr, `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CREW_HERDR_LOG"
case "$1 $2" in
  "agent get")
    if [[ "$CREW_WORKSPACE_PRESENT" == 1 ]]; then printf '{"result":{"agent":{"status":"working"}}}\\n'; else echo agent_not_found >&2; exit 1; fi ;;
  "workspace get")
    if [[ "$CREW_WORKSPACE_PRESENT" == 1 ]]; then printf '{"result":{"workspace":{"id":"missing-workspace"}}}\\n'; else echo workspace_not_found >&2; exit 1; fi ;;
  *) echo unexpected_herdr_mutation >&2; exit 1 ;;
esac
`);
  await chmod(herdr, 0o755);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CREWDECK_CONFIG: configPath,
    CREWDECK_STATE_DIR: stateDir,
    CREW_HERDR_LOG: herdrLog,
    CREW_WORKSPACE_PRESENT: workspacePresent ? "1" : "0",
  };
  return { root, repo, worktree, statePath, reportPath, herdrLog, baseHead, env };
}

function runCli(item, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { env: item.env, encoding: "utf8" });
}

async function persisted(item) {
  return JSON.parse(await readFile(item.statePath, "utf8"));
}

test("reconciles a running orphan report and removes stale Git metadata without touching base", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));

  const result = runCli(item, "reconcile-orphan", "old-report", "--confirm", "--reason", "resources removed manually");
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout);
  assert.equal(task.status, "orphan-reconciled");
  assert.equal(task.orphanReconciledFromStatus, "running");
  assert.equal(task.orphanReconciliationReason, "resources removed manually");
  assert.ok(task.orphanReconciledAt);
  assert.equal(git(item.repo, "rev-parse", "main"), item.baseHead);
  assert.notEqual(spawnSync("git", ["-C", item.repo, "show-ref", "--verify", "refs/heads/crew/old-report"]).status, 0);
  assert.doesNotMatch(git(item.repo, "worktree", "list", "--porcelain"), /old-report/);

  const status = runCli(item, "status", "old-report");
  assert.equal(status.status, 0, status.stderr);
  const [history] = JSON.parse(status.stdout);
  assert.equal(history.observedStatus, "orphan-reconciled");
  assert.equal(history.agent.state, "closed");
  assert.equal(history.git.state, "worktree-removed");

  const retry = runCli(item, "reconcile-orphan", "old-report", "--confirm", "--reason", "retry");
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /already_reconciled/);
});

test("finalizes a collected orphan report while preserving its durable report and history", async (t) => {
  const item = await fixture({ collected: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const before = await readFile(item.reportPath, "utf8");

  const result = runCli(item, "reconcile-orphan", "old-report", "--confirm", "--reason", "cleanup failed: workspace_not_found");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(item.reportPath, "utf8"), before);
  const record = (await persisted(item)).tasks["old-report"];
  assert.ok(record.resultCollectedAt);
  assert.equal(record.status, "orphan-reconciled");
  const status = JSON.parse(runCli(item, "status", "old-report").stdout)[0];
  assert.equal(status.result.available, true);
  assert.equal(status.result.report.payload.summary, "preserved report");
});

test("requires independent confirmation and a durable reason", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));

  let result = runCli(item, "reconcile-orphan", "old-report", "--reason", "manual removal");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reconcile-orphan requires <id> --confirm --reason <text>/);
  result = runCli(item, "reconcile-orphan", "old-report", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reconcile-orphan requires <id> --confirm --reason <text>/);
  assert.equal((await persisted(item)).tasks["old-report"].status, "running");
  assert.equal(git(item.repo, "rev-parse", "crew/old-report"), item.baseHead);
});

test("refuses reports whose Herdr or Git resources are still present, including dirty worktrees", async (t) => {
  const workspace = await fixture({ workspacePresent: true });
  t.after(() => rm(workspace.root, { recursive: true, force: true }));
  let result = runCli(workspace, "reconcile-orphan", "old-report", "--confirm", "--reason", "incorrect claim");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /orphan_resources_present/);

  const clean = await fixture({ removeResources: false });
  t.after(() => rm(clean.root, { recursive: true, force: true }));
  result = runCli(clean, "reconcile-orphan", "old-report", "--confirm", "--reason", "incorrect claim");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /orphan_resources_present/);
  await writeFile(path.join(clean.worktree, "dirty.txt"), "preserve\n");
  result = runCli(clean, "reconcile-orphan", "old-report", "--confirm", "--reason", "incorrect claim");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dirty_worktree/);
  assert.equal(await readFile(path.join(clean.worktree, "dirty.txt"), "utf8"), "preserve\n");
});

test("refuses unintegrated branch commits and change tasks", async (t) => {
  const committed = await fixture();
  t.after(() => rm(committed.root, { recursive: true, force: true }));
  const temp = path.join(committed.root, "temp-worktree");
  git(committed.repo, "worktree", "remove", "--force", committed.worktree);
  git(committed.repo, "worktree", "add", "-q", temp, "crew/old-report");
  await writeFile(path.join(temp, "unexpected.txt"), "commit\n");
  git(temp, "add", "unexpected.txt");
  git(temp, "commit", "-qm", "unexpected report commit");
  git(committed.repo, "worktree", "remove", "--force", temp);
  let result = runCli(committed, "reconcile-orphan", "old-report", "--confirm", "--reason", "manual removal");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unintegrated_branch/);

  const change = await fixture();
  t.after(() => rm(change.root, { recursive: true, force: true }));
  const state = await persisted(change);
  state.tasks["old-report"].kind = "build";
  state.tasks["old-report"].lifecycle = "change";
  await writeFile(change.statePath, JSON.stringify(state));
  result = runCli(change, "reconcile-orphan", "old-report", "--confirm", "--reason", "use abandon instead");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /report_task_required/);
});

test("Pi extension exposes a separately confirmed orphan reconciliation tool with a required reason", async () => {
  const source = await readFile(path.join(projectRoot, ".pi/extensions/crewdeck/index.ts"), "utf8");
  const start = source.indexOf('name: "crew_reconcile_orphan_report"');
  const tool = source.slice(start, source.indexOf('name: "crew_cleanup"', start));
  assert.ok(start >= 0);
  assert.match(tool, /requires interactive confirmation/);
  assert.match(tool, /reason: Type\.String/);
  assert.match(tool, /ctx\.ui\.confirm/);
  assert.match(tool, /await reconcileOrphanReport/);
});
