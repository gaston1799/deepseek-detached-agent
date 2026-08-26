import { createWriteStream, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { registerArtifactFile, taskRoot } from "./artifacts.js";

export const SANDBOX_ENVIRONMENTS = {
  "linux-general": { image: "dsw/linux-general:latest", cpu: 2, memory_mb: 2048, timeout_ms: 120000, network: "none", capabilities: [] },
  "linux-re": { image: "dsw/linux-re:latest", cpu: 4, memory_mb: 4096, timeout_ms: 300000, network: "none", capabilities: [] },
  "web-testing": { image: "dsw/web-testing:latest", cpu: 2, memory_mb: 2048, timeout_ms: 120000, network: "allowlisted", capabilities: [] },
  fuzzing: { image: "dsw/fuzzing:latest", cpu: 2, memory_mb: 4096, timeout_ms: 300000, network: "none", capabilities: [] },
  "network-analysis": { image: "dsw/network-analysis:latest", cpu: 2, memory_mb: 2048, timeout_ms: 120000, network: "none", capabilities: ["NET_ADMIN", "NET_RAW"] },
  "android-tools": { image: "dsw/android-tools:latest", cpu: 4, memory_mb: 4096, timeout_ms: 300000, network: "none", capabilities: [] }
};

const MAX_PREVIEW = 12000;
const MAX_TOTAL = 24000;
let cachedDockerCpuLimit = null;
let cachedDockerBin = null;

// On Windows, PATH usually contains both an extensionless `docker` (a bash
// script) and `docker.exe`. Node's spawn() may pick the script and fail with
// `spawn UNKNOWN` (errno -4094). Resolve the real .exe explicitly.
function dockerExecutable() {
  if (cachedDockerBin) return cachedDockerBin;
  if (process.platform !== "win32") { cachedDockerBin = "docker"; return cachedDockerBin; }
  const candidates = [
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    "C:\\Program Files\\Docker\\Docker\\resources\\cli-plugins\\docker.exe",
    process.env["ProgramFiles"] ? `${process.env["ProgramFiles"]}\\Docker\\Docker\\resources\\bin\\docker.exe` : null,
  ].filter(Boolean);
  for (const c of candidates) {
    if (existsSync(c)) { cachedDockerBin = c; return cachedDockerBin; }
  }
  // Fall back to PATH resolution via where.exe.
  try {
    const res = spawnSync("where.exe", ["docker.exe"], { encoding: "utf8", windowsHide: true });
    if (res.status === 0 && res.stdout) {
      const first = String(res.stdout).split(/\r?\n/).map((s) => s.trim()).find((s) => /docker\.exe$/i.test(s) && s.length);
      if (first) { cachedDockerBin = first; return cachedDockerBin; }
    }
  } catch { /* keep default */ }
  cachedDockerBin = "docker.exe";
  return cachedDockerBin;
}

function profile(name) {
  const value = String(name || "linux-general");
  if (!SANDBOX_ENVIRONMENTS[value]) throw new Error(`Unknown sandbox environment: ${value}`);
  return { name: value, ...SANDBOX_ENVIRONMENTS[value] };
}

function cap(value, max = MAX_PREVIEW) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function docker(args, { timeoutMs = 120000, input = "", outputDir, outputPrefix = "docker" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const dockerBin = dockerExecutable();
    const child = spawn(dockerBin, args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let stdoutChars = 0; let stderrChars = 0; let settled = false;
    const stdoutFile = outputDir ? join(outputDir, `${outputPrefix}.stdout.log`) : null;
    const stderrFile = outputDir ? join(outputDir, `${outputPrefix}.stderr.log`) : null;
    const stdoutStream = stdoutFile ? createWriteStream(stdoutFile, { encoding: "utf8" }) : null;
    const stderrStream = stderrFile ? createWriteStream(stderrFile, { encoding: "utf8" }) : null;
    const closeStream = (stream) => stream ? new Promise((resolve) => { stream.once("close", resolve); stream.end(); }) : Promise.resolve();
    const finish = async (result) => { if (settled) return; settled = true; clearTimeout(timer); await Promise.all([closeStream(stdoutStream), closeStream(stderrStream)]); resolvePromise({ ...result, stdout_file: stdoutFile, stderr_file: stderrFile, stdout_chars: stdoutChars, stderr_chars: stderrChars }); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ code: null, timed_out: true, stdout: cap(stdout), stderr: cap(stderr) }); }, Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdoutChars += chunk.length; stdoutStream?.write(chunk); if (stdout.length < MAX_PREVIEW) stdout += chunk.slice(0, MAX_PREVIEW - stdout.length); });
    child.stderr.on("data", (chunk) => { stderrChars += chunk.length; stderrStream?.write(chunk); if (stderr.length < MAX_PREVIEW) stderr += chunk.slice(0, MAX_PREVIEW - stderr.length); });
    child.on("error", (error) => { if (!settled) reject(error); });
    child.on("close", (code) => finish({ code, timed_out: false, stdout: cap(stdout), stderr: cap(stderr) }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function containerName(taskId, environment) {
  return `dsw-${String(taskId || "task").replace(/[^A-Za-z0-9_.-]/g, "-")}-${environment}-${Date.now()}`.slice(0, 120);
}

function capabilityArgs(p) { return (p.capabilities || []).flatMap((capability) => ["--cap-add", capability]); }

function parseContainers(text) {
  return String(text || "").trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const [id, name, status, task, environment, persistence] = line.split("\t");
    return { id, name, status, task, environment, persistence };
  });
}

