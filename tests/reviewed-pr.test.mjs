import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin/crewdeck");
const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();
const gh245HeadIdentity = {
  isCrossRepository: false,
  headRepository: { name: "demo" },
  headRepositoryOwner: { login: "acme" },
};

function git(cwd, ...args) {
  return execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runCli(item, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { env: item.env, encoding: "utf8" });
}

function runCliAsync(item, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { env: item.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
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

async function fixture({
  verdict = "approved",
  failCreateOnce = false,
  includeReview = true,
  commentFailure = "",
  staleBeforeComment = false,
  staleAfterComment = false,
  commentPostDelayMs = 0,
  headIdentity = gh245HeadIdentity,
  restFailure = "",
  restMismatch = "",
} = {}) {
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
  const baseSha = git(repo, "rev-parse", "HEAD");
  execFileSync(realGit, ["init", "-q", "--bare", remote]);
  execFileSync(realGit, ["-C", repo, "push", "-q", remote, "main:main"]);
  git(repo, "remote", "add", "origin", "git@github.com:acme/demo.git");
  git(repo, "remote", "add", "base-source", remote);
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
    projects: { demo: { path: repo, base: "main", baseRemote: "base-source", githubChecks: "none", verify: [] } },
  }));

  const buildToken = "a".repeat(48);
  const reviewToken = "b".repeat(48);
  const build = {
    id: "build-one", project: "demo", description: "Reviewed fixture build", kind: "build",
    lifecycle: "change", contract: "standard", workflow: "reviewed-pr", cleanup: "after-integration",
    profile: "worker", status: "running", branch: "crew/build-one", detached: false,
    base: "main", baseSha, baseSource: { mode: "remote", remote: "base-source", ref: "refs/heads/main" }, repo, worktree, workspaceId: "build-workspace", paneId: "build-pane",
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
    ref="\${@: -1}"; exec "$real" ls-remote --heads "$CREW_FAKE_REMOTE" "$ref" ;;
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
  "worktree remove") if [[ "\${CREW_FAIL_RETIRE_REMOVE:-0}" == 1 ]]; then echo interrupted_remove >&2; exit 1; fi; "$CREW_REAL_GIT" -C "$CREW_FIXTURE_REPO" worktree remove "$CREW_DETACHED_REMOVE_PATH"; printf '{"result":{}}\n' ;;
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
const cp=require("child_process");
const args=process.argv.slice(2); const file=process.env.CREW_GH_STATE; const log=process.env.CREW_GH_LOG;
const logged=args.map((arg)=>arg.startsWith("body=")?"body=<redacted>":arg);
fs.appendFileSync(log,logged.join(" ")+"\\n");
let state={}; try{state=JSON.parse(fs.readFileSync(file,"utf8"))}catch{}
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const value=(name)=>args[args.indexOf(name)+1];
const rawField=(name)=>{const prefix=name+"=";const field=args.find((arg)=>arg.startsWith(prefix));return field&&field.slice(prefix.length)};
const headOid=()=>cp.execFileSync(process.env.CREW_REAL_GIT,["--git-dir",process.env.CREW_FAKE_REMOTE,"rev-parse","refs/heads/crew/build-one"],{encoding:"utf8"}).trim();
const headIdentity=()=>JSON.parse(process.env.CREW_GH_HEAD_IDENTITY);
const currentPr=()=>state.pr?{...state.pr,...headIdentity(),headRefOid:state.headRefOidOverride||headOid()}:undefined;
if(args[0]==="auth"&&args[1]==="status") process.exit(0);
if(args[0]==="repo"&&args[1]==="view"){console.log(JSON.stringify({nameWithOwner:"acme/demo"}));process.exit(0)}
if(args[0]==="pr"&&args[1]==="list"){const pr=currentPr();console.log(JSON.stringify(pr?[pr]:[]));process.exit(0)}
if(args[0]==="pr"&&args[1]==="view"){const pr=currentPr();if(!pr)process.exit(1);console.log(JSON.stringify(pr));process.exit(0)}
if(args[0]==="pr"&&args[1]==="create"){
  state.pr={number:17,url:"https://github.com/acme/demo/pull/17",isDraft:true,headRefName:"crew/build-one",baseRefName:"main",state:"OPEN",title:value("--title"),body:value("--body")}; save();
  if(process.env.CREW_GH_FAIL_ONCE==="1"&&!state.failedOnce){state.failedOnce=true;save();console.error("simulated response loss");process.exit(1)}
  console.log(state.pr.url);process.exit(0)
}
if(args[0]==="pr"&&args[1]==="edit"){console.error("Projects Classic projectCards must not be queried");process.exit(1)}
if(args[0]==="api"){
  const endpoint=args.find((arg)=>arg.startsWith("repos/"));
  if(args.includes("PATCH")){
    if(endpoint!=="repos/acme/demo/pulls/17"){console.error("unexpected patch endpoint");process.exit(1)}
    state.restPatches=(state.restPatches||0)+1;
    if(process.env.CREW_GH_REST_FAILURE!=="rejected"){
      state.pr.title=rawField("title");state.pr.body=rawField("body");state.pr.baseRefName=rawField("base");
      if(process.env.CREW_GH_REST_MISMATCH==="title")state.pr.title="mismatched title";
      if(process.env.CREW_GH_REST_MISMATCH==="body")state.pr.body="mismatched body";
      if(process.env.CREW_GH_REST_MISMATCH==="base")state.pr.baseRefName="other";
      if(process.env.CREW_GH_REST_MISMATCH==="head")state.headRefOidOverride="f".repeat(40);
    }
    save();
    if(process.env.CREW_GH_REST_FAILURE){console.error("simulated REST response failure");process.exit(1)}
    console.log(JSON.stringify(currentPr()));process.exit(0)
  }
  const comments=state.comments||[];
  if(args.includes("POST")){
    state.commentPosts=(state.commentPosts||0)+1;
    const bodyArg=args.find((arg)=>arg.startsWith("body="));
    const comment={id:500+state.commentPosts,html_url:
      "https://github.com/acme/demo/pull/17#issuecomment-"+(500+state.commentPosts),body:bodyArg.slice(5)};
    if(Number(process.env.CREW_GH_COMMENT_DELAY_MS||0)>0){Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,Number(process.env.CREW_GH_COMMENT_DELAY_MS))}
    if(process.env.CREW_GH_COMMENT_FAILURE!=="lost-absent") state.comments=[...comments,comment];
    save();
    if(process.env.CREW_GH_STALE_AFTER_COMMENT==="1"){
      fs.writeFileSync(process.env.CREW_FIXTURE_WORKTREE+"/stale-after.txt","stale after comment\\n");
      cp.execFileSync(process.env.CREW_REAL_GIT,["-C",process.env.CREW_FIXTURE_WORKTREE,"add","stale-after.txt"]);
      cp.execFileSync(process.env.CREW_REAL_GIT,["-C",process.env.CREW_FIXTURE_WORKTREE,"commit","-qm","stale after comment"]);
    }
    if(process.env.CREW_GH_COMMENT_FAILURE){console.error("simulated comment response loss");process.exit(1)}
    console.log(JSON.stringify(comment));process.exit(0)
  }
  if(process.env.CREW_GH_STALE_BEFORE_COMMENT==="1"&&!state.staledBeforeComment){
    state.staledBeforeComment=true;save();
    fs.writeFileSync(process.env.CREW_FIXTURE_WORKTREE+"/stale.txt","stale before comment\\n");
    cp.execFileSync(process.env.CREW_REAL_GIT,["-C",process.env.CREW_FIXTURE_WORKTREE,"add","stale.txt"]);
    cp.execFileSync(process.env.CREW_REAL_GIT,["-C",process.env.CREW_FIXTURE_WORKTREE,"commit","-qm","stale before comment"]);
  }
  const pageMatch=endpoint&&endpoint.match(/\\/comments\\?per_page=100&page=([1-9][0-9]*)$/);
  if(!pageMatch){console.error("unexpected api endpoint");process.exit(1)}
  const page=Number(pageMatch[1]);
  console.log(JSON.stringify(comments.slice((page-1)*100,page*100)));process.exit(0)
}
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
    CREW_FIXTURE_WORKTREE: worktree,
    CREW_REAL_GIT: realGit,
    CREW_DETACHED_REMOVE_PATH: "",
    HERDR_ENV: "1",
    CREW_AGENT_PRESENT: "0",
    CREW_GH_FAIL_ONCE: failCreateOnce ? "1" : "0",
    CREW_GH_COMMENT_FAILURE: commentFailure,
    CREW_GH_STALE_BEFORE_COMMENT: staleBeforeComment ? "1" : "0",
    CREW_GH_STALE_AFTER_COMMENT: staleAfterComment ? "1" : "0",
    CREW_GH_COMMENT_DELAY_MS: String(commentPostDelayMs),
    CREW_GH_HEAD_IDENTITY: JSON.stringify(headIdentity),
    CREW_GH_REST_FAILURE: restFailure,
    CREW_GH_REST_MISMATCH: restMismatch,
  };
  return { root, repo, worktree, remote, statePath, stateDir, ghState, ghLog, herdrLog, baseSha, head, env };
}

