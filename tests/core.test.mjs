import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { addProject, CrewdeckError, getPendingResultIds, loadConfig, spawnBatch } from "../src/core.mjs";

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
  const kindsPath = path.join(root, "kinds.yml");
  await writeFile(
    kindsPath,
    [
      "version: 1",
      "kinds:",
      "  scout:",
      "    lifecycle: report",
      "    description: Read-only fixture investigation",
      "    permissions: { filesystem: read-only, shell: false }",
      "    tools: [read, grep, find, ls]",
      "    skills: []",
      "    cleanup: after-collection",
      "  build:",
      "    lifecycle: change",
      "    description: Fixture implementation and commit",
      "    permissions: { filesystem: write, shell: true }",
      "    tools: [read, grep, find, ls, bash, edit, write]",
      "    skills: []",
      "    cleanup: after-integration",
      "",
    ].join("\n"),
  );
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
      kindsFile: kindsPath,
      projects: {},
    }),
  );
  return { root, repo, configPath };
}

test("loads a minimal valid configuration", async () => {
  const { configPath } = await fixture();
  const config = await loadConfig(configPath);
  assert.equal(config.maxWorkers, 5);
  assert.equal(config.maxReviewRounds, 3);
  assert.equal(config.profiles.worker.thinking, "medium");
  assert.equal(config.profiles.worker.provider, "test");
  assert.equal(config.kinds.scout.lifecycle, "report");
  assert.deepEqual(config.kinds.scout.skills, []);
  assert.ok(path.isAbsolute(config.worktreeRoot));
});

test("resolves only explicitly configured kind skills", async () => {
  const { root, configPath } = await fixture();
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  const skill = path.join(root, "skills", "review", "SKILL.md");
  await mkdir(path.dirname(skill), { recursive: true });
  await writeFile(skill, "---\nname: review\ndescription: Review fixture files\n---\n");
  const kinds = await readFile(raw.kindsFile, "utf8");
  await writeFile(raw.kindsFile, kinds.replace("    skills: []", "    skills: [./skills/review/SKILL.md]"));

  const config = await loadConfig(configPath);
  assert.deepEqual(config.kinds.scout.skills, ["./skills/review/SKILL.md"]);
  assert.deepEqual(config.kinds.scout.resolvedSkills, [skill]);
  assert.deepEqual(config.kinds.build.skills, []);
});

test("registers a Git project with explicit trust and base remote", async () => {
  const { configPath, repo } = await fixture();
  const project = await addProject(configPath, "demo", repo, {
    base: "main",
    baseRemote: "upstream",
    trustProjectResources: true,
  });
  assert.deepEqual(project, {
    path: repo,
    base: "main",
    baseRemote: "upstream",
    trustProjectResources: true,
    verify: [],
  });
  const persisted = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(persisted.projects.demo.path, repo);
  assert.equal(persisted.projects.demo.baseRemote, "upstream");
  assert.equal(typeof persisted.profilesFile, "string");
  assert.equal(persisted.profiles, undefined);
});

test("requires every task to declare a configured kind", async () => {
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

test("rejects a report kind that grants a mutating tool", async () => {
  const { configPath } = await fixture();
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  await writeFile(
    raw.kindsFile,
    "version: 1\nkinds:\n  unsafe-report:\n    lifecycle: report\n    description: Unsafe report fixture\n    permissions: { filesystem: read-only, shell: false }\n    tools: [read, bash]\n    skills: []\n    cleanup: after-collection\n",
  );
  await assert.rejects(() => loadConfig(configPath), (error) => {
    assert.ok(error instanceof CrewdeckError);
    assert.equal(error.code, "invalid_config");
    return true;
  });
});

test("reconciles durable uncollected reports as pending wake input", async () => {
  const { root, configPath } = await fixture();
  const stateDir = path.join(root, "state");
  const token = "a".repeat(48);
  await mkdir(path.join(stateDir, "reports"), { recursive: true });
  await writeFile(
    path.join(stateDir, "state.json"),
    JSON.stringify({
      version: 1,
      tasks: {
        "ready-report": {
          id: "ready-report",
          kind: "scout",
          lifecycle: "report",
          status: "running",
          reportToken: token,
        },
      },
    }),
  );
  await writeFile(
    path.join(stateDir, "reports", "ready-report.json"),
    JSON.stringify({
      schemaVersion: 1,
      taskId: "ready-report",
      kind: "scout",
      lifecycle: "report",
      token,
      payload: { conclusion: "done" },
    }),
  );
  const previous = process.env.CREWDECK_STATE_DIR;
  process.env.CREWDECK_STATE_DIR = stateDir;
  try {
    assert.deepEqual(await getPendingResultIds(configPath), ["ready-report"]);
  } finally {
    if (previous === undefined) delete process.env.CREWDECK_STATE_DIR;
    else process.env.CREWDECK_STATE_DIR = previous;
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
