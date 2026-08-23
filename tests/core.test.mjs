import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProject, CrewdeckError, loadConfig, spawnBatch } from "../src/core.mjs";

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-test-"));
  const repo = path.join(root, "repo");
  execFileSync("git", ["init", "-q", "-b", "main", repo]);
  await writeFile(path.join(repo, "README.md"), "test\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "-qm", "initial");
  const configPath = path.join(root, "crewdeck.json");
  const profilesPath = path.join(root, "profiles.yml");
  await writeFile(
    profilesPath,
    [
      "version: 1",
      "defaultProfile: worker",
      "profiles:",
      "  worker:",
      "    provider: test",
      "    model: model",
      "    thinking: medium",
      "    allowedKinds: [scout, build]",
      "  scout-only:",
      "    provider: test",
      "    model: model",
      "    thinking: low",
      "    allowedKinds: [scout]",
      "",
    ].join("\n"),
  );
  await writeFile(
    configPath,
    JSON.stringify({
      maxWorkers: 5,
      worktreeRoot: path.join(root, "worktrees"),
      profilesFile: profilesPath,
      scoutCleanup: "after-collection",
      projects: {},
    }),
  );
  return { root, repo, configPath };
}

test("loads a minimal valid configuration", async () => {
  const { configPath } = await fixture();
  const config = await loadConfig(configPath);
  assert.equal(config.maxWorkers, 5);
  assert.equal(config.profiles.worker.thinking, "medium");
  assert.equal(config.profiles.worker.provider, "test");
  assert.ok(path.isAbsolute(config.worktreeRoot));
});

test("registers a Git project with explicit trust", async () => {
  const { configPath, repo } = await fixture();
  const project = await addProject(configPath, "demo", repo, {
    base: "main",
    trustProjectResources: true,
  });
  assert.deepEqual(project, {
    path: repo,
    base: "main",
    trustProjectResources: true,
    verify: [],
  });
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.projects.demo.path, repo);
  assert.equal(typeof persisted.profilesFile, "string");
  assert.equal(persisted.profiles, undefined);
});

test("requires every task to declare scout or build", async () => {
  const { configPath } = await fixture();
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    await assert.rejects(
      () =>
        spawnBatch(configPath, {
          project: "missing",
          tasks: [{ id: "missing-kind", task: "Analyze the fixture without a declared task kind" }],
        }),
      (error) => {
        assert.ok(error instanceof CrewdeckError);
        assert.equal(error.code, "invalid_task");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
});

test("rejects a build assigned to a scout-only model profile", async () => {
  const { configPath } = await fixture();
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    await assert.rejects(
      () =>
        spawnBatch(configPath, {
          project: "missing",
          tasks: [
            {
              id: "wrong-profile",
              kind: "build",
              profile: "scout-only",
              task: "Implement a fixture change with the wrong model profile",
            },
          ],
        }),
      (error) => {
        assert.ok(error instanceof CrewdeckError);
        assert.equal(error.code, "profile_kind_mismatch");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
});

test("rejects batches above the configured concurrency cap before mutation", async () => {
  const { configPath } = await fixture();
  const previous = process.env.HERDR_ENV;
  process.env.HERDR_ENV = "1";
  try {
    await assert.rejects(
      () =>
        spawnBatch(configPath, {
          project: "missing",
          tasks: Array.from({ length: 6 }, (_, index) => ({
            id: `task-${index}`,
            kind: "build",
            task: `Perform independent test task number ${index}`,
          })),
        }),
      (error) => {
        assert.ok(error instanceof CrewdeckError);
        assert.equal(error.code, "invalid_batch");
        return true;
      },
    );
  } finally {
    if (previous === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = previous;
  }
});

test("rejects invalid worker thinking levels", async () => {
  const { configPath } = await fixture();
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    raw.profilesFile,
    "version: 1\ndefaultProfile: worker\nprofiles:\n  worker:\n    provider: test\n    model: model\n    thinking: enormous\n    allowedKinds: [build]\n",
  );
  await assert.rejects(() => loadConfig(configPath), (error) => {
    assert.ok(error instanceof CrewdeckError);
    assert.equal(error.code, "invalid_config");
    return true;
  });
});
