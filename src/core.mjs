import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
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
const CONTRACTS = new Set(["standard", "review"]);
const WORKFLOWS = new Set(["direct", "reviewed-pr"]);
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

function taskCandidatesPath(id) {
  return path.join(reportsRoot(), `${id}.candidates.json`);
}

function reviewEvidencePath(id) {
  return path.join(reportsRoot(), `${id}.review-evidence.json`);
}

async function verifyReviewEvidence(record) {
  if (!record.reviewEvidence) return { available: false, state: "legacy-absent" };
  try {
    const evidence = JSON.parse(await readFile(record.reviewEvidence.path, "utf8"));
    const { contentSha256, ...payload } = evidence;
    const actual = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
    if (
      actual !== contentSha256 || contentSha256 !== record.reviewEvidence.contentSha256 ||
      evidence.parentTaskId !== record.parentTaskId || evidence.reviewTaskId !== record.id ||
      evidence.baseSha !== record.reviewEvidence.baseSha || evidence.candidateSha !== record.reviewedHead
    ) throw new Error("identity or digest mismatch");
    return { available: true, evidence };
  } catch (error) {
    return { available: false, error: `Reviewer evidence is stale or tampered: ${error.message}` };
  }
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
      `Authoritative shell-free evidence is precomputed at ${task.reviewEvidence?.path || "(unavailable)"}; verify its parent/base/candidate identity and SHA-256 ${task.reviewEvidence?.contentSha256 || "(legacy)"} before reviewing.`,
      "Filesystem access is strictly read-only and no shell is available. Do not message or steer the build agent.",
      "Finish by calling crew_complete exactly once with the bound parentTaskId/reviewedHead, verdict, summary, structured findings, checks, and openQuestions.",
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

const VERDICT_COMMENT_MAX_BYTES = 48 * 1024;
const REVIEW_SEVERITIES = new Set(["blocking", "major", "minor", "nit"]);

function truncateUtf8(value, maxBytes) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const suffix = "\n… [truncated by Crewdeck]";
  const available = maxBytes - Buffer.byteLength(suffix, "utf8");
  let bytes = 0;
  let truncated = "";
  for (const character of text) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > available) break;
    truncated += character;
    bytes += size;
  }
  return `${truncated}${suffix}`;
}

function safeReviewJson(value, maxBytes) {
  const json = JSON.stringify(value, null, 2).replace(/[\u202a-\u202e\u2066-\u2069]/g, (character) =>
    `\\u${character.codePointAt(0).toString(16).padStart(4, "0")}`,
  );
  const escaped = json
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "&#64;&#8203;");
  return truncateUtf8(escaped, maxBytes);
}

function validatedVerdictPayload(taskId, candidate, approval) {
  if (
    !TASK_ID_RE.test(taskId) ||
    !approval ||
    approval.verdict !== "approved" ||
    approval.reviewedHead !== candidate.head ||
    approval.candidateVersion !== candidate.version ||
    !TASK_ID_RE.test(approval.reviewTaskId || "") ||
    typeof approval.summary !== "string" ||
    !approval.summary ||
    !Array.isArray(approval.checks) ||
    approval.checks.length > 100 ||
    approval.checks.some((item) => typeof item !== "string") ||
    !Array.isArray(approval.findings) ||
    approval.findings.length > 100 ||
    approval.findings.some((finding) =>
      !finding ||
      !REVIEW_SEVERITIES.has(finding.severity) ||
      finding.severity === "blocking" ||
      ["title", "detail", "location", "recommendation"].some(
        (field) => typeof finding[field] !== "string",
      )
    ) ||
    !Array.isArray(approval.openQuestions) ||
    approval.openQuestions.length > 100 ||
    approval.openQuestions.some((item) => typeof item !== "string")
  ) {
    throw new CrewdeckError("Approved reviewer data is invalid", "invalid_review_result");
  }
  return {
    verdict: approval.verdict,
    approvedSha: candidate.head,
    reviewerTaskId: approval.reviewTaskId,
    candidateVersion: candidate.version,
    taskId,
    summary: approval.summary,
    checks: approval.checks,
    findings: approval.findings,
    openQuestions: approval.openQuestions,
  };
}

