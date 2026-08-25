import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const taskId = process.env.CREWDECK_TASK_ID || "";
const taskKind = process.env.CREWDECK_TASK_KIND || "";
const taskLifecycle = process.env.CREWDECK_TASK_LIFECYCLE || "";
const taskContract = process.env.CREWDECK_TASK_CONTRACT || "standard";
const taskWorkflow = process.env.CREWDECK_TASK_WORKFLOW || "direct";
const taskBranch = process.env.CREWDECK_TASK_BRANCH || "";
const taskBase = process.env.CREWDECK_TASK_BASE || "";
const taskBaseSha = process.env.CREWDECK_TASK_BASE_SHA || "";
const parentTaskId = process.env.CREWDECK_PARENT_TASK_ID || "";
const reviewedHead = process.env.CREWDECK_REVIEWED_HEAD || "";
const reviewEvidencePath = process.env.CREWDECK_REVIEW_EVIDENCE_PATH || "";
const reviewEvidenceSha256 = process.env.CREWDECK_REVIEW_EVIDENCE_SHA256 || "";
const reportToken = process.env.CREWDECK_REPORT_TOKEN || "";
const reportDir = process.env.CREWDECK_REPORT_DIR || "";
const maxReviewRounds = Number(process.env.CREWDECK_MAX_REVIEW_ROUNDS || "3");

const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 });

const ScoutResult = Type.Object({
  conclusion: Type.String({ minLength: 1, maxLength: 12000 }),
  findings: StringList,
  evidence: Type.Array(
    Type.Object({
      location: Type.String({ minLength: 1, maxLength: 2000 }),
      detail: Type.String({ minLength: 1, maxLength: 6000 }),
    }),
    { maxItems: 100 },
  ),
  recommendations: StringList,
  openQuestions: StringList,
});

const BuildResult = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 12000 }),
  commit: Type.String({ pattern: "^[0-9a-f]{7,40}$" }),
  tests: Type.Array(
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 4000 }),
      result: Type.String({ minLength: 1, maxLength: 6000 }),
    }),
    { maxItems: 100 },
  ),
  risks: StringList,
  openQuestions: StringList,
});

const CandidateResult = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 12000 }),
  commit: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  tests: Type.Array(
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 4000 }),
      result: Type.String({ minLength: 1, maxLength: 6000 }),
    }),
    { maxItems: 100 },
  ),
  risks: StringList,
  openQuestions: StringList,
});

const ReviewResult = Type.Object({
  parentTaskId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,23}$" }),
  reviewedHead: Type.String({ pattern: "^[0-9a-f]{40}$" }),
  verdict: StringEnum(["approved", "changes-requested", "blocked", "inconclusive"] as const),
  summary: Type.String({ minLength: 1, maxLength: 12000 }),
  findings: Type.Array(
    Type.Object({
      severity: StringEnum(["blocking", "major", "minor", "nit"] as const),
      title: Type.String({ minLength: 1, maxLength: 1000 }),
      detail: Type.String({ minLength: 1, maxLength: 6000 }),
      location: Type.String({ minLength: 1, maxLength: 2000 }),
      recommendation: Type.String({ minLength: 1, maxLength: 4000 }),
    }),
    { maxItems: 100 },
  ),
  checks: StringList,
  openQuestions: StringList,
  evidenceSha256: Type.Optional(Type.String({ pattern: "^[0-9a-f]{64}$" })),
});

async function git(args: string[]) {
  const result = await execFileAsync("git", args, {
    cwd: process.cwd(),
    timeout: 15_000,
    encoding: "utf8",
  });
  return result.stdout.trim();
}

