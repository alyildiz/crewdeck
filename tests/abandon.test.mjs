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

async function operationFixture(status = "conflict") {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-abandon-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "demo", "obsolete");
  const stateDir = path.join(root, "state");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "Fixture");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "initial");
  await mkdir(path.dirname(worktree), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "crew/obsolete", worktree, "main");
  await writeFile(path.join(worktree, "change.txt"), "obsolete change\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "obsolete change");
  const head = git(worktree, "rev-parse", "HEAD");
  const baseHead = git(repo, "rev-parse", "main");

  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "config.json");
  await writeFile(kindsPath, [
    "version: 1", "kinds:",
    "  scout:", "    lifecycle: report", "    description: Read only fixture report", "    permissions: { filesystem: read-only, shell: false }", "    tools: [read]", "    skills: []", "    cleanup: after-collection",
    "  build:", "    lifecycle: change", "    description: Fixture implementation work", "    permissions: { filesystem: write, shell: true }", "    tools: [bash, edit]", "    skills: []", "    cleanup: after-integration", "",
  ].join("\n"));
  await writeFile(profilesPath, "version: 1\ndefaultProfile: worker\nprofiles:\n  worker:\n    provider: test\n    model: model\n    thinking: low\n    allowedKinds: [scout, build]\n");
  await writeFile(configPath, JSON.stringify({
    maxWorkers: 2,
    worktreeRoot: path.join(root, "worktrees"),
    kindsFile: kindsPath,
    profilesFile: profilesPath,
    projects: { demo: { path: repo, base: "main", verify: [] } },
  }));

  const token = "a".repeat(48);
  const record = {
    id: "obsolete", project: "demo", description: "Obsolete fixture change", kind: "build",
    lifecycle: "change", cleanup: "after-integration", profile: "worker", status,
    branch: "crew/obsolete", base: "main", repo, worktree, workspaceId: "fixture-workspace",
    agentName: "cd_obsolete", sourceWorkspaceId: "fixture-source", sourceWorkspaceOwned: false,
    reportToken: token, createdAt: new Date().toISOString(),
  };
  await mkdir(path.join(stateDir, "reports"), { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1, tasks: { obsolete: record } }));
  const reportPath = path.join(stateDir, "reports", "obsolete.json");
  await writeFile(reportPath, JSON.stringify({
    schemaVersion: 1, taskId: "obsolete", kind: "build", lifecycle: "change", token,
    payload: { summary: "obsolete", commit: head, tests: [], risks: [], openQuestions: [] },
  }));

  const fakeBin = path.join(root, "bin");
  await mkdir(fakeBin);
  const herdr = path.join(fakeBin, "herdr");
  await writeFile(herdr, `#!/usr/bin/env bash
set -e
case "$1 $2" in
  "agent get"|"agent send-keys") exit 1 ;;
  "worktree remove") git -C "$CREW_FIXTURE_REPO" worktree remove "$CREW_FIXTURE_WORKTREE"; printf '{"result":{}}\\n' ;;
  "workspace close") printf '{"result":{}}\\n' ;;
  *) printf '{"result":{}}\\n' ;;
esac
`);
  await chmod(herdr, 0o755);
  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CREWDECK_CONFIG: configPath,
    CREWDECK_STATE_DIR: stateDir,
    CREW_FIXTURE_REPO: repo,
    CREW_FIXTURE_WORKTREE: worktree,
  };
  return { root, repo, worktree, statePath, reportPath, head, baseHead, env, record };
}

function runCli(fixture, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { env: fixture.env, encoding: "utf8" });
}

async function persisted(fixture) {
  return JSON.parse(await readFile(fixture.statePath, "utf8"));
}

