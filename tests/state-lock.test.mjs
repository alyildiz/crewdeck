import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { recoverStateLock, stateLockStatus, withStateLock } from "../src/core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "crewdeck");

async function waitFor(check, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("timed out waiting for process-level lock fixture");
}

test("state lock proves its active owner and safely recovers after the holder is killed", { concurrency: false }, async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "crewdeck-lock-"));
  t.after(async () => {
    delete process.env.CREWDECK_STATE_DIR;
    await rm(stateDir, { recursive: true, force: true });
  });
  process.env.CREWDECK_STATE_DIR = stateDir;
  const script = `import { withStateLock } from ${JSON.stringify(path.join(root, "src/core.mjs"))}; await withStateLock(() => new Promise(() => setInterval(() => {}, 1000)));`;
  const holder = spawn(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, CREWDECK_STATE_DIR: stateDir }, stdio: "ignore",
  });
  t.after(() => { try { holder.kill("SIGKILL"); } catch {} });
  await waitFor(async () => (await stateLockStatus()).status === "active");
  const active = await stateLockStatus();
  assert.equal(active.owner.pid, holder.pid);
  await assert.rejects(() => recoverStateLock({ reason: "must not steal live holder" }), (error) => error.code === "active_state_lock");

  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  await new Promise((resolve) => setTimeout(resolve, 2_100));
  assert.equal((await stateLockStatus()).status, "dead");
  assert.equal(await withStateLock(async () => "recovered"), "recovered");
  assert.equal((await stateLockStatus()).status, "unlocked");
  assert.equal(JSON.parse(await readFile(path.join(stateDir, "last-lock-recovery.json"), "utf8")).reason, "automatic-dead-owner-proof");
});

test("malformed stale locks require confirmed, reason-durable operator recovery", { concurrency: false }, async (t) => {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), "crewdeck-lock-malformed-"));
  t.after(() => rm(stateDir, { recursive: true, force: true }));
  const lock = path.join(stateDir, ".lock");
  await mkdir(lock);
  await writeFile(path.join(lock, "owner.json"), "not-json\n");
  const old = new Date(Date.now() - 10_000);
  await utimes(lock, old, old);
  const env = { ...process.env, CREWDECK_STATE_DIR: stateDir };
  let result;
  try { execFileSync(cli, ["recover-lock", "--reason", "interrupted owner write"], { env, encoding: "utf8", stdio: "pipe" }); }
  catch (error) { result = error; }
  assert.equal(result?.status, 1);
  const output = execFileSync(cli, ["recover-lock", "--confirm", "--reason", "interrupted owner write"], { env, encoding: "utf8" });
  assert.equal(JSON.parse(output).recovered, true);
  const audit = JSON.parse(await readFile(path.join(stateDir, "last-lock-recovery.json"), "utf8"));
  assert.equal(audit.reason, "interrupted owner write");
});
