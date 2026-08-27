import { watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createCompletionWakeController } from "../../../src/completion-wake.mjs";
import { createCrewCommand } from "../../../src/crew-view.mjs";
import {
  abandonTask,
  cleanupTask,
  collectResults,
  getPendingResultIds,
  getStatus,
  forwardReviewFindings,
  forwardBaseAdvance,
  extendReviewRounds,
  getTaskDiff,
  loadConfig,
  mergeTask,
  observePublishedPullRequests,
  prepareIntegration,
  promptTask,
  publishPullRequest,
  reconcileMergedPullRequest,
  reconcileOrphanReport,
  reconcileVerdictComment,
  recoverStateLock,
  reportDirectory,
  retireTaskAgent,
  resumeBuild,
  stateLockStatus,
  spawnBatch,
  spawnReview,
} from "../../../src/core.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG = process.env.CREWDECK_CONFIG || path.join(ROOT, "crewdeck.json");

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

async function validateProfiles(params: any, ctx: any) {
  const config = await loadConfig(CONFIG);
  const names = new Set<string>();
  for (const task of params.tasks) names.add(task.profile || params.profile || config.defaultProfile);
  for (const name of names) {
    const profile = config.profiles[name];
    if (!profile) throw new Error(`Unknown Crewdeck profile '${name}'`);
    const model = ctx.modelRegistry.find(profile.provider, profile.model);
    if (!model) {
      throw new Error(
        `Profile '${name}' references unavailable Pi model ${profile.provider}/${profile.model}`,
      );
    }
    if (profile.thinking !== "off" && model.reasoning === false) {
      throw new Error(`Profile '${name}' requests thinking=${profile.thinking} on a non-reasoning model`);
    }
    const mappedLevel = model.thinkingLevelMap?.[profile.thinking];
    if (mappedLevel === null) {
      throw new Error(`Profile '${name}' uses unsupported thinking level ${profile.thinking}`);
    }
    if (["xhigh", "max"].includes(profile.thinking) && typeof mappedLevel !== "string") {
      throw new Error(
        `Profile '${name}' must explicitly map extended thinking level ${profile.thinking}`,
      );
    }
    const auth = await ctx.modelRegistry.getProviderAuth(profile.provider);
    if (!auth) throw new Error(`Profile '${name}' provider ${profile.provider} has no usable authentication`);
  }
}

