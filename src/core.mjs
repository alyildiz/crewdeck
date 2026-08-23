import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const TASK_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const TASK_KINDS = new Set(["scout", "build"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REPORTER_EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../worker/reporter.ts");

export class CrewdeckError extends Error {
  constructor(message, code = "crewdeck_error", details = undefined) {
    super(message);
    this.name = "CrewdeckError";
    this.code = code;
    this.details = details;
  }
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

function stateRoot() {
  return expandHome(
    process.env.CREWDECK_STATE_DIR ||
      path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "crewdeck"),
  );
}

function statePath() {
  return path.join(stateRoot(), "state.json");
}

function reportsRoot() {
  return path.join(stateRoot(), "reports");
}

function taskReportPath(id) {
  return path.join(reportsRoot(), `${id}.json`);
}

async function readTaskReport(record) {
  try {
    const report = JSON.parse(await readFile(taskReportPath(record.id), "utf8"));
    if (
      report.schemaVersion !== 1 ||
      report.taskId !== record.id ||
      report.kind !== record.kind ||
      report.token !== record.reportToken ||
      !report.payload ||
      typeof report.payload !== "object"
    ) {
      return { available: false, error: "Report identity does not match the task" };
    }
    return { available: true, path: taskReportPath(record.id), report };
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, state: "missing" };
    return { available: false, error: error.message };
  }
}

function publicTaskRecord(record) {
  const { reportToken: _reportToken, ...publicRecord } = record;
  return publicRecord;
}

function publicTaskReport(result) {
  if (!result.available) return result;
  const { token: _token, ...report } = result.report;
  return { available: true, path: result.path, report };
}

async function run(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      timeout: options.timeout ?? 30_000,
      maxBuffer: options.maxBuffer ?? 1024 * 1024,
      encoding: "utf8",
    });
    return { stdout: result.stdout.trim(), stderr: result.stderr.trim(), code: 0 };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new CrewdeckError(
      `${command} ${args.join(" ")} failed: ${stderr || stdout || error.message}`,
      "command_failed",
      { command, args, stdout, stderr, exitCode: error.code },
    );
  }
}

async function runJson(command, args, options) {
  const result = await run(command, args, options);
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CrewdeckError(`Expected JSON from ${command} ${args.join(" ")}`, "invalid_json", {
      output: result.stdout,
    });
  }
}

async function git(cwd, args, options = {}) {
  return run("git", ["-C", cwd, ...args], options);
}

async function loadState() {
  try {
    const raw = await readFile(statePath(), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && parsed.version === 1 && parsed.tasks ? parsed : { version: 1, tasks: {} };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, tasks: {} };
    throw new CrewdeckError(`Cannot read Crewdeck state: ${error.message}`, "invalid_state");
  }
}

async function saveState(state) {
  await mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  const target = statePath();
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, target);
}

async function withStateLock(fn) {
  const root = stateRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".lock");
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (Date.now() >= deadline) throw new CrewdeckError("Crewdeck state is busy", "state_locked");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

async function loadRawConfig(configPath) {
  const absolute = path.resolve(configPath);
  try {
    return { absolute, config: JSON.parse(await readFile(absolute, "utf8")) };
  } catch (error) {
    throw new CrewdeckError(`Cannot read ${absolute}: ${error.message}`, "invalid_config");
  }
}

async function loadProfiles(config, configAbsolute) {
  if (!config.profilesFile || typeof config.profilesFile !== "string") {
    throw new CrewdeckError("profilesFile must point to a YAML profile file", "invalid_config");
  }
  const profilesPath = path.resolve(path.dirname(configAbsolute), expandHome(config.profilesFile));
  let document;
  try {
    document = parseYaml(await readFile(profilesPath, "utf8"));
  } catch (error) {
    throw new CrewdeckError(`Cannot read ${profilesPath}: ${error.message}`, "invalid_config");
  }
  if (document?.version !== 1 || !document.profiles || typeof document.profiles !== "object") {
    throw new CrewdeckError(`${profilesPath} must contain version: 1 and profiles`, "invalid_config");
  }
  if (!document.defaultProfile || !document.profiles[document.defaultProfile]) {
    throw new CrewdeckError("defaultProfile must name a configured profile", "invalid_config");
  }
  for (const [name, profile] of Object.entries(document.profiles)) {
    if (!profile.provider || !profile.model || !THINKING_LEVELS.has(profile.thinking)) {
      throw new CrewdeckError(
        `Profile ${name}: provider, model, and a valid thinking level are required`,
        "invalid_config",
      );
    }
    if (
      !Array.isArray(profile.allowedKinds) ||
      profile.allowedKinds.length === 0 ||
      profile.allowedKinds.some((kind) => !TASK_KINDS.has(kind))
    ) {
      throw new CrewdeckError(`Profile ${name}: allowedKinds must contain scout and/or build`, "invalid_config");
    }
  }
  return {
    path: profilesPath,
    profiles: document.profiles,
    defaultProfile: document.defaultProfile,
  };
}