async function collectCandidateAndReview(item) {
  const result = runCli(item, "collect", "build-one@candidate-1", "review-one", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  const collected = JSON.parse(result.stdout);
  assert.equal(collected.length, 2);
  return collected;
}

async function addApprovedCandidate(item) {
  await writeFile(path.join(item.worktree, "change.txt"), "approved candidate two\n");
  git(item.worktree, "add", "change.txt");
  git(item.worktree, "commit", "-qm", "approved candidate two");
  const head = git(item.worktree, "rev-parse", "HEAD");
  const journalPath = path.join(item.stateDir, "reports", "build-one.candidates.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8"));
  journal.candidates.push({
    version: 2, head, submittedAt: new Date().toISOString(),
    payload: { summary: "approved candidate two", commit: head, tests: [], risks: [], openQuestions: [] },
  });
  await writeFile(journalPath, JSON.stringify(journal));
  const durable = JSON.parse(await readFile(item.statePath, "utf8"));
  const token = "c".repeat(48);
  durable.tasks["review-two"] = {
    ...durable.tasks["review-one"],
    id: "review-two", reportToken: token, reviewedHead: head, checkoutHead: head,
    candidateVersion: 2, agentName: "cd_review_two", resultCollectedAt: undefined,
  };
  await writeFile(item.statePath, JSON.stringify(durable));
  await writeFile(path.join(item.stateDir, "reports", "review-two.json"), JSON.stringify({
    schemaVersion: 1, taskId: "review-two", kind: "review", lifecycle: "report", contract: "review",
    parentTaskId: "build-one", reviewedHead: head, token, completedAt: new Date().toISOString(),
    payload: {
      parentTaskId: "build-one", reviewedHead: head, verdict: "approved", summary: "second approval",
      findings: [], checks: ["exact second SHA"], openQuestions: [],
    },
  }));
  const result = runCli(item, "collect", "build-one@candidate-2", "review-two", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  return head;
}

const publishArgs = [
  "publish", "build-one",
  "--remote", "origin",
  "--repo", "acme/demo",
  "--base", "main",
  "--head", "crew/build-one",
  "--title", "Reviewed change",
  "--body", "Draft body",
];

function publish(item, { title = "Reviewed change", body = "Draft body" } = {}) {
  const args = [...publishArgs];
  args[args.indexOf("--title") + 1] = title;
  args[args.indexOf("--body") + 1] = body;
  return runCli(item, ...args);
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
      findings: [], checks: ["exact SHA"], openQuestions: [], evidenceSha256: reviewRecord.reviewEvidence.contentSha256,
    },
  }));
  const evidencePath = reviewRecord.reviewEvidence.path;
  const originalEvidence = await readFile(evidencePath, "utf8");
  const evidence = JSON.parse(originalEvidence);
  assert.equal(evidence.parentTaskId, "build-one");
  assert.equal(evidence.baseSha, item.baseSha);
  assert.equal(evidence.candidateSha, item.head);
  assert.ok(evidence.commits.some((commit) => commit.sha === item.head));
  await chmod(evidencePath, 0o600);
  await writeFile(evidencePath, originalEvidence.replace("candidate one", "tampered subject"));
  result = runCli(item, "collect", "review-new", "--keep-reports");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /review_evidence_invalid/);
  await writeFile(evidencePath, originalEvidence);
  await chmod(evidencePath, 0o400);

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

