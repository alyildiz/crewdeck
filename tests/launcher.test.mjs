import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "bin/crewdeck-pi");

test("orchestrator launcher disables discovery and loads only the Crewdeck skill", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "crewdeck-launcher-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const output = path.join(directory, "args.txt");
  const fakePi = path.join(directory, "pi");
  await writeFile(fakePi, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > ${JSON.stringify(output)}\n`);
  await chmod(fakePi, 0o755);

  await execFileAsync(launcher, ["--thinking", "high"], {
    env: { ...process.env, PI_BIN: fakePi },
  });
  const args = (await readFile(output, "utf8")).trim().split("\n");
  assert.deepEqual(args, [
    "--no-skills",
    "--skill",
    path.join(root, ".agents/skills/crewdeck/SKILL.md"),
    "--thinking",
    "high",
  ]);
});

test("orchestrator launcher refuses additional skills", async () => {
  await assert.rejects(
    () => execFileAsync(launcher, ["--skill", "/tmp/unapproved-skill"]),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /additional skills are disabled/);
      return true;
    },
  );
});
