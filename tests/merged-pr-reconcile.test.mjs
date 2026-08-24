import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createCrewCommand } from "../src/crew-view.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(projectRoot, "bin/crewdeck");
const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();

function git(cwd, ...args) {
  return execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function runCli(item, ...args) {
  return spawnSync(process.execPath, [cli, ...args], { env: item.env, encoding: "utf8" });
}

async function persisted(item) {
  return JSON.parse(await readFile(item.statePath, "utf8"));
}

async function mutateJson(file, mutate) {
  const value = JSON.parse(await readFile(file, "utf8"));
  mutate(value);
  await writeFile(file, JSON.stringify(value));
}

async function assertUntouched(item) {
  assert.equal((await persisted(item)).tasks["build-one"].status, "running");
  assert.equal(git(item.repo, "rev-parse", "crew/build-one"), item.head);
  assert.equal(await readFile(path.join(item.worktree, "change.txt"), "utf8"), "approved candidate\n");
  assert.equal(git(item.repo, "rev-parse", "main"), item.localBase);
}

async function fixture({ agent = "idle", contained = true, legacyPublication = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-merged-pr-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "worktrees", "demo", "build-one");
  const remote = path.join(root, "remote.git");
  const stateDir = path.join(root, "state");
  const fakeBin = path.join(root, "bin");
  const ghState = path.join(root, "gh-state.json");
  const ghLog = path.join(root, "gh.log");
  const herdrLog = path.join(root, "herdr.log");
  const workspaceRemoved = path.join(root, "workspace-removed");
  const agentClosed = path.join(root, "agent-closed");

  execFileSync(realGit, ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "base");
  const localBase = git(repo, "rev-parse", "main");
  execFileSync(realGit, ["init", "-q", "--bare", remote]);
  execFileSync(realGit, ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"]);
  execFileSync(realGit, ["-C", repo, "push", "-q", remote, "main:main"]);
  git(repo, "remote", "add", "origin", "git@github.com:acme/demo.git");
  await mkdir(path.dirname(worktree), { recursive: true });
  git(repo, "worktree", "add", "-q", "-b", "crew/build-one", worktree, "main");
  let priorHead;
  if (legacyPublication) {
    await writeFile(path.join(worktree, "change.txt"), "candidate v1\n");
    git(worktree, "add", "change.txt");
    git(worktree, "commit", "-qm", "candidate v1");
    priorHead = git(worktree, "rev-parse", "HEAD");
  }
  await writeFile(path.join(worktree, "change.txt"), "approved candidate\n");
  git(worktree, "add", "change.txt");
  git(worktree, "commit", "-qm", "approved candidate");
  const head = git(worktree, "rev-parse", "HEAD");
  const candidateVersion = legacyPublication ? 2 : 1;

  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "config.json");
  await writeFile(kindsPath, [
    "version: 1", "kinds:",
    "  review:", "    lifecycle: report", "    contract: review", "    description: Exact SHA fixture review", "    permissions: { filesystem: read-only, shell: false }", "    tools: [read]", "    skills: []", "    cleanup: after-collection",
    "  build:", "    lifecycle: change", "    description: Fixture implementation work", "    permissions: { filesystem: write, shell: true }", "    tools: [bash, edit]", "    skills: []", "    cleanup: after-integration", "",
  ].join("\n"));
  await writeFile(profilesPath, "version: 1\ndefaultProfile: worker\nprofiles:\n  worker:\n    provider: test\n    model: model\n    thinking: low\n    allowedKinds: [review, build]\n");
  await writeFile(configPath, JSON.stringify({
    maxWorkers: 2,
    maxReviewRounds: 3,
    worktreeRoot: path.join(root, "worktrees"),
    kindsFile: kindsPath,
    profilesFile: profilesPath,
    projects: { demo: { path: repo, base: "main", verify: [] } },
  }));

  const now = new Date().toISOString();
  const buildToken = "a".repeat(48);
  const reviewToken = "b".repeat(48);
  const build = {
    id: "build-one", project: "demo", description: "Reviewed fixture build", kind: "build",
    lifecycle: "change", contract: "standard", workflow: "reviewed-pr", cleanup: "after-integration",
    profile: "worker", status: "running", branch: "crew/build-one", detached: false,
    base: "main", repo, worktree, workspaceId: "build-workspace", paneId: "build-pane",
    agentName: "cd_build_one", sourceWorkspaceId: "source", sourceWorkspaceOwned: false,
    reportToken: buildToken, maxReviewRounds: 3, candidateCollectedVersion: candidateVersion,
    candidateCollectedAt: now, createdAt: now,
    reviewInbox: [
      ...(legacyPublication ? [{
        reviewTaskId: "review-prior", candidateVersion: 1, reviewedHead: priorHead,
        verdict: "changes-requested", summary: "v1 requires changes", findings: [{
          severity: "major", title: "v1 finding", detail: "fix provenance",
          location: "src/core.mjs", recommendation: "submit v2",
        }],
        checks: ["fixture v1 review"], openQuestions: [], completedAt: now,
        collectedAt: now, validAtCollection: true,
      }] : []),
      {
        reviewTaskId: "review-one", candidateVersion, reviewedHead: head,
        verdict: "approved", summary: "approved exact SHA", findings: [],
        checks: ["fixture review"], openQuestions: [], completedAt: now,
        collectedAt: now, validAtCollection: true,
      },
    ],
    ...(legacyPublication ? { reviewReservation: {
      reviewTaskId: "review-one", reviewedHead: head, reservedAt: now,
    } } : {}),
  };
  const review = {
    id: "review-one", project: "demo", description: "Review candidate", kind: "review",
    lifecycle: "report", contract: "review", workflow: "direct", cleanup: "after-collection",
    profile: "worker", status: "cleaned", branch: null, detached: true, checkoutHead: head,
    base: "main", repo, worktree: path.join(root, "worktrees", "demo", "review-one"),
    workspaceId: "review-workspace", agentName: "cd_review_one", sourceWorkspaceId: "source",
    sourceWorkspaceOwned: false, reportToken: reviewToken, parentTaskId: "build-one",
    reviewedHead: head, candidateVersion, resultCollectedAt: now, cleanedAt: now, createdAt: now,
  };
  const priorReview = legacyPublication ? {
    ...review,
    id: "review-prior", reportToken: "c".repeat(48), reviewedHead: priorHead,
    candidateVersion: 1, worktree: path.join(root, "worktrees", "demo", "review-prior"),
    workspaceId: "review-prior-workspace", agentName: "cd_review_prior",
  } : undefined;
  await mkdir(path.join(stateDir, "reports"), { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  const candidatePath = path.join(stateDir, "reports", "build-one.candidates.json");
  const reviewPath = path.join(stateDir, "reports", "review-one.json");
  const priorReviewPath = path.join(stateDir, "reports", "review-prior.json");
  await writeFile(statePath, JSON.stringify({ version: 1, tasks: {
    "build-one": build,
    ...(priorReview ? { "review-prior": priorReview } : {}),
    "review-one": review,
  } }));
  await writeFile(candidatePath, JSON.stringify({
    schemaVersion: 1, taskId: "build-one", kind: "build", workflow: "reviewed-pr", token: buildToken,
    candidates: [
      ...(legacyPublication ? [{
        version: 1, head: priorHead, submittedAt: now,
        payload: { summary: "candidate v1", commit: priorHead, tests: [], risks: [], openQuestions: [] },
      }] : []),
      {
        version: candidateVersion, head, submittedAt: now,
        payload: { summary: "candidate", commit: head, tests: [], risks: [], openQuestions: [] },
      },
    ],
  }));
  await writeFile(reviewPath, JSON.stringify({
    schemaVersion: 1, taskId: "review-one", kind: "review", lifecycle: "report", contract: "review",
    parentTaskId: "build-one", reviewedHead: head, token: reviewToken, completedAt: now,
    payload: {
      parentTaskId: "build-one", reviewedHead: head, verdict: "approved", summary: "approved exact SHA",
      findings: [], checks: ["fixture review"], openQuestions: [],
    },
  }));
  if (legacyPublication) {
    await writeFile(priorReviewPath, JSON.stringify({
      schemaVersion: 1, taskId: "review-prior", kind: "review", lifecycle: "report", contract: "review",
      parentTaskId: "build-one", reviewedHead: priorHead, token: priorReview.reportToken, completedAt: now,
      payload: {
        parentTaskId: "build-one", reviewedHead: priorHead, verdict: "changes-requested",
        summary: "v1 requires changes", findings: [{
          severity: "major", title: "v1 finding", detail: "fix provenance",
          location: "src/core.mjs", recommendation: "submit v2",
        }],
        checks: ["fixture v1 review"], openQuestions: [],
      },
    }));
  }
  await writeFile(ghState, JSON.stringify({ comments: [] }));
  await writeFile(ghLog, "");

  await mkdir(fakeBin);
  const fakeGit = path.join(fakeBin, "git");
  await writeFile(fakeGit, `#!/usr/bin/env bash
set -euo pipefail
real="$CREW_REAL_GIT"
cwd=""
if [[ "\${1:-}" == "-C" ]]; then cwd="$2"; shift 2; fi
case "\${1:-}" in
  ls-remote)
    exec "$real" ls-remote --heads "$CREW_FAKE_REMOTE" "\${4}" ;;
  push)
    exec "$real" -C "$cwd" push "$2" "$CREW_FAKE_REMOTE" "$4" ;;
  fetch)
    mapped=()
    for value in "$@"; do
      if [[ "$value" == origin ]]; then mapped+=("$CREW_FAKE_REMOTE"); else mapped+=("$value"); fi
    done
    exec "$real" -C "$cwd" "\${mapped[@]}" ;;
  *)
    if [[ -n "$cwd" ]]; then exec "$real" -C "$cwd" "$@"; else exec "$real" "$@"; fi ;;
esac
`);
  await chmod(fakeGit, 0o755);

  const herdr = path.join(fakeBin, "herdr");
  await writeFile(herdr, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$CREW_HERDR_LOG"
case "$1 $2" in
  "agent get")
    if [[ -f "$CREW_AGENT_CLOSED" || "$CREW_AGENT_MODE" == absent ]]; then echo agent_not_found >&2; exit 1; fi
    if [[ "$CREW_AGENT_MODE" == unavailable ]]; then echo connection_refused >&2; exit 1; fi
    printf '{"result":{"agent":{"status":"%s"}}}\n' "$CREW_AGENT_MODE" ;;
  "agent send-keys")
    if [[ "$CREW_FAIL_AGENT_CLOSE" == 1 ]]; then echo close_failed >&2; exit 1; fi
    touch "$CREW_AGENT_CLOSED" ;;
  "worktree remove")
    if [[ "$CREW_FAIL_WORKTREE_REMOVE" == 1 ]]; then echo remove_failed >&2; exit 1; fi
    "$CREW_REAL_GIT" -C "$CREW_FIXTURE_REPO" worktree remove "$CREW_FIXTURE_WORKTREE"
    touch "$CREW_WORKSPACE_REMOVED"
    printf '{"result":{}}\n' ;;
  "workspace get")
    if [[ -f "$CREW_WORKSPACE_REMOVED" ]]; then echo workspace_not_found >&2; exit 1; fi
    printf '{"result":{"workspace":{"workspace_id":"build-workspace"}}}\n' ;;
  "workspace close")
    touch "$CREW_WORKSPACE_REMOVED"
    printf '{"result":{}}\n' ;;
  *) echo unexpected_herdr_command >&2; exit 1 ;;