test("approved exact SHA publication with the gh 2.45 repository shape retries deterministically", async (t) => {
  const item = await fixture({ verdict: "approved", failCreateOnce: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  assert.deepEqual(JSON.parse(item.env.CREW_GH_HEAD_IDENTITY), gh245HeadIdentity);
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
  assert.equal(output.verdictComment.headSha, item.head);
  assert.equal(output.verdictComment.reviewerTaskId, "review-one");
  assert.equal(output.verdictComment.candidateVersion, 1);
  assert.equal(output.verdictComment.immutable, true);
  let ghDurable = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghDurable.commentPosts, 1);
  assert.equal(ghDurable.comments.length, 1);
  const firstComment = ghDurable.comments[0].body;
  assert.match(firstComment, new RegExp(`<!-- crewdeck-verdict:build-one:${item.head} -->`));
  assert.match(firstComment, new RegExp(item.head));
  assert.match(firstComment, /"verdict": "approved"/);
  assert.match(firstComment, /"reviewerTaskId": "review-one"/);
  assert.match(firstComment, /"candidateVersion": 1/);
  assert.match(firstComment, /### Summary[\s\S]*review approved/);
  assert.match(firstComment, /### Checks[\s\S]*inspected exact diff/);
  assert.match(firstComment, /### Findings/);
  assert.match(firstComment, /### Open questions/);
  assert.match(firstComment, /not an official GitHub approval/);

  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.idempotent, true);
  let log = await readFile(item.ghLog, "utf8");
  assert.equal((log.match(/pr create/g) || []).length, 1);
  assert.equal((log.match(/pr edit/g) || []).length, 0);
  ghDurable = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghDurable.commentPosts, 1);
  assert.equal(ghDurable.comments.length, 1);

  const secondHead = await addApprovedCandidate(item);
  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  output = JSON.parse(result.stdout);
  assert.equal(output.publication.number, 17);
  assert.equal(output.publication.remoteSha, secondHead);
  assert.equal(git(item.remote, "rev-parse", "refs/heads/crew/build-one"), secondHead);
  log = await readFile(item.ghLog, "utf8");
  assert.equal((log.match(/pr create/g) || []).length, 1);
  assert.equal((log.match(/pr edit/g) || []).length, 0);
  assert.match(
    log,
    /api --method PATCH repos\/acme\/demo\/pulls\/17 --raw-field title=Reviewed change --raw-field body=<redacted> --raw-field base=main/,
  );
  assert.doesNotMatch(log, /--method DELETE|pr (?:edit|review|ready|merge)/);
  ghDurable = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghDurable.restPatches, 1);
  assert.equal(ghDurable.commentPosts, 2);
  assert.equal(ghDurable.comments.length, 2);
  assert.equal(ghDurable.comments[0].body, firstComment);
  assert.match(ghDurable.comments[1].body, new RegExp(`<!-- crewdeck-verdict:build-one:${secondHead} -->`));
  durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.deepEqual(
    durable.tasks["build-one"].publication.verdictComments.map((entry) => entry.headSha),
    [item.head, secondHead],
  );
  assert.equal(git(item.repo, "rev-parse", "main"), git(item.remote, "rev-parse", "main"));
});

test("updates an existing draft PR through REST and verifies title, body, base, and head", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  const before = JSON.parse(await readFile(item.ghState, "utf8"));
  const immutableComment = before.comments[0].body;
  await writeFile(item.ghLog, "");

  result = publish(item, { title: "Updated reviewed change", body: "Updated draft body" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.publication.title, "Updated reviewed change");
  assert.equal(output.publication.body, "Updated draft body");
  assert.equal(output.publication.base, "main");
  assert.equal(output.publication.remoteSha, item.head);

  const github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.pr.title, "Updated reviewed change");
  assert.equal(github.pr.body, "Updated draft body");
  assert.equal(github.pr.baseRefName, "main");
  assert.equal(github.restPatches, 1);
  assert.equal(github.commentPosts, 1);
  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0].body, immutableComment);
  const log = await readFile(item.ghLog, "utf8");
  assert.match(
    log,
    /api --method PATCH repos\/acme\/demo\/pulls\/17 --raw-field title=Updated reviewed change --raw-field body=<redacted> --raw-field base=main/,
  );
  assert.match(log, /pr view 17[\s\S]*pr view 17/);
  assert.doesNotMatch(log, /pr edit|--method (?:POST|DELETE)/);
});