function renderVerdictComment(taskId, candidate, approval) {
  const payload = validatedVerdictPayload(taskId, candidate, approval);
  const marker = `<!-- crewdeck-verdict:${taskId}:${candidate.head} -->`;
  const body = [
    marker,
    "## Crewdeck immutable reviewed-PR verdict",
    "",
    "This append-only audit comment is bound to one exact commit. Crewdeck never edits or deletes it, even if the PR head later changes.",
    "**This comment is not an official GitHub approval.**",
    "",
    "### Verdict identity",
    "<pre>",
    safeReviewJson({
      verdict: payload.verdict,
      approvedSha: payload.approvedSha,
      reviewerTaskId: payload.reviewerTaskId,
      candidateVersion: payload.candidateVersion,
      taskId: payload.taskId,
    }, 2 * 1024),
    "</pre>",
    "",
    "### Summary",
    "<pre>",
    safeReviewJson(payload.summary, 7 * 1024),
    "</pre>",
    "",
    "### Checks",
    "<pre>",
    safeReviewJson(payload.checks, 8 * 1024),
    "</pre>",
    "",
    "### Findings",
    "<pre>",
    safeReviewJson(payload.findings, 20 * 1024),
    "</pre>",
    "",
    "### Open questions",
    "<pre>",
    safeReviewJson(payload.openQuestions, 8 * 1024),
    "</pre>",
  ].join("\n");
  if (
    Buffer.byteLength(body, "utf8") > VERDICT_COMMENT_MAX_BYTES ||
    body.split(marker).length !== 2
  ) {
    throw new CrewdeckError("Rendered verdict comment exceeds its safe bound", "verdict_comment_too_large");
  }
  return {
    marker,
    body,
    contentSha256: createHash("sha256").update(body, "utf8").digest("hex"),
  };
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

async function createReviewEvidence(parent, reviewTaskId, candidate) {
  if (!/^[0-9a-f]{40}$/.test(parent.baseSha || "")) {
    throw new CrewdeckError("Reviewer evidence requires the parent's pinned base SHA", "base_sha_unproven");
  }
  const range = `${parent.baseSha}...${candidate.head}`;
  const [commits, diffstat, patchResult] = await Promise.all([
    git(parent.worktree, ["log", "--format=%H%x09%s", `${parent.baseSha}..${candidate.head}`]),
    git(parent.worktree, ["diff", "--stat", range]),
    git(parent.worktree, ["diff", "--no-ext-diff", "--unified=3", range], { maxBuffer: 4 * 1024 * 1024 }),
  ]);
  const maxPatchBytes = 40 * 1024;
  const patchBytes = Buffer.byteLength(patchResult.stdout, "utf8");
  const payload = {
    schemaVersion: 1, parentTaskId: parent.id, reviewTaskId,
    baseSha: parent.baseSha, candidateSha: candidate.head, candidateVersion: candidate.version,
    generatedAt: new Date().toISOString(),
    commits: commits.stdout ? commits.stdout.split("\n").map((line) => {
      const [sha, ...subject] = line.split("\t");
      return { sha, subject: subject.join("\t") };
    }) : [],
    diffstat: diffstat.stdout,
    patch: patchBytes <= maxPatchBytes ? patchResult.stdout
      : `${Buffer.from(patchResult.stdout, "utf8").subarray(0, maxPatchBytes).toString("utf8")}\n\n[patch truncated: ${patchBytes - maxPatchBytes} bytes omitted]`,
    patchBytes, truncated: patchBytes > maxPatchBytes,
  };
  const contentSha256 = createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
  const target = reviewEvidencePath(reviewTaskId);
  await mkdir(reportsRoot(), { recursive: true, mode: 0o700 });
  await writeFile(target, `${JSON.stringify({ ...payload, contentSha256 }, null, 2)}\n`, { mode: 0o400, flag: "wx" });
  return { path: target, contentSha256, baseSha: parent.baseSha, candidateSha: candidate.head };
}

function reviewRoundMax(record, config) {
  return record.effectiveMaxReviewRounds || record.maxReviewRounds || config.maxReviewRounds;
}

export async function spawnReview(
  configPath,
  { id, parentTaskId, reviewedHead, task, profile },
) {
  if (process.env.HERDR_ENV !== "1") {
    throw new CrewdeckError("Crewdeck must run inside a Herdr-managed pane", "not_in_herdr");
  }
  if (!TASK_ID_RE.test(parentTaskId || "") || !/^[0-9a-f]{40}$/.test(reviewedHead || "")) {
    throw new CrewdeckError("Review requires a valid parentTaskId and full reviewedHead SHA", "invalid_review_contract");
  }
  const config = await loadConfig(configPath);
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
    reviewEvidence = await createReviewEvidence(parent, id, candidate);
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
        reviewEvidence,
      },
      profile,
    );
  } catch (error) {
    if (reviewEvidence?.path) await rm(reviewEvidence.path, { force: true });
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

function operatorStatus(record, candidates, observedStatus, config) {
  const candidate = candidates?.available ? candidates.journal.candidates.at(-1) : undefined;
  const review = candidate && latestRelevantReview(record.reviewInbox, candidate.head);
  const intent = candidate && Array.isArray(record.publication?.verdictComments)
    ? record.publication.verdictComments.find((item) => item.headSha === candidate.head) : undefined;
  const baseAdvance = (record.baseAdvances || []).at(-1);
  let nextAction = "inspect task";
  if (baseAdvance?.status === "pending") {
    nextAction = baseAdvance.classification === "unknown"
      ? "resolve unknown base compatibility; do not mutate or forward"
      : baseAdvance.classification === "compatible" && (record.publication?.number || baseAdvance.requiresRefresh === false)
        ? "settle compatible base advance without rewriting the candidate"
        : `forward base advance ${baseAdvance.sequence} to the sole writer`;
  } else if (baseAdvance?.status === "awaiting-writer") nextAction = "resume the sole writer, then forward the pending base advance";
  else if (baseAdvance?.status === "forwarding") nextAction = "retry base-advance forwarding; delivery may be at-least-once";
  else if (record.agentRetirement?.status === "retiring") nextAction = "retry confirmed agent retirement with the same reason";
  else if (record.prObservation?.status === "merged-awaiting-confirmed-reconciliation") nextAction = "confirm merged PR reconciliation";
  else if (["ambiguous", "dispatched"].includes(intent?.status)) nextAction = "confirm verdict reconciliation";
  else if (record.reviewEscalation && !record.reviewEscalation.resolvedAt) nextAction = "confirm review-round extension or decide escalation";
  else if (observedStatus === "candidate-submitted") nextAction = "collect candidate";
  else if (observedStatus === "candidate") nextAction = "spawn exact-SHA review";
  else if (observedStatus === "review-changes-requested") nextAction = "forward durable review";
  else if (observedStatus === "review-approved" && !record.publication?.number) nextAction = "publish draft PR after checks";
  else if (record.publication?.number) nextAction = "observe external PR; reconciliation remains confirmed";
  return { nextAction, reviewRound: candidate?.version || 0, currentMaxReviewRounds: reviewRoundMax(record, config),
    escalation: record.reviewEscalation,
    pr: record.publication?.number ? { number: record.publication.number, url: record.publication.url, headSha: record.publication.headSha, state: record.prObservation?.status || "unobserved" } : undefined,
    verdictState: intent?.status || (review?.verdict ? `review-${review.verdict}` : "none"),
    checkState: record.publication?.checks?.status || "not-checked",
    baseAdvanceState: baseAdvance ? {
      sequence: baseAdvance.sequence, status: baseAdvance.status, classification: baseAdvance.classification,
      priorBaseSha: baseAdvance.priorBaseSha, newBaseSha: baseAdvance.newBaseSha, sourceTaskId: baseAdvance.sourceTaskId,
    } : undefined,
    observerState: record.prObservation?.status || "not-observed" };
}

const TERMINAL_STATUSES = new Set(["cleaned", "orphan-reconciled", "retired", "pr-merged"]);
const STATUS_SCOPES = new Set(["active", "history", "all"]);
export const COLLECTION_LIMIT = 20;
export const DEFAULT_STATUS_LIMIT = 20;
export const MAX_STATUS_LIMIT = 50;
export const STATUS_OUTPUT_BUDGET_BYTES = 128 * 1024;

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

function isTerminalStatusRecord(record) {
  return TERMINAL_STATUSES.has(record.status) || (record.status === "abandoned" && Boolean(record.cleanedAt));
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

function statusInteger(value) {
  return Number.isSafeInteger(value) ? value : undefined;
}

function latestRelevantReview(reviewInbox, head) {
  if (!head || !Array.isArray(reviewInbox)) return undefined;
  for (let index = reviewInbox.length - 1; index >= 0; index -= 1) {
    if (reviewInbox[index]?.reviewedHead === head) return reviewInbox[index];
  }
  return undefined;
}

function projectResultAvailability(result, ref) {
  const projected = result.available
    ? { available: true, ref, state: "available" }
    : { available: false, ref, state: result.state === "missing" ? "missing" : "error" };
  if (!result.available && result.error) projected.error = safeDiagnosticText(result.error, 512);
  return projected;
}

function projectLatestPrObservation(observation) {
  if (!observation || typeof observation !== "object") return undefined;
  const projected = {
    status: boundedStatusText(observation.status, 80),
    observedAt: boundedStatusText(observation.observedAt, 64),
  };
  if (observation.repo !== undefined) projected.repo = boundedStatusText(observation.repo, 256);
  if (statusInteger(observation.number) !== undefined) projected.number = observation.number;
  if (observation.url !== undefined) projected.url = boundedStatusText(observation.url, 512);
  if (observation.headSha !== undefined) projected.headSha = boundedStatusText(observation.headSha, 64);
  if (observation.mergedAt !== undefined) projected.mergedAt = boundedStatusText(observation.mergedAt, 64);
  if (observation.mergeCommit !== undefined) projected.mergeCommit = boundedStatusText(observation.mergeCommit, 64);
  return projected;
}

function terminalStatusSummary(record) {
  const summary = {
    id: boundedStatusText(record.id, 24),
    project: boundedStatusText(record.project, 64),
    kind: boundedStatusText(record.kind, 32),
    status: boundedStatusText(record.status, 64),
    observedStatus: boundedStatusText(record.status, 64),
  };
  const terminalAt = record.status === "pr-merged"
    ? record.mergedReconciledAt
    : record.cleanedAt || record.orphanReconciledAt || record.agentRetiredAt || record.abandonedAt;
  if (terminalAt) summary.terminalAt = boundedStatusText(terminalAt, 64);
  if (record.status === "pr-merged" && record.prMergedAt) summary.remotePrMergedAt = boundedStatusText(record.prMergedAt, 64);
  if (record.lifecycle === "report" || record.resultCollectedAt) summary.result = { ref: `result:${record.id}` };
  if (record.workflow === "reviewed-pr") summary.candidates = { ref: `candidates:${record.id}` };
  if (record.publication?.number) summary.publication = {
    number: statusInteger(record.publication.number),
    url: boundedStatusText(record.publication.url, 256),
  };
  return summary;
}

async function computeStatusRecord(config, state, storedRecord) {
  const record = normalizeStatusRecord(config, storedRecord);
  if (
    record.status === "cleaned" ||
    record.status === "orphan-reconciled" ||
    record.status === "retired" ||
    record.status === "pr-merged" ||
    (record.status === "abandoned" && record.cleanedAt)
  ) {
    const terminal = {
      ...publicTaskRecord(record),
      observedStatus: record.status,
      agent: { available: false, state: "closed" },
      git: { available: false, state: "worktree-removed" },
    };
    if (["abandoned", "orphan-reconciled"].includes(record.status) || record.contract === "review") {
      terminal.result = publicTaskReport(await readTaskReport(record));
    }
    if (record.status === "pr-merged") {
      terminal.candidates = publicCandidateJournal(await readCandidateJournal(record));
    }
    Object.assign(terminal, operatorStatus(record, terminal.candidates, terminal.observedStatus, config));
    if (record.contract === "review") {
      const parent = state.tasks[record.parentTaskId];
      const parentSnapshot = parent ? await gitSnapshot(parent) : { available: false };
      terminal.reviewValidity = {
        reviewedHead: record.reviewedHead,
        validForCurrentHead: parentSnapshot.available && parentSnapshot.head === record.reviewedHead,
      };
    }
    return terminal;
  }
  const [agent, snapshot, result, candidates] = await Promise.all([
    liveAgent(record),
    gitSnapshot(record),
    readTaskReport(record),
    readCandidateJournal(record),
  ]);
  let observedStatus = record.status;
  if (record.status === "abandoned" && !record.cleanedAt) observedStatus = "abandon-cleanup-pending";
  if (record.status === "running" && agent.state === "blocked") observedStatus = "blocked";
  if (record.lifecycle === "report" && result.available) {
    observedStatus = record.resultCollectedAt ? "report-collected" : "report-ready";
    if (record.contract === "review") {
      const parent = state.tasks[record.parentTaskId];
      const parentSnapshot = parent ? await gitSnapshot(parent) : { available: false };
      const stillCurrent =
        parentSnapshot.available &&
        parentSnapshot.head === record.reviewedHead &&
        result.report.reviewedHead === record.reviewedHead;
      observedStatus = stillCurrent
        ? record.resultCollectedAt ? "report-collected" : "review-ready"
        : "review-stale";
    }
  }
  if (record.workflow === "reviewed-pr" && candidates.available) {
    const candidate = candidates.journal.candidates.at(-1);
    if (candidate) {
      const review = latestRelevantReview(record.reviewInbox, candidate.head);
      if (!snapshot.available || snapshot.head !== candidate.head) observedStatus = "candidate-stale";
      else if ((record.candidateCollectedVersion || 0) < candidate.version) observedStatus = "candidate-submitted";
      else if (review?.validAtCollection) observedStatus = `review-${review.verdict}`;
      else observedStatus = "candidate";
    }
  }
  const pendingBaseRefresh = (record.baseAdvances || []).some((item) =>
    ["forwarding", "forwarded"].includes(item.status) && item.requiresRefresh !== false &&
    item.newBaseSha === record.requiredBaseSha
  );
  if (pendingBaseRefresh && snapshot.available) {
    const refreshed = await gitAncestorProof(record.repo, record.requiredBaseSha, snapshot.head);
    if (!refreshed.available || !refreshed.ancestor) observedStatus = "base-refresh-required";
  }
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    observedStatus = `merge-${record.mergeReconciliation.status}`;
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
    candidates: publicCandidateJournal(candidates),
    ...operatorStatus(record, candidates, observedStatus, config),
  };
}

async function computeStatusSummaryRecord(config, state, storedRecord) {
  const record = normalizeStatusRecord(config, storedRecord);
  if (isTerminalStatusRecord(record)) return terminalStatusSummary(record);

  const needsResult = record.lifecycle === "report" || record.workflow === "direct";
  const needsCandidates = record.workflow === "reviewed-pr";
  const [agent, snapshot, result, candidates] = await Promise.all([
    liveAgent(record),
    gitSnapshot(record),
    needsResult ? readTaskReport(record) : Promise.resolve(undefined),
    needsCandidates ? readCandidateJournal(record) : Promise.resolve(undefined),
  ]);
  let observedStatus = record.status;
  if (record.status === "abandoned" && !record.cleanedAt) observedStatus = "abandon-cleanup-pending";
  if (record.status === "running" && agent.state === "blocked") observedStatus = "blocked";
  if (record.lifecycle === "report" && result?.available) {
    observedStatus = record.resultCollectedAt ? "report-collected" : "report-ready";
    if (record.contract === "review") {
      const parent = state.tasks[record.parentTaskId];
      const parentSnapshot = parent ? await gitSnapshot(parent) : { available: false };
      const stillCurrent =
        parentSnapshot.available &&
        parentSnapshot.head === record.reviewedHead &&
        result.report.reviewedHead === record.reviewedHead;
      observedStatus = stillCurrent
        ? record.resultCollectedAt ? "report-collected" : "review-ready"
        : "review-stale";
    }
  }

  const latestCandidate = candidates?.available ? candidates.journal.candidates.at(-1) : undefined;
  const latestReview = latestRelevantReview(record.reviewInbox, latestCandidate?.head);
  if (latestCandidate) {
    if (!snapshot.available || snapshot.head !== latestCandidate.head) observedStatus = "candidate-stale";
    else if ((record.candidateCollectedVersion || 0) < latestCandidate.version) observedStatus = "candidate-submitted";
    else if (latestReview?.validAtCollection) observedStatus = `review-${latestReview.verdict}`;
    else observedStatus = "candidate";
  }

  const pendingBaseRefresh = (record.baseAdvances || []).some((item) =>
    ["forwarding", "forwarded"].includes(item.status) && item.requiresRefresh !== false &&
    item.newBaseSha === record.requiredBaseSha
  );
  if (pendingBaseRefresh && snapshot.available) {
    const refreshed = await gitAncestorProof(record.repo, record.requiredBaseSha, snapshot.head);
    if (!refreshed.available || !refreshed.ancestor) observedStatus = "base-refresh-required";
  }
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    observedStatus = `merge-${record.mergeReconciliation.status}`;
  }
  const reportedCommit = result?.available ? result.report.payload?.commit : undefined;
  const commitMatches =
    typeof reportedCommit === "string" && snapshot.available && snapshot.head.startsWith(reportedCommit);
  if (
    record.lifecycle === "change" &&
    record.status === "running" &&
    ["idle", "done"].includes(agent.state) &&
    result?.available &&
    snapshot.available &&
    snapshot.clean &&
    snapshot.ahead > 0 &&
    commitMatches
  ) {
    observedStatus = "candidate";
  }

  const operator = operatorStatus(record, candidates, observedStatus, config);
  const summary = {
    id: boundedStatusText(record.id, 24),
    project: boundedStatusText(record.project, 64),
    kind: boundedStatusText(record.kind, 32),
    workflow: boundedStatusText(record.workflow, 32),
    status: boundedStatusText(record.status, 64),
    observedStatus: boundedStatusText(observedStatus, 80),
    nextAction: boundedStatusText(operator.nextAction, 256),
    reviewRound: statusInteger(operator.reviewRound),
    currentMaxReviewRounds: statusInteger(operator.currentMaxReviewRounds),
    verdictState: boundedStatusText(operator.verdictState, 80),
    checkState: boundedStatusText(operator.checkState, 80),
    observerState: boundedStatusText(operator.observerState, 80),
    agent: {
      available: Boolean(agent.available),
      state: boundedStatusText(agent.state, 80),
      ...(!agent.available && agent.error ? { error: safeDiagnosticText(agent.error, 256) } : {}),
    },
    git: snapshot.available
      ? { available: true, clean: Boolean(snapshot.clean), ahead: statusInteger(snapshot.ahead), head: boundedStatusText(snapshot.head, 64) }
      : { available: false, ...(snapshot.error ? { error: safeDiagnosticText(snapshot.error, 256) } : {}) },
  };
  if (operator.escalation) {
    summary.escalation = {
      reviewTaskId: boundedStatusText(operator.escalation.reviewTaskId, 24),
      reviewedHead: boundedStatusText(operator.escalation.reviewedHead, 64),
      verdict: boundedStatusText(operator.escalation.verdict, 80),
      escalatedAt: boundedStatusText(operator.escalation.escalatedAt, 64),
      resolvedAt: boundedStatusText(operator.escalation.resolvedAt, 64),
    };
  }
  if (operator.pr) {
    summary.pr = {
      number: statusInteger(operator.pr.number),
      url: boundedStatusText(operator.pr.url, 256),
      headSha: boundedStatusText(operator.pr.headSha, 64),
      state: boundedStatusText(operator.pr.state, 80),
    };
  }
  if (result) summary.result = projectResultAvailability(result, `result:${record.id}`);
  if (candidates) {
    summary.candidates = {
      ...projectResultAvailability(candidates, `candidates:${record.id}`),
      count: candidates.available ? candidates.journal.candidates.length : 0,
    };
    if (latestCandidate) {
      summary.candidates.latest = {
        version: latestCandidate.version,
        head: boundedStatusText(latestCandidate.head, 64),
      };
    }
    let relevantCount = 0;
    if (latestCandidate && Array.isArray(record.reviewInbox)) {
      for (const item of record.reviewInbox) {
        if (item?.reviewedHead === latestCandidate.head) relevantCount += 1;
      }
    }
    summary.reviews = {
      count: Array.isArray(record.reviewInbox) ? record.reviewInbox.length : 0,
      relevantCount,
    };
    if (latestReview) {
      summary.reviews.latest = {
        reviewTaskId: boundedStatusText(latestReview.reviewTaskId, 24),
        candidateVersion: statusInteger(latestReview.candidateVersion),
        reviewedHead: boundedStatusText(latestReview.reviewedHead, 64),
        verdict: boundedStatusText(latestReview.verdict, 80),
        forwardStatus: boundedStatusText(latestReview.forwardStatus, 80),
        validAtCollection: Boolean(latestReview.validAtCollection),
      };
    }
  }
  if (operator.baseAdvanceState) {
    summary.baseAdvanceState = {
      sequence: statusInteger(operator.baseAdvanceState.sequence),
      status: boundedStatusText(operator.baseAdvanceState.status, 80),
      classification: boundedStatusText(operator.baseAdvanceState.classification, 80),
      priorBaseSha: boundedStatusText(operator.baseAdvanceState.priorBaseSha, 64),
      newBaseSha: boundedStatusText(operator.baseAdvanceState.newBaseSha, 64),
      sourceTaskId: boundedStatusText(operator.baseAdvanceState.sourceTaskId, 24),
    };
  }
  if (record.mergeReconciliation) {
    summary.mergeReconciliation = { status: boundedStatusText(record.mergeReconciliation.status, 80) };
    if (statusInteger(record.mergeReconciliation.prNumber) !== undefined) summary.mergeReconciliation.prNumber = record.mergeReconciliation.prNumber;
    if (record.mergeReconciliation.mergeCommit !== undefined) summary.mergeReconciliation.mergeCommit = boundedStatusText(record.mergeReconciliation.mergeCommit, 64);
    if (record.mergeReconciliation.lastError) summary.mergeReconciliation.error = safeDiagnosticText(record.mergeReconciliation.lastError);
    if (record.mergeReconciliation.reason) summary.mergeReconciliation.reason = safeDiagnosticText(record.mergeReconciliation.reason);
    if (record.mergeReconciliation.code) summary.mergeReconciliation.errorCode = boundedStatusText(record.mergeReconciliation.code, 80);
  }
  if (record.error) summary.error = safeDiagnosticText(record.error);
  if (record.errorCode) summary.errorCode = boundedStatusText(record.errorCode, 80);
  if (record.abandonmentReason) summary.reason = safeDiagnosticText(record.abandonmentReason);
  const observation = projectLatestPrObservation(record.prObservation);
  if (observation) {
    if (operator.pr) {
      delete observation.url;
      delete observation.number;
      delete observation.headSha;
    }
    summary.prObservation = observation;
  }
  return summary;
}

