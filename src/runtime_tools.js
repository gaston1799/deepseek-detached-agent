// src/runtime_tools.js — runtime observation tooling for the dsw harness.
//
// Scope: observing YOUR OWN host / authorized targets. Phase 3 of the roadmap:
//   - sys_snapshot / sys_diff  — before/after system state diffs
//     (filesystem, registry, services, scheduled tasks, running processes)
//   - sys_ipc_discovery        — pipes, localhost listeners, COM/RPC, URI handlers
//   - re_frida                 — Frida instrumentation (needs frida in sandbox image)
//   - net_mitm                 — mitmproxy HTTP capture harness (needs mitmproxy image)
//
// Host tools use PowerShell on Windows (the harness host). Sandbox tools are
// detection-gated: if the tool is missing from the image they return setup
// instructions instead of failing cryptically.
import { spawn } from "node:child_process";
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeArtifact, getArtifact, taskRoot } from "./artifacts.js";
import { sandboxExecute } from "./sandbox.js";

// ── Small shared helpers ─────────────────────────────────────────────────────
export function truncate(text, max = 4000) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

function capList(items, max) {
  const list = [...items];
  const capped = list.slice(0, max);
  if (list.length > max) capped.push(`…[+${list.length - max} more]`);
  return capped;
}

function runPowershell(script, timeoutMs = 30000) {
  return new Promise((resolvePromise) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolvePromise({ code: null, timed_out: true, stdout, stderr }); }, timeoutMs);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c) => { stdout += c; if (stdout.length > 2000000) { try { child.kill(); } catch {} } });
    child.stderr.on("data", (c) => { stderr += c; });
    child.on("error", (e) => { clearTimeout(timer); resolvePromise({ code: -1, timed_out: false, stdout, stderr: String(e?.message || e) }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ code, timed_out: false, stdout, stderr }); });
  });
}

