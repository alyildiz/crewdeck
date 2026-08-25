import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getStatus, spawnBatch } from "../src/core.mjs";

const realGit = execFileSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).trim();

function git(cwd, ...args) {
  return execFileSync(realGit, ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function fixture({ baseRemote = "upstream" } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-fresh-base-"));
  const repo = path.join(root, "primary");
  const remote = path.join(root, "remote.git");
  const publisher = path.join(root, "publisher");
  execFileSync(realGit, ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  await writeFile(path.join(repo, "version.txt"), "local\n");
  git(repo, "add", "version.txt");
  git(repo, "commit", "-qm", "local base");
  execFileSync(realGit, ["clone", "-q", "--bare", repo, remote]);
  git(repo, "remote", "add", "upstream", remote);
  execFileSync(realGit, ["clone", "-q", remote, publisher]);
  git(publisher, "config", "user.email", "test@example.com");
  git(publisher, "config", "user.name", "Test");
  await writeFile(path.join(publisher, "version.txt"), "remote\n");
  git(publisher, "commit", "-qam", "fresh remote base");
  git(publisher, "push", "-q", "origin", "main");

  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "crewdeck.json");
  await writeFile(kindsPath, [
    "version: 1", "kinds:", "  build:", "    lifecycle: change",
    "    description: Integration fixture implementation", "    permissions: { filesystem: write, shell: true }",
    "    tools: [read, bash, edit]", "    skills: []", "    cleanup: after-integration", "",
  ].join("\n"));
  await writeFile(profilesPath, [
    "version: 1", "defaultProfile: worker", "profiles:", "  worker:",
    "    provider: test", "    model: model", "    thinking: medium", "    allowedKinds: [build]", "",
  ].join("\n"));
  await writeFile(configPath, JSON.stringify({
    maxWorkers: 5,
    worktreeRoot: path.join(root, "worktrees"),
    profilesFile: profilesPath,
    kindsFile: kindsPath,
    projects: { demo: { path: repo, base: "main", ...(baseRemote ? { baseRemote } : {}), verify: [] } },
  }));

  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "git"), `#!/usr/bin/env bash\nset -euo pipefail\nif [[ \"\${CREW_FAIL_FETCH:-}\" = 1 && \" $* \" == *\" fetch \"* ]]; then echo controlled-fetch-failure >&2; exit 71; fi\nexec \"$CREW_REAL_GIT\" \"$@\"\n`);
  await writeFile(path.join(bin, "herdr"), `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CREW_HERDR_LOG"
case "$1 $2" in
  "workspace list") printf '{"result":{"workspaces":[{"workspace_id":"source","label":"project:demo","worktree":{"is_linked_worktree":false,"checkout_path":"%s"}}]}}\\n' "$CREW_FIXTURE_REPO" ;;
  "worktree create")
    shift 2; branch= base= target=
    while (($#)); do case "$1" in --branch) branch=$2; shift 2;; --base) base=$2; shift 2;; --path) target=$2; shift 2;; *) shift;; esac; done
    "$CREW_REAL_GIT" -C "$CREW_FIXTURE_REPO" worktree add -q -b "$branch" "$target" "$base"
    safe=\${branch//\//-}
    printf '{"result":{"workspace":{"workspace_id":"ws-%s"},"root_pane":{"pane_id":"pane-%s"},"worktree":{"is_detached":false}}}\\n' "$safe" "$safe" ;;
  "agent get") printf '{"result":{"agent":{"status":"idle"}}}\\n' ;;
  *) printf '{"result":{}}\\n' ;;
esac
`);
  await chmod(path.join(bin, "git"), 0o755);
  await chmod(path.join(bin, "herdr"), 0o755);
  await writeFile(path.join(root, "herdr.log"), "");
  return {
    root, repo, remote, configPath,
    localSha: git(repo, "rev-parse", "main"),
    remoteSha: git(publisher, "rev-parse", "main"),
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HERDR_ENV: "1",
      CREWDECK_STATE_DIR: path.join(root, "state"),
      CREW_FIXTURE_REPO: repo,
      CREW_HERDR_LOG: path.join(root, "herdr.log"),
      CREW_REAL_GIT: realGit,
    },
  };
}