export async function getStatus(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const records = id ? [state.tasks[id]].filter(Boolean) : Object.values(state.tasks);
  if (id && records.length === 0) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  return Promise.all(records.map((storedRecord) => computeStatusRecord(config, state, storedRecord)));
}

export async function getTaskStatus(configPath, id) {
  if (!TASK_ID_RE.test(id || "")) throw new CrewdeckError("A valid task id is required", "invalid_task_id");
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  return computeStatusSummaryRecord(config, state, record);
}

function statusGeneration(records, scope) {
  return createHash("sha256").update(`${scope}\n${records.map((record) => `${record.id}:${record.status}:${record.cleanedAt || ""}`).join("\n")}`).digest("hex").slice(0, 16);
}

function encodeStatusCursor(scope, generation, after) {
  return Buffer.from(JSON.stringify({ v: 1, scope, generation, after }), "utf8").toString("base64url");
}

function decodeStatusCursor(cursor, scope, generation, records) {
  if (cursor === undefined || cursor === null || cursor === "" || cursor === 0) return 0;
  if (Number.isSafeInteger(cursor) && cursor >= 0) return cursor;
  if (typeof cursor !== "string") throw new CrewdeckError("Status cursor must be an opaque cursor string", "invalid_status_cursor");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded.v !== 1 || decoded.scope !== scope || decoded.generation !== generation || typeof decoded.after !== "string") {
      throw new Error("cursor scope or generation changed");
    }
    const index = records.findIndex((record) => record.id === decoded.after);
    if (index < 0) throw new Error("cursor task no longer exists in this scope");
    return index + 1;
  } catch (error) {
    throw new CrewdeckError(`Status cursor is stale or invalid; restart pagination: ${error.message}`, "invalid_status_cursor");
  }
}

export function statusCursorScope(cursor) {
  if (typeof cursor !== "string" || cursor === "") {
    throw new CrewdeckError("Status cursor must be an opaque cursor string", "invalid_status_cursor");
  }
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (decoded.v !== 1 || typeof decoded.scope !== "string") throw new Error("cursor scope missing");
    return decoded.scope;
  } catch (error) {
    throw new CrewdeckError(`Status cursor is stale or invalid; restart pagination: ${error.message}`, "invalid_status_cursor");
  }
}

export async function getStatusView(configPath, { id, mode = "bounded", scope, limit, cursor } = {}) {
  if (!["bounded", "diagnostic"].includes(mode)) throw new CrewdeckError("Status mode must be bounded or diagnostic", "invalid_status_mode");
  if (id && (scope !== undefined || limit !== undefined || cursor !== undefined)) {
    throw new CrewdeckError("Status id is incompatible with summary pagination arguments", "invalid_status_arguments");
  }
  if (mode === "diagnostic" && !id) throw new CrewdeckError("Diagnostic status requires exactly one task id", "invalid_status_arguments");
  if (id) return mode === "diagnostic" ? getStatus(configPath, id) : getTaskStatus(configPath, id);
  return getStatusSummary(configPath, { scope, limit, cursor });
}