test("a rejected REST update fails closed and retries after an already-pushed partial attempt", async (t) => {
  const item = await fixture({ verdict: "approved", failCreateOnce: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pr_create_failed/);
  assert.equal(git(item.remote, "rev-parse", "refs/heads/crew/build-one"), item.head);
  const afterPush = JSON.parse(await readFile(item.statePath, "utf8"));
  const pushedAt = afterPush.tasks["build-one"].publication.pushedAt;

  item.env.CREW_GH_REST_FAILURE = "rejected";
  result = publish(item, { title: "Recovered title", body: "Recovered body" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pr_update_failed/);
  let github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.restPatches, 1);
  assert.equal(github.pr.title, "Reviewed change");
  assert.equal(github.pr.body, "Draft body");
  assert.equal(github.commentPosts || 0, 0);
  let durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.deepEqual(durable.tasks["build-one"].publication.verdictComments || [], []);

  item.env.CREW_GH_REST_FAILURE = "";
  result = publish(item, { title: "Recovered title", body: "Recovered body" });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.publication.pushedAt, pushedAt);
  assert.equal(output.publication.remoteSha, item.head);
  github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.restPatches, 2);
  assert.equal(github.pr.title, "Recovered title");
  assert.equal(github.pr.body, "Recovered body");
  assert.equal(github.pr.baseRefName, "main");
  assert.equal(github.commentPosts, 1);
  assert.equal(github.comments.length, 1);
  durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(durable.tasks["build-one"].publication.verdictComments.length, 1);
  assert.equal(durable.tasks["build-one"].publication.verdictComments[0].status, "published");
  assert.doesNotMatch(await readFile(item.ghLog, "utf8"), /pr edit|--method DELETE/);
});

