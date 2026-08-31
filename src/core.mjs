import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { createPublicationService } from "./core/publication.mjs";
import { createReconciliationService } from "./core/reconciliation.mjs";
import { createReviewService } from "./core/review.mjs";
import { COLLECTION_LIMIT, createStatusService } from "./core/status.mjs";

export { DEFAULT_STATUS_LIMIT, MAX_STATUS_LIMIT, STATUS_OUTPUT_BUDGET_BYTES } from "./core/status.mjs";

const execFileAsync = promisify(execFile);
const TASK_ID_RE = /^[a-z][a-z0-9-]{0,23}$/;
const KIND_NAME_RE = /^[a-z][a-z0-9-]{0,31}$/;
const LIFECYCLES = new Set(["report", "change"]);
const CONTRACTS = new Set(["standard", "review"]);
const WORKFLOWS = new Set(["direct", "reviewed-pr"]);
const BUILTIN_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
const MUTATING_TOOLS = new Set(["bash", "edit", "write"]);
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const REVIEW_DEPTHS = new Set(["standard", "deep"]);
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

function taskCandidatesPath(id) {
  return path.join(reportsRoot(), `${id}.candidates.json`);
}

async function readCandidateJournal(record) {
  try {
    const journal = JSON.parse(await readFile(taskCandidatesPath(record.id), "utf8"));
    if (
      journal.schemaVersion !== 1 ||
      journal.taskId !== record.id ||
      journal.kind !== record.kind ||
      journal.workflow !== "reviewed-pr" ||
      journal.token !== record.reportToken ||
      !Array.isArray(journal.candidates) ||
      journal.candidates.some(
        (candidate, index) =>
          candidate?.version !== index + 1 ||
          !/^[0-9a-f]{40}$/.test(candidate.head || "") ||
          !candidate.payload ||
          candidate.payload.commit !== candidate.head,
      )
    ) {
      return { available: false, error: "Candidate journal identity or sequence does not match the task" };
    }
    return { available: true, path: taskCandidatesPath(record.id), journal };
  } catch (error) {
    if (error.code === "ENOENT") return { available: false, state: "missing" };
    return { available: false, error: error.message };
  }
}

const reviewService = createReviewService({ CrewdeckError, git, readCandidateJournal, reportsRoot });
const createReviewEvidence = reviewService.createReviewEvidence;
const verifyReviewEvidence = reviewService.verifyReviewEvidence;

