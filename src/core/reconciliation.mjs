import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";

export function createReconciliationService({
  CrewdeckError,
  exactHeadRepository,
  exactIssueCommentUrl,
  exactPullRequestUrl,
  findVerdictComment,
  git,
  gitAncestorProof,
  githubRepositoryFromUrl,
  gitSnapshot,
  inspectGitHubChecks,
  listedWorktrees,
  liveAgent,
  loadConfig,
  loadState,
  missingWorkspace,
  provenMissingAgent,
  publicTaskRecord,
  readCandidateJournal,
  readTaskReport,
  remoteBranchSha,
  renderVerdictComment,
  requirePassingChecks,
  resolveProject,
  run,
  runJson,
  saveState,
  taskIdPattern,
  validatedVerdictPayload,
  validBranchName,
  validRemoteName,
  validRepositoryName,
  withStateLock,
}) {
  const BASE_ADVANCE_TERMINAL = new Set(["cleaned", "integrated", "abandoned", "pr-merged", "orphan-reconciled", "retired"]);

  async function classifyBaseAdvance(record, newBaseSha) {
    if (!/^[0-9a-f]{40}$/.test(record.baseSha || "") || !/^[0-9a-f]{40}$/.test(newBaseSha || "")) {
      return { classification: "unknown", reason: "missing exact pinned or advanced base commit" };
    }
    const behind = await gitAncestorProof(record.repo, record.baseSha, newBaseSha);
    if (!behind.available || !behind.ancestor) {
      return { classification: "unknown", reason: behind.error || "pinned base is not proven ancestral to the merged base" };
    }
    const snapshot = await gitSnapshot(record);
    if (!snapshot.available) return { classification: "unknown", reason: snapshot.error || "build HEAD is unavailable" };
    const contains = await gitAncestorProof(record.repo, newBaseSha, snapshot.head);
    if (contains.available && contains.ancestor) {
      return { classification: "compatible", requiresRefresh: false, headSha: snapshot.head, evidence: "advanced base already contained by build HEAD" };
    }
    try {
      await git(record.repo, ["merge-tree", "--write-tree", "--merge-base", record.baseSha, newBaseSha, snapshot.head]);
      return { classification: "compatible", requiresRefresh: true, headSha: snapshot.head, evidence: "git merge-tree completed without conflicts" };
    } catch (error) {
      if (error.code === "command_failed" && Number(error.details?.exitCode) === 1) {
        return { classification: "conflicting", requiresRefresh: true, headSha: snapshot.head, evidence: "git merge-tree reported conflicts" };
      }
      return { classification: "unknown", headSha: snapshot.head, reason: error.message };
    }
  }

  async function recordBaseAdvanceFanout(source, outcome) {
    if (outcome.status !== "merged-awaiting-confirmed-reconciliation" || !/^[0-9a-f]{40}$/.test(outcome.mergeCommit || "")) return [];
    const snapshot = await loadState();
    const eligible = Object.values(snapshot.tasks).filter((record) => {
      const lifecycle = record.lifecycle || (record.kind === "scout" ? "report" : "change");
      return record.id !== source.id && record.project === source.project && lifecycle === "change" &&
        record.base === source.base && !record.cleanedAt && !BASE_ADVANCE_TERMINAL.has(record.status) &&
        record.baseSha !== outcome.mergeCommit;
    });
    const classified = [];
    for (const record of eligible) classified.push({ record, result: await classifyBaseAdvance(record, outcome.mergeCommit) });
    const created = [];
    await withStateLock(async () => {
      const next = await loadState();
      for (const { record, result } of classified) {
        const stored = next.tasks[record.id];
        if (!stored || stored.id === source.id || stored.project !== source.project || stored.lifecycle === "report" ||
            stored.cleanedAt || BASE_ADVANCE_TERMINAL.has(stored.status)) continue;
        stored.baseAdvances ||= [];
        const identity = `${source.id}:${stored.baseSha || "unknown"}:${outcome.mergeCommit}`;
        const existing = stored.baseAdvances.find((item) => item.identity === identity);
        if (existing) {
          if (["pending", "awaiting-writer"].includes(existing.status) && result.headSha && existing.headSha !== result.headSha) {
            Object.assign(existing, {
              classification: result.classification,
              ...(result.requiresRefresh !== undefined ? { requiresRefresh: result.requiresRefresh } : {}),
              headSha: result.headSha,
              ...(result.evidence ? { evidence: result.evidence, reason: undefined } : {}),
              ...(result.reason ? { reason: result.reason, evidence: undefined } : {}),
              reclassifiedAt: new Date().toISOString(),
            });
            created.push({ taskId: stored.id, ...existing, updated: true });
          }
          continue;
        }
        const notification = {
          sequence: stored.baseAdvances.length + 1,
          identity,
          status: "pending",
          sourceTaskId: source.id,
          sourcePrNumber: outcome.number,
          sourcePrUrl: outcome.url,
          priorBaseSha: stored.baseSha,
          newBaseSha: outcome.mergeCommit,
          mergedAt: outcome.mergedAt,
          observedAt: outcome.observedAt,
          classification: result.classification,
          ...(result.requiresRefresh !== undefined ? { requiresRefresh: result.requiresRefresh } : {}),
          ...(result.headSha ? { headSha: result.headSha } : {}),
          ...(result.evidence ? { evidence: result.evidence } : {}),
          ...(result.reason ? { reason: result.reason } : {}),
        };
        stored.baseAdvances.push(notification);
        created.push({ taskId: stored.id, ...notification });
      }
      if (created.length) await saveState(next);
    });
    return created;
  }

  async function observePublishedPullRequests(configPath, id) {
    const config = await loadConfig(configPath);
    const state = await loadState();
    const records = Object.values(state.tasks).filter((record) =>
      (!id || record.id === id) && record.status === "running" && record.workflow === "reviewed-pr" && record.publication?.number
    );
    if (id && records.length === 0) throw new CrewdeckError("No active published reviewed-pr task matches", "publication_incomplete");
    const observations = [];
    for (const record of records) {
      const publication = record.publication;
      const fields = "number,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,mergeCommit,mergedAt";
      let outcome;
      try {
        const pr = await runJson("gh", ["pr", "view", String(publication.number), "--repo", publication.repo, "--json", fields], { timeout: 20_000 });
        const identityExact = pr?.number === publication.number && pr?.url === publication.url &&
          exactPullRequestUrl(pr?.url, publication.repo, publication.number) && pr?.headRefName === publication.remoteHead &&
          pr?.baseRefName === publication.base && pr?.headRefOid === publication.headSha && pr?.isCrossRepository === false &&
          exactHeadRepository(pr?.headRepository, pr?.headRepositoryOwner, publication.repo);
        if (!identityExact) throw new CrewdeckError("Observed PR identity diverges from durable publication", "observer_identity_mismatch", pr);
        if (pr.state === "MERGED" && (!/^[0-9a-f]{40}$/.test(pr.mergeCommit?.oid || "") ||
            typeof pr.mergedAt !== "string" || Number.isNaN(Date.parse(pr.mergedAt)))) {
          throw new CrewdeckError("Merged observation lacks exact merge identity", "observer_identity_mismatch", pr);
        }
        const stateName = pr.state === "MERGED" ? "merged-awaiting-confirmed-reconciliation"
          : pr.state === "OPEN" ? "open" : pr.state === "CLOSED" ? "closed-unmerged" : "unknown";
        outcome = { status: stateName, observedAt: new Date().toISOString(), repo: publication.repo,
          number: publication.number, url: publication.url, headSha: publication.headSha,
          ...(pr.state === "MERGED" ? { mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid } : {}) };
      } catch (error) {
        outcome = { status: "lookup-failed", observedAt: new Date().toISOString(), repo: publication.repo,
          number: publication.number, url: publication.url, headSha: publication.headSha, reason: error.message };
      }
      let newlyObserved = false;
      await withStateLock(async () => {
        const next = await loadState();
        const stored = next.tasks[record.id];
        if (stored?.publication?.number === publication.number && stored.publication.headSha === publication.headSha) {
          newlyObserved = stored.prObservation?.status !== outcome.status;
          stored.prObservation = outcome;
          stored.prObservationHistory ||= [];
          if (newlyObserved) stored.prObservationHistory.push(outcome);
          await saveState(next);
        }
      });
      // Run fanout on every exact merged observation. Durable identities deduplicate it;
      // this closes the crash window between persisting the PR observation and fanout.
      const baseAdvances = outcome.status === "merged-awaiting-confirmed-reconciliation"
        ? await recordBaseAdvanceFanout(record, outcome) : [];
      observations.push({ id: record.id, ...outcome, newlyObserved, baseAdvances });
    }
    return observations;
  }

  async function forwardBaseAdvance(configPath, id, sequence, { wait = false } = {}) {
    if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new CrewdeckError("Base-advance sequence must be a positive safe integer", "invalid_base_advance_sequence");
    const config = await loadConfig(configPath);
    const state = await loadState();
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
    if (record.lifecycle !== "change" || record.cleanedAt || BASE_ADVANCE_TERMINAL.has(record.status)) {
      throw new CrewdeckError("Only a nonterminal change task can receive a base advance", "invalid_base_advance_task");
    }
    const notification = sequence === undefined
      ? (record.baseAdvances || []).filter((item) => item.status === "pending" || item.status === "awaiting-writer").at(-1)
      : (record.baseAdvances || []).find((item) => item.sequence === sequence);
    if (!notification) throw new CrewdeckError("Pending base-advance notification is missing", "base_advance_missing");
    if (notification.status === "forwarded" || notification.status === "compatible-preserved") {
      return { forwarded: notification.status === "forwarded", preserved: notification.status === "compatible-preserved", idempotent: true, notification };
    }
    if (notification.classification === "unknown") {
      throw new CrewdeckError("Base compatibility is unknown; resolve Git evidence before notifying a writer", "base_compatibility_unknown", notification);
    }
    const currentSnapshot = await gitSnapshot(record);
    if (!currentSnapshot.available || (notification.headSha && currentSnapshot.head !== notification.headSha)) {
      throw new CrewdeckError("Build HEAD changed after base compatibility classification; wait for observer reclassification", "base_advance_stale", {
        classifiedHead: notification.headSha, currentHead: currentSnapshot.head, error: currentSnapshot.error,
      });
    }
    if (notification.classification === "compatible" && (record.publication?.number || notification.requiresRefresh === false)) {
      await withStateLock(async () => {
        const next = await loadState();
        const item = (next.tasks[id]?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
        if (!item) throw new CrewdeckError("Base advance changed", "state_changed");
        item.status = "compatible-preserved";
        item.settledAt ||= new Date().toISOString();
        await saveState(next);
      });
      return {
        forwarded: false, preserved: true, idempotent: false,
        reason: record.publication?.number
          ? "published exact-SHA PR is locally compatible and is not rewritten"
          : "build HEAD already contains the advanced base; candidate and approval identity do not require refresh",
      };
    }
    const agent = await liveAgent(record);
    if (!agent.available) {
      if (!provenMissingAgent(agent)) throw new CrewdeckError("Cannot prove sole writer state", "agent_state_unknown", agent);
      await withStateLock(async () => {
        const next = await loadState();
        const item = (next.tasks[id]?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
        if (!item) throw new CrewdeckError("Base advance changed", "state_changed");
        item.status = "awaiting-writer";
        item.writerAbsentAt ||= new Date().toISOString();
        await saveState(next);
      });
      return { forwarded: false, writerAbsent: true, nextAction: "resume the sole writer, then forward this base advance" };
    }
    const attemptedAt = new Date().toISOString();
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      const item = (stored?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
      if (!item) throw new CrewdeckError("Base advance changed", "state_changed");
      item.status = "forwarding";
      item.forwardAttempts = (item.forwardAttempts || 0) + 1;
      item.forwardAttemptedAt = attemptedAt;
      stored.baseShaHistory ||= [];
      if (stored.baseSha !== notification.newBaseSha) {
        stored.baseShaHistory.push({ sha: stored.baseSha, supersededBy: notification.newBaseSha, at: attemptedAt, sourceTaskId: notification.sourceTaskId });
        stored.baseSha = notification.newBaseSha;
      }
      stored.requiredBaseSha = notification.newBaseSha;
      for (const review of stored.reviewInbox || []) {
        if (review.validAtCollection) {
          review.validAtCollection = false;
          review.staleAt ||= attemptedAt;
          review.staleReason = "pinned base advanced";
        }
      }
      await saveState(next);
    });
    const message = [
      `CREWDECK BASE ADVANCE ${notification.sequence}: ${notification.sourceTaskId} merged and the pinned base advanced from ${notification.priorBaseSha} to ${notification.newBaseSha}.`,
      `Local deterministic classification: ${notification.classification}.`,
      "Adapt/rebase the existing sole-writer branch without discarding work, rerun verification, commit any resulting changes, and submit a new exact-HEAD candidate when the SHA changes. Prior candidate review/approval is stale. Do not reuse it.",
    ].join("\n");
    const args = ["agent", "prompt", record.agentName, message];
    if (wait) args.push("--wait", "--timeout", "600000");
    await runJson("herdr", args, { timeout: wait ? 610_000 : 15_000 });
    const forwardedAt = new Date().toISOString();
    await withStateLock(async () => {
      const next = await loadState();
      const item = (next.tasks[id]?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
      if (!item) throw new CrewdeckError("Base advance changed after delivery", "state_changed");
      item.status = "forwarded";
      item.forwardedAt ||= forwardedAt;
      await saveState(next);
    });
    return { forwarded: true, idempotent: false, taskId: id, sequence: notification.sequence, forwardedAt };
  }

  function mergedReconciliationResult(record, idempotent) {
    return {
      reconciled: true,
      idempotent,
      status: "merged-reconciled",
      task: publicTaskRecord(record),
      publication: record.publication,
      reconciliation: record.mergeReconciliation,
    };
  }

  async function reconcileMergedPullRequest(configPath, id) {
    const config = await loadConfig(configPath);
    const state = await loadState();
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    record.kind ||= record.profile === "scout" ? "scout" : "build";
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
    record.workflow ||= "direct";
    record.cleanup ||= config.kinds[record.kind]?.cleanup || "after-integration";

    if (record.status === "pr-merged") {
      if (record.mergeReconciliation?.status !== "merged-reconciled") {
        throw new CrewdeckError("Merged PR task has incomplete reconciliation evidence", "invalid_reconciliation_state");
      }
      return mergedReconciliationResult(record, true);
    }
    if (record.lifecycle !== "change" || record.workflow !== "reviewed-pr") {
      throw new CrewdeckError("Merged PR reconciliation requires a reviewed-pr change task", "invalid_reconciliation_task");
    }
    if (record.status !== "running" || record.cleanedAt) {
      throw new CrewdeckError(
        `Task status '${record.status}' is not eligible for merged PR reconciliation`,
        "invalid_reconciliation_state",
      );
    }
    const recovery = ["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status);
    if (record.mergeReconciliation && !recovery) {
      throw new CrewdeckError("Task has invalid merge reconciliation state", "invalid_reconciliation_state");
    }
    if (record.resumeReservation) {
      throw new CrewdeckError("A build adoption reservation is active", "writer_already_present");
    }
    const activeReview = Object.values(state.tasks).find((item) =>
      item.parentTaskId === id &&
      !item.cleanedAt &&
      !["cleaned", "orphan-reconciled"].includes(item.status)
    );
    if (activeReview) {
      throw new CrewdeckError("A reviewer for this build is still active", "reviewer_already_active", {
        reviewTaskId: activeReview.id,
      });
    }

    const project = resolveProject(config, record.project);
    if (
      record.branch !== `crew/${id}` ||
      record.base !== project.base ||
      path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
      path.resolve(record.repo) !== project.path
    ) {
      throw new CrewdeckError("Task does not reference its expected isolated Git resources", "unsafe_task_resources");
    }

    const publication = record.publication;
    if (
      !publication ||
      !validRemoteName(publication.remote) ||
      !validRepositoryName(publication.repo) ||
      !validBranchName(publication.base) ||
      !validBranchName(publication.remoteHead) ||
      !Number.isInteger(publication.number) ||
      publication.number < 1 ||
      !exactPullRequestUrl(publication.url, publication.repo, publication.number) ||
      publication.base !== record.base ||
      publication.remoteHead !== record.branch ||
      publication.headSha !== publication.remoteSha ||
      !/^[0-9a-f]{40}$/.test(publication.headSha || "")
    ) {
      throw new CrewdeckError("Durable publication identity is missing or inconsistent", "invalid_publication_identity");
    }

    const journalResult = await readCandidateJournal(record);
    if (!journalResult.available) {
      throw new CrewdeckError(journalResult.error || "Candidate journal is missing", "missing_candidate");
    }
    const candidate = journalResult.journal.candidates.at(-1);
    if (
      !candidate ||
      candidate.head !== publication.headSha ||
      record.candidateCollectedVersion !== candidate.version
    ) {
      throw new CrewdeckError("Published approved SHA is not the latest collected candidate", "stale_candidate", {
        publishedHead: publication.headSha,
        candidateHead: candidate?.head,
        candidateVersion: candidate?.version,
        collectedVersion: record.candidateCollectedVersion,
      });
    }
    const approvals = (record.reviewInbox || []).filter((item) =>
      item.reviewedHead === candidate.head &&
      item.candidateVersion === candidate.version &&
      item.verdict === "approved" &&
      item.validAtCollection === true
    );
    if (approvals.length !== 1) {
      throw new CrewdeckError("Published candidate does not have one exact durable approval", "ambiguous_approval", {
        matches: approvals.length,
      });
    }
    const approval = approvals[0];
    validatedVerdictPayload(id, candidate, approval);
    const reviewRecord = state.tasks[approval.reviewTaskId];
    const reviewResult = reviewRecord ? await readTaskReport(reviewRecord) : { available: false };
    if (
      !reviewRecord ||
      reviewRecord.contract !== "review" ||
      reviewRecord.parentTaskId !== id ||
      reviewRecord.reviewedHead !== candidate.head ||
      reviewRecord.candidateVersion !== candidate.version ||
      !reviewRecord.resultCollectedAt ||
      !reviewResult.available ||
      reviewResult.report.payload?.verdict !== "approved" ||
      reviewResult.report.payload?.parentTaskId !== id ||
      reviewResult.report.payload?.reviewedHead !== candidate.head ||
      reviewResult.report.payload?.summary !== approval.summary ||
      JSON.stringify(reviewResult.report.payload?.findings) !== JSON.stringify(approval.findings) ||
      JSON.stringify(reviewResult.report.payload?.checks) !== JSON.stringify(approval.checks) ||
      JSON.stringify(reviewResult.report.payload?.openQuestions) !== JSON.stringify(approval.openQuestions)
    ) {
      throw new CrewdeckError("Exact durable reviewer evidence is missing or inconsistent", "invalid_approval_evidence");
    }
    if (record.reviewEscalation?.reviewedHead === candidate.head) {
      throw new CrewdeckError("Published candidate has unresolved review escalation", "review_not_approved");
    }

    const hasVerdictJournal = Object.hasOwn(publication, "verdictComments");
    let verdictEvidence;
    if (!hasVerdictJournal) {
      // Publications completed by a process that loaded the pre-verdict implementation
      // have no journal at all. Absence is distinct from any present, incomplete intent.
      verdictEvidence = {
        status: "legacy-absent",
        headSha: candidate.head,
        candidateVersion: candidate.version,
        reviewerTaskId: approval.reviewTaskId,
      };
    } else {
      const verdicts = publication.verdictComments;
      if (
        !Array.isArray(verdicts) ||
        verdicts.length === 0 ||
        verdicts.some((item) => {
          if (
            item?.status !== "published" ||
            !/^[0-9a-f]{40}$/.test(item.headSha || "") ||
            item.marker !== `<!-- crewdeck-verdict:${id}:${item.headSha} -->` ||
            item.prNumber !== publication.number ||
            !Number.isInteger(item.candidateVersion) ||
            !taskIdPattern.test(item.reviewerTaskId || "") ||
            !/^[0-9a-f]{64}$/.test(item.contentSha256 || "") ||
            !Number.isInteger(item.comment?.id) ||
            item.comment.id < 1 ||
            !exactIssueCommentUrl(item.comment?.url, publication.repo, publication.number, item.comment?.id)
          ) {
            return true;
          }
          const intentCandidate = journalResult.journal.candidates.find((entry) =>
            entry.head === item.headSha && entry.version === item.candidateVersion
          );
          const intentApprovals = (record.reviewInbox || []).filter((entry) =>
            entry.reviewTaskId === item.reviewerTaskId &&
            entry.reviewedHead === item.headSha &&
            entry.candidateVersion === item.candidateVersion &&
            entry.verdict === "approved" &&
            entry.validAtCollection === true
          );
          if (!intentCandidate || intentApprovals.length !== 1) return true;
          try {
            const rendered = renderVerdictComment(id, intentCandidate, intentApprovals[0]);
            return item.marker !== rendered.marker || item.contentSha256 !== rendered.contentSha256;
          } catch {
            return true;
          }
        }) ||
        new Set(verdicts.map((item) => item.headSha)).size !== verdicts.length
      ) {
        throw new CrewdeckError("Durable publication is missing or ambiguous", "ambiguous_publication");
      }
      const matchingVerdicts = verdicts.filter((item) =>
        item.headSha === candidate.head &&
        item.candidateVersion === candidate.version &&
        item.reviewerTaskId === approval.reviewTaskId
      );
      if (matchingVerdicts.length !== 1) {
        throw new CrewdeckError("Approved candidate has no unique published verdict", "ambiguous_publication", {
          matches: matchingVerdicts.length,
        });
      }
      const [matchingVerdict] = matchingVerdicts;
      verdictEvidence = {
        status: "published",
        headSha: matchingVerdict.headSha,
        candidateVersion: matchingVerdict.candidateVersion,
        reviewerTaskId: matchingVerdict.reviewerTaskId,
        marker: matchingVerdict.marker,
        contentSha256: matchingVerdict.contentSha256,
        comment: { ...matchingVerdict.comment },
      };
    }
    let remoteUrl;
    try {
      remoteUrl = (await git(record.repo, ["remote", "get-url", "--push", publication.remote])).stdout;
    } catch (error) {
      throw new CrewdeckError(`Git remote '${publication.remote}' is unavailable`, "remote_unavailable", {
        error: error.message,
      });
    }
    const remoteRepo = githubRepositoryFromUrl(remoteUrl);
    if (!remoteRepo || remoteRepo.toLowerCase() !== publication.repo.toLowerCase()) {
      throw new CrewdeckError("Durable publication remote and GitHub repository differ", "remote_repo_mismatch", {
        remoteUrl,
        repo: publication.repo,
      });
    }
    let forgeRepo;
    try {
      forgeRepo = await runJson("gh", ["repo", "view", publication.repo, "--json", "nameWithOwner"], {
        timeout: 20_000,
      });
    } catch (error) {
      throw new CrewdeckError("GitHub repository is unavailable through gh", "forge_unavailable", {
        error: error.message,
      });
    }
    if (forgeRepo?.nameWithOwner?.toLowerCase() !== publication.repo.toLowerCase()) {
      throw new CrewdeckError("gh resolved a different GitHub repository", "forge_repo_mismatch", forgeRepo);
    }

    const prFields = [
      "number", "url", "state", "isDraft", "headRefName", "baseRefName", "headRefOid",
      "isCrossRepository", "headRepository", "headRepositoryOwner", "mergeCommit", "mergedAt",
    ].join(",");
    let pr;
    try {
      pr = await runJson("gh", [
        "pr", "view", String(publication.number), "--repo", publication.repo, "--json", prFields,
      ], { timeout: 20_000 });
    } catch (error) {
      throw new CrewdeckError("Stored GitHub PR is unavailable", "forge_unavailable", { error: error.message });
    }
    const mergeCommit = pr?.mergeCommit?.oid;
    if (
      pr?.number !== publication.number ||
      pr?.url !== publication.url ||
      !exactPullRequestUrl(pr?.url, publication.repo, publication.number) ||
      pr?.state !== "MERGED" ||
      pr?.isDraft !== false ||
      pr?.headRefName !== publication.remoteHead ||
      pr?.baseRefName !== publication.base ||
      pr?.headRefOid !== candidate.head ||
      pr?.isCrossRepository !== false ||
      !exactHeadRepository(pr?.headRepository, pr?.headRepositoryOwner, publication.repo) ||
      !/^[0-9a-f]{40}$/.test(mergeCommit || "") ||
      typeof pr?.mergedAt !== "string" ||
      Number.isNaN(Date.parse(pr.mergedAt))
    ) {
      throw new CrewdeckError("GitHub PR is not the exact merged publication", "pull_request_not_merged", pr);
    }
    const mergedChecks = await inspectGitHubChecks(project, publication.repo, candidate.head);
    publication.checks = mergedChecks;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (!stored?.publication || stored.publication.number !== publication.number || stored.publication.headSha !== candidate.head) {
        throw new CrewdeckError("Publication changed before merged checks persistence", "state_changed");
      }
      stored.publication.checks = mergedChecks;
      await saveState(next);
    });
    requirePassingChecks(mergedChecks, "merged reconciliation");

    if (verdictEvidence.status === "legacy-absent") {
      const rendered = renderVerdictComment(id, candidate, approval);
      const untrackedVerdict = await findVerdictComment(
        publication.repo,
        publication.number,
        rendered.marker,
        rendered.body,
      );
      if (untrackedVerdict) {
        throw new CrewdeckError(
          "Legacy publication has an untracked GitHub verdict comment",
          "ambiguous_publication",
          { prNumber: publication.number, marker: rendered.marker },
        );
      }
      verdictEvidence.verifiedAt = new Date().toISOString();
    }

    const localBaseBefore = (await git(record.repo, ["rev-parse", record.base])).stdout;
    const remoteBaseSha = await remoteBranchSha(record.repo, publication.remote, publication.base);
    try {
      await git(record.repo, [
        "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", publication.remote,
        `refs/heads/${publication.base}`,
      ], { timeout: 120_000 });
    } catch (error) {
      throw new CrewdeckError("Cannot fetch remote base evidence without updating refs", "containment_unavailable", {
        error: error.message,
      });
    }
    if ((await git(record.repo, ["rev-parse", record.base])).stdout !== localBaseBefore) {
      throw new CrewdeckError("Containment fetch unexpectedly changed the local base", "base_changed");
    }
    try {
      await git(record.repo, [
        "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", publication.remote, mergeCommit,
      ], { timeout: 120_000 });
    } catch {
      // Some forges refuse fetching an exact SHA. The advertised remote base may
      // still supply either the merge object or independent containment proof.
    }
    const [mergeProof, baseProof] = await Promise.all([
      gitAncestorProof(record.repo, candidate.head, mergeCommit),
      gitAncestorProof(record.repo, candidate.head, remoteBaseSha),
    ]);
    if (!mergeProof.ancestor && !baseProof.ancestor) {
      throw new CrewdeckError(
        "Approved candidate is not proven contained in the PR merge commit or current remote base",
        "approved_sha_not_contained",
        { candidate: candidate.head, mergeCommit, remoteBaseSha, mergeProof, baseProof },
      );
    }

    const agent = await liveAgent(record);
    if (agent.available && !["idle", "done"].includes(agent.state)) {
      throw new CrewdeckError(`Worker is ${agent.state}; reconciliation requires a settled writer`, "worker_not_settled");
    }
    if (!agent.available && !provenMissingAgent(agent)) {
      throw new CrewdeckError("Cannot prove build writer state", "agent_state_unknown", agent);
    }

    const snapshot = await gitSnapshot(record);
    if (snapshot.available) {
      const branch = (await git(record.worktree, ["branch", "--show-current"])).stdout;
      if (!snapshot.clean) {
        throw new CrewdeckError("Worktree is dirty; reconciliation never discards uncommitted data", "dirty_worktree", snapshot);
      }
      if (snapshot.head !== candidate.head || branch !== record.branch) {
        throw new CrewdeckError("Worktree no longer matches the latest approved candidate", "stale_candidate", {
          snapshot,
          branch,
        });
      }
    } else {
      let worktreeMissing = false;
      try {
        await stat(record.worktree);
      } catch (error) {
        if (error.code === "ENOENT") worktreeMissing = true;
        else throw error;
      }
      const priorProof = record.mergeReconciliation?.evidence?.worktree;
      if (
        !recovery ||
        !worktreeMissing ||
        priorProof?.clean !== true ||
        priorProof?.head !== candidate.head ||
        priorProof?.branch !== record.branch
      ) {
        throw new CrewdeckError("Cannot prove the build worktree clean", "worktree_state_unknown", snapshot);
      }
    }

    const branchRef = `refs/heads/${record.branch}`;
    let branchSha;
    try {
      branchSha = (await git(record.repo, ["rev-parse", "--verify", branchRef])).stdout;
    } catch (error) {
      if (!recovery) {
        throw new CrewdeckError("Owned build branch is missing", "missing_branch", { error: error.message });
      }
    }
    if (branchSha && branchSha !== candidate.head) {
      throw new CrewdeckError("Owned branch contains a newer or different candidate", "stale_candidate", {
        expected: candidate.head,
        actual: branchSha,
      });
    }

    const publicationFingerprint = JSON.stringify(publication);
    const reviewFingerprint = JSON.stringify(record.reviewInbox);
    const expectedPriorOperationId = record.mergeReconciliation?.operationId;
    const operationId = randomBytes(12).toString("hex");
    const startedAt = record.mergeReconciliation?.startedAt || new Date().toISOString();
    const proofAt = new Date().toISOString();
    const evidence = {
      pr: {
        repo: publication.repo,
        number: publication.number,
        url: publication.url,
        base: publication.base,
        head: publication.remoteHead,
        state: "MERGED",
        mergeCommit,
        mergedAt: pr.mergedAt,
      },
      candidate: {
        sha: candidate.head,
        version: candidate.version,
        reviewerTaskId: approval.reviewTaskId,
      },
      verdict: verdictEvidence,
      containment: {
        remoteBaseSha,
        mergeCommit,
        candidateAncestorOfMergeCommit: mergeProof.ancestor,
        candidateAncestorOfRemoteBase: baseProof.ancestor,
        verifiedAt: proofAt,
      },
      remote: { name: publication.remote, url: remoteUrl, repo: publication.repo },
      agent: { state: agent.state, available: agent.available },
      worktree: { clean: true, head: candidate.head, branch: record.branch, verifiedAt: proofAt },
    };

    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (
        !stored ||
        stored.status !== "running" ||
        stored.cleanedAt ||
        stored.resumeReservation ||
        JSON.stringify(stored.publication) !== publicationFingerprint ||
        stored.candidateCollectedVersion !== candidate.version ||
        JSON.stringify(stored.reviewInbox) !== reviewFingerprint ||
        stored.mergeReconciliation?.operationId !== expectedPriorOperationId
      ) {
        throw new CrewdeckError("Task state changed before reconciliation cleanup", "state_changed");
      }
      stored.mergeReconciliation = {
        status: "cleanup-pending",
        operationId,
        startedAt,
        lastAttemptAt: proofAt,
        attempts: (stored.mergeReconciliation?.attempts || 0) + 1,
        fromStatus: "running",
        evidence,
      };
      await saveState(next);
    });

    const recordFailure = async (error) => {
      try {
        await withStateLock(async () => {
          const next = await loadState();
          const stored = next.tasks[id];
          if (stored?.status === "running" && stored.mergeReconciliation?.operationId === operationId) {
            stored.mergeReconciliation.status = "cleanup-failed";
            stored.mergeReconciliation.failedAt = new Date().toISOString();
            stored.mergeReconciliation.lastError = error.message;
            stored.mergeReconciliation.lastErrorCode = error.code || "cleanup_failed";
            await saveState(next);
          }
        });
      } catch {
        // Preserve the original cleanup failure; a reservation still prevents a false terminal state.
      }
    };

    try {
      const closingAgent = await liveAgent(record);
      if (closingAgent.available && !["idle", "done"].includes(closingAgent.state)) {
        throw new CrewdeckError(`Worker became ${closingAgent.state} before cleanup`, "worker_not_settled");
      }
      if (!closingAgent.available && !provenMissingAgent(closingAgent)) {
        throw new CrewdeckError("Build writer state became unknown before cleanup", "agent_state_unknown", closingAgent);
      }
      if (closingAgent.available) {
        try {
          await run("herdr", ["agent", "send-keys", record.agentName, "ctrl+d"], { timeout: 10_000 });
        } catch (error) {
          if (closingAgent.state !== "done") {
            throw new CrewdeckError("Cannot close the settled build agent", "agent_cleanup_failed", {
              error: error.message,
            });
          }
          // A done agent may already have exited its pane. Removing the proven
          // isolated workspace remains the closing authority.
        }
      }

      const beforeCleanupState = await loadState();
      const beforeCleanupRecord = beforeCleanupState.tasks[id];
      const latestJournal = await readCandidateJournal(beforeCleanupRecord || record);
      const latestCandidate = latestJournal.available ? latestJournal.journal.candidates.at(-1) : undefined;
      const beforeCleanupSnapshot = await gitSnapshot(record);
      if (
        beforeCleanupRecord?.status !== "running" ||
        beforeCleanupRecord?.mergeReconciliation?.operationId !== operationId ||
        JSON.stringify(beforeCleanupRecord.publication) !== publicationFingerprint ||
        beforeCleanupRecord.candidateCollectedVersion !== candidate.version ||
        JSON.stringify(beforeCleanupRecord.reviewInbox) !== reviewFingerprint ||
        latestCandidate?.head !== candidate.head ||
        latestCandidate?.version !== candidate.version ||
        (beforeCleanupSnapshot.available &&
          (!beforeCleanupSnapshot.clean || beforeCleanupSnapshot.head !== candidate.head)) ||
        (!beforeCleanupSnapshot.available && !recovery)
      ) {
        throw new CrewdeckError("Candidate or durable state changed before cleanup", "state_changed");
      }
      if (await remoteBranchSha(record.repo, publication.remote, publication.base) !== remoteBaseSha) {
        throw new CrewdeckError("Remote base changed before cleanup; retry containment verification", "remote_base_changed");
      }

      let worktreeExists = true;
      try {
        await stat(record.worktree);
      } catch (error) {
        if (error.code === "ENOENT") worktreeExists = false;
        else throw error;
      }
      if (worktreeExists) {
        try {
          await runJson("herdr", ["worktree", "remove", "--workspace", record.workspaceId], {
            timeout: 30_000,
          });
        } catch (error) {
          throw new CrewdeckError("Cannot remove the isolated Herdr worktree", "worktree_cleanup_failed", {
            error: error.message,
          });
        }
      } else {
        const workspaceAbsent = await missingWorkspace(record);
        if (!workspaceAbsent) {
          try {
            await runJson("herdr", ["workspace", "close", record.workspaceId], { timeout: 15_000 });
          } catch (error) {
            throw new CrewdeckError("Cannot close the residual Herdr workspace", "workspace_cleanup_failed", {
              error: error.message,
            });
          }
        }
      }
      if (!(await missingWorkspace(record))) {
        throw new CrewdeckError("Herdr workspace still exists after cleanup", "workspace_cleanup_failed");
      }
      try {
        await stat(record.worktree);
        throw new CrewdeckError("Isolated worktree path still exists after cleanup", "worktree_cleanup_failed");
      } catch (error) {
        if (error instanceof CrewdeckError) throw error;
        if (error.code !== "ENOENT") throw error;
      }

      let worktrees = await listedWorktrees(record.repo);
      const registration = worktrees.find((item) => path.resolve(item.worktree) === path.resolve(record.worktree));
      if (registration) {
        if (!recovery || registration.branch !== branchRef) {
          throw new CrewdeckError("Unexpected Git worktree registration survived cleanup", "unsafe_git_metadata", registration);
        }
        await git(record.repo, ["worktree", "remove", "--force", record.worktree]);
        worktrees = await listedWorktrees(record.repo);
      }
      const otherCheckout = worktrees.find((item) => item.branch === branchRef);
      if (otherCheckout) {
        throw new CrewdeckError("Owned branch is checked out in another worktree", "unsafe_git_metadata", otherCheckout);
      }

      let currentBranchSha;
      try {
        currentBranchSha = (await git(record.repo, ["rev-parse", "--verify", branchRef])).stdout;
      } catch {
        currentBranchSha = undefined;
      }
      if (currentBranchSha && currentBranchSha !== candidate.head) {
        throw new CrewdeckError("Owned branch changed during cleanup and was preserved", "stale_candidate", {
          expected: candidate.head,
          actual: currentBranchSha,
        });
      }
      if (currentBranchSha) {
        await git(record.repo, ["update-ref", "-d", branchRef, candidate.head]);
      }
      try {
        await git(record.repo, ["rev-parse", "--verify", branchRef]);
        throw new CrewdeckError("Owned branch still exists after exact deletion", "branch_cleanup_failed");
      } catch (error) {
        if (error instanceof CrewdeckError && error.code === "branch_cleanup_failed") throw error;
        if (error.code !== "command_failed") throw error;
      }

      const afterAgent = await liveAgent(record);
      if (!provenMissingAgent(afterAgent) && !(afterAgent.available && afterAgent.state === "done")) {
        throw new CrewdeckError("Build agent did not close with its workspace", "agent_cleanup_failed", afterAgent);
      }

      const reconciledAt = new Date().toISOString();
      let reconciled;
      await withStateLock(async () => {
        const next = await loadState();
        const stored = next.tasks[id];
        if (
          stored?.status !== "running" ||
          stored.mergeReconciliation?.operationId !== operationId ||
          JSON.stringify(stored.publication) !== publicationFingerprint ||
          stored.candidateCollectedVersion !== candidate.version ||
          JSON.stringify(stored.reviewInbox) !== reviewFingerprint
        ) {
          throw new CrewdeckError("Task state changed after cleanup; terminal transition refused", "state_changed");
        }
        stored.status = "pr-merged";
        stored.prMergedAt = pr.mergedAt;
        stored.mergedReconciledAt = reconciledAt;
        stored.mergeReconciliation = {
          ...stored.mergeReconciliation,
          status: "merged-reconciled",
          reconciledAt,
          cleanup: {
            agentClosedAt: reconciledAt,
            workspaceClosedAt: reconciledAt,
            worktreeRemovedAt: reconciledAt,
            branchDeletedAt: reconciledAt,
          },
        };
        delete stored.error;
        reconciled = { ...stored };
        await saveState(next);
      });
      return mergedReconciliationResult(reconciled, false);
    } catch (error) {
      await recordFailure(error);
      throw error;
    }
  }


  return {
    forwardBaseAdvance,
    observePublishedPullRequests,
    reconcileMergedPullRequest,
  };
}