esac
`);
  await chmod(herdr, 0o755);

  const gh = path.join(fakeBin, "gh");
  await writeFile(gh, `#!/usr/bin/env node
const fs=require("fs");
const args=process.argv.slice(2); const file=process.env.CREW_GH_STATE;
fs.appendFileSync(process.env.CREW_GH_LOG,args.join(" ")+"\\n");
let state=JSON.parse(fs.readFileSync(file,"utf8"));
const save=()=>fs.writeFileSync(file,JSON.stringify(state));
const value=(name)=>args[args.indexOf(name)+1];
if(args[0]==="auth"&&args[1]==="status")process.exit(0);
if(args[0]==="repo"&&args[1]==="view"){console.log(JSON.stringify({nameWithOwner:state.repoView||"acme/demo"}));process.exit(0)}
if(args[0]==="pr"&&args[1]==="list"){
  console.log(JSON.stringify(state.pr&&state.pr.state==="OPEN"?[state.pr]:[]));process.exit(0)
}
if(args[0]==="pr"&&args[1]==="view"){
  if(!state.pr)process.exit(1);console.log(JSON.stringify(state.pr));process.exit(0)
}
if(args[0]==="pr"&&args[1]==="create"){
  state.pr={number:17,url:"https://github.com/acme/demo/pull/17",isDraft:true,
    headRefName:"crew/build-one",baseRefName:"main",headRefOid:process.env.CREW_HEAD,
    isCrossRepository:false,headRepository:{nameWithOwner:"acme/demo"},
    headRepositoryOwner:{login:"acme"},state:"OPEN",title:value("--title"),body:value("--body")};
  save();console.log(state.pr.url);process.exit(0)
}
if(args[0]==="pr"&&args[1]==="edit"){
  state.pr.title=value("--title");state.pr.body=value("--body");save();process.exit(0)
}
if(args[0]==="api"){
  const comments=state.comments||[];
  if(args.includes("POST")){
    const body=args.find((arg)=>arg.startsWith("body=")).slice(5);
    const comment={id:501,html_url:"https://github.com/acme/demo/pull/17#issuecomment-501",body};
    state.comments=[...comments,comment];save();console.log(JSON.stringify(comment));process.exit(0)
  }
  console.log(JSON.stringify(comments));process.exit(0)
}
console.error("unexpected gh "+args.join(" "));process.exit(1)
`);
  await chmod(gh, 0o755);

  const env = {
    ...process.env,
    PATH: `${fakeBin}:${process.env.PATH}`,
    CREWDECK_CONFIG: configPath,
    CREWDECK_STATE_DIR: stateDir,
    CREW_REAL_GIT: realGit,
    CREW_FAKE_REMOTE: remote,
    CREW_FIXTURE_REPO: repo,
    CREW_FIXTURE_WORKTREE: worktree,
    CREW_GH_STATE: ghState,
    CREW_GH_LOG: ghLog,
    CREW_HEAD: head,
    CREW_HERDR_LOG: herdrLog,
    CREW_AGENT_MODE: "idle",
    CREW_AGENT_CLOSED: agentClosed,
    CREW_WORKSPACE_REMOVED: workspaceRemoved,
    CREW_FAIL_AGENT_CLOSE: "0",
    CREW_FAIL_WORKTREE_REMOVE: "0",
    HERDR_ENV: "1",
  };

  const publish = runCli({ env },
    "publish", "build-one", "--remote", "origin", "--repo", "acme/demo",
    "--base", "main", "--head", "crew/build-one", "--title", "Reviewed change", "--body", "Draft body",
  );
  assert.equal(publish.status, 0, publish.stderr);
  if (legacyPublication) {
    await mutateJson(statePath, (state) => {
      delete state.tasks["build-one"].publication.verdictComments;
    });
    await mutateJson(ghState, (github) => {
      github.comments = [];
      github.pr.headRepository = { name: "demo" };
    });
  }
  env.CREW_AGENT_MODE = agent;

  let mergeCommit = localBase;
  if (contained) {
    const external = path.join(root, "external");
    execFileSync(realGit, ["clone", "-q", remote, external]);
    git(external, "config", "user.name", "External GitHub");
    git(external, "config", "user.email", "github@example.com");
    git(external, "fetch", "-q", remote, "refs/heads/crew/build-one");
    git(external, "merge", "-q", "--no-ff", "FETCH_HEAD", "-m", "Merge pull request #17");
    mergeCommit = git(external, "rev-parse", "HEAD");
    git(external, "push", "-q", "origin", "main");
  }
  execFileSync(realGit, ["--git-dir", remote, "update-ref", "-d", "refs/heads/crew/build-one"]);
  const github = JSON.parse(await readFile(ghState, "utf8"));
  github.pr = {
    ...github.pr,
    state: "MERGED",
    isDraft: false,
    mergeCommit: { oid: mergeCommit },
    mergedAt: new Date().toISOString(),
  };
  await writeFile(ghState, JSON.stringify(github));

  return {
    root, repo, worktree, remote, statePath, stateDir, candidatePath, reviewPath, priorReviewPath,
    ghState, ghLog, herdrLog, workspaceRemoved, agentClosed, head, priorHead, mergeCommit, localBase, env,
  };
}

async function crewWidget(item, mode = "") {
  const widgets = [];
  const command = createCrewCommand(async () => {
    const result = runCli(item, "status");
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  });
  await command.handler(mode, {
    ui: {
      setWidget: (...args) => widgets.push(args),
      notify: (message) => assert.fail(message),
    },
  });
  return widgets[0][1].join("\n");
}

test("reproduces a GitHub-merged reviewed publication that remains active in /crew", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));

  assert.equal(git(item.repo, "rev-parse", "main"), item.localBase);
  assert.notEqual(item.mergeCommit, item.localBase);
  assert.equal(git(item.remote, "rev-parse", "main"), item.mergeCommit);
  const state = await persisted(item);
  assert.equal(state.tasks["build-one"].status, "running");
  assert.equal(state.tasks["build-one"].publication.number, 17);
  const widget = await crewWidget(item);
  assert.match(widget, /build-one\s+review-approved/);
});

test("reconciles a historical v2 publication with no verdict field or GitHub comment", async (t) => {
  const item = await fixture({ legacyPublication: true });
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const candidateHistory = await readFile(item.candidatePath, "utf8");
  const reviewHistory = await readFile(item.reviewPath, "utf8");
  const priorReviewHistory = await readFile(item.priorReviewPath, "utf8");
  const before = await persisted(item);
  const publicationHistory = before.tasks["build-one"].publication;
  assert.equal(before.tasks["build-one"].candidateCollectedVersion, 2);
  assert.equal(Object.hasOwn(publicationHistory, "verdictComments"), false);
  assert.deepEqual(JSON.parse(await readFile(item.ghState, "utf8")).comments, []);
  await writeFile(item.ghLog, "");

  const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.task.status, "pr-merged");
  assert.equal(output.reconciliation.status, "merged-reconciled");
  assert.equal(output.reconciliation.evidence.candidate.version, 2);
  assert.equal(output.reconciliation.evidence.candidate.sha, item.head);
  assert.equal(output.reconciliation.evidence.verdict.status, "legacy-absent");
  assert.equal(output.reconciliation.evidence.verdict.headSha, item.head);

  assert.notEqual(spawnSync(realGit, ["-C", item.repo, "show-ref", "--verify", "refs/heads/crew/build-one"]).status, 0);
  await assert.rejects(() => readFile(path.join(item.worktree, "change.txt")), /ENOENT/);
  assert.equal(await readFile(item.candidatePath, "utf8"), candidateHistory);
  assert.equal(await readFile(item.reviewPath, "utf8"), reviewHistory);
  assert.equal(await readFile(item.priorReviewPath, "utf8"), priorReviewHistory);
  const after = await persisted(item);
  assert.deepEqual(after.tasks["build-one"].publication, publicationHistory);
  assert.equal(after.tasks["build-one"].mergeReconciliation.evidence.verdict.status, "legacy-absent");
  assert.deepEqual(JSON.parse(await readFile(item.ghState, "utf8")).comments, []);
  assert.doesNotMatch(await readFile(item.ghLog, "utf8"), /api .*--method (?:POST|PATCH|DELETE)/);

  const status = runCli(item, "status", "build-one");
  assert.equal(status.status, 0, status.stderr);
  const [history] = JSON.parse(status.stdout);
  assert.equal(history.observedStatus, "pr-merged");
  assert.equal(history.mergeReconciliation.evidence.verdict.status, "legacy-absent");
  assert.equal(history.candidates.journal.candidates.at(-1).version, 2);
});

test("reconciles the exact external merge, cleans only isolated resources, and preserves history", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));
  const candidateHistory = await readFile(item.candidatePath, "utf8");
  const reviewHistory = await readFile(item.reviewPath, "utf8");
  const before = await persisted(item);
  const publicationHistory = before.tasks["build-one"].publication;
  const githubComments = JSON.parse(await readFile(item.ghState, "utf8")).comments;
  assert.equal(githubComments.length, 1);
  await writeFile(item.ghLog, "");

  const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.reconciled, true);
  assert.equal(output.idempotent, false);
  assert.equal(output.status, "merged-reconciled");
  assert.equal(output.task.status, "pr-merged");
  assert.equal(output.reconciliation.status, "merged-reconciled");
  assert.equal(output.reconciliation.evidence.pr.number, 17);
  assert.equal(output.reconciliation.evidence.pr.url, "https://github.com/acme/demo/pull/17");
  assert.equal(output.reconciliation.evidence.pr.mergeCommit, item.mergeCommit);
  assert.equal(output.reconciliation.evidence.candidate.sha, item.head);
  assert.equal(output.reconciliation.evidence.verdict.status, "published");
  assert.equal(output.reconciliation.evidence.verdict.headSha, item.head);
  assert.equal(output.reconciliation.evidence.verdict.comment.id, 501);
  assert.ok(output.reconciliation.reconciledAt);
  assert.ok(output.reconciliation.cleanup.workspaceClosedAt);

  assert.equal(git(item.repo, "rev-parse", "main"), item.localBase);
  assert.equal(git(item.remote, "rev-parse", "main"), item.mergeCommit);
  assert.notEqual(spawnSync(realGit, ["-C", item.repo, "show-ref", "--verify", "refs/heads/crew/build-one"]).status, 0);
  await assert.rejects(() => readFile(path.join(item.worktree, "change.txt")), /ENOENT/);
  const herdrLog = await readFile(item.herdrLog, "utf8");
  assert.match(herdrLog, /agent send-keys cd_build_one ctrl\+d/);
  assert.match(herdrLog, /worktree remove --workspace build-workspace/);
  assert.equal(await readFile(item.candidatePath, "utf8"), candidateHistory);
  assert.equal(await readFile(item.reviewPath, "utf8"), reviewHistory);
  const after = await persisted(item);
  assert.deepEqual(after.tasks["build-one"].publication, publicationHistory);
  assert.equal(after.tasks["review-one"].status, "cleaned");
  assert.deepEqual(JSON.parse(await readFile(item.ghState, "utf8")).comments, githubComments);
  assert.doesNotMatch(await readFile(item.ghLog, "utf8"), /api .*--method (?:POST|PATCH|DELETE)/);
  assert.doesNotMatch(await crewWidget(item), /build-one/);
  assert.match(await crewWidget(item, "all"), /build-one\s+pr-merged/);

  const status = runCli(item, "status", "build-one");
  assert.equal(status.status, 0, status.stderr);
  const [history] = JSON.parse(status.stdout);
  assert.equal(history.observedStatus, "pr-merged");
  assert.equal(history.agent.state, "closed");
  assert.equal(history.git.state, "worktree-removed");
  assert.equal(history.candidates.journal.candidates[0].head, item.head);

  const retry = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).idempotent, true);
  assert.equal(git(item.repo, "rev-parse", "main"), item.localBase);
});

test("CLI reconciliation requires its own explicit confirmation", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));

  const result = runCli(item, "reconcile-merged-pr", "build-one");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reconcile-merged-pr requires <reviewed-pr-build-id> --confirm/);
  assert.equal((await persisted(item)).tasks["build-one"].status, "running");
  assert.equal(git(item.repo, "rev-parse", "crew/build-one"), item.head);
});

test("refuses an open PR and every mismatched GitHub PR identity without cleanup", async (t) => {
  const cases = [
    ["open", (github) => { github.pr.state = "OPEN"; github.pr.isDraft = true; }],
    ["number", (github) => { github.pr.number = 18; }],
    ["base", (github) => { github.pr.baseRefName = "release"; }],
    ["head", (github) => { github.pr.headRefName = "crew/other"; }],
    ["sha", (github) => { github.pr.headRefOid = "f".repeat(40); }],
    ["repository", (github) => { github.pr.headRepository.nameWithOwner = "other/demo"; }],
    ["repository-name", (github) => { github.pr.headRepository = { name: "other" }; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const item = await fixture();
      t.after(() => rm(item.root, { recursive: true, force: true }));
      await mutateJson(item.ghState, mutate);

      const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /pull_request_not_merged/);
      await assertUntouched(item);
    });
  }
});

test("refuses mismatched forge and Git remote repositories", async (t) => {
  const forge = await fixture();
  t.after(() => rm(forge.root, { recursive: true, force: true }));
  await mutateJson(forge.ghState, (github) => { github.repoView = "other/demo"; });
  let result = runCli(forge, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /forge_repo_mismatch/);
  await assertUntouched(forge);

  const remote = await fixture();
  t.after(() => rm(remote.root, { recursive: true, force: true }));
  git(remote.repo, "remote", "set-url", "origin", "git@github.com:other/demo.git");
  result = runCli(remote, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remote_repo_mismatch/);
  await assertUntouched(remote);
});

test("refuses a claimed merge when the approved SHA is not contained", async (t) => {
  const item = await fixture({ contained: false });
  t.after(() => rm(item.root, { recursive: true, force: true }));

  const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /approved_sha_not_contained/);
  await assertUntouched(item);
});

test("refuses active, blocked, unknown, or unreachable agents", async (t) => {
  for (const [agent, code] of [
    ["working", "worker_not_settled"],
    ["blocked", "worker_not_settled"],
    ["unknown", "worker_not_settled"],
    ["unavailable", "agent_state_unknown"],
  ]) {
    await t.test(agent, async (t) => {
      const item = await fixture({ agent });
      t.after(() => rm(item.root, { recursive: true, force: true }));

      const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
      assert.equal(result.status, 1);
      assert.match(result.stderr, new RegExp(code));
      await assertUntouched(item);
    });
  }
});

test("accepts absent or done agents but refuses a dirty worktree", async (t) => {
  const absent = await fixture({ agent: "absent" });
  t.after(() => rm(absent.root, { recursive: true, force: true }));
  let result = runCli(absent, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task.status, "pr-merged");

  const done = await fixture({ agent: "done" });
  t.after(() => rm(done.root, { recursive: true, force: true }));
  result = runCli(done, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).task.status, "pr-merged");

  const dirty = await fixture();
  t.after(() => rm(dirty.root, { recursive: true, force: true }));
  await writeFile(path.join(dirty.worktree, "keep-me.txt"), "uncommitted data\n");
  result = runCli(dirty, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /dirty_worktree/);
  assert.equal(await readFile(path.join(dirty.worktree, "keep-me.txt"), "utf8"), "uncommitted data\n");
  assert.equal((await persisted(dirty)).tasks["build-one"].status, "running");
  assert.equal(git(dirty.repo, "rev-parse", "crew/build-one"), dirty.head);
});

test("refuses a newer candidate and preserves its branch", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await writeFile(path.join(item.worktree, "newer.txt"), "new candidate\n");
  git(item.worktree, "add", "newer.txt");
  git(item.worktree, "commit", "-qm", "newer candidate");
  const newer = git(item.worktree, "rev-parse", "HEAD");
  await mutateJson(item.candidatePath, (journal) => {
    journal.candidates.push({
      version: 2, head: newer, submittedAt: new Date().toISOString(),
      payload: { summary: "newer", commit: newer, tests: [], risks: [], openQuestions: [] },
    });
  });

  const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /stale_candidate/);
  assert.equal((await persisted(item)).tasks["build-one"].status, "running");
  assert.equal(git(item.repo, "rev-parse", "crew/build-one"), newer);
  assert.equal(await readFile(path.join(item.worktree, "newer.txt"), "utf8"), "new candidate\n");
});

test("refuses missing durable publication identity", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await mutateJson(item.statePath, (state) => { delete state.tasks["build-one"].publication; });

  const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid_publication_identity/);
  await assertUntouched(item);
});

test("refuses ambiguous, dispatched, partial, empty, divergent, or untracked verdict evidence", async (t) => {
  const cases = [
    ["ambiguous", (publication) => { publication.verdictComments[0].status = "ambiguous"; }],
    ["dispatched", (publication) => { publication.verdictComments[0].status = "dispatched"; }],
    ["partial", (publication) => { delete publication.verdictComments[0].comment.url; }],
    ["empty", (publication) => { publication.verdictComments = []; }],
    ["divergent", (publication) => { publication.verdictComments[0].contentSha256 = "f".repeat(64); }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (t) => {
      const item = await fixture();
      t.after(() => rm(item.root, { recursive: true, force: true }));
      await mutateJson(item.statePath, (state) => mutate(state.tasks["build-one"].publication));
      const comments = JSON.parse(await readFile(item.ghState, "utf8")).comments;
      await writeFile(item.ghLog, "");

      const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
      assert.equal(result.status, 1);
      assert.match(result.stderr, /ambiguous_publication/);
      await assertUntouched(item);
      assert.deepEqual(JSON.parse(await readFile(item.ghState, "utf8")).comments, comments);
      assert.doesNotMatch(await readFile(item.ghLog, "utf8"), /api .*--method (?:POST|PATCH|DELETE)/);
    });
  }

  await t.test("absent journal with an untracked GitHub verdict", async (t) => {
    const item = await fixture();
    t.after(() => rm(item.root, { recursive: true, force: true }));
    await mutateJson(item.statePath, (state) => {
      delete state.tasks["build-one"].publication.verdictComments;
    });
    const comments = JSON.parse(await readFile(item.ghState, "utf8")).comments;
    assert.equal(comments.length, 1);
    await writeFile(item.ghLog, "");

    const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
    assert.equal(result.status, 1);
    assert.match(result.stderr, /ambiguous_publication/);
    await assertUntouched(item);
    assert.deepEqual(JSON.parse(await readFile(item.ghState, "utf8")).comments, comments);
    assert.doesNotMatch(await readFile(item.ghLog, "utf8"), /api .*--method (?:POST|PATCH|DELETE)/);
  });
});

test("does not mark terminal on cleanup failure and safely resumes cleanup", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));
  item.env.CREW_FAIL_WORKTREE_REMOVE = "1";

  let result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /worktree_cleanup_failed/);
  let state = await persisted(item);
  assert.equal(state.tasks["build-one"].status, "running");
  assert.equal(state.tasks["build-one"].mergeReconciliation.status, "cleanup-failed");
  const failedStatus = runCli(item, "status", "build-one");
  assert.equal(failedStatus.status, 0, failedStatus.stderr);
  assert.equal(JSON.parse(failedStatus.stdout)[0].observedStatus, "merge-cleanup-failed");
  assert.equal(git(item.repo, "rev-parse", "crew/build-one"), item.head);
  assert.equal(await readFile(path.join(item.worktree, "change.txt"), "utf8"), "approved candidate\n");

  item.env.CREW_FAIL_WORKTREE_REMOVE = "0";
  result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 0, result.stderr);
  state = await persisted(item);
  assert.equal(state.tasks["build-one"].status, "pr-merged");
  assert.equal(state.tasks["build-one"].mergeReconciliation.attempts, 2);
  assert.notEqual(spawnSync(realGit, ["-C", item.repo, "show-ref", "--verify", "refs/heads/crew/build-one"]).status, 0);
});

test("refuses non-reviewed workflows and keeps their Git resources", async (t) => {
  const item = await fixture();
  t.after(() => rm(item.root, { recursive: true, force: true }));
  await mutateJson(item.statePath, (state) => { state.tasks["build-one"].workflow = "direct"; });

  const result = runCli(item, "reconcile-merged-pr", "build-one", "--confirm");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /invalid_reconciliation_task/);
  await assertUntouched(item);
});

test("Pi exposes a separately confirmed merged-PR reconciliation tool and CLI help", async () => {
  const source = await readFile(path.join(projectRoot, ".pi/extensions/crewdeck/index.ts"), "utf8");
  const start = source.indexOf('name: "crew_reconcile_merged_pr"');
  const tool = source.slice(start, source.indexOf('name: "crew_prepare_integration"', start));
  assert.ok(start >= 0);
  assert.match(tool, /requires interactive confirmation/);
  assert.match(tool, /ctx\.ui\.confirm/);
  assert.match(tool, /if \(!confirmed\).*user declined/);
  assert.match(tool, /await reconcileMergedPullRequest/);
  assert.doesNotMatch(tool, /mergeTask|publishPullRequest/);

  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /reconcile-merged-pr <reviewed-pr-build-id> --confirm/);
});
