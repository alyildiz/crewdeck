export const TERMINAL_CREW_STATUSES = new Set([
  "report-collected",
  "orphan-reconciled",
  "retired",
  "integrated",
  "pr-merged",
  "abandoned",
  "cleaned",
]);

export function currentCrewTasks(tasks) {
  return tasks.filter((task) => {
    const status = task.observedStatus || task.status;
    return !TERMINAL_CREW_STATUSES.has(status);
  });
}

export function taskLines(tasks) {
  if (tasks.length === 0) return ["Crewdeck: no matching tasks"];
  return tasks.map((task) => {
    const live = task.agent?.state || "unknown";
    const ahead = task.git?.available ? `${task.git.ahead} commit(s)` : "git unavailable";
    const status = task.observedStatus || task.status;
    const round = task.workflow === "reviewed-pr" ? ` r${task.reviewRound || 0}/${task.currentMaxReviewRounds || task.maxReviewRounds || "?"}` : "";
    const pr = task.pr?.number ? ` PR#${task.pr.number}:${task.pr.state}` : "";
    const gate = task.workflow === "reviewed-pr" ? ` checks=${task.checkState || "?"} verdict=${task.verdictState || "?"}` : "";
    const action = task.nextAction ? ` → ${task.nextAction}` : "";
    return `${task.id.padEnd(24)} ${status.padEnd(20)} agent=${live.padEnd(8)} ${ahead}${round}${pr}${gate}${action}`;
  });
}

export function createCrewCommand(getTasks) {
  return {
    description: "Show active Crewdeck workers; use '/crew all' for history or '/crew clear' to hide",
    handler: async (args, ctx) => {
      const mode = args.trim();
      if (mode === "clear") {
        ctx.ui.setWidget("crewdeck", undefined);
        return;
      }
      try {
        const tasks = await getTasks();
        const visibleTasks = mode === "all" ? tasks : currentCrewTasks(tasks);
        ctx.ui.setWidget("crewdeck", taskLines(visibleTasks), { placement: "belowEditor" });
      } catch (error) {
        ctx.ui.notify(error.message, "error");
      }
    },
  };
}
