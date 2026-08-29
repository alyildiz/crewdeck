import { statusCursorScope } from "./core.mjs";

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
    description:
      "Show a bounded active Crewdeck page; use '/crew all [cursor]' for one bounded history page, '/crew <cursor>' to continue the page a cursor names, or '/crew clear' to hide",
    handler: async (args, ctx) => {
      const [first = "", ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (first === "clear") {
        ctx.ui.setWidget("crewdeck", undefined);
        return;
      }
      try {
        if (first === "all" ? rest.length > 1 : rest.length > 0) {
          throw new Error("Usage: /crew, /crew all [cursor], /crew <cursor>, or /crew clear");
        }
        const cursor = first === "all" ? rest[0] : first;
        const scope = first === "all" ? "all" : first ? statusCursorScope(first) : "active";
        const response = await getPage({ scope, limit: scope === "all" ? 50 : 20, cursor: cursor || undefined });
        const lines = taskLines(response.tasks);
        if (response.pagination.nextCursor) {
          const continuation = response.scope === "all" ? `/crew all ${response.pagination.nextCursor}` : `/crew ${response.pagination.nextCursor}`;
          lines.push(`Crewdeck: page truncated; continue with ${continuation}`);
        }
        ctx.ui.setWidget("crewdeck", lines, { placement: "belowEditor" });
      } catch (error) {
        ctx.ui.notify(error.message, "error");
      }
    },
  };
}