async function ensureTaskWorkspace(cwd, taskId) {
  const root = taskRoot(cwd, taskId);
  await mkdir(root, { recursive: true });
  for (const dir of ["input", "output", "tmp", "captures", "logs", "crashes", "extracted", "reports", "artifacts"]) await mkdir(`${root}/${dir}`, { recursive: true });
  return root;
}

function outputResult(result) {
  const stdout = cap(result.stdout); const stderr = cap(result.stderr);
  const totalChars = Number(result.stdout_chars || stdout.length) + Number(result.stderr_chars || stderr.length);
  return { ...result, stdout, stderr, truncated: totalChars > MAX_TOTAL || stdout.length >= MAX_PREVIEW || stderr.length >= MAX_PREVIEW, stdout_limit: MAX_PREVIEW, stderr_limit: MAX_PREVIEW, total_limit: MAX_TOTAL };
}

async function dockerCpuLimit() {
  if (cachedDockerCpuLimit !== null) return cachedDockerCpuLimit;
  try {
    const result = await docker(["info", "--format", "{{.NCPU}}"], { timeoutMs: 10000 });
    const value = Number.parseFloat(String(result.stdout || "").trim());
    cachedDockerCpuLimit = Number.isFinite(value) && value > 0 ? value : Infinity;
  } catch { cachedDockerCpuLimit = Infinity; }
  return cachedDockerCpuLimit;
}