export default function crewdeckExtension(pi: ExtensionAPI) {
  let reportWatcher: FSWatcher | undefined;
  let observerTimer: ReturnType<typeof setInterval> | undefined;
  let activeContext: any;
  const completionWake = createCompletionWakeController({
    listPending: () => getPendingResultIds(CONFIG),
    sendFollowUp: (ready: string[]) => {
      const taskIds = [...new Set(ready.map((key) => key.split("@")[0]))];
      pi.sendUserMessage(
        `CREWDECK COMPLETION: durable inbox events are ready: ${ready.join(", ")}. ` +
          `Call crew_status for task ids ${taskIds.join(", ")}, then crew_collect_results with the exact inbox keys. ` +
          "For a collected changes-requested review, use crew_forward_review so durable structured findings reach the parent build through steering; never message it from the reviewer.",
        { deliverAs: "followUp" },
      );
    },
    onReady: (ready: string[], pending: string[]) => {
      activeContext?.ui.notify(`Crewdeck result ready: ${ready.join(", ")}`, "info");
      activeContext?.ui.setStatus("crewdeck", `crewdeck: ${pending.length} result(s) ready`);
    },
    onError: (error: Error) => {
      activeContext?.ui.notify(`Crewdeck wake delivery failed: ${error.message}`, "warning");
    },
  });
  pi.registerTool({
    name: "crew_spawn_batch",
    label: "Spawn Crew",
    description:
      "Launch one to five Pi workers concurrently in visible Herdr worktree workspaces for a registered project. Kind permissions, tools, skills, lifecycle, and cleanup come from config/kinds.yml.",
    parameters: Type.Object({
      project: Type.String({ description: "Registered project name from crewdeck.json" }),
      profile: Type.Optional(Type.String({ description: "Default profile for this batch" })),
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "Unique lowercase task id, max 24 characters" }),
          kind: Type.String({
            description: "Task kind configured in config/kinds.yml",
          }),
          task: Type.String({ description: "Concrete task and acceptance criteria" }),
          profile: Type.Optional(Type.String({ description: "Optional per-task profile override" })),
          workflow: Type.Optional(Type.String({ description: "direct (default) or reviewed-pr for change tasks" })),
        }),
        { minItems: 1, maxItems: 5 },
      ),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      await validateProfiles(params, ctx);
      return text(await spawnBatch(CONFIG, params));
    },
  });

  pi.registerTool({
    name: "crew_spawn_review",
    label: "Spawn Exact-SHA Reviewer",
    description:
      "Launch the one configured read-only review kind in a proven detached worktree for exactly the current collected candidate SHA of a reviewed-pr build. Refuses concurrent or duplicate reviewers.",
    parameters: Type.Object({
      id: Type.String({ description: "Unique review task id" }),
      parentTaskId: Type.String({ description: "Reviewed-pr build task id" }),
      reviewedHead: Type.String({ description: "Exact 40-character current candidate SHA" }),
      task: Type.String({ description: "Concrete review scope and acceptance criteria" }),
      profile: Type.Optional(Type.String({ description: "Optional reviewer profile" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const config = await loadConfig(CONFIG);
      const reviewKinds = Object.entries(config.kinds).filter(([, kind]: any) => kind.contract === "review");
      if (reviewKinds.length !== 1) throw new Error("Configure exactly one review contract kind");
      await validateProfiles({
        tasks: [{ kind: reviewKinds[0][0], profile: params.profile, task: params.task, id: params.id }],
      }, ctx);
      return text(await spawnReview(CONFIG, params));
    },
  });

  pi.registerTool({
    name: "crew_status",
    label: "Crew Status",
    description: "Read current Herdr and Git state for all Crewdeck tasks or one task without waking workers.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      return text(await getStatus(CONFIG, params.id));
    },
  });

  pi.registerTool({
    name: "crew_collect_results",
    label: "Collect Crew Results",
    description:
      "Collect durable structured results submitted by Crewdeck workers. Report kinds configured for after-collection are safely closed; change kinds remain available through integration.",
    parameters: Type.Object({
      ids: Type.Optional(Type.Array(Type.String(), { maxItems: 20 })),
      keepReports: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      const results = await collectResults(CONFIG, params.ids, {
        cleanupReports: params.keepReports !== true,
      });
      ctx.ui.setStatus("crewdeck", "crewdeck");
      return text(results);
    },
  });

  pi.registerTool({
    name: "crew_diff",
    label: "Inspect Build Diff",
    description:
      "Return bounded commits, diffstat, and patch for a Crewdeck change branch before integration. Refuses report tasks and truncates patches above 40 KB.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      return text(await getTaskDiff(CONFIG, params.id));
    },
  });

  pi.registerTool({
    name: "crew_steer",
    label: "Steer Worker",
    description: "Send a concise follow-up or conflict-resolution instruction to an existing Crewdeck worker.",
    parameters: Type.Object({
      id: Type.String(),
      message: Type.String(),
      wait: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params) {
      return text(await promptTask(CONFIG, params.id, params.message, { wait: params.wait }));
    },
  });

  pi.registerTool({
    name: "crew_forward_review",
    label: "Forward Durable Review",
    description:
      "After collecting a review, forward its exact durable changes-requested findings to the parent build through Herdr steering. Refuses stale or approved reviews and escalates blocked/inconclusive or exhausted rounds.",
    parameters: Type.Object({
      reviewId: Type.String(),
      wait: Type.Optional(Type.Boolean({ default: false })),
    }),
    async execute(_id, params) {
      return text(await forwardReviewFindings(CONFIG, params.reviewId, { wait: params.wait }));
    },
  });

  pi.registerTool({
    name: "crew_resume_build",
    label: "Resume Reviewed-PR Build",
    description:
      "Safely adopt a reviewed-pr build only after proving its prior Herdr agent absent and its owned crew branch/workspace intact. Preserves a single writer.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      return text(await resumeBuild(CONFIG, params.id));
    },
  });

  pi.registerTool({
    name: "crew_publish_pr",
    label: "Publish Draft Pull Request",
    description:
      "Idempotently push only the approved current SHA, create/update its GitHub draft PR, then append one bounded immutable verdict comment for task+SHA. Reconciles exact markers under a durable dispatch intent; ambiguity fails closed without repost, edit, delete, approval, ready, or merge.",
    parameters: Type.Object({
      id: Type.String(),
      remote: Type.String(),
      repo: Type.String({ description: "GitHub owner/name" }),
      base: Type.String(),
      head: Type.String({ description: "Remote head; must equal the task-owned crew/<id> branch" }),
      title: Type.String(),
      body: Type.String(),
    }),
    async execute(_id, params) {
      return text(await publishPullRequest(CONFIG, params.id, params));
    },
  });

  pi.registerTool({
    name: "crew_reconcile_verdict",
    label: "Reconcile Ambiguous Verdict",
    description: "Separately confirmed read-only GitHub reconciliation. Re-lists only the exact immutable marker/body and adopts an exact match; never reposts, edits, or deletes. Durable reason and refusal outcome are recorded.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_reconcile_verdict requires interactive confirmation");
      const confirmed = await ctx.ui.confirm("Reconcile immutable verdict evidence?", `Read only PR comments for '${params.id}' and adopt only an exact marker/body match? Reason: ${params.reason}`);
      if (!confirmed) return text({ reconciled: false, reason: "user declined" });
      return text(await reconcileVerdictComment(CONFIG, params.id, { reason: params.reason }));
    },
  });

  pi.registerTool({
    name: "crew_extend_review_rounds",
    label: "Extend Review Rounds",
    description: "Confirmed monotonic per-task review-round extension with durable reason and concurrent expected-current-max guard. Does not rewrite candidate or review history.",
    parameters: Type.Object({ id: Type.String(), currentMax: Type.Integer({ minimum: 1, maximum: 50 }), newMax: Type.Integer({ minimum: 2, maximum: 50 }), reason: Type.String({ minLength: 1, maxLength: 4000 }) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_extend_review_rounds requires interactive confirmation");
      const confirmed = await ctx.ui.confirm("Extend this task's review rounds?", `Extend '${params.id}' from ${params.currentMax} to ${params.newMax} without rewriting history? Reason: ${params.reason}`);
      if (!confirmed) return text({ extended: false, reason: "user declined" });
      return text(await extendReviewRounds(CONFIG, params.id, params));
    },
  });

  pi.registerTool({
    name: "crew_retire_agent",
    label: "Retire Stalled Agent",
    description: "Confirmed retirement of a provably absent agent or an explicitly terminated one. Preserves all dirty/unintegrated change work; a clean dead reviewer can release its isolated resources for replacement.",
    parameters: Type.Object({ id: Type.String(), reason: Type.String({ minLength: 1, maxLength: 4000 }), terminate: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_retire_agent requires interactive confirmation");
      const confirmed = await ctx.ui.confirm("Retire task agent?", `Retire '${params.id}'${params.terminate ? " by explicitly terminating it" : " only if absent"}; preserve unintegrated change work? Reason: ${params.reason}`);
      if (!confirmed) return text({ retired: false, reason: "user declined" });
      return text(await retireTaskAgent(CONFIG, params.id, params));
    },
  });

  pi.registerTool({
    name: "crew_state_lock",
    label: "Diagnose/Recover State Lock",
    description: "Diagnose the verifiable local state-lock owner. Recovery is separately confirmed, never steals an active lock, and requires a durable reason.",
    parameters: Type.Object({ recover: Type.Optional(Type.Boolean({ default: false })), reason: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!params.recover) return text(await stateLockStatus());
      if (!params.reason) throw new Error("crew_state_lock recovery requires a reason");
      if (!ctx.hasUI) throw new Error("crew_state_lock recovery requires interactive confirmation");
      const confirmed = await ctx.ui.confirm("Recover stale Crewdeck state lock?", `Never steal an active lock; quarantine only a dead or grace-aged unverifiable lock? Reason: ${params.reason}`);
      if (!confirmed) return text({ recovered: false, reason: "user declined" });
      return text(await recoverStateLock({ reason: params.reason }));
    },
  });

  pi.registerTool({
    name: "crew_observe_prs",
    label: "Observe Published PRs",
    description: "Read-only authenticated exact-identity rescan of Crewdeck PRs. Closed-unmerged, lookup failures, and unknown states are never treated as merged.",
    parameters: Type.Object({ id: Type.Optional(Type.String()) }),
    async execute(_id, params) { return text(await observePublishedPullRequests(CONFIG, params.id)); },
  });

  pi.registerTool({
    name: "crew_forward_base_advance",
    label: "Forward Base Advance",
    description: "Controlled delivery of one durable, locally classified base advance to the affected sole writer. Unknown evidence fails closed; compatible published PRs are preserved without rewriting.",
    parameters: Type.Object({ id: Type.String(), sequence: Type.Optional(Type.Integer({ minimum: 1 })), wait: Type.Optional(Type.Boolean({ default: false })) }),
    async execute(_id, params) {
      return text(await forwardBaseAdvance(CONFIG, params.id, params.sequence, { wait: params.wait }));
    },
  });

  pi.registerTool({
    name: "crew_reconcile_merged_pr",
    label: "Reconcile Externally Merged PR",
    description:
      "Finalize a reviewed-pr build only after proving its exact durable GitHub PR is MERGED and its latest collected approved/publication SHA is contained in the merge commit or current remote base. Refuses present ambiguous, dispatched, partial, or divergent verdict evidence; only a wholly absent legacy verdict journal may bootstrap as legacy-absent after every other proof succeeds. Never mutates GitHub comments, pushes, merges, or changes a base; preserves all audit history and always asks for independent confirmation.",
    parameters: Type.Object({ id: Type.String({ description: "Reviewed-pr build task id" }) }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_reconcile_merged_pr requires interactive confirmation");
      const confirmed = await ctx.ui.confirm(
        "Reconcile externally merged pull request?",
        `Verify the exact GitHub merge for task '${params.id}', then close only its isolated worker workspace and delete its proven-contained crew branch? Crewdeck will not push, merge, or change the local/remote base.`,
      );
      if (!confirmed) return text({ reconciled: false, reason: "user declined" });
      return text(await reconcileMergedPullRequest(CONFIG, params.id));
    },
  });

  pi.registerTool({
    name: "crew_prepare_integration",
    label: "Prepare Integration",
    description:
      "Rebase one settled worker branch onto the current local base and run that project's configured verification commands. Does not merge. On conflict, keep the worktree for its original worker to resolve.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params) {
      return text(await prepareIntegration(CONFIG, params.id));
    },
  });

  pi.registerTool({
    name: "crew_merge",
    label: "Merge Worker",
    description:
      "Fast-forward a previously prepared Crewdeck branch into its local base branch. Always asks the user for interactive confirmation and never pushes remotely.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_merge requires interactive confirmation");
      const confirmed = await ctx.ui.confirm(
        "Merge Crewdeck task?",
        `Fast-forward task '${params.id}' into its configured local base branch? This does not push.`,
      );
      if (!confirmed) return text({ merged: false, reason: "user declined" });
      return text(await mergeTask(CONFIG, params.id));
    },
  });

  pi.registerTool({
    name: "crew_abandon",
    label: "Abandon Worker",
    description:
      "Explicitly abandon a clean, non-integrated change task, then close its agent/workspace and remove only its isolated worktree and branch. Refuses report, integrated, cleaned, already abandoned, active, or dirty tasks and always asks for independent confirmation.",
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.Optional(Type.String({ description: "Durable reason this change is no longer needed" })),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_abandon requires interactive confirmation");
      const confirmed = await ctx.ui.confirm(
        "Abandon unintegrated Crewdeck task?",
        `Permanently discard the committed change branch for task '${params.id}' and remove its isolated worktree? The base branch is not changed and nothing is pushed.`,
      );
      if (!confirmed) return text({ abandoned: false, reason: "user declined" });
      return text(await abandonTask(CONFIG, params.id, { reason: params.reason }));
    },
  });

  pi.registerTool({
    name: "crew_reconcile_orphan_report",
    label: "Reconcile Orphan Report",
    description:
      "Explicitly finalize a report task only after its Herdr workspace and Git worktree were manually removed. Requires a durable reason and independent confirmation, preserves reports/history, refuses surviving resources, dirty worktrees, unintegrated commits, change tasks, and uncertain absence, and never changes base or pushes.",
    parameters: Type.Object({
      id: Type.String(),
      reason: Type.String({ description: "Durable reason the report resources were removed outside Crewdeck" }),
    }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_reconcile_orphan_report requires interactive confirmation");
      const confirmed = await ctx.ui.confirm(
        "Reconcile orphaned report task?",
        `Confirm that task '${params.id}' is a report whose Herdr workspace and Git worktree were already removed manually. Crewdeck will preserve its report/history and remove only safe residual Git metadata and a commit-free branch. Reason: ${params.reason}`,
      );
      if (!confirmed) return text({ reconciled: false, reason: "user declined" });
      return text(await reconcileOrphanReport(CONFIG, params.id, { reason: params.reason }));
    },
  });

  pi.registerTool({
    name: "crew_cleanup",
    label: "Clean Worker",
    description:
      "Close and remove an integrated, or already explicitly abandoned, Crewdeck worker worktree, workspace, and isolated branch. Refuses other unintegrated or dirty work and asks for confirmation.",
    parameters: Type.Object({ id: Type.String() }),
    async execute(_id, params, _signal, _update, ctx) {
      if (!ctx.hasUI) throw new Error("crew_cleanup requires interactive confirmation");
      const confirmed = await ctx.ui.confirm(
        "Clean integrated task?",
        `Close task '${params.id}' and remove its integrated worktree?`,
      );
      if (!confirmed) return text({ cleaned: false, reason: "user declined" });
      return text(await cleanupTask(CONFIG, params.id));
    },
  });

  pi.registerCommand("crew", createCrewCommand(() => getStatus(CONFIG)));

  pi.on("session_start", async (_event, ctx) => {
    activeContext = ctx;
    ctx.ui.setStatus("crewdeck", "crewdeck");
    const directory = reportDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    reportWatcher?.close();
    reportWatcher = watch(directory, () => completionWake.signal());
    // Reconcile the durable report inbox at every start so an event that arrived
    // while Pi was stopped, or was missed by fs.watch, still wakes the orchestrator.
    completionWake.start();
    const observe = async () => {
      try {
        const observations = await observePublishedPullRequests(CONFIG);
        for (const item of observations) {
          if ((item.newlyObserved || item.baseAdvances?.length) && item.status === "merged-awaiting-confirmed-reconciliation") {
            const affected = item.baseAdvances?.length
              ? ` Durable base advances: ${item.baseAdvances.map((entry: any) => `${entry.taskId}#${entry.sequence}:${entry.classification}`).join(", ")}. Inspect status and use crew_forward_base_advance; unknown classifications fail closed.`
              : " No eligible same-project change task was affected.";
            pi.sendUserMessage(`CREWDECK PR MERGED: exact published PR ${item.url} for ${item.id} was observed merged. Ask the user before calling crew_reconcile_merged_pr; observation alone is not reconciliation.${affected}`, { deliverAs: "followUp" });
          }
        }
      } catch (error: any) {
        activeContext?.ui.notify(`Crewdeck PR observer: ${error.message}`, "warning");
      }
    };
    await observe();
    const config = await loadConfig(CONFIG);
    observerTimer = setInterval(observe, config.prObserverIntervalSeconds * 1000);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    completionWake.stop();
    if (observerTimer) clearInterval(observerTimer);
    observerTimer = undefined;
    activeContext = undefined;
    reportWatcher?.close();
    reportWatcher = undefined;
    ctx.ui.setStatus("crewdeck", undefined);
    ctx.ui.setWidget("crewdeck", undefined);
  });
}