test("retry recovers after the reviewed head was pushed but its existing-PR update failed", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  let github = JSON.parse(await readFile(item.ghState, "utf8"));
  const firstComment = github.comments[0].body;
  const secondHead = await addApprovedCandidate(item);
  item.env.CREW_GH_REST_FAILURE = "rejected";
  await writeFile(item.ghLog, "");

  result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pr_update_failed/);
  assert.equal(git(item.remote, "rev-parse", "refs/heads/crew/build-one"), secondHead);
  let durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(durable.tasks["build-one"].publication.remoteSha, secondHead);
  assert.equal(durable.tasks["build-one"].publication.headSha, secondHead);
  assert.deepEqual(
    durable.tasks["build-one"].publication.verdictComments.map((entry) => entry.headSha),
    [item.head],
  );
  github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.restPatches, 1);
  assert.equal(github.commentPosts, 1);
  assert.equal(github.comments[0].body, firstComment);

  item.env.CREW_GH_REST_FAILURE = "";
  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).publication.remoteSha, secondHead);
  github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.restPatches, 1);
  assert.equal(github.commentPosts, 2);
  assert.equal(github.comments.length, 2);
  assert.equal(github.comments[0].body, firstComment);
  assert.match(github.comments[1].body, new RegExp(`<!-- crewdeck-verdict:build-one:${secondHead} -->`));
  durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.deepEqual(
    durable.tasks["build-one"].publication.verdictComments.map((entry) => entry.headSha),
    [item.head, secondHead],
  );
  const log = await readFile(item.ghLog, "utf8");
  assert.equal((log.match(/--method PATCH/g) || []).length, 1);
  assert.equal((log.match(/--method POST/g) || []).length, 1);
  assert.doesNotMatch(log, /pr edit|--method DELETE/);
});

test("an applied REST update with a lost response is adopted without another PATCH or verdict comment", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  let github = JSON.parse(await readFile(item.ghState, "utf8"));
  const immutableComment = github.comments[0].body;
  await writeFile(item.ghLog, "");

  item.env.CREW_GH_REST_FAILURE = "lost-applied";
  result = publish(item, { title: "Applied title", body: "Applied body" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pr_update_failed/);
  github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.restPatches, 1);
  assert.equal(github.pr.title, "Applied title");
  assert.equal(github.pr.body, "Applied body");
  assert.equal(github.commentPosts, 1);
  assert.equal(github.comments[0].body, immutableComment);

  item.env.CREW_GH_REST_FAILURE = "";
  result = publish(item, { title: "Applied title", body: "Applied body" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).idempotent, true);
  github = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(github.restPatches, 1);
  assert.equal(github.commentPosts, 1);
  assert.equal(github.comments.length, 1);
  assert.equal(github.comments[0].body, immutableComment);
  const durable = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(durable.tasks["build-one"].publication.verdictComments.length, 1);
  const log = await readFile(item.ghLog, "utf8");
  assert.equal((log.match(/--method PATCH/g) || []).length, 1);
  assert.doesNotMatch(log, /pr edit|--method (?:POST|DELETE)/);
});

test("authoritative REST update verification refuses any mismatched field or head before verdict dispatch", async (t) => {
  for (const mismatch of ["title", "body", "base", "head"]) {
    await t.test(mismatch, async (t) => {
      const item = await fixture({ verdict: "approved", failCreateOnce: true });
      t.after(() => rm(item.root, { recursive: true, force: true }));
      await collectCandidateAndReview(item);

      let result = publish(item);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pr_create_failed/);
      item.env.CREW_GH_REST_MISMATCH = mismatch;
      await writeFile(item.ghLog, "");

      result = publish(item, { title: "Verified title", body: "Verified body" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid_existing_pr/);
      const github = JSON.parse(await readFile(item.ghState, "utf8"));
      assert.equal(github.restPatches, 1);
      assert.equal(github.commentPosts || 0, 0);
      assert.deepEqual(github.comments || [], []);
      const durable = JSON.parse(await readFile(item.statePath, "utf8"));
      assert.deepEqual(durable.tasks["build-one"].publication.verdictComments || [], []);
      const log = await readFile(item.ghLog, "utf8");
      assert.match(log, /--method PATCH[\s\S]*pr view 17/);
      assert.doesNotMatch(log, /pr edit|--method (?:POST|DELETE)/);
    });
  }
});

test("idempotent pr view republication accepts the gh 2.45 shape without mutation", async (t) => {
  const item = await fixture({
    verdict: "approved",
    headIdentity: {
      isCrossRepository: false,
      headRepository: { nameWithOwner: "acme/demo" },
      headRepositoryOwner: { login: "acme" },
    },
  });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  item.env.CREW_GH_HEAD_IDENTITY = JSON.stringify(gh245HeadIdentity);
  await writeFile(item.ghLog, "");

  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).idempotent, true);
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.equal(ghState.edits || 0, 0);
  assert.equal(ghState.comments.length, 1);
  const log = await readFile(item.ghLog, "utf8");
  assert.match(log, /pr view 17/);
  assert.doesNotMatch(log, /pr list|pr edit|--method POST/);
});

test("nameWithOwner head repository identity remains accepted", async (t) => {
  const item = await fixture({
    verdict: "approved",
    failCreateOnce: true,
    headIdentity: {
      isCrossRepository: false,
      headRepository: { nameWithOwner: "acme/demo" },
      headRepositoryOwner: { login: "acme" },
    },
  });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /pr_create_failed/);
  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).idempotent, true);
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.equal(ghState.edits || 0, 0);
});