async function readTaskReport(record) {
  try {
    const report = JSON.parse(await readFile(taskReportPath(record.id), "utf8"));
    if (
      report.schemaVersion !== 1 ||
      report.taskId !== record.id ||
      report.kind !== record.kind ||
      (report.lifecycle !== undefined && record.lifecycle !== undefined && report.lifecycle !== record.lifecycle) ||
      (record.contract === "review" &&
        (report.contract !== "review" ||
          report.parentTaskId !== record.parentTaskId ||
          report.reviewedHead !== record.reviewedHead ||
          report.payload?.parentTaskId !== record.parentTaskId ||
          report.payload?.reviewedHead !== record.reviewedHead)) ||
      report.token !== record.reportToken ||
      (record.reviewEvidence && report.payload?.evidenceSha256 !== record.reviewEvidence.contentSha256) ||
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
  if (!result.available) return { available: false, state: result.state || "error", error: safeDiagnosticText(result.error, 512) };
  const { token: _token, ...report } = result.report;
  return { available: true, ref: `result:${report.taskId}`, report };
}

function publicCandidateJournal(result) {
  if (!result.available) return { available: false, state: result.state || "error", error: safeDiagnosticText(result.error, 512) };
  const { token: _token, ...journal } = result.journal;
  return { available: true, ref: `candidates:${journal.taskId}`, journal };
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

const STATE_LOCK_GRACE_MS = 2_000;

async function linuxProcessIdentity(pid) {
  try {
    const [statLine, bootId] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const close = statLine.lastIndexOf(")");
    const fields = statLine.slice(close + 2).split(" ");
    return { bootId: bootId.trim(), startTicks: fields[19] };
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    return { unknown: error.message };
  }
}

async function inspectStateLock() {
  const lock = path.join(stateRoot(), ".lock");
  let lockStat;
  try {
    lockStat = await stat(lock);
  } catch (error) {
    if (error.code === "ENOENT") return { status: "unlocked", lock };
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
  } catch (error) {
    return { status: "unverifiable", lock, ageMs: Date.now() - lockStat.mtimeMs, reason: error.message };
  }
  if (typeof owner?.host === "string" && owner.host !== os.hostname()) {
    return { status: "foreign", lock, owner, ageMs: Date.now() - lockStat.mtimeMs, reason: "multi-host lock recovery is unsupported" };
  }
  const valid = owner?.schemaVersion === 1 && owner.host === os.hostname() &&
    Number.isInteger(owner.pid) && owner.pid > 0 && /^[0-9a-f]{32}$/.test(owner.token || "") &&
    typeof owner.acquiredAt === "string" && !Number.isNaN(Date.parse(owner.acquiredAt)) && typeof owner.bootId === "string" &&
    typeof owner.startTicks === "string";
  if (!valid) return { status: "unverifiable", lock, owner, ageMs: Date.now() - lockStat.mtimeMs, reason: "invalid owner identity" };
  const processIdentity = await linuxProcessIdentity(owner.pid);
  if (processIdentity?.unknown) {
    return { status: "unverifiable", lock, owner, ageMs: Date.now() - lockStat.mtimeMs, reason: processIdentity.unknown };
  }
  const active = processIdentity?.bootId === owner.bootId && processIdentity?.startTicks === owner.startTicks;
  return {
    status: active ? "active" : "dead",
    lock,
    owner,
    ageMs: Date.now() - lockStat.mtimeMs,
    ...(active ? {} : { reason: processIdentity ? "pid identity was reused" : "owner process is absent" }),
  };
}

async function quarantineStateLock(diagnostic, { allowUnverifiable = false } = {}) {
  if (diagnostic.status !== "dead" && !(allowUnverifiable && diagnostic.status === "unverifiable")) return false;
  if (diagnostic.ageMs < STATE_LOCK_GRACE_MS) return false;
  const quarantine = `${diagnostic.lock}.recovery-${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    await rename(diagnostic.lock, quarantine);
  } catch (error) {
    if (error.code === "ENOENT") return true;
    throw error;
  }
  // Renaming, rather than deleting in place, prevents a recovering process from
  // deleting a successor lock. Active, identity-matching owners are never moved.
  await rm(quarantine, { recursive: true, force: true });
  return true;
}

export async function stateLockStatus() {
  await mkdir(stateRoot(), { recursive: true, mode: 0o700 });
  return inspectStateLock();
}

export async function recoverStateLock({ reason } = {}) {
  if (typeof reason !== "string" || !reason.trim()) {
    throw new CrewdeckError("State lock recovery requires a durable operator reason", "invalid_reason");
  }
  const diagnostic = await inspectStateLock();
  if (diagnostic.status === "unlocked") return { recovered: false, idempotent: true, diagnostic };
  if (diagnostic.status === "active") {
    throw new CrewdeckError("Active Crewdeck state locks are never stolen", "active_state_lock", diagnostic);
  }
  if (diagnostic.status === "foreign") {
    throw new CrewdeckError("Crewdeck makes no multi-host lock recovery claim", "multi_host_lock_unsupported", diagnostic);
  }
  if (diagnostic.ageMs < STATE_LOCK_GRACE_MS) {
    throw new CrewdeckError("State lock is inside the bounded recovery grace period", "state_lock_grace", diagnostic);
  }
  const recovered = await quarantineStateLock(diagnostic, { allowUnverifiable: true });
  if (!recovered) throw new CrewdeckError("State lock changed during recovery", "state_lock_changed", diagnostic);
  const event = { recoveredAt: new Date().toISOString(), reason: reason.trim(), diagnostic };
  await writeFile(path.join(stateRoot(), "last-lock-recovery.json"), `${JSON.stringify(event, null, 2)}\n`, { mode: 0o600 });
  return { recovered: true, ...event };
}

export async function withStateLock(fn) {
  const root = stateRoot();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = path.join(root, ".lock");
  const deadline = Date.now() + 10_000;
  let token;
  while (true) {
    try {
      await mkdir(lock, { mode: 0o700 });
      token = randomBytes(16).toString("hex");
      const identity = await linuxProcessIdentity(process.pid);
      if (!identity || identity.unknown) throw new CrewdeckError("Cannot establish process identity for state lock", "lock_identity_unavailable");
      await writeFile(path.join(lock, "owner.json"), `${JSON.stringify({
        schemaVersion: 1, token, host: os.hostname(), pid: process.pid,
        bootId: identity.bootId, startTicks: identity.startTicks, acquiredAt: new Date().toISOString(),
      }, null, 2)}\n`, { mode: 0o600 });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") {
        if (token) await rm(lock, { recursive: true, force: true });
        throw error;
      }
      const diagnostic = await inspectStateLock();
      if (diagnostic.status === "dead" && diagnostic.ageMs >= STATE_LOCK_GRACE_MS) {
        if (await quarantineStateLock(diagnostic)) {
          await writeFile(path.join(root, "last-lock-recovery.json"), `${JSON.stringify({
            recoveredAt: new Date().toISOString(), reason: "automatic-dead-owner-proof", diagnostic,
          }, null, 2)}\n`, { mode: 0o600 });
          continue;
        }
      }
      if (Date.now() >= deadline) {
        throw new CrewdeckError("Crewdeck state is busy", "state_locked", diagnostic);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      const owner = JSON.parse(await readFile(path.join(lock, "owner.json"), "utf8"));
      if (owner.token === token) await rm(lock, { recursive: true, force: true });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

export function defaultConfigPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "crewdeck.json");
}

async function loadRawConfig(configPath) {
  const absolute = path.resolve(configPath);
  try {
    return { absolute, config: JSON.parse(await readFile(absolute, "utf8")) };
  } catch (error) {
    if (error.code === "ENOENT" && absolute === defaultConfigPath()) {
      throw new CrewdeckError(
        `Default Crewdeck config not found at ${absolute}. Bootstrap the local runtime config from the tracked templates:\n` +
          `  cp crewdeck.json.example crewdeck.json\n` +
          `  cp config/profiles.yml.example config/profiles.yml\n` +
          `Then edit crewdeck.json (register this machine's projects) and config/profiles.yml (providers/models available here).`,
        "missing_config",
      );
    }
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
    const kind = { contract: "standard", ...rawKind };
    if (!LIFECYCLES.has(kind.lifecycle)) {
      throw new CrewdeckError(`Kind ${name}: lifecycle must be report or change`, "invalid_config");
    }
    if (!CONTRACTS.has(kind.contract)) {
      throw new CrewdeckError(`Kind ${name}: contract must be standard or review`, "invalid_config");
    }
    if (kind.contract === "review" && kind.lifecycle !== "report") {
      throw new CrewdeckError(`Kind ${name}: review contracts must use the report lifecycle`, "invalid_config");
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
  config.maxReviewRounds ??= 3;
  if (!Number.isInteger(config.maxReviewRounds) || config.maxReviewRounds < 1 || config.maxReviewRounds > 10) {
    throw new CrewdeckError("maxReviewRounds must be an integer from 1 to 10", "invalid_config");
  }
  config.prObserverIntervalSeconds ??= 60;
  if (!Number.isInteger(config.prObserverIntervalSeconds) || config.prObserverIntervalSeconds < 30 || config.prObserverIntervalSeconds > 900) {
    throw new CrewdeckError("prObserverIntervalSeconds must be an integer from 30 to 900", "invalid_config");
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
  for (const [name, project] of Object.entries(config.projects)) {
    project.githubChecks ??= "required";
    if (!["required", "none"].includes(project.githubChecks)) {
      throw new CrewdeckError(`Project ${name}: githubChecks must be required or none`, "invalid_config");
    }
  }
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
  if (typeof project.base !== "string" || !project.base.trim()) {
    throw new CrewdeckError(`Project ${project.name}: base must name a branch`, "invalid_project");
  }
  try {
    await git(project.path, ["check-ref-format", "--branch", project.base]);
  } catch {
    throw new CrewdeckError(`Project ${project.name}: base is not a valid branch name`, "invalid_project");
  }
  if (project.baseRemote !== undefined &&
      (typeof project.baseRemote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(project.baseRemote))) {
    throw new CrewdeckError(`Project ${project.name}: baseRemote is not a valid explicit remote name`, "invalid_project");
  }
  if (project.baseRemote === undefined) await git(project.path, ["rev-parse", "--verify", `${project.base}^{commit}`]);
}

function parseRemoteBranch(output, ref) {
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) return undefined;
  const match = lines[0].match(/^([0-9a-f]{40})\t(.+)$/);
  return match?.[2] === ref ? match[1] : undefined;
}

async function resolveChangeBase(project) {
  const ref = `refs/heads/${project.base}`;
  if (project.baseRemote === undefined) {
    const sha = (await git(project.path, ["rev-parse", "--verify", `${project.base}^{commit}`])).stdout;
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      throw new CrewdeckError(`Cannot prove local base ${project.base} as an exact commit`, "local_base_unproven");
    }
    return { sha, source: { mode: "local", ref } };
  }

  const remote = project.baseRemote;
  try {
    await git(project.path, ["remote", "get-url", remote]);
  } catch (error) {
    throw new CrewdeckError(`Configured base remote '${remote}' is unavailable`, "base_remote_unavailable", {
      error: error.message,
    });
  }
  const readAdvertisedSha = async () => {
    let output;
    try {
      output = (await git(project.path, ["ls-remote", "--refs", "--heads", remote, ref], { timeout: 30_000 })).stdout;
    } catch (error) {
      throw new CrewdeckError(`Cannot read configured remote base ${remote}/${project.base}`, "remote_base_unavailable", {
        error: error.message,
      });
    }
    const sha = parseRemoteBranch(output, ref);
    if (!sha) {
      throw new CrewdeckError(`Configured remote base ${remote}/${project.base} is missing or ambiguous`, "remote_base_ref_unproven");
    }
    return sha;
  };

  const advertisedBefore = await readAdvertisedSha();
  try {
    await git(project.path, [
      "fetch",
      "--no-tags",
      "--no-write-fetch-head",
      "--refmap=",
      remote,
      ref,
    ], { timeout: 120_000 });
  } catch (error) {
    throw new CrewdeckError(`Fetch failed for configured remote base ${remote}/${project.base}`, "remote_base_fetch_failed", {
      error: error.message,
    });
  }
  const advertisedAfter = await readAdvertisedSha();
  if (advertisedAfter !== advertisedBefore) {
    throw new CrewdeckError(`Configured remote base ${remote}/${project.base} changed during fetch`, "remote_base_changed");
  }
  try {
    const commit = (await git(project.path, ["rev-parse", "--verify", `${advertisedAfter}^{commit}`])).stdout;
    if (commit !== advertisedAfter) throw new Error("advertised object is not the exact commit");
  } catch (error) {
    throw new CrewdeckError(`Fetched SHA for ${remote}/${project.base} cannot be proven as a commit`, "remote_base_sha_unproven", {
      sha: advertisedAfter,
      error: error.message,
    });
  }
  return { sha: advertisedAfter, source: { mode: "remote", remote, ref } };
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
  task.workflow ||= "direct";
  if (!WORKFLOWS.has(task.workflow)) {
    throw new CrewdeckError(`Task ${task.id} has an invalid workflow`, "invalid_task");
  }
  const kind = config.kinds[task.kind];
  if (task.workflow === "reviewed-pr" && kind.lifecycle !== "change") {
    throw new CrewdeckError("Only change tasks can use workflow=reviewed-pr", "invalid_task");
  }
  if (kind.contract === "review" && (!task.parentTaskId || !task.reviewedHead)) {
    throw new CrewdeckError("Review tasks must be spawned with parentTaskId and reviewedHead", "invalid_review_contract");
  }
  if (kind.contract === "review" && !REVIEW_DEPTHS.has(task.reviewDepth || "standard")) {
    throw new CrewdeckError("Review depth must be standard or deep", "invalid_review_depth");
  }
}

function agentName(id) {
  return `cd_${id.replaceAll("-", "_")}`;
}

function workerPrompt(task, project, kind) {
  let delivery;
  if (kind.contract === "review") {
    delivery = [
      `This is a ${task.kind} review task: ${kind.description}`,
      `Review exactly commit ${task.reviewedHead} for parent build ${task.parentTaskId}. The detached worktree is immutable; never review another HEAD.`,
      `Start with the authoritative review context at ${task.reviewEvidence?.path || "(unavailable)"}. Crewdeck verifies its exact-SHA identity and attached patch digests deterministically.`,
      task.reviewDepth === "deep"
        ? "This is an explicit deep review. Inspect the complete change and relevant architecture, security, concurrency, persistence, and regression surfaces. Stay evidence-based and avoid unrelated cleanup advice."
        : "This is a standard bounded review. Start with the correction delta when present, then inspect changed code, direct callers, and associated tests only. Do not audit unrelated repository areas. Stop after one focused pass when no concrete defect remains; keep findings concise and actionable.",
      "Filesystem access is strictly read-only and no shell is available. Do not attempt to rerun tests, message, or steer the build agent; assess declared test evidence and code instead.",
      "Finish by calling crew_complete exactly once with the bound parentTaskId/reviewedHead, verdict, concise summary, structured findings, checks, and openQuestions. Crewdeck attaches the evidence digest automatically.",
    ];
  } else if (kind.lifecycle === "report") {
    delivery = [
      `This is a ${task.kind} report task: ${kind.description}`,
      "Filesystem access is strictly read-only and no shell is available. Analyze only; a recommendation never authorizes implementation.",
      "Finish by calling crew_complete exactly once with a self-contained report: conclusion, findings, evidence, recommendations, and openQuestions.",
    ];
  } else if (task.workflow === "reviewed-pr") {
    delivery = [
      `This is a ${task.kind} change task using the reviewed-pr workflow: ${kind.description}`,
      "Implement the accepted scope, run relevant tests, and commit the result on the current crew/<id> branch.",
      `Submit each clean exact HEAD with crew_submit_candidate. It stores a versioned candidate without ending this agent; remain available for orchestrator steering. At most ${task.maxReviewRounds} rounds are allowed.`,
      "Do not call crew_complete for a reviewed-pr candidate.",
    ];
  } else {
    delivery = [
      `This is a ${task.kind} change task: ${kind.description}`,
      "Implement the accepted scope, run relevant tests, and commit the result on the current branch.",
      "Finish by calling crew_complete exactly once with summary, the exact HEAD commit hash, tests, risks, and openQuestions.",
    ];
  }
  if (kind.prompt) delivery.splice(1, 0, kind.prompt);
  const finalInstruction =
    task.workflow === "reviewed-pr"
      ? "A candidate is accepted only when crew_submit_candidate confirms its durable version and exact HEAD."
      : "The task is not complete until crew_complete accepts the structured result.";
  return [
    `# Task\n${task.task.trim()}`,
    `# Project\nYou are already in an isolated Git worktree of ${project.name}. Read and follow this worktree's AGENTS.md and inspect the project before acting.`,
    `# Delivery\n${delivery.join("\n")}`,
    "Stay inside this worktree. Do not push, merge, rebase, switch branches, remove the worktree, or modify another checkout.",
    "Do not wait for the orchestrator unless a real product decision or blocker prevents progress.",
    finalInstruction,
  ].join("\n\n");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function githubRepositoryFromUrl(value) {
  const url = String(value || "").trim();
  const match = url.match(
    /^(?:git@github\.com:|ssh:\/\/(?:git@)?github\.com\/|https?:\/\/github\.com\/)([^/\s]+)\/([^/\s]+?)(?:\.git)?$/i,
  );
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function validRemoteName(value) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value || "");
}

function validRepositoryName(value) {
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value || "") && !value.includes("..");
}

function validBranchName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 240 &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[~^:?*[\\\s]/.test(value) &&
    !value.split("/").some((part) => !part || part.endsWith(".lock"))
  );
}

