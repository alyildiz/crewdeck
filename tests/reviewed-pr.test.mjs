import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin/crewdeck");
const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();

function git(cwd, ...args) {
  return execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runCli(item, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { env: item.env, encoding: "utf8" });
}

function pendingInbox(item) {
  const source = `import { getPendingResultIds } from ${JSON.stringify(path.join(projectRoot, "src/core.mjs"))}; console.log(JSON.stringify(await getPendingResultIds(process.env.CREWDECK_CONFIG)));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], {
    env: item.env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

async function fixture({ verdict = "approved", failCreateOnce = false, includeReview = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-reviewed-pr-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "demo", "build-one");
  const remote = path.join(root, "remote.git");
  const stateDir = path.join(root, "state");
  const bin = path.join(root, "bin");
  const ghState = path.join(root, "gh-state.json");
  const ghLog = path.join(root, "gh.log");
  const herdrLog = path.join(root, "herdr.log");
  execFileSync(realGit, ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "base");
  execFileSync(realGit, ["init", "-q", "--bare", remote]);
  execFileSync(realGit, ["-C", repo, "push", "-q", remote, "main:main"]);
  git(repo, "remote", "add", "origin", "git@github.com:acme/demo.git");
  await mkdir(path.dirname(worktree), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "crew/build-one", worktree, "main");
  await writeFile(path.join(worktree, "change.txt"), "candidate one\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "candidate one");
  const head = git(worktree, "rev-parse", "HEAD");

  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "config.json");
  await writeFile(kindsPath, [
    "version: 1", "kinds:",
    "  scout:", "    lifecycle: report", "    description: Read only fixture report", "    permissions: { filesystem: read-only, shell: false }", "    tools: [read]", "    skills: []", "    cleanup: after-collection",
    "  review:", "    lifecycle: report", "    contract: review", "    description: Exact SHA fixture review", "    permissions: { filesystem: read-only, shell: false }", "    tools: [read]", "    skills: []", "    cleanup: after-collection",
    "  build:", "    lifecycle: change", "    description: Fixture implementation work", "    permissions: { filesystem: write, shell: true }", "    tools: [bash, edit]", "    skills: []", "    cleanup: after-integration", "",
  ].join("\n"));
  await writeFile(profilesPath, "version: 1\ndefaultProfile: worker\nprofiles:\n  worker:\n    provider: test\n    model: model\n    thinking: low\n    allowedKinds: [scout, review, build]\n");
  await writeFile(configPath, JSON.stringify({
    maxWorkers: 3,
    maxReviewRounds: 3,
    worktreeRoot: path.join(root, "worktrees"),
    kindsFile: kindsPath,
    profilesFile: profilesPath,
    projects: { demo: { path: repo, base: "main", verify: [] } },
  }));

  const buildToken = "a".repeat(48);
  const reviewToken = "b".repeat(48);
  const build = {
    id: "build-one", project: "demo", description: "Reviewed fixture build", kind: "build",
    lifecycle: "change", contract: "standard", workflow: "reviewed-pr", cleanup: "after-integration",
    profile: "worker", status: "running", branch: "crew/build-one", detached: false,
    base: "main", repo, worktree, workspaceId: "build-workspace", paneId: "build-pane",
    agentName: "cd_build_one", sourceWorkspaceId: "source", sourceWorkspaceOwned: false,
    reportToken: buildToken, maxReviewRounds: 3, createdAt: new Date().toISOString(),
  };
  const review = {
    id: "review-one", project: "demo", description: "Review candidate", kind: "review",
    lifecycle: "report", contract: "review", workflow: "direct", cleanup: "after-collection",
    profile: "worker", status: "running", branch: null, detached: true, checkoutHead: head,
    base: "main", repo, worktree: path.join(root, "worktrees", "demo", "review-one"),
    workspaceId: "review-workspace", paneId: "review-pane", agentName: "cd_review_one",
    sourceWorkspaceId: "source", sourceWorkspaceOwned: false, reportToken: reviewToken,
    parentTaskId: "build-one", reviewedHead: head, candidateVersion: 1, createdAt: new Date().toISOString(),
  };
  const tasks = includeReview ? { "build-one": build, "review-one": review } : { "build-one": build };
  await mkdir(path.join(stateDir, "reports"), { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  await writeFile(statePath, JSON.stringify({ version: 1, tasks }));
  await writeFile(path.join(stateDir, "reports", "build-one.candidates.json"), JSON.stringify({
    schemaVersion: 1, taskId: "build-one", kind: "build", workflow: "reviewed-pr", token: buildToken,
    candidates: [{
      version: 1, head, submittedAt: new Date().toISOString(),
      payload: { summary: "candidate one", commit: head, tests: [{ command: "fixture", result: "passed" }], risks: [], openQuestions: [] },
    }],
  }));
  if (includeReview) {
    const findings = verdict === "approved" ? [] : [{
      severity: "major", title: "Handle edge case", detail: "The edge case is not covered",
      location: "change.txt:1", recommendation: "Add handling and a regression test",
    }];
    await writeFile(path.join(stateDir, "reports", "review-one.json"), JSON.stringify({
      schemaVersion: 1, taskId: "review-one", kind: "review", lifecycle: "report", contract: "review",
      parentTaskId: "build-one", reviewedHead: head, token: reviewToken, completedAt: new Date().toISOString(),
      payload: {
        parentTaskId: "build-one", reviewedHead: head, verdict, summary: `review ${verdict}`,
        findings, checks: ["inspected exact diff"], openQuestions: [],
      },
    }));
  }

  await mkdir(bin);
  const fakeGit = path.join(bin, "git");
  await writeFile(fakeGit, `#!/usr/bin/env bash
set -euo pipefail
real=${JSON.stringify(realGit)}
cwd=""
if [[ "\${1:-}" == "-C" ]]; then cwd="$2"; shift 2; fi
case "\${1:-}" in
  ls-remote)
    exec "$real" ls-remote --heads "$CREW_FAKE_REMOTE" "$4" ;;
  push)
    exec "$real" -C "$cwd" push "$2" "$CREW_FAKE_REMOTE" "$4" ;;
  *)
    if [[ -n "$cwd" ]]; then exec "$real" -C "$cwd" "$@"; else exec "$real" "$@"; fi ;;