export async function getStatusSummary(
  configPath,
  { scope = "active", limit = DEFAULT_STATUS_LIMIT, cursor = 0 } = {},
) {
  if (!STATUS_SCOPES.has(scope)) {
    throw new CrewdeckError("Status scope must be active, history, or all", "invalid_status_scope");
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_STATUS_LIMIT) {
    throw new CrewdeckError(`Status limit must be a safe integer from 1 to ${MAX_STATUS_LIMIT}`, "invalid_status_limit");
  }
  const config = await loadConfig(configPath);
  const state = await loadState();
  const records = Object.values(state.tasks)
    .filter((record) => {
      const terminal = isTerminalStatusRecord(record);
      return scope === "all" || (scope === "history" ? terminal : !terminal);
    })
    .sort((left, right) => {
      const leftId = String(left.id || "");
      const rightId = String(right.id || "");
      return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
    });
  const generation = statusGeneration(records, scope);
  const offset = decodeStatusCursor(cursor, scope, generation, records);
  const selected = records.slice(offset, offset + limit);
  const tasks = await Promise.all(selected.map((record) => computeStatusSummaryRecord(config, state, record)));
  const nextCursor = offset + tasks.length < records.length
    ? encodeStatusCursor(scope, generation, selected.at(-1).id)
    : null;
  const page = {
    scope,
    pagination: { cursor: cursor || null, generation, limit, returned: tasks.length, total: records.length, nextCursor },
    tasks,
  };
  const bytes = Buffer.byteLength(JSON.stringify(page, null, 2), "utf8");
  if (bytes > STATUS_OUTPUT_BUDGET_BYTES) {
    throw new CrewdeckError(`Serialized status page exceeds the ${STATUS_OUTPUT_BUDGET_BYTES}-byte budget`, "status_output_budget", { bytes });
  }
  return page;
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

function verdictCommentIdentity(comment, repo, prNumber, expectedBody) {
  if (
    !comment ||
    comment.body !== expectedBody ||
    !Number.isInteger(comment.id) ||
    comment.id < 1 ||
    typeof comment.html_url !== "string"
  ) {
    throw new CrewdeckError("GitHub returned an invalid verdict comment identity", "invalid_comment_identity");
  }
  let commentUrl;
  try {
    commentUrl = new URL(comment.html_url);
  } catch {
    throw new CrewdeckError("GitHub returned an invalid verdict comment URL", "invalid_comment_identity");
  }
  if (
    commentUrl.protocol !== "https:" ||
    commentUrl.hostname.toLowerCase() !== "github.com" ||
    commentUrl.pathname.toLowerCase() !== `/${repo}/pull/${prNumber}`.toLowerCase() ||
    commentUrl.hash !== `#issuecomment-${comment.id}`
  ) {
    throw new CrewdeckError("Verdict comment identity does not belong to the exact PR", "invalid_comment_identity");
  }
  return { id: comment.id, url: comment.html_url };
}

async function findVerdictComment(repo, prNumber, marker, expectedBody) {
  const comments = [];
  for (let page = 1; page <= 100; page += 1) {
    let listed;
    try {
      listed = await runJson("gh", [
        "api", `repos/${repo}/issues/${prNumber}/comments?per_page=100&page=${page}`,
      ], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
    } catch (error) {
      throw new CrewdeckError("Cannot list immutable verdict comments", "forge_unavailable", {
        error: error.message,
      });
    }
    if (!Array.isArray(listed) || listed.length > 100) {
      throw new CrewdeckError("GitHub comment page is invalid", "invalid_comment_lookup");
    }
    comments.push(...listed);
    if (listed.length < 100) break;
    if (page === 100) {
      throw new CrewdeckError("GitHub comment lookup exceeds its 10,000-comment bound", "invalid_comment_lookup");
    }
  }
  let markerCount = 0;
  let markedComment;
  for (const comment of comments) {
    if (typeof comment?.body !== "string") continue;
    let offset = 0;
    while (true) {
      const found = comment.body.indexOf(marker, offset);
      if (found < 0) break;
      markerCount += 1;
      markedComment = comment;
      offset = found + marker.length;
    }
  }
  if (markerCount > 1) {
    throw new CrewdeckError("The immutable verdict marker collides on this PR", "verdict_comment_collision", {
      marker,
      occurrences: markerCount,
    });
  }
  if (markerCount === 0) return undefined;
  if (markedComment.body !== expectedBody) {
    throw new CrewdeckError("The immutable verdict marker has divergent content", "verdict_comment_divergent", {
      marker,
    });
  }
  return verdictCommentIdentity(markedComment, repo, prNumber, expectedBody);
}

function matchingVerdictIntent(publication, headSha) {
  const entries = publication?.verdictComments || [];
  if (!Array.isArray(entries)) {
    throw new CrewdeckError("Durable verdict intent journal is invalid", "verdict_comment_divergent");
  }
  const matches = entries.filter((item) => item?.headSha === headSha);
  if (matches.length > 1) {
    throw new CrewdeckError("Durable verdict comment intent collides for this SHA", "verdict_comment_collision");
  }
  return matches[0];
}

function validateVerdictIntent(intent, { marker, contentSha256, prNumber, approval }) {
  if (
    !["dispatched", "ambiguous", "published"].includes(intent.status) ||
    intent.marker !== marker ||
    intent.contentSha256 !== contentSha256 ||
    intent.prNumber !== prNumber ||
    intent.reviewerTaskId !== approval.reviewTaskId ||
    intent.candidateVersion !== approval.candidateVersion
  ) {
    throw new CrewdeckError("Durable verdict intent has divergent immutable content", "verdict_comment_divergent");
  }
}

async function currentApprovedVerdict(id, fallbackRecord, expectedHead, expectedVersion, expectedReviewTaskId) {
  const state = await loadState();
  const record = state.tasks[id];
  if (!record || record.cleanedAt || ["cleaned", "integrated", "abandoned", "pr-merged"].includes(record.status)) {
    throw new CrewdeckError("Build became terminal before verdict publication", "stale_candidate");
  }
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    throw new CrewdeckError("Build is reserved for merged PR reconciliation", "reconciliation_in_progress");
  }
  const [snapshot, journal] = await Promise.all([
    gitSnapshot(record),
    readCandidateJournal(record),
  ]);
  const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
  const approval = (record.reviewInbox || [])
    .filter((item) =>
      item.reviewTaskId === expectedReviewTaskId &&
      item.reviewedHead === expectedHead &&
      item.verdict === "approved" &&
      item.validAtCollection
    )
    .at(-1);
  if (
    !snapshot.available ||
    !snapshot.clean ||
    snapshot.head !== expectedHead ||
    candidate?.head !== expectedHead ||
    candidate?.version !== expectedVersion ||
    (record.candidateCollectedVersion || 0) < expectedVersion ||
    !approval ||
    (record.reviewEscalation && record.reviewEscalation.reviewedHead === expectedHead)
  ) {
    throw new CrewdeckError("Approved candidate became stale before verdict comment POST", "stale_candidate", {
      approvedHead: expectedHead,
      currentHead: snapshot.head,
      currentCandidateHead: candidate?.head,
    });
  }
  if (
    record.repo !== fallbackRecord.repo ||
    record.worktree !== fallbackRecord.worktree ||
    record.branch !== fallbackRecord.branch
  ) {
    throw new CrewdeckError("Build resources changed before verdict publication", "state_changed");
  }
  validatedVerdictPayload(id, candidate, approval);
  return { record, snapshot, candidate, approval };
}

async function inspectGitHubChecks(project, repo, headSha) {
  const checkedAt = new Date().toISOString();
  if (project.githubChecks === "none") {
    return { policy: "none", status: "disabled", headSha, checkedAt, reason: "project explicitly opts out of GitHub checks" };
  }
  let checks;
  let statuses;
  try {
    [checks, statuses] = await Promise.all([
      runJson("gh", ["api", `repos/${repo}/commits/${headSha}/check-runs?per_page=100`], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
      runJson("gh", ["api", `repos/${repo}/commits/${headSha}/status?per_page=100`], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }),
    ]);
  } catch (error) {
    return { policy: "required", status: "unavailable", headSha, checkedAt, reason: error.message };
  }
  if (!Array.isArray(checks?.check_runs) || !Number.isInteger(checks.total_count) || checks.total_count !== checks.check_runs.length || checks.check_runs.length > 100 || statuses?.sha !== headSha || !Array.isArray(statuses.statuses) || statuses.statuses.length > 100) {
    return { policy: "required", status: "ambiguous", headSha, checkedAt, reason: "invalid or stale-SHA GitHub checks response" };
  }
  const stale = checks.check_runs.some((item) => item?.head_sha !== headSha);
  const checkStates = checks.check_runs.map((item) => ({ name: item.name, status: item.status, conclusion: item.conclusion }));
  const contextStates = statuses.statuses.map((item) => ({ context: item.context, state: item.state }));
  let status = "passing";
  let reason;
  if (stale) ({ status, reason } = { status: "stale", reason: "a check run belongs to another SHA" });
  else if (checkStates.length + contextStates.length === 0) ({ status, reason } = { status: "missing", reason: "no checks or status contexts exist" });
  else if (checkStates.some((item) => item.status !== "completed") || contextStates.some((item) => item.state === "pending")) ({ status, reason } = { status: "pending", reason: "checks have not completed" });
  else if (checkStates.some((item) => !["success", "neutral", "skipped"].includes(item.conclusion)) || contextStates.some((item) => item.state !== "success")) ({ status, reason } = { status: "failing", reason: "one or more checks failed" });
  return { policy: "required", status, headSha, checkedAt, checks: checkStates, contexts: contextStates, ...(reason ? { reason } : {}) };
}

function requirePassingChecks(observation, phase) {
  if (!["passing", "disabled"].includes(observation.status)) {
    throw new CrewdeckError(`GitHub checks refuse ${phase}: ${observation.reason || observation.status}`, "github_checks_not_passing", observation);
  }
}

async function observePublishedVerdict(id, approvedHead) {
  try {
    const state = await loadState();
    const record = state.tasks[id];
    if (!record) return { status: "unknown", approvedHead, error: "task missing" };
    const [snapshot, journal] = await Promise.all([gitSnapshot(record), readCandidateJournal(record)]);
    const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
    const stillApproved = (record.reviewInbox || []).some((item) =>
      item.reviewedHead === approvedHead && item.verdict === "approved" && item.validAtCollection
    );
    const current =
      snapshot.available &&
      snapshot.clean &&
      snapshot.head === approvedHead &&
      candidate?.head === approvedHead &&
      stillApproved;
    return {
      status: current ? "current" : "stale",
      approvedHead,
      currentHead: snapshot.head,
      currentCandidateHead: candidate?.head,
    };
  } catch (error) {
    return { status: "unknown", approvedHead, error: error.message };
  }
}

export async function publishPullRequest(
  configPath,
  id,
  { remote, repo, base, head, title, body },
) {
  const config = await loadConfig(configPath);
  if (!validRemoteName(remote) || !validRepositoryName(repo) || !validBranchName(base) || !validBranchName(head)) {
    throw new CrewdeckError("remote, repo, base, and head must be explicit valid GitHub publication targets", "invalid_publication_target");
  }
  if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !body.trim()) {
    throw new CrewdeckError("Draft PR title and body are required", "invalid_publication_target");
  }
  const intendedTitle = title.trim();
  const intendedBody = body.trim();
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
  record.workflow ||= "direct";
  if (record.lifecycle !== "change" || record.workflow !== "reviewed-pr") {
    throw new CrewdeckError("Draft PR publication requires a reviewed-pr build", "invalid_publication_task");
  }
  if (record.status === "cleaned" || record.cleanedAt || ["integrated", "abandoned", "pr-merged"].includes(record.status)) {
    throw new CrewdeckError("Terminal builds cannot be published", "invalid_publication_task");
  }
  if (["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status)) {
    throw new CrewdeckError("Build is reserved for merged PR reconciliation", "reconciliation_in_progress");
  }
  const project = resolveProject(config, record.project);
  if (
    record.branch !== `crew/${id}` ||
    head !== record.branch ||
    base !== record.base ||
    head === base ||
    path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
    path.resolve(record.repo) !== project.path
  ) {
    throw new CrewdeckError("Publication must push only the task-owned crew branch, never the base", "unsafe_publication_ref");
  }
  const agent = await liveAgent(record);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Build writer is ${agent.state}; publication requires a settled writer`, "worker_not_settled");
  }
  if (!agent.available && !/agent[^\n]*(not[_ -]?found|missing)|not[_ -]?found[^\n]*agent/i.test(agent.error || "")) {
    throw new CrewdeckError("Cannot prove build writer state before publication", "agent_state_unknown", agent);
  }
  const [snapshot, journal] = await Promise.all([gitSnapshot(record), readCandidateJournal(record)]);
  if (!snapshot.available || !snapshot.clean) {
    throw new CrewdeckError("Publication refuses a dirty or unavailable build worktree", "dirty_worktree", snapshot);
  }
  if (record.requiredBaseSha) {
    const requiredBase = await gitAncestorProof(record.repo, record.requiredBaseSha, snapshot.head);
    if (!requiredBase.available || !requiredBase.ancestor) {
      throw new CrewdeckError("Current candidate does not contain the required advanced base", "base_refresh_required", requiredBase);
    }
  }
  if (snapshot.ahead < 1) throw new CrewdeckError("Current candidate has no commits ahead of base", "no_commits");
  const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
  if (!candidate) throw new CrewdeckError("No reviewed-pr candidate is available", "missing_candidate");
  if (snapshot.head !== candidate.head) {
    throw new CrewdeckError("Build HEAD changed after candidate submission", "stale_candidate");
  }
  if ((record.candidateCollectedVersion || 0) < candidate.version) {
    throw new CrewdeckError("Current candidate has not been collected", "candidate_not_collected");
  }
  const approval = (record.reviewInbox || [])
    .filter((item) => item.reviewedHead === snapshot.head && item.verdict === "approved" && item.validAtCollection)
    .at(-1);
  if (!approval) throw new CrewdeckError("Current HEAD has no collected approved review", "review_not_approved");
  if (record.reviewEscalation && record.reviewEscalation.reviewedHead === snapshot.head) {
    throw new CrewdeckError("Current review requires escalation", "review_not_approved");
  }

  let remoteUrl;
  try {
    remoteUrl = (await git(record.worktree, ["remote", "get-url", "--push", remote])).stdout;
  } catch (error) {
    throw new CrewdeckError(`Git remote '${remote}' is unavailable`, "remote_unavailable", { error: error.message });
  }
  const remoteRepo = githubRepositoryFromUrl(remoteUrl);
  if (!remoteRepo || remoteRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new CrewdeckError("Git remote is not the requested GitHub repository", "remote_repo_mismatch", { remoteUrl, repo });
  }
  try {
    await run("gh", ["auth", "status", "--hostname", "github.com"], { timeout: 15_000 });
  } catch (error) {
    throw new CrewdeckError("GitHub credentials are unavailable", "credentials_unavailable", { error: error.message });
  }
  let forgeRepo;
  try {
    forgeRepo = await runJson("gh", ["repo", "view", repo, "--json", "nameWithOwner"], { timeout: 20_000 });
  } catch (error) {
    throw new CrewdeckError("GitHub repository is unavailable through gh", "forge_unavailable", { error: error.message });
  }
  if (forgeRepo?.nameWithOwner?.toLowerCase() !== repo.toLowerCase()) {
    throw new CrewdeckError("gh resolved a different GitHub repository", "forge_repo_mismatch", forgeRepo);
  }

  const baseRef = `refs/heads/${base}`;
  const remoteRef = `refs/heads/${head}`;
  const readRemoteSha = async (ref) => {
    const output = (await git(record.worktree, ["ls-remote", "--heads", remote, ref], { timeout: 30_000 })).stdout;
    if (!output) return undefined;
    const lines = output.split("\n").filter(Boolean);
    if (lines.length !== 1) throw new CrewdeckError(`Remote ref ${ref} is ambiguous`, "ambiguous_remote_ref");
    const [sha, foundRef] = lines[0].split(/\s+/);
    if (!/^[0-9a-f]{40}$/.test(sha || "") || foundRef !== ref) {
      throw new CrewdeckError(`Remote returned an invalid ref for ${ref}`, "invalid_remote_ref");
    }
    return sha;
  };
  const publicationBaseSha = await readRemoteSha(baseRef);
  if (!publicationBaseSha) {
    throw new CrewdeckError(`Remote base ${base} does not exist`, "remote_base_missing");
  }
  let configuredBaseEvidence = { source: "publication-remote", remote, sha: publicationBaseSha, verifiedAt: new Date().toISOString() };
  if (record.baseSource?.mode === "remote") {
    const resolved = await resolveChangeBase(project);
    configuredBaseEvidence = { source: "configured-base-remote", remote: record.baseSource.remote, sha: resolved.sha, verifiedAt: new Date().toISOString() };
  }
  if (record.baseSha && configuredBaseEvidence.sha !== record.baseSha) {
    throw new CrewdeckError("Configured reviewed base advanced after spawn; a new candidate/review contract is required", "base_advanced", {
      pinnedBaseSha: record.baseSha, currentBaseSha: configuredBaseEvidence.sha, baseSource: record.baseSource,
    });
  }
  if (record.baseSha && publicationBaseSha !== record.baseSha) {
    throw new CrewdeckError("Publication base differs from the pinned reviewed base", "base_drift", {
      pinnedBaseSha: record.baseSha, publicationBaseSha, remote, base,
    });
  }

  const prFields = [
    "number", "url", "isDraft", "headRefName", "baseRefName", "headRefOid",
    "isCrossRepository", "headRepository", "headRepositoryOwner", "state", "title", "body",
  ].join(",");
  const validatePr = (pr, expectedHeadSha = undefined) => {
    const urlMatch = typeof pr?.url === "string"
      ? pr.url.match(/^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/([1-9][0-9]*)$/i)
      : undefined;
    if (
      !pr ||
      !Number.isInteger(pr.number) ||
      !urlMatch ||
      urlMatch[1].toLowerCase() !== repo.toLowerCase() ||
      Number(urlMatch[2]) !== pr.number ||
      typeof pr.title !== "string" ||
      typeof pr.body !== "string" ||
      pr.isDraft !== true ||
      pr.headRefName !== head ||
      pr.baseRefName !== base ||
      pr.isCrossRepository !== false ||
      !exactHeadRepository(pr.headRepository, pr.headRepositoryOwner, repo) ||
      (pr.state !== undefined && pr.state !== "OPEN") ||
      (expectedHeadSha !== undefined && pr.headRefOid !== expectedHeadSha)
    ) {
      throw new CrewdeckError("Existing GitHub PR is not the expected open draft", "invalid_existing_pr", pr);
    }
    return pr;
  };
  const validateExactPr = (pr, expectedHeadSha = undefined) => {
    const validated = validatePr(pr, expectedHeadSha);
    if (
      validated.title !== intendedTitle ||
      validated.body !== intendedBody ||
      validated.baseRefName !== base
    ) {
      throw new CrewdeckError(
        "GitHub PR title, body, or base does not match the intended publication",
        "invalid_existing_pr",
        validated,
      );
    }
    return validated;
  };

  const publication = record.publication;
  if (
    publication &&
    (publication.remote !== remote ||
      publication.repo.toLowerCase() !== repo.toLowerCase() ||
      publication.base !== base ||
      publication.remoteHead !== head)
  ) {
    throw new CrewdeckError("Publication target cannot change after first attempt", "publication_target_mismatch");
  }
  let existingPr;
  if (publication?.number) {
    try {
      existingPr = validatePr(await runJson("gh", [
        "pr", "view", String(publication.number), "--repo", repo,
        "--json", prFields,
      ], { timeout: 20_000 }));
    } catch (error) {
      if (error instanceof CrewdeckError && error.code === "invalid_existing_pr") throw error;
      throw new CrewdeckError("Stored draft PR is unavailable", "forge_unavailable", { error: error.message });
    }
  } else {
    let listed;
    try {
      listed = await runJson("gh", [
        "pr", "list", "--repo", repo, "--head", head, "--base", base, "--state", "open",
        "--json", prFields, "--limit", "2",
      ], { timeout: 20_000 });
    } catch (error) {
      throw new CrewdeckError("Cannot query GitHub draft PRs", "forge_unavailable", { error: error.message });
    }
    if (!Array.isArray(listed) || listed.length > 1) {
      throw new CrewdeckError("GitHub PR lookup is invalid or ambiguous", "ambiguous_pull_request", listed);
    }
    if (listed.length === 1) existingPr = validatePr(listed[0]);
  }

  let remoteSha = await readRemoteSha(remoteRef);
  const ownedRemote =
    !remoteSha ||
    publication?.remoteSha === remoteSha ||
    (remoteSha === snapshot.head && existingPr?.headRefName === head);
  if (!ownedRemote) {
    throw new CrewdeckError("Remote head exists but is not owned by this durable publication", "remote_head_changed", {
      expected: publication?.remoteSha,
      actual: remoteSha,
    });
  }
  let pushedAt = publication?.pushedAt;
  if (remoteSha !== snapshot.head) {
    const lease = `--force-with-lease=${remoteRef}:${remoteSha || ""}`;
    await git(record.worktree, ["push", lease, remote, `${snapshot.head}:${remoteRef}`], { timeout: 120_000 });
    remoteSha = await readRemoteSha(remoteRef);
    if (remoteSha !== snapshot.head) {
      throw new CrewdeckError("Remote head does not equal the approved SHA after push", "push_verification_failed");
    }
    pushedAt = new Date().toISOString();
  }
  const afterPush = await gitSnapshot(record);
  if (!afterPush.available || !afterPush.clean || afterPush.head !== snapshot.head) {
    throw new CrewdeckError("Build HEAD changed during publication; review and CI are stale", "stale_candidate");
  }

  const attemptAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (!stored) throw new CrewdeckError("Build disappeared during publication", "state_changed");
    stored.publication = {
      ...(stored.publication || {}),
      remote,
      repo,
      base,
      remoteHead: head,
      remoteSha,
      title: intendedTitle,
      body: intendedBody,
      headSha: snapshot.head,
      baseEvidence: configuredBaseEvidence,
      pushedAt,
      createdAt: stored.publication?.createdAt || attemptAt,
      firstAttemptAt: stored.publication?.firstAttemptAt || attemptAt,
      lastAttemptAt: attemptAt,
    };
    await saveState(next);
  });

  let pr = existingPr;
  let prCreatedAt = publication?.prCreatedAt;
  if (!pr) {
    try {
      await run("gh", [
        "pr", "create", "--draft", "--repo", repo, "--base", base, "--head", head,
        "--title", intendedTitle, "--body", intendedBody,
      ], { timeout: 60_000 });
    } catch (error) {
      throw new CrewdeckError("Draft PR creation failed; retry will reconcile by head/base", "pr_create_failed", {
        error: error.message,
        remoteSha,
      });
    }
    const listed = await runJson("gh", [
      "pr", "list", "--repo", repo, "--head", head, "--base", base, "--state", "open",
      "--json", prFields, "--limit", "2",
    ], { timeout: 20_000 });
    if (!Array.isArray(listed) || listed.length !== 1) {
      throw new CrewdeckError("Created draft PR cannot be reconciled uniquely", "ambiguous_pull_request", listed);
    }
    pr = validateExactPr(listed[0], snapshot.head);
    prCreatedAt = new Date().toISOString();
  } else if (
    pr.title !== intendedTitle ||
    pr.body !== intendedBody ||
    pr.baseRefName !== base ||
    publication?.headSha !== snapshot.head
  ) {
    try {
      await run("gh", [
        "api", "--method", "PATCH", `repos/${repo}/pulls/${pr.number}`,
        "--raw-field", `title=${intendedTitle}`,
        "--raw-field", `body=${intendedBody}`,
        "--raw-field", `base=${base}`,
      ], { timeout: 30_000 });
    } catch (error) {
      throw new CrewdeckError(
        "Draft PR REST update failed; retry will re-read authoritative PR state",
        "pr_update_failed",
        { error: error.message, number: pr.number, remoteSha },
      );
    }
    try {
      pr = validateExactPr(await runJson("gh", [
        "pr", "view", String(pr.number), "--repo", repo,
        "--json", prFields,
      ], { timeout: 20_000 }), snapshot.head);
    } catch (error) {
      if (error instanceof CrewdeckError && error.code === "invalid_existing_pr") throw error;
      throw new CrewdeckError("Cannot verify the draft PR after REST update", "forge_unavailable", {
        error: error.message,
      });
    }
  }

  const updatedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (!stored?.publication || stored.publication.remoteSha !== snapshot.head) {
      throw new CrewdeckError("Publication state changed before PR persistence", "state_changed");
    }
    stored.publication = {
      ...stored.publication,
      number: pr.number,
      url: pr.url,
      draft: true,
      prCreatedAt: stored.publication.prCreatedAt || prCreatedAt || updatedAt,
      updatedAt,
      lastVerifiedAt: updatedAt,
    };
    await saveState(next);
  });

  const checkObservation = await inspectGitHubChecks(project, repo, snapshot.head);
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (!stored?.publication || stored.publication.number !== pr.number || stored.publication.headSha !== snapshot.head) {
      throw new CrewdeckError("Publication changed before checks persistence", "state_changed");
    }
    stored.publication.checks = checkObservation;
    await saveState(next);
  });
  requirePassingChecks(checkObservation, "publication completion");

  const prWasIdempotent =
    publication?.headSha === snapshot.head &&
    publication?.title === intendedTitle &&
    publication?.body === intendedBody &&
    existingPr?.number === pr.number &&
    existingPr?.title === intendedTitle &&
    existingPr?.body === intendedBody &&
    existingPr?.baseRefName === base;
  const readExactCommentPr = async () => {
    try {
      return validateExactPr(await runJson("gh", [
        "pr", "view", String(pr.number), "--repo", repo, "--json", prFields,
      ], { timeout: 20_000 }), snapshot.head);
    } catch (error) {
      if (error instanceof CrewdeckError && error.code === "invalid_existing_pr") throw error;
      throw new CrewdeckError("Cannot validate the exact draft PR before verdict POST", "forge_unavailable", {
        error: error.message,
      });
    }
  };

  // The exact PR and approved local state are checked after PR create/REST update and
  // immediately around marker lookup. No comment POST is allowed before these checks.
  await readExactCommentPr();
  let current = await currentApprovedVerdict(
    id,
    record,
    snapshot.head,
    candidate.version,
    approval.reviewTaskId,
  );
  let rendered = renderVerdictComment(id, current.candidate, current.approval);
  let foundComment = await findVerdictComment(repo, pr.number, rendered.marker, rendered.body);

  const intentMetadata = {
    headSha: snapshot.head,
    marker: rendered.marker,
    contentSha256: rendered.contentSha256,
    prNumber: pr.number,
    reviewerTaskId: current.approval.reviewTaskId,
    candidateVersion: current.candidate.version,
  };
  const persistCommentIdentity = async (identity, { adopted = false } = {}) => {
    let persisted;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (
        !stored?.publication ||
        stored.publication.number !== pr.number ||
        stored.publication.repo?.toLowerCase() !== repo.toLowerCase() ||
        stored.publication.base !== base ||
        stored.publication.remoteHead !== head
      ) {
        throw new CrewdeckError("Publication target changed before verdict identity persistence", "state_changed");
      }
      stored.publication.verdictComments ||= [];
      let intent = matchingVerdictIntent(stored.publication, snapshot.head);
      if (!intent) {
        if (!adopted) {
          throw new CrewdeckError("Durable verdict dispatch intent is missing", "state_changed");
        }
        intent = { ...intentMetadata, status: "published" };
        stored.publication.verdictComments.push(intent);
      } else {
        validateVerdictIntent(intent, {
          ...rendered,
          prNumber: pr.number,
          approval: current.approval,
        });
      }
      if (intent.comment && (intent.comment.id !== identity.id || intent.comment.url !== identity.url)) {
        throw new CrewdeckError("Durable verdict comment identity changed", "verdict_comment_collision");
      }
      intent.status = "published";
      intent.comment = identity;
      persisted = { record: { ...stored }, intent: { ...intent } };
      await saveState(next);
    });
    return persisted;
  };
  const publicationResult = async (persisted, { adopted, idempotent }) => ({
    published: true,
    idempotent: prWasIdempotent && idempotent,
    task: publicTaskRecord(persisted.record),
    publication: persisted.record.publication,
    verdictComment: {
      ...persisted.intent.comment,
      marker: persisted.intent.marker,
      headSha: persisted.intent.headSha,
      reviewerTaskId: persisted.intent.reviewerTaskId,
      candidateVersion: persisted.intent.candidateVersion,
      immutable: true,
      adopted,
    },
    currentVerdictState: await observePublishedVerdict(id, snapshot.head),
  });

  if (foundComment) {
    const persisted = await persistCommentIdentity(foundComment, { adopted: true });
    return publicationResult(persisted, { adopted: true, idempotent: true });
  }

  // Recheck both authorities after lookup. This catches a stale HEAD/PR before
  // the first and only possible comment POST for this task+SHA marker.
  current = await currentApprovedVerdict(
    id,
    record,
    snapshot.head,
    candidate.version,
    approval.reviewTaskId,
  );
  const rerendered = renderVerdictComment(id, current.candidate, current.approval);
  if (rerendered.body !== rendered.body || rerendered.marker !== rendered.marker) {
    throw new CrewdeckError("Approved verdict data changed before dispatch", "state_changed");
  }
  rendered = rerendered;
  await readExactCommentPr();
  current = await currentApprovedVerdict(
    id,
    record,
    snapshot.head,
    candidate.version,
    approval.reviewTaskId,
  );
  if (renderVerdictComment(id, current.candidate, current.approval).body !== rendered.body) {
    throw new CrewdeckError("Approved verdict data changed before dispatch", "state_changed");
  }

  let shouldPost = false;
  let existingIntentStatus;
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (
      !stored?.publication ||
      stored.publication.number !== pr.number ||
      stored.publication.headSha !== snapshot.head ||
      stored.publication.remoteSha !== snapshot.head
    ) {
      throw new CrewdeckError("Publication changed before verdict dispatch", "state_changed");
    }
    const lockedApproval = (stored.reviewInbox || []).find((item) =>
      item.reviewTaskId === approval.reviewTaskId &&
      item.reviewedHead === snapshot.head &&
      item.verdict === "approved" &&
      item.validAtCollection
    );
    if (
      stored.cleanedAt ||
      ["cleaned", "integrated", "abandoned", "pr-merged"].includes(stored.status) ||
      ["cleanup-pending", "cleanup-failed"].includes(stored.mergeReconciliation?.status) ||
      (stored.candidateCollectedVersion || 0) < candidate.version ||
      !lockedApproval ||
      (stored.reviewEscalation && stored.reviewEscalation.reviewedHead === snapshot.head) ||
      renderVerdictComment(id, current.candidate, lockedApproval).body !== rendered.body
    ) {
      throw new CrewdeckError("Approved candidate state changed before verdict dispatch", "stale_candidate");
    }
    stored.publication.verdictComments ||= [];
    const intent = matchingVerdictIntent(stored.publication, snapshot.head);
    if (intent) {
      validateVerdictIntent(intent, {
        ...rendered,
        prNumber: pr.number,
        approval: current.approval,
      });
      existingIntentStatus = intent.status;
      return;
    }
    stored.publication.verdictComments.push({
      ...intentMetadata,
      status: "dispatched",
      dispatchedAt: new Date().toISOString(),
    });
    shouldPost = true;
    await saveState(next);
  });

  if (!shouldPost) {
    // A concurrent or interrupted caller owns the sole dispatch. Reconcile only;
    // absence is durably ambiguous and can never authorize an automatic repost.
    foundComment = await findVerdictComment(repo, pr.number, rendered.marker, rendered.body);
    if (foundComment) {
      const persisted = await persistCommentIdentity(foundComment, { adopted: true });
      return publicationResult(persisted, { adopted: true, idempotent: true });
    }
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      const intent = matchingVerdictIntent(stored?.publication, snapshot.head);
      if (intent && intent.status !== "published") {
        validateVerdictIntent(intent, {
          ...rendered,
          prNumber: pr.number,
          approval: current.approval,
        });
        intent.status = "ambiguous";
        intent.ambiguousAt ||= new Date().toISOString();
        await saveState(next);
      }
    });
    throw new CrewdeckError(
      existingIntentStatus === "published"
        ? "Published immutable verdict comment is no longer present; Crewdeck will not replace it"
        : "Verdict dispatch outcome is ambiguous; Crewdeck will not issue a second POST",
      existingIntentStatus === "published" ? "verdict_comment_missing" : "verdict_comment_ambiguous",
      { marker: rendered.marker, prNumber: pr.number },
    );
  }

  let postedIdentity;
  try {
    const posted = await runJson("gh", [
      "api", "--method", "POST", `repos/${repo}/issues/${pr.number}/comments`,
      "--raw-field", `body=${rendered.body}`,
    ], { timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    postedIdentity = verdictCommentIdentity(posted, repo, pr.number, rendered.body);
  } catch (error) {
    // The dispatched intent is intentionally left intact. A later invocation
    // may only relist/adopt; it can never compensate or send another POST.
    throw new CrewdeckError(
      "Verdict comment POST may have been applied; retry will reconcile without reposting",
      "verdict_comment_post_ambiguous",
      { error: error.message, marker: rendered.marker, prNumber: pr.number },
    );
  }
  const persisted = await persistCommentIdentity(postedIdentity);
  return publicationResult(persisted, { adopted: false, idempotent: false });
}

export async function reconcileVerdictComment(configPath, id, { reason } = {}) {
  await loadConfig(configPath);
  if (typeof reason !== "string" || !reason.trim()) throw new CrewdeckError("Verdict reconciliation requires a durable reason", "invalid_reason");
  const state = await loadState();
  const record = state.tasks[id];
  if (!record?.publication?.number || !record.publication.repo) throw new CrewdeckError("Task has no exact published PR", "publication_incomplete");
  const journal = await readCandidateJournal(record);
  const candidate = journal.available ? journal.journal.candidates.at(-1) : undefined;
  const approval = candidate && (record.reviewInbox || []).find((item) => item.reviewedHead === candidate.head && item.verdict === "approved" && item.validAtCollection);
  if (!candidate || !approval || record.publication.headSha !== candidate.head) throw new CrewdeckError("Current exact approval/publication evidence is missing", "invalid_approval_evidence");
  const rendered = renderVerdictComment(id, candidate, approval);
  const intent = matchingVerdictIntent(record.publication, candidate.head);
  if (!intent || !["dispatched", "ambiguous"].includes(intent.status)) {
    if (intent?.status === "published") return { reconciled: true, idempotent: true, intent };
    throw new CrewdeckError("No ambiguous exact verdict dispatch can be reconciled", "verdict_reconciliation_not_applicable");
  }
  validateVerdictIntent(intent, { ...rendered, prNumber: record.publication.number, approval });
  let found;
  let refusal;
  try {
    found = await findVerdictComment(record.publication.repo, record.publication.number, rendered.marker, rendered.body);
    if (!found) refusal = { code: "verdict_comment_absent", message: "Exact immutable verdict comment is absent" };
  } catch (error) {
    refusal = { code: error.code || "verdict_lookup_failed", message: error.message, details: error.details };
  }
  const reconciledAt = new Date().toISOString();
  let persisted;
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    const current = matchingVerdictIntent(stored?.publication, candidate.head);
    if (!current || current.contentSha256 !== rendered.contentSha256 || !["dispatched", "ambiguous"].includes(current.status)) {
      throw new CrewdeckError("Verdict intent changed concurrently", "state_changed");
    }
    stored.verdictReconciliations ||= [];
    const outcome = { headSha: candidate.head, prNumber: record.publication.number, reason: reason.trim(), reconciledAt,
      outcome: found ? "adopted-exact" : "refused", ...(refusal ? { refusal } : {}) };
    stored.verdictReconciliations.push(outcome);
    if (found) {
      current.status = "published";
      current.comment = found;
      current.reconciledAt = reconciledAt;
      current.reconciliationReason = reason.trim();
    }
    persisted = { outcome, intent: { ...current } };
    await saveState(next);
  });
  if (!found) throw new CrewdeckError(refusal.message, refusal.code, { ...refusal.details, durableOutcome: persisted.outcome });
  return { reconciled: true, idempotent: false, ...persisted };
}

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

const BASE_ADVANCE_TERMINAL = new Set(["cleaned", "integrated", "abandoned", "pr-merged", "orphan-reconciled", "retired"]);

async function classifyBaseAdvance(record, newBaseSha) {
  if (!/^[0-9a-f]{40}$/.test(record.baseSha || "") || !/^[0-9a-f]{40}$/.test(newBaseSha || "")) {
    return { classification: "unknown", reason: "missing exact pinned or advanced base commit" };
  }
  const behind = await gitAncestorProof(record.repo, record.baseSha, newBaseSha);
  if (!behind.available || !behind.ancestor) {
    return { classification: "unknown", reason: behind.error || "pinned base is not proven ancestral to the merged base" };
  }
  const snapshot = await gitSnapshot(record);
  if (!snapshot.available) return { classification: "unknown", reason: snapshot.error || "build HEAD is unavailable" };
  const contains = await gitAncestorProof(record.repo, newBaseSha, snapshot.head);
  if (contains.available && contains.ancestor) {
    return { classification: "compatible", requiresRefresh: false, headSha: snapshot.head, evidence: "advanced base already contained by build HEAD" };
  }
  try {
    await git(record.repo, ["merge-tree", "--write-tree", "--merge-base", record.baseSha, newBaseSha, snapshot.head]);
    return { classification: "compatible", requiresRefresh: true, headSha: snapshot.head, evidence: "git merge-tree completed without conflicts" };
  } catch (error) {
    if (error.code === "command_failed" && Number(error.details?.exitCode) === 1) {
      return { classification: "conflicting", requiresRefresh: true, headSha: snapshot.head, evidence: "git merge-tree reported conflicts" };
    }
    return { classification: "unknown", headSha: snapshot.head, reason: error.message };
  }
}

async function recordBaseAdvanceFanout(source, outcome) {
  if (outcome.status !== "merged-awaiting-confirmed-reconciliation" || !/^[0-9a-f]{40}$/.test(outcome.mergeCommit || "")) return [];
  const snapshot = await loadState();
  const eligible = Object.values(snapshot.tasks).filter((record) => {
    const lifecycle = record.lifecycle || (record.kind === "scout" ? "report" : "change");
    return record.id !== source.id && record.project === source.project && lifecycle === "change" &&
      record.base === source.base && !record.cleanedAt && !BASE_ADVANCE_TERMINAL.has(record.status) &&
      record.baseSha !== outcome.mergeCommit;
  });
  const classified = [];
  for (const record of eligible) classified.push({ record, result: await classifyBaseAdvance(record, outcome.mergeCommit) });
  const created = [];
  await withStateLock(async () => {
    const next = await loadState();
    for (const { record, result } of classified) {
      const stored = next.tasks[record.id];
      if (!stored || stored.id === source.id || stored.project !== source.project || stored.lifecycle === "report" ||
          stored.cleanedAt || BASE_ADVANCE_TERMINAL.has(stored.status)) continue;
      stored.baseAdvances ||= [];
      const identity = `${source.id}:${stored.baseSha || "unknown"}:${outcome.mergeCommit}`;
      const existing = stored.baseAdvances.find((item) => item.identity === identity);
      if (existing) {
        if (["pending", "awaiting-writer"].includes(existing.status) && result.headSha && existing.headSha !== result.headSha) {
          Object.assign(existing, {
            classification: result.classification,
            ...(result.requiresRefresh !== undefined ? { requiresRefresh: result.requiresRefresh } : {}),
            headSha: result.headSha,
            ...(result.evidence ? { evidence: result.evidence, reason: undefined } : {}),
            ...(result.reason ? { reason: result.reason, evidence: undefined } : {}),
            reclassifiedAt: new Date().toISOString(),
          });
          created.push({ taskId: stored.id, ...existing, updated: true });
        }
        continue;
      }
      const notification = {
        sequence: stored.baseAdvances.length + 1,
        identity,
        status: "pending",
        sourceTaskId: source.id,
        sourcePrNumber: outcome.number,
        sourcePrUrl: outcome.url,
        priorBaseSha: stored.baseSha,
        newBaseSha: outcome.mergeCommit,
        mergedAt: outcome.mergedAt,
        observedAt: outcome.observedAt,
        classification: result.classification,
        ...(result.requiresRefresh !== undefined ? { requiresRefresh: result.requiresRefresh } : {}),
        ...(result.headSha ? { headSha: result.headSha } : {}),
        ...(result.evidence ? { evidence: result.evidence } : {}),
        ...(result.reason ? { reason: result.reason } : {}),
      };
      stored.baseAdvances.push(notification);
      created.push({ taskId: stored.id, ...notification });
    }
    if (created.length) await saveState(next);
  });
  return created;
}

export async function observePublishedPullRequests(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const records = Object.values(state.tasks).filter((record) =>
    (!id || record.id === id) && record.status === "running" && record.workflow === "reviewed-pr" && record.publication?.number
  );
  if (id && records.length === 0) throw new CrewdeckError("No active published reviewed-pr task matches", "publication_incomplete");
  const observations = [];
  for (const record of records) {
    const publication = record.publication;
    const fields = "number,url,state,isDraft,headRefName,baseRefName,headRefOid,isCrossRepository,headRepository,headRepositoryOwner,mergeCommit,mergedAt";
    let outcome;
    try {
      const pr = await runJson("gh", ["pr", "view", String(publication.number), "--repo", publication.repo, "--json", fields], { timeout: 20_000 });
      const identityExact = pr?.number === publication.number && pr?.url === publication.url &&
        exactPullRequestUrl(pr?.url, publication.repo, publication.number) && pr?.headRefName === publication.remoteHead &&
        pr?.baseRefName === publication.base && pr?.headRefOid === publication.headSha && pr?.isCrossRepository === false &&
        exactHeadRepository(pr?.headRepository, pr?.headRepositoryOwner, publication.repo);
      if (!identityExact) throw new CrewdeckError("Observed PR identity diverges from durable publication", "observer_identity_mismatch", pr);
      if (pr.state === "MERGED" && (!/^[0-9a-f]{40}$/.test(pr.mergeCommit?.oid || "") ||
          typeof pr.mergedAt !== "string" || Number.isNaN(Date.parse(pr.mergedAt)))) {
        throw new CrewdeckError("Merged observation lacks exact merge identity", "observer_identity_mismatch", pr);
      }
      const stateName = pr.state === "MERGED" ? "merged-awaiting-confirmed-reconciliation"
        : pr.state === "OPEN" ? "open" : pr.state === "CLOSED" ? "closed-unmerged" : "unknown";
      outcome = { status: stateName, observedAt: new Date().toISOString(), repo: publication.repo,
        number: publication.number, url: publication.url, headSha: publication.headSha,
        ...(pr.state === "MERGED" ? { mergedAt: pr.mergedAt, mergeCommit: pr.mergeCommit?.oid } : {}) };
    } catch (error) {
      outcome = { status: "lookup-failed", observedAt: new Date().toISOString(), repo: publication.repo,
        number: publication.number, url: publication.url, headSha: publication.headSha, reason: error.message };
    }
    let newlyObserved = false;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[record.id];
      if (stored?.publication?.number === publication.number && stored.publication.headSha === publication.headSha) {
        newlyObserved = stored.prObservation?.status !== outcome.status;
        stored.prObservation = outcome;
        stored.prObservationHistory ||= [];
        if (newlyObserved) stored.prObservationHistory.push(outcome);
        await saveState(next);
      }
    });
    // Run fanout on every exact merged observation. Durable identities deduplicate it;
    // this closes the crash window between persisting the PR observation and fanout.
    const baseAdvances = outcome.status === "merged-awaiting-confirmed-reconciliation"
      ? await recordBaseAdvanceFanout(record, outcome) : [];
    observations.push({ id: record.id, ...outcome, newlyObserved, baseAdvances });
  }
  return observations;
}

export async function forwardBaseAdvance(configPath, id, sequence, { wait = false } = {}) {
  if (sequence !== undefined && (!Number.isSafeInteger(sequence) || sequence < 1)) throw new CrewdeckError("Base-advance sequence must be a positive safe integer", "invalid_base_advance_sequence");
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
  if (record.lifecycle !== "change" || record.cleanedAt || BASE_ADVANCE_TERMINAL.has(record.status)) {
    throw new CrewdeckError("Only a nonterminal change task can receive a base advance", "invalid_base_advance_task");
  }
  const notification = sequence === undefined
    ? (record.baseAdvances || []).filter((item) => item.status === "pending" || item.status === "awaiting-writer").at(-1)
    : (record.baseAdvances || []).find((item) => item.sequence === sequence);
  if (!notification) throw new CrewdeckError("Pending base-advance notification is missing", "base_advance_missing");
  if (notification.status === "forwarded" || notification.status === "compatible-preserved") {
    return { forwarded: notification.status === "forwarded", preserved: notification.status === "compatible-preserved", idempotent: true, notification };
  }
  if (notification.classification === "unknown") {
    throw new CrewdeckError("Base compatibility is unknown; resolve Git evidence before notifying a writer", "base_compatibility_unknown", notification);
  }
  const currentSnapshot = await gitSnapshot(record);
  if (!currentSnapshot.available || (notification.headSha && currentSnapshot.head !== notification.headSha)) {
    throw new CrewdeckError("Build HEAD changed after base compatibility classification; wait for observer reclassification", "base_advance_stale", {
      classifiedHead: notification.headSha, currentHead: currentSnapshot.head, error: currentSnapshot.error,
    });
  }
  if (notification.classification === "compatible" && (record.publication?.number || notification.requiresRefresh === false)) {
    await withStateLock(async () => {
      const next = await loadState();
      const item = (next.tasks[id]?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
      if (!item) throw new CrewdeckError("Base advance changed", "state_changed");
      item.status = "compatible-preserved";
      item.settledAt ||= new Date().toISOString();
      await saveState(next);
    });
    return {
      forwarded: false, preserved: true, idempotent: false,
      reason: record.publication?.number
        ? "published exact-SHA PR is locally compatible and is not rewritten"
        : "build HEAD already contains the advanced base; candidate and approval identity do not require refresh",
    };
  }
  const agent = await liveAgent(record);
  if (!agent.available) {
    if (!provenMissingAgent(agent)) throw new CrewdeckError("Cannot prove sole writer state", "agent_state_unknown", agent);
    await withStateLock(async () => {
      const next = await loadState();
      const item = (next.tasks[id]?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
      if (!item) throw new CrewdeckError("Base advance changed", "state_changed");
      item.status = "awaiting-writer";
      item.writerAbsentAt ||= new Date().toISOString();
      await saveState(next);
    });
    return { forwarded: false, writerAbsent: true, nextAction: "resume the sole writer, then forward this base advance" };
  }
  const attemptedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    const item = (stored?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
    if (!item) throw new CrewdeckError("Base advance changed", "state_changed");
    item.status = "forwarding";
    item.forwardAttempts = (item.forwardAttempts || 0) + 1;
    item.forwardAttemptedAt = attemptedAt;
    stored.baseShaHistory ||= [];
    if (stored.baseSha !== notification.newBaseSha) {
      stored.baseShaHistory.push({ sha: stored.baseSha, supersededBy: notification.newBaseSha, at: attemptedAt, sourceTaskId: notification.sourceTaskId });
      stored.baseSha = notification.newBaseSha;
    }
    stored.requiredBaseSha = notification.newBaseSha;
    for (const review of stored.reviewInbox || []) {
      if (review.validAtCollection) {
        review.validAtCollection = false;
        review.staleAt ||= attemptedAt;
        review.staleReason = "pinned base advanced";
      }
    }
    await saveState(next);
  });
  const message = [
    `CREWDECK BASE ADVANCE ${notification.sequence}: ${notification.sourceTaskId} merged and the pinned base advanced from ${notification.priorBaseSha} to ${notification.newBaseSha}.`,
    `Local deterministic classification: ${notification.classification}.`,
    "Adapt/rebase the existing sole-writer branch without discarding work, rerun verification, commit any resulting changes, and submit a new exact-HEAD candidate when the SHA changes. Prior candidate review/approval is stale. Do not reuse it.",
  ].join("\n");
  const args = ["agent", "prompt", record.agentName, message];
  if (wait) args.push("--wait", "--timeout", "600000");
  await runJson("herdr", args, { timeout: wait ? 610_000 : 15_000 });
  const forwardedAt = new Date().toISOString();
  await withStateLock(async () => {
    const next = await loadState();
    const item = (next.tasks[id]?.baseAdvances || []).find((entry) => entry.identity === notification.identity);
    if (!item) throw new CrewdeckError("Base advance changed after delivery", "state_changed");
    item.status = "forwarded";
    item.forwardedAt ||= forwardedAt;
    await saveState(next);
  });
  return { forwarded: true, idempotent: false, taskId: id, sequence: notification.sequence, forwardedAt };
}

function mergedReconciliationResult(record, idempotent) {
  return {
    reconciled: true,
    idempotent,
    status: "merged-reconciled",
    task: publicTaskRecord(record),
    publication: record.publication,
    reconciliation: record.mergeReconciliation,
  };
}

export async function reconcileMergedPullRequest(configPath, id) {
  const config = await loadConfig(configPath);
  const state = await loadState();
  const record = state.tasks[id];
  if (!record) throw new CrewdeckError(`Unknown task '${id}'`, "unknown_task");
  record.kind ||= record.profile === "scout" ? "scout" : "build";
  record.lifecycle ||= config.kinds[record.kind]?.lifecycle || "change";
  record.workflow ||= "direct";
  record.cleanup ||= config.kinds[record.kind]?.cleanup || "after-integration";

  if (record.status === "pr-merged") {
    if (record.mergeReconciliation?.status !== "merged-reconciled") {
      throw new CrewdeckError("Merged PR task has incomplete reconciliation evidence", "invalid_reconciliation_state");
    }
    return mergedReconciliationResult(record, true);
  }
  if (record.lifecycle !== "change" || record.workflow !== "reviewed-pr") {
    throw new CrewdeckError("Merged PR reconciliation requires a reviewed-pr change task", "invalid_reconciliation_task");
  }
  if (record.status !== "running" || record.cleanedAt) {
    throw new CrewdeckError(
      `Task status '${record.status}' is not eligible for merged PR reconciliation`,
      "invalid_reconciliation_state",
    );
  }
  const recovery = ["cleanup-pending", "cleanup-failed"].includes(record.mergeReconciliation?.status);
  if (record.mergeReconciliation && !recovery) {
    throw new CrewdeckError("Task has invalid merge reconciliation state", "invalid_reconciliation_state");
  }
  if (record.resumeReservation) {
    throw new CrewdeckError("A build adoption reservation is active", "writer_already_present");
  }
  const activeReview = Object.values(state.tasks).find((item) =>
    item.parentTaskId === id &&
    !item.cleanedAt &&
    !["cleaned", "orphan-reconciled"].includes(item.status)
  );
  if (activeReview) {
    throw new CrewdeckError("A reviewer for this build is still active", "reviewer_already_active", {
      reviewTaskId: activeReview.id,
    });
  }

  const project = resolveProject(config, record.project);
  if (
    record.branch !== `crew/${id}` ||
    record.base !== project.base ||
    path.resolve(record.worktree) !== path.join(config.worktreeRoot, record.project, id) ||
    path.resolve(record.repo) !== project.path
  ) {
    throw new CrewdeckError("Task does not reference its expected isolated Git resources", "unsafe_task_resources");
  }

  const publication = record.publication;
  if (
    !publication ||
    !validRemoteName(publication.remote) ||
    !validRepositoryName(publication.repo) ||
    !validBranchName(publication.base) ||
    !validBranchName(publication.remoteHead) ||
    !Number.isInteger(publication.number) ||
    publication.number < 1 ||
    !exactPullRequestUrl(publication.url, publication.repo, publication.number) ||
    publication.base !== record.base ||
    publication.remoteHead !== record.branch ||
    publication.headSha !== publication.remoteSha ||
    !/^[0-9a-f]{40}$/.test(publication.headSha || "")
  ) {
    throw new CrewdeckError("Durable publication identity is missing or inconsistent", "invalid_publication_identity");
  }

  const journalResult = await readCandidateJournal(record);
  if (!journalResult.available) {
    throw new CrewdeckError(journalResult.error || "Candidate journal is missing", "missing_candidate");
  }
  const candidate = journalResult.journal.candidates.at(-1);
  if (
    !candidate ||
    candidate.head !== publication.headSha ||
    record.candidateCollectedVersion !== candidate.version
  ) {
    throw new CrewdeckError("Published approved SHA is not the latest collected candidate", "stale_candidate", {
      publishedHead: publication.headSha,
      candidateHead: candidate?.head,
      candidateVersion: candidate?.version,
      collectedVersion: record.candidateCollectedVersion,
    });
  }
  const approvals = (record.reviewInbox || []).filter((item) =>
    item.reviewedHead === candidate.head &&
    item.candidateVersion === candidate.version &&
    item.verdict === "approved" &&
    item.validAtCollection === true
  );
  if (approvals.length !== 1) {
    throw new CrewdeckError("Published candidate does not have one exact durable approval", "ambiguous_approval", {
      matches: approvals.length,
    });
  }
  const approval = approvals[0];
  validatedVerdictPayload(id, candidate, approval);
  const reviewRecord = state.tasks[approval.reviewTaskId];
  const reviewResult = reviewRecord ? await readTaskReport(reviewRecord) : { available: false };
  if (
    !reviewRecord ||
    reviewRecord.contract !== "review" ||
    reviewRecord.parentTaskId !== id ||
    reviewRecord.reviewedHead !== candidate.head ||
    reviewRecord.candidateVersion !== candidate.version ||
    !reviewRecord.resultCollectedAt ||
    !reviewResult.available ||
    reviewResult.report.payload?.verdict !== "approved" ||
    reviewResult.report.payload?.parentTaskId !== id ||
    reviewResult.report.payload?.reviewedHead !== candidate.head ||
    reviewResult.report.payload?.summary !== approval.summary ||
    JSON.stringify(reviewResult.report.payload?.findings) !== JSON.stringify(approval.findings) ||
    JSON.stringify(reviewResult.report.payload?.checks) !== JSON.stringify(approval.checks) ||
    JSON.stringify(reviewResult.report.payload?.openQuestions) !== JSON.stringify(approval.openQuestions)
  ) {
    throw new CrewdeckError("Exact durable reviewer evidence is missing or inconsistent", "invalid_approval_evidence");
  }
  if (record.reviewEscalation?.reviewedHead === candidate.head) {
    throw new CrewdeckError("Published candidate has unresolved review escalation", "review_not_approved");
  }

  const hasVerdictJournal = Object.hasOwn(publication, "verdictComments");
  let verdictEvidence;
  if (!hasVerdictJournal) {
    // Publications completed by a process that loaded the pre-verdict implementation
    // have no journal at all. Absence is distinct from any present, incomplete intent.
    verdictEvidence = {
      status: "legacy-absent",
      headSha: candidate.head,
      candidateVersion: candidate.version,
      reviewerTaskId: approval.reviewTaskId,
    };
  } else {
    const verdicts = publication.verdictComments;
    if (
      !Array.isArray(verdicts) ||
      verdicts.length === 0 ||
      verdicts.some((item) => {
        if (
          item?.status !== "published" ||
          !/^[0-9a-f]{40}$/.test(item.headSha || "") ||
          item.marker !== `<!-- crewdeck-verdict:${id}:${item.headSha} -->` ||
          item.prNumber !== publication.number ||
          !Number.isInteger(item.candidateVersion) ||
          !TASK_ID_RE.test(item.reviewerTaskId || "") ||
          !/^[0-9a-f]{64}$/.test(item.contentSha256 || "") ||
          !Number.isInteger(item.comment?.id) ||
          item.comment.id < 1 ||
          !exactIssueCommentUrl(item.comment?.url, publication.repo, publication.number, item.comment?.id)
        ) {
          return true;
        }
        const intentCandidate = journalResult.journal.candidates.find((entry) =>
          entry.head === item.headSha && entry.version === item.candidateVersion
        );
        const intentApprovals = (record.reviewInbox || []).filter((entry) =>
          entry.reviewTaskId === item.reviewerTaskId &&
          entry.reviewedHead === item.headSha &&
          entry.candidateVersion === item.candidateVersion &&
          entry.verdict === "approved" &&
          entry.validAtCollection === true
        );
        if (!intentCandidate || intentApprovals.length !== 1) return true;
        try {
          const rendered = renderVerdictComment(id, intentCandidate, intentApprovals[0]);
          return item.marker !== rendered.marker || item.contentSha256 !== rendered.contentSha256;
        } catch {
          return true;
        }
      }) ||
      new Set(verdicts.map((item) => item.headSha)).size !== verdicts.length
    ) {
      throw new CrewdeckError("Durable publication is missing or ambiguous", "ambiguous_publication");
    }
    const matchingVerdicts = verdicts.filter((item) =>
      item.headSha === candidate.head &&
      item.candidateVersion === candidate.version &&
      item.reviewerTaskId === approval.reviewTaskId
    );
    if (matchingVerdicts.length !== 1) {
      throw new CrewdeckError("Approved candidate has no unique published verdict", "ambiguous_publication", {
        matches: matchingVerdicts.length,
      });
    }
    const [matchingVerdict] = matchingVerdicts;
    verdictEvidence = {
      status: "published",
      headSha: matchingVerdict.headSha,
      candidateVersion: matchingVerdict.candidateVersion,
      reviewerTaskId: matchingVerdict.reviewerTaskId,
      marker: matchingVerdict.marker,
      contentSha256: matchingVerdict.contentSha256,
      comment: { ...matchingVerdict.comment },
    };
  }
  let remoteUrl;
  try {
    remoteUrl = (await git(record.repo, ["remote", "get-url", "--push", publication.remote])).stdout;
  } catch (error) {
    throw new CrewdeckError(`Git remote '${publication.remote}' is unavailable`, "remote_unavailable", {
      error: error.message,
    });
  }
  const remoteRepo = githubRepositoryFromUrl(remoteUrl);
  if (!remoteRepo || remoteRepo.toLowerCase() !== publication.repo.toLowerCase()) {
    throw new CrewdeckError("Durable publication remote and GitHub repository differ", "remote_repo_mismatch", {
      remoteUrl,
      repo: publication.repo,
    });
  }
  let forgeRepo;
  try {
    forgeRepo = await runJson("gh", ["repo", "view", publication.repo, "--json", "nameWithOwner"], {
      timeout: 20_000,
    });
  } catch (error) {
    throw new CrewdeckError("GitHub repository is unavailable through gh", "forge_unavailable", {
      error: error.message,
    });
  }
  if (forgeRepo?.nameWithOwner?.toLowerCase() !== publication.repo.toLowerCase()) {
    throw new CrewdeckError("gh resolved a different GitHub repository", "forge_repo_mismatch", forgeRepo);
  }

  const prFields = [
    "number", "url", "state", "isDraft", "headRefName", "baseRefName", "headRefOid",
    "isCrossRepository", "headRepository", "headRepositoryOwner", "mergeCommit", "mergedAt",
  ].join(",");
  let pr;
  try {
    pr = await runJson("gh", [
      "pr", "view", String(publication.number), "--repo", publication.repo, "--json", prFields,
    ], { timeout: 20_000 });
  } catch (error) {
    throw new CrewdeckError("Stored GitHub PR is unavailable", "forge_unavailable", { error: error.message });
  }
  const mergeCommit = pr?.mergeCommit?.oid;
  if (
    pr?.number !== publication.number ||
    pr?.url !== publication.url ||
    !exactPullRequestUrl(pr?.url, publication.repo, publication.number) ||
    pr?.state !== "MERGED" ||
    pr?.isDraft !== false ||
    pr?.headRefName !== publication.remoteHead ||
    pr?.baseRefName !== publication.base ||
    pr?.headRefOid !== candidate.head ||
    pr?.isCrossRepository !== false ||
    !exactHeadRepository(pr?.headRepository, pr?.headRepositoryOwner, publication.repo) ||
    !/^[0-9a-f]{40}$/.test(mergeCommit || "") ||
    typeof pr?.mergedAt !== "string" ||
    Number.isNaN(Date.parse(pr.mergedAt))
  ) {
    throw new CrewdeckError("GitHub PR is not the exact merged publication", "pull_request_not_merged", pr);
  }
  const mergedChecks = await inspectGitHubChecks(project, publication.repo, candidate.head);
  publication.checks = mergedChecks;
  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (!stored?.publication || stored.publication.number !== publication.number || stored.publication.headSha !== candidate.head) {
      throw new CrewdeckError("Publication changed before merged checks persistence", "state_changed");
    }
    stored.publication.checks = mergedChecks;
    await saveState(next);
  });
  requirePassingChecks(mergedChecks, "merged reconciliation");

  if (verdictEvidence.status === "legacy-absent") {
    const rendered = renderVerdictComment(id, candidate, approval);
    const untrackedVerdict = await findVerdictComment(
      publication.repo,
      publication.number,
      rendered.marker,
      rendered.body,
    );
    if (untrackedVerdict) {
      throw new CrewdeckError(
        "Legacy publication has an untracked GitHub verdict comment",
        "ambiguous_publication",
        { prNumber: publication.number, marker: rendered.marker },
      );
    }
    verdictEvidence.verifiedAt = new Date().toISOString();
  }

  const localBaseBefore = (await git(record.repo, ["rev-parse", record.base])).stdout;
  const remoteBaseSha = await remoteBranchSha(record.repo, publication.remote, publication.base);
  try {
    await git(record.repo, [
      "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", publication.remote,
      `refs/heads/${publication.base}`,
    ], { timeout: 120_000 });
  } catch (error) {
    throw new CrewdeckError("Cannot fetch remote base evidence without updating refs", "containment_unavailable", {
      error: error.message,
    });
  }
  if ((await git(record.repo, ["rev-parse", record.base])).stdout !== localBaseBefore) {
    throw new CrewdeckError("Containment fetch unexpectedly changed the local base", "base_changed");
  }
  try {
    await git(record.repo, [
      "fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", publication.remote, mergeCommit,
    ], { timeout: 120_000 });
  } catch {
    // Some forges refuse fetching an exact SHA. The advertised remote base may
    // still supply either the merge object or independent containment proof.
  }
  const [mergeProof, baseProof] = await Promise.all([
    gitAncestorProof(record.repo, candidate.head, mergeCommit),
    gitAncestorProof(record.repo, candidate.head, remoteBaseSha),
  ]);
  if (!mergeProof.ancestor && !baseProof.ancestor) {
    throw new CrewdeckError(
      "Approved candidate is not proven contained in the PR merge commit or current remote base",
      "approved_sha_not_contained",
      { candidate: candidate.head, mergeCommit, remoteBaseSha, mergeProof, baseProof },
    );
  }

  const agent = await liveAgent(record);
  if (agent.available && !["idle", "done"].includes(agent.state)) {
    throw new CrewdeckError(`Worker is ${agent.state}; reconciliation requires a settled writer`, "worker_not_settled");
  }
  if (!agent.available && !provenMissingAgent(agent)) {
    throw new CrewdeckError("Cannot prove build writer state", "agent_state_unknown", agent);
  }

  const snapshot = await gitSnapshot(record);
  if (snapshot.available) {
    const branch = (await git(record.worktree, ["branch", "--show-current"])).stdout;
    if (!snapshot.clean) {
      throw new CrewdeckError("Worktree is dirty; reconciliation never discards uncommitted data", "dirty_worktree", snapshot);
    }
    if (snapshot.head !== candidate.head || branch !== record.branch) {
      throw new CrewdeckError("Worktree no longer matches the latest approved candidate", "stale_candidate", {
        snapshot,
        branch,
      });
    }
  } else {
    let worktreeMissing = false;
    try {
      await stat(record.worktree);
    } catch (error) {
      if (error.code === "ENOENT") worktreeMissing = true;
      else throw error;
    }
    const priorProof = record.mergeReconciliation?.evidence?.worktree;
    if (
      !recovery ||
      !worktreeMissing ||
      priorProof?.clean !== true ||
      priorProof?.head !== candidate.head ||
      priorProof?.branch !== record.branch
    ) {
      throw new CrewdeckError("Cannot prove the build worktree clean", "worktree_state_unknown", snapshot);
    }
  }

  const branchRef = `refs/heads/${record.branch}`;
  let branchSha;
  try {
    branchSha = (await git(record.repo, ["rev-parse", "--verify", branchRef])).stdout;
  } catch (error) {
    if (!recovery) {
      throw new CrewdeckError("Owned build branch is missing", "missing_branch", { error: error.message });
    }
  }
  if (branchSha && branchSha !== candidate.head) {
    throw new CrewdeckError("Owned branch contains a newer or different candidate", "stale_candidate", {
      expected: candidate.head,
      actual: branchSha,
    });
  }

  const publicationFingerprint = JSON.stringify(publication);
  const reviewFingerprint = JSON.stringify(record.reviewInbox);
  const expectedPriorOperationId = record.mergeReconciliation?.operationId;
  const operationId = randomBytes(12).toString("hex");
  const startedAt = record.mergeReconciliation?.startedAt || new Date().toISOString();
  const proofAt = new Date().toISOString();
  const evidence = {
    pr: {
      repo: publication.repo,
      number: publication.number,
      url: publication.url,
      base: publication.base,
      head: publication.remoteHead,
      state: "MERGED",
      mergeCommit,
      mergedAt: pr.mergedAt,
    },
    candidate: {
      sha: candidate.head,
      version: candidate.version,
      reviewerTaskId: approval.reviewTaskId,
    },
    verdict: verdictEvidence,
    containment: {
      remoteBaseSha,
      mergeCommit,
      candidateAncestorOfMergeCommit: mergeProof.ancestor,
      candidateAncestorOfRemoteBase: baseProof.ancestor,
      verifiedAt: proofAt,
    },
    remote: { name: publication.remote, url: remoteUrl, repo: publication.repo },
    agent: { state: agent.state, available: agent.available },
    worktree: { clean: true, head: candidate.head, branch: record.branch, verifiedAt: proofAt },
  };

  await withStateLock(async () => {
    const next = await loadState();
    const stored = next.tasks[id];
    if (
      !stored ||
      stored.status !== "running" ||
      stored.cleanedAt ||
      stored.resumeReservation ||
      JSON.stringify(stored.publication) !== publicationFingerprint ||
      stored.candidateCollectedVersion !== candidate.version ||
      JSON.stringify(stored.reviewInbox) !== reviewFingerprint ||
      stored.mergeReconciliation?.operationId !== expectedPriorOperationId
    ) {
      throw new CrewdeckError("Task state changed before reconciliation cleanup", "state_changed");
    }
    stored.mergeReconciliation = {
      status: "cleanup-pending",
      operationId,
      startedAt,
      lastAttemptAt: proofAt,
      attempts: (stored.mergeReconciliation?.attempts || 0) + 1,
      fromStatus: "running",
      evidence,
    };
    await saveState(next);
  });

  const recordFailure = async (error) => {
    try {
      await withStateLock(async () => {
        const next = await loadState();
        const stored = next.tasks[id];
        if (stored?.status === "running" && stored.mergeReconciliation?.operationId === operationId) {
          stored.mergeReconciliation.status = "cleanup-failed";
          stored.mergeReconciliation.failedAt = new Date().toISOString();
          stored.mergeReconciliation.lastError = error.message;
          stored.mergeReconciliation.lastErrorCode = error.code || "cleanup_failed";
          await saveState(next);
        }
      });
    } catch {
      // Preserve the original cleanup failure; a reservation still prevents a false terminal state.
    }
  };

  try {
    const closingAgent = await liveAgent(record);
    if (closingAgent.available && !["idle", "done"].includes(closingAgent.state)) {
      throw new CrewdeckError(`Worker became ${closingAgent.state} before cleanup`, "worker_not_settled");
    }
    if (!closingAgent.available && !provenMissingAgent(closingAgent)) {
      throw new CrewdeckError("Build writer state became unknown before cleanup", "agent_state_unknown", closingAgent);
    }
    if (closingAgent.available) {
      try {
        await run("herdr", ["agent", "send-keys", record.agentName, "ctrl+d"], { timeout: 10_000 });
      } catch (error) {
        if (closingAgent.state !== "done") {
          throw new CrewdeckError("Cannot close the settled build agent", "agent_cleanup_failed", {
            error: error.message,
          });
        }
        // A done agent may already have exited its pane. Removing the proven
        // isolated workspace remains the closing authority.
      }
    }

    const beforeCleanupState = await loadState();
    const beforeCleanupRecord = beforeCleanupState.tasks[id];
    const latestJournal = await readCandidateJournal(beforeCleanupRecord || record);
    const latestCandidate = latestJournal.available ? latestJournal.journal.candidates.at(-1) : undefined;
    const beforeCleanupSnapshot = await gitSnapshot(record);
    if (
      beforeCleanupRecord?.status !== "running" ||
      beforeCleanupRecord?.mergeReconciliation?.operationId !== operationId ||
      JSON.stringify(beforeCleanupRecord.publication) !== publicationFingerprint ||
      beforeCleanupRecord.candidateCollectedVersion !== candidate.version ||
      JSON.stringify(beforeCleanupRecord.reviewInbox) !== reviewFingerprint ||
      latestCandidate?.head !== candidate.head ||
      latestCandidate?.version !== candidate.version ||
      (beforeCleanupSnapshot.available &&
        (!beforeCleanupSnapshot.clean || beforeCleanupSnapshot.head !== candidate.head)) ||
      (!beforeCleanupSnapshot.available && !recovery)
    ) {
      throw new CrewdeckError("Candidate or durable state changed before cleanup", "state_changed");
    }
    if (await remoteBranchSha(record.repo, publication.remote, publication.base) !== remoteBaseSha) {
      throw new CrewdeckError("Remote base changed before cleanup; retry containment verification", "remote_base_changed");
    }

    let worktreeExists = true;
    try {
      await stat(record.worktree);
    } catch (error) {
      if (error.code === "ENOENT") worktreeExists = false;
      else throw error;
    }
    if (worktreeExists) {
      try {
        await runJson("herdr", ["worktree", "remove", "--workspace", record.workspaceId], {
          timeout: 30_000,
        });
      } catch (error) {
        throw new CrewdeckError("Cannot remove the isolated Herdr worktree", "worktree_cleanup_failed", {
          error: error.message,
        });
      }
    } else {
      const workspaceAbsent = await missingWorkspace(record);
      if (!workspaceAbsent) {
        try {
          await runJson("herdr", ["workspace", "close", record.workspaceId], { timeout: 15_000 });
        } catch (error) {
          throw new CrewdeckError("Cannot close the residual Herdr workspace", "workspace_cleanup_failed", {
            error: error.message,
          });
        }
      }
    }
    if (!(await missingWorkspace(record))) {
      throw new CrewdeckError("Herdr workspace still exists after cleanup", "workspace_cleanup_failed");
    }
    try {
      await stat(record.worktree);
      throw new CrewdeckError("Isolated worktree path still exists after cleanup", "worktree_cleanup_failed");
    } catch (error) {
      if (error instanceof CrewdeckError) throw error;
      if (error.code !== "ENOENT") throw error;
    }

    let worktrees = await listedWorktrees(record.repo);
    const registration = worktrees.find((item) => path.resolve(item.worktree) === path.resolve(record.worktree));
    if (registration) {
      if (!recovery || registration.branch !== branchRef) {
        throw new CrewdeckError("Unexpected Git worktree registration survived cleanup", "unsafe_git_metadata", registration);
      }
      await git(record.repo, ["worktree", "remove", "--force", record.worktree]);
      worktrees = await listedWorktrees(record.repo);
    }
    const otherCheckout = worktrees.find((item) => item.branch === branchRef);
    if (otherCheckout) {
      throw new CrewdeckError("Owned branch is checked out in another worktree", "unsafe_git_metadata", otherCheckout);
    }

    let currentBranchSha;
    try {
      currentBranchSha = (await git(record.repo, ["rev-parse", "--verify", branchRef])).stdout;
    } catch {
      currentBranchSha = undefined;
    }
    if (currentBranchSha && currentBranchSha !== candidate.head) {
      throw new CrewdeckError("Owned branch changed during cleanup and was preserved", "stale_candidate", {
        expected: candidate.head,
        actual: currentBranchSha,
      });
    }
    if (currentBranchSha) {
      await git(record.repo, ["update-ref", "-d", branchRef, candidate.head]);
    }
    try {
      await git(record.repo, ["rev-parse", "--verify", branchRef]);
      throw new CrewdeckError("Owned branch still exists after exact deletion", "branch_cleanup_failed");
    } catch (error) {
      if (error instanceof CrewdeckError && error.code === "branch_cleanup_failed") throw error;
      if (error.code !== "command_failed") throw error;
    }

    const afterAgent = await liveAgent(record);
    if (!provenMissingAgent(afterAgent) && !(afterAgent.available && afterAgent.state === "done")) {
      throw new CrewdeckError("Build agent did not close with its workspace", "agent_cleanup_failed", afterAgent);
    }

    const reconciledAt = new Date().toISOString();
    let reconciled;
    await withStateLock(async () => {
      const next = await loadState();
      const stored = next.tasks[id];
      if (
        stored?.status !== "running" ||
        stored.mergeReconciliation?.operationId !== operationId ||
        JSON.stringify(stored.publication) !== publicationFingerprint ||
        stored.candidateCollectedVersion !== candidate.version ||
        JSON.stringify(stored.reviewInbox) !== reviewFingerprint
      ) {
        throw new CrewdeckError("Task state changed after cleanup; terminal transition refused", "state_changed");
      }
      stored.status = "pr-merged";
      stored.prMergedAt = pr.mergedAt;
      stored.mergedReconciledAt = reconciledAt;
      stored.mergeReconciliation = {
        ...stored.mergeReconciliation,
        status: "merged-reconciled",
        reconciledAt,
        cleanup: {
          agentClosedAt: reconciledAt,
          workspaceClosedAt: reconciledAt,
          worktreeRemovedAt: reconciledAt,
          branchDeletedAt: reconciledAt,
        },
      };
      delete stored.error;
      reconciled = { ...stored };
      await saveState(next);
    });
    return mergedReconciliationResult(reconciled, false);
  } catch (error) {
    await recordFailure(error);
    throw error;
  }
}

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