async function bindWorkerEnvironment(paneId, record) {
  const values = {
    CREWDECK_TASK_ID: record.id,
    CREWDECK_TASK_KIND: record.kind,
    CREWDECK_TASK_LIFECYCLE: record.lifecycle,
    CREWDECK_TASK_CONTRACT: record.contract || "standard",
    CREWDECK_TASK_WORKFLOW: record.workflow || "direct",
    CREWDECK_TASK_BRANCH: record.branch || "",
    CREWDECK_TASK_BASE: record.base || "",
    CREWDECK_TASK_BASE_SHA: record.baseSha || "",
    CREWDECK_PARENT_TASK_ID: record.parentTaskId || "",
    CREWDECK_REVIEWED_HEAD: record.reviewedHead || "",
    CREWDECK_REVIEW_EVIDENCE_PATH: record.reviewEvidence?.path || "",
    CREWDECK_REVIEW_EVIDENCE_SHA256: record.reviewEvidence?.contentSha256 || "",
    CREWDECK_REVIEW_DEPTH: record.reviewDepth || "standard",
    CREWDECK_MAX_REVIEW_ROUNDS: record.effectiveMaxReviewRounds || record.maxReviewRounds || 3,
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

async function createOne(config, project, sourceWorkspace, task, profileName, changeBase) {
  validateTaskInput(task, config);
  const kind = config.kinds[task.kind];
  task.maxReviewRounds = config.maxReviewRounds;
  const selectedProfile = task.profile || profileName || config.defaultProfile;
  const profile = config.profiles[selectedProfile];
  if (!profile) throw new CrewdeckError(`Unknown profile '${selectedProfile}'`, "unknown_profile");
  if (!profile.allowedKinds.includes(task.kind)) {
    throw new CrewdeckError(`Profile '${selectedProfile}' does not allow kind=${task.kind}`, "profile_kind_mismatch");
  }
  const detached = kind.lifecycle === "report";
  const branch = detached ? null : `crew/${task.id}`;
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
  if (!detached) {
    try {
      await git(project.path, ["show-ref", "--verify", `refs/heads/${branch}`]);
      throw new CrewdeckError(`Branch ${branch} already exists`, "branch_exists");
    } catch (error) {
      if (error instanceof CrewdeckError && error.code === "branch_exists") throw error;
      if (!(error instanceof CrewdeckError) || error.details?.exitCode === 0) throw error;
    }
  }

  await mkdir(path.dirname(worktree), { recursive: true });
  let created;
  if (detached) {
    const checkoutRef = task.reviewedHead || project.base;
    await git(project.path, ["worktree", "add", "--detach", worktree, checkoutRef], { timeout: 30_000 });
    try {
      created = await runJson("herdr", [
        "worktree",
        "open",
        "--workspace",
        sourceWorkspace.id,
        "--path",
        worktree,
        "--label",
        `crew:${task.id}`,
        "--no-focus",
      ]);
    } catch (error) {
      try {
        await git(project.path, ["worktree", "remove", "--force", worktree]);
      } catch {
        // Preserve failed detached resources if Git cannot prove safe removal.
      }
      throw error;
    }
  } else {
    if (!changeBase || !/^[0-9a-f]{40}$/.test(changeBase.sha)) {
      throw new CrewdeckError("Exact change base was not proven before worktree creation", "base_sha_unproven");
    }
    created = await runJson("herdr", [
      "worktree",
      "create",
      "--workspace",
      sourceWorkspace.id,
      "--branch",
      branch,
      "--base",
      changeBase.sha,
      "--path",
      worktree,
      "--label",
      `crew:${task.id}`,
      "--no-focus",
    ]);
  }
  const workspaceId = created?.result?.workspace?.workspace_id;
  const paneId = created?.result?.root_pane?.pane_id;
  const detachedConfirmed =
    !detached ||
    (created?.result?.worktree?.is_detached === true &&
      (await git(worktree, ["branch", "--show-current"])).stdout === "");
  if (!workspaceId || !paneId || !detachedConfirmed) {
    if (detached) {
      let removedByHerdr = false;
      if (workspaceId) {
        try {
          await runJson("herdr", ["worktree", "remove", "--workspace", workspaceId], { timeout: 30_000 });
          removedByHerdr = true;
        } catch {
          // Fall back to the exact Git worktree only when Herdr cannot clean its partial response.
        }
      }
      if (!removedByHerdr) {
        try {
          await git(project.path, ["worktree", "remove", "--force", worktree]);
        } catch {
          // Preserve failed detached resources if Git cannot prove safe removal.
        }
      }
    }
    throw new CrewdeckError(
      detached && !detachedConfirmed
        ? "Herdr did not prove that the report worktree remained detached"
        : "Herdr created a worktree without workspace/pane identifiers",
      detached && !detachedConfirmed ? "detached_worktree_unproven" : "invalid_herdr_response",
    );
  }
  const checkoutHead = (await git(worktree, ["rev-parse", "HEAD"])).stdout;
  if (!detached) {
    const checkoutBranch = (await git(worktree, ["branch", "--show-current"])).stdout;
    if (checkoutBranch !== branch || checkoutHead !== changeBase.sha) {
      throw new CrewdeckError("Created change worktree does not match its pinned base SHA and owned branch", "change_worktree_unproven", {
        expectedBranch: branch,
        actualBranch: checkoutBranch,
        expectedHead: changeBase.sha,
        actualHead: checkoutHead,
      });
    }
  }

  const record = {
    id: task.id,
    project: project.name,
    description: task.task.trim(),
    kind: task.kind,
    lifecycle: kind.lifecycle,
    contract: kind.contract,
    workflow: task.workflow,
    cleanup: kind.cleanup,
    profile: selectedProfile,
    status: "starting",
    branch,
    detached,
    checkoutHead,
    ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}),
    ...(task.reviewedHead ? { reviewedHead: task.reviewedHead } : {}),
    ...(task.candidateVersion ? { candidateVersion: task.candidateVersion } : {}),
    ...(task.reviewEvidence ? { reviewEvidence: task.reviewEvidence } : {}),
    ...(kind.contract === "review" ? { reviewDepth: task.reviewDepth || "standard" } : {}),
    maxReviewRounds: config.maxReviewRounds,
    effectiveMaxReviewRounds: config.maxReviewRounds,
    base: project.base,
    ...(!detached ? { baseSource: changeBase.source, baseSha: changeBase.sha } : {}),
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
  if (record.workflow === "reviewed-pr") {
    await mkdir(reportsRoot(), { recursive: true, mode: 0o700 });
    await writeFile(path.join(reportsRoot(), `${record.id}.rounds.json`), `${JSON.stringify({
      schemaVersion: 1, taskId: record.id, token: record.reportToken,
      maxReviewRounds: record.effectiveMaxReviewRounds, updatedAt: record.createdAt,
    }, null, 2)}\n`, { mode: 0o600 });
  }

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
    [
      ...kind.tools,
      ...(task.workflow === "reviewed-pr" ? ["crew_submit_candidate"] : ["crew_complete"]),
    ].join(","),
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
  const changeBase = tasks.some((task) => config.kinds[task.kind].lifecycle === "change")
    ? await resolveChangeBase(project)
    : undefined;
  const sourceWorkspace = await ensureProjectWorkspace(project);

  // Resolve one immutable change base per batch, then start independent Pi workers concurrently.
  const results = await Promise.allSettled(
    tasks.map((task) => createOne(config, project, sourceWorkspace, task, profile, changeBase)),
  );
  return results.map((result, index) =>
    result.status === "fulfilled"
      ? { ok: true, ...result.value }
      : { ok: false, id: tasks[index].id, error: result.reason?.message || String(result.reason) },
  );
}

function reviewRoundMax(record, config) {
  return record.effectiveMaxReviewRounds || record.maxReviewRounds || config.maxReviewRounds;
}

export async function spawnReview(
  configPath,
  { id, parentTaskId, reviewedHead, task, profile, reviewDepth = "standard" },
) {
  if (process.env.HERDR_ENV !== "1") {
    throw new CrewdeckError("Crewdeck must run inside a Herdr-managed pane", "not_in_herdr");
  }
  if (!TASK_ID_RE.test(parentTaskId || "") || !/^[0-9a-f]{40}$/.test(reviewedHead || "")) {
    throw new CrewdeckError("Review requires a valid parentTaskId and full reviewedHead SHA", "invalid_review_contract");
  }
  if (!REVIEW_DEPTHS.has(reviewDepth)) {
    throw new CrewdeckError("Review depth must be standard or deep", "invalid_review_depth");
  }
  const config = await loadConfig(configPath);
  const selectedProfile = profile || config.defaultProfile;
  const reviewProfile = config.profiles[selectedProfile];
  if (!reviewProfile) throw new CrewdeckError(`Unknown profile '${selectedProfile}'`, "unknown_profile");
  if (reviewDepth === "standard" && ["xhigh", "max"].includes(reviewProfile.thinking)) {
    throw new CrewdeckError(
      `Standard review refuses ${reviewProfile.thinking} thinking; choose a medium/low profile or request reviewDepth=deep explicitly`,
      "review_profile_too_deep",
    );
  }
  const reviewKinds = Object.entries(config.kinds).filter(([, kind]) => kind.contract === "review");
  if (reviewKinds.length !== 1) {
    throw new CrewdeckError("Configure exactly one review contract kind", "invalid_review_kind_configuration");
  }
  const [kindName] = reviewKinds[0];
  const state = await loadState();
  const parent = state.tasks[parentTaskId];
  if (!parent) throw new CrewdeckError(`Unknown parent task '${parentTaskId}'`, "unknown_task");
  parent.kind ||= parent.profile === "scout" ? "scout" : "build";
  parent.lifecycle ||= config.kinds[parent.kind]?.lifecycle || "change";
  parent.workflow ||= "direct";
  if (parent.lifecycle !== "change" || parent.workflow !== "reviewed-pr") {
    throw new CrewdeckError("Reviews require a reviewed-pr change parent", "invalid_review_parent");
  }
  if (parent.status === "cleaned" || parent.cleanedAt || ["integrated", "abandoned", "pr-merged"].includes(parent.status)) {
    throw new CrewdeckError("Review parent is terminal", "invalid_review_parent");
  }
  if (["cleanup-pending", "cleanup-failed"].includes(parent.mergeReconciliation?.status)) {
    throw new CrewdeckError("Review parent is reserved for merged PR reconciliation", "reconciliation_in_progress");
  }
  const journal = await readCandidateJournal(parent);
  if (!journal.available) {
    throw new CrewdeckError(journal.error || "Parent has no submitted candidates", "missing_candidate");
  }
  const candidate = journal.journal.candidates.at(-1);
  if (!candidate || candidate.head !== reviewedHead) {
    throw new CrewdeckError("reviewedHead is not the current submitted candidate", "stale_candidate");
  }
  if ((parent.candidateCollectedVersion || 0) < candidate.version) {
    throw new CrewdeckError("Collect the durable candidate inbox event before review", "candidate_not_collected");
  }
  if (candidate.version > reviewRoundMax(parent, config)) {
    throw new CrewdeckError("Review round limit reached; escalation is required", "review_round_limit");
  }
  const snapshot = await gitSnapshot(parent);
  if (!snapshot.available || !snapshot.clean) {
    throw new CrewdeckError("Build worktree must be available and clean", "dirty_worktree", snapshot);
  }
  if (snapshot.head !== reviewedHead) {
    throw new CrewdeckError("Build HEAD changed after candidate submission", "stale_candidate");
  }
  if (parent.requiredBaseSha) {
    const requiredBase = await gitAncestorProof(parent.repo, parent.requiredBaseSha, reviewedHead);
    if (!requiredBase.available || !requiredBase.ancestor) {
      throw new CrewdeckError("Candidate does not contain the required advanced base", "base_refresh_required", requiredBase);
    }
  }
  if (snapshot.ahead < 1) throw new CrewdeckError("Candidate has no commits ahead of base", "no_commits");
  const agent = await liveAgent(parent);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Build writer is ${agent.state}; wait until it settles`, "worker_not_settled");
  }
  if (!agent.available && !/agent[^\n]*(not[_ -]?found|missing)|not[_ -]?found[^\n]*agent/i.test(agent.error || "")) {
    throw new CrewdeckError("Cannot prove build writer state before review", "agent_state_unknown", agent);
  }
  const reviews = Object.values(state.tasks).filter((record) => record.parentTaskId === parentTaskId);
  if (reviews.some((record) => record.reviewedHead === reviewedHead && record.status !== "retired")) {
    throw new CrewdeckError("This candidate already has its single reviewer", "review_already_exists");
  }
  if (reviews.some((record) => !record.cleanedAt && !["cleaned", "orphan-reconciled", "retired"].includes(record.status))) {
    throw new CrewdeckError("Another reviewer for this build is still open", "reviewer_already_active");
  }

  const reservedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const nextParent = next.tasks[parentTaskId];
    if (!nextParent) throw new CrewdeckError("Review parent disappeared", "state_changed");
    const nextReviews = Object.values(next.tasks).filter((record) => record.parentTaskId === parentTaskId);
    if (nextReviews.some((record) => record.reviewedHead === reviewedHead && record.status !== "retired")) {
      throw new CrewdeckError("This candidate already has its single reviewer", "review_already_exists");
    }
    if (nextReviews.some((record) => !record.cleanedAt && !["cleaned", "orphan-reconciled", "retired"].includes(record.status))) {
      throw new CrewdeckError("Another reviewer for this build is still open", "reviewer_already_active");
    }
    const reservation = nextParent.reviewReservation;
    if (reservation) {
      const reservedTask = next.tasks[reservation.reviewTaskId];
      const reservationActive = reservedTask
        ? !reservedTask.cleanedAt && !["cleaned", "orphan-reconciled", "retired"].includes(reservedTask.status)
        : Date.now() - Date.parse(reservation.reservedAt) < 120_000;
      if (reservationActive) {
        throw new CrewdeckError("Another reviewer reservation is active", "reviewer_already_active");
      }
    }
    nextParent.reviewReservation = { reviewTaskId: id, reviewedHead, reservedAt };
    await saveState(next);
  });

  const project = resolveProject(config, parent.project);
  let reviewEvidence;
  try {
    reviewEvidence = await createReviewEvidence(parent, id, candidate, reviewDepth);
    await validateProject(project);
    const sourceWorkspace = await ensureProjectWorkspace(project);
    return await createOne(
      config,
      project,
      sourceWorkspace,
      {
        id,
        kind: kindName,
        task,
        profile,
        workflow: "direct",
        parentTaskId,
        reviewedHead,
        candidateVersion: candidate.version,
        reviewDepth,
        reviewEvidence,
      },
      profile,
    );
  } catch (error) {
    if (reviewEvidence?.path) await rm(reviewEvidence.path, { force: true });
    if (reviewEvidence?.fullPatch?.path) await rm(reviewEvidence.fullPatch.path, { force: true });
    if (reviewEvidence?.correctionPatch?.path) await rm(reviewEvidence.correctionPatch.path, { force: true });
    await withStateLock(async () => {
      const next = await loadState();
      const nextParent = next.tasks[parentTaskId];
      if (nextParent?.reviewReservation?.reviewTaskId === id && !next.tasks[id]) {
        delete nextParent.reviewReservation;
        await saveState(next);
      }
    });
    throw error;
  }
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
    const baseHead = record.baseSha || (await git(record.repo, ["rev-parse", record.base])).stdout;
    const aheadRaw = (await git(record.worktree, ["rev-list", "--count", `${baseHead}..${head}`])).stdout;
    return { available: true, clean: status === "", status, head, baseHead, ahead: Number(aheadRaw) };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

const statusService = createStatusService({
  boundedStatusText,
  CrewdeckError,
  gitAncestorProof,
  gitSnapshot,
  liveAgent,
  loadConfig,
  loadState,
  publicCandidateJournal,
  publicTaskRecord,
  publicTaskReport,
  readCandidateJournal,
  readTaskReport,
  reviewRoundMax,
  safeDiagnosticText,
  taskIdPattern: TASK_ID_RE,
  normalizeStatusRecord,
});

export const getStatus = statusService.getStatus;
export const getStatusSummary = statusService.getStatusSummary;
export const getStatusView = statusService.getStatusView;
export const getTaskActionStatus = statusService.getTaskActionStatus;
export const getTaskStatus = statusService.getTaskStatus;
export const statusCursorScope = statusService.statusCursorScope;

function normalizeStatusRecord(config, storedRecord) {
  const record = {
    ...storedRecord,
    kind: storedRecord.kind || (storedRecord.profile === "scout" ? "scout" : "build"),
  };
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  record.contract ||= config.kinds[record.kind]?.contract || "standard";
  record.workflow ||= "direct";
  record.cleanup ||= config.kinds[record.kind]?.cleanup ||
    (record.lifecycle === "report" ? "after-collection" : "after-integration");
  return record;
}

function boundedStatusText(value, maxLength = 256) {
  if (typeof value !== "string") return undefined;
  if (value.length <= maxLength) return value;
  return `${value.slice(0, maxLength - 3)}...`;
}

function safeDiagnosticText(value, maxLength = 512) {
  if (typeof value !== "string") return undefined;
  const redacted = value
    .replace(/\b[0-9a-f]{40,}\b/gi, "[redacted-digest]")
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, "[redacted-token]");
  return boundedStatusText(redacted, maxLength);
}

export async function getPendingBaseAdvanceKeys(configPath) {
  await loadConfig(configPath);
  const state = await loadState();
  const pending = [];
  for (const record of Object.values(state.tasks)) {
    for (const item of record.baseAdvances || []) {
      if (["pending", "awaiting-writer", "forwarding"].includes(item.status)) {
        pending.push({ taskId: record.id, sequence: item.sequence, classification: boundedStatusText(item.classification, 80), status: boundedStatusText(item.status, 80) });
      }
    }
  }
  return pending.sort((left, right) => left.taskId.localeCompare(right.taskId) || left.sequence - right.sequence);
}

export async function getPendingResultIds(configPath) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const pending = [];
  for (const storedRecord of Object.values(state.tasks)) {
    const record = { ...storedRecord };
    record.kind ||= record.profile === "scout" ? "scout" : "build";
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle ||
      (record.kind === "scout" ? "report" : "change");
    record.workflow ||= "direct";
    if (record.workflow === "reviewed-pr") {
      const candidates = await readCandidateJournal(record);
      if (candidates.available) {
        for (const candidate of candidates.journal.candidates) {
          if (candidate.version > (record.candidateCollectedVersion || 0)) {
            pending.push(`${record.id}@candidate-${candidate.version}`);
          }
        }
      }
    }
    if (!record.resultCollectedAt && record.status !== "cleaned") {
      const result = await readTaskReport(record);
      if (result.available) pending.push(record.id);
    }
  }
  return pending.sort((left, right) => {
    const [leftId, leftVersion] = left.split("@candidate-");
    const [rightId, rightVersion] = right.split("@candidate-");
    if (leftId !== rightId) return leftId < rightId ? -1 : 1;
    if (leftVersion === undefined) return -1;
    if (rightVersion === undefined) return 1;
    return Number(leftVersion) - Number(rightVersion);
  });
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
  const baseRef = record.baseSha || record.base;
  const range = `${baseRef}...HEAD`;
  const [commits, stat, patchResult] = await Promise.all([
    git(record.worktree, ["log", "--oneline", "--decorate=no", `${baseRef}..HEAD`]),
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
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    throw new CrewdeckError("Task is reserved for merged PR reconciliation", "reconciliation_in_progress");
  }
  const args = ["agent", "prompt", record.agentName, message.trim()];
  if (wait) args.push("--wait", "--timeout", "600000");
  return runJson("herdr", args, { timeout: wait ? 610_000 : 15_000 });
}

function collectionTaskProjection(record, observedStatus = record.status) {
  return {
    id: boundedStatusText(record.id, 24),
    project: boundedStatusText(record.project, 128),
    kind: boundedStatusText(record.kind, 32),
    lifecycle: boundedStatusText(record.lifecycle, 16),
    workflow: boundedStatusText(record.workflow, 32),
    status: boundedStatusText(record.status, 64),
    observedStatus: boundedStatusText(observedStatus, 80),
    cleanup: boundedStatusText(record.cleanup, 32),
  };
}

export async function readResultDetail(configPath, key) {
  const config = await loadConfig(configPath);
  const match = String(key || "").match(/^([a-z][a-z0-9-]{0,23})(?:@candidate-([1-9][0-9]*))?$/);
  if (!match) throw new CrewdeckError("A result id or exact candidate inbox key is required", "invalid_inbox_key");
  const [, id, versionText] = match;
  const version = versionText ? Number(versionText) : undefined;
  if (version !== undefined && !Number.isSafeInteger(version)) throw new CrewdeckError("Candidate version must be a safe integer", "invalid_inbox_key");
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  const normalized = normalizeStatusRecord(config, record);
  if (version !== undefined) {
    const journal = await readCandidateJournal(normalized);
    if (!journal.available) throw new CrewdeckError(journal.error || "Candidate journal is missing", "missing_candidate");
    const candidate = journal.journal.candidates.find((item) => item.version === version);
    if (!candidate) throw new CrewdeckError(`Candidate v${version} does not exist`, "missing_candidate");
    return { inboxKey: key, task: collectionTaskProjection(normalized), candidate: { ...candidate } };
  }
  const result = await readTaskReport(normalized);
  if (!result.available) throw new CrewdeckError(result.error || "Task result is missing", "missing_result");
  const { token: _token, ...report } = result.report;
  return { inboxKey: id, task: collectionTaskProjection(normalized), result: { available: true, ref: `result:${id}`, report } };
}

export async function collectResults(configPath, ids, { cleanupReports } = {}) {
  if (ids !== undefined && !Array.isArray(ids)) throw new CrewdeckError("ids must be an array", "invalid_inbox_keys");
  if (ids?.length > COLLECTION_LIMIT) throw new CrewdeckError(`At most ${COLLECTION_LIMIT} inbox keys may be collected`, "too_many_inbox_keys");
  if (ids && new Set(ids).size !== ids.length) throw new CrewdeckError("Duplicate inbox keys are not allowed", "duplicate_inbox_key");
  const pending = ids?.length ? null : await getPendingResultIds(configPath);
  const selectedKeys = ids?.length ? ids : pending.slice(0, COLLECTION_LIMIT);
  const config = await loadConfig(configPath);
  const state = await loadState();
  const collected = [];
  const candidateAcks = new Map();
  const resultAcks = new Map();
  const reviewInboxAdds = [];
  const seenCandidates = new Set();
  const seenResults = new Set();

  for (const key of selectedKeys) {
    const match = String(key).match(/^([a-z][a-z0-9-]{0,23})(?:@candidate-([1-9][0-9]*))?$/);
    if (!match) throw new CrewdeckError(`Invalid inbox key '${key}'`, "invalid_inbox_key");
    const [, id, requestedVersionText] = match;
    const requestedVersion = requestedVersionText ? Number(requestedVersionText) : undefined;
    if (requestedVersion !== undefined && !Number.isSafeInteger(requestedVersion)) {
      throw new CrewdeckError("Candidate version must be a safe integer", "invalid_inbox_key");
    }
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    record.kind ||= record.profile === "scout" ? "scout" : "build";
    record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
    record.contract ||= config.kinds[record.kind]?.contract || "standard";
    record.workflow ||= "direct";
    record.cleanup ||= config.kinds[record.kind]?.cleanup ||
      (record.lifecycle === "report" ? "after-collection" : "after-integration");

    if (record.workflow === "reviewed-pr") {
      const journal = await readCandidateJournal(record);
      if (requestedVersion === undefined && journal.available && journal.journal.candidates.length > (record.candidateCollectedVersion || 0)) {
        throw new CrewdeckError(`Build '${id}' has pending candidate events; use an exact key such as ${id}@candidate-${(record.candidateCollectedVersion || 0) + 1}`, "exact_candidate_key_required");
      }
      if (requestedVersion !== undefined) {
        if (!journal.available) throw new CrewdeckError(journal.error || "Candidate journal is missing", "missing_candidate");
        const candidate = journal.journal.candidates.find((item) => item.version === requestedVersion);
        if (!candidate) throw new CrewdeckError(`Candidate v${requestedVersion} does not exist`, "missing_candidate");
        const expectedVersion = Math.max(record.candidateCollectedVersion || 0, candidateAcks.get(id) || 0) + 1;
        if (candidate.version < expectedVersion) throw new CrewdeckError(`Inbox event '${key}' was already collected`, "inbox_event_collected");
        if (candidate.version > expectedVersion) throw new CrewdeckError(`Collect ${id}@candidate-${expectedVersion} first; candidate acknowledgements are sequential`, "candidate_sequence_required");
        const candidateKey = `${id}@candidate-${candidate.version}`;
        if (!seenCandidates.has(candidateKey)) {
          seenCandidates.add(candidateKey);
          collected.push({ inboxKey: candidateKey, task: collectionTaskProjection(record, "candidate-submitted"), candidate: { ...candidate } });
          candidateAcks.set(id, Math.max(candidateAcks.get(id) || 0, candidate.version));
        }
      }
    } else if (requestedVersion !== undefined) {
      throw new CrewdeckError("Only reviewed-pr builds have candidate inbox events", "invalid_inbox_key");
    }

    if (requestedVersion !== undefined || seenResults.has(id)) continue;
    seenResults.add(id);
    const result = await readTaskReport(record);
    if (!result.available) {
      if (ids?.length) throw new CrewdeckError(result.error || `Inbox event '${id}' is not available`, "missing_result");
      continue;
    }
    if (record.resultCollectedAt && ids?.length) throw new CrewdeckError(`Inbox event '${id}' was already collected`, "inbox_event_collected");
    const collectedAt = record.resultCollectedAt || new Date().toISOString();
    record.resultCollectedAt = collectedAt;
    resultAcks.set(id, collectedAt);
    const item = { inboxKey: id, task: collectionTaskProjection(record, record.lifecycle === "report" ? "report-ready" : "candidate"), result: publicTaskReport(result) };
    collected.push(item);

    if (record.contract === "review") {
      const evidence = await verifyReviewEvidence(record);
      if (record.reviewEvidence && !evidence.available) {
        throw new CrewdeckError(evidence.error, "review_evidence_invalid");
      }
      const parent = state.tasks[record.parentTaskId];
      if (!parent) throw new CrewdeckError("Review parent is missing from durable state", "invalid_review_parent");
      const parentSnapshot = await gitSnapshot(parent);
      const parentJournal = await readCandidateJournal(parent);
      const currentCandidate = parentJournal.available ? parentJournal.journal.candidates.at(-1) : undefined;
      const validAtCollection =
        parentSnapshot.available &&
        parentSnapshot.head === record.reviewedHead &&
        currentCandidate?.head === record.reviewedHead;
      reviewInboxAdds.push({
        parentTaskId: record.parentTaskId,
        entry: {
          reviewTaskId: record.id,
          candidateVersion: record.candidateVersion,
          reviewedHead: record.reviewedHead,
          verdict: result.report.payload.verdict,
          summary: result.report.payload.summary,
          findings: result.report.payload.findings,
          checks: result.report.payload.checks,
          openQuestions: result.report.payload.openQuestions,
          completedAt: result.report.completedAt,
          collectedAt,
          validAtCollection,
          ...(validAtCollection ? {} : { staleAt: collectedAt }),
        },
      });
    }
  }

  if (candidateAcks.size > 0 || resultAcks.size > 0 || reviewInboxAdds.length > 0) {
    await withStateLock(async () => {
      const next = await loadState();
      for (const [id, version] of candidateAcks) {
        if (!next.tasks[id]) throw new CrewdeckError(`Task '${id}' disappeared`, "state_changed");
        next.tasks[id].candidateCollectedVersion = Math.max(next.tasks[id].candidateCollectedVersion || 0, version);
        next.tasks[id].candidateCollectedAt = new Date().toISOString();
      }
      for (const [id, collectedAt] of resultAcks) {
        if (!next.tasks[id]) throw new CrewdeckError(`Task '${id}' disappeared`, "state_changed");
        next.tasks[id].resultCollectedAt ||= collectedAt;
      }
      for (const { parentTaskId, entry } of reviewInboxAdds) {
        const parent = next.tasks[parentTaskId];
        if (!parent) throw new CrewdeckError("Review parent disappeared", "state_changed");
        parent.reviewInbox ||= [];
        if (!parent.reviewInbox.some((item) => item.reviewTaskId === entry.reviewTaskId)) {
          parent.reviewInbox.push(entry);
        }
      }
      await saveState(next);
    });
  }

  const shouldCleanupReports = cleanupReports ?? true;
  if (shouldCleanupReports) {
    for (const item of collected) {
      if (
        !item.result ||
        item.task.lifecycle !== "report" ||
        item.task.cleanup !== "after-collection" ||
        item.task.status === "cleaned"
      ) continue;
      try {
        const cleaned = await cleanupTask(configPath, item.task.id);
        item.cleanup = { ok: true, status: boundedStatusText(cleaned.status, 64), cleanedAt: boundedStatusText(cleaned.cleanedAt, 64) };
      } catch (error) {
        item.cleanup = { ok: false, error: error.message, code: error.code };
      }
    }
  }
  if (ids?.length) return collected;
  return {
    items: collected,
    pagination: {
      limit: COLLECTION_LIMIT,
      returned: collected.length,
      pendingBefore: pending.length,
      remaining: Math.max(0, pending.length - selectedKeys.length),
      hasMore: pending.length > selectedKeys.length,
    },
  };
}

export async function forwardReviewFindings(configPath, reviewId, { wait = false } = {}) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const review = state.tasks[reviewId];
  if (!review) throw new CrewdeckError(`Unknown review task '${reviewId}'`, "unknown_task");
  review.contract ||= config.kinds[review.kind]?.contract || "standard";
  if (review.contract !== "review") throw new CrewdeckError("Task is not a review", "review_task_required");
  if (!review.resultCollectedAt) {
    throw new CrewdeckError("Collect the review into the durable parent inbox first", "review_not_collected");
  }
  const parent = state.tasks[review.parentTaskId];
  if (!parent) throw new CrewdeckError("Review parent is missing", "invalid_review_parent");
  const inbox = (parent.reviewInbox || []).find((item) => item.reviewTaskId === reviewId);
  if (!inbox) throw new CrewdeckError("Durable parent review inbox entry is missing", "review_inbox_missing");
  if (inbox.forwardedAt) {
    return { forwarded: true, idempotent: true, reviewTaskId: reviewId, parentTaskId: parent.id, forwardedAt: inbox.forwardedAt };
  }
  const [snapshot, journal] = await Promise.all([gitSnapshot(parent), readCandidateJournal(parent)]);
  const currentCandidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
  if (!snapshot.available || snapshot.head !== inbox.reviewedHead || currentCandidate?.head !== inbox.reviewedHead) {
    throw new CrewdeckError("Review is stale because the build HEAD changed", "stale_review");
  }
  if (!inbox.validAtCollection) throw new CrewdeckError("Review was stale when collected", "stale_review");
  if (inbox.verdict === "approved") {
    throw new CrewdeckError("Approved reviews have no correction round to forward", "review_already_approved");
  }
  if (
    inbox.verdict === "blocked" ||
    inbox.verdict === "inconclusive" ||
    inbox.candidateVersion >= reviewRoundMax(parent, config)
  ) {
    const escalatedAt = new Date().toISOString();
    await withStateLock(async () => {
      const next = await loadState();
      const nextParent = next.tasks[parent.id];
      const nextInbox = (nextParent?.reviewInbox || []).find((item) => item.reviewTaskId === reviewId);
      if (!nextInbox) throw new CrewdeckError("Review inbox changed", "state_changed");
      nextInbox.escalatedAt ||= escalatedAt;
      nextParent.reviewEscalation = {
        reviewTaskId: reviewId,
        reviewedHead: inbox.reviewedHead,
        verdict: inbox.verdict,
        reason:
          inbox.candidateVersion >= reviewRoundMax(nextParent, config)
            ? `review round limit ${reviewRoundMax(nextParent, config)} reached`
            : `review verdict ${inbox.verdict} requires orchestration decision`,
        escalatedAt: nextInbox.escalatedAt,
      };
      await saveState(next);
    });
    return {
      forwarded: false,
      escalationRequired: true,
      reviewTaskId: reviewId,
      parentTaskId: parent.id,
      verdict: inbox.verdict,
      findings: inbox.findings,
    };
  }
  if (inbox.verdict !== "changes-requested") {
    throw new CrewdeckError(`Unsupported review verdict '${inbox.verdict}'`, "invalid_review_verdict");
  }

  const attemptAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const nextInbox = (next.tasks[parent.id]?.reviewInbox || []).find((item) => item.reviewTaskId === reviewId);
    if (!nextInbox) throw new CrewdeckError("Review inbox changed", "state_changed");
    if (nextInbox.forwardedAt) return;
    nextInbox.forwardStatus = "pending";
    nextInbox.forwardAttemptedAt = attemptAt;
    nextInbox.forwardAttempts = (nextInbox.forwardAttempts || 0) + 1;
    await saveState(next);
  });

  const message = [
    `CREWDECK REVIEW ${reviewId}: changes requested for candidate v${inbox.candidateVersion} at ${inbox.reviewedHead}.`,
    "Address the durable structured findings below, run tests, commit on your existing crew branch, then call crew_submit_candidate for the new exact HEAD.",
    JSON.stringify({
      reviewTaskId: reviewId,
      reviewedHead: inbox.reviewedHead,
      summary: inbox.summary,
      findings: inbox.findings,
      openQuestions: inbox.openQuestions,
    }),
  ].join("\n");
  const response = await promptTask(configPath, parent.id, message, { wait });
  const forwardedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const nextInbox = (next.tasks[parent.id]?.reviewInbox || []).find((item) => item.reviewTaskId === reviewId);
    if (!nextInbox) throw new CrewdeckError("Review inbox changed after steering", "state_changed");
    nextInbox.forwardStatus = "delivered";
    nextInbox.forwardedAt ||= forwardedAt;
    await saveState(next);
  });
  return { forwarded: true, idempotent: false, reviewTaskId: reviewId, parentTaskId: parent.id, forwardedAt, response };
}

export async function extendReviewRounds(configPath, id, { currentMax, newMax, reason } = {}) {
  const config = await loadConfig(configPath);
  if (!Number.isInteger(currentMax) || !Number.isInteger(newMax) || newMax <= currentMax || newMax > 50) {
    throw new CrewdeckError("Review-round extension requires integer currentMax < newMax <= 50", "invalid_round_extension");
  }
  if (typeof reason !== "string" || !reason.trim()) throw new CrewdeckError("Review-round extension requires a durable reason", "invalid_reason");
  let updated;
  await withStateLock(async () => {
    const state = await loadState();
    const record = state.tasks[id];
    if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
    if (record.workflow !== "reviewed-pr" || record.lifecycle !== "change" || record.cleanedAt || ["integrated", "abandoned", "pr-merged"].includes(record.status)) {
      throw new CrewdeckError("Only an active reviewed-pr build can extend review rounds", "invalid_round_extension");
    }
    const actual = reviewRoundMax(record, config);
    if (actual !== currentMax) throw new CrewdeckError("Review-round authority changed concurrently", "round_extension_conflict", { expected: currentMax, actual });
    const journal = await readCandidateJournal(record);
    const used = journal.available ? journal.journal.candidates.length : 0;
    if (newMax <= used) throw new CrewdeckError("New review-round maximum must exceed used rounds", "invalid_round_extension", { used });
    const decidedAt = new Date().toISOString();
    record.reviewRoundDecisions ||= [];
    record.reviewRoundDecisions.push({ from: actual, to: newMax, reason: reason.trim(), decidedAt });
    record.effectiveMaxReviewRounds = newMax;
    if (record.reviewEscalation?.reason?.startsWith("review round limit")) record.reviewEscalation.resolvedAt = decidedAt;
    // Persist the authority decision first. If refreshing the worker-facing file
    // fails, state is conservatively ahead (the worker cannot use extra rounds),
    // never the unsafe inverse.
    await saveState(state);
    updated = { ...record };
    await writeFile(path.join(reportsRoot(), `${record.id}.rounds.json`), `${JSON.stringify({
      schemaVersion: 1, taskId: record.id, token: record.reportToken, maxReviewRounds: newMax, updatedAt: decidedAt,
    }, null, 2)}\n`, { mode: 0o600 });
  });
  return { extended: true, task: publicTaskRecord(updated), currentMax: newMax };
}

export async function resumeBuild(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
  record.workflow ||= "direct";
  if (record.lifecycle !== "change" || record.workflow !== "reviewed-pr") {
    throw new CrewdeckError("Only reviewed-pr builds can be safely resumed", "invalid_resume_task");
  }
  if (record.status === "cleaned" || record.cleanedAt || ["integrated", "abandoned", "pr-merged"].includes(record.status)) {
    throw new CrewdeckError("Terminal builds cannot be resumed", "invalid_resume_task");
  }
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    throw new CrewdeckError("Build is reserved for merged PR reconciliation", "reconciliation_in_progress");
  }
  const agent = await liveAgent(record);
  if (agent.available) throw new CrewdeckError(`Agent still exists with state ${agent.state}`, "writer_already_present");
  if (!/agent[^\n]*(not[_ -]?found|missing)|not[_ -]?found[^\n]*agent/i.test(agent.error || "")) {
    throw new CrewdeckError("Cannot prove the previous build writer is absent", "agent_state_unknown", agent);
  }
  await runJson("herdr", ["workspace", "get", record.workspaceId], { timeout: 10_000 });
  const project = resolveProject(config, record.project);
  if (
    record.branch !== `crew/${id}` ||
    path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
    path.resolve(record.repo) !== project.path
  ) {
    throw new CrewdeckError("Build does not reference its expected isolated resources", "unsafe_task_resources");
  }
  const branch = (await git(record.worktree, ["branch", "--show-current"])).stdout;
  if (branch !== record.branch) throw new CrewdeckError("Build worktree is not on its owned branch", "wrong_branch");
  const kind = config.kinds[record.kind];
  const profile = config.profiles[record.profile];
  if (!kind || !profile || !profile.allowedKinds.includes(record.kind)) {
    throw new CrewdeckError("Stored build kind/profile is no longer configured", "invalid_resume_task");
  }
  const piArgs = [
    "--model", `${profile.provider}/${profile.model}`,
    "--thinking", profile.thinking,
    "--name", `crew:${record.id}`,
    "--no-extensions", "-e", REPORTER_EXTENSION,
    "--no-skills",
    "--tools", [...kind.tools, "crew_submit_candidate"].join(","),
  ];
  for (const skill of kind.resolvedSkills) piArgs.push("--skill", skill);
  if (project.trustProjectResources === true) piArgs.push("--approve");
  const reservationToken = randomBytes(12).toString("hex");
  const reservedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (!stored || stored.cleanedAt || ["integrated", "abandoned", "pr-merged"].includes(stored.status)) {
      throw new CrewdeckError("Build state changed during adoption", "state_changed");
    }
    if (["cleanup-pending", "cleanup-failed"].includes(stored.mergeReconciliation?.status)) {
      throw new CrewdeckError("Build is reserved for merged PR reconciliation", "reconciliation_in_progress");
    }
    if (
      stored.resumeReservation &&
      Date.now() - Date.parse(stored.resumeReservation.reservedAt) < 120_000
    ) {
      throw new CrewdeckError("Another build adoption is already starting", "resume_in_progress");
    }
    stored.resumeReservation = { token: reservationToken, reservedAt };
    await saveState(next);
  });

  try {
    await bindWorkerEnvironment(record.paneId, record);
    await startAgentWhenShellReady(record.agentName, record.paneId, piArgs);
    const latestInbox = (record.reviewInbox || []).at(-1);
    const resumePrompt = [
      workerPrompt(
        {
          id: record.id,
          kind: record.kind,
          task: record.description,
          workflow: "reviewed-pr",
          maxReviewRounds: reviewRoundMax(record, config),
        },
        project,
        kind,
      ),
      "# Recovery\nYou are the sole replacement writer adopted after Crewdeck proved the previous agent absent. Inspect the existing worktree before changing anything.",
      latestInbox ? `Latest durable review inbox entry:\n${JSON.stringify(latestInbox)}` : "No review has been collected yet.",
    ].join("\n\n");
    await run("herdr", ["agent", "prompt", record.agentName, resumePrompt], { timeout: 15_000 });
    const resumedAt = new Date().toISOString();
    let resumedRecord;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (
        !stored ||
        stored.cleanedAt ||
        ["integrated", "abandoned", "pr-merged"].includes(stored.status) ||
        ["cleanup-pending", "cleanup-failed"].includes(stored.mergeReconciliation?.status) ||
        stored.resumeReservation?.token !== reservationToken
      ) {
        throw new CrewdeckError("Build state changed during adoption", "state_changed");
      }
      stored.status = "running";
      stored.resumedAt = resumedAt;
      stored.resumeCount = (stored.resumeCount || 0) + 1;
      delete stored.resumeReservation;
      delete stored.error;
      resumedRecord = { ...stored };
      await saveState(next);
    });
    return publicTaskRecord(resumedRecord);
  } catch (error) {
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (stored?.resumeReservation?.token === reservationToken) {
        delete stored.resumeReservation;
        stored.resumeLastFailedAt = new Date().toISOString();
        stored.resumeLastError = error.message;
        await saveState(next);
      }
    });
    throw error;
  }
}

export async function prepareIntegration(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || (record.kind === "scout" ? "report" : "change");
  record.workflow ||= "direct";
  if (record.workflow === "reviewed-pr") {
    throw new CrewdeckError("reviewed-pr builds publish a draft PR and are not prepared for local merge", "reviewed_pr_no_local_merge");
  }
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
  if (record.status === "pr-merged") {
    throw new CrewdeckError("Externally merged PR tasks cannot be abandoned", "already_pr_merged");
  }
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    throw new CrewdeckError("Task is reserved for merged PR reconciliation", "reconciliation_in_progress");
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
  const expectedGitIdentity = record.detached === true
    ? record.branch === null && /^[0-9a-f]{40}$/.test(record.checkoutHead || "")
    : record.branch === `crew/${id}`;
  if (
    !expectedGitIdentity ||
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
  const branchExists = record.detached !== true && (await git(record.repo, [
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
  const branchRef = record.detached === true ? undefined : `refs/heads/${record.branch}`;
  const unexpectedCheckout = branchRef && worktrees.find(
    (item) => item.branch === branchRef && path.resolve(item.worktree) !== path.resolve(record.worktree),
  );
  if (unexpectedCheckout) {
    throw new CrewdeckError("The residual branch is checked out in another worktree", "orphan_resources_present", unexpectedCheckout);
  }
  const staleRegistration = worktrees.find((item) => path.resolve(item.worktree) === path.resolve(record.worktree));
  if (staleRegistration) {
    const metadataMatches = record.detached === true
      ? staleRegistration.detached === true && staleRegistration.HEAD === record.checkoutHead
      : staleRegistration.branch === branchRef;
    if (!metadataMatches) {
      throw new CrewdeckError("Stale worktree metadata references an unexpected Git identity", "unsafe_git_metadata", staleRegistration);
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

const publicationService = createPublicationService({
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
  taskIdPattern: TASK_ID_RE,
  validBranchName,
  validRemoteName,
  validRepositoryName,
  withStateLock,
});

const findVerdictComment = publicationService.findVerdictComment;
const inspectGitHubChecks = publicationService.inspectGitHubChecks;
const matchingVerdictIntent = publicationService.matchingVerdictIntent;
export const publishPullRequest = publicationService.publishPullRequest;
export const reconcileVerdictComment = publicationService.reconcileVerdictComment;
const renderVerdictComment = publicationService.renderVerdictComment;
const requirePassingChecks = publicationService.requirePassingChecks;
const validatedVerdictPayload = publicationService.validatedVerdictPayload;

function provenMissingAgent(agent) {
  return (
    !agent.available &&
    /agent[^\n]*(not[_ -]?found|missing)|not[_ -]?found[^\n]*agent/i.test(agent.error || "")
  );
}

function exactPullRequestUrl(value, repo, number) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.pathname.toLowerCase() === `/${repo}/pull/${number}`.toLowerCase() &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

function exactHeadRepository(value, owner, repo) {
  const [expectedOwner, expectedName, extra] = repo.split("/");
  if (!expectedOwner || !expectedName || extra || !value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if (Object.hasOwn(value, "nameWithOwner")) {
    return (
      typeof value.nameWithOwner === "string" &&
      value.nameWithOwner.toLowerCase() === repo.toLowerCase()
    );
  }
  return (
    typeof value.name === "string" &&
    value.name.toLowerCase() === expectedName.toLowerCase() &&
    typeof owner?.login === "string" &&
    owner.login.toLowerCase() === expectedOwner.toLowerCase()
  );
}

function exactIssueCommentUrl(value, repo, number, commentId) {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      url.pathname.toLowerCase() === `/${repo}/pull/${number}`.toLowerCase() &&
      !url.search &&
      url.hash === `#issuecomment-${commentId}`
    );
  } catch {
    return false;
  }
}