export async function loadConfig(configPath) {
  const { absolute, config } = await loadRawConfig(configPath);
  if (!Number.isInteger(config.maxWorkers) || config.maxWorkers < 1 || config.maxWorkers > 5) {
    throw new CrewdeckError("maxWorkers must be an integer from 1 to 5", "invalid_config");
  }
  if (!config.projects || typeof config.projects !== "object") {
    throw new CrewdeckError("projects must be an object", "invalid_config");
  }
  if (!["after-collection", "manual"].includes(config.scoutCleanup || "after-collection")) {
    throw new CrewdeckError("scoutCleanup must be after-collection or manual", "invalid_config");
  }
  const loadedProfiles = await loadProfiles(config, absolute);
  config.__path = absolute;
  config.__profilesPath = loadedProfiles.path;
  config.profiles = loadedProfiles.profiles;
  config.defaultProfile = loadedProfiles.defaultProfile;
  config.scoutCleanup ||= "after-collection";
  config.worktreeRoot = path.resolve(expandHome(config.worktreeRoot));
  return config;
}

function resolveProject(config, name) {
  const project = config.projects[name];
  if (!project) {
    throw new CrewdeckError(`Unknown project '${name}'. Configure it in ${config.__path}`, "unknown_project");
  }
  return { ...project, name, path: path.resolve(expandHome(project.path)) };
}

async function validateProject(project) {
  const root = (await git(project.path, ["rev-parse", "--show-toplevel"])).stdout;
  if (path.resolve(root) !== project.path) {
    throw new CrewdeckError(`${project.path} is not the project worktree root`, "invalid_project");
  }
  await git(project.path, ["rev-parse", "--verify", project.base]);
}

function validateTaskInput(task) {
  if (!TASK_ID_RE.test(task.id || "")) {
    throw new CrewdeckError(
      `Invalid task id '${task.id}'. Use 1-24 lowercase letters, digits, or hyphens, starting with a letter`,
      "invalid_task",
    );
  }
  if (typeof task.task !== "string" || task.task.trim().length < 8) {
    throw new CrewdeckError(`Task ${task.id} needs a concrete description`, "invalid_task");
  }
  if (!TASK_KINDS.has(task.kind)) {
    throw new CrewdeckError(`Task ${task.id} must declare kind=scout or kind=build`, "invalid_task");
  }
}

function agentName(id) {
  return `cd_${id.replaceAll("-", "_")}`;
}

