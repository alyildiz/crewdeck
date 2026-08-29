import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { collectResults } from "../src/core.mjs";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-collection-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stateDir = path.join(root, "state");
  const reports = path.join(stateDir, "reports");
  await mkdir(reports, { recursive: true });
  const kinds = path.join(root, "kinds.yml");
  const profiles = path.join(root, "profiles.yml");
  const config = path.join(root, "crewdeck.json");
  await writeFile(kinds, [
    "version: 1", "kinds:",
    "  scout:", "    lifecycle: report", "    description: Fixture report contract", "    permissions: { filesystem: read-only, shell: false }", "    tools: [read, grep, find, ls]", "    skills: []", "    cleanup: after-collection",
    "  build:", "    lifecycle: change", "    description: Fixture change contract", "    permissions: { filesystem: write, shell: true }", "    tools: [read, grep, find, ls, bash, edit, write]", "    skills: []", "    cleanup: after-integration", "",
  ].join("\n"));
  await writeFile(profiles, ["version: 1", "defaultProfile: worker", "profiles:", "  worker:", "    provider: test", "    model: model", "    thinking: medium", "    allowedKinds: [scout, build]", ""].join("\n"));
  await writeFile(config, JSON.stringify({ maxWorkers: 5, worktreeRoot: path.join(root, "worktrees"), kindsFile: kinds, profilesFile: profiles, projects: {} }));
  const token = "z".repeat(48);
  const tasks = {};
  for (let index = 0; index < 25; index += 1) {
    const id = `report-${String(index).padStart(2, "0")}`;
    tasks[id] = { id, project: "demo", kind: "scout", lifecycle: "report", workflow: "direct", cleanup: "after-collection", status: "running", reportToken: token };
    await writeFile(path.join(reports, `${id}.json`), JSON.stringify({ schemaVersion: 1, taskId: id, kind: "scout", lifecycle: "report", token, payload: { summary: `PAYLOAD-${id}` } }));
  }
  const heads = [1, 2, 3].map((n) => n.toString(16).padStart(40, "0"));
  tasks.build = { id: "build", project: "demo", kind: "build", lifecycle: "change", workflow: "reviewed-pr", cleanup: "after-integration", status: "running", reportToken: token, candidateCollectedVersion: 0 };
  await writeFile(path.join(reports, "build.candidates.json"), JSON.stringify({ schemaVersion: 1, taskId: "build", kind: "build", workflow: "reviewed-pr", token, candidates: heads.map((head, index) => ({ version: index + 1, head, payload: { commit: head, summary: `CANDIDATE-${index + 1}` } })) }));
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, tasks }));
  const previous = process.env.CREWDECK_STATE_DIR;
  process.env.CREWDECK_STATE_DIR = stateDir;
  t.after(() => { if (previous === undefined) delete process.env.CREWDECK_STATE_DIR; else process.env.CREWDECK_STATE_DIR = previous; });
  return config;
}

test("omitted ids paginate at twenty without dropping pending events", async (t) => {
  const config = await fixture(t);
  const first = await collectResults(config, undefined, { cleanupReports: false });
  assert.equal(first.items.length, 20);
  assert.deepEqual(first.pagination, { limit: 20, returned: 20, pendingBefore: 28, remaining: 8, hasMore: true });
  const second = await collectResults(config, undefined, { cleanupReports: false });
  assert.equal(second.items.length, 8);
  assert.equal(second.pagination.remaining, 0);
  assert.equal(new Set([...first.items, ...second.items].map((item) => item.inboxKey)).size, 28);
});

test("reviewed build ids require exact sequential candidate keys and item limits are core-enforced", async (t) => {
  const config = await fixture(t);
  await assert.rejects(() => collectResults(config, ["build"], { cleanupReports: false }), { code: "exact_candidate_key_required" });
  await assert.rejects(() => collectResults(config, ["build@candidate-2"], { cleanupReports: false }), { code: "candidate_sequence_required" });
  await assert.rejects(() => collectResults(config, Array.from({ length: 21 }, (_, index) => `report-${String(index).padStart(2, "0")}`), { cleanupReports: false }), { code: "too_many_inbox_keys" });
  const items = await collectResults(config, ["build@candidate-1", "build@candidate-2", "build@candidate-3"], { cleanupReports: false });
  assert.deepEqual(items.map((item) => item.inboxKey), ["build@candidate-1", "build@candidate-2", "build@candidate-3"]);
  assert.deepEqual(items.map((item) => item.candidate.payload.summary), ["CANDIDATE-1", "CANDIDATE-2", "CANDIDATE-3"]);
});
