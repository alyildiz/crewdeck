import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { loadConfig } from "../src/core.mjs";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function runCli(tmp, args, env = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [path.join(tmp, "bin", "crewdeck"), ...args], {
      cwd: tmp,
      env: { ...process.env, CREWDECK_STATE_DIR: path.join(tmp, "state"), ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// Copy the tracked runtime (bin, src, config, package.json, node_modules,
// crewdeck.json.example) into a temp directory and drop the machine-local
// config files, simulating a fresh clone where crewdeck.json and
// config/profiles.yml are git-ignored.
async function freshCheckout() {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "crewdeck-templates-"));
  for (const entry of ["bin", "src", "config", "package.json", "node_modules", "crewdeck.json.example"]) {
    await cp(path.join(root, entry), path.join(tmp, entry), { recursive: true });
  }
  await rm(path.join(tmp, "crewdeck.json"), { force: true });
  await rm(path.join(tmp, "config", "profiles.yml"), { force: true });
  return tmp;
}

async function bootstrap(tmp) {
  await cp(path.join(tmp, "crewdeck.json.example"), path.join(tmp, "crewdeck.json"));
  await cp(path.join(tmp, "config", "profiles.yml.example"), path.join(tmp, "config", "profiles.yml"));
}

test("tracked templates are portable and load as a valid configuration", async (t) => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "crewdeck-templates-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const jsonExample = await readFile(path.join(root, "crewdeck.json.example"), "utf8");
  const profilesExample = await readFile(path.join(root, "config", "profiles.yml.example"), "utf8");
  for (const content of [jsonExample, profilesExample]) {
    assert.doesNotMatch(content, /\/home\//, "templates must not contain local home paths");
    assert.doesNotMatch(content, /baris/, "templates must not contain local usernames");
    assert.doesNotMatch(content, /projects\/crewdeck/, "templates must not reference local checkouts");
    assert.doesNotMatch(content, /100\.\d+\.\d+\.\d+/, "templates must not contain local network addresses");
  }
  const parsed = JSON.parse(jsonExample);
  assert.deepEqual(parsed.projects, {}, "template must register no projects");
  for (const value of Object.values(parsed)) {
    if (typeof value === "string") assert.doesNotMatch(value, /^\//, "template paths must be relative or ~-based");
  }
  await writeFile(path.join(tmp, "crewdeck.json"), jsonExample);
  await mkdir(path.join(tmp, "config"), { recursive: true });
  await writeFile(path.join(tmp, "config", "profiles.yml"), profilesExample);
  await cp(path.join(root, "config", "kinds.yml"), path.join(tmp, "config", "kinds.yml"));
  const config = await loadConfig(path.join(tmp, "crewdeck.json"));
  assert.deepEqual(config.projects, {});
  assert.equal(config.defaultProfile, "default");
  assert.ok(config.profiles.default);
  assert.ok(path.isAbsolute(config.worktreeRoot));
});

test("missing default config fails with guided bootstrap commands", async (t) => {
  const tmp = await freshCheckout();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const result = await runCli(tmp, ["config"]);
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "missing_config");
  assert.match(error.error, /cp crewdeck\.json\.example crewdeck\.json/);
  assert.match(error.error, /cp config\/profiles\.yml\.example config\/profiles\.yml/);
});

test("bootstrap from the tracked templates makes a fresh checkout work", async (t) => {
  const tmp = await freshCheckout();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await bootstrap(tmp);
  const result = await runCli(tmp, ["config"]);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.deepEqual(config.projects, {});
  assert.ok(config.kinds.scout);
  assert.ok(config.kinds.build);
  assert.equal(config.defaultProfile, "default");
});

test("an explicit CREWDECK_CONFIG pointing elsewhere keeps the plain error", async (t) => {
  const tmp = await freshCheckout();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const result = await runCli(tmp, ["config"], { CREWDECK_CONFIG: path.join(tmp, "elsewhere.json") });
  assert.equal(result.code, 1);
  const error = JSON.parse(result.stderr);
  assert.equal(error.code, "invalid_config");
  assert.match(error.error, /Cannot read/);
  assert.doesNotMatch(error.error, /crewdeck\.json\.example/, "explicit config errors must not be masked by bootstrap guidance");
});

test("project add mutates only the local copy, never the tracked templates", async (t) => {
  const tmp = await freshCheckout();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await bootstrap(tmp);
  const jsonExampleBefore = await readFile(path.join(tmp, "crewdeck.json.example"), "utf8");
  const profilesExampleBefore = await readFile(path.join(tmp, "config", "profiles.yml.example"), "utf8");
  const repo = path.join(tmp, "demo-project");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "demo\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  const result = await runCli(tmp, ["project", "add", "demo", repo, "--base", "main"]);
  assert.equal(result.code, 0, result.stderr);
  const local = JSON.parse(await readFile(path.join(tmp, "crewdeck.json"), "utf8"));
  assert.equal(local.projects.demo.path, repo);
  assert.equal(local.projects.demo.base, "main");
  assert.equal(sha256(await readFile(path.join(tmp, "crewdeck.json.example"), "utf8")), sha256(jsonExampleBefore));
  assert.equal(sha256(await readFile(path.join(tmp, "config", "profiles.yml.example"), "utf8")), sha256(profilesExampleBefore));
  const listed = await runCli(tmp, ["project", "list"]);
  assert.equal(listed.code, 0, listed.stderr);
  assert.ok(JSON.parse(listed.stdout).demo);
});

test("existing local runtime files keep working unchanged (backward compatibility)", async (t) => {
  const tmp = await freshCheckout();
  t.after(() => rm(tmp, { recursive: true, force: true }));
  // Simulate a pre-existing installation: local files present, not from the examples.
  await writeFile(
    path.join(tmp, "crewdeck.json"),
    JSON.stringify({
      maxWorkers: 2,
      worktreeRoot: path.join(tmp, "worktrees"),
      profilesFile: "config/profiles.yml",
      kindsFile: "config/kinds.yml",
      projects: {},
    }),
  );
  await writeFile(
    path.join(tmp, "config", "profiles.yml"),
    [
      "version: 1",
      "defaultProfile: legacy",
      "profiles:",
      "  legacy:",
      "    provider: legacy-provider",
      "    model: legacy-model",
      "    thinking: low",
      "    allowedKinds: [scout, build]",
      "",
    ].join("\n"),
  );
  const result = await runCli(tmp, ["config"]);
  assert.equal(result.code, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.maxWorkers, 2);
  assert.equal(config.defaultProfile, "legacy");
});