// ── sys_snapshot: capture system state ───────────────────────────────────────
const SNAPSHOT_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
# Services
$out.services = @(Get-CimInstance Win32_Service | ForEach-Object { [PSCustomObject]@{ name=$_.Name; state=$_.State; start=$_.StartMode; path=$_.PathName } })
# Scheduled tasks
$out.tasks = @(Get-ScheduledTask | ForEach-Object { [PSCustomObject]@{ name=$_.TaskName; path=$_.TaskPath; state=[string]$_.State } })
# Running processes (name + pid, bounded)
$out.processes = @(Get-Process | Sort-Object Id | Select-Object -First 500 | ForEach-Object { [PSCustomObject]@{ name=$_.ProcessName; pid=$_.Id } })
# TCP listeners
$out.listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object { [PSCustomObject]@{ local=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess } })
$out | ConvertTo-Json -Depth 4 -Compress
`;

async function sysSnapshot(args, ctx) {
  const snapshotType = String(args.type || "system");
  const label = String(args.label || `snapshot-${Date.now()}`);
  const result = { schema_version: 1, captured_at: new Date().toISOString(), label, type: snapshotType, data: {} };

  if (snapshotType === "filesystem" || snapshotType === "system") {
    const root = args.path ? resolve(ctx.cwd, args.path) : ctx.cwd;
    const maxDepth = Math.min(Math.max(Number(args.depth) || 3, 1), 8);
    const maxEntries = Math.min(Math.max(Number(args.max_entries) || 2000, 10), 20000);
    const walk = async (dir, depth) => {
      if (result.data.files && result.data.files.length >= maxEntries) return;
      if (depth > maxDepth) return;
      let entries = [];
      try { entries = await readdirSafe(dir); } catch { return; }
      for (const entry of entries) {
        const full = join(dir, entry);
        try {
          const info = await stat(full);
          const rec = { path: relative(ctx.cwd, full).replaceAll("\\", "/"), is_dir: info.isDirectory(), size: info.size, mtime: info.mtimeMs };
          (result.data.files ||= []).push(rec);
          if (info.isDirectory()) await walk(full, depth + 1);
        } catch { /* skip unreadable */ }
        if (result.data.files && result.data.files.length >= maxEntries) return;
      }
    };
    await walk(root, 0);
    result.data.files = (result.data.files || []).slice(0, maxEntries);
  }

  if (snapshotType === "system" || snapshotType === "services" || snapshotType === "tasks" || snapshotType === "processes" || snapshotType === "listeners") {
    const ps = await runPowershell(SNAPSHOT_PS, 60000);
    let parsed = {};
    try { parsed = JSON.parse(ps.stdout || "{}"); } catch { /* keep {} */ }
    if (snapshotType === "services" || snapshotType === "system") result.data.services = parsed.services || [];
    if (snapshotType === "tasks" || snapshotType === "system") result.data.tasks = parsed.tasks || [];
    if (snapshotType === "processes" || snapshotType === "system") result.data.processes = parsed.processes || [];
    if (snapshotType === "listeners" || snapshotType === "system") result.data.listeners = parsed.listeners || [];
    if (ps.timed_out) result.warning = "PowerShell observation timed out — partial snapshot.";
  }

  if (snapshotType === "registry") {
    const hive = String(args.hive || "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run");
    const ps = await runPowershell(`
      $ErrorActionPreference='SilentlyContinue'
      Get-ItemProperty -Path '${hive}' | Select-Object * -ExcludeProperty PS* | ConvertTo-Json -Depth 3 -Compress`, 30000);
    try { result.data.registry = JSON.parse(ps.stdout || "{}"); } catch { result.data.registry = {}; result.warning = "registry read failed or empty (check hive path / permissions)"; }
  }

  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "sys-snapshot", name: `${label}.snapshot.json`, data: JSON.stringify(result, null, 2), metadata: { label, type: snapshotType } });
  const lines = [`System snapshot "${label}" (${snapshotType}) captured â†’ ${artifact.path}`];
  for (const [key, value] of Object.entries(result.data)) {
    if (Array.isArray(value)) lines.push(`  ${key}: ${value.length} entries`);
    else if (value && typeof value === "object") lines.push(`  ${key}: ${Object.keys(value).length} keys`);
  }
  if (result.warning) lines.push(`  âš  ${result.warning}`);
  return lines.join("\n");
}

async function readdirSafe(dir) {
  const { readdir } = await import("node:fs/promises");
  return readdir(dir);
}

// ── sys_diff: compare two snapshots ──────────────────────────────────────────
export function diffLists(before, after, keyFn, label) {
  const b = new Map((before || []).map((x) => [keyFn(x), x]));
  const a = new Map((after || []).map((x) => [keyFn(x), x]));
  const added = []; const removed = []; const changed = [];
  for (const [k, v] of a) {
    if (!b.has(k)) added.push(v);
    else if (JSON.stringify(b.get(k)) !== JSON.stringify(v)) changed.push({ before: b.get(k), after: v });
  }
  for (const [k, v] of b) if (!a.has(k)) removed.push(v);
  return { label, added, removed, changed };
}

async function sysDiff(args, ctx) {
  const resolveSnapshot = async (ref) => {
    try {
      const found = await getArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, artifact: ref });
      return JSON.parse(await readFile(found.file, "utf8"));
    } catch (error) {
      if (!/not found/i.test(error.message)) throw error;
      // Fall back: match by the snapshot label stored in artifact content.
      const { listArtifacts } = await import("./artifacts.js");
      const records = await listArtifacts({ cwd: ctx.cwd, taskId: ctx.taskId });
      for (const record of records) {
        try {
          const data = JSON.parse(await readFile(resolve(ctx.cwd, record.path), "utf8"));
          if (data.label === ref) return data;
        } catch { /* keep looking */ }
      }
      throw new Error(`Snapshot not found by id/name/label: ${ref}`);
    }
  };
  const before = await resolveSnapshot(args.before);
  const after = await resolveSnapshot(args.after);
  const lines = [`System diff — ${before.label || args.before} â†’ ${after.label || args.after}`];

  if (before.data.services && after.data.services) {
    const d = diffLists(before.data.services, after.data.services, (s) => s.name, "services");
    lines.push(`\nServices (${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed):`);
    for (const x of d.added) lines.push(`  + ${x.name} [${x.state}/${x.start}]`);
    for (const x of d.removed) lines.push(`  - ${x.name} [${x.state}/${x.start}]`);
    for (const x of d.changed.slice(0, 20)) lines.push(`  ~ ${x.before.name}: ${x.before.state}/${x.before.start} â†’ ${x.after.state}/${x.after.start}`);
  }
  if (before.data.tasks && after.data.tasks) {
    const d = diffLists(before.data.tasks, after.data.tasks, (t) => `${t.path}\\${t.name}`, "tasks");
    lines.push(`\nScheduled tasks (${d.added.length} added, ${d.removed.length} removed, ${d.changed.length} changed):`);
    for (const x of d.added) lines.push(`  + ${x.path}${x.name} [${x.state}]`);
    for (const x of d.removed) lines.push(`  - ${x.path}${x.name} [${x.state}]`);
  }
  if (before.data.processes && after.data.processes) {
    const d = diffLists(before.data.processes, after.data.processes, (p) => p.pid, "processes");
    lines.push(`\nProcesses (${d.added.length} new, ${d.removed.length} exited):`);
    for (const x of d.added.slice(0, 30)) lines.push(`  + ${x.name} (pid ${x.pid})`);
    for (const x of d.removed.slice(0, 30)) lines.push(`  - ${x.name} (pid ${x.pid})`);
  }
  if (before.data.listeners && after.data.listeners) {
    const d = diffLists(before.data.listeners, after.data.listeners, (l) => `${l.local}:${l.port}`, "listeners");
    lines.push(`\nTCP listeners (${d.added.length} added, ${d.removed.length} removed):`);
    for (const x of d.added) lines.push(`  + ${x.local}:${x.port} (pid ${x.pid})`);
    for (const x of d.removed) lines.push(`  - ${x.local}:${x.port} (pid ${x.pid})`);
  }
  if (before.data.files && after.data.files) {
    const bFiles = new Map(before.data.files.map((f) => [f.path, f]));
    const aFiles = new Map(after.data.files.map((f) => [f.path, f]));
    const added = []; const removed = []; const modified = [];
    for (const [p, f] of aFiles) {
      if (!bFiles.has(p)) added.push(f);
      else if (bFiles.get(p).size !== f.size || bFiles.get(p).is_dir !== f.is_dir) modified.push({ before: bFiles.get(p), after: f });
    }
    for (const [p] of bFiles) if (!aFiles.has(p)) removed.push(p);
    lines.push(`\nFilesystem (${added.length} added, ${removed.length} removed, ${modified.length} modified, within snapshot paths):`);
    for (const f of added.slice(0, 30)) lines.push(`  + ${f.path}${f.is_dir ? "/" : ` (${f.size} bytes)`}`);
    for (const p of removed.slice(0, 30)) lines.push(`  - ${p}`);
    for (const m of modified.slice(0, 30)) lines.push(`  ~ ${m.before.path}: ${m.before.size} â†’ ${m.after.size} bytes`);
  }
  if (before.data.registry && after.data.registry) {
    const keys = new Set([...Object.keys(before.data.registry), ...Object.keys(after.data.registry)]);
    const changed = [];
    for (const k of keys) {
      if (JSON.stringify(before.data.registry[k]) !== JSON.stringify(after.data.registry[k])) changed.push(k);
    }
    if (changed.length) lines.push(`\nRegistry values changed (${changed.length}): ${capList(changed, 20).join(", ")}`);
  }
  return lines.join("\n") || "No differences found between snapshots.";
}

// ── sys_ipc_discovery: pipes, listeners, COM/RPC, URI handlers ──────────────
const IPC_PS = `
$ErrorActionPreference = 'SilentlyContinue'
$out = @{}
# Named pipes
$out.pipes = @([System.IO.Directory]::GetFiles('\\\\.\\pipe\\') | ForEach-Object { [System.IO.Path]::GetFileName($_) } | Select-Object -First 300)
# Localhost TCP listeners with owning process
$out.listeners = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '0.0.0.0' -or $_.LocalAddress -eq '::' -or $_.LocalAddress -eq '::1' } | ForEach-Object {
  $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue
  [PSCustomObject]@{ local=$_.LocalAddress; port=$_.LocalPort; pid=$_.OwningProcess; proc=$(if($p){$p.ProcessName}else{''}) }
} | Sort-Object port -Unique | Select-Object -First 200)
# URI handlers from HKCR via .NET Registry API (fast, in-process).
# Enumerate letter-prefixed scheme keys, read shell\open\command default value.
$out.uri_handlers = @()
$hkcr = [Microsoft.Win32.Registry]::ClassesRoot
foreach ($name in $hkcr.GetSubKeyNames()) {
  if ($name -notmatch '^[a-z][a-z0-9+.-]*$') { continue }
  $sub = $hkcr.OpenSubKey("$name\\shell\\open\\command")
  if ($sub) {
    $cmd = $sub.GetValue('')
    if ($cmd) { $out.uri_handlers += [PSCustomObject]@{ scheme=$name; command=[string]$cmd } }
    $sub.Close()
  }
  if ($out.uri_handlers.Count -ge 150) { break }
}
# COM servers (LocalServer32 exe paths, bounded)
$out.com_servers = @()
$clsidRoot = $hkcr.OpenSubKey('CLSID')
if ($clsidRoot) {
  foreach ($clsid in $clsidRoot.GetSubKeyNames()) {
    $ls = $clsidRoot.OpenSubKey("$clsid\\LocalServer32")
    if ($ls) {
      $cmd = $ls.GetValue('')
      if ($cmd) { $out.com_servers += [PSCustomObject]@{ clsid=$clsid; command=[string]$cmd } }
      $ls.Close()
    }
    if ($out.com_servers.Count -ge 200) { break }
  }
  $clsidRoot.Close()
}
$out | ConvertTo-Json -Depth 4 -Compress
`;


async function sysIpcDiscovery(args, ctx) {
  const ps = await runPowershell(IPC_PS, 60000);
  let data = {};
  try { data = JSON.parse(ps.stdout || "{}"); } catch { /* keep {} */ }
  const lines = [`IPC discovery — ${new Date().toISOString()}`];
  lines.push(`\nNamed pipes (${(data.pipes || []).length}):`);
  lines.push(...capList(data.pipes || [], 100).map((p) => `  ${p}`));
  lines.push(`\nLocalhost TCP listeners (${(data.listeners || []).length}):`);
  for (const l of (data.listeners || []).slice(0, 100)) lines.push(`  ${l.local}:${l.port}  ${l.proc || "?"} (pid ${l.pid})`);
  lines.push(`\nURI handlers (${(data.uri_handlers || []).length}):`);
  for (const h of (data.uri_handlers || []).slice(0, 60)) lines.push(`  ${h.scheme}: ${truncate(String(h.command || "").replace(/\s+/g, " "), 100)}`);
  lines.push(`\nCOM LocalServer32 servers (${(data.com_servers || []).length}):`);
  for (const c of (data.com_servers || []).slice(0, 50)) lines.push(`  ${c.clsid}: ${truncate(String(c.command || "").replace(/\s+/g, " "), 100)}`);
  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "ipc-discovery", name: `ipc-${Date.now()}.json`, data: JSON.stringify(data, null, 2), metadata: {} });
  lines.push(`\nArtifact: ${artifact.path}`);
  return lines.join("\n");
}

// ── re_frida: Frida instrumentation (needs frida in linux-re image) ─────────
const FRIDA_PROBE = "command -v frida 2>/dev/null || python3 -c 'import frida; print(\"python-frida\")' 2>/dev/null || true";

async function reFrida(args, ctx) {
  const target = args.path ? resolve(ctx.cwd, args.path) : null;
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 60000, 10000), 600000);

  const probe = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: "linux-re", command: FRIDA_PROBE, timeoutMs: 30000, networkPolicy: "none" });
  const hasFrida = String(probe.stdout || "").trim();
  if (!hasFrida) {
    return [
      "Frida is not installed in the linux-re sandbox image.",
      "Install it (adds frida + frida-tools to the image):",
      "  docker build --file docker/Dockerfile.linux-re-frida --tag dsw/linux-re-frida:latest .",
      "Then point SANDBOX_ENVIRONMENTS['linux-re'].image at the new image in src/sandbox.js.",
    ].join("\n");
  }

  const scriptText = String(args.script || "console.log(JSON.stringify(Process.enumerateModules().slice(0,50).map(m => ({n:m.name,b:m.base,s:m.size}))));");
  const taskWs = taskRoot(ctx.cwd, ctx.taskId);
  const scriptLocal = join(taskWs, "tmp", "frida-hook.js");
  await mkdir(dirname(scriptLocal), { recursive: true });
  await writeFile(scriptLocal, scriptText, "utf8");

  // If a host binary was given, stage it; otherwise enumerate system processes.
  const binArg = target ? await stageBinary(ctx, target, "frida-target") : null;
  const command = binArg
    ? `cd /workspace && timeout ${Math.floor(timeoutMs / 1000)} frida -q -f /workspace/tmp/${binArg} -l /workspace/tmp/frida-hook.js 2>&1 | head -c 30000`
    : `cd /workspace && timeout ${Math.floor(timeoutMs / 1000)} frida-ps -a 2>&1 | head -c 30000`;
  const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: "linux-re", command, timeoutMs, networkPolicy: "none" });
  return [`Frida — ${target || "process listing"}`, truncate(result.stdout || "", 20000), result.stderr ? `stderr: ${truncate(result.stderr, 2000)}` : ""].join("\n");
}

async function stageBinary(ctx, target, prefix) {
  const info = await stat(target);
  if (!info.isFile()) throw new Error("path must be a file.");
  const fileName = `${prefix}-${target.split(/[\\/]/).pop()}`;
  await writeFile(join(taskRoot(ctx.cwd, ctx.taskId), "tmp", fileName), await readFile(target));
  return fileName;
}

// ── net_mitm: mitmproxy harness (needs mitmproxy in network-analysis image) ─
const MITM_PROBE = "command -v mitmdump 2>/dev/null || true";

async function netMitm(args, ctx) {
  const url = String(args.url || "");
  if (!url) throw new Error("url is required.");
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, 20000), 600000);

  const probe = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: "network-analysis", command: MITM_PROBE, timeoutMs: 30000, networkPolicy: "none" });
  if (!String(probe.stdout || "").trim()) {
    return [
      "mitmproxy is not installed in the network-analysis sandbox image.",
      "Install it (adds mitmproxy to the image):",
      "  docker build --file docker/Dockerfile.network-analysis-mitm --tag dsw/network-analysis-mitm:latest .",
      "Then point SANDBOX_ENVIRONMENTS['network-analysis'].image at the new image in src/sandbox.js.",
    ].join("\n");
  }

  // One-shot harness: run mitmdump in the background, curl the target through
  // it, then dump the captured flows as JSON.
  const command = [
    `cd /workspace && rm -f /tmp/flows.mitm`,
    `(mitmdump -q --set confdir=/tmp/mitm -w /tmp/flows.mitm > /tmp/mitm.log 2>&1 &)`,
    `sleep 2`,
    `curl -sk --max-time 30 --proxy http://127.0.0.1:8080 -o /dev/null -w 'status=%{http_code} size=%{size_download}\\n' ${JSON.stringify(url)} || true`,
    `sleep 1`,
    `pkill -f mitmdump 2>/dev/null || true`,
    `python3 - <<'PY' 2>/dev/null || true
from mitmproxy.io import FlowReader
try:
    f = open('/tmp/flows.mitm','rb'); r = FlowReader(f)
    for flow in r.stream():
        req = flow.request
        print(f"{req.method} {req.pretty_url} status={getattr(flow.response,'status_code','?') if flow.response else '?'} len={len(req.raw_content or b'') if hasattr(req,'raw_content') else '?'}")
except Exception as e:
    print("no flows:", e)
PY`,
  ].join(" && ");
  const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: "network-analysis", command, timeoutMs, networkPolicy: "allowlisted", target: url });
  return [`mitmproxy — ${url}`, truncate(result.stdout || "", 20000), result.stderr ? `stderr: ${truncate(result.stderr, 2000)}` : ""].join("\n");
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set(["re_frida", "net_mitm"]);

