export const TERMINAL_CREW_STATUSES = new Set([
  "orphan-reconciled",
  "retired",
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
    const baseAdvance = task.baseAdvanceState ? ` base#${task.baseAdvanceState.sequence}:${task.baseAdvanceState.classification}/${task.baseAdvanceState.status}` : "";
    const action = task.nextAction ? ` → ${task.nextAction}` : "";
    return `${task.id.padEnd(24)} ${status.padEnd(20)} agent=${live.padEnd(8)} ${ahead}${round}${pr}${gate}${baseAdvance}${action}`;
  });
}

export function createCrewCommand(getPage) {
  return {
    description: "Show a bounded active Crewdeck page; use '/crew all [cursor]' for one bounded history page or '/crew clear'",
    handler: async (args, ctx) => {
      const [mode = "", cursor, ...extra] = args.trim().split(/\s+/).filter(Boolean);
      if (mode === "clear") {
        ctx.ui.setWidget("crewdeck", undefined);
        return;
      }
      try {
        if (extra.length || (mode && mode !== "all")) throw new Error("Usage: /crew, /crew all [cursor], or /crew clear");
        const response = await getPage({ scope: mode === "all" ? "all" : "active", limit: mode === "all" ? 50 : 20, cursor });
        const page = Array.isArray(response)
          ? { tasks: mode === "all" ? response.slice(0, 50) : currentCrewTasks(response).slice(0, 20), pagination: {} }
          : response;
        const lines = taskLines(page.tasks);
        if (page.pagination.nextCursor) lines.push(`Crewdeck: page truncated; continue with /crew all ${page.pagination.nextCursor}`);
        ctx.ui.setWidget("crewdeck", lines, { placement: "belowEditor" });
      } catch (error) {
        ctx.ui.notify(error.message, "error");
      }
    },
  };
}