test("invalid fallback head repository identities are refused before edit or comment POST", async (t) => {
  const cases = [
    ["wrong name", {
      isCrossRepository: false,
      headRepository: { name: "other" },
      headRepositoryOwner: { login: "acme" },
    }],
    ["wrong owner", {
      isCrossRepository: false,
      headRepository: { name: "demo" },
      headRepositoryOwner: { login: "attacker" },
    }],
    ["wrong nameWithOwner", {
      isCrossRepository: false,
      headRepository: { nameWithOwner: "attacker/demo", name: "demo" },
      headRepositoryOwner: { login: "acme" },
    }],
    ["fork", {
      isCrossRepository: true,
      headRepository: { name: "demo" },
      headRepositoryOwner: { login: "acme" },
    }],
    ["missing repository", {
      isCrossRepository: false,
      headRepositoryOwner: { login: "acme" },
    }],
    ["missing repository name", {
      isCrossRepository: false,
      headRepository: {},
      headRepositoryOwner: { login: "acme" },
    }],
    ["missing repository owner", {
      isCrossRepository: false,
      headRepository: { name: "demo" },
    }],
    ["missing cross-repository marker", {
      headRepository: { name: "demo" },
      headRepositoryOwner: { login: "acme" },
    }],
  ];

  for (const [name, headIdentity] of cases) {
    await t.test(name, async (t) => {
      const item = await fixture({ verdict: "approved", failCreateOnce: true, headIdentity });
      t.after(() => rm(item.root, { recursive: true, force: true }));
      await collectCandidateAndReview(item);

      let result = publish(item);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pr_create_failed/);
      const pendingPr = JSON.parse(await readFile(item.ghState, "utf8"));
      pendingPr.pr.title = "Externally changed title";
      await writeFile(item.ghState, JSON.stringify(pendingPr));
      await writeFile(item.ghLog, "");

      result = publish(item);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /invalid_existing_pr/);
      const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
      assert.equal(ghState.edits || 0, 0);
      assert.equal(ghState.restPatches || 0, 0);
      assert.equal(ghState.commentPosts || 0, 0);
      assert.deepEqual(ghState.comments || [], []);
      const log = await readFile(item.ghLog, "utf8");
      const prReads = log.split("\n").filter((line) => /pr (?:list|view)/.test(line));
      assert.ok(prReads.length > 0);
      assert.ok(prReads.every((line) =>
        line.includes("isCrossRepository") &&
        line.includes("headRepository") &&
        line.includes("headRepositoryOwner")
      ));
      assert.doesNotMatch(log, /pr edit|--method (?:PATCH|POST)/);
    });
  }
});

test("exact marker lookup adopts an immutable comment beyond the first bounded page", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  let result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  const exact = ghState.comments[0];
  ghState.comments = Array.from({ length: 100 }, (_, index) => ({
    id: 10_000 + index,
    html_url: `https://github.com/acme/demo/pull/17#issuecomment-${10_000 + index}`,
    body: `unrelated comment ${index}`,
  })).concat(exact);
  await writeFile(item.ghState, JSON.stringify(ghState));

  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).verdictComment.adopted, true);
  const after = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(after.commentPosts, 1);
  assert.equal(after.comments.length, 101);
  assert.match(await readFile(item.ghLog, "utf8"), /comments\?per_page=100&page=2/);
});

test("a provably dead reviewer can be safely retired and replaced without discarding build work", async (t) => {
  const item = await fixture({ includeReview: false });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  let result = runCli(item, "collect", "build-one@candidate-1", "--keep-reports");
  assert.equal(result.status, 0, result.stderr);
  result = runCli(item, "review", "build-one", "dead-review", item.head, "Review exact candidate before the simulated agent loss", "--profile", "worker");
  assert.equal(result.status, 0, result.stderr);
  const deadWorktree = path.join(item.root, "worktrees", "demo", "dead-review");
  item.env.CREW_DETACHED_REMOVE_PATH = deadWorktree;
  item.env.CREW_FAIL_RETIRE_REMOVE = "1";
  result = runCli(item, "retire-agent", "dead-review", "--confirm", "--reason", "Herdr proves the reviewer agent absent");
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(await readFile(item.statePath, "utf8")).tasks["dead-review"].agentRetirement.status, "retiring");
  item.env.CREW_FAIL_RETIRE_REMOVE = "0";
  result = runCli(item, "retire-agent", "dead-review", "--confirm", "--reason", "Herdr proves the reviewer agent absent");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task.status, "retired");
  assert.equal(git(item.worktree, "rev-parse", "HEAD"), item.head);
  result = runCli(item, "review", "build-one", "replacement-review", item.head, "Replacement exact candidate review after proven dead reviewer", "--profile", "worker");
  assert.equal(result.status, 0, result.stderr);
});