esac
`);
  await chmod(fakeGit, 0o755);

  const herdr = path.join(bin, "herdr");
  await writeFile(herdr, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CREW_HERDR_LOG"
case "$1 $2" in
  "workspace list") printf '{"result":{"workspaces":[{"workspace_id":"source","label":"project:demo","worktree":{"is_linked_worktree":false,"checkout_path":"%s"}}]}}\n' "$CREW_FIXTURE_REPO" ;;
  "workspace get") printf '{"result":{"workspace":{"workspace_id":"build-workspace"}}}\n' ;;
  "worktree open") printf '{"result":{"workspace":{"workspace_id":"detached-workspace"},"root_pane":{"pane_id":"detached-pane"},"worktree":{"is_detached":true}}}\n' ;;
  "worktree remove") "$CREW_REAL_GIT" -C "$CREW_FIXTURE_REPO" worktree remove "$CREW_DETACHED_REMOVE_PATH"; printf '{"result":{}}\n' ;;
  "pane run"|"agent start") printf '{"result":{}}\n' ;;
  "agent get") if [[ "\${CREW_AGENT_PRESENT:-0}" == 1 ]]; then printf '{"result":{"agent":{"status":"working"}}}\n'; else echo agent_not_found >&2; exit 1; fi ;;
  "agent prompt") printf '{"result":{"accepted":true}}\n' ;;
  *) echo unexpected_herdr_command >&2; exit 1 ;;
esac
`);
  await chmod(herdr, 0o755);

  const gh = path.join(bin, "gh");
  await writeFile(gh, `#!/usr/bin/env node
const fs=require("fs");
const args=process.argv.slice(2); const file=process.env.CREW_GH_STATE; const log=process.env.CREW_GH_LOG;
fs.appendFileSync(log,args.join(" ")+"\\n");
let state={}; try{state=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
if(args[0]==="auth"&&args[1]==="status") process.exit(0);
if(args[0]==="repo"&&args[1]==="view"){console.log(JSON.stringify({nameWithOwner:"acme/demo"}));process.exit(0)}
if(args[0]==="pr"&&args[1]==="list"){console.log(JSON.stringify(state.pr?[state.pr]:[]));process.exit(0)}
if(args[0]==="pr"&&args[1]==="view"){if(!state.pr)process.exit(1);console.log(JSON.stringify(state.pr));process.exit(0)}
if(args[0]==="pr"&&args[1]==="create"){
  const value=(name)=>args[args.indexOf(name)+1];
  state.pr={number:17,url:"https://github.com/acme/demo/pull/17",isDraft:true,headRefName:"crew/build-one",baseRefName:"main",state:"OPEN",title:value("--title"),body:value("--body")}; save();
  if(process.env.CREW_GH_FAIL_ONCE==="1"&&!state.failedOnce){state.failedOnce=true;save();console.error("simulated response loss");process.exit(1)}
  console.log(state.pr.url);process.exit(0)
}
if(args[0]==="pr"&&args[1]==="edit"){const value=(name)=>args[args.indexOf(name)+1];state.pr.title=value("--title");state.pr.body=value("--body");state.edits=(state.edits||0)+1;save();process.exit(0)}
console.error("unexpected gh "+args.join(" "));process.exit(1)
`);
  await chmod(gh, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    CREWDECK_CONFIG: configPath,
    CREWDECK_STATE_DIR: stateDir,
    CREW_FAKE_REMOTE: remote,
    CREW_GH_STATE: ghState,
    CREW_GH_LOG: ghLog,
    CREW_HERDR_LOG: herdrLog,
    CREW_FIXTURE_REPO: repo,
    CREW_REAL_GIT: realGit,
    CREW_DETACHED_REMOVE_PATH: "",
    HERDR_ENV: "1",
    CREW_AGENT_PRESENT: "0",
    CREW_GH_FAIL_ONCE: failCreateOnce ? "1" : "0",
  };
  return { root, repo, worktree, remote, statePath, stateDir, ghState, ghLog, herdrLog, head, env };
}