function samePayload(left: unknown, right: unknown) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export default function crewdeckWorkerReporter(pi: ExtensionAPI) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(taskId)) throw new Error("Invalid CREWDECK_TASK_ID");
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(taskKind)) throw new Error("Invalid CREWDECK_TASK_KIND");
  if (taskLifecycle !== "report" && taskLifecycle !== "change") {
    throw new Error("Invalid CREWDECK_TASK_LIFECYCLE");
  }
  if (taskContract !== "standard" && taskContract !== "review") {
    throw new Error("Invalid CREWDECK_TASK_CONTRACT");
  }
  if (taskContract === "review") {
    if (taskLifecycle !== "report") throw new Error("Review contracts must use the report lifecycle");
    if (!/^[a-z][a-z0-9-]{0,23}$/.test(parentTaskId)) throw new Error("Invalid CREWDECK_PARENT_TASK_ID");
    if (!/^[0-9a-f]{40}$/.test(reviewedHead)) throw new Error("Invalid CREWDECK_REVIEWED_HEAD");
  }
  if (taskWorkflow !== "direct" && taskWorkflow !== "reviewed-pr") {
    throw new Error("Invalid CREWDECK_TASK_WORKFLOW");
  }
  if (taskWorkflow === "reviewed-pr") {
    if (taskLifecycle !== "change") throw new Error("Only change tasks can use reviewed-pr");
    if (taskBranch !== `crew/${taskId}`) throw new Error("Invalid CREWDECK_TASK_BRANCH");
    if (!taskBase) throw new Error("Invalid CREWDECK_TASK_BASE");
    if (!/^[0-9a-f]{40}$/.test(taskBaseSha)) throw new Error("Invalid CREWDECK_TASK_BASE_SHA");
    if (!Number.isInteger(maxReviewRounds) || maxReviewRounds < 1 || maxReviewRounds > 50) {
      throw new Error("Invalid CREWDECK_MAX_REVIEW_ROUNDS");
    }
  }
  if (!/^[0-9a-f]{48}$/.test(reportToken)) throw new Error("Invalid CREWDECK_REPORT_TOKEN");
  if (!path.isAbsolute(reportDir)) throw new Error("CREWDECK_REPORT_DIR must be absolute");

  if (taskWorkflow === "reviewed-pr") {
    pi.registerTool({
      name: "crew_submit_candidate",
      label: "Submit Reviewed-PR Candidate",
      description:
        "Durably submit the clean current HEAD as the next reviewed-PR candidate without ending this build agent. Repeating the exact same candidate is idempotent.",
      parameters: CandidateResult,
      async execute(_toolCallId, params) {
        const [head, branch, status, ahead] = await Promise.all([
          git(["rev-parse", "HEAD"]),
          git(["branch", "--show-current"]),
          git(["status", "--porcelain"]),
          git(["rev-list", "--count", `${taskBaseSha}..HEAD`]),
        ]);
        if (branch !== taskBranch) throw new Error(`Build must remain on ${taskBranch}`);
        if (status !== "") throw new Error("Cannot submit a candidate from a dirty worktree");
        if (Number(ahead) < 1) throw new Error("Candidate must contain at least one commit ahead of the configured base");
        if (params.commit !== head) throw new Error(`Candidate commit must equal exact HEAD ${head}`);

        const target = path.join(reportDir, `${taskId}.candidates.json`);
        await mkdir(reportDir, { recursive: true, mode: 0o700 });
        return withFileMutationQueue(target, async () => {
          let journal: any = {
            schemaVersion: 1,
            taskId,
            kind: taskKind,
            workflow: taskWorkflow,
            token: reportToken,
            candidates: [],
          };
          try {
            journal = JSON.parse(await readFile(target, "utf8"));
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
          if (
            journal.schemaVersion !== 1 ||
            journal.taskId !== taskId ||
            journal.kind !== taskKind ||
            journal.workflow !== "reviewed-pr" ||
            journal.token !== reportToken ||
            !Array.isArray(journal.candidates)
          ) {
            throw new Error("Candidate journal identity does not match this task");
          }
          const existing = journal.candidates.find((candidate: any) => candidate.head === head);
          if (existing) {
            if (!samePayload(existing.payload, params)) {
              throw new Error("This HEAD already has a candidate with a different payload");
            }
            return {
              content: [{ type: "text", text: `Candidate v${existing.version} already stored for ${head}. Build remains active.` }],
              details: { taskId, version: existing.version, head, submittedAt: existing.submittedAt, idempotent: true },
            };
          }
          let effectiveMax = maxReviewRounds;
          try {
            const authority = JSON.parse(await readFile(path.join(reportDir, `${taskId}.rounds.json`), "utf8"));
            if (authority.taskId !== taskId || authority.token !== reportToken || !Number.isInteger(authority.maxReviewRounds)) {
              throw new Error("invalid review-round authority");
            }
            effectiveMax = authority.maxReviewRounds;
          } catch (error: any) {
            if (error.code !== "ENOENT") throw error;
          }
          if (journal.candidates.length >= effectiveMax) {
            throw new Error(`Review round limit reached (${effectiveMax}); orchestrator escalation is required`);
          }
          const candidate = {
            version: journal.candidates.length + 1,
            head,
            submittedAt: new Date().toISOString(),
            payload: params,
          };
          journal.candidates.push(candidate);
          const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
          await writeFile(temp, `${JSON.stringify(journal, null, 2)}\n`, { mode: 0o600 });
          await rename(temp, target);
          return {
            content: [{ type: "text", text: `Candidate v${candidate.version} stored for ${head}. Build remains active for review steering.` }],
            details: { taskId, version: candidate.version, head, submittedAt: candidate.submittedAt, idempotent: false },
          };
        });
      },
    });
  }

  pi.registerTool({
    name: "crew_complete",
    label: "Complete Crewdeck Task",
    description:
      taskContract === "review"
        ? `Submit the final durable review of exactly ${reviewedHead}. Required exactly once before ending the task.`
        : taskLifecycle === "report"
          ? `Submit the final durable read-only ${taskKind} report. Required exactly once before ending the task.`
          : `Submit the final durable ${taskKind} change result with the exact committed HEAD. Required exactly once before ending the task.`,
    parameters: taskContract === "review" ? ReviewResult : taskLifecycle === "report" ? ScoutResult : BuildResult,
    async execute(_toolCallId, params: any) {
      if (taskContract === "review") {
        if (params.parentTaskId !== parentTaskId || params.reviewedHead !== reviewedHead) {
          throw new Error("Review identity must match the bound parentTaskId and reviewedHead");
        }
        if (reviewEvidenceSha256) {
          if (!path.isAbsolute(reviewEvidencePath) || params.evidenceSha256 !== reviewEvidenceSha256) {
            throw new Error("Review must attest the authoritative precomputed evidence SHA-256");
          }
          const evidence = JSON.parse(await readFile(reviewEvidencePath, "utf8"));
          if (evidence.contentSha256 !== reviewEvidenceSha256 || evidence.parentTaskId !== parentTaskId || evidence.candidateSha !== reviewedHead) {
            throw new Error("Authoritative reviewer evidence identity is stale or tampered");
          }
        }
        if (params.verdict === "approved" && params.findings.some((finding: any) => finding.severity === "blocking")) {
          throw new Error("An approved review cannot contain blocking findings");
        }
        if (params.verdict === "changes-requested" && params.findings.length === 0) {
          throw new Error("changes-requested requires at least one structured finding");
        }
        const head = await git(["rev-parse", "HEAD"]);
        if (head !== reviewedHead) throw new Error(`Reviewer worktree no longer matches ${reviewedHead}`);
      }

      const target = path.join(reportDir, `${taskId}.json`);
      await mkdir(reportDir, { recursive: true, mode: 0o700 });
      return withFileMutationQueue(target, async () => {
        try {
          await access(target);
          throw new Error("Crewdeck result already submitted; do not replace a durable result");
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
        const report = {
          schemaVersion: 1,
          taskId,
          kind: taskKind,
          lifecycle: taskLifecycle,
          contract: taskContract,
          ...(taskContract === "review" ? { parentTaskId, reviewedHead } : {}),
          token: reportToken,
          completedAt: new Date().toISOString(),
          payload: params,
        };
        const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, target);
        return {
          content: [{ type: "text", text: `Crewdeck ${taskKind} result stored durably. Task complete.` }],
          details: { taskId, kind: taskKind, completedAt: report.completedAt },
          terminate: true,
        };
      });
    },
  });
}
