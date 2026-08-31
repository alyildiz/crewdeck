import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function createReviewService({ CrewdeckError, git, readCandidateJournal, reportsRoot }) {
  function evidencePath(id) {
    return path.join(reportsRoot(), `${id}.review-evidence.json`);
  }

  async function verifyPatchDescriptor(name, evidence, record) {
    const descriptor = evidence[name];
    if (!descriptor) return;
    const recorded = record.reviewEvidence[name];
    if (
      !recorded || descriptor.path !== recorded.path || descriptor.contentSha256 !== recorded.contentSha256 ||
      descriptor.bytes !== recorded.bytes || !path.isAbsolute(descriptor.path)
    ) throw new Error(`${name} identity mismatch`);
    const patch = await readFile(descriptor.path);
    if (
      patch.byteLength !== descriptor.bytes ||
      createHash("sha256").update(patch).digest("hex") !== descriptor.contentSha256
    ) throw new Error(`${name} digest mismatch`);
  }

  async function verifyReviewEvidence(record) {
    if (!record.reviewEvidence) return { available: false, state: "legacy-absent" };
    try {
      const evidence = JSON.parse(await readFile(record.reviewEvidence.path, "utf8"));
      const { contentSha256, ...payload } = evidence;
      const actual = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
      if (
        actual !== contentSha256 || contentSha256 !== record.reviewEvidence.contentSha256 ||
        evidence.parentTaskId !== record.parentTaskId || evidence.reviewTaskId !== record.id ||
        evidence.baseSha !== record.reviewEvidence.baseSha || evidence.candidateSha !== record.reviewedHead ||
        (evidence.schemaVersion === 2 && evidence.reviewDepth !== (record.reviewDepth || "standard"))
      ) throw new Error("identity or digest mismatch");
      if (evidence.schemaVersion === 2) {
        await verifyPatchDescriptor("fullPatch", evidence, record);
        await verifyPatchDescriptor("correctionPatch", evidence, record);
      }
      return { available: true, evidence };
    } catch (error) {
      return { available: false, error: `Reviewer evidence is stale or tampered: ${error.message}` };
    }
  }

  function boundedText(value, max = 4_000) {
    const text = typeof value === "string" ? value : "";
    return text.length <= max ? text : `${text.slice(0, max)}\n[truncated by Crewdeck]`;
  }

  function boundedPatch(value, maxBytes) {
    const source = Buffer.from(value, "utf8");
    if (source.byteLength <= maxBytes) return { content: source, sourceBytes: source.byteLength, truncated: false };
    const marker = Buffer.from(`\n\n[patch truncated: ${source.byteLength - maxBytes} source bytes omitted]\n`, "utf8");
    return {
      content: Buffer.concat([source.subarray(0, Math.max(0, maxBytes - marker.byteLength)), marker]),
      sourceBytes: source.byteLength,
      truncated: true,
    };
  }

  async function writePatch(reviewTaskId, label, patch, maxBytes) {
    const bounded = boundedPatch(patch, maxBytes);
    const target = path.join(reportsRoot(), `${reviewTaskId}.review-${label}.patch`);
    await writeFile(target, bounded.content, { mode: 0o400, flag: "wx" });
    return {
      path: target,
      bytes: bounded.content.byteLength,
      sourceBytes: bounded.sourceBytes,
      truncated: bounded.truncated,
      contentSha256: createHash("sha256").update(bounded.content).digest("hex"),
    };
  }

  function priorReviewContext(parent, previousCandidate) {
    if (!previousCandidate) return undefined;
    const prior = [...(parent.reviewInbox || [])].reverse().find((item) => item.reviewedHead === previousCandidate.head);
    if (!prior) return undefined;
    return {
      verdict: prior.verdict,
      summary: boundedText(prior.summary, 3_000),
      findings: (prior.findings || []).slice(0, 20).map((finding) => ({
        severity: finding.severity,
        title: boundedText(finding.title, 500),
        detail: boundedText(finding.detail, 2_000),
        location: boundedText(finding.location, 1_000),
        recommendation: boundedText(finding.recommendation, 2_000),
      })),
    };
  }

  async function createReviewEvidence(parent, reviewTaskId, candidate, reviewDepth) {
    if (!/^[0-9a-f]{40}$/.test(parent.baseSha || "")) {
      throw new CrewdeckError("Reviewer evidence requires the parent's pinned base SHA", "base_sha_unproven");
    }
    const range = `${parent.baseSha}...${candidate.head}`;
    const journal = await readCandidateJournal(parent);
    if (!journal.available) throw new CrewdeckError(journal.error || "Candidate journal is unavailable", "missing_candidate");
    const previousCandidate = candidate.version > 1 ? journal.journal.candidates[candidate.version - 2] : undefined;
    const [commits, diffstat, changedFiles, fullPatchResult, correctionPatchResult] = await Promise.all([
      git(parent.worktree, ["log", "--format=%H%x09%s", `${parent.baseSha}..${candidate.head}`]),
      git(parent.worktree, ["diff", "--stat", range]),
      git(parent.worktree, ["diff", "--name-status", range]),
      git(parent.worktree, ["diff", "--no-ext-diff", "--unified=3", range], { maxBuffer: 4 * 1024 * 1024 }),
      previousCandidate
        ? git(parent.worktree, ["diff", "--no-ext-diff", "--unified=3", `${previousCandidate.head}..${candidate.head}`], { maxBuffer: 2 * 1024 * 1024 })
        : Promise.resolve(undefined),
    ]);
    await mkdir(reportsRoot(), { recursive: true, mode: 0o700 });
    const createdPaths = [];
    try {
      const fullPatch = await writePatch(reviewTaskId, "full", fullPatchResult.stdout, 40 * 1024);
      createdPaths.push(fullPatch.path);
      const correctionPatch = correctionPatchResult
        ? await writePatch(reviewTaskId, "delta", correctionPatchResult.stdout, 24 * 1024)
        : undefined;
      if (correctionPatch) createdPaths.push(correctionPatch.path);
      const payload = {
        schemaVersion: 2,
        parentTaskId: parent.id,
        reviewTaskId,
        reviewDepth,
        baseSha: parent.baseSha,
        candidateSha: candidate.head,
        candidateVersion: candidate.version,
        generatedAt: new Date().toISOString(),
        featureScope: boundedText(parent.description, 8_000),
        candidate: {
          summary: boundedText(candidate.payload?.summary, 4_000),
          tests: (candidate.payload?.tests || []).slice(0, 20).map((item) => ({
            command: boundedText(item?.command, 1_000),
            result: boundedText(item?.result, 2_000),
          })),
          risks: (candidate.payload?.risks || []).slice(0, 20).map((item) => boundedText(item, 2_000)),
          openQuestions: (candidate.payload?.openQuestions || []).slice(0, 20).map((item) => boundedText(item, 2_000)),
        },
        commits: commits.stdout ? commits.stdout.split("\n").slice(0, 200).map((line) => {
          const [sha, ...subject] = line.split("\t");
          return { sha, subject: boundedText(subject.join("\t"), 1_000) };
        }) : [],
        diffstat: boundedText(diffstat.stdout, 12_000),
        changedFiles: changedFiles.stdout ? changedFiles.stdout.split("\n").slice(0, 500) : [],
        ...(previousCandidate ? {
          previousCandidate: { version: previousCandidate.version, head: previousCandidate.head },
          priorReview: priorReviewContext(parent, previousCandidate),
        } : {}),
        fullPatch,
        ...(correctionPatch ? { correctionPatch } : {}),
      };
      const contentSha256 = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
      const target = evidencePath(reviewTaskId);
      await writeFile(target, `${JSON.stringify({ ...payload, contentSha256 }, null, 2)}\n`, { mode: 0o400, flag: "wx" });
      return {
        path: target,
        contentSha256,
        baseSha: parent.baseSha,
        candidateSha: candidate.head,
        fullPatch,
        ...(correctionPatch ? { correctionPatch } : {}),
      };
    } catch (error) {
      await Promise.all(createdPaths.map((target) => rm(target, { force: true })));
      throw error;
    }
  }

  return { createReviewEvidence, verifyReviewEvidence };
}
