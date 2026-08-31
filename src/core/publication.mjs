import { createHash } from "node:crypto";
import path from "node:path";

export function createPublicationService({
  CrewdeckError,
  exactHeadRepository,
  git,
  gitAncestorProof,
  githubRepositoryFromUrl,
  gitSnapshot,
  liveAgent,
  loadConfig,
  loadState,
  publicTaskRecord,
  readCandidateJournal,
  resolveChangeBase,
  resolveProject,
  run,
  runJson,
  saveState,
  taskIdPattern,
  validBranchName,
  validRemoteName,
  validRepositoryName,
  withStateLock,
}) {
  const VERDICT_COMMENT_MAX_BYTES = 48 * 1024;
  const REVIEW_SEVERITIES = new Set(["blocking", "major", "minor", "nit"]);

  function truncateUtf8(value, maxBytes) {
    const text = String(value);
    if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
    const suffix = "\n… [truncated by Crewdeck]";
    const available = maxBytes - Buffer.byteLength(suffix, "utf8");
    let bytes = 0;
    let truncated = "";
    for (const character of text) {
      const size = Buffer.byteLength(character, "utf8");
      if (bytes + size > available) break;
      truncated += character;
      bytes += size;
    }
    return `${truncated}${suffix}`;
  }

  function safeReviewJson(value, maxBytes) {
    const json = JSON.stringify(value, null, 2).replace(/[\u202a-\u202e\u2066-\u2069]/g, (character) =>
      `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
    );
    const escaped = json
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll("@", "&#64;&#8203;");
    return truncateUtf8(escaped, maxBytes);
  }

  function validatedVerdictPayload(taskId, candidate, approval) {
    if (
      !taskIdPattern.test(taskId) ||
      !approval ||
      approval.verdict !== "approved" ||
      approval.reviewedHead !== candidate.head ||
      approval.candidateVersion !== candidate.version ||
      !taskIdPattern.test(approval.reviewTaskId || "") ||
      typeof approval.summary !== "string" ||
      !approval.summary ||
      !Array.isArray(approval.checks) ||
      approval.checks.length > 100 ||
      approval.checks.some((item) => typeof item !== "string") ||
      !Array.isArray(approval.findings) ||
      approval.findings.length > 100 ||
      approval.findings.some((finding) =>
        !finding ||
        !REVIEW_SEVERITIES.has(finding.severity) ||
        finding.severity === "blocking" ||
        ["title", "detail", "location", "recommendation"].some(
          (field) => typeof finding[field] !== "string",
        )
      ) ||
      !Array.isArray(approval.openQuestions) ||
      approval.openQuestions.length > 100 ||
      approval.openQuestions.some((item) => typeof item !== "string")
    ) {
      throw new CrewdeckError("Approved reviewer data is invalid", "invalid_review_result");
    }
    return {
      verdict: approval.verdict,
      approvedSha: candidate.head,
      reviewerTaskId: approval.reviewTaskId,
      candidateVersion: candidate.version,
      taskId,
      summary: approval.summary,
      checks: approval.checks,
      findings: approval.findings,
      openQuestions: approval.openQuestions,
    };
  }

  function renderVerdictComment(taskId, candidate, approval) {
    const payload = validatedVerdictPayload(taskId, candidate, approval);
    const marker = `<!-- crewdeck-verdict:${taskId}:${candidate.head} -->`;
    const body = [
      marker,
      "## Crewdeck immutable reviewed-PR verdict",
      "",
      "This append-only audit comment is bound to one exact commit. Crewdeck never edits or deletes it, even if the PR head later changes.",
      "**This comment is not an official GitHub approval.**",
      "",
      "### Verdict identity",
      "<pre>",
      safeReviewJson({
        verdict: payload.verdict,
        approvedSha: payload.approvedSha,
        reviewerTaskId: payload.reviewerTaskId,
        candidateVersion: payload.candidateVersion,
        taskId: payload.taskId,
      }, 2 * 1024),
      "</pre>",
      "",
      "### Summary",
      "<pre>",
      safeReviewJson(payload.summary, 7 * 1024),
      "</pre>",
      "",
      "### Checks",
      "<pre>",
      safeReviewJson(payload.checks, 8 * 1024),
      "</pre>",
      "",
      "### Findings",
      "<pre>",
      safeReviewJson(payload.findings, 20 * 1024),
      "</pre>",
      "",
      "### Open questions",
      "<pre>",
      safeReviewJson(payload.openQuestions, 8 * 1024),
      "</pre>",
    ].join("\n");
    if (
      Buffer.byteLength(body, "utf8") > VERDICT_COMMENT_MAX_BYTES ||
      body.split(marker).length !== 2
    ) {
      throw new CrewdeckError("Rendered verdict comment exceeds its safe bound", "verdict_comment_too_large");
    }
    return {
      marker,
      body,
      contentSha256: createHash("sha256").update(body, "utf8").digest("hex"),
    };
  }

  function verdictCommentIdentity(comment, repo, prNumber, expectedBody) {
    if (
      !comment ||
      comment.body !== expectedBody ||
      !Number.isInteger(comment.id) ||
      comment.id < 1 ||
      typeof comment.html_url !== "string"
    ) {
      throw new CrewdeckError("GitHub returned an invalid verdict comment identity", "invalid_comment_identity");
    }
    let commentUrl;
    try {
      commentUrl = new URL(comment.html_url);
    } catch {
      throw new CrewdeckError("GitHub returned an invalid verdict comment URL", "invalid_comment_identity");
    }
    if (
      commentUrl.protocol !== "https:" ||
      commentUrl.hostname.toLowerCase() !== "github.com" ||
      commentUrl.pathname.toLowerCase() !== `/${repo}/pull/${prNumber}`.toLowerCase() ||
      commentUrl.hash !== `#issuecomment-${comment.id}`
    ) {
      throw new CrewdeckError("Verdict comment identity does not belong to the exact PR", "invalid_comment_identity");
    }
    return { id: comment.id, url: comment.html_url };
  }

  async function findVerdictComment(repo, prNumber, marker, expectedBody) {
    const comments = [];
    for (let page = 1; page <= 100; page += 1) {
      let listed;
      try {
        listed = await runJson("gh", [
          "api", `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
        ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
      } catch (error) {
        throw new CrewdeckError("Cannot list immutable verdict comments", "forge_unavailable", {
          error: error.message,
        });
      }
      if (!Array.isArray(listed) || listed.length > 100) {
        throw new CrewdeckError("GitHub comment page is invalid", "invalid_comment_lookup");
      }
      comments.push(...listed);
      if (listed.length < 100) break;
      if (page === 100) {
        throw new CrewdeckError("GitHub comment lookup exceeds its 10,000-comment bound", "invalid_comment_lookup");
      }
    }
    let markerCount = 0;
    let markedComment;
    for (const comment of comments) {
      if (typeof comment?.body !== "string") continue;
      let offset = 0;
      while (true) {
        const found = comment.body.indexOf(marker, offset);
        if (found < 0) break;
        markerCount += 1;
        markedComment = comment;
        offset = found + marker.length;
      }
    }
    if (markerCount > 1) {
      throw new CrewdeckError("The immutable verdict marker collides on this PR", "verdict_comment_collision", {
        marker,
        occurrences: markerCount,
      });
    }
    if (markerCount === 0) return undefined;
    if (markedComment.body !== expectedBody) {
      throw new CrewdeckError("The immutable verdict marker has divergent content", "verdict_comment_divergent", {
        marker,
      });
    }
    return verdictCommentIdentity(markedComment, repo, prNumber, expectedBody);
  }

  function matchingVerdictIntent(publication, headSha) {
    const entries = publication?.verdictComments || [];
    if (!Array.isArray(entries)) {
      throw new CrewdeckError("Durable verdict intent journal is invalid", "verdict_comment_divergent");
    }
    const matches = entries.filter((item) => item?.headSha === headSha);
    if (matches.length > 1) {
      throw new CrewdeckError("Durable verdict comment intent collides for this SHA", "verdict_comment_collision");
    }
    return matches[0];
  }

  function validateVerdictIntent(intent, { marker, contentSha256, prNumber, approval }) {
    if (
      !["dispatched", "ambiguous", "published"].includes(intent.status) ||
      intent.marker !== marker ||
      intent.contentSha256 !== contentSha256 ||
      intent.prNumber !== prNumber ||
      intent.reviewerTaskId !== approval.reviewTaskId ||
      intent.candidateVersion !== approval.candidateVersion
    ) {
      throw new CrewdeckError("Durable verdict intent has divergent immutable content", "verdict_comment_divergent");
    }
  }

  async function currentApprovedVerdict(id, fallbackRecord, expectedHead, expectedVersion, expectedReviewTaskId) {
    const state = await loadState();
    const record = state.tasks[id];
    if (!record || record.cleanedAt || ["cleaned", "integrated", "abandoned", "pr-merged"].includes(record.status)) {
      throw new CrewdeckError("Build became terminal before verdict publication", "stale_candidate");
    }
    if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
      throw new CrewdeckError("Build is reserved for merged PR reconciliation", "reconciliation_in_progress");
    }
    const [snapshot, journal] = await Promise.all([
      gitSnapshot(record),
      readCandidateJournal(record),
    ]);
    const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
    const approval = (record.reviewInbox || [])
      .filter((item) =>
        item.reviewTaskId === expectedReviewTaskId &&
        item.reviewedHead === expectedHead &&
        item.verdict === "approved" &&
        item.validAtCollection
      )
      .at(-1);
    if (
      !snapshot.available ||
      !snapshot.clean ||
      snapshot.head !== expectedHead ||
      candidate?.head !== expectedHead ||
      candidate?.version !== expectedVersion ||
      (record.candidateCollectedVersion || 0) < expectedVersion ||
      !approval ||
      (record.reviewEscalation && record.reviewEscalation.reviewedHead === expectedHead)
    ) {
      throw new CrewdeckError("Approved candidate became stale before verdict comment POST", "stale_candidate", {
        approvedHead: expectedHead,
        currentHead: snapshot.head,
        currentCandidateHead: candidate?.head,
      });
    }
    if (
      record.repo !== fallbackRecord.repo ||
      record.worktree !== fallbackRecord.worktree ||
      record.branch !== fallbackRecord.branch
    ) {
      throw new CrewdeckError("Build resources changed before verdict publication", "state_changed");
    }
    validatedVerdictPayload(id, candidate, approval);
    return { record, snapshot, candidate, approval };
  }

  async function inspectGitHubChecks(project, repo, headSha) {
    const checkedAt = new Date().toISOString();
    if (project.githubChecks === "none") {
      return { policy: "none", status: "disabled", headSha, checkedAt, reason: "project explicitly opts out of GitHub checks" };
    }
    let checks;
    let statuses;
    try {
      [checks, statuses] = await Promise.all([
        runJson("gh", ["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
        runJson("gh", ["api", `repos/${repo}/commits/${headSha}/status?per_page=100`], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      ]);
    } catch (error) {
      return { policy: "required", status: "unavailable", headSha, checkedAt, reason: error.message };
    }
    if (!Array.isArray(checks?.check_runs) || !Number.isInteger(checks.total_count) || checks.total_count !== checks.check_runs.length || checks.check_runs.length > 100 || statuses?.sha !== headSha || !Array.isArray(statuses.statuses) || statuses.statuses.length > 100) {
      return { policy: "required", status: "ambiguous", headSha, checkedAt, reason: "invalid or stale-SHA GitHub checks response" };
    }
    const stale = checks.check_runs.some((item) => item?.head_sha !== headSha);
    const checkStates = checks.check_runs.map((item) => ({ name: item.name, status: item.status, conclusion: item.conclusion }));
    const contextStates = statuses.statuses.map((item) => ({ context: item.context, state: item.state }));
    let status = "passing";
    let reason;
    if (stale) ({ status, reason } = { status: "stale", reason: "a check run belongs to another SHA" });
    else if (checkStates.length + contextStates.length === 0) ({ status, reason } = { status: "missing", reason: "no checks or status contexts exist" });
    else if (checkStates.some((item) => item.status !== "completed") || contextStates.some((item) => item.state === "pending")) ({ status, reason } = { status: "pending", reason: "checks have not completed" });
    else if (checkStates.some((item) => !["success", "neutral", "skipped"].includes(item.conclusion)) || contextStates.some((item) => item.state !== "success")) ({ status, reason } = { status: "failing", reason: "one or more checks failed" });
    return { policy: "required", status, headSha, checkedAt, checks: checkStates, contexts: contextStates, ...(reason ? { reason } : {}) };
  }

  function requirePassingChecks(observation, phase) {
    if (!["passing", "disabled"].includes(observation.status)) {
      throw new CrewdeckError(`GitHub checks refuse ${phase}: ${observation.reason || observation.status}`, "github_checks_not_passing", observation);
    }
  }

  async function observePublishedVerdict(id, approvedHead) {
    try {
      const state = await loadState();
      const record = state.tasks[id];
      if (!record) return { status: "unknown", approvedHead, error: "task missing" };
      const [snapshot, journal] = await Promise.all([gitSnapshot(record), readCandidateJournal(record)]);
      const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
      const stillApproved = (record.reviewInbox || []).some((item) =>
        item.reviewedHead === approvedHead && item.verdict === "approved" && item.validAtCollection
      );
      const current =
        snapshot.available &&
        snapshot.clean &&
        snapshot.head === approvedHead &&
        candidate?.head === approvedHead &&
        stillApproved;
      return {
        status: current ? "current" : "stale",
        approvedHead,
        currentHead: snapshot.head,
        currentCandidateHead: candidate?.head,
      };
    } catch (error) {
      return { status: "unknown", approvedHead, error: error.message };
    }
  }

  async function publishPullRequest(
    configPath,
    id,
    { remote, repo, base, head, title, body },
  ) {
    const config = await loadConfig(configPath);
    if (!validRemoteName(remote) || !validRepositoryName(repo) || !validBranchName(base) || !validBranchName(head)) {
      throw new CrewdeckError("remote, repo, base, and head must be explicit valid GitHub publication targets", "invalid_publication_target");
    }
    if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !body.trim()) {
      throw new CrewdeckError("Draft PR title and body are required", "invalid_publication_target");
    }
    const intendedTitle = title.trim();
    const intendedBody = body.trim();
    const state = await loadState();
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    record.kind ||= record.profile === "scout" ? "scout" : "build";
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
    record.workflow ||= "direct";
    if (record.lifecycle !== "change" || record.workflow !== "reviewed-pr") {
      throw new CrewdeckError("Draft PR publication requires a reviewed-pr build", "invalid_publication_task");
    }
    if (record.status === "cleaned" || record.cleanedAt || ["integrated", "abandoned", "pr-merged"].includes(record.status)) {
      throw new CrewdeckError("Terminal builds cannot be published", "invalid_publication_task");
    }
    if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
      throw new CrewdeckError("Build is reserved for merged PR reconciliation", "reconciliation_in_progress");
    }
    const project = resolveProject(config, record.project);
    if (
      record.branch !== `crew/${id}` ||
      head !== record.branch ||
      base !== record.base ||
      head === base ||
      path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
      path.resolve(record.repo) !== project.path
    ) {
      throw new CrewdeckError("Publication must push only the task-owned crew branch, never the base", "unsafe_publication_ref");
    }
    const agent = await liveAgent(record);
    if (agent.available && !["idle", "done"].includes(agent.state)) {
      throw new CrewdeckError(`Build writer is ${agent.state}; publication requires a settled writer`, "worker_not_settled");
    }
    if (!agent.available && !/agent[^\n]*(not[_ -]?found|missing)|not[_ -]?found[^\n]*agent/i.test(agent.error || "")) {
      throw new CrewdeckError("Cannot prove build writer state before publication", "agent_state_unknown", agent);
    }
    const [snapshot, journal] = await Promise.all([gitSnapshot(record), readCandidateJournal(record)]);
    if (!snapshot.available || !snapshot.clean) {
      throw new CrewdeckError("Publication refuses a dirty or unavailable build worktree", "dirty_worktree", snapshot);
    }
    if (record.requiredBaseSha) {
      const requiredBase = await gitAncestorProof(record.repo, record.requiredBaseSha, snapshot.head);
      if (!requiredBase.available || !requiredBase.ancestor) {
        throw new CrewdeckError("Current candidate does not contain the required advanced base", "base_refresh_required", requiredBase);
      }
    }
    if (snapshot.ahead < 1) throw new CrewdeckError("Current candidate has no commits ahead of base", "no_commits");
    const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
    if (!candidate) throw new CrewdeckError("No reviewed-pr candidate is available", "missing_candidate");
    if (snapshot.head !== candidate.head) {
      throw new CrewdeckError("Build HEAD changed after candidate submission", "stale_candidate");
    }
    if ((record.candidateCollectedVersion || 0) < candidate.version) {
      throw new CrewdeckError("Current candidate has not been collected", "candidate_not_collected");
    }
    const approval = (record.reviewInbox || [])
      .filter((item) => item.reviewedHead === snapshot.head && item.verdict === "approved" && item.validAtCollection)
      .at(-1);
    if (!approval) throw new CrewdeckError("Current HEAD has no collected approved review", "review_not_approved");
    if (record.reviewEscalation && record.reviewEscalation.reviewedHead === snapshot.head) {
      throw new CrewdeckError("Current review requires escalation", "review_not_approved");
    }

    let remoteUrl;
    try {
      remoteUrl = (await git(record.worktree, ["remote", "get-url", "--push", remote])).stdout;
    } catch (error) {
      throw new CrewdeckError(`Git remote '${remote}' is unavailable`, "remote_unavailable", { error: error.message });
    }
    const remoteRepo = githubRepositoryFromUrl(remoteUrl);
    if (!remoteRepo || remoteRepo.toLowerCase() !== repo.toLowerCase()) {
      throw new CrewdeckError("Git remote is not the requested GitHub repository", "remote_repo_mismatch", { remoteUrl, repo });
    }
    try {
      await run("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 15_000 });
    } catch (error) {
      throw new CrewdeckError("GitHub credentials are unavailable", "credentials_unavailable", { error: error.message });
    }
    let forgeRepo;
    try {
      forgeRepo = await runJson("gh", ["repo", "view", repo, "--json", "nameWithOwner"], { timeout: 20_000 });
    } catch (error) {
      throw new CrewdeckError("GitHub repository is unavailable through gh", "forge_unavailable", { error: error.message });
    }
    if (forgeRepo?.nameWithOwner?.toLowerCase() !== repo.toLowerCase()) {
      throw new CrewdeckError("gh resolved a different GitHub repository", "forge_repo_mismatch", forgeRepo);
    }

    const baseRef = `refs/heads/${base}`;
    const remoteRef = `refs/heads/${head}`;
    const readRemoteSha = async (ref) => {
      const output = (await git(record.worktree, ["ls-remote", "--heads", remote, ref], { timeout: 30_000 })).stdout;
      if (!output) return undefined;
      const lines = output.split("\n").filter(Boolean);
      if (lines.length !== 1) throw new CrewdeckError(`Remote ref ${ref} is ambiguous`, "ambiguous_remote_ref");
      const [sha, foundRef] = lines[0].split(/\s+/);
      if (!/^[0-9a-f]{40}$/.test(sha || "") || foundRef !== ref) {
        throw new CrewdeckError(`Remote returned an invalid ref for ${ref}`, "invalid_remote_ref");
      }
      return sha;
    };
    const publicationBaseSha = await readRemoteSha(baseRef);
    if (!publicationBaseSha) {
      throw new CrewdeckError(`Remote base ${base} does not exist`, "remote_base_missing");
    }
    let configuredBaseEvidence = { source: "publication-remote", remote, sha: publicationBaseSha, verifiedAt: new Date().toISOString() };
    if (record.baseSource?.mode === "remote") {
      const resolved = await resolveChangeBase(project);
      configuredBaseEvidence = { source: "configured-base-remote", remote: record.baseSource.remote, sha: resolved.sha, verifiedAt: new Date().toISOString() };
    }
    if (record.baseSha && configuredBaseEvidence.sha !== record.baseSha) {
      throw new CrewdeckError("Configured reviewed base advanced after spawn; a new candidate/review contract is required", "base_advanced", {
        pinnedBaseSha: record.baseSha, currentBaseSha: configuredBaseEvidence.sha, baseSource: record.baseSource,
      });
    }
    if (record.baseSha && publicationBaseSha !== record.baseSha) {
      throw new CrewdeckError("Publication base differs from the pinned reviewed base", "base_drift", {
        pinnedBaseSha: record.baseSha, publicationBaseSha, remote, base,
      });
    }

    const prFields = [
      "number", "url", "isDraft", "headRefName", "baseRefName", "headRefOid",
      "isCrossRepository", "headRepository", "headRepositoryOwner", "state", "title", "body",
    ].join(",");
    const validatePr = (pr, expectedHeadSha = undefined) => {
      const urlMatch = typeof pr?.url === "string"
        ? pr.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i)
        : undefined;
      if (
        !pr ||
        !Number.isInteger(pr.number) ||
        !urlMatch ||
        urlMatch[1].toLowerCase() !== repo.toLowerCase() ||
        Number(urlMatch[2]) !== pr.number ||
        typeof pr.title !== "string" ||
        typeof pr.body !== "string" ||
        pr.isDraft !== true ||
        pr.headRefName !== head ||
        pr.baseRefName !== base ||
        pr.isCrossRepository !== false ||
        !exactHeadRepository(pr.headRepository, pr.headRepositoryOwner, repo) ||
        (pr.state !== undefined && pr.state !== "OPEN") ||
        (expectedHeadSha !== undefined && pr.headRefOid !== expectedHeadSha)
      ) {
        throw new CrewdeckError("Existing GitHub PR is not the expected open draft", "invalid_existing_pr", pr);
      }
      return pr;
    };
    const validateExactPr = (pr, expectedHeadSha = undefined) => {
      const validated = validatePr(pr, expectedHeadSha);
      if (
        validated.title !== intendedTitle ||
        validated.body !== intendedBody ||
        validated.baseRefName !== base
      ) {
        throw new CrewdeckError(
          "GitHub PR title, body, or base does not match the intended publication",
          "invalid_existing_pr",
          validated,
        );
      }
      return validated;
    };

    const publication = record.publication;
    if (
      publication &&
      (publication.remote !== remote ||
        publication.repo.toLowerCase() !== repo.toLowerCase() ||
        publication.base !== base ||
        publication.remoteHead !== head)
    ) {
      throw new CrewdeckError("Publication target cannot change after first attempt", "publication_target_mismatch");
    }
    let existingPr;
    if (publication?.number) {
      try {
        existingPr = validatePr(await runJson("gh", [
          "pr", "view", String(publication.number), "--repo", repo,
          "--json", prFields,
        ], { timeout: 20_000 }));
      } catch (error) {
        if (error instanceof CrewdeckError && error.code === "invalid_existing_pr") throw error;
        throw new CrewdeckError("Stored draft PR is unavailable", "forge_unavailable", { error: error.message });
      }
    } else {
      let listed;
      try {
        listed = await runJson("gh", [
          "pr", "list", "--repo", repo, "--head", head, "--base", base, "--state", "open",
          "--json", prFields, "--limit", "2",
        ], { timeout: 20_000 });
      } catch (error) {
        throw new CrewdeckError("Cannot query GitHub draft PRs", "forge_unavailable", { error: error.message });
      }
      if (!Array.isArray(listed) || listed.length > 1) {
        throw new CrewdeckError("GitHub PR lookup is invalid or ambiguous", "ambiguous_pull_request", listed);
      }
      if (listed.length === 1) existingPr = validatePr(listed[0]);
    }

    let remoteSha = await readRemoteSha(remoteRef);
    const ownedRemote =
      !remoteSha ||
      publication?.remoteSha === remoteSha ||
      (remoteSha === snapshot.head && existingPr?.headRefName === head);
    if (!ownedRemote) {
      throw new CrewdeckError("Remote head exists but is not owned by this durable publication", "remote_head_changed", {
        expected: publication?.remoteSha,
        actual: remoteSha,
      });
    }
    let pushedAt = publication?.pushedAt;
    if (remoteSha !== snapshot.head) {
      const lease = `--force-with-lease=${remoteRef}:${remoteSha || ""}`;
      await git(record.worktree, ["push", lease, remote, `${snapshot.head}:${remoteRef}`], { timeout: 120_000 });
      remoteSha = await readRemoteSha(remoteRef);
      if (remoteSha !== snapshot.head) {
        throw new CrewdeckError("Remote head does not equal the approved SHA after push", "push_verification_failed");
      }
      pushedAt = new Date().toISOString();
    }
    const afterPush = await gitSnapshot(record);
    if (!afterPush.available || !afterPush.clean || afterPush.head !== snapshot.head) {
      throw new CrewdeckError("Build HEAD changed during publication; review and CI are stale", "stale_candidate");
    }

    const attemptAt = new Date().toISOString();
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (!stored) throw new CrewdeckError("Build disappeared during publication", "state_changed");
      stored.publication = {
        ...(stored.publication || {}),
        remote,
        repo,
        base,
        remoteHead: head,
        remoteSha,
        title: intendedTitle,
        body: intendedBody,
        headSha: snapshot.head,
        baseEvidence: configuredBaseEvidence,
        pushedAt,
        createdAt: stored.publication?.createdAt || attemptAt,
        firstAttemptAt: stored.publication?.firstAttemptAt || attemptAt,
        lastAttemptAt: attemptAt,
      };
      await saveState(next);
    });

    let pr = existingPr;
    let prCreatedAt = publication?.prCreatedAt;
    if (!pr) {
      try {
        await run("gh", [
          "pr", "create", "--draft", "--repo", repo, "--base", base, "--head", head,
          "--title", intendedTitle, "--body", intendedBody,
        ], { timeout: 60_000 });
      } catch (error) {
        throw new CrewdeckError("Draft PR creation failed; retry will reconcile by head/base", "pr_create_failed", {
          error: error.message,
          remoteSha,
        });
      }
      const listed = await runJson("gh", [
        "pr", "list", "--repo", repo, "--head", head, "--base", base, "--state", "open",
        "--json", prFields, "--limit", "2",
      ], { timeout: 20_000 });
      if (!Array.isArray(listed) || listed.length !== 1) {
        throw new CrewdeckError("Created draft PR cannot be reconciled uniquely", "ambiguous_pull_request", listed);
      }
      pr = validateExactPr(listed[0], snapshot.head);
      prCreatedAt = new Date().toISOString();
    } else if (
      pr.title !== intendedTitle ||
      pr.body !== intendedBody ||
      pr.baseRefName !== base ||
      publication?.headSha !== snapshot.head
    ) {
      try {
        await run("gh", [
          "api", "--method", "PATCH", `repos/${repo}/pulls/${pr.number}`,
          "--raw-field", `title=${intendedTitle}`,
          "--raw-field", `body=${intendedBody}`,
          "--raw-field", `base=${base}`,
        ], { timeout: 30_000 });
      } catch (error) {
        throw new CrewdeckError(
          "Draft PR REST update failed; retry will re-read authoritative PR state",
          "pr_update_failed",
          { error: error.message, number: pr.number, remoteSha },
        );
      }
      try {
        pr = validateExactPr(await runJson("gh", [
          "pr", "view", String(pr.number), "--repo", repo,
          "--json", prFields,
        ], { timeout: 20_000 }), snapshot.head);
      } catch (error) {
        if (error instanceof CrewdeckError && error.code === "invalid_existing_pr") throw error;
        throw new CrewdeckError("Cannot verify the draft PR after REST update", "forge_unavailable", {
          error: error.message,
        });
      }
    }

    const updatedAt = new Date().toISOString();
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (!stored?.publication || stored.publication.remoteSha !== snapshot.head) {
        throw new CrewdeckError("Publication state changed before PR persistence", "state_changed");
      }
      stored.publication = {
        ...stored.publication,
        number: pr.number,
        url: pr.url,
        draft: true,
        prCreatedAt: stored.publication.prCreatedAt || prCreatedAt || updatedAt,
        updatedAt,
        lastVerifiedAt: updatedAt,
      };
      await saveState(next);
    });

    const checkObservation = await inspectGitHubChecks(project, repo, snapshot.head);
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (!stored?.publication || stored.publication.number !== pr.number || stored.publication.headSha !== snapshot.head) {
        throw new CrewdeckError("Publication changed before checks persistence", "state_changed");
      }
      stored.publication.checks = checkObservation;
      await saveState(next);
    });
    requirePassingChecks(checkObservation, "publication completion");

    const prWasIdempotent =
      publication?.headSha === snapshot.head &&
      publication?.title === intendedTitle &&
      publication?.body === intendedBody &&
      existingPr?.number === pr.number &&
      existingPr?.title === intendedTitle &&
      existingPr?.body === intendedBody &&
      existingPr?.baseRefName === base;
    const readExactCommentPr = async () => {
      try {
        return validateExactPr(await runJson("gh", [
          "pr", "view", String(pr.number), "--repo", repo, "--json", prFields,
        ], { timeout: 20_000 }), snapshot.head);
      } catch (error) {
        if (error instanceof CrewdeckError && error.code === "invalid_existing_pr") throw error;
        throw new CrewdeckError("Cannot validate the exact draft PR before verdict POST", "forge_unavailable", {
          error: error.message,
        });
      }
    };

    // The exact PR and approved local state are checked after PR create/REST update and
    // immediately around marker lookup. No comment POST is allowed before these checks.
    await readExactCommentPr();
    let current = await currentApprovedVerdict(
      id,
      record,
      snapshot.head,
      candidate.version,
      approval.reviewTaskId,
    );
    let rendered = renderVerdictComment(id, current.candidate, current.approval);
    let foundComment = await findVerdictComment(repo, pr.number, rendered.marker, rendered.body);

    const intentMetadata = {
      headSha: snapshot.head,
      marker: rendered.marker,
      contentSha256: rendered.contentSha256,
      prNumber: pr.number,
      reviewerTaskId: current.approval.reviewTaskId,
      candidateVersion: current.candidate.version,
    };
    const persistCommentIdentity = async (identity, { adopted = false } = {}) => {
      let persisted;
      await withStateLock(async () => {
        const next = await loadState();
        const stored = next.tasks[id];
        if (
          !stored?.publication ||
          stored.publication.number !== pr.number ||
          stored.publication.repo?.toLowerCase() !== repo.toLowerCase() ||
          stored.publication.base !== base ||
          stored.publication.remoteHead !== head
        ) {
          throw new CrewdeckError("Publication target changed before verdict identity persistence", "state_changed");
        }
        stored.publication.verdictComments ||= [];
        let intent = matchingVerdictIntent(stored.publication, snapshot.head);
        if (!intent) {
          if (!adopted) {
            throw new CrewdeckError("Durable verdict dispatch intent is missing", "state_changed");
          }
          intent = { ...intentMetadata, status: "published" };
          stored.publication.verdictComments.push(intent);
        } else {
          validateVerdictIntent(intent, {
            ...rendered,
            prNumber: pr.number,
            approval: current.approval,
          });
        }
        if (intent.comment && (intent.comment.id !== identity.id || intent.comment.url !== identity.url)) {
          throw new CrewdeckError("Durable verdict comment identity changed", "verdict_comment_collision");
        }
        intent.status = "published";
        intent.comment = identity;
        persisted = { record: { ...stored }, intent: { ...intent } };
        await saveState(next);
      });
      return persisted;
    };
    const publicationResult = async (persisted, { adopted, idempotent }) => ({
      published: true,
      idempotent: prWasIdempotent && idempotent,
      task: publicTaskRecord(persisted.record),
      publication: persisted.record.publication,
      verdictComment: {
        ...persisted.intent.comment,
        marker: persisted.intent.marker,
        headSha: persisted.intent.headSha,
        reviewerTaskId: persisted.intent.reviewerTaskId,
        candidateVersion: persisted.intent.candidateVersion,
        immutable: true,
        adopted,
      },
      currentVerdictState: await observePublishedVerdict(id, snapshot.head),
    });

    if (foundComment) {
      const persisted = await persistCommentIdentity(foundComment, { adopted: true });
      return publicationResult(persisted, { adopted: true, idempotent: true });
    }

    // Recheck both authorities after lookup. This catches a stale HEAD/PR before
    // the first and only possible comment POST for this task+SHA marker.
    current = await currentApprovedVerdict(
      id,
      record,
      snapshot.head,
      candidate.version,
      approval.reviewTaskId,
    );
    const rerendered = renderVerdictComment(id, current.candidate, current.approval);
    if (rerendered.body !== rendered.body || rerendered.marker !== rendered.marker) {
      throw new CrewdeckError("Approved verdict data changed before dispatch", "state_changed");
    }
    rendered = rerendered;
    await readExactCommentPr();
    current = await currentApprovedVerdict(
      id,
      record,
      snapshot.head,
      candidate.version,
      approval.reviewTaskId,
    );
    if (renderVerdictComment(id, current.candidate, current.approval).body !== rendered.body) {
      throw new CrewdeckError("Approved verdict data changed before dispatch", "state_changed");
    }

    let shouldPost = false;
    let existingIntentStatus;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (
        !stored?.publication ||
        stored.publication.number !== pr.number ||
        stored.publication.headSha !== snapshot.head ||
        stored.publication.remoteSha !== snapshot.head
      ) {
        throw new CrewdeckError("Publication changed before verdict dispatch", "state_changed");
      }
      const lockedApproval = (stored.reviewInbox || []).find((item) =>
        item.reviewTaskId === approval.reviewTaskId &&
        item.reviewedHead === snapshot.head &&
        item.verdict === "approved" &&
        item.validAtCollection
      );
      if (
        stored.cleanedAt ||
        ["cleaned", "integrated", "abandoned", "pr-merged"].includes(stored.status) ||
        ["cleanup-pending", "cleanup-failed"].includes(stored.mergeReconciliation?.status) ||
        (stored.candidateCollectedVersion || 0) < candidate.version ||
        !lockedApproval ||
        (stored.reviewEscalation && stored.reviewEscalation.reviewedHead === snapshot.head) ||
        renderVerdictComment(id, current.candidate, lockedApproval).body !== rendered.body
      ) {
        throw new CrewdeckError("Approved candidate state changed before verdict dispatch", "stale_candidate");
      }
      stored.publication.verdictComments ||= [];
      const intent = matchingVerdictIntent(stored.publication, snapshot.head);
      if (intent) {
        validateVerdictIntent(intent, {
          ...rendered,
          prNumber: pr.number,
          approval: current.approval,
        });
        existingIntentStatus = intent.status;
        return;
      }
      stored.publication.verdictComments.push({
        ...intentMetadata,
        status: "dispatched",
        dispatchedAt: new Date().toISOString(),
      });
      shouldPost = true;
      await saveState(next);
    });

    if (!shouldPost) {
      // A concurrent or interrupted caller owns the sole dispatch. Reconcile only;
      // absence is durably ambiguous and can never authorize an automatic repost.
      foundComment = await findVerdictComment(repo, pr.number, rendered.marker, rendered.body);
      if (foundComment) {
        const persisted = await persistCommentIdentity(foundComment, { adopted: true });
        return publicationResult(persisted, { adopted: true, idempotent: true });
      }
      await withStateLock(async () => {
        const next = await loadState();
        const stored = next.tasks[id];
        const intent = matchingVerdictIntent(stored?.publication, snapshot.head);
        if (intent && intent.status !== "published") {
          validateVerdictIntent(intent, {
            ...rendered,
            prNumber: pr.number,
            approval: current.approval,
          });
          intent.status = "ambiguous";
          intent.ambiguousAt ||= new Date().toISOString();
          await saveState(next);
        }
      });
      throw new CrewdeckError(
        existingIntentStatus === "published"
          ? "Published immutable verdict comment is no longer present; Crewdeck will not replace it"
          : "Verdict dispatch outcome is ambiguous; Crewdeck will not issue a second POST",
        existingIntentStatus === "published" ? "verdict_comment_missing" : "verdict_comment_ambiguous",
        { marker: rendered.marker, prNumber: pr.number },
      );
    }

    let postedIdentity;
    try {
      const posted = await runJson("gh", [
        "api", "--method", "POST", `repos/${repo}/issues/${pr.number}/comments`,
        "--raw-field", `body=${rendered.body}`,
      ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
      postedIdentity = verdictCommentIdentity(posted, repo, pr.number, rendered.body);
    } catch (error) {
      // The dispatched intent is intentionally left intact. A later invocation
      // may only relist/adopt; it can never compensate or send another POST.
      throw new CrewdeckError(
        "Verdict comment POST may have been applied; retry will reconcile without reposting",
        "verdict_comment_post_ambiguous",
        { error: error.message, marker: rendered.marker, prNumber: pr.number },
      );
    }
    const persisted = await persistCommentIdentity(postedIdentity);
    return publicationResult(persisted, { adopted: false, idempotent: false });
  }

  async function reconcileVerdictComment(configPath, id, { reason } = {}) {
    await loadConfig(configPath);
    if (typeof reason !== "string" || !reason.trim()) throw new CrewdeckError("Verdict reconciliation requires a durable reason", "invalid_reason");
    const state = await loadState();
    const record = state.tasks[id];
    if (!record?.publication?.number || !record.publication.repo) throw new CrewdeckError("Task has no exact published PR", "publication_incomplete");
    const journal = await readCandidateJournal(record);
    const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
    const approval = candidate && (record.reviewInbox || []).find((item) => item.reviewedHead === candidate.head && item.verdict === "approved" && item.validAtCollection);
    if (!candidate || !approval || record.publication.headSha !== candidate.head) throw new CrewdeckError("Current exact approval/publication evidence is missing", "invalid_approval_evidence");
    const rendered = renderVerdictComment(id, candidate, approval);
    const intent = matchingVerdictIntent(record.publication, candidate.head);
    if (!intent || !["dispatched", "ambiguous"].includes(intent.status)) {
      if (intent?.status === "published") return { reconciled: true, idempotent: true, intent };
      throw new CrewdeckError("No ambiguous exact verdict dispatch can be reconciled", "verdict_reconciliation_not_applicable");
    }
    validateVerdictIntent(intent, { ...rendered, prNumber: record.publication.number, approval });
    let found;
    let refusal;
    try {
      found = await findVerdictComment(record.publication.repo, record.publication.number, rendered.marker, rendered.body);
      if (!found) refusal = { code: "verdict_comment_absent", message: "Exact immutable verdict comment is absent" };
    } catch (error) {
      refusal = { code: error.code || "verdict_lookup_failed", message: error.message, details: error.details };
    }
    const reconciledAt = new Date().toISOString();
    let persisted;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      const current = matchingVerdictIntent(stored?.publication, candidate.head);
      if (!current || current.contentSha256 !== rendered.contentSha256 || !["dispatched", "ambiguous"].includes(current.status)) {
        throw new CrewdeckError("Verdict intent changed concurrently", "state_changed");
      }
      stored.verdictReconciliations ||= [];
      const outcome = { headSha: candidate.head, prNumber: record.publication.number, reason: reason.trim(), reconciledAt,
        outcome: found ? "adopted-exact" : "refused", ...(refusal ? { refusal } : {}) };
      stored.verdictReconciliations.push(outcome);
      if (found) {
        current.status = "published";
        current.comment = found;
        current.reconciledAt = reconciledAt;
        current.reconciliationReason = reason.trim();
      }
      persisted = { outcome, intent: { ...current } };
      await saveState(next);
    });
    if (!found) throw new CrewdeckError(refusal.message, refusal.code, { ...refusal.details, durableOutcome: persisted.outcome });
    return { reconciled: true, idempotent: false, ...persisted };
  }


  return {
    findVerdictComment,
    inspectGitHubChecks,
    matchingVerdictIntent,
    publishPullRequest,
    reconcileVerdictComment,
    renderVerdictComment,
    requirePassingChecks,
    validatedVerdictPayload,
  };
}
