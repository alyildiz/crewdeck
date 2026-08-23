import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const TASK_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const KIND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LIFECYCLES = new Set(["report", "change"]);
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);
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
      (report.lifecycle !== undefined && record.lifecycle !== undefined && report.lifecycle !== record.lifecycle) ||
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

async function loadKinds(config, configAbsolute) {
  if (!config.kindsFile || typeof config.kindsFile !== "string") {
    throw new CrewdeckError("kindsFile must point to a YAML kind file", "invalid_config");
  }
  const kindsPath = path.resolve(path.dirname(configAbsolute), expandHome(config.kindsFile));
  let document;
  try {
    document = parseYaml(await readFile(kindsPath, "utf8"));
  } catch (error) {
    throw new CrewdeckError(`Cannot read ${kindsPath}: ${error.message}`, "invalid_config");
  }
  if (document?.version !== 1 || !document.kinds || typeof document.kinds !== "object") {
    throw new CrewdeckError(`${kindsPath} must contain version: 1 and kinds`, "invalid_config");
  }
  const kinds = {};
  for (const [name, rawKind] of Object.entries(document.kinds)) {
    if (!KIND_NAME_RE.test(name) || !rawKind || typeof rawKind !== "object") {
      throw new CrewdeckError(`Invalid kind '${name}'`, "invalid_config");
    }
    const kind = { ...rawKind };
    if (!LIFECYCLES.has(kind.lifecycle)) {
      throw new CrewdeckError(`Kind ${name}: lifecycle must be report or change`, "invalid_config");
    }
    if (typeof kind.description !== "string" || kind.description.trim().length < 8) {
      throw new CrewdeckError(`Kind ${name}: description is required`, "invalid_config");
    }
    if (!kind.permissions || !["read-only", "write"].includes(kind.permissions.filesystem)) {
      throw new CrewdeckError(`Kind ${name}: permissions.filesystem must be read-only or write`, "invalid_config");
    }
    if (typeof kind.permissions.shell !== "boolean") {
      throw new CrewdeckError(`Kind ${name}: permissions.shell must be boolean`, "invalid_config");
    }
    if (
      !Array.isArray(kind.tools) ||
      kind.tools.length === 0 ||
      kind.tools.some((tool) => typeof tool !== "string" || !BUILTIN_TOOLS.has(tool)) ||
      new Set(kind.tools).size !== kind.tools.length
    ) {
      throw new CrewdeckError(
        `Kind ${name}: tools must be a unique non-empty list of Crewdeck-supported built-in tools`,
        "invalid_config",
      );
    }
    kind.skills ||= [];
    if (!Array.isArray(kind.skills) || kind.skills.some((skill) => typeof skill !== "string" || !skill.trim())) {
      throw new CrewdeckError(`Kind ${name}: skills must be a list of paths`, "invalid_config");
    }
    if (kind.lifecycle === "report") {
      if (
        kind.permissions.filesystem !== "read-only" ||
        kind.permissions.shell !== false ||
        kind.tools.some((tool) => MUTATING_TOOLS.has(tool)) ||
        !["after-collection", "manual"].includes(kind.cleanup)
      ) {
        throw new CrewdeckError(
          `Kind ${name}: report kinds must be read-only, shell-free, and clean up after-collection or manually`,
          "invalid_config",
        );
      }
    } else if (
      kind.permissions.filesystem !== "write" ||
      kind.permissions.shell !== true ||
      !kind.tools.includes("bash") ||
      !kind.tools.some((tool) => tool === "edit" || tool === "write") ||
      kind.cleanup !== "after-integration"
    ) {
      throw new CrewdeckError(
        `Kind ${name}: change kinds must allow writes and shell, include bash plus edit/write, and clean up after-integration`,
        "invalid_config",
      );
    }
    if (kind.prompt !== undefined && (typeof kind.prompt !== "string" || !kind.prompt.trim())) {
      throw new CrewdeckError(`Kind ${name}: prompt must be a non-empty string`, "invalid_config");
    }
    kind.description = kind.description.trim();
    kind.prompt = kind.prompt?.trim();
    kind.resolvedSkills = kind.skills.map((skill) =>
      path.resolve(path.dirname(kindsPath), expandHome(skill)),
    );
    for (const skillPath of kind.resolvedSkills) {
      try {
        const skillStat = await stat(skillPath);
        if (!skillStat.isFile() && !skillStat.isDirectory()) throw new Error("not a file or directory");
      } catch (error) {
        throw new CrewdeckError(`Kind ${name}: cannot load skill ${skillPath}: ${error.message}`, "invalid_config");
      }
    }
    kinds[name] = kind;
  }
  if (Object.keys(kinds).length === 0) {
    throw new CrewdeckError(`${kindsPath} must configure at least one kind`, "invalid_config");
  }
  return { path: kindsPath, kinds };
}

