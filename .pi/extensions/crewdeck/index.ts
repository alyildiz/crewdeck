import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  cleanupTask,
  getStatus,
  mergeTask,
  prepareIntegration,
  promptTask,
  spawnBatch,
} from "../../../src/core.mjs";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const CONFIG = process.env.CREWDECK_CONFIG || path.join(ROOT, "crewdeck.json");

function text(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

function taskLines(tasks: any[]) {
  if (tasks.length === 0) return ["Crewdeck: no recorded tasks"];
  return tasks.map((task) => {
    const live = task.agent?.state || "unknown";
    const ahead = task.git?.available ? `${task.git.ahead} commit(s)` : "git unavailable";
    const status = task.observedStatus || task.status;
    return `${task.id.padEnd(24)} ${status.padEnd(20)} agent=${live.padEnd(8)} ${ahead}`;
  });
}

export default function crewdeckExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "crew_spawn_batch",
    label: "Spawn Crew",
    description:
      "Launch one to five Pi workers concurrently in visible Herdr worktree workspaces for a registered project. Each worker loads that project's own AGENTS.md. Use for independently actionable coding or read-only scout tasks.",
    parameters: Type.Object({
      project: Type.String({ description: "Registered project name from crewdeck.json" }),
      profile: Type.Optional(Type.String({ description: "Default profile for this batch" })),
      tasks: Type.Array(
        Type.Object({
          id: Type.String({ description: "Unique lowercase task id, max 24 characters" }),
          task: Type.String({ description: "Concrete task and acceptance criteria" }),
          profile: Type.Optional(Type.String({ description: "Optional per-task profile override" })),
        }),
        { minItems: 1, maxItems: 5 },
      ),
    }),
    async execute(_id, params) {
      return text(await spawnBatch(CONFIG, params));
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
    name: "crew_cleanup",
    label: "Clean Worker",
    description:
      "Close and remove an integrated Crewdeck worker worktree, workspace, and merged branch. Refuses unintegrated or dirty work and asks for confirmation.",
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

  pi.registerCommand("crew", {
    description: "Show Crewdeck workers without spending an LLM turn; use '/crew clear' to hide",
    handler: async (args, ctx) => {
      if (args.trim() === "clear") {
        ctx.ui.setWidget("crewdeck", undefined);
        return;
      }
      try {
        const tasks = await getStatus(CONFIG);
        ctx.ui.setWidget("crewdeck", taskLines(tasks), { placement: "belowEditor" });
      } catch (error: any) {
        ctx.ui.notify(error.message, "error");
      }
    },
  });

  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setStatus("crewdeck", "crewdeck");
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setStatus("crewdeck", undefined);
    ctx.ui.setWidget("crewdeck", undefined);
  });
}