test("separately confirmed verdict reconciliation adopts only exact existing evidence without reposting", async (t) => {
  const item = await fixture({ verdict: "approved", commentFailure: "lost-applied" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  let result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_post_ambiguous/);
  item.env.CREW_GH_COMMENT_FAILURE = "";
  await writeFile(item.ghLog, "");
  result = runCli(item, "reconcile-verdict", "build-one", "--confirm", "--reason", "POST response was interrupted");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.outcome.outcome, "adopted-exact");
  assert.equal(output.intent.status, "published");
  assert.doesNotMatch(await readFile(item.ghLog, "utf8"), /--method (?:POST|PATCH|DELETE)/);
});

test("PR observer persists exact open identity without treating it as merged", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  assert.equal(publish(item).status, 0);
  const observed = runCli(item, "observe-prs", "build-one");
  assert.equal(observed.status, 0, observed.stderr);
  const [entry] = JSON.parse(observed.stdout);
  assert.equal(entry.status, "open");
  assert.equal(entry.headSha, item.head);
  const status = JSON.parse(runCli(item, "status", "build-one").stdout);
  assert.equal(status.observerState, "open");
  assert.equal(status.pr.state, "open");
});

test("review-round extension is monotonic, reason-durable, and concurrent-decision safe", async (t) => {
  const item = await fixture({ includeReview: false });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  let result = runCli(item, "extend-review-rounds", "build-one", "--current-max", "3", "--new-max", "5", "--confirm", "--reason", "one additional correction cycle approved");
  assert.equal(result.status, 0, result.stderr);
  const state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].effectiveMaxReviewRounds, 5);
  assert.deepEqual(state.tasks["build-one"].reviewRoundDecisions.map(({ from, to }) => ({ from, to })), [{ from: 3, to: 5 }]);
  result = runCli(item, "extend-review-rounds", "build-one", "--current-max", "3", "--new-max", "6", "--confirm", "--reason", "stale concurrent decision");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /round_extension_conflict/);
});

test("publication refuses a remote base that moved after the pinned review contract", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  execFileSync(realGit, ["-C", item.worktree, "push", "-q", item.remote, `${item.head}:refs/heads/main`]);
  const refsBefore = git(item.repo, "show-ref");
  const fetchHeadPath = path.join(item.repo, ".git", "FETCH_HEAD");
  const fetchHeadBefore = await readFile(fetchHeadPath, "utf8").catch(() => undefined);
  const result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /base_(?:advanced|drift)/);
  assert.equal(git(item.remote, "rev-parse", "main"), item.head);
  assert.equal(git(item.repo, "show-ref"), refsBefore);
  assert.equal(await readFile(fetchHeadPath, "utf8").catch(() => undefined), fetchHeadBefore);
  assert.notEqual(spawnSync(realGit, ["--git-dir", item.remote, "show-ref", "--verify", "refs/heads/crew/build-one"]).status, 0);
});

test("required GitHub checks fail closed when the exact-SHA check API is unavailable", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  const config = JSON.parse(await readFile(item.env.CREWDECK_CONFIG, "utf8"));
  config.projects.demo.githubChecks = "required";
  await writeFile(item.env.CREWDECK_CONFIG, JSON.stringify(config));
  const result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /github_checks_not_passing/);
  const state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.checks.status, "unavailable");
  assert.equal((JSON.parse(await readFile(item.ghState, "utf8")).comments || []).length, 0);
});

test("lost comment response with an applied comment is adopted on retry without another POST", async (t) => {
  const item = await fixture({ verdict: "approved", commentFailure: "lost-applied" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_post_ambiguous/);
  let state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.verdictComments[0].status, "dispatched");
  let ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.equal(ghState.comments.length, 1);

  item.env.CREW_GH_COMMENT_FAILURE = "";
  result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.verdictComment.adopted, true);
  assert.equal(output.verdictComment.id, ghState.comments[0].id);
  state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.verdictComments[0].status, "published");
  ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
});

test("lost comment response without an applied comment becomes durably ambiguous and never reposts", async (t) => {
  const item = await fixture({ verdict: "approved", commentFailure: "lost-absent" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  let result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_post_ambiguous/);
  item.env.CREW_GH_COMMENT_FAILURE = "";
  result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_ambiguous/);
  let state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.verdictComments[0].status, "ambiguous");
  let ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.deepEqual(ghState.comments || [], []);

  result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_ambiguous/);
  state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.verdictComments[0].status, "ambiguous");
  ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);

  result = runCli(item, "reconcile-verdict", "build-one", "--confirm", "--reason", "operator checked after interrupted POST");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_absent/);
  state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].verdictReconciliations.at(-1).outcome, "refused");
  assert.equal(state.tasks["build-one"].verdictReconciliations.at(-1).refusal.code, "verdict_comment_absent");
  assert.equal(JSON.parse(await readFile(item.ghState, "utf8")).commentPosts, 1);
});