async function loadProfiles(config, configAbsolute, configuredKinds) {
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
      profile.allowedKinds.some((kind) => !configuredKinds.has(kind))
    ) {
      throw new CrewdeckError(
        `Profile ${name}: allowedKinds must name configured kinds`,
        "invalid_config",
      );
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
  const loadedKinds = await loadKinds(config, absolute);
  const loadedProfiles = await loadProfiles(config, absolute, new Set(Object.keys(loadedKinds.kinds)));
  config.__path = absolute;
  config.__kindsPath = loadedKinds.path;
  config.__profilesPath = loadedProfiles.path;
  config.kinds = loadedKinds.kinds;
  config.profiles = loadedProfiles.profiles;
  config.defaultProfile = loadedProfiles.defaultProfile;
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

function validateTaskInput(task, config) {
  if (!TASK_ID_RE.test(task.id || "")) {
    throw new CrewdeckError(
      `Invalid task id '${task.id}'. Use 1-24 lowercase letters, digits, or hyphens, starting with a letter`,
      "invalid_task",
    );
  }
  if (typeof task.task !== "string" || task.task.trim().length < 8) {
    throw new CrewdeckError(`Task ${task.id} needs a concrete description`, "invalid_task");
  }
  if (!KIND_NAME_RE.test(task.kind || "") || !config.kinds[task.kind]) {
    throw new CrewdeckError(
      `Task ${task.id} must declare a kind configured in ${config.__kindsPath}`,
      "invalid_task",
    );
  }
}

function agentName(id) {
  return `cd_${id.replaceAll("-", "_")}`;
}

function workerPrompt(task, project, kind) {
  const delivery =
    kind.lifecycle === "report"
      ? [
          `This is a ${task.kind} report task: ${kind.description}`,
          "Filesystem access is strictly read-only and no shell is available. Analyze only; a recommendation never authorizes implementation.",
          "Finish by calling crew_complete exactly once with a self-contained report: conclusion, findings, evidence, recommendations, and openQuestions.",
        ]
      : [
          `This is a ${task.kind} change task: ${kind.description}`,
          "Implement the accepted scope, run relevant tests, and commit the result on the current branch.",
          "Finish by calling crew_complete exactly once with summary, the exact HEAD commit hash, tests, risks, and openQuestions.",
        ];
  if (kind.prompt) delivery.splice(1, 0, kind.prompt);
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
    CREWDECK_TASK_LIFECYCLE: record.lifecycle,
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
  validateTaskInput(task, config);
  const kind = config.kinds[task.kind];
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
    lifecycle: kind.lifecycle,
    cleanup: kind.cleanup,
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
    "--no-skills",
    "--tools",
    [...kind.tools, "crew_complete"].join(","),
  ];
  for (const skill of kind.resolvedSkills) piArgs.push("--skill", skill);
  if (kind.lifecycle === "report") {
    piArgs.push("--no-approve");
  } else if (project.trustProjectResources === true) {
    piArgs.push("--approve");
  }

  try {
    await bindWorkerEnvironment(paneId, record);
    await startAgentWhenShellReady(name, paneId, piArgs);
    await run("herdr", ["agent", "prompt", name, workerPrompt(task, project, kind)], { timeout: 15_000 });
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
    validateTaskInput(task, config);
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

async function missingWorkspace(record) {
  try {
    await runJson("herdr", ["workspace", "get", record.workspaceId], { timeout: 10_000 });
    return false;
  } catch (error) {
    if (/workspace_not_found|workspace[^\n]*not found|not found[^\n]*workspace/i.test(error.message)) return true;
    throw new CrewdeckError(
      "Cannot prove that the Herdr workspace is absent; reconciliation is refused",
      "workspace_state_unknown",
      { error: error.message },
    );
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
  const config = await loadConfig(configPath);
  const state = await loadState();
  const records = id ? [state.tasks[id]].filter(Boolean) : Object.values(state.tasks);
  if (id && records.length === 0) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  return Promise.all(
    records.map(async (storedRecord) => {
      const record = {
        ...storedRecord,
        kind: storedRecord.kind || (storedRecord.profile === "scout" ? "scout" : "build"),
      };
      record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
      record.cleanup ||= config.kinds[record.kind]?.cleanup ||
        (record.lifecycle === "report" ? "after-collection" : "after-integration");
      if (
        record.status === "cleaned" ||
        record.status === "orphan-reconciled" ||
        (record.status === "abandoned" && record.cleanedAt)
      ) {
        const terminal = {
          ...publicTaskRecord(record),
          observedStatus: record.status,
          agent: { available: false, state: "closed" },
          git: { available: false, state: "worktree-removed" },
        };
        if (["abandoned", "orphan-reconciled"].includes(record.status)) {
          terminal.result = publicTaskReport(await readTaskReport(record));
        }
        return terminal;
      }
      const [agent, snapshot, result] = await Promise.all([
        liveAgent(record),
        gitSnapshot(record),
        readTaskReport(record),
      ]);
      let observedStatus = record.status;
      if (record.status === "abandoned" && !record.cleanedAt) observedStatus = "abandon-cleanup-pending";
      if (record.status === "running" && agent.state === "blocked") observedStatus = "blocked";
      if (record.lifecycle === "report" && result.available) {
        observedStatus = record.resultCollectedAt ? "report-collected" : "report-ready";
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
      };
    }),
  );
}

export async function getPendingResultIds(configPath) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const pending = [];
  for (const storedRecord of Object.values(state.tasks)) {
    if (storedRecord.resultCollectedAt || storedRecord.status === "cleaned") continue;
    const record = { ...storedRecord };
    record.kind ||= record.profile === "scout" ? "scout" : "build";
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle ||
      (record.kind === "scout" ? "report" : "change");
    const result = await readTaskReport(record);
    if (result.available) pending.push(record.id);
  }
  return pending.sort();
}

export async function getTaskDiff(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  if (record.lifecycle !== "change") {
    throw new CrewdeckError("Report tasks have no integration diff", "read_only_task");
  }
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

export async function collectResults(configPath, ids, { cleanupReports, cleanupScouts } = {}) {
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
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
    record.cleanup ||= config.kinds[record.kind]?.cleanup ||
      (record.lifecycle === "report" ? "after-collection" : "after-integration");
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

  const shouldCleanupReports = cleanupReports ?? cleanupScouts ?? true;
  if (shouldCleanupReports) {
    for (const item of collected) {
      if (
        item.task.lifecycle !== "report" ||
        item.task.cleanup !== "after-collection" ||
        item.task.status === "cleaned"
      ) continue;
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
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  const project = resolveProject(config, record.project);
  if (record.lifecycle !== "change") {
    throw new CrewdeckError("Report tasks cannot be integrated", "read_only_task");
  }
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

export async function abandonTask(configPath, id, { reason } = {}) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  record.cleanup ||= config.kinds[record.kind]?.cleanup ||
    (record.lifecycle === "report" ? "after-collection" : "after-integration");
  if (record.lifecycle !== "change") {
    throw new CrewdeckError("Report tasks cannot be abandoned", "read_only_task");
  }
  const project = resolveProject(config, record.project);
  if (
    record.branch !== `crew/${id}` ||
    path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
    path.resolve(record.repo) !== project.path
  ) {
    throw new CrewdeckError("Task does not reference its expected isolated Git resources", "unsafe_task_resources");
  }
  if (record.status === "integrated") {
    throw new CrewdeckError("Integrated tasks cannot be abandoned", "already_integrated");
  }
  if (record.status === "abandoned") {
    throw new CrewdeckError("Task is already abandoned", "already_abandoned");
  }
  if (record.status === "cleaned" || record.cleanedAt) {
    throw new CrewdeckError("Cleaned tasks cannot be abandoned", "already_cleaned");
  }
  if (reason !== undefined && (typeof reason !== "string" || !reason.trim())) {
    throw new CrewdeckError("Abandonment reason must be a non-empty string", "invalid_reason");
  }
  const agent = await liveAgent(record);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Worker is ${agent.state}; wait until it settles before abandonment`, "worker_not_settled");
  }
  const snapshot = await gitSnapshot(record);
  if (!snapshot.available || !snapshot.clean) {
    throw new CrewdeckError("Worktree is not clean; abandonment never discards uncommitted data", "dirty_worktree", snapshot);
  }

  const previousStatus = record.status;
  record.status = "abandoned";
  record.abandonedFromStatus = previousStatus;
  record.abandonedAt = new Date().toISOString();
  if (reason !== undefined) record.abandonmentReason = reason.trim();
  delete record.error;
  await withStateLock(async () => {
    const next = await loadState();
    if (next.tasks[id]?.status !== previousStatus) {
      throw new CrewdeckError("Task state changed during abandonment", "state_changed");
    }
    next.tasks[id] = record;
    await saveState(next);
  });

  // The durable abandonment transition happens before destructive cleanup. If
  // cleanup is interrupted, a later explicitly confirmed cleanup can resume it.
  return cleanupTask(configPath, id);
}

export async function reconcileOrphanReport(configPath, id, { reason } = {}) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  record.cleanup ||= config.kinds[record.kind]?.cleanup ||
    (record.lifecycle === "report" ? "after-collection" : "after-integration");
  if (record.lifecycle !== "report") {
    throw new CrewdeckError("Only report tasks can use orphan reconciliation; use abandonment for changes", "report_task_required");
  }
  if (record.status === "orphan-reconciled") {
    throw new CrewdeckError("Task orphan resources were already reconciled", "already_reconciled");
  }
  if (record.status === "cleaned" || record.cleanedAt) {
    throw new CrewdeckError("Cleaned tasks cannot be reconciled as orphans", "already_cleaned");
  }
  if (!["starting", "running"].includes(record.status)) {
    throw new CrewdeckError(`Report task status '${record.status}' is not eligible for orphan reconciliation`, "invalid_orphan_state");
  }
  if (typeof reason !== "string" || !reason.trim()) {
    throw new CrewdeckError("Orphan reconciliation requires a non-empty durable reason", "invalid_reason");
  }
  const project = resolveProject(config, record.project);
  if (
    record.branch !== `crew/${id}` ||
    path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
    path.resolve(record.repo) !== project.path
  ) {
    throw new CrewdeckError("Task does not reference its expected isolated resources", "unsafe_task_resources");
  }

  const agent = await liveAgent(record);
  if (agent.available) {
    throw new CrewdeckError("The Herdr agent still exists; orphan reconciliation requires absent resources", "orphan_resources_present", { agent });
  }
  if (!(await missingWorkspace(record))) {
    throw new CrewdeckError("The Herdr workspace still exists; use normal collection or cleanup", "orphan_resources_present");
  }

  try {
    await stat(record.worktree);
    const snapshot = await gitSnapshot(record);
    if (snapshot.available && !snapshot.clean) {
      throw new CrewdeckError("Worktree is dirty; reconciliation never discards uncommitted data", "dirty_worktree", snapshot);
    }
    throw new CrewdeckError("The Git worktree still exists; use normal collection or cleanup", "orphan_resources_present", snapshot);
  } catch (error) {
    if (error instanceof CrewdeckError) throw error;
    if (error.code !== "ENOENT") {
      throw new CrewdeckError("Cannot prove that the Git worktree is absent", "worktree_state_unknown", { error: error.message });
    }
  }

  const baseHead = (await git(record.repo, ["rev-parse", record.base])).stdout;
  const branchExists = (await git(record.repo, [
    "branch", "--list", record.branch, "--format=%(refname)",
  ])).stdout === `refs/heads/${record.branch}`;
  if (branchExists) {
    const ahead = Number((await git(record.repo, ["rev-list", "--count", `${record.base}..${record.branch}`])).stdout);
    if (ahead > 0) {
      throw new CrewdeckError(
        "The report branch contains commits not integrated into base; reconciliation refuses to discard them",
        "unintegrated_branch",
        { branch: record.branch, ahead },
      );
    }
  }

  const worktrees = (await git(record.repo, ["worktree", "list", "--porcelain"])).stdout
    .split(/\n\n+/)
    .filter(Boolean)
    .map((block) => Object.fromEntries(block.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    })));
  const branchRef = `refs/heads/${record.branch}`;
  const unexpectedCheckout = worktrees.find(
    (item) => item.branch === branchRef && path.resolve(item.worktree) !== path.resolve(record.worktree),
  );
  if (unexpectedCheckout) {
    throw new CrewdeckError("The residual branch is checked out in another worktree", "orphan_resources_present", unexpectedCheckout);
  }
  const staleRegistration = worktrees.find((item) => path.resolve(item.worktree) === path.resolve(record.worktree));
  if (staleRegistration) {
    if (staleRegistration.branch !== branchRef) {
      throw new CrewdeckError("Stale worktree metadata references an unexpected branch", "unsafe_git_metadata", staleRegistration);
    }
    await git(record.repo, ["worktree", "remove", "--force", record.worktree]);
  }
  if (branchExists) await git(record.repo, ["branch", "-d", record.branch]);
  const finalBaseHead = (await git(record.repo, ["rev-parse", record.base])).stdout;
  if (finalBaseHead !== baseHead) {
    throw new CrewdeckError("Base branch changed concurrently during orphan reconciliation", "base_changed");
  }

  const previousStatus = record.status;
  record.status = "orphan-reconciled";
  record.orphanReconciledFromStatus = previousStatus;
  record.orphanReconciledAt = new Date().toISOString();
  record.orphanReconciliationReason = reason.trim();
  delete record.error;
  await withStateLock(async () => {
    const next = await loadState();
    if (next.tasks[id]?.status !== previousStatus) {
      throw new CrewdeckError("Task state changed during orphan reconciliation", "state_changed");
    }
    next.tasks[id] = record;
    await saveState(next);
  });
  return publicTaskRecord(record);
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
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  record.cleanup ||= config.kinds[record.kind]?.cleanup ||
    (record.lifecycle === "report" ? "after-collection" : "after-integration");
  if (record.status === "cleaned" || record.cleanedAt) {
    throw new CrewdeckError("Task is already cleaned", "already_cleaned");
  }
  if (record.status === "orphan-reconciled") {
    throw new CrewdeckError("Orphan reconciliation is already complete", "already_reconciled");
  }
  if (record.lifecycle === "change" && !["integrated", "abandoned"].includes(record.status)) {
    throw new CrewdeckError("Change tasks can be cleaned only after integration or explicit abandonment", "not_integrated");
  }
  if (record.status === "abandoned") {
    const project = resolveProject(config, record.project);
    if (
      record.branch !== `crew/${id}` ||
      path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
      path.resolve(record.repo) !== project.path
    ) {
      throw new CrewdeckError("Task does not reference its expected isolated Git resources", "unsafe_task_resources");
    }
  }
  if (record.lifecycle === "report") {
    if (!record.resultCollectedAt) {
      throw new CrewdeckError("Report result must be collected before cleanup", "result_not_collected");
    }
    const result = await readTaskReport(record);
    if (!result.available) throw new CrewdeckError("Durable report is missing", "missing_result");
  }
  const agent = await liveAgent(record);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Worker is ${agent.state}; wait until it settles before cleanup`, "worker_not_settled");
  }
  const snapshot = await gitSnapshot(record);
  let worktreeAlreadyRemoved = false;
  if (!snapshot.available && record.status === "abandoned") {
    try {
      await stat(record.worktree);
    } catch (error) {
      if (error.code === "ENOENT") worktreeAlreadyRemoved = true;
      else throw error;
    }
  }
  if ((!snapshot.available && !worktreeAlreadyRemoved) || (snapshot.available && !snapshot.clean)) {
    throw new CrewdeckError("Worktree is not clean", "dirty_worktree", snapshot);
  }
  if (record.lifecycle === "report" && snapshot.ahead !== 0) {
    throw new CrewdeckError("Report branch unexpectedly contains commits", "report_has_commits");
  }
  try {
    await run("herdr", ["agent", "send-keys", record.agentName, "ctrl+d"], { timeout: 10_000 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  } catch {
    // An already exited agent is fine; worktree removal remains the authority.
  }
  if (!worktreeAlreadyRemoved) {
    await runJson("herdr", ["worktree", "remove", "--workspace", record.workspaceId], { timeout: 30_000 });
  } else {
    try {
      await runJson("herdr", ["workspace", "close", record.workspaceId], { timeout: 15_000 });
    } catch {
      // The isolated worktree is already absent; preserving an unknown workspace is safer than forcing cleanup.
    }
  }
  try {
    await git(record.repo, ["branch", record.status === "abandoned" ? "-D" : "-d", record.branch]);
  } catch (error) {
    if (record.status === "abandoned") {
      throw new CrewdeckError("Abandoned worktree was removed but its isolated branch was preserved", "branch_cleanup_failed", {
        branch: record.branch,
        error: error.message,
      });
    }
    // Integrated work is safe even if non-forced branch deletion is refused.
  }
  if (record.status !== "abandoned") record.status = "cleaned";
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
          other.status !== "cleaned" &&
          !other.cleanedAt,
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