export async function runRuntimeTool(name, args, opts = {}, ctx = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const summary = args.url ? `Target: ${args.url}` : args.path ? `Path: ${args.path}` : "";
    const ok = await opts.askYesNo?.(`Run ${name}?\n${summary}`.trim());
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "sys_snapshot": return sysSnapshot(args, ctx);
    case "sys_diff": return sysDiff(args, ctx);
    case "sys_ipc_discovery": return sysIpcDiscovery(args, ctx);
    case "re_frida": return reFrida(args, ctx);
    case "net_mitm": return netMitm(args, ctx);
    default: throw new Error(`Unknown runtime tool: ${name}`);
  }
}

export function runtimeToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    schema("sys_snapshot",
      "Capture a system state snapshot on the Windows host (services, scheduled tasks, running processes, TCP listeners) and/or a bounded filesystem walk. Writes a JSON artifact for later sys_diff.",
      {
        type: { type: "string", enum: ["system", "filesystem", "services", "tasks", "processes", "listeners", "registry"], description: "What to capture. Default system." },
        label: { type: "string", description: "Snapshot label (used as artifact name). Default: snapshot-<ts>." },
        path: { type: "string", description: "For filesystem snapshots: workspace-relative dir to walk. Default: workspace root." },
        depth: { type: "number", description: "Filesystem walk depth. Default 3, max 8." },
        max_entries: { type: "number", description: "Filesystem entry cap. Default 2000, max 20000." },
        hive: { type: "string", description: "For registry snapshots: PSDrive hive path. Default HKLM Run key." },
      }),
    schema("sys_diff",
      "Compare two sys_snapshot artifacts (before/after): added/removed/changed services, scheduled tasks, processes, TCP listeners, filesystem entries, and registry values. Requires two artifact names from a previous sys_snapshot.",
      {
        before: { type: "string", description: "Before snapshot artifact name (or label)." },
        after: { type: "string", description: "After snapshot artifact name (or label)." },
      },
      ["before", "after"]),
    schema("sys_ipc_discovery",
      "Discover IPC surface on the Windows host: named pipes, localhost TCP listeners with owning process, URI handlers registered in HKCR, and COM LocalServer32 servers. Writes a JSON artifact.",
      {}),
    schema("re_frida",
      "Frida instrumentation in the linux-re sandbox: spawn a staged host binary under Frida with a hook script (default: enumerate modules), or list running processes. Requires Frida in the sandbox image (see output if missing).",
      {
        path: { type: "string", description: "Optional workspace-relative binary to spawn under Frida." },
        script: { type: "string", description: "Optional Frida JS hook script. Default: enumerate modules." },
        timeout_ms: { type: "number", description: "Timeout. Default 60000." },
      }),
    schema("net_mitm",
      "mitmproxy HTTP capture harness against an ALLOWLISTED URL: runs mitmdump in the network-analysis sandbox, fetches the URL through the proxy, and lists captured request/status pairs. Requires mitmproxy in the image (see output if missing).",
      {
        url: { type: "string", description: "Target URL. Host must be allowlisted and in scope." },
        timeout_ms: { type: "number", description: "Harness timeout. Default 120000." },
      },
      ["url"]),
  ];
}
