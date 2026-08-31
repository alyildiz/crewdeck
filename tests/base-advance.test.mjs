import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin/crewdeck");
const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
const git = (cwd, ...args) => execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
const run = (fx, ...args) => spawnSync(process.execPath, [cli, ...args], { env: fx.env, encoding: "utf8" });
const state = async (fx) => JSON.parse(await readFile(fx.statePath, "utf8"));

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "crewdeck-base-advance-"));
  const repo = path.join(dir, "repo");
  const worktrees = path.join(dir, "worktrees");
  execFileSync(realGit, ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(repo, "shared.txt"), "old\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "base");
  const base = git(repo, "rev-parse", "HEAD");

  const makeTask = async (id, mutate) => {
    const wt = path.join(worktrees, "demo", id); await mkdir(path.dirname(wt), { recursive: true });
    git(repo, "worktree", "add", "-q", "-b", `crew/${id}`, wt, base);
    await mutate(wt); git(wt, "add", "."); git(wt, "commit", "-qm", id);
    return { wt, head: git(wt, "rev-parse", "HEAD") };
  };
  const compatible = await makeTask("compatible", (wt) => writeFile(path.join(wt, "own.txt"), "change\n"));
  const conflict = await makeTask("conflict", (wt) => writeFile(path.join(wt, "shared.txt"), "worker\n"));
  const published = await makeTask("published", (wt) => writeFile(path.join(wt, "published.txt"), "change\n"));
  const absent = await makeTask("absent", (wt) => writeFile(path.join(wt, "absent.txt"), "change\n"));

  await writeFile(path.join(repo, "shared.txt"), "merged\n");
  git(repo, "add", "."); git(repo, "commit", "-qm", "merged source");
  const mergeCommit = git(repo, "rev-parse", "HEAD");
  const sourceHead = mergeCommit;
  const now = new Date().toISOString();
  const build = (id, item, extra = {}) => ({
    id, project: "demo", kind: "build", lifecycle: "change", workflow: "reviewed-pr", status: "running",
    base: "main", baseSha: base, repo, worktree: item.wt, branch: `crew/${id}`, agentName: `cd_${id}`,
    reviewInbox: [{ reviewTaskId: `${id}-review`, reviewedHead: item.head, candidateVersion: 1, verdict: "approved", validAtCollection: true }],
    createdAt: now, ...extra,
  });
  const sourcePublication = { number: 11, url: "https://github.com/acme/demo/pull/11", repo: "acme/demo", base: "main", remoteHead: "crew/source", headSha: sourceHead };
  const tasks = {
    source: { ...build("source", { wt: repo, head: sourceHead }), branch: "crew/source", publication: sourcePublication },
    compatible: build("compatible", compatible), conflict: build("conflict", conflict),
    published: build("published", published, { publication: { number: 9, headSha: published.head } }),
    absent: build("absent", absent),
    unknown: { ...build("unknown", compatible), baseSha: undefined, branch: "crew/compatible" },
    report: { id: "report", project: "demo", kind: "review", lifecycle: "report", status: "running", base: "main", baseSha: base },
    terminal: { ...build("terminal", compatible), status: "integrated" },
    other: { ...build("other", compatible), project: "other" },
  };
  const stateDir = path.join(dir, "state"); await mkdir(stateDir);
  const statePath = path.join(stateDir, "state.json"); await writeFile(statePath, JSON.stringify({ version: 1, tasks }));
  const kinds = path.join(dir, "kinds.yml");
  await writeFile(kinds, "version: 1\nkinds:\n  build:\n    lifecycle: change\n    description: Fixture build task\n    permissions: {filesystem: write, shell: true}\n    tools: [bash, edit, write]\n    skills: []\n    cleanup: after-integration\n  review:\n    lifecycle: report\n    contract: review\n    description: Fixture review task\n    permissions: {filesystem: read-only, shell: false}\n    tools: [read]\n    skills: []\n    cleanup: after-collection\n");
  const profiles = path.join(dir, "profiles.yml");
  await writeFile(profiles, "version: 1\ndefaultProfile: p\nprofiles:\n  p: {provider: test, model: test, thinking: low, allowedKinds: [build, review]}\n");
  const config = path.join(dir, "config.json");
  await writeFile(config, JSON.stringify({ maxWorkers: 5, maxReviewRounds: 3, worktreeRoot: worktrees, kindsFile: kinds, profilesFile: profiles, projects: { demo: { path: repo, base: "main", githubChecks: "none", verify: [] }, other: { path: repo, base: "main", githubChecks: "none", verify: [] } } }));
  const ghState = path.join(dir, "gh.json");
  await writeFile(ghState, JSON.stringify({ 11: { number: 11, url: sourcePublication.url, state: "MERGED", isDraft: false, headRefName: "crew/source", baseRefName: "main", headRefOid: sourceHead, isCrossRepository: false, headRepository: { nameWithOwner: "acme/demo" }, headRepositoryOwner: { login: "acme" }, mergeCommit: { oid: mergeCommit }, mergedAt: now } }));
  const bin = path.join(dir, "bin"); await mkdir(bin);
  await writeFile(path.join(bin, "gh"), `#!/usr/bin/env node\nconst fs=require('fs');const a=process.argv.slice(2);const s=JSON.parse(fs.readFileSync(process.env.GH_STATE));console.log(JSON.stringify(s[a[2]]));\n`); await chmod(path.join(bin, "gh"), 0o755);
  await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env bash\nset -eu\nif [[ "$1 $2" == "agent get" ]]; then if [[ "$3" == "cd_absent" ]]; then echo agent_not_found >&2; exit 1; fi; echo '{"result":{"agent":{"status":"idle"}}}'; else printf '%s\\n' "$*" >> "$HERDR_LOG"; echo '{"result":{}}'; fi\n`); await chmod(path.join(bin, "herdr"), 0o755);
  const herdrLog = path.join(dir, "herdr.log"); await writeFile(herdrLog, "");
  return { statePath, mergeCommit, base, repo, ghState, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CREWDECK_CONFIG: config, CREWDECK_STATE_DIR: stateDir, GH_STATE: ghState, HERDR_LOG: herdrLog }, herdrLog };
}

test("merged observation durably fans out, classifies, excludes, deduplicates, and forwards safely", async () => {
  const fx = await fixture();
  const first = run(fx, "observe-prs", "source");
  assert.equal(first.status, 0, first.stderr);
  const observed = JSON.parse(first.stdout)[0];
  assert.equal(observed.baseAdvances.length, 5);
  const classifications = Object.fromEntries(observed.baseAdvances.map((x) => [x.taskId, x.classification]));
  assert.deepEqual(classifications, { compatible: "compatible", conflict: "conflicting", published: "compatible", absent: "compatible", unknown: "unknown" });
  let durable = await state(fx);
  assert.equal(durable.tasks.report.baseAdvances, undefined);
  assert.equal(durable.tasks.terminal.baseAdvances, undefined);
  assert.equal(durable.tasks.other.baseAdvances, undefined);
  assert.equal(durable.tasks.source.baseAdvances, undefined);

  const repeat = run(fx, "observe-prs", "source");
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.equal(JSON.parse(repeat.stdout)[0].baseAdvances.length, 0);
  assert.equal((await state(fx)).tasks.conflict.baseAdvances.length, 1);

  const unknown = run(fx, "forward-base-advance", "unknown", "--sequence", "1");
  assert.equal(unknown.status, 1); assert.match(unknown.stderr, /base_compatibility_unknown/);

  const preserve = run(fx, "forward-base-advance", "published", "--sequence", "1");
  assert.equal(preserve.status, 0, preserve.stderr); assert.equal(JSON.parse(preserve.stdout).preserved, true);
  assert.equal((await readFile(fx.herdrLog, "utf8")), "");

  const absent = run(fx, "forward-base-advance", "absent", "--sequence", "1");
  assert.equal(absent.status, 0, absent.stderr); assert.equal(JSON.parse(absent.stdout).writerAbsent, true);
  assert.equal((await state(fx)).tasks.absent.baseAdvances[0].status, "awaiting-writer");

  const forwarded = run(fx, "forward-base-advance", "conflict", "--sequence", "1");
  assert.equal(forwarded.status, 0, forwarded.stderr);
  durable = await state(fx);
  assert.equal(durable.tasks.conflict.baseSha, fx.mergeCommit);
  assert.equal(durable.tasks.conflict.requiredBaseSha, fx.mergeCommit);
  assert.equal(durable.tasks.conflict.reviewInbox[0].validAtCollection, false);
  assert.equal(durable.tasks.conflict.baseAdvances[0].status, "forwarded");
  const once = await readFile(fx.herdrLog, "utf8");
  const again = run(fx, "forward-base-advance", "conflict", "--sequence", "1");
  assert.equal(again.status, 0, again.stderr); assert.equal(JSON.parse(again.stdout).idempotent, true);
  assert.equal(await readFile(fx.herdrLog, "utf8"), once);

  const status = run(fx, "status", "--detail", "conflict");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).baseAdvanceState.status, "forwarded");

  // A distinct later merged/base identity appends exactly one monotonic event.
  await writeFile(path.join(fx.repo, "later.txt"), "later\n");
  git(fx.repo, "add", "."); git(fx.repo, "commit", "-qm", "later merged source");
  const later = git(fx.repo, "rev-parse", "HEAD");
  durable = await state(fx);
  durable.tasks["source-two"] = {
    ...durable.tasks.source, id: "source-two", branch: "crew/source-two", agentName: "cd_source_two",
    publication: { ...durable.tasks.source.publication, number: 12, url: "https://github.com/acme/demo/pull/12", remoteHead: "crew/source-two", headSha: later },
    prObservation: undefined, baseAdvances: undefined,
  };
  await writeFile(fx.statePath, JSON.stringify(durable));
  const gh = JSON.parse(await readFile(fx.ghState, "utf8"));
  gh[12] = { ...gh[11], number: 12, url: "https://github.com/acme/demo/pull/12", headRefName: "crew/source-two", headRefOid: later, mergeCommit: { oid: later } };
  await writeFile(fx.ghState, JSON.stringify(gh));
  const second = run(fx, "observe-prs", "source-two");
  assert.equal(second.status, 0, second.stderr);
  assert.ok(JSON.parse(second.stdout)[0].baseAdvances.some((item) => item.taskId === "compatible" && item.sequence === 2));
  assert.equal((await state(fx)).tasks.compatible.baseAdvances.length, 2);
  const secondRepeat = run(fx, "observe-prs", "source-two");
  assert.equal(secondRepeat.status, 0, secondRepeat.stderr);
  assert.equal((await state(fx)).tasks.compatible.baseAdvances.length, 2);
});
