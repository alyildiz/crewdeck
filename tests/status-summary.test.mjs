import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getStatus, getStatusSummary } from "../src/core.mjs";

const SHA1 = "a".repeat(40);
const TOKEN = "c".repeat(48);

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
  const build = {
    id: "reviewed-build",
    project: "demo",
    kind: "build",
    lifecycle: "change",
    contract: "standard",
    workflow: "reviewed-pr",
    status: "running",
    description: "SECRET-DESCRIPTION must never appear in the summary",
    reportToken: TOKEN,
    worktree: path.join(root, "missing-worktree"),
    repo: path.join(root, "missing-repo"),
    agentName: "reviewed-build-agent",
    baseSha: SHA1,
    maxReviewRounds: 3,
    candidateCollectedVersion: 1,
    reviewInbox: [
      {
        reviewTaskId: "reviewed-build-r1",
        candidateVersion: 1,
        reviewedHead: SHA1,
        verdict: "changes-requested",
        summary: "SECRET-REVIEW-SUMMARY",
        findings: [{ severity: "major", message: "SECRET-FINDING" }],
        checks: { status: "SECRET-CHECKS" },
        openQuestions: ["SECRET-QUESTION"],
        forwardStatus: "delivered",
        forwardedAt: "2025-01-01T00:00:00.000Z",
        validAtCollection: true,
      },
    ],
    reviewRoundDecisions: [{ from: 3, to: 4, reason: "SECRET-DECISION", decidedAt: "2025-01-01T01:00:00.000Z" }],
    publication: {
      number: 42,
      url: "https://github.com/demo/repo/pull/42",
      headSha: SHA1,
      title: "Draft",
      body: "SECRET-PR-BODY",
      checks: { status: "passed" },
      verdictComments: [{ headSha: SHA1, status: "published", body: "SECRET-VERDICT" }],
    },
    prObservation: {
      status: "open",
      observedAt: "2025-01-02T00:00:00.000Z",
      number: 42,
      url: "https://github.com/demo/repo/pull/42",
      headSha: SHA1,
    },
    prObservationHistory: [
      { status: "lookup-failed", observedAt: "2025-01-01T12:00:00.000Z", reason: "SECRET-HISTORY" },
      {
        status: "open",
        observedAt: "2025-01-02T00:00:00.000Z",
        number: 42,
        url: "https://github.com/demo/repo/pull/42",
        headSha: SHA1,
      },
    ],
    mergeReconciliation: {
      status: "cleanup-pending",
      operationId: "op-1",
      evidence: { marker: "SECRET-EVIDENCE" },
      lastError: "SECRET-ERROR",
    },
  };
  const scout = {
    id: "old-scout",
    project: "demo",
    kind: "scout",
    lifecycle: "report",
    status: "cleaned",
    cleanedAt: "2025-01-03T00:00:00.000Z",
    description: "SECRET-TERMINAL-DESCRIPTION",
    reportToken: TOKEN,
    worktree: path.join(root, "missing-scout-worktree"),
    repo: path.join(root, "missing-repo"),
    agentName: "old-scout-agent",
  };
  await writeFile(path.join(stateDir, "state.json"), JSON.stringify({ version: 1, tasks: { "reviewed-build": build, "old-scout": scout } }));
  await writeFile(
    path.join(reportsDir, "reviewed-build.json"),
    JSON.stringify({
      schemaVersion: 1,
      taskId: "reviewed-build",
      kind: "build",
      lifecycle: "change",
      token: TOKEN,
      payload: { commit: SHA1, summary: "SECRET-REPORT-PAYLOAD" },
    }),
  );
  await writeFile(
    path.join(reportsDir, "reviewed-build.candidates.json"),
    JSON.stringify({
      schemaVersion: 1,
      taskId: "reviewed-build",
      kind: "build",
      workflow: "reviewed-pr",
      token: TOKEN,
      candidates: [{ version: 1, head: SHA1, payload: { commit: SHA1, diffstat: "SECRET-DIFFSTAT" } }],
    }),
  );
  return { root, stateDir, configPath, reportsDir };
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

test("status summary excludes report payloads, review findings, PR bodies, raw agent, and observation history", async () => {
  const { stateDir, configPath } = await fixture();
  await withStateDir(stateDir, async () => {
    const summary = await getStatusSummary(configPath);
    assert.equal(summary.length, 2);
    const serialized = JSON.stringify(summary);
    for (const secret of [
      "SECRET-DESCRIPTION",
      "SECRET-REVIEW-SUMMARY",
      "SECRET-FINDING",
      "SECRET-QUESTION",
      "SECRET-CHECKS",
      "SECRET-REPORT-PAYLOAD",
      "SECRET-DIFFSTAT",
      "SECRET-PR-BODY",
      "SECRET-VERDICT",
      "SECRET-HISTORY",
      "SECRET-DECISION",
      "SECRET-EVIDENCE",
      "SECRET-ERROR",
      "SECRET-TERMINAL-DESCRIPTION",
    ]) assert.ok(!serialized.includes(secret), `summary must not contain ${secret}`);
    const build = summary.find((item) => item.id === "reviewed-build");
    assert.equal(build.description, undefined);
    assert.equal(build.prObservationHistory, undefined);
    assert.equal(build.reviewRoundDecisions, undefined);
    assert.equal(build.agent.raw, undefined);
    assert.equal(build.result.report, undefined);
    assert.equal(build.candidates.journal, undefined);
    assert.equal(build.publication.body, undefined);
    assert.equal(build.publication.verdictComments, undefined);
    assert.equal(build.publication.title, undefined);
    assert.equal(build.reviewInbox[0].findings, undefined);
    assert.equal(build.reviewInbox[0].summary, undefined);
    assert.equal(build.reviewInbox[0].checks, undefined);
    assert.equal(build.reviewInbox[0].openQuestions, undefined);
    assert.equal(build.mergeReconciliation.evidence, undefined);
    assert.equal(build.mergeReconciliation.lastError, undefined);
  });
});

