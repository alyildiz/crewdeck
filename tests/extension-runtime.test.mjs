import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function resourceCounts() {
  const resources = process.getActiveResourcesInfo();
  return {
    watchers: resources.filter((name) => name === "FSEventWrap").length,
    timers: resources.filter((name) => name === "Timeout").length,
  };
}

async function extensionFixture(t, { configPath, stateDir, configOverrides = {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-extension-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionDir = path.join(root, ".pi", "extensions", "crewdeck");
  await mkdir(extensionDir, { recursive: true });
  await copyFile(path.join(projectRoot, ".pi", "extensions", "crewdeck", "index.ts"), path.join(extensionDir, "index.ts"));
  await symlink(path.join(projectRoot, "src"), path.join(root, "src"), "dir");
  const typebox = path.join(root, "node_modules", "typebox");
  await mkdir(typebox, { recursive: true });
  await writeFile(path.join(typebox, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(path.join(typebox, "index.js"), "export const Type=new Proxy({}, {get:()=> (...args)=>({args})});\n");
  if (configPath) {
    const kindsPath = path.join(root, "kinds.yml");
    const profilesPath = path.join(root, "profiles.yml");
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
        "",
      ].join("\n"),
    );
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        maxWorkers: 5,
        worktreeRoot: path.join(root, "worktrees"),
        profilesFile: profilesPath,
        kindsFile: kindsPath,
        projects: {},
        ...configOverrides,
      }),
    );
  }
  process.env.CREWDECK_CONFIG = configPath;
  process.env.CREWDECK_STATE_DIR = stateDir;
  t.after(() => {
    delete process.env.CREWDECK_CONFIG;
    delete process.env.CREWDECK_STATE_DIR;
  });
  const handlers = {};
  const sent = [];
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name, fn) { handlers[name] = fn; },
    sendUserMessage: (message, options) => sent.push([message, options]),
  };
  const { default: extension } = await import(pathToFileURL(path.join(extensionDir, "index.ts")));
  extension(pi);
  return { root, handlers, pi, sent };
}

test("Pi extension runtime registers hardened lifecycle tools and executes lock diagnostics", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-extension-runtime-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionDir = path.join(root, ".pi", "extensions", "crewdeck");
  await mkdir(extensionDir, { recursive: true });
  await copyFile(path.join(projectRoot, ".pi", "extensions", "crewdeck", "index.ts"), path.join(extensionDir, "index.ts"));
  await symlink(path.join(projectRoot, "src"), path.join(root, "src"), "dir");
  const typebox = path.join(root, "node_modules", "typebox");
  await mkdir(typebox, { recursive: true });
  await writeFile(path.join(typebox, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(path.join(typebox, "index.js"), "export const Type=new Proxy({}, {get:()=> (...args)=>({args})});\n");

  const tools = [];
  const pi = {
    registerTool(tool) { tools.push(tool); },
    registerCommand() {}, on() {}, sendUserMessage() {},
  };
  process.env.CREWDECK_STATE_DIR = path.join(root, "state");
  t.after(() => { delete process.env.CREWDECK_STATE_DIR; });
  const { default: extension } = await import(pathToFileURL(path.join(extensionDir, "index.ts")));
  extension(pi);
  for (const name of ["crew_reconcile_verdict", "crew_extend_review_rounds", "crew_retire_agent", "crew_state_lock", "crew_observe_prs"]) {
    assert.ok(tools.some((tool) => tool.name === name), `missing runtime tool ${name}`);
  }
  const statusTool = tools.find((tool) => tool.name === "crew_status");
  assert.match(statusTool.description, /targeted token-safe projection/);
  assert.match(statusTool.description, /scope=history\/all/);
  assert.match(statusTool.description, /mode=diagnostic/);
  const statusSchema = JSON.stringify(statusTool.parameters);
  for (const field of ["id", "mode", "diagnostic", "scope", "limit", "cursor", "active", "history", "all"]) {
    assert.ok(statusSchema.includes(`\"${field}\"`), `crew_status schema must expose ${field}`);
  }
  assert.match(statusSchema, /\"minimum\":1/);
  assert.match(statusSchema, /\"maximum\":50/);
  assert.match(statusSchema, /\"minimum\":0/);
  assert.ok(tools.some((tool) => tool.name === "crew_read_result"));
  const lockTool = tools.find((tool) => tool.name === "crew_state_lock");
  const result = await lockTool.execute("call", {}, undefined, undefined, { hasUI: false });
  assert.equal(result.details.status, "unlocked");
});

test("session_start whose config load rejects installs no watcher and no wake controller", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-extension-config-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await extensionFixture(t, {
    configPath: path.join(root, "missing", "crewdeck.json"),
    stateDir: path.join(root, "state"),
    configOverrides: { maxWorkers: 99 },
  });
  assert.equal(typeof fixture.handlers.session_start, "function");
  const before = resourceCounts();
  const ctx = { ui: { setStatus() {}, notify() {}, setWidget() {} } };
  await assert.rejects(() => fixture.handlers.session_start({}, ctx), (error) => {
    assert.equal(error.code, "invalid_config");
    return true;
  });
  const after = resourceCounts();
  assert.equal(after.watchers, before.watchers, "a config failure must not leave an fs watcher installed");
  assert.equal(after.timers, before.timers, "a config failure must not leave a wake controller timer scheduled");
  assert.equal(fs.existsSync(path.join(root, "state")), false, "a config failure must not create the state directory");
});

test("double session_start does not leak the observer interval or the report watcher", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-extension-double-start-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await extensionFixture(t, { configPath: path.join(root, "crewdeck.json"), stateDir: path.join(root, "state") });
  const ctx = { ui: { setStatus() {}, notify() {}, setWidget() {} } };
  let shutDown = false;
  t.after(() => {
    if (!shutDown) fixture.handlers.session_shutdown({}, ctx);
  });
  const before = resourceCounts();
  await fixture.handlers.session_start({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterFirst = resourceCounts();
  assert.equal(afterFirst.watchers, before.watchers + 1, "first start installs exactly one report watcher");
  assert.equal(afterFirst.timers, before.timers + 1, "first start installs exactly one observer interval");
  await fixture.handlers.session_start({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const afterSecond = resourceCounts();
  assert.equal(afterSecond.watchers, afterFirst.watchers, "second start must replace, not add, the report watcher");
  assert.equal(afterSecond.timers, afterFirst.timers, "second start must replace, not add, the observer interval");
  fixture.handlers.session_shutdown({}, ctx);
  shutDown = true;
  await new Promise((resolve) => setTimeout(resolve, 100));
  const afterShutdown = resourceCounts();
  assert.equal(afterShutdown.watchers, before.watchers, "shutdown clears the report watcher");
  assert.equal(afterShutdown.timers, before.timers, "shutdown clears the observer interval");
});