function workerPrompt(task, project) {
  const delivery =
    task.kind === "scout"
      ? [
          "This is a strictly read-only scout task. You have no write, edit, or shell tool. Analyze only; a recommendation never authorizes implementation.",
          "Finish by calling crew_complete exactly once with a self-contained report: conclusion, findings, evidence, recommendations, and openQuestions.",
        ]
      : [
          "This is a build task. Implement the accepted scope, run relevant tests, and commit the result on the current branch.",
          "Finish by calling crew_complete exactly once with summary, the exact HEAD commit hash, tests, risks, and openQuestions.",
        ];
  return [
    `# Task\n${task.task.trim()}`,
    `# Project\nYou are already in an isolated Git worktree of ${project.name}. Read and follow this worktree's AGENTS.md and inspect the project before acting.`,
    `# Delivery\n${delivery.join("\n")}`,
    "Stay inside this worktree. Do not push, merge, rebase, switch branches, remove the worktree, or modify another checkout.",
    "Do not wait for the orchestrator unless a real product decision or blocker prevents progress.",
    "The task is not complete until crew_complete accepts the structured result.",
  ].join("\n\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function bindWorkerEnvironment(paneId, record) {
  const values = {
    CREWDECK_TASK_ID: record.id,
    CREWDECK_TASK_KIND: record.kind,
    CREWDECK_REPORT_TOKEN: record.reportToken,
    CREWDECK_REPORT_DIR: reportsRoot(),
  };
  const command = `export ${Object.entries(values)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")}`;
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      await run("herdr", ["pane", "run", paneId, command], { timeout: 10_000 });
      return;
    } catch (error) {
      const shellStarting = error instanceof CrewdeckError && error.message.includes("pane_busy");
      if (!shellStarting || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function startAgentWhenShellReady(name, paneId, piArgs) {
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      return await run(
        "herdr",
        [
          "agent",
          "start",
          name,
          "--kind",
          "pi",
          "--pane",
          paneId,
          "--timeout",
          "120000",
          "--",
          ...piArgs,
        ],
        { timeout: 130_000 },
      );
    } catch (error) {
      const shellStarting = error instanceof CrewdeckError && error.message.includes("agent_pane_busy");
      if (!shellStarting || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}

async function ensureProjectWorkspace(project) {
  const listed = await runJson("herdr", ["workspace", "list"], { timeout: 10_000 });
  const workspaces = listed?.result?.workspaces || [];
  const matches = [];
  for (const workspace of workspaces) {
    const checkoutMatches =
      workspace.worktree?.is_linked_worktree === false &&
      path.resolve(workspace.worktree?.checkout_path || "") === project.path;
    let paneMatches = false;
    if (!checkoutMatches) {
      try {
        const listedPanes = await runJson("herdr", ["pane", "list", "--workspace", workspace.workspace_id], {
          timeout: 10_000,
        });
        paneMatches = (listedPanes?.result?.panes || []).some(
          (pane) => path.resolve(pane.cwd || "") === project.path,
        );
      } catch {
        // An unreadable workspace is not safe source authority.
      }
    }
    if (checkoutMatches || paneMatches) matches.push(workspace);
  }
  if (matches.length > 1) {
    throw new CrewdeckError(`Several Herdr workspaces represent ${project.path}`, "ambiguous_project_workspace");
  }
  if (matches.length === 1) {
    return { id: matches[0].workspace_id, owned: matches[0].label === `project:${project.name}` };
  }

  const created = await runJson("herdr", [
    "workspace",
    "create",
    "--cwd",
    project.path,
    "--label",
    `project:${project.name}`,
    "--no-focus",
  ]);
  const id = created?.result?.workspace?.workspace_id;
  if (!id) throw new CrewdeckError("Herdr did not return a project workspace id", "invalid_herdr_response");
  return { id, owned: true };
}

async function createOne(config, project, sourceWorkspace, task, profileName) {
  validateTaskInput(task);
  const selectedProfile = task.profile || profileName || config.defaultProfile;
  const profile = config.profiles[selectedProfile];
  if (!profile) throw new CrewdeckError(`Unknown profile '${selectedProfile}'`, "unknown_profile");
  if (!profile.allowedKinds.includes(task.kind)) {
    throw new CrewdeckError(`Profile '${selectedProfile}' does not allow kind=${task.kind}`, "profile_kind_mismatch");
  }
  const branch = `crew/${task.id}`;
  const worktree = path.join(config.worktreeRoot, project.name, task.id);
  const name = agentName(task.id);

  const state = await loadState();
  const existing = state.tasks[task.id];
  if (existing) {
    throw new CrewdeckError(
      `Task '${task.id}' already exists with status ${existing.status}; task ids are durable and cannot be reused`,
      "task_exists",
    );
  }
  try {
    await git(project.path, ["show-ref", "--verify", `refs/heads/${branch}`]);
    throw new CrewdeckError(`Branch ${branch} already exists`, "branch_exists");
  } catch (error) {
    if (error instanceof CrewdeckError && error.code === "branch_exists") throw error;
    if (!(error instanceof CrewdeckError) || error.details?.exitCode === 0) throw error;
  }

  await mkdir(path.dirname(worktree), { recursive: true });
  const created = await runJson("herdr", [
    "worktree",
    "create",
    "--workspace",
    sourceWorkspace.id,
    "--branch",
    branch,
    "--base",
    project.base,
    "--path",
    worktree,
    "--label",
    `crew:${task.id}`,
    "--no-focus",
  ]);
  const workspaceId = created?.result?.workspace?.workspace_id;
  const paneId = created?.result?.root_pane?.pane_id;
  if (!workspaceId || !paneId) {
    throw new CrewdeckError("Herdr created a worktree without workspace/pane identifiers", "invalid_herdr_response");
  }

  const record = {
    id: task.id,
    project: project.name,
    description: task.task.trim(),
    kind: task.kind,
    profile: selectedProfile,
    status: "starting",
    branch,
    base: project.base,
    repo: project.path,
    worktree,
    workspaceId,
    paneId,
    agentName: name,
    sourceWorkspaceId: sourceWorkspace.id,
    sourceWorkspaceOwned: sourceWorkspace.owned,
    reportToken: randomBytes(24).toString("hex"),
    createdAt: new Date().toISOString(),
  };
  await withStateLock(async () => {
    const next = await loadState();
    next.tasks[task.id] = record;
    await saveState(next);
  });

  const piArgs = [
    "--model",
    `${profile.provider}/${profile.model}`,
    "--thinking",
    profile.thinking,
    "--name",
    `crew:${task.id}`,
    "--no-extensions",
    "-e",
    REPORTER_EXTENSION,
  ];
  if (task.kind === "scout") {
    piArgs.push("--no-approve", "--no-skills", "--tools", "read,grep,find,ls,crew_complete");
  } else if (project.trustProjectResources === true) {
    piArgs.push("--approve");
  }

  try {
    await bindWorkerEnvironment(paneId, record);
    await startAgentWhenShellReady(name, paneId, piArgs);
    await run("herdr", ["agent", "prompt", name, workerPrompt(task, project)], { timeout: 15_000 });
    record.status = "running";
    record.startedAt = new Date().toISOString();
    await withStateLock(async () => {
      const next = await loadState();
      next.tasks[task.id] = record;
      await saveState(next);
    });
    return publicTaskRecord(record);
  } catch (error) {
    record.status = "failed";
    record.error = error.message;
    await withStateLock(async () => {
      const next = await loadState();
      next.tasks[task.id] = record;
      await saveState(next);
    });
    throw error;
  }
}

export async function spawnBatch(configPath, { project: projectName, tasks, profile }) {
  if (process.env.HERDR_ENV !== "1") {
    throw new CrewdeckError("Crewdeck must run inside a Herdr-managed pane", "not_in_herdr");
  }
  const config = await loadConfig(configPath);
  if (!Array.isArray(tasks) || tasks.length < 1 || tasks.length > config.maxWorkers) {
    throw new CrewdeckError(`Provide 1-${config.maxWorkers} tasks`, "invalid_batch");
  }
  const ids = tasks.map((task) => task.id);
  if (new Set(ids).size !== ids.length) throw new CrewdeckError("Task ids must be unique", "invalid_batch");
  tasks.forEach((task) => {
    validateTaskInput(task);
    const selectedProfile = task.profile || profile || config.defaultProfile;
    const configuredProfile = config.profiles[selectedProfile];
    if (!configuredProfile) throw new CrewdeckError(`Unknown profile '${selectedProfile}'`, "unknown_profile");
    if (!configuredProfile.allowedKinds.includes(task.kind)) {
      throw new CrewdeckError(
        `Profile '${selectedProfile}' does not allow kind=${task.kind}`,
        "profile_kind_mismatch",
      );
    }
  });
  const project = resolveProject(config, projectName);
  await validateProject(project);
  const sourceWorkspace = await ensureProjectWorkspace(project);

  // Each task receives its own worktree workspace; independent Pi startups happen concurrently.
  const results = await Promise.allSettled(
    tasks.map((task) => createOne(config, project, sourceWorkspace, task, profile)),
  );
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? { ok: true, ...result.value }
      : { ok: false, id: tasks[index].id, error: result.reason?.message || String(result.reason) },
  );
}

async function liveAgent(record) {
  try {
    const response = await runJson("herdr", ["agent", "get", record.agentName], { timeout: 10_000 });
    const agent = response?.result?.agent || response?.result;
    return { available: true, state: agent?.status || agent?.agent_status || "unknown", raw: agent };
  } catch (error) {
    return { available: false, state: "missing", error: error.message };
  }
}

async function gitSnapshot(record) {
  try {
    const status = (await git(record.worktree, ["status", "--porcelain"])).stdout;
    const head = (await git(record.worktree, ["rev-parse", "HEAD"])).stdout;
    const baseHead = (await git(record.repo, ["rev-parse", record.base])).stdout;
    const aheadRaw = (await git(record.worktree, ["rev-list", "--count", `${baseHead}..${head}`])).stdout;
    return { available: true, clean: status === "", status, head, baseHead, ahead: Number(aheadRaw) };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

export async function getStatus(configPath, id) {
  await loadConfig(configPath);
  const state = await loadState();
  const records = id ? [state.tasks[id]].filter(Boolean) : Object.values(state.tasks);
  if (id && records.length === 0) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  return Promise.all(
    records.map(async (storedRecord) => {
      const record = {
        ...storedRecord,
        kind: storedRecord.kind || (storedRecord.profile === "scout" ? "scout" : "build"),
      };
      if (record.status === "cleaned") {
        return {
          ...publicTaskRecord(record),
          observedStatus: "cleaned",
          agent: { available: false, state: "closed" },
          git: { available: false, state: "worktree-removed" },
        };
      }
      const [agent, snapshot, result] = await Promise.all([
        liveAgent(record),
        gitSnapshot(record),
        readTaskReport(record),
      ]);
      let observedStatus = record.status;
      if (record.status === "running" && agent.state === "blocked") observedStatus = "blocked";
      if (record.kind === "scout" && result.available) {
        observedStatus = record.resultCollectedAt ? "report-collected" : "report-ready";
      }
      const reportedCommit = result.available ? result.report.payload?.commit : undefined;
      const commitMatches =
        typeof reportedCommit === "string" && snapshot.available && snapshot.head.startsWith(reportedCommit);
      if (
        record.kind === "build" &&
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
      };
    }),
  );
}

export async function getTaskDiff(configPath, id) {
  await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  if (record.kind !== "build") throw new CrewdeckError("Scout tasks have no integration diff", "read_only_task");
  const snapshot = await gitSnapshot(record);
  if (!snapshot.available) throw new CrewdeckError("Build worktree is unavailable", "missing_worktree");
  const range = `${record.base}...HEAD`;
  const [commits, stat, patchResult] = await Promise.all([
    git(record.worktree, ["log", "--oneline", "--decorate=no", `${record.base}..HEAD`]),
    git(record.worktree, ["diff", "--stat", range]),
    git(record.worktree, ["diff", "--no-ext-diff", "--unified=3", range], { maxBuffer: 4 * 1024 * 1024 }),
  ]);
  const maxPatchBytes = 40 * 1024;
  const patchBytes = Buffer.byteLength(patchResult.stdout, "utf8");
  const patch =
    patchBytes <= maxPatchBytes
      ? patchResult.stdout
      : `${Buffer.from(patchResult.stdout, "utf8").subarray(0, maxPatchBytes).toString("utf8")}\n\n[diff truncated: ${patchBytes - maxPatchBytes} bytes omitted; inspect the worktree for the full patch]`;
  return {
    task: publicTaskRecord(record),
    clean: snapshot.clean,
    head: snapshot.head,
    baseHead: snapshot.baseHead,
    ahead: snapshot.ahead,
    commits: commits.stdout,
    stat: stat.stdout,
    patch,
    truncated: patchBytes > maxPatchBytes,
  };
}

export async function promptTask(configPath, id, message, { wait = false } = {}) {
  await loadConfig(configPath);
  if (!message || message.trim().length < 2) throw new CrewdeckError("Message is empty", "invalid_prompt");
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  const args = ["agent", "prompt", record.agentName, message.trim()];
  if (wait) args.push("--wait", "--timeout", "600000");
  return runJson("herdr", args, { timeout: wait ? 610_000 : 15_000 });
}

export async function collectResults(configPath, ids, { cleanupScouts } = {}) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const selectedIds = ids?.length
    ? ids
    : Object.values(state.tasks)
        .filter((record) => !record.resultCollectedAt && record.status !== "cleaned")
        .map((record) => record.id);
  const collected = [];
  for (const id of selectedIds) {
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    record.kind ||= record.profile === "scout" ? "scout" : "build";
    const result = await readTaskReport(record);
    if (!result.available) continue;
    record.resultCollectedAt ||= new Date().toISOString();
    collected.push({ task: publicTaskRecord(record), result: publicTaskReport(result) });
  }
  if (collected.length > 0) {
    await withStateLock(async () => {
      const next = await loadState();
      for (const item of collected) {
        next.tasks[item.task.id].resultCollectedAt = item.task.resultCollectedAt;
        next.tasks[item.task.id].kind ||= item.task.kind;
      }
      await saveState(next);
    });
  }

  const shouldCleanup = cleanupScouts ?? config.scoutCleanup === "after-collection";
  if (shouldCleanup) {
    for (const item of collected) {
      if (item.task.kind !== "scout" || item.task.status === "cleaned") continue;
      try {
        item.cleanup = await cleanupTask(configPath, item.task.id);
      } catch (error) {
        item.cleanup = { ok: false, error: error.message, code: error.code };
      }
    }
  }
  return collected;
}

export async function prepareIntegration(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  const project = resolveProject(config, record.project);
  if (record.kind !== "build") throw new CrewdeckError("Scout tasks cannot be integrated", "read_only_task");
  const agent = await liveAgent(record);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Worker is ${agent.state}; wait until it settles`, "worker_not_settled");
  }
  const snapshot = await gitSnapshot(record);
  if (!snapshot.available || !snapshot.clean) {
    throw new CrewdeckError("Worker worktree is not clean", "dirty_worktree", snapshot);
  }
  if (snapshot.ahead < 1) throw new CrewdeckError("Worker branch has no commits to integrate", "no_commits");
  const result = await readTaskReport(record);
  if (!result.available) throw new CrewdeckError("Builder has not submitted crew_complete", "missing_result");
  if (!snapshot.head.startsWith(result.report.payload?.commit || "!")) {
    throw new CrewdeckError("Builder result commit does not match the worktree HEAD", "result_commit_mismatch");
  }

  try {
    await git(record.worktree, ["rebase", record.base], { timeout: 120_000 });
  } catch (error) {
    record.status = "conflict";
    record.error = error.message;
    await withStateLock(async () => {
      const next = await loadState();
      next.tasks[id] = record;
      await saveState(next);
    });
    return { ok: false, conflict: true, task: publicTaskRecord(record), error: error.message };
  }

  const verification = [];
  for (const command of project.verify || []) {
    try {
      const result = await run("bash", ["-lc", command], { cwd: record.worktree, timeout: 15 * 60_000 });
      verification.push({ command, ok: true, output: result.stdout.slice(-4000) });
    } catch (error) {
      record.status = "verification-failed";
      record.error = error.message;
      await withStateLock(async () => {
        const next = await loadState();
        next.tasks[id] = record;
        await saveState(next);
      });
      return {
        ok: false,
        conflict: false,
        task: publicTaskRecord(record),
        verification,
        error: error.message,
      };
    }
  }
  record.status = "ready";
  record.preparedBaseHead = (await git(record.repo, ["rev-parse", record.base])).stdout;
  record.preparedAt = new Date().toISOString();
  delete record.error;
  await withStateLock(async () => {
    const next = await loadState();
    next.tasks[id] = record;
    await saveState(next);
  });
  return { ok: true, task: publicTaskRecord(record), verification };
}

export async function mergeTask(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  if (record.status !== "ready") throw new CrewdeckError("Task must be prepared before merge", "not_ready");
  const project = resolveProject(config, record.project);
  const currentBase = (await git(project.path, ["rev-parse", record.base])).stdout;
  if (currentBase !== record.preparedBaseHead) {
    throw new CrewdeckError("Base branch advanced; prepare the task again", "base_advanced");
  }
  const primaryStatus = (await git(project.path, ["status", "--porcelain"])).stdout;
  if (primaryStatus) throw new CrewdeckError("Primary project checkout is dirty", "dirty_primary");
  const currentBranch = (await git(project.path, ["branch", "--show-current"])).stdout;
  if (currentBranch !== record.base) {
    throw new CrewdeckError(`Primary checkout must be on ${record.base}, currently ${currentBranch || "detached"}`, "wrong_branch");
  }
  await git(project.path, ["merge", "--ff-only", record.branch], { timeout: 120_000 });
  record.status = "integrated";
  record.integratedAt = new Date().toISOString();
  record.integratedHead = (await git(project.path, ["rev-parse", "HEAD"])).stdout;
  await withStateLock(async () => {
    const next = await loadState();
    next.tasks[id] = record;
    await saveState(next);
  });
  return publicTaskRecord(record);
}

export async function cleanupTask(configPath, id) {
  await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  if (record.kind === "build" && record.status !== "integrated") {
    throw new CrewdeckError("Build tasks can be cleaned only after integration", "not_integrated");
  }
  if (record.kind === "scout") {
    if (!record.resultCollectedAt) {
      throw new CrewdeckError("Scout result must be collected before cleanup", "result_not_collected");
    }
    const result = await readTaskReport(record);
    if (!result.available) throw new CrewdeckError("Scout durable report is missing", "missing_result");
  }
  const agent = await liveAgent(record);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Worker is ${agent.state}; wait until it settles before cleanup`, "worker_not_settled");
  }
  const snapshot = await gitSnapshot(record);
  if (!snapshot.available || !snapshot.clean) throw new CrewdeckError("Worktree is not clean", "dirty_worktree");
  if (record.kind === "scout" && snapshot.ahead !== 0) {
    throw new CrewdeckError("Scout branch unexpectedly contains commits", "scout_has_commits");
  }
  try {
    await run("herdr", ["agent", "send-keys", record.agentName, "ctrl+d"], { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    // An already exited agent is fine; worktree removal remains the authority.
  }
  await runJson("herdr", ["worktree", "remove", "--workspace", record.workspaceId], { timeout: 30_000 });
  try {
    await git(record.repo, ["branch", "-d", record.branch]);
  } catch {
    // The integrated work is safe even if branch deletion is refused.
  }
  record.status = "cleaned";
  record.cleanedAt = new Date().toISOString();
  let closeOwnedSource = false;
  await withStateLock(async () => {
    const next = await loadState();
    next.tasks[id] = record;
    closeOwnedSource =
      record.sourceWorkspaceOwned === true &&
      !Object.values(next.tasks).some(
        (other) =>
          other.id !== id &&
          other.sourceWorkspaceId === record.sourceWorkspaceId &&
          other.status !== "cleaned",
      );
    await saveState(next);
  });
  if (closeOwnedSource) {
    try {
      await runJson("herdr", ["workspace", "close", record.sourceWorkspaceId], { timeout: 15_000 });
    } catch {
      // Cleanup is complete; preserving an unexpected source workspace is safer than forcing it closed.
    }
  }
  return publicTaskRecord(record);
}

export async function addProject(configPath, name, projectPath, options = {}) {
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) throw new CrewdeckError("Invalid project name", "invalid_project");
  const absolute = path.resolve(expandHome(projectPath));
  const root = (await git(absolute, ["rev-parse", "--show-toplevel"])).stdout;
  if (path.resolve(root) !== absolute) throw new CrewdeckError("Project path must be a Git worktree root", "invalid_project");
  const { config } = await loadRawConfig(configPath);
  if (!config.projects || typeof config.projects !== "object") config.projects = {};
  const base = options.base || (await git(absolute, ["branch", "--show-current"])).stdout;
  if (!base) throw new CrewdeckError("Cannot infer base branch; pass --base", "invalid_project");
  config.projects[name] = {
    path: absolute,
    base,
    trustProjectResources: options.trustProjectResources === true,
    verify: options.verify || [],
  };
  await writeFile(path.resolve(configPath), `${JSON.stringify(config, null, 2)}\n`);
  return config.projects[name];
}

export function stateLocation() {
  return statePath();
}

export function reportDirectory() {
  return reportsRoot();
}