test("status summary keeps every orchestration loop field", async () => {
  const { stateDir, configPath, reportsDir } = await fixture();
  await withStateDir(stateDir, async () => {
    const summary = await getStatusSummary(configPath);
    const build = summary.find((item) => item.id === "reviewed-build");
    assert.equal(build.project, "demo");
    assert.equal(build.kind, "build");
    assert.equal(build.workflow, "reviewed-pr");
    assert.equal(build.status, "running");
    assert.equal(build.observedStatus, "merge-cleanup-pending");
    assert.equal(build.nextAction, "observe external PR; reconciliation remains confirmed");
    assert.equal(build.reviewRound, 1);
    assert.equal(build.currentMaxReviewRounds, 3);
    assert.equal(build.verdictState, "published");
    assert.equal(build.checkState, "passed");
    assert.equal(build.observerState, "open");
    assert.deepEqual(build.pr, { number: 42, url: "https://github.com/demo/repo/pull/42", state: "open" });
    assert.equal(typeof build.agent.available, "boolean");
    assert.equal(typeof build.agent.state, "string");
    assert.deepEqual(build.git, { available: false });
    assert.deepEqual(build.result, { available: true, path: path.join(reportsDir, "reviewed-build.json"), state: "available" });
    assert.deepEqual(build.candidates, {
      available: true,
      path: path.join(reportsDir, "reviewed-build.candidates.json"),
      versions: [{ version: 1, head: SHA1 }],
    });
    assert.deepEqual(build.publication, { number: 42, url: "https://github.com/demo/repo/pull/42", headSha: SHA1 });
    assert.deepEqual(build.reviewInbox, [
      { reviewTaskId: "reviewed-build-r1", candidateVersion: 1, reviewedHead: SHA1, verdict: "changes-requested", forwardStatus: "delivered" },
    ]);
    assert.deepEqual(build.mergeReconciliation, { status: "cleanup-pending" });
    assert.deepEqual(build.prObservation, {
      status: "open",
      observedAt: "2025-01-02T00:00:00.000Z",
      number: 42,
      url: "https://github.com/demo/repo/pull/42",
      headSha: SHA1,
    });
  });
});

test("status summary renders terminal tasks as one compact line", async () => {
  const { stateDir, configPath } = await fixture();
  await withStateDir(stateDir, async () => {
    const summary = await getStatusSummary(configPath);
    assert.deepEqual(
      summary.find((item) => item.id === "old-scout"),
      {
        id: "old-scout",
        project: "demo",
        kind: "scout",
        status: "cleaned",
        observedStatus: "cleaned",
        terminalAt: "2025-01-03T00:00:00.000Z",
      },
    );
  });
});

test("full status with an id is unchanged (non-regression)", async () => {
  const { stateDir, configPath, reportsDir } = await fixture();
  await withStateDir(stateDir, async () => {
    const full = await getStatus(configPath, "reviewed-build");
    assert.equal(full.length, 1);
    const record = full[0];
    assert.ok(record.description.includes("SECRET-DESCRIPTION"));
    assert.equal(record.reviewInbox[0].findings[0].message, "SECRET-FINDING");
    assert.equal(record.reviewInbox[0].summary, "SECRET-REVIEW-SUMMARY");
    assert.equal(record.publication.body, "SECRET-PR-BODY");
    assert.equal(record.publication.verdictComments.length, 1);
    assert.equal(record.prObservationHistory.length, 2);
    assert.equal(record.reviewRoundDecisions[0].reason, "SECRET-DECISION");
    assert.equal(record.mergeReconciliation.evidence.marker, "SECRET-EVIDENCE");
    assert.equal(record.result.report.payload.summary, "SECRET-REPORT-PAYLOAD");
    assert.equal(record.result.path, path.join(reportsDir, "reviewed-build.json"));
    assert.equal(record.candidates.journal.candidates[0].payload.diffstat, "SECRET-DIFFSTAT");
    assert.equal(record.reportToken, undefined);
    assert.equal(record.nextAction, "observe external PR; reconciliation remains confirmed");
    assert.equal(record.reviewRound, 1);
    assert.equal(record.currentMaxReviewRounds, 3);
  });
});