async function remoteBranchSha(repoPath, remote, branch) {
  const ref = `refs/heads/${branch}`;
  const output = (await git(repoPath, ["ls-remote", "--heads", remote, ref], { timeout: 30_000 })).stdout;
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new CrewdeckError(`Remote base ${branch} is missing or ambiguous`, "remote_base_unavailable", {
      remote,
      branch,
      output,
    });
  }
  const [sha, foundRef] = lines[0].split(/\s+/);
  if (!/^[0-9a-f]{40}$/.test(sha || "") || foundRef !== ref) {
    throw new CrewdeckError("Remote base returned an invalid identity", "invalid_remote_ref", {
      remote,
      branch,
      output,
    });
  }
  return sha;
}

async function gitAncestorProof(repoPath, ancestor, descendant) {
  try {
    await git(repoPath, ["rev-parse", "--verify", `${descendant}^{commit}`]);
    await git(repoPath, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return { available: true, ancestor: true };
  } catch (error) {
    if (error.code === "command_failed" && Number(error.details?.exitCode) === 1) {
      return { available: true, ancestor: false };
    }
    return { available: false, ancestor: false, error: error.message };
  }
}

async function listedWorktrees(repoPath) {
  const output = (await git(repoPath, ["worktree", "list", "--porcelain"])).stdout;
  if (!output) return [];
  return output.split(/\n\n+/).filter(Boolean).map((block) =>
    Object.fromEntries(block.split("\n").map((line) => {
      const space = line.indexOf(" ");
      return space < 0 ? [line, true] : [line.slice(0, space), line.slice(space + 1)];
    })),
  );
}

const reconciliationService = createReconciliationService({
  CrewdeckError,
  exactHeadRepository,
  exactIssueCommentUrl,
  exactPullRequestUrl,
  findVerdictComment,
  git,
  gitAncestorProof,
  githubRepositoryFromUrl,
  gitSnapshot,
  inspectGitHubChecks,
  listedWorktrees,
  liveAgent,
  loadConfig,
  loadState,
  missingWorkspace,
  provenMissingAgent,
  publicTaskRecord,
  readCandidateJournal,
  readTaskReport,
  remoteBranchSha,
  renderVerdictComment,
  requirePassingChecks,
  resolveProject,
  run,
  runJson,
  saveState,
  taskIdPattern: TASK_ID_RE,
  validatedVerdictPayload,
  validBranchName,
  validRemoteName,
  validRepositoryName,
  withStateLock,
});

export const forwardBaseAdvance = reconciliationService.forwardBaseAdvance;
export const observePublishedPullRequests = reconciliationService.observePublishedPullRequests;
export const reconcileMergedPullRequest = reconciliationService.reconcileMergedPullRequest;

export async function retireTaskAgent(configPath, id, { reason, terminate = false } = {}) {
  await loadConfig(configPath);
  if (typeof reason !== "string" || !reason.trim()) throw new CrewdeckError("Agent retirement requires a durable reason", "invalid_reason");
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  if (record.cleanedAt || ["cleaned", "integrated", "abandoned", "pr-merged", "retired"].includes(record.status)) {
    throw new CrewdeckError("Terminal tasks cannot retire an agent", "invalid_retirement_state");
  }
  const recovery = record.agentRetirement?.status === "retiring";
  let snapshot = await gitSnapshot(record);
  let reportResourcesAlreadyClosed = false;
  if (recovery && record.lifecycle === "report" && !snapshot.available) {
    try {
      await stat(record.worktree);
    } catch (error) {
      if (error.code === "ENOENT" && await missingWorkspace(record)) reportResourcesAlreadyClosed = true;
      else if (error.code !== "ENOENT") throw error;
    }
  }
  if (!reportResourcesAlreadyClosed && (!snapshot.available || !snapshot.clean)) {
    throw new CrewdeckError("Agent retirement never discards dirty or unavailable work", "dirty_worktree", snapshot);
  }
  const agent = await liveAgent(record);
  const absent = provenMissingAgent(agent);
  if (!absent && !terminate) {
    throw new CrewdeckError("Agent exists or absence is uncertain; explicit termination confirmation is required", "agent_retirement_unproven", agent);
  }
  const retiredAt = record.agentRetirement?.startedAt || new Date().toISOString();
  const proof = absent ? "agent-absent" : "explicitly-terminated";
  if (!recovery) {
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (!stored || stored.cleanedAt || stored.status !== record.status || stored.agentRetirement?.status === "retiring") {
        throw new CrewdeckError("Task changed during agent retirement", "state_changed");
      }
      stored.agentRetirement = { status: "retiring", reason: reason.trim(), startedAt: retiredAt, proof,
        priorAgentState: agent.state, cleanHead: snapshot.head };
      await saveState(next);
    });
  } else if (record.agentRetirement.reason !== reason.trim()) {
    throw new CrewdeckError("Retirement recovery reason must match the durable operation", "retirement_reason_mismatch");
  }
  if (!absent) await run("herdr", ["agent", "send-keys", record.agentName, "ctrl+d"], { timeout: 10_000 });
  let resources = "agent-only-change-preserved";
  if (record.lifecycle === "report") {
    if (!reportResourcesAlreadyClosed) {
      if (record.detached !== true || snapshot.head !== record.checkoutHead) {
        throw new CrewdeckError("Reviewer/report checkout identity changed; resources are preserved", "report_has_commits");
      }
      await runJson("herdr", ["worktree", "remove", "--workspace", record.workspaceId], { timeout: 30_000 });
    }
    resources = "isolated-report-workspace-closed";
  }
  let updated;
  const completedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (!stored || stored.cleanedAt || stored.status !== record.status || stored.agentRetirement?.status !== "retiring") {
      throw new CrewdeckError("Task changed during agent retirement", "state_changed");
    }
    stored.agentRetirement = { ...stored.agentRetirement, status: "retired", completedAt, resources };
    if (stored.lifecycle === "report") {
      stored.status = "retired";
      stored.cleanedAt = completedAt;
      const parent = stored.parentTaskId && next.tasks[stored.parentTaskId];
      if (parent?.reviewReservation?.reviewTaskId === id) delete parent.reviewReservation;
    } else stored.agentRetiredAt = completedAt;
    updated = { ...stored };
    await saveState(next);
  });
  return { retired: true, task: publicTaskRecord(updated), evidence: updated.agentRetirement };
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
  if (record.status === "pr-merged") {
    throw new CrewdeckError("Merged PR reconciliation already removed isolated resources", "already_reconciled");
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
  if (
    record.lifecycle === "report" &&
    (record.detached === true ? snapshot.head !== record.checkoutHead : snapshot.ahead !== 0)
  ) {
    throw new CrewdeckError("Report worktree no longer matches its immutable checkout", "report_has_commits");
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
  if (record.detached !== true) {
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
          !["cleaned", "pr-merged", "orphan-reconciled"].includes(other.status) &&
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
    ...(options.baseRemote ? { baseRemote: options.baseRemote } : {}),
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