test("concurrent publication calls share one durable dispatch intent and issue at most one comment POST", async (t) => {
  const item = await fixture({ verdict: "approved", commentPostDelayMs: 500 });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);

  const results = await Promise.all([
    runCliAsync(item, ...publishArgs),
    runCliAsync(item, ...publishArgs),
  ]);
  assert.ok(results.some((result) => result.status === 0), JSON.stringify(results));
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.equal(ghState.comments.length, 1);
  const state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.verdictComments.length, 1);
  assert.equal(state.tasks["build-one"].publication.verdictComments[0].status, "published");
});

test("immutable marker collision or divergent content is refused without comment mutation", async (t) => {
  const divergent = await fixture({ verdict: "approved" });
  t.after(() => rm(divergent.root, { recursive: true, force: true }));
  await collectCandidateAndReview(divergent);
  let result = publish(divergent);
  assert.equal(result.status, 0, result.stderr);
  let ghState = JSON.parse(await readFile(divergent.ghState, "utf8"));
  ghState.comments[0].body += "\ndivergent external content";
  await writeFile(divergent.ghState, JSON.stringify(ghState));
  result = publish(divergent);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_divergent/);
  ghState = JSON.parse(await readFile(divergent.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.match(ghState.comments[0].body, /divergent external content/);

  const collision = await fixture({ verdict: "approved" });
  t.after(() => rm(collision.root, { recursive: true, force: true }));
  await collectCandidateAndReview(collision);
  result = publish(collision);
  assert.equal(result.status, 0, result.stderr);
  ghState = JSON.parse(await readFile(collision.ghState, "utf8"));
  ghState.comments.push({
    ...ghState.comments[0],
    id: 999,
    html_url: "https://github.com/acme/demo/pull/17#issuecomment-999",
  });
  await writeFile(collision.ghState, JSON.stringify(ghState));
  result = publish(collision);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /verdict_comment_collision/);
  ghState = JSON.parse(await readFile(collision.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.equal(ghState.comments.length, 2);
});

test("a candidate becoming stale before comment dispatch produces zero comments", async (t) => {
  const item = await fixture({ verdict: "approved", staleBeforeComment: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  const result = publish(item);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale_candidate/);
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts || 0, 0);
  assert.deepEqual(ghState.comments || [], []);
  const state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.deepEqual(state.tasks["build-one"].publication.verdictComments || [], []);
  const log = await readFile(item.ghLog, "utf8");
  assert.doesNotMatch(log, /--method POST|--method PATCH|--method DELETE|pr (?:review|ready|merge)/);
});

test("a comment remains immutable historical audit when the candidate becomes stale after POST", async (t) => {
  const item = await fixture({ verdict: "approved", staleAfterComment: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await collectCandidateAndReview(item);
  const result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.currentVerdictState.status, "stale");
  assert.equal(output.currentVerdictState.approvedHead, item.head);
  assert.notEqual(output.currentVerdictState.currentHead, item.head);
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  assert.equal(ghState.commentPosts, 1);
  assert.equal(ghState.comments.length, 1);
  const state = JSON.parse(await readFile(item.statePath, "utf8"));
  assert.equal(state.tasks["build-one"].publication.verdictComments[0].comment.id, ghState.comments[0].id);
  const log = await readFile(item.ghLog, "utf8");
  assert.doesNotMatch(log, /--method PATCH|--method DELETE|pr (?:review|ready|merge)/);
});

test("reviewer-controlled verdict fields are safely rendered and byte-bounded", async (t) => {
  const item = await fixture({ verdict: "approved" });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const reportPath = path.join(item.stateDir, "reports", "review-one.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  report.payload.summary = `<script>@octocat</script>${"<&@".repeat(20_000)}`;
  report.payload.checks = ["@crew please review <b>unsafe</b>"];
  report.payload.findings = [{
    severity: "nit",
    title: "<img src=x>",
    detail: "@octocat",
    location: "<root>",
    recommendation: "keep immutable",
  }];
  report.payload.openQuestions = ["@all?"];
  await writeFile(reportPath, JSON.stringify(report));
  await collectCandidateAndReview(item);

  const result = publish(item);
  assert.equal(result.status, 0, result.stderr);
  const ghState = JSON.parse(await readFile(item.ghState, "utf8"));
  const comment = ghState.comments[0].body;
  assert.ok(Buffer.byteLength(comment, "utf8") <= 48 * 1024);
  assert.doesNotMatch(comment, /<script>|<img|@octocat|@crew|@all/);
  assert.match(comment, /&lt;script&gt;&#64;&#8203;octocat&lt;\/script&gt;/);
  assert.match(comment, /truncated by Crewdeck/);
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
  assert.equal(JSON.parse(result.stdout).observedStatus, "review-stale");
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