export async function sandboxExecute({ cwd = process.cwd(), taskId = "task", environment = "linux-general", command, timeoutMs, workingDirectory = "/workspace", cpu, memoryMb, networkPolicy, persistence = "ephemeral", env = {} }) {
  const p = profile(environment);
  if (!String(command || "").trim()) throw new Error("sandbox command is required.");
  const taskWorkspace = await ensureTaskWorkspace(cwd, taskId);
  const name = containerName(taskId, p.name);
  const requestedCpu = Number(cpu || p.cpu);
  const effectiveCpu = Math.min(requestedCpu, await dockerCpuLimit());
  const network = networkPolicy || p.network;
  if (!['none', 'allowlisted'].includes(network)) throw new Error("network_policy must be none or allowlisted.");
  const runArgs = ["run", "-d", "--name", name, "--label", `dsw.task=${taskId}`, "--label", `dsw.environment=${p.name}`, "--label", `dsw.persistence=${persistence}`, "--label", `dsw.ephemeral=${persistence !== "persistent"}`, "--cpus", String(effectiveCpu), "--memory", `${Number(memoryMb || p.memory_mb)}m`, "--network", network === "none" ? "none" : "bridge", ...capabilityArgs(p), "-v", `${taskWorkspace}:/workspace`, "-w", workingDirectory || "/workspace"];
  for (const [key, value] of Object.entries(env || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) runArgs.push("-e", `${key}=${String(value)}`);
  runArgs.push(p.image, "sleep", "infinity");
  const logDir = join(taskWorkspace, "logs");
  const created = await docker(runArgs, { timeoutMs: 30000, outputDir: logDir, outputPrefix: `${name}-create` });
  if (created.code !== 0) return outputResult({ ok: false, phase: "create", container: name, environment: p.name, ...created });
  const timeout = timeoutMs || p.timeout_ms;
  const result = await docker(["exec", "-w", workingDirectory || "/workspace", name, "sh", "-lc", String(command)], { timeoutMs: timeout, outputDir: logDir, outputPrefix: name });
  const full = outputResult({ ok: result.code === 0 && !result.timed_out, phase: "execute", container: name, environment: p.name, command: String(command), timeout_ms: timeout, requested_cpu: requestedCpu, effective_cpu: effectiveCpu, ...result });
  if (result.stdout_file) full.stdout_artifact = await registerArtifactFile({ cwd, taskId, kind: "sandbox-stdout", name: `${name}.stdout.log`, file: result.stdout_file, metadata: { container: name, environment: p.name, complete: true } });
  if (result.stderr_file) full.stderr_artifact = await registerArtifactFile({ cwd, taskId, kind: "sandbox-stderr", name: `${name}.stderr.log`, file: result.stderr_file, metadata: { container: name, environment: p.name, complete: true } });
  if (persistence !== "persistent") await docker(["rm", "-f", name], { timeoutMs: 30000 });
  return full;
}

export async function sandboxOperation({ cwd = process.cwd(), taskId = "task", operation, environment, container, command, source, destination, timeoutMs = 30000 }) {
  const op = String(operation || "").toLowerCase();
  if (op === "list_environments") return Object.entries(SANDBOX_ENVIRONMENTS).map(([name, value]) => ({ name, ...value }));
  if (op === "list_containers") {
    const result = await docker(["ps", "-a", "--filter", "label=dsw.task", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Label \"dsw.task\"}}\t{{.Label \"dsw.environment\"}}\t{{.Label \"dsw.persistence\"}}"], { timeoutMs });
    return { ...outputResult(result), containers: parseContainers(result.stdout) };
  }
  if (op === "cleanup_orphans") {
    const listed = await docker(["ps", "-aq", "--filter", "label=dsw.ephemeral=true"], { timeoutMs });
    const ids = String(listed.stdout || "").trim().split(/\s+/).filter(Boolean);
    if (!ids.length) return { operation: op, removed: [], stdout: "", stderr: "", truncated: false };
    const removed = await docker(["rm", "-f", ...ids], { timeoutMs });
    return { operation: op, removed: ids, ...outputResult(removed) };
  }
  if (!["create", "inspect", "stop", "destroy", "exec", "copy_in", "copy_out", "logs"].includes(op)) throw new Error("operation must be create, exec, copy_in, copy_out, inspect, logs, stop, destroy, cleanup_orphans, list_environments, or list_containers.");
  if (op === "create") {
    const p = profile(environment); const root = await ensureTaskWorkspace(cwd, taskId); const name = container || containerName(taskId, p.name);
    const requestedCpu = Number(p.cpu); const effectiveCpu = Math.min(requestedCpu, await dockerCpuLimit());
    const result = await docker(["run", "-d", "--name", name, "--label", `dsw.task=${taskId}`, "--label", `dsw.environment=${p.name}`, "--label", "dsw.persistence=persistent", "--label", "dsw.ephemeral=false", "--cpus", String(effectiveCpu), "--memory", `${Number(p.memory_mb)}m`, "--network", p.network === "none" ? "none" : "bridge", ...capabilityArgs(p), "-v", `${root}:/workspace`, "-w", "/workspace", p.image, "sleep", "infinity"], { timeoutMs });
    return { operation: op, container: name, environment: p.name, requested_cpu: requestedCpu, effective_cpu: effectiveCpu, ...result };
  }
  if (!container) throw new Error("container is required.");
  const args = op === "inspect" ? ["inspect", container] : op === "stop" ? ["stop", container] : op === "destroy" ? ["rm", "-f", container] : op === "logs" ? ["logs", "--tail", "200", container] : op === "exec" ? ["exec", container, "sh", "-lc", String(command || "")] : op === "copy_in" ? ["cp", String(source), `${container}:/workspace/${String(destination || "")}`] : ["cp", `${container}:/workspace/${String(source || "")}`, String(destination)];
  return { operation: op, container, ...await docker(args, { timeoutMs }) };
}