test("explicitly abandons and cleans a clean non-integrated conflict without touching base or report", async (t) => {
  const fixture = await operationFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runCli(fixture, "abandon", "obsolete", "--confirm", "--reason", "superseded");
  assert.equal(result.status, 0, result.stderr);
  const task = JSON.parse(result.stdout);
  assert.equal(task.status, "abandoned");
  assert.equal(task.abandonedFromStatus, "conflict");
  assert.equal(task.abandonmentReason, "superseded");
  assert.ok(task.abandonedAt);
  assert.ok(task.cleanedAt);
  assert.equal(git(fixture.repo, "rev-parse", "main"), fixture.baseHead);
  assert.notEqual(
    spawnSync("git", ["-C", fixture.repo, "show-ref", "--verify", "refs/heads/crew/obsolete"]).status,
    0,
  );
  await assert.rejects(() => readFile(path.join(fixture.worktree, "change.txt")), /ENOENT/);
  assert.equal(JSON.parse(await readFile(fixture.reportPath, "utf8")).payload.commit, fixture.head);

  const status = runCli(fixture, "status", "obsolete");
  assert.equal(status.status, 0, status.stderr);
  const [history] = JSON.parse(status.stdout);
  assert.equal(history.observedStatus, "abandoned");
  assert.equal(history.agent.state, "closed");
  assert.equal(history.result.available, true);

  const retry = runCli(fixture, "abandon", "obsolete", "--confirm");
  assert.equal(retry.status, 1);
  assert.match(retry.stderr, /already_abandoned/);
});

test("refuses abandonment of a dirty worktree without deleting data", async (t) => {
  const fixture = await operationFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  await writeFile(path.join(fixture.worktree, "uncommitted.txt"), "keep me\n");

  const result = runCli(fixture, "abandon", "obsolete", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dirty_worktree/);
  assert.equal((await persisted(fixture)).tasks.obsolete.status, "conflict");
  assert.equal(await readFile(path.join(fixture.worktree, "uncommitted.txt"), "utf8"), "keep me\n");
  assert.equal(git(fixture.repo, "rev-parse", "crew/obsolete"), fixture.head);
});

test("CLI abandonment requires its own explicit confirmation", async (t) => {
  const fixture = await operationFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  const result = runCli(fixture, "abandon", "obsolete");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /abandon requires <id> --confirm/);
  assert.equal((await persisted(fixture)).tasks.obsolete.status, "conflict");
  assert.equal(git(fixture.repo, "rev-parse", "crew/obsolete"), fixture.head);
});

test("refuses report and terminal task states", async (t) => {
  const fixture = await operationFixture();
  t.after(() => rm(fixture.root, { recursive: true, force: true }));
  const state = await persisted(fixture);

  state.tasks.obsolete.kind = "scout";
  state.tasks.obsolete.lifecycle = "report";
  await writeFile(fixture.statePath, JSON.stringify(state));
  let result = runCli(fixture, "abandon", "obsolete", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /read_only_task/);

  state.tasks.obsolete.kind = "build";
  state.tasks.obsolete.lifecycle = "change";
  for (const [status, code] of [["integrated", "already_integrated"], ["cleaned", "already_cleaned"], ["abandoned", "already_abandoned"]]) {
    state.tasks.obsolete.status = status;
    await writeFile(fixture.statePath, JSON.stringify(state));
    result = runCli(fixture, "abandon", "obsolete", "--confirm");
    assert.equal(result.status, 1);
    assert.match(result.stderr, new RegExp(code));
  }
});

test("existing prepare, merge, and cleanup lifecycle remains intact", async (t) => {
  const fixture = await operationFixture("running");
  t.after(() => rm(fixture.root, { recursive: true, force: true }));

  let result = runCli(fixture, "prepare", "obsolete");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task.status, "ready");
  result = runCli(fixture, "merge", "obsolete", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "integrated");
  assert.equal(git(fixture.repo, "rev-parse", "main"), fixture.head);
  result = runCli(fixture, "cleanup", "obsolete", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, "cleaned");
});

test("Pi extension exposes a separately confirmed abandonment tool", async () => {
  const source = await readFile(path.join(projectRoot, ".pi/extensions/crewdeck/index.ts"), "utf8");
  const tool = source.slice(source.indexOf('name: "crew_abandon"'), source.indexOf('name: "crew_cleanup"'));
  assert.match(tool, /crew_abandon requires interactive confirmation/);
  assert.match(tool, /ctx\.ui\.confirm/);
  assert.match(tool, /if \(!confirmed\).*user declined/);
  assert.match(tool, /await abandonTask/);
});