async function collectCandidateAndReview(item) {
  const result = runCli(item, "collect", "build-one@candidate-1", "review-one", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  const collected = JSON.parse(result.stdout);
  assert.equal(collected.length, 2);
  return collected;
}

function publish(item) {
  return runCli(
    item,
    "publish", "build-one",
    "--remote", "origin",
    "--repo", "acme/demo",
    "--base", "main",
    "--head", "crew/build-one",
    "--title", "Reviewed change",
    "--body", "Draft body",
  );
}

test("reviewers and scouts use Herdr-opened detached worktrees while builds keep crew branches", async (t) => {
  const item = await fixture({ includeReview: false });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  let result = runCli(item, "collect", "build-one@candidate-1", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  result = runCli(
    item,
    "review", "build-one", "review-new", item.head,
    "Review the exact candidate and report structured findings",
    "--profile", "worker",
  );
  assert.equal(result.status, 0, result.stderr);
  const reviewWorktree = path.join(item.root, "worktrees", "demo", "review-new");
  assert.equal(git(reviewWorktree, "branch", "--show-current"), "");
  assert.equal(git(reviewWorktree, "rev-parse", "HEAD"), item.head);

  result = runCli(
    item,
    "spawn", "demo", "scout", "scout-new",
    "Inspect the fixture without changing any files",
    "--profile", "worker",
  );
  assert.equal(result.status, 0, result.stderr);
  const scoutWorktree = path.join(item.root, "worktrees", "demo", "scout-new");
  assert.equal(git(scoutWorktree, "branch", "--show-current"), "");
  assert.equal(git(item.worktree, "branch", "--show-current"), "crew/build-one");
  let state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["review-new"].detached, true);
  assert.equal(state.tasks["review-new"].reviewedHead, item.head);
  assert.equal(state.tasks["scout-new"].detached, true);

  const reviewRecord = state.tasks["review-new"];
  await writeFile(path.join(item.stateDir, "reports", "review-new.json"), JSON.stringify({
    schemaVersion: 1, taskId: "review-new", kind: "review", lifecycle: "report", contract: "review",
    parentTaskId: "build-one", reviewedHead: item.head, token: reviewRecord.reportToken,
    completedAt: new Date().toISOString(),
    payload: {
      parentTaskId: "build-one", reviewedHead: item.head, verdict: "approved", summary: "approved",
      findings: [], checks: ["exact SHA"], openQuestions: [],
    },
  }));
  item.env.CREW_DETACHED_REMOVE_PATH = reviewWorktree;
  result = runCli(item, "collect", "review-new");
  assert.equal(result.status, 0, result.stderr);
  await assert.rejects(() => readFile(path.join(reviewWorktree, "change.txt")), /ENOENT/);
  state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["review-new"].status, "cleaned");

  result = runCli(
    item,
    "review", "build-one", "review-two", item.head,
    "Try to stack a second reviewer on the same exact candidate",
    "--profile", "worker",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review_already_exists/);

  result = runCli(item, "resume", "build-one");
  assert.equal(result.status, 0, result.stderr);
  item.env.CREW_AGENT_PRESENT = "1";
  result = runCli(item, "resume", "build-one");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /writer_already_present/);
  const log = await readFile(item.herdrLog, "utf8");
  assert.match(log, /worktree open/);
  assert.doesNotMatch(log, /worktree create/);
});

