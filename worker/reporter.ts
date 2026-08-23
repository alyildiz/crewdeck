import { randomBytes } from "node:crypto";
import { access, mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const taskId = process.env.CREWDECK_TASK_ID || "";
const taskKind = process.env.CREWDECK_TASK_KIND || "";
const reportToken = process.env.CREWDECK_REPORT_TOKEN || "";
const reportDir = process.env.CREWDECK_REPORT_DIR || "";

const StringList = Type.Array(Type.String({ minLength: 1, maxLength: 4000 }), { maxItems: 100 });

const ScoutResult = Type.Object({
  conclusion: Type.String({ minLength: 1, maxLength: 12000 }),
  findings: StringList,
  evidence: Type.Array(
    Type.Object({
      location: Type.String({ minLength: 1, maxLength: 2000 }),
      detail: Type.String({ minLength: 1, maxLength: 6000 }),
    }),
    { maxItems: 100 },
  ),
  recommendations: StringList,
  openQuestions: StringList,
});

const BuildResult = Type.Object({
  summary: Type.String({ minLength: 1, maxLength: 12000 }),
  commit: Type.String({ pattern: "^[0-9a-f]{7,40}$" }),
  tests: Type.Array(
    Type.Object({
      command: Type.String({ minLength: 1, maxLength: 4000 }),
      result: Type.String({ minLength: 1, maxLength: 6000 }),
    }),
    { maxItems: 100 },
  ),
  risks: StringList,
  openQuestions: StringList,
});

export default function crewdeckWorkerReporter(pi: ExtensionAPI) {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(taskId)) throw new Error("Invalid CREWDECK_TASK_ID");
  if (taskKind !== "scout" && taskKind !== "build") throw new Error("Invalid CREWDECK_TASK_KIND");
  if (!/^[0-9a-f]{48}$/.test(reportToken)) throw new Error("Invalid CREWDECK_REPORT_TOKEN");
  if (!path.isAbsolute(reportDir)) throw new Error("CREWDECK_REPORT_DIR must be absolute");

  pi.registerTool({
    name: "crew_complete",
    label: "Complete Crewdeck Task",
    description:
      taskKind === "scout"
        ? "Submit the final durable read-only scout report. Required exactly once before ending the task."
        : "Submit the final durable build result with the exact committed HEAD. Required exactly once before ending the task.",
    parameters: taskKind === "scout" ? ScoutResult : BuildResult,
    async execute(_toolCallId, params) {
      const target = path.join(reportDir, `${taskId}.json`);
      await mkdir(reportDir, { recursive: true, mode: 0o700 });
      return withFileMutationQueue(target, async () => {
        try {
          await access(target);
          throw new Error("Crewdeck result already submitted; do not replace a durable result");
        } catch (error: any) {
          if (error.code !== "ENOENT") throw error;
        }
        const report = {
          schemaVersion: 1,
          taskId,
          kind: taskKind,
          token: reportToken,
          completedAt: new Date().toISOString(),
          payload: params,
        };
        const temp = `${target}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
        await writeFile(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
        await rename(temp, target);
        return {
          content: [{ type: "text", text: `Crewdeck ${taskKind} result stored durably. Task complete.` }],
          details: { taskId, kind: taskKind, completedAt: report.completedAt },
          terminate: true,
        };
      });
    },
  });
}
