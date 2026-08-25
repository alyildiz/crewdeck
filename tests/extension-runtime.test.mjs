import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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
  const lockTool = tools.find((tool) => tool.name === "crew_state_lock");
  const result = await lockTool.execute("call", {}, undefined, undefined, { hasUI: false });
  assert.equal(result.details.status, "unlocked");
});