test("approved exact SHA publication retries deterministically and is idempotent", async (t) => {
  const item = await fixture({ verdict: "approved", failCreateOnce: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  assert.deepEqual(pendingInbox(item), ["build-one@candidate-1", "review-one"]);
  await collectCandidateAndReview(item);
  assert.deepEqual(pendingInbox(item), []);

  let result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pr_create_failed/);
  assert.equal(git(item.remote, "rev-parse", "refs/heads/crew/build-one"), item.head);
  let durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(durable.tasks["build-one"].publication.remoteSha, item.head);
  assert.equal(durable.tasks["build-one"].publication.number, undefined);

  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  let output = JSON.parse(result.stdout);
  assert.equal(output.publication.number, 17);
  assert.equal(output.publication.url, "https://github.com/acme/demo/pull/17");
  assert.equal(output.publication.remoteHead, "crew/build-one");
  assert.ok(output.publication.pushedAt);
  assert.ok(output.publication.prCreatedAt);
  assert.ok(output.publication.updatedAt);

  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.idempotent, true);
  let log = await readFile(item.ghLog, "utf8");
  assert.equal((log.match(/pr create/g) || []).length, 1);
  assert.equal((log.match(/pr edit/g) || []).length, 0);

  await writeFile(path.join(item.worktree, "change.txt"), "approved candidate two\n");
  git(item.worktree, "add", "change.txt");
  git(item.worktree, "commit", "-qm", "approved candidate two");
  const secondHead = git(item.worktree, "rev-parse", "HEAD");
  const journalPath = path.join(item.stateDir, "reports", "build-one.candidates.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.candidates.push({
    version: 2, head: secondHead, submittedAt: new Date().toISOString(),
    payload: { summary: "approved candidate two", commit: secondHead, tests: [], risks: [], openQuestions: [] },
  });
  await writeFile(journalPath, JSON.stringify(journal));
  durable = JSON.parse(await readFile(item.statePath, "utf8"));
  const token = "c".repeat(48);
  durable.tasks["review-two"] = {
    ...durable.tasks["review-one"],
    id: "review-two", reportToken: token, reviewedHead: secondHead, checkoutHead: secondHead,
    candidateVersion: 2, agentName: "cd_review_two", resultCollectedAt: undefined,
  };
  await writeFile(item.statePath, JSON.stringify(durable));
  await writeFile(path.join(item.stateDir, "reports", "review-two.json"), JSON.stringify({
    schemaVersion: 1, taskId: "review-two", kind: "review", lifecycle: "report", contract: "review",
    parentTaskId: "build-one", reviewedHead: secondHead, token, completedAt: new Date().toISOString(),
    payload: {
      parentTaskId: "build-one", reviewedHead: secondHead, verdict: "approved", summary: "second approval",
      findings: [], checks: ["exact second SHA"], openQuestions: [],
    },
  }));
  result = runCli(item, "collect", "build-one@candidate-2", "review-two", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.publication.number, 17);
  assert.equal(output.publication.remoteSha, secondHead);
  assert.equal(git(item.remote, "rev-parse", "refs/heads/crew/build-one"), secondHead);
  log = await readFile(item.ghLog, "utf8");
  assert.equal((log.match(/pr create/g) || []).length, 1);
  assert.equal((log.match(/pr edit/g) || []).length, 1);
  assert.equal(git(item.repo, "rev-parse", "main"), git(item.remote, "rev-parse", "main"));
});

