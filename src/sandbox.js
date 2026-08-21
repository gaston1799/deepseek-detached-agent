import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { taskRoot, writeArtifact } from "./artifacts.js";

export const SANDBOX_ENVIRONMENTS = {
  "linux-general": { image: "dsw/linux-general:latest", cpu: 2, memory_mb: 2048, timeout_ms: 120000, network: "none", capabilities: [] },
  "linux-re": { image: "dsw/linux-re:latest", cpu: 4, memory_mb: 4096, timeout_ms: 300000, network: "none", capabilities: [] },
  "web-testing": { image: "dsw/web-testing:latest", cpu: 2, memory_mb: 2048, timeout_ms: 120000, network: "allowlisted", capabilities: [] },
  fuzzing: { image: "dsw/fuzzing:latest", cpu: 2, memory_mb: 4096, timeout_ms: 300000, network: "none", capabilities: [] },
  "network-analysis": { image: "dsw/network-analysis:latest", cpu: 2, memory_mb: 2048, timeout_ms: 120000, network: "none", capabilities: [] },
  "android-tools": { image: "dsw/android-tools:latest", cpu: 4, memory_mb: 4096, timeout_ms: 300000, network: "none", capabilities: [] }
};

const MAX_PREVIEW = 12000;
const MAX_TOTAL = 24000;

function profile(name) {
  const value = String(name || "linux-general");
  if (!SANDBOX_ENVIRONMENTS[value]) throw new Error(`Unknown sandbox environment: ${value}`);
  return { name: value, ...SANDBOX_ENVIRONMENTS[value] };
}

function cap(value, max = MAX_PREVIEW) {
  const text = String(value || "");
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

function docker(args, { timeoutMs = 120000, input = "" } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", args, { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); resolvePromise(result); };
    const timer = setTimeout(() => { try { child.kill(); } catch {} finish({ code: null, timed_out: true, stdout: cap(stdout), stderr: cap(stderr) }); }, Math.min(Math.max(Number(timeoutMs) || 120000, 1000), 600000));
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > MAX_TOTAL) stdout = stdout.slice(0, MAX_TOTAL); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > MAX_TOTAL) stderr = stderr.slice(0, MAX_TOTAL); });
    child.on("error", (error) => { if (!settled) reject(error); });
    child.on("close", (code) => finish({ code, timed_out: false, stdout: cap(stdout), stderr: cap(stderr) }));
    if (input) child.stdin.write(input);
    child.stdin.end();
  });
}

function containerName(taskId, environment) {
  return `dsw-${String(taskId || "task").replace(/[^A-Za-z0-9_.-]/g, "-")}-${environment}-${Date.now()}`.slice(0, 120);
}

async function ensureTaskWorkspace(cwd, taskId) {
  const root = taskRoot(cwd, taskId);
  await mkdir(root, { recursive: true });
  for (const dir of ["input", "output", "tmp", "captures", "logs", "crashes", "extracted", "reports", "artifacts"]) await mkdir(`${root}/${dir}`, { recursive: true });
  return root;
}

function outputResult(result) {
  const stdout = cap(result.stdout); const stderr = cap(result.stderr);
  const combined = `${stdout}\n${stderr}`;
  return { ...result, stdout, stderr, truncated: combined.length >= MAX_TOTAL, stdout_limit: MAX_PREVIEW, stderr_limit: MAX_PREVIEW, total_limit: MAX_TOTAL };
}

export async function sandboxExecute({ cwd = process.cwd(), taskId = "task", environment = "linux-general", command, timeoutMs, workingDirectory = "/workspace", cpu, memoryMb, networkPolicy, persistence = "ephemeral", env = {} }) {
  const p = profile(environment);
  if (!String(command || "").trim()) throw new Error("sandbox command is required.");
  const taskWorkspace = await ensureTaskWorkspace(cwd, taskId);
  const name = containerName(taskId, p.name);
  const network = networkPolicy || p.network;
  if (!['none', 'allowlisted'].includes(network)) throw new Error("network_policy must be none or allowlisted.");
  const runArgs = ["run", "-d", "--name", name, "--label", `dsw.task=${taskId}`, "--label", `dsw.environment=${p.name}`, "--cpus", String(cpu || p.cpu), "--memory", `${Number(memoryMb || p.memory_mb)}m`, "--network", network === "none" ? "none" : "bridge", "-v", `${taskWorkspace}:/workspace`, "-w", workingDirectory || "/workspace"];
  for (const [key, value] of Object.entries(env || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) runArgs.push("-e", `${key}=${String(value)}`);
  runArgs.push(p.image, "sleep", "infinity");
  const created = await docker(runArgs, { timeoutMs: 30000 });
  if (created.code !== 0) return outputResult({ ok: false, phase: "create", container: name, environment: p.name, ...created });
  const timeout = timeoutMs || p.timeout_ms;
  const result = await docker(["exec", "-w", workingDirectory || "/workspace", name, "sh", "-lc", String(command)], { timeoutMs: timeout });
  const full = outputResult({ ok: result.code === 0 && !result.timed_out, phase: "execute", container: name, environment: p.name, command: String(command), timeout_ms: timeout, ...result });
  if (full.stdout || full.stderr) full.output_artifact = await writeArtifact({ cwd, taskId, kind: "sandbox-log", name: `${name}.log.txt`, data: `STDOUT\n${full.stdout}\nSTDERR\n${full.stderr}\n`, metadata: { container: name, environment: p.name, truncated: full.truncated } });
  if (persistence !== "persistent") await docker(["rm", "-f", name], { timeoutMs: 30000 });
  return full;
}

export async function sandboxOperation({ cwd = process.cwd(), taskId = "task", operation, environment, container, command, source, destination, timeoutMs = 30000 }) {
  const op = String(operation || "").toLowerCase();
  if (op === "list_environments") return Object.entries(SANDBOX_ENVIRONMENTS).map(([name, value]) => ({ name, ...value }));
  if (op === "list_containers") return docker(["ps", "-a", "--filter", "label=dsw.task", "--format", "{{.ID}}\t{{.Names}}\t{{.Status}}"], { timeoutMs });
  if (!["create", "inspect", "stop", "destroy", "exec", "copy_in", "copy_out", "logs"].includes(op)) throw new Error("operation must be create, exec, copy_in, copy_out, inspect, logs, stop, destroy, list_environments, or list_containers.");
  if (op === "create") {
    const p = profile(environment); const root = await ensureTaskWorkspace(cwd, taskId); const name = container || containerName(taskId, p.name);
    const result = await docker(["run", "-d", "--name", name, "--label", `dsw.task=${taskId}`, "--label", `dsw.environment=${p.name}`, "--network", p.network === "none" ? "none" : "bridge", "-v", `${root}:/workspace`, "-w", "/workspace", p.image, "sleep", "infinity"], { timeoutMs });
    return { operation: op, container: name, environment: p.name, ...result };
  }
  if (!container) throw new Error("container is required.");
  const args = op === "inspect" ? ["inspect", container] : op === "stop" ? ["stop", container] : op === "destroy" ? ["rm", "-f", container] : op === "logs" ? ["logs", "--tail", "200", container] : op === "exec" ? ["exec", container, "sh", "-lc", String(command || "")] : op === "copy_in" ? ["cp", String(source), `${container}:/workspace/${String(destination || "")}`] : ["cp", `${container}:/workspace/${String(source || "")}`, String(destination)];
  return { operation: op, container, ...await docker(args, { timeoutMs }) };
}
