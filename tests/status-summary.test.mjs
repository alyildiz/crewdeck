import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { getStatus, getStatusSummary, getStatusView } from "../src/core.mjs";

const TOKEN = "c".repeat(48);
const LARGE_SECRET = `SECRET-LARGE-${"x".repeat(256 * 1024)}`;
const CLI = path.resolve("bin/crewdeck");

function sha(index) {
  return index.toString(16).padStart(40, "0");
}

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "crewdeck-status-summary-"));
  const stateDir = path.join(root, "state");
  const reportsDir = path.join(stateDir, "reports");
  await mkdir(reportsDir, { recursive: true });
  const kindsPath = path.join(root, "kinds.yml");
  const profilesPath = path.join(root, "profiles.yml");
  const configPath = path.join(root, "crewdeck.json");
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

  const candidates = Array.from({ length: 250 }, (_, index) => {
    const head = sha(index + 1);
    return {
      version: index + 1,
      head,
      payload: {
        commit: head,
        diffstat: index === 249 ? LARGE_SECRET : `SECRET-CANDIDATE-PAYLOAD-${index}`,
      },
    };
  });
  const latestHead = candidates.at(-1).head;
  const reviewInbox = Array.from({ length: 250 }, (_, index) => ({
    reviewTaskId: `old-review-${index}`,
    candidateVersion: index + 1,
    reviewedHead: candidates[index].head,
    verdict: "changes-requested",
    summary: index === 0 ? LARGE_SECRET : `SECRET-REVIEW-SUMMARY-${index}`,
    findings: [{ severity: "major", message: `SECRET-FINDING-${index}` }],
    checks: { status: `SECRET-REVIEW-CHECK-${index}` },
    openQuestions: [`SECRET-QUESTION-${index}`],
    forwardStatus: "delivered",
    validAtCollection: true,
  }));
  reviewInbox.push({
    reviewTaskId: "latest-review-a",
    candidateVersion: 250,
    reviewedHead: latestHead,
    verdict: "changes-requested",
    findings: [{ message: "SECRET-OLDER-RELEVANT-FINDING" }],
    forwardStatus: "delivered",
    validAtCollection: true,
  });
  reviewInbox.push({
    reviewTaskId: "latest-review-b",
    candidateVersion: 250,
    reviewedHead: latestHead,
    verdict: "approved",
    summary: "SECRET-LATEST-REVIEW-SUMMARY",
    findings: [{ message: "SECRET-LATEST-REVIEW-FINDING" }],
    forwardStatus: "not-required",
    validAtCollection: true,
  });

  const build = {
    id: "reviewed-build",
    project: "demo",
    kind: "build",
    lifecycle: "change",
    contract: "standard",
    workflow: "reviewed-pr",
    status: "running",
    createdAt: "2025-01-01T00:00:00.000Z",
    description: LARGE_SECRET,
    reportToken: TOKEN,
    worktree: path.join(root, "missing-worktree"),
    repo: path.join(root, "missing-repo"),
    agentName: "reviewed-build-agent",
    baseSha: sha(9000),
    requiredBaseSha: sha(9001),
    maxReviewRounds: 300,
    candidateCollectedVersion: 250,
    reviewInbox,
    reviewRoundDecisions: Array.from({ length: 500 }, (_, index) => ({
      from: index,
      to: index + 1,
      reason: index === 499 ? LARGE_SECRET : `SECRET-ROUND-DECISION-${index}`,
    })),
    reviewEscalation: {
      reviewTaskId: "latest-review-b",
      reviewedHead: latestHead,
      verdict: "approved",
      reason: LARGE_SECRET,
      escalatedAt: "2025-01-02T00:00:00.000Z",
    },
    publication: {
      number: 42,
      url: "https://github.com/demo/repo/pull/42",
      headSha: latestHead,
      title: LARGE_SECRET,
      body: LARGE_SECRET,
      checks: { status: "passed", output: LARGE_SECRET },
      verdictComments: [
        { headSha: sha(1), status: "published", body: LARGE_SECRET },
        { headSha: latestHead, status: "published", body: LARGE_SECRET },
      ],
    },
    prObservation: {
      status: "open",
      observedAt: "2025-01-03T00:00:00.000Z",
      repo: "demo/repo",
      number: 42,
      url: "https://github.com/demo/repo/pull/42",
      headSha: latestHead,
      reason: LARGE_SECRET,
      body: LARGE_SECRET,
      unexpected: LARGE_SECRET,
    },
    prObservationHistory: [
      { status: "lookup-failed", observedAt: "2025-01-01T12:00:00.000Z", reason: LARGE_SECRET },
      ...Array.from({ length: 500 }, (_, index) => ({
        status: "open",
        observedAt: `2025-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
        reason: `SECRET-OBSERVATION-HISTORY-${index}`,
      })),
    ],
    mergeReconciliation: {
      status: "cleanup-pending",
      operationId: "op-1",
      evidence: { marker: LARGE_SECRET },
      lastError: LARGE_SECRET,
    },
    baseAdvances: Array.from({ length: 400 }, (_, index) => ({
      sequence: index + 1,
      status: "settled",
      classification: "compatible",
      priorBaseSha: sha(7000 + index),
      newBaseSha: sha(7001 + index),
      sourceTaskId: `source-${index}`,
      reason: index === 399 ? LARGE_SECRET : `SECRET-BASE-REASON-${index}`,
      evidence: { secret: `SECRET-BASE-EVIDENCE-${index}` },
    })),
  };

  const abandonedPending = {
    id: "abandoned-pending",
    project: "demo",
    kind: "build",
    lifecycle: "change",
    workflow: "direct",
    status: "abandoned",
    abandonedAt: "2025-01-04T00:00:00.000Z",
    abandonmentReason: LARGE_SECRET,
    reportToken: TOKEN,
    worktree: path.join(root, "missing-abandoned-worktree"),
    repo: path.join(root, "missing-repo"),
    agentName: "abandoned-pending-agent",
    baseSha: sha(1),
  };

  const tasks = { "reviewed-build": build, "abandoned-pending": abandonedPending };
  const terminalStatuses = ["cleaned", "orphan-reconciled", "retired", "pr-merged", "abandoned"];
  for (let index = 0; index < 65; index += 1) {
    const id = `history-${String(index).padStart(3, "0")}`;
    const status = terminalStatuses[index % terminalStatuses.length];
    tasks[id] = {
      id,
      project: "demo",
      kind: index % 2 ? "build" : "scout",
      lifecycle: index % 2 ? "change" : "report",
      status,
      cleanedAt: `2024-01-${String((index % 28) + 1).padStart(2, "0")}T00:00:00.000Z`,
      description: `SECRET-TERMINAL-DESCRIPTION-${index}`,
      reportToken: TOKEN,
      worktree: path.join(root, `missing-${id}`),
      repo: path.join(root, "missing-repo"),
      agentName: `${id}-agent`,
      reviewInbox: Array.from({ length: 100 }, (_, reviewIndex) => ({ findings: [`SECRET-TERMINAL-FINDING-${reviewIndex}`] })),
      prObservationHistory: Array.from({ length: 100 }, (_, observationIndex) => ({ reason: `SECRET-TERMINAL-HISTORY-${observationIndex}` })),
    };
  }
  tasks["old-scout"] = {
    id: "old-scout",
    project: "demo",
    kind: "scout",
    lifecycle: "report",
    status: "cleaned",
    cleanedAt: "2025-01-05T00:00:00.000Z",
    reportToken: TOKEN,
    description: LARGE_SECRET,
  };
  tasks["merged-malformed"] = {
    id: "merged-malformed",
    project: "demo",
    kind: "build",
    lifecycle: "change",
    workflow: "reviewed-pr",
    status: "pr-merged",
    prMergedAt: "2025-01-06T00:00:00.000Z",
    mergedReconciledAt: "2025-01-06T01:00:00.000Z",
    reportToken: TOKEN,
  };

  const statePath = path.join(stateDir, "state.json");
  const state = { version: 1, tasks };
  await writeFile(statePath, JSON.stringify(state));
  await writeFile(
    path.join(reportsDir, "reviewed-build.json"),
    JSON.stringify({
      schemaVersion: 1,
      taskId: "reviewed-build",
      kind: "build",
      lifecycle: "change",
      token: TOKEN,
      payload: { commit: latestHead, summary: LARGE_SECRET },
    }),
  );
  const candidatesPath = path.join(reportsDir, "reviewed-build.candidates.json");
  await writeFile(candidatesPath, JSON.stringify({
    schemaVersion: 1,
    taskId: "reviewed-build",
    kind: "build",
    workflow: "reviewed-pr",
    token: TOKEN,
    candidates,
  }));
  // Terminal summary code must not depend on these malformed payload journals.
  await writeFile(path.join(reportsDir, "old-scout.json"), `{"payload":"TERMINAL-PAYLOAD-SECRET"`);
  await writeFile(path.join(reportsDir, "merged-malformed.candidates.json"), `{"payload":"TERMINAL-CANDIDATE-SECRET"`);

  const historyIds = Object.values(tasks)
    .filter((record) => ["cleaned", "orphan-reconciled", "retired", "pr-merged"].includes(record.status) ||
      (record.status === "abandoned" && record.cleanedAt))
    .map((record) => record.id)
    .sort();
  return { root, stateDir, statePath, state, configPath, reportsDir, candidatesPath, candidates, historyIds };
}

function withStateDir(stateDir, fn) {
  const previous = process.env.CREWDECK_STATE_DIR;
  process.env.CREWDECK_STATE_DIR = stateDir;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (previous === undefined) delete process.env.CREWDECK_STATE_DIR;
      else process.env.CREWDECK_STATE_DIR = previous;
    });
}

test("default summary is a bounded active/actionable page", async () => {
  const { stateDir, configPath } = await fixture();
  await withStateDir(stateDir, async () => {
    const page = await getStatusSummary(configPath);
    assert.equal(page.scope, "active");
    assert.equal(page.pagination.cursor, null);
    assert.equal(page.pagination.limit, 20);
    assert.equal(page.pagination.returned, 2);
    assert.equal(page.pagination.total, 2);
    assert.equal(page.pagination.nextCursor, null);
    assert.match(page.pagination.generation, /^[0-9a-f]{16}$/);
    assert.deepEqual(page.tasks.map((item) => item.id), ["abandoned-pending", "reviewed-build"]);
    assert.equal(page.tasks[0].observedStatus, "abandon-cleanup-pending");
    assert.ok(!page.tasks.some((item) => item.id.startsWith("history-") || item.id === "old-scout"));
  });
});

test("history and all scopes paginate deterministically with bounded metadata", async () => {
  const { stateDir, configPath, historyIds } = await fixture();
  await withStateDir(stateDir, async () => {
    const first = await getStatusSummary(configPath, { scope: "history", limit: 7, cursor: 0 });
    const second = await getStatusSummary(configPath, { scope: "history", limit: 7, cursor: first.pagination.nextCursor });
    assert.deepEqual(first.tasks.map((item) => item.id), historyIds.slice(0, 7));
    assert.deepEqual(second.tasks.map((item) => item.id), historyIds.slice(7, 14));
    assert.equal(first.pagination.returned, 7);
    assert.equal(first.pagination.total, historyIds.length);
    assert.equal(first.pagination.cursor, null);
    assert.equal(typeof first.pagination.nextCursor, "string");
    assert.equal(second.pagination.cursor, first.pagination.nextCursor);
    assert.equal(second.pagination.returned, 7);
    assert.equal(second.pagination.total, historyIds.length);
    assert.equal(typeof second.pagination.nextCursor, "string");

    const maxPage = await getStatusSummary(configPath, { scope: "all", limit: 50, cursor: 0 });
    assert.equal(maxPage.pagination.returned, 50);
    assert.equal(maxPage.pagination.total, historyIds.length + 2);
    assert.equal(typeof maxPage.pagination.nextCursor, "string");
    const tail = await getStatusSummary(configPath, { scope: "all", limit: 50, cursor: 50 });
    assert.equal(tail.pagination.returned, historyIds.length + 2 - 50);
    assert.equal(tail.pagination.nextCursor, null);
    const beyond = await getStatusSummary(configPath, { scope: "history", limit: 10, cursor: 10_000 });
    assert.equal(beyond.pagination.cursor, 10_000);
    assert.equal(beyond.pagination.returned, 0);
    assert.equal(beyond.pagination.total, historyIds.length);
    assert.equal(beyond.pagination.nextCursor, null);
  });
});

test("generation cursor fails visibly after task creation or scope transition", async () => {
  const { stateDir, statePath, state, configPath } = await fixture();
  await withStateDir(stateDir, async () => {
    const first = await getStatusSummary(configPath, { scope: "all", limit: 5 });
    state.tasks["created-between-pages"] = {
      id: "created-between-pages", project: "demo", kind: "scout", lifecycle: "report", status: "cleaned", cleanedAt: "2025-02-01T00:00:00.000Z",
    };
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(
      () => getStatusSummary(configPath, { scope: "all", limit: 5, cursor: first.pagination.nextCursor }),
      { code: "invalid_status_cursor" },
    );

    const active = await getStatusSummary(configPath, { scope: "active", limit: 1 });
    state.tasks[active.tasks[0].id].status = "cleaned";
    state.tasks[active.tasks[0].id].cleanedAt = "2025-02-02T00:00:00.000Z";
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(
      () => getStatusSummary(configPath, { scope: "active", limit: 1, cursor: active.pagination.nextCursor }),
      { code: "invalid_status_cursor" },
    );
  });
});

test("summary validates scope, maximum limit, and cursor", async () => {
  const { stateDir, configPath } = await fixture();
  await withStateDir(stateDir, async () => {
    await assert.rejects(() => getStatusSummary(configPath, { scope: "secret" }), { code: "invalid_status_scope" });
    await assert.rejects(() => getStatusSummary(configPath, { limit: 0 }), { code: "invalid_status_limit" });
    await assert.rejects(() => getStatusSummary(configPath, { limit: 51 }), { code: "invalid_status_limit" });
    await assert.rejects(() => getStatusSummary(configPath, { cursor: -1 }), { code: "invalid_status_cursor" });
    await assert.rejects(() => getStatusSummary(configPath, { cursor: 1.5 }), { code: "invalid_status_cursor" });
    await assert.rejects(() => getStatusView(configPath, { id: "reviewed-build", limit: 1 }), { code: "invalid_status_arguments" });
    await assert.rejects(() => getStatusView(configPath, { mode: "diagnostic", scope: "active" }), { code: "invalid_status_arguments" });
    await assert.rejects(() => getStatusView(configPath, { mode: "verbose" }), { code: "invalid_status_mode" });
  });
});

test("active records expose latest-only candidate/review counts and explicit PR observation projection", async () => {
  const { stateDir, configPath, candidatesPath } = await fixture();
  await withStateDir(stateDir, async () => {
    const page = await getStatusSummary(configPath);
    const build = page.tasks.find((item) => item.id === "reviewed-build");
    assert.equal(build.observedStatus, "merge-cleanup-pending");
    assert.equal(build.nextAction, "confirm review-round extension or decide escalation");
    assert.equal(build.reviewRound, 250);
    assert.equal(build.currentMaxReviewRounds, 300);
    assert.equal(build.verdictState, "published");
    assert.equal(build.checkState, "passed");
    assert.equal(build.observerState, "open");
    assert.deepEqual(build.candidates, {
      available: true,
      ref: "candidates:reviewed-build",
      state: "available",
      count: 250,
      latest: { version: 250, head: sha(250) },
    });
    assert.deepEqual(build.reviews, {
      count: 252,
      relevantCount: 3,
      latest: {
        reviewTaskId: "latest-review-b",
        candidateVersion: 250,
        reviewedHead: sha(250),
        verdict: "approved",
        forwardStatus: "not-required",
        validAtCollection: true,
      },
    });
    assert.deepEqual(build.prObservation, {
      status: "open",
      observedAt: "2025-01-03T00:00:00.000Z",
      repo: "demo/repo",
    });
    assert.deepEqual(build.pr, { number: 42, url: "https://github.com/demo/repo/pull/42", headSha: sha(250), state: "open" });
    assert.equal(build.baseAdvanceState.sequence, 400);
    assert.equal(build.baseAdvanceState.status, "settled");
    assert.deepEqual(build.mergeReconciliation, { status: "cleanup-pending", error: "[redacted-token]" });
    assert.ok(!Object.values(build).some(Array.isArray), "a summary record must not contain an unbounded array");
  });
});

test("adversarial payloads never leak and serialized output stays bounded as journals grow", async () => {
  const { stateDir, statePath, state, configPath, candidatesPath, candidates } = await fixture();
  await withStateDir(stateDir, async () => {
    const before = await getStatusSummary(configPath);
    const beforeSerialized = JSON.stringify(before);
    for (const secret of [
      "SECRET-LARGE-",
      "SECRET-CANDIDATE-PAYLOAD-",
      "SECRET-REVIEW-SUMMARY-",
      "SECRET-FINDING-",
      "SECRET-QUESTION-",
      "SECRET-REVIEW-CHECK-",
      "SECRET-LATEST-REVIEW",
      "SECRET-ROUND-DECISION-",
      "SECRET-OBSERVATION-HISTORY-",
      "SECRET-BASE-REASON-",
    ]) assert.ok(!beforeSerialized.includes(secret), `summary must not contain ${secret}`);
    assert.ok(Buffer.byteLength(beforeSerialized) < 12_000, "active page must remain compact");

    const build = state.tasks["reviewed-build"];
    for (let index = candidates.length + 1; index <= 1000; index += 1) {
      const head = sha(index);
      candidates.push({ version: index, head, payload: { commit: head, diffstat: `SECRET-GROWN-CANDIDATE-${index}` } });
      build.reviewInbox.push({
        reviewTaskId: `grown-review-${index}`,
        candidateVersion: index,
        reviewedHead: head,
        verdict: "approved",
        findings: [{ message: `SECRET-GROWN-FINDING-${index}` }],
        validAtCollection: true,
      });
      build.prObservationHistory.push({ status: "open", reason: `SECRET-GROWN-HISTORY-${index}` });
    }
    const latestHead = sha(1000);
    build.candidateCollectedVersion = 1000;
    build.publication.headSha = latestHead;
    build.publication.verdictComments.push({ headSha: latestHead, status: "published", body: LARGE_SECRET });
    build.prObservation.headSha = latestHead;
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(candidatesPath, JSON.stringify({
      schemaVersion: 1,
      taskId: "reviewed-build",
      kind: "build",
      workflow: "reviewed-pr",
      token: TOKEN,
      candidates,
    }));

    const after = await getStatusSummary(configPath);
    const afterSerialized = JSON.stringify(after);
    const summarizedBuild = after.tasks.find((item) => item.id === "reviewed-build");
    assert.equal(summarizedBuild.candidates.count, 1000);
    assert.equal(summarizedBuild.candidates.latest.version, 1000);
    assert.equal(summarizedBuild.reviews.count, 1002);
    assert.ok(!afterSerialized.includes("SECRET-GROWN-"));
    assert.ok(!afterSerialized.includes("SECRET-LARGE-"));
    assert.ok(Buffer.byteLength(afterSerialized) < 12_000, "journal growth must not grow the serialized page");
    assert.ok(Math.abs(Buffer.byteLength(afterSerialized) - Buffer.byteLength(beforeSerialized)) < 256);
  });
});

test("indented JSON for 20 and 50 maximally populated Unicode active summaries stays under 128 KiB", async () => {
  const { stateDir, statePath, state, configPath, reportsDir } = await fixture();
  const tasks = {};
  for (let index = 0; index < 50; index += 1) {
    const id = `max-active-${String(index).padStart(2, "0")}`;
    tasks[id] = {
      id, project: `é🙂\\\"${"界".repeat(120)}`, kind: "build", lifecycle: "change", workflow: "direct",
      cleanup: "after-integration", status: "abandoned", abandonedAt: "2025-01-01T00:00:00.000Z",
      abandonmentReason: LARGE_SECRET, reportToken: TOKEN, agentName: `${id}-agent`,
      worktree: `/missing/${id}`, repo: `/missing/repo/${id}`, baseSha: sha(index + 1),
      publication: { number: index + 1, url: `https://example.invalid/${"é🙂%22".repeat(60)}`, headSha: sha(index + 1), checks: { status: "failed" } },
      prObservation: { status: "lookup-failed", observedAt: "2025-01-02T00:00:00.000Z", repo: "demo/repo", number: index + 1, url: `https://example.invalid/${"界".repeat(120)}`, headSha: sha(index + 1) },
      mergeReconciliation: { status: "cleanup-failed", lastError: LARGE_SECRET, code: "cleanup_failed" },
      baseAdvances: [{ sequence: 1, status: "pending", classification: "unknown", priorBaseSha: sha(index + 1), newBaseSha: sha(index + 2), sourceTaskId: "source-task" }],
    };
    await writeFile(path.join(reportsDir, `${id}.json`), JSON.stringify({ schemaVersion: 1, taskId: id, kind: "build", lifecycle: "change", token: TOKEN, payload: { commit: sha(index + 1), summary: LARGE_SECRET } }));
  }
  state.tasks = tasks;
  await writeFile(statePath, JSON.stringify(state));
  await withStateDir(stateDir, async () => {
    for (const limit of [20, 50]) {
      const page = await getStatusSummary(configPath, { scope: "active", limit });
      const text = JSON.stringify(page, null, 2);
      const bytes = Buffer.byteLength(text, "utf8");
      assert.equal(page.tasks.length, limit);
      assert.ok(text.includes("é🙂"));
      assert.ok(text.includes("\\\\\\\""), "escaped backslash/quote must be measured at the serialized boundary");
      assert.ok(bytes <= 128 * 1024, `${limit}-item page is ${bytes} bytes`);
      console.log(`status budget: items=${limit} indentedUtf8Bytes=${bytes}`);
    }
  });
});

test("terminal summaries stay compact without reading payload journals or live resources", async () => {
  const { stateDir, configPath, reportsDir } = await fixture();
  const candidatePath = path.join(reportsDir, "merged-malformed.candidates.json");
  await rm(candidatePath);
  const fifo = spawnSync("mkfifo", [candidatePath], { encoding: "utf8" });
  assert.equal(fifo.status, 0, fifo.stderr);
  const result = spawnSync(
    process.execPath,
    [CLI, "status", "--summary", "--scope", "history", "--limit", "50", "--cursor", "50"],
    {
      env: { ...process.env, CREWDECK_STATE_DIR: stateDir, CREWDECK_CONFIG: configPath },
      encoding: "utf8",
      timeout: 2_000,
    },
  );
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  const page = JSON.parse(result.stdout);
  const oldScout = page.tasks.find((item) => item.id === "old-scout");
  const merged = page.tasks.find((item) => item.id === "merged-malformed");
  assert.deepEqual(oldScout, {
    id: "old-scout",
    project: "demo",
    kind: "scout",
    status: "cleaned",
    observedStatus: "cleaned",
    terminalAt: "2025-01-05T00:00:00.000Z",
    result: { ref: "result:old-scout" },
  });
  assert.deepEqual(merged, {
    id: "merged-malformed",
    project: "demo",
    kind: "build",
    status: "pr-merged",
    observedStatus: "pr-merged",
    terminalAt: "2025-01-06T01:00:00.000Z",
    remotePrMergedAt: "2025-01-06T00:00:00.000Z",
    candidates: { ref: "candidates:merged-malformed" },
  });
  const serialized = JSON.stringify(page);
  assert.ok(!serialized.includes("TERMINAL-PAYLOAD-SECRET"));
  assert.ok(!serialized.includes("TERMINAL-CANDIDATE-SECRET"));
});

test("full status with an id remains the durable diagnostic record", async () => {
  const { stateDir, configPath, reportsDir } = await fixture();
  await withStateDir(stateDir, async () => {
    const full = await getStatus(configPath, "reviewed-build");
    assert.equal(full.length, 1);
    const record = full[0];
    assert.ok(record.description.startsWith("SECRET-LARGE-"));
    assert.equal(record.reviewInbox.length, 252);
    assert.equal(record.reviewInbox[0].findings[0].message, "SECRET-FINDING-0");
    assert.ok(record.publication.body.startsWith("SECRET-LARGE-"));
    assert.equal(record.prObservationHistory.length, 501);
    assert.equal(record.reviewRoundDecisions.length, 500);
    assert.ok(record.mergeReconciliation.evidence.marker.startsWith("SECRET-LARGE-"));
    assert.ok(record.result.report.payload.summary.startsWith("SECRET-LARGE-"));
    assert.equal(record.result.ref, "result:reviewed-build");
    assert.equal(record.result.path, undefined);
    assert.equal(record.candidates.journal.candidates.length, 250);
    assert.ok(record.candidates.journal.candidates.at(-1).payload.diffstat.startsWith("SECRET-LARGE-"));
    assert.equal(record.reportToken, undefined);
    assert.equal(record.baseAdvanceState.sequence, 400);
  });
});

test("default action projection omits operational detail and stays below 500 bytes per task", async () => {
  const { stateDir, configPath } = await fixture();
  await withStateDir(stateDir, async () => {
    const page = await getStatusView(configPath, { mode: "action" });
    assert.equal(page.scope, "active");
    assert.equal(page.total, 2);
    assert.deepEqual(page.tasks.map((item) => item.id), ["abandoned-pending", "reviewed-build"]);
    const build = page.tasks.find((item) => item.id === "reviewed-build");
    assert.deepEqual(build, {
      id: "reviewed-build",
      project: "demo",
      state: "merge-cleanup-pending",
      action: "resolve-review-escalation",
      round: "250/300",
      pr: { number: 42, state: "open" },
    });
    assert.equal(build.nextAction, undefined);
    assert.equal(build.git, undefined);
    assert.equal(build.agent, undefined);
    assert.equal(build.reviews, undefined);
    for (const task of page.tasks) {
      assert.ok(Buffer.byteLength(JSON.stringify(task), "utf8") < 500, `${task.id} action projection exceeds 500 bytes`);
    }
  });
});

test("action status stays minimal while detail and diagnostics remain explicit", async () => {
  const { stateDir, configPath, historyIds } = await fixture();
  const env = { ...process.env, CREWDECK_STATE_DIR: stateDir, CREWDECK_CONFIG: configPath };
  const pageResult = spawnSync(process.execPath, [CLI, "status", "--summary", "--scope", "history", "--limit", "3", "--cursor", "2"], {
    env,
    encoding: "utf8",
  });
  assert.equal(pageResult.status, 0, pageResult.stderr);
  const page = JSON.parse(pageResult.stdout);
  assert.deepEqual(page.tasks.map((item) => item.id), historyIds.slice(2, 5));
  assert.equal(page.pagination.cursor, 2);
  assert.equal(page.pagination.limit, 3);
  assert.equal(page.pagination.returned, 3);
  assert.equal(page.pagination.total, historyIds.length);
  assert.equal(typeof page.pagination.nextCursor, "string");

  const invalid = spawnSync(process.execPath, [CLI, "status", "--summary", "--limit", "51"], { env, encoding: "utf8" });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stderr).code, "invalid_status_limit");

  const action = spawnSync(process.execPath, [CLI, "status", "old-scout"], { env, encoding: "utf8" });
  assert.equal(action.status, 0, action.stderr);
  assert.deepEqual(JSON.parse(action.stdout), { id: "old-scout", project: "demo", state: "cleaned", action: "inspect" });
  assert.ok(Buffer.byteLength(action.stdout, "utf8") < 500);
  assert.ok(!action.stdout.includes("SECRET-LARGE-"));

  const detail = spawnSync(process.execPath, [CLI, "status", "--detail", "old-scout"], { env, encoding: "utf8" });
  assert.equal(detail.status, 0, detail.stderr);
  assert.equal(JSON.parse(detail.stdout).observedStatus, "cleaned");

  const full = spawnSync(process.execPath, [CLI, "status", "--diagnostic", "old-scout"], { env, encoding: "utf8" });
  assert.equal(full.status, 0, full.stderr);
  const record = JSON.parse(full.stdout)[0];
  assert.equal(record.description.startsWith("SECRET-LARGE-"), true);
});