async function withEnv(env, fn) {
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  try { return await fn(); }
  finally {
    for (const key of Object.keys(env)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    delete process.env.CREW_FAIL_FETCH;
  }
}

function primaryProof(repo) {
  return {
    branch: git(repo, "branch", "--show-current"),
    head: git(repo, "rev-parse", "HEAD"),
    main: git(repo, "rev-parse", "main"),
    status: git(repo, "status", "--porcelain"),
    protectedRefs: git(repo, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/main", "refs/remotes", "refs/tags"),
  };
}

function task(id) {
  return { id, kind: "build", task: `Implement integration fixture change for ${id}` };
}

test("stale local base creates remote-configured changes from the fetched exact SHA without mutating primary", async () => {
  const item = await fixture();
  assert.notEqual(item.localSha, item.remoteSha);
  const before = primaryProof(item.repo);
  const [spawned] = await withEnv(item.env, () => spawnBatch(item.configPath, { project: "demo", tasks: [task("fresh-build")] }));
  assert.equal(spawned.ok, true);
  assert.equal(spawned.checkoutHead, item.remoteSha);
  assert.equal(spawned.baseSha, item.remoteSha);
  assert.deepEqual(spawned.baseSource, { mode: "remote", remote: "upstream", ref: "refs/heads/main" });
  assert.equal(git(spawned.worktree, "rev-parse", "HEAD"), item.remoteSha);
  assert.equal(git(spawned.worktree, "branch", "--show-current"), "crew/fresh-build");
  assert.deepEqual(primaryProof(item.repo), before);
  await assert.rejects(() => readFile(path.join(item.repo, ".git", "FETCH_HEAD")));
  const [status] = await withEnv(item.env, () => getStatus(item.configPath, "fresh-build"));
  assert.equal(status.baseSha, item.remoteSha);
  assert.equal(status.git.baseHead, item.remoteSha);
});

test("local-base projects remain compatible and pin the local commit", async () => {
  const item = await fixture({ baseRemote: null });
  const before = primaryProof(item.repo);
  const [spawned] = await withEnv(item.env, () => spawnBatch(item.configPath, { project: "demo", tasks: [task("local-build")] }));
  assert.equal(spawned.ok, true);
  assert.equal(spawned.baseSha, item.localSha);
  assert.deepEqual(spawned.baseSource, { mode: "local", ref: "refs/heads/main" });
  assert.equal(git(spawned.worktree, "rev-parse", "HEAD"), item.localSha);
  assert.deepEqual(primaryProof(item.repo), before);
});

test("configured remote fetch and ref failures fail closed before worktree creation", async (t) => {
  await t.test("fetch failure", async () => {
    const item = await fixture();
    const before = primaryProof(item.repo);
    await assert.rejects(
      () => withEnv({ ...item.env, CREW_FAIL_FETCH: "1" }, () => spawnBatch(item.configPath, { project: "demo", tasks: [task("fetch-fails")] })),
      (error) => error.code === "remote_base_fetch_failed",
    );
    assert.equal((await readFile(item.env.CREW_HERDR_LOG, "utf8")).trim(), "");
    assert.deepEqual(primaryProof(item.repo), before);
  });
  await t.test("missing ref", async () => {
    const item = await fixture();
    const raw = JSON.parse(await readFile(item.configPath, "utf8"));
    raw.projects.demo.base = "absent";
    await writeFile(item.configPath, JSON.stringify(raw));
    await assert.rejects(
      () => withEnv(item.env, () => spawnBatch(item.configPath, { project: "demo", tasks: [task("ref-fails")] })),
      (error) => error.code === "remote_base_ref_unproven",
    );
    assert.equal((await readFile(item.env.CREW_HERDR_LOG, "utf8")).trim(), "");
  });
});

test("a concurrent change batch fetches once and gives every build the same pinned remote SHA", async () => {
  const item = await fixture();
  const results = await withEnv(item.env, () => spawnBatch(item.configPath, {
    project: "demo",
    tasks: [task("parallel-one"), task("parallel-two")],
  }));
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.ok && result.baseSha === item.remoteSha && result.checkoutHead === item.remoteSha));
  assert.equal(results.map((result) => result.worktree).filter((value, index, all) => all.indexOf(value) === index).length, 2);
});
