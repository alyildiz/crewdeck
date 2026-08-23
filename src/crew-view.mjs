export const TERMINAL_CREW_STATUSES = new Set([
  "report-collected",
  "integrated",
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
    return `${task.id.padEnd(24)} ${status.padEnd(20)} agent=${live.padEnd(8)} ${ahead}`;
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
