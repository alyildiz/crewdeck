import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function runtimeFixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-completion-boundary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const extensionDir = path.join(root, ".pi", "extensions", "crewdeck");
  await mkdir(extensionDir, { recursive: true });
  await copyFile(path.join(projectRoot, ".pi/extensions/crewdeck/index.ts"), path.join(extensionDir, "index.ts"));
  await symlink(path.join(projectRoot, "src"), path.join(root, "src"), "dir");
  const typebox = path.join(root, "node_modules/typebox");
  await mkdir(typebox, { recursive: true });
  await writeFile(path.join(typebox, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }));
  await writeFile(path.join(typebox, "index.js"), "export const Type=new Proxy({}, {get:()=> (...args)=>({args})});\n");

  const stateDir = path.join(root, "state");
  const reportsDir = path.join(stateDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "crewdeck.json");
  await writeFile(kindsPath, [
    "version: 1", "kinds:", "  scout:", "    lifecycle: report",
    "    description: Read-only fixture", "    permissions: { filesystem: read-only, shell: false }",
    "    tools: [read, grep, find, ls]", "    skills: []", "    cleanup: after-collection", "",
  ].join("\n"));
  await writeFile(profilesPath, [
    "version: 1", "defaultProfile: worker", "profiles:", "  worker:", "    provider: test",
    "    model: model", "    thinking: medium", "    allowedKinds: [scout]", "",
  ].join("\n"));
  await writeFile(configPath, JSON.stringify({ maxWorkers: 5, worktreeRoot: path.join(root, "worktrees"), profilesFile: profilesPath, kindsFile: kindsPath, projects: {} }));

  const marker = "PAYLOAD-ONCE-";
  const payload = `${marker}${"é\\\"🙂".repeat(8000)}`;
  const token = "t".repeat(48);
  const record = {
    id: "completed-report", project: "demo", kind: "scout", lifecycle: "report", workflow: "direct",
    cleanup: "after-collection", status: "running", description: `UNBOUNDED-TASK-${"x".repeat(64 * 1024)}`,
    reportToken: token, agentName: "missing-agent", worktree: path.join(root, "missing-worktree"),
    repo: path.join(root, "missing-repo"), createdAt: "2025-01-01T00:00:00.000Z",
    baseAdvances: Array.from({ length: 45 }, (_, index) => ({ sequence: index + 1, status: "pending", classification: "compatible" })),
  };
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, tasks: { [record.id]: record } }));
  await writeFile(path.join(reportsDir, `${record.id}.json`), JSON.stringify({
    schemaVersion: 1, taskId: record.id, kind: "scout", lifecycle: "report", token,
    completedAt: "2025-01-02T00:00:00.000Z", payload: { summary: payload, risks: [], openQuestions: [] },
  }));

  const previousState = process.env.CREWDECK_STATE_DIR;
  const previousConfig = process.env.CREWDECK_CONFIG;
  process.env.CREWDECK_STATE_DIR = stateDir;
  process.env.CREWDECK_CONFIG = configPath;
  t.after(() => {
    if (previousState === undefined) delete process.env.CREWDECK_STATE_DIR; else process.env.CREWDECK_STATE_DIR = previousState;
    if (previousConfig === undefined) delete process.env.CREWDECK_CONFIG; else process.env.CREWDECK_CONFIG = previousConfig;
  });
  const tools = [];
  const handlers = {};
  const messages = [];
  const pi = { registerTool(tool) { tools.push(tool); }, registerCommand() {}, on(name, handler) { handlers[name] = handler; }, sendUserMessage(message) { messages.push(message); } };
  const { default: extension } = await import(`${pathToFileURL(path.join(extensionDir, "index.ts"))}?fixture=${Date.now()}`);
  extension(pi);
  return { tools, marker, handlers, messages };
}

function occurrences(text, value) {
  return text.split(value).length - 1;
}

test("merged-base pending announcements chunk at twenty and reconcile across restart", async (t) => {
  const { handlers, messages } = await runtimeFixture(t);
  const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
  await handlers.session_start({}, ctx);
  const first = messages.filter((message) => message.startsWith("CREWDECK BASE ADVANCES"));
  assert.equal(first.length, 3);
  assert.match(first[0], /1-20\/45/);
  assert.match(first[1], /21-40\/45/);
  assert.match(first[2], /41-45\/45/);
  handlers.session_shutdown({}, ctx);

  messages.length = 0;
  await handlers.session_start({}, ctx);
  const restarted = messages.filter((message) => message.startsWith("CREWDECK BASE ADVANCES"));
  assert.equal(restarted.length, 3, "durable pending base advances must be reannounced after restart");
  handlers.session_shutdown({}, ctx);
});

test("completion wake directs collection without a status preflight", async (t) => {
  const { handlers, messages } = await runtimeFixture(t);
  const ctx = { ui: { setStatus() {}, setWidget() {}, notify() {} } };
  await handlers.session_start({}, ctx);
  await new Promise((resolve) => setTimeout(resolve, 25));
  const completion = messages.find((message) => message.startsWith("CREWDECK COMPLETION"));
  assert.ok(completion);
  assert.match(completion, /Call crew_collect_results directly/);
  assert.match(completion, /no crew_status preflight is needed/);
  assert.doesNotMatch(completion, /then crew_collect_results/);
  handlers.session_shutdown({}, ctx);
});

test("real Pi tool boundary keeps completion payload single with token-minimal action status", async (t) => {
  const { tools, marker } = await runtimeFixture(t);
  const status = tools.find((tool) => tool.name === "crew_status");
  const collect = tools.find((tool) => tool.name === "crew_collect_results");
  const ctx = { ui: { setStatus() {} } };

  const diagnosticText = (await status.execute("before", { id: "completed-report", mode: "diagnostic" })).content[0].text;
  const actionText = (await status.execute("after", { id: "completed-report" })).content[0].text;
  const collectedText = (await collect.execute("collect", { ids: ["completed-report"], keepReports: true }, undefined, undefined, ctx)).content[0].text;

  assert.equal(occurrences(actionText, marker), 0);
  assert.equal(occurrences(collectedText, marker), 1);
  assert.equal(occurrences(actionText + collectedText, marker), 1);
  assert.equal(occurrences(diagnosticText + collectedText, marker), 2, "old full-status completion path duplicated the payload");
  assert.ok(!actionText.includes("UNBOUNDED-TASK-"));
  assert.ok(!collectedText.includes("UNBOUNDED-TASK-"));
  assert.ok(!collectedText.includes("reports/completed-report.json"));
  assert.ok(!collectedText.includes("\"token\""));
  const parsed = JSON.parse(collectedText);
  assert.equal(parsed.length, 1);
  assert.deepEqual(Object.keys(parsed[0].task), ["id", "project", "kind", "lifecycle", "workflow", "status", "observedStatus", "cleanup"]);

  assert.ok(Buffer.byteLength(actionText, "utf8") < 500, `action status must stay below 500 bytes: ${Buffer.byteLength(actionText, "utf8")}`);
  assert.equal(actionText.includes("\n"), false, "tool JSON must not be pretty-printed");
  assert.equal(collectedText.includes("\n"), false, "collection JSON must not be pretty-printed");
  const beforeBytes = Buffer.byteLength(diagnosticText + collectedText, "utf8");
  const afterBytes = Buffer.byteLength(actionText + collectedText, "utf8");
  assert.ok(afterBytes < beforeBytes * 0.7, `expected action cycle below 70% of old cycle: ${afterBytes}/${beforeBytes}`);
  console.log(`completion A/B compact UTF-8 bytes: before=${beforeBytes} after=${afterBytes}`);
});