test("changes-requested findings travel through durable inbox then orchestrator steering", async (t) => {
  const item = await fixture({ verdict: "changes-requested" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  let state = JSON.parse(await readFile(item.statePath, "utf8"));
  const inbox = state.tasks["build-one"].reviewInbox[0];
  assert.equal(inbox.verdict, "changes-requested");
  assert.equal(inbox.findings[0].title, "Handle edge case");
  assert.equal(inbox.forwardedAt, undefined);

  let result = runCli(item, "forward-review", "review-one");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).forwarded, true);
  state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].reviewInbox[0].forwardStatus, "delivered");
  assert.ok(state.tasks["build-one"].reviewInbox[0].forwardedAt);
  assert.match(await readFile(item.herdrLog, "utf8"), /agent prompt cd_review_one|agent prompt cd_build_one/);
  assert.match(await readFile(item.herdrLog, "utf8"), /Handle edge case/);

  result = runCli(item, "forward-review", "review-one");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).idempotent, true);
  assert.equal((await readFile(item.herdrLog, "utf8")).match(/agent prompt/g)?.length, 1);

  await writeFile(path.join(item.worktree, "change.txt"), "candidate two\n");
  git(item.worktree, "add", "change.txt");
  git(item.worktree, "commit", "-qm", "candidate two");
  const secondHead = git(item.worktree, "rev-parse", "HEAD");
  const journalPath = path.join(item.stateDir, "reports", "build-one.candidates.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.candidates.push({
    version: 2, head: secondHead, submittedAt: new Date().toISOString(),
    payload: { summary: "candidate two", commit: secondHead, tests: [], risks: [], openQuestions: [] },
  });
  await writeFile(journalPath, JSON.stringify(journal));
  result = runCli(item, "collect", "build-one@candidate-2", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review_not_approved/);
});

test("the configured final review round escalates instead of steering another candidate", async (t) => {
  const item = await fixture({ verdict: "changes-requested" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const state = JSON.parse(await readFile(item.statePath, "utf8"));
  state.tasks["review-one"].candidateVersion = 3;
  await writeFile(item.statePath, JSON.stringify(state));
  await collectCandidateAndReview(item);
  const result = runCli(item, "forward-review", "review-one");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.forwarded, false);
  assert.equal(output.escalationRequired, true);
  const durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.match(durable.tasks["build-one"].reviewEscalation.reason, /round limit 3/);
  await assert.rejects(() => readFile(item.herdrLog, "utf8"), /ENOENT/);
});

test("publication refuses stale SHA, dirty worktree, missing review, and any base push", async (t) => {
  const stale = await fixture({ verdict: "approved" });
  t.after(() => rm(stale.root, { recursive: true, force: true }));
  await collectCandidateAndReview(stale);
  await writeFile(path.join(stale.worktree, "later.txt"), "later\n");
  git(stale.worktree, "add", "later.txt");
  git(stale.worktree, "commit", "-qm", "later head");
  let result = runCli(stale, "status", "review-one");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].observedStatus, "review-stale");
  result = publish(stale);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale_candidate/);

  const dirty = await fixture({ verdict: "approved" });
  t.after(() => rm(dirty.root, { recursive: true, force: true }));
  await collectCandidateAndReview(dirty);
  await writeFile(path.join(dirty.worktree, "dirty.txt"), "do not push\n");
  result = publish(dirty);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dirty_worktree/);
  assert.equal(spawnSync(realGit, ["--git-dir", dirty.remote, "rev-parse", "refs/heads/crew/build-one"]).status, 128);

  const missing = await fixture({ includeReview: false });
  t.after(() => rm(missing.root, { recursive: true, force: true }));
  result = runCli(missing, "collect", "build-one@candidate-1", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  result = publish(missing);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review_not_approved/);

  result = runCli(
    missing, "publish", "build-one", "--remote", "origin", "--repo", "acme/demo",
    "--base", "main", "--head", "main", "--title", "Unsafe", "--body", "Unsafe",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsafe_publication_ref/);
});

test("Pi extension and CLI expose the reviewed-pr operations without a merge primitive", async () => {
  const source = await readFile(path.join(projectRoot, ".pi/extensions/crewdeck/index.ts"), "utf8");
  for (const name of ["crew_spawn_review", "crew_forward_review", "crew_resume_build", "crew_publish_pr"]) {
    assert.match(source, new RegExp(`name: "${name}"`));
  }
  const publishTool = source.slice(source.indexOf('name: "crew_publish_pr"'), source.indexOf('name: "crew_prepare_integration"'));
  assert.match(publishTool, /publishPullRequest/);
  assert.doesNotMatch(publishTool, /mergeTask|gh.*merge/);
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /review <parent-id>/);
  assert.match(help.stdout, /forward-review/);
  assert.match(help.stdout, /publish <build-id>/);
});
