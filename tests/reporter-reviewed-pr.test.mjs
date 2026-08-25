import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const reporterSource = await readFile(path.join(projectRoot, "worker/reporter.ts"), "utf8");

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function reporterHarness() {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-reporter-"));
  const extensionDir = path.join(root, "extension");
  const modules = path.join(extensionDir, "node_modules");
  await mkdir(path.join(modules, "@earendil-works", "pi-coding-agent"), { recursive: true });
  await mkdir(path.join(modules, "@earendil-works", "pi-ai"), { recursive: true });
  await mkdir(path.join(modules, "typebox"), { recursive: true });
  await writeFile(path.join(extensionDir, "reporter.ts"), reporterSource);
  const packageJson = JSON.stringify({ type: "module", exports: "./index.js" });
  await writeFile(path.join(modules, "@earendil-works", "pi-coding-agent", "package.json"), packageJson);
  await writeFile(
    path.join(modules, "@earendil-works", "pi-coding-agent", "index.js"),
    "export async function withFileMutationQueue(_path, fn) { return fn(); }\n",
  );
  await writeFile(path.join(modules, "@earendil-works", "pi-ai", "package.json"), packageJson);
  await writeFile(path.join(modules, "@earendil-works", "pi-ai", "index.js"), "export const StringEnum = () => ({});\n");
  await writeFile(path.join(modules, "typebox", "package.json"), packageJson);
  await writeFile(
    path.join(modules, "typebox", "index.js"),
    "export const Type = new Proxy({}, { get: () => (..._args) => ({}) });\n",
  );
  return { root, extension: path.join(extensionDir, "reporter.ts") };
}

function runReporter({ extension, cwd, reportDir, workflow, script }) {
  return spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CREW_REPORTER_EXTENSION: extension,
        CREWDECK_TASK_ID: "build-one",
        CREWDECK_TASK_KIND: "build",
        CREWDECK_TASK_LIFECYCLE: "change",
        CREWDECK_TASK_CONTRACT: "standard",
        CREWDECK_TASK_WORKFLOW: workflow,
        CREWDECK_TASK_BRANCH: "crew/build-one",
        CREWDECK_TASK_BASE: "main",
        CREWDECK_TASK_BASE_SHA: git(cwd, "rev-parse", "main"),
        CREWDECK_MAX_REVIEW_ROUNDS: "3",
        CREWDECK_REPORT_TOKEN: "a".repeat(48),
        CREWDECK_REPORT_DIR: reportDir,
      },
    },
  );
}

test("reproduces immutable terminating crew_complete and keeps reviewed-pr candidates non-terminating and versioned", async (t) => {
  const harness = await reporterHarness();
  t.after(() => rm(harness.root, { recursive: true, force: true }));
  const repo = path.join(harness.root, "repo");
  const worktree = path.join(harness.root, "worktree");
  const reportDir = path.join(harness.root, "reports");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.com");
  await writeFile(path.join(repo, "file.txt"), "base\n");
  git(repo, "add", "file.txt");
  git(repo, "commit", "-qm", "base");
  git(repo, "worktree", "add", "-q", "-b", "crew/build-one", worktree, "main");
  await writeFile(path.join(worktree, "candidate.txt"), "one\n");
  git(worktree, "add", "candidate.txt");
  git(worktree, "commit", "-qm", "candidate one");

  const completeScript = `
    const tools=[]; const pi={registerTool(tool){tools.push(tool)}};
    const {default: reporter}=await import(process.env.CREW_REPORTER_EXTENSION); reporter(pi);
    const payload={summary:"first",commit:"${git(worktree, "rev-parse", "HEAD")}",tests:[],risks:[],openQuestions:[]};
    const first=await tools.find(t=>t.name==="crew_complete").execute("one",payload);
    let second; try { await tools.find(t=>t.name==="crew_complete").execute("two",{...payload,summary:"replacement"}); }
    catch(error){second=error.message}
    console.log(JSON.stringify({terminate:first.terminate,second}));
  `;
  let result = runReporter({
    extension: harness.extension,
    cwd: worktree,
    reportDir,
    workflow: "direct",
    script: completeScript,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    terminate: true,
    second: "Crewdeck result already submitted; do not replace a durable result",
  });
  assert.equal(JSON.parse(await readFile(path.join(reportDir, "build-one.json"), "utf8")).payload.summary, "first");

  await rm(reportDir, { recursive: true, force: true });
  const candidateScript = `
    const tools=[]; const pi={registerTool(tool){tools.push(tool)}};
    const {default: reporter}=await import(process.env.CREW_REPORTER_EXTENSION); reporter(pi);
    const tool=tools.find(t=>t.name==="crew_submit_candidate");
    const head=(await import("node:child_process")).execFileSync("git",["rev-parse","HEAD"],{encoding:"utf8"}).trim();
    const payload={summary:"candidate",commit:head,tests:[],risks:[],openQuestions:[]};
    const first=await tool.execute("one",payload); const retry=await tool.execute("two",payload);
    console.log(JSON.stringify({first:first.details,retry:retry.details,firstTerminates:first.terminate,retryTerminates:retry.terminate}));
  `;
  result = runReporter({
    extension: harness.extension,
    cwd: worktree,
    reportDir,
    workflow: "reviewed-pr",
    script: candidateScript,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.first.version, 1);
  assert.equal(output.first.idempotent, false);
  assert.equal(output.retry.idempotent, true);
  assert.equal(output.firstTerminates, undefined);
  assert.equal(output.retryTerminates, undefined);
  const journal = JSON.parse(await readFile(path.join(reportDir, "build-one.candidates.json"), "utf8"));
  assert.equal(journal.candidates.length, 1);
  assert.equal(journal.candidates[0].head, git(worktree, "rev-parse", "HEAD"));
});
