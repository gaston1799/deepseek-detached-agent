import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getArtifact, registerArtifactFile, taskRoot } from "./artifacts.js";
import { sandboxExecute } from "./sandbox.js";
import { sandboxOperation } from "./sandbox.js";

function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }

async function pcapCommand({ cwd, taskId, artifact, command }) {
  const found = await getArtifact({ cwd, taskId, artifact });
  const relativeArtifact = found.record.path.replaceAll("\\", "/");
  const fullCommand = `tshark -r ${quote(`/workspace/${relativeArtifact}`)} ${command}`;
  return sandboxExecute({ cwd, taskId, environment: "network-analysis", command: fullCommand, timeoutMs: 120000, networkPolicy: "none" });
}

export async function netListInterfaces({ cwd = process.cwd(), taskId }) {
  return sandboxExecute({ cwd, taskId, environment: "network-analysis", command: "tshark -D", timeoutMs: 30000, networkPolicy: "none" });
}

export async function netProtocolSummary(options) { return pcapCommand({ ...options, command: "-q -z io,phs -c 10000" }); }
export async function netConversations(options) { return pcapCommand({ ...options, command: "-q -z conv,ip -c 10000" }); }
export async function netQueryPcap({ filter, fields, ...options }) {
  const display = filter ? `-Y ${quote(filter)}` : "";
  const projection = Array.isArray(fields) && fields.length ? `-T fields ${fields.map((field) => `-e ${quote(field)}`).join(" ")}` : "-T fields -e frame.number -e frame.protocols";
  return pcapCommand({ ...options, command: `${display} ${projection} -c 500` });
}
export async function netStreamSummary(options) { return pcapCommand({ ...options, command: "-q -z conv,tcp -c 10000" }); }
export async function netExtractFields(options) { return netQueryPcap(options); }

function captureStatePath(cwd, taskId) { return join(taskRoot(cwd, taskId), "captures.json"); }
async function captureState(cwd, taskId) {
  try { return JSON.parse(await readFile(captureStatePath(cwd, taskId), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { schema_version: 1, captures: {} }; throw error; }
}
async function saveCaptureState(cwd, taskId, value) { await writeFile(captureStatePath(cwd, taskId), `${JSON.stringify(value, null, 2)}\n`, "utf8"); }
function safeCaptureName(value) { return String(value || `capture-${Date.now()}`).replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 80); }

export async function netCaptureStart({ cwd = process.cwd(), taskId, interface: iface, durationSeconds = 60, maxFileMb = 50, ringFiles = 2, name }) {
  if (!/^[A-Za-z0-9_.:-]+$/.test(String(iface || ""))) throw new Error("interface must contain only letters, digits, dot, underscore, colon, or dash.");
  const interfaces = await netListInterfaces({ cwd, taskId });
  if (!interfaces.ok) throw new Error(`Unable to enumerate capture interfaces: ${interfaces.stderr || interfaces.stdout}`);
  const available = String(interfaces.stdout || "").split(/\r?\n/).map((line) => line.match(/^\d+\.\s+([^\s(]+)/)?.[1]).filter(Boolean);
  if (!available.includes(String(iface))) throw new Error(`Capture interface unavailable: ${iface}. Available: ${available.join(", ")}`);
  const duration = Math.min(Math.max(Number(durationSeconds) || 60, 1), 600);
  const size = Math.min(Math.max(Number(maxFileMb) || 50, 1), 250);
  const files = Math.min(Math.max(Number(ringFiles) || 2, 1), 10);
  const capture = safeCaptureName(name);
  const state = await captureState(cwd, taskId);
  if (state.captures[capture]) throw new Error(`Capture already exists: ${capture}`);
  const created = await sandboxOperation({ cwd, taskId, operation: "create", environment: "network-analysis" });
  if (created.code !== 0) return { phase: "create", ...created };
  const fileName = `${capture}.pcapng`;
  const command = `mkdir -p /workspace/captures /workspace/logs; nohup dumpcap -i ${quote(iface)} -a duration:${duration} -b filesize:${size} -b files:${files} -w ${quote(`/workspace/captures/${fileName}`)} > ${quote(`/workspace/logs/${capture}.log`)} 2>&1 & echo $!`;
  const started = await sandboxOperation({ cwd, taskId, operation: "exec", container: created.container, command, timeoutMs: 30000 });
  if (started.code !== 0) { await sandboxOperation({ cwd, taskId, operation: "destroy", container: created.container }); return { phase: "start", ...started }; }
  const pid = String(started.stdout || "").trim().split(/\s+/).at(-1) || null;
  state.captures[capture] = { name: capture, container: created.container, pid, interface: iface, duration_seconds: duration, max_file_mb: size, ring_files: files, file: fileName, started_at: new Date().toISOString() };
  await saveCaptureState(cwd, taskId, state);
  return { phase: "started", ...state.captures[capture] };
}

export async function netCaptureStop({ cwd = process.cwd(), taskId, name }) {
  const state = await captureState(cwd, taskId); const capture = state.captures[String(name || "")];
  if (!capture) throw new Error(`Capture not found: ${name}`);
  const stopped = await sandboxOperation({ cwd, taskId, operation: "exec", container: capture.container, command: `kill ${quote(capture.pid)} 2>/dev/null || true; sleep 1`, timeoutMs: 30000 });
  const captureDir = join(taskRoot(cwd, taskId), "captures");
  const candidates = (await readdir(captureDir).catch(() => [])).filter((file) => file.startsWith(capture.name) && /\.pcapng$/i.test(file));
  const artifacts = [];
  for (const file of candidates) artifacts.push(await registerArtifactFile({ cwd, taskId, kind: "pcapng", name: file, file: join(captureDir, file), metadata: { capture: capture.name, interface: capture.interface, bounded_duration_seconds: capture.duration_seconds, bounded_file_mb: capture.max_file_mb } }));
  let logArtifact = null;
  if (!artifacts.length) {
    const log = join(taskRoot(cwd, taskId), "logs", `${capture.name}.log`);
    try { logArtifact = await registerArtifactFile({ cwd, taskId, kind: "capture-log", name: `${capture.name}.log`, file: log, metadata: { capture: capture.name, interface: capture.interface } }); }
    catch (error) { capture.error = `capture artifact unavailable: ${error.message}`; }
  }
  await sandboxOperation({ cwd, taskId, operation: "destroy", container: capture.container, timeoutMs: 30000 });
  delete state.captures[capture.name]; await saveCaptureState(cwd, taskId, state);
  return { phase: "stopped", capture, stopped, artifacts, artifact: artifacts[0] || null, log_artifact: logArtifact };
}

export async function netCaptureStatus({ cwd = process.cwd(), taskId }) { return captureState(cwd, taskId); }
