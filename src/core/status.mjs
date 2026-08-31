import { createHash } from "node:crypto";

export const COLLECTION_LIMIT = 20;
export const DEFAULT_STATUS_LIMIT = 20;
export const MAX_STATUS_LIMIT = 50;
export const STATUS_OUTPUT_BUDGET_BYTES = 128 * 1024;

const TERMINAL_STATUSES = new Set(["cleaned", "orphan-reconciled", "retired", "pr-merged"]);
const STATUS_SCOPES = new Set(["active", "history", "all"]);

export function createStatusService({
  boundedStatusText,
  CrewdeckError,
  gitAncestorProof,
  gitSnapshot,
  liveAgent,
  loadConfig,
  loadState,
  publicCandidateJournal,
  publicTaskRecord,
  publicTaskReport,
  readCandidateJournal,
  readTaskReport,
  reviewRoundMax,
  safeDiagnosticText,
  taskIdPattern,
  normalizeStatusRecord,
}) {
  function operatorStatus(record, candidates, observedStatus, config) {
    const candidate = candidates?.available ? candidates.journal.candidates.at(-1) : undefined;
    const review = candidate && latestRelevantReview(record.reviewInbox, candidate.head);
    const intent = candidate && Array.isArray(record.publication?.verdictComments)
      ? record.publication.verdictComments.find((item) => item.headSha === candidate.head) : undefined;
    const baseAdvance = (record.baseAdvances || []).at(-1);
    let action = "inspect";
    let nextAction = "inspect task";
    if (baseAdvance?.status === "pending") {
      action = baseAdvance.classification === "unknown"
        ? "resolve-base-advance"
        : baseAdvance.classification === "compatible" && (record.publication?.number || baseAdvance.requiresRefresh === false)
          ? "settle-base-advance"
          : "forward-base-advance";
      nextAction = baseAdvance.classification === "unknown"
        ? "resolve unknown base compatibility; do not mutate or forward"
        : baseAdvance.classification === "compatible" && (record.publication?.number || baseAdvance.requiresRefresh === false)
          ? "settle compatible base advance without rewriting the candidate"
          : `forward base advance ${baseAdvance.sequence} to the sole writer`;
    } else if (baseAdvance?.status === "awaiting-writer") {
      action = "resume-build";
      nextAction = "resume the sole writer, then forward the pending base advance";
    } else if (baseAdvance?.status === "forwarding") {
      action = "retry-forward-base-advance";
      nextAction = "retry base-advance forwarding; delivery may be at-least-once";
    } else if (record.agentRetirement?.status === "retiring") {
      action = "retry-retire-agent";
      nextAction = "retry confirmed agent retirement with the same reason";
    } else if (record.prObservation?.status === "merged-awaiting-confirmed-reconciliation") {
      action = "reconcile-merged-pr";
      nextAction = "confirm merged PR reconciliation";
    } else if (["ambiguous", "dispatched"].includes(intent?.status)) {
      action = "reconcile-verdict";
      nextAction = "confirm verdict reconciliation";
    } else if (record.reviewEscalation && !record.reviewEscalation.resolvedAt) {
      action = "resolve-review-escalation";
      nextAction = "confirm review-round extension or decide escalation";
    } else if (observedStatus === "report-ready") {
      action = "collect-result";
      nextAction = "collect result";
    } else if (observedStatus === "candidate-submitted") {
      action = "collect-candidate";
      nextAction = "collect candidate";
    } else if (observedStatus === "candidate" && record.workflow === "reviewed-pr") {
      action = "spawn-review";
      nextAction = "spawn exact-SHA review";
    } else if (observedStatus === "candidate") {
      action = "prepare-integration";
      nextAction = "inspect diff and prepare integration";
    } else if (observedStatus === "review-changes-requested") {
      action = "forward-review";
      nextAction = "forward durable review";
    } else if (observedStatus === "review-approved" && !record.publication?.number) {
      action = "publish-pr";
      nextAction = "publish draft PR after checks";
    } else if (record.publication?.number) {
      action = "observe-pr";
      nextAction = "observe external PR; reconciliation remains confirmed";
    }
    return { action, nextAction, reviewRound: candidate?.version || 0, currentMaxReviewRounds: reviewRoundMax(record, config),
      escalation: record.reviewEscalation,
      pr: record.publication?.number ? { number: record.publication.number, url: record.publication.url, headSha: record.publication.headSha, state: record.prObservation?.status || "unobserved" } : undefined,
      verdictState: intent?.status || (review?.verdict ? `review-${review.verdict}` : "none"),
      checkState: record.publication?.checks?.status || "not-checked",
      baseAdvanceState: baseAdvance ? {
        sequence: baseAdvance.sequence, status: baseAdvance.status, classification: baseAdvance.classification,
        priorBaseSha: baseAdvance.priorBaseSha, newBaseSha: baseAdvance.newBaseSha, sourceTaskId: baseAdvance.sourceTaskId,
      } : undefined,
      observerState: record.prObservation?.status || "not-observed" };
  }


  function isTerminalStatusRecord(record) {
    return TERMINAL_STATUSES.has(record.status) || (record.status === "abandoned" && Boolean(record.cleanedAt));
  }

  function statusInteger(value) {
    return Number.isSafeInteger(value) ? value : undefined;
  }

  function latestRelevantReview(reviewInbox, head) {
    if (!head || !Array.isArray(reviewInbox)) return undefined;
    for (let index = reviewInbox.length - 1; index >= 0; index -= 1) {
      if (reviewInbox[index]?.reviewedHead === head) return reviewInbox[index];
    }
    return undefined;
  }

  function projectResultAvailability(result, ref) {
    const projected = result.available
      ? { available: true, ref, state: "available" }
      : { available: false, ref, state: result.state === "missing" ? "missing" : "error" };
    if (!result.available && result.error) projected.error = safeDiagnosticText(result.error, 512);
    return projected;
  }

  function projectLatestPrObservation(observation) {
    if (!observation || typeof observation !== "object") return undefined;
    const projected = {
      status: boundedStatusText(observation.status, 80),
      observedAt: boundedStatusText(observation.observedAt, 64),
    };
    if (observation.repo !== undefined) projected.repo = boundedStatusText(observation.repo, 256);
    if (statusInteger(observation.number) !== undefined) projected.number = observation.number;
    if (observation.url !== undefined) projected.url = boundedStatusText(observation.url, 512);
    if (observation.headSha !== undefined) projected.headSha = boundedStatusText(observation.headSha, 64);
    if (observation.mergedAt !== undefined) projected.mergedAt = boundedStatusText(observation.mergedAt, 64);
    if (observation.mergeCommit !== undefined) projected.mergeCommit = boundedStatusText(observation.mergeCommit, 64);
    return projected;
  }

  function terminalStatusSummary(record) {
    const summary = {
      id: boundedStatusText(record.id, 24),
      project: boundedStatusText(record.project, 64),
      kind: boundedStatusText(record.kind, 32),
      status: boundedStatusText(record.status, 64),
      observedStatus: boundedStatusText(record.status, 64),
    };
    const terminalAt = record.status === "pr-merged"
      ? record.mergedReconciledAt
      : record.cleanedAt || record.orphanReconciledAt || record.agentRetiredAt || record.abandonedAt;
    if (terminalAt) summary.terminalAt = boundedStatusText(terminalAt, 64);
    if (record.status === "pr-merged" && record.prMergedAt) summary.remotePrMergedAt = boundedStatusText(record.prMergedAt, 64);
    if (record.lifecycle === "report" || record.resultCollectedAt) summary.result = { ref: `result:${record.id}` };
    if (record.workflow === "reviewed-pr") summary.candidates = { ref: `candidates:${record.id}` };
    if (record.publication?.number) summary.publication = {
      number: statusInteger(record.publication.number),
      url: boundedStatusText(record.publication.url, 256),
    };
    return summary;
  }

  async function computeStatusRecord(config, state, storedRecord) {
    const record = normalizeStatusRecord(config, storedRecord);
    if (
      record.status === "cleaned" ||
      record.status === "orphan-reconciled" ||
      record.status === "retired" ||
      record.status === "pr-merged" ||
      (record.status === "abandoned" && record.cleanedAt)
    ) {
      const terminal = {
        ...publicTaskRecord(record),
        observedStatus: record.status,
        agent: { available: false, state: "closed" },
        git: { available: false, state: "worktree-removed" },
      };
      if (["abandoned", "orphan-reconciled"].includes(record.status) || record.contract === "review") {
        terminal.result = publicTaskReport(await readTaskReport(record));
      }
      if (record.status === "pr-merged") {
        terminal.candidates = publicCandidateJournal(await readCandidateJournal(record));
      }
      Object.assign(terminal, operatorStatus(record, terminal.candidates, terminal.observedStatus, config));
      if (record.contract === "review") {
        const parent = state.tasks[record.parentTaskId];
        const parentSnapshot = parent ? await gitSnapshot(parent) : { available: false };
        terminal.reviewValidity = {
          reviewedHead: record.reviewedHead,
          validForCurrentHead: parentSnapshot.available && parentSnapshot.head === record.reviewedHead,
        };
      }
      return terminal;
    }
    const [agent, snapshot, result, candidates] = await Promise.all([
      liveAgent(record),
      gitSnapshot(record),
      readTaskReport(record),
      readCandidateJournal(record),
    ]);
    let observedStatus = record.status;
    if (record.status === "abandoned" && !record.cleanedAt) observedStatus = "abandon-cleanup-pending";
    if (record.status === "running" && agent.state === "blocked") observedStatus = "blocked";
    if (record.lifecycle === "report" && result.available) {
      observedStatus = record.resultCollectedAt ? "report-collected" : "report-ready";
      if (record.contract === "review") {
        const parent = state.tasks[record.parentTaskId];
        const parentSnapshot = parent ? await gitSnapshot(parent) : { available: false };
        const stillCurrent =
          parentSnapshot.available &&
          parentSnapshot.head === record.reviewedHead &&
          result.report.reviewedHead === record.reviewedHead;
        observedStatus = stillCurrent
          ? record.resultCollectedAt ? "report-collected" : "review-ready"
          : "review-stale";
      }
    }
    if (record.workflow === "reviewed-pr" && candidates.available) {
      const candidate = candidates.journal.candidates.at(-1);
      if (candidate) {
        const review = latestRelevantReview(record.reviewInbox, candidate.head);
        if (!snapshot.available || snapshot.head !== candidate.head) observedStatus = "candidate-stale";
        else if ((record.candidateCollectedVersion || 0) < candidate.version) observedStatus = "candidate-submitted";
        else if (review?.validAtCollection) observedStatus = `review-${review.verdict}`;
        else observedStatus = "candidate";
      }
    }
    const pendingBaseRefresh = (record.baseAdvances || []).some((item) =>
      ["forwarding", "forwarded"].includes(item.status) && item.requiresRefresh !== false &&
      item.newBaseSha === record.requiredBaseSha
    );
    if (pendingBaseRefresh && snapshot.available) {
      const refreshed = await gitAncestorProof(record.repo, record.requiredBaseSha, snapshot.head);
      if (!refreshed.available || !refreshed.ancestor) observedStatus = "base-refresh-required";
    }
    if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
      observedStatus = `merge-${record.mergeReconciliation.status}`;
    }
    const reportedCommit = result.available ? result.report.payload?.commit : undefined;
    const commitMatches =
      typeof reportedCommit === "string" && snapshot.available && snapshot.head.startsWith(reportedCommit);
    if (
      record.lifecycle === "change" &&
      record.status === "running" &&
      ["idle", "done"].includes(agent.state) &&
      result.available &&
      snapshot.available &&
      snapshot.clean &&
      snapshot.ahead > 0 &&
      commitMatches
    ) {
      observedStatus = "candidate";
    }
    return {
      ...publicTaskRecord(record),
      observedStatus,
      agent,
      git: snapshot,
      result: publicTaskReport(result),
      candidates: publicCandidateJournal(candidates),
      ...operatorStatus(record, candidates, observedStatus, config),
    };
  }

  async function computeStatusSummaryRecord(config, state, storedRecord) {
    const record = normalizeStatusRecord(config, storedRecord);
    if (isTerminalStatusRecord(record)) return terminalStatusSummary(record);

    const needsResult = record.lifecycle === "report" || record.workflow === "direct";
    const needsCandidates = record.workflow === "reviewed-pr";
    const [agent, snapshot, result, candidates] = await Promise.all([
      liveAgent(record),
      gitSnapshot(record),
      needsResult ? readTaskReport(record) : Promise.resolve(undefined),
      needsCandidates ? readCandidateJournal(record) : Promise.resolve(undefined),
    ]);
    let observedStatus = record.status;
    if (record.status === "abandoned" && !record.cleanedAt) observedStatus = "abandon-cleanup-pending";
    if (record.status === "running" && agent.state === "blocked") observedStatus = "blocked";
    if (record.lifecycle === "report" && result?.available) {
      observedStatus = record.resultCollectedAt ? "report-collected" : "report-ready";
      if (record.contract === "review") {
        const parent = state.tasks[record.parentTaskId];
        const parentSnapshot = parent ? await gitSnapshot(parent) : { available: false };
        const stillCurrent =
          parentSnapshot.available &&
          parentSnapshot.head === record.reviewedHead &&
          result.report.reviewedHead === record.reviewedHead;
        observedStatus = stillCurrent
          ? record.resultCollectedAt ? "report-collected" : "review-ready"
          : "review-stale";
      }
    }

    const latestCandidate = candidates?.available ? candidates.journal.candidates.at(-1) : undefined;
    const latestReview = latestRelevantReview(record.reviewInbox, latestCandidate?.head);
    if (latestCandidate) {
      if (!snapshot.available || snapshot.head !== latestCandidate.head) observedStatus = "candidate-stale";
      else if ((record.candidateCollectedVersion || 0) < latestCandidate.version) observedStatus = "candidate-submitted";
      else if (latestReview?.validAtCollection) observedStatus = `review-${latestReview.verdict}`;
      else observedStatus = "candidate";
    }

    const pendingBaseRefresh = (record.baseAdvances || []).some((item) =>
      ["forwarding", "forwarded"].includes(item.status) && item.requiresRefresh !== false &&
      item.newBaseSha === record.requiredBaseSha
    );
    if (pendingBaseRefresh && snapshot.available) {
      const refreshed = await gitAncestorProof(record.repo, record.requiredBaseSha, snapshot.head);
      if (!refreshed.available || !refreshed.ancestor) observedStatus = "base-refresh-required";
    }
    if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
      observedStatus = `merge-${record.mergeReconciliation.status}`;
    }
    const reportedCommit = result?.available ? result.report.payload?.commit : undefined;
    const commitMatches =
      typeof reportedCommit === "string" && snapshot.available && snapshot.head.startsWith(reportedCommit);
    if (
      record.lifecycle === "change" &&
      record.status === "running" &&
      ["idle", "done"].includes(agent.state) &&
      result?.available &&
      snapshot.available &&
      snapshot.clean &&
      snapshot.ahead > 0 &&
      commitMatches
    ) {
      observedStatus = "candidate";
    }

    const operator = operatorStatus(record, candidates, observedStatus, config);
    const summary = {
      id: boundedStatusText(record.id, 24),
      project: boundedStatusText(record.project, 64),
      kind: boundedStatusText(record.kind, 32),
      workflow: boundedStatusText(record.workflow, 32),
      status: boundedStatusText(record.status, 64),
      observedStatus: boundedStatusText(observedStatus, 80),
      action: boundedStatusText(operator.action, 80),
      nextAction: boundedStatusText(operator.nextAction, 256),
      reviewRound: statusInteger(operator.reviewRound),
      currentMaxReviewRounds: statusInteger(operator.currentMaxReviewRounds),
      verdictState: boundedStatusText(operator.verdictState, 80),
      checkState: boundedStatusText(operator.checkState, 80),
      observerState: boundedStatusText(operator.observerState, 80),
      agent: {
        available: Boolean(agent.available),
        state: boundedStatusText(agent.state, 80),
        ...(!agent.available && agent.error ? { error: safeDiagnosticText(agent.error, 256) } : {}),
      },
      git: snapshot.available
        ? { available: true, clean: Boolean(snapshot.clean), ahead: statusInteger(snapshot.ahead), head: boundedStatusText(snapshot.head, 64) }
        : { available: false, ...(snapshot.error ? { error: safeDiagnosticText(snapshot.error, 256) } : {}) },
    };
    if (operator.escalation) {
      summary.escalation = {
        reviewTaskId: boundedStatusText(operator.escalation.reviewTaskId, 24),
        reviewedHead: boundedStatusText(operator.escalation.reviewedHead, 64),
        verdict: boundedStatusText(operator.escalation.verdict, 80),
        escalatedAt: boundedStatusText(operator.escalation.escalatedAt, 64),
        resolvedAt: boundedStatusText(operator.escalation.resolvedAt, 64),
      };
    }
    if (operator.pr) {
      summary.pr = {
        number: statusInteger(operator.pr.number),
        url: boundedStatusText(operator.pr.url, 256),
        headSha: boundedStatusText(operator.pr.headSha, 64),
        state: boundedStatusText(operator.pr.state, 80),
      };
    }
    if (result) summary.result = projectResultAvailability(result, `result:${record.id}`);
    if (candidates) {
      summary.candidates = {
        ...projectResultAvailability(candidates, `candidates:${record.id}`),
        count: candidates.available ? candidates.journal.candidates.length : 0,
      };
      if (latestCandidate) {
        summary.candidates.latest = {
          version: latestCandidate.version,
          head: boundedStatusText(latestCandidate.head, 64),
        };
      }
      let relevantCount = 0;
      if (latestCandidate && Array.isArray(record.reviewInbox)) {
        for (const item of record.reviewInbox) {
          if (item?.reviewedHead === latestCandidate.head) relevantCount += 1;
        }
      }
      summary.reviews = {
        count: Array.isArray(record.reviewInbox) ? record.reviewInbox.length : 0,
        relevantCount,
      };
      if (latestReview) {
        summary.reviews.latest = {
          reviewTaskId: boundedStatusText(latestReview.reviewTaskId, 24),
          candidateVersion: statusInteger(latestReview.candidateVersion),
          reviewedHead: boundedStatusText(latestReview.reviewedHead, 64),
          verdict: boundedStatusText(latestReview.verdict, 80),
          forwardStatus: boundedStatusText(latestReview.forwardStatus, 80),
          validAtCollection: Boolean(latestReview.validAtCollection),
        };
      }
    }
    if (operator.baseAdvanceState) {
      summary.baseAdvanceState = {
        sequence: statusInteger(operator.baseAdvanceState.sequence),
        status: boundedStatusText(operator.baseAdvanceState.status, 80),
        classification: boundedStatusText(operator.baseAdvanceState.classification, 80),
        priorBaseSha: boundedStatusText(operator.baseAdvanceState.priorBaseSha, 64),
        newBaseSha: boundedStatusText(operator.baseAdvanceState.newBaseSha, 64),
        sourceTaskId: boundedStatusText(operator.baseAdvanceState.sourceTaskId, 24),
      };
    }
    if (record.mergeReconciliation) {
      summary.mergeReconciliation = { status: boundedStatusText(record.mergeReconciliation.status, 80) };
      if (statusInteger(record.mergeReconciliation.prNumber) !== undefined) summary.mergeReconciliation.prNumber = record.mergeReconciliation.prNumber;
      if (record.mergeReconciliation.mergeCommit !== undefined) summary.mergeReconciliation.mergeCommit = boundedStatusText(record.mergeReconciliation.mergeCommit, 64);
      if (record.mergeReconciliation.lastError) summary.mergeReconciliation.error = safeDiagnosticText(record.mergeReconciliation.lastError);
      if (record.mergeReconciliation.reason) summary.mergeReconciliation.reason = safeDiagnosticText(record.mergeReconciliation.reason);
      if (record.mergeReconciliation.code) summary.mergeReconciliation.errorCode = boundedStatusText(record.mergeReconciliation.code, 80);
    }
    if (record.error) summary.error = safeDiagnosticText(record.error);
    if (record.errorCode) summary.errorCode = boundedStatusText(record.errorCode, 80);
    if (record.abandonmentReason) summary.reason = safeDiagnosticText(record.abandonmentReason);
    const observation = projectLatestPrObservation(record.prObservation);
    if (observation) {
      if (operator.pr) {
        delete observation.url;
        delete observation.number;
        delete observation.headSha;
      }
      summary.prObservation = observation;
    }
    return summary;
  }

  function actionStatusProjection(summary) {
    const projected = {
      id: summary.id,
      project: summary.project,
      state: summary.observedStatus || summary.status,
      action: summary.action || "inspect",
    };
    if (summary.errorCode) projected.errorCode = summary.errorCode;
    if (summary.action === "collect-result" && summary.result?.ref) projected.result = summary.result.ref;
    if (summary.candidates?.latest && ["collect-candidate", "spawn-review", "publish-pr"].includes(summary.action)) {
      projected.candidate = { version: summary.candidates.latest.version };
      if (summary.action === "collect-candidate") {
        projected.candidate.inboxKey = `${summary.id}@candidate-${summary.candidates.latest.version}`;
      } else {
        projected.candidate.head = summary.candidates.latest.head;
      }
    }
    if (summary.action === "forward-review" && summary.reviews?.latest?.reviewTaskId) {
      projected.review = summary.reviews.latest.reviewTaskId;
    }
    if (summary.currentMaxReviewRounds && summary.workflow === "reviewed-pr") {
      projected.round = `${summary.reviewRound || 0}/${summary.currentMaxReviewRounds}`;
    }
    if (summary.pr?.number) projected.pr = { number: summary.pr.number, state: summary.pr.state };
    if (summary.baseAdvanceState && ["resolve-base-advance", "settle-base-advance", "forward-base-advance", "retry-forward-base-advance", "resume-build"].includes(summary.action)) {
      projected.baseAdvance = {
        sequence: summary.baseAdvanceState.sequence,
        classification: summary.baseAdvanceState.classification,
        status: summary.baseAdvanceState.status,
      };
    }
    return projected;
  }

  async function getStatus(configPath, id) {
    const config = await loadConfig(configPath);
    const state = await loadState();
    const records = id ? [state.tasks[id]].filter(Boolean) : Object.values(state.tasks);
    if (id && records.length === 0) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    return Promise.all(records.map((storedRecord) => computeStatusRecord(config, state, storedRecord)));
  }

  async function getTaskStatus(configPath, id) {
    if (!taskIdPattern.test(id || "")) throw new CrewdeckError("A valid task id is required", "invalid_task_id");
    const config = await loadConfig(configPath);
    const state = await loadState();
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    return computeStatusSummaryRecord(config, state, record);
  }

  async function getTaskActionStatus(configPath, id) {
    return actionStatusProjection(await getTaskStatus(configPath, id));
  }

  function statusGeneration(records, scope) {
    return createHash("sha256").update(`${scope}\n${records.map((record) => `${record.id}:${record.status}:${record.cleanedAt || ""}`).join("\n")}`).digest("hex").slice(0, 16);
  }

  function encodeStatusCursor(scope, generation, after) {
    return Buffer.from(JSON.stringify({ v: 1, scope, generation, after }), "utf8").toString("base64url");
  }

  function decodeStatusCursor(cursor, scope, generation, records) {
    if (cursor === undefined || cursor === null || cursor === "" || cursor === 0) return 0;
    if (Number.isSafeInteger(cursor) && cursor >= 0) return cursor;
    if (typeof cursor !== "string") throw new CrewdeckError("Status cursor must be an opaque cursor string", "invalid_status_cursor");
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.v !== 1 || decoded.scope !== scope || decoded.generation !== generation || typeof decoded.after !== "string") {
        throw new Error("cursor scope or generation changed");
      }
      const index = records.findIndex((record) => record.id === decoded.after);
      if (index < 0) throw new Error("cursor task no longer exists in this scope");
      return index + 1;
    } catch (error) {
      throw new CrewdeckError(`Status cursor is stale or invalid; restart pagination: ${error.message}`, "invalid_status_cursor");
    }
  }

  function statusCursorScope(cursor) {
    if (typeof cursor !== "string" || cursor === "") {
      throw new CrewdeckError("Status cursor must be an opaque cursor string", "invalid_status_cursor");
    }
    try {
      const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
      if (decoded.v !== 1 || typeof decoded.scope !== "string") throw new Error("cursor scope missing");
      return decoded.scope;
    } catch (error) {
      throw new CrewdeckError(`Status cursor is stale or invalid; restart pagination: ${error.message}`, "invalid_status_cursor");
    }
  }

  async function getStatusView(configPath, { id, mode = "detail", scope, limit, cursor } = {}) {
    if (!["action", "detail", "bounded", "diagnostic"].includes(mode)) {
      throw new CrewdeckError("Status mode must be action, detail, or diagnostic", "invalid_status_mode");
    }
    if (id && (scope !== undefined || limit !== undefined || cursor !== undefined)) {
      throw new CrewdeckError("Status id is incompatible with status pagination arguments", "invalid_status_arguments");
    }
    if (mode === "diagnostic" && !id) throw new CrewdeckError("Diagnostic status requires exactly one task id", "invalid_status_arguments");
    if (id) {
      if (mode === "diagnostic") return getStatus(configPath, id);
      if (["detail", "bounded"].includes(mode)) return getTaskStatus(configPath, id);
      return getTaskActionStatus(configPath, id);
    }
    const page = await getStatusSummary(configPath, { scope, limit, cursor });
    if (["detail", "bounded"].includes(mode)) return page;
    return {
      scope: page.scope,
      total: page.pagination.total,
      ...(page.pagination.nextCursor ? { nextCursor: page.pagination.nextCursor } : {}),
      tasks: page.tasks.map(actionStatusProjection),
    };
  }

  async function getStatusSummary(
    configPath,
    { scope = "active", limit = DEFAULT_STATUS_LIMIT, cursor = 0 } = {},
  ) {
    if (!STATUS_SCOPES.has(scope)) {
      throw new CrewdeckError("Status scope must be active, history, or all", "invalid_status_scope");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STATUS_LIMIT) {
      throw new CrewdeckError(`Status limit must be a safe integer from 1 to ${MAX_STATUS_LIMIT}`, "invalid_status_limit");
    }
    const config = await loadConfig(configPath);
    const state = await loadState();
    const records = Object.values(state.tasks)
      .filter((record) => {
        const terminal = isTerminalStatusRecord(record);
        return scope === "all" || (scope === "history" ? terminal : !terminal);
      })
      .sort((left, right) => {
        const leftId = String(left.id || "");
        const rightId = String(right.id || "");
        return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
      });
    const generation = statusGeneration(records, scope);
    const offset = decodeStatusCursor(cursor, scope, generation, records);
    const selected = records.slice(offset, offset + limit);
    const tasks = await Promise.all(selected.map((record) => computeStatusSummaryRecord(config, state, record)));
    const nextCursor = offset + tasks.length < records.length
      ? encodeStatusCursor(scope, generation, selected.at(-1).id)
      : null;
    const page = {
      scope,
      pagination: { cursor: cursor || null, generation, limit, returned: tasks.length, total: records.length, nextCursor },
      tasks,
    };
    const bytes = Buffer.byteLength(JSON.stringify(page, null, 2), "utf8");
    if (bytes > STATUS_OUTPUT_BUDGET_BYTES) {
      throw new CrewdeckError(`Serialized status page exceeds the ${STATUS_OUTPUT_BUDGET_BYTES}-byte budget`, "status_output_budget", { bytes });
    }
    return page;
  }


  return {
    getStatus,
    getStatusSummary,
    getStatusView,
    getTaskActionStatus,
    getTaskStatus,
    statusCursorScope,
  };
}
