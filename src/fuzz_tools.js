// src/fuzz_tools.js — bounded fuzzing workflows + crash triage for the dsw harness.
//
// Scope: fuzzing YOUR OWN / authorized software inside the `fuzzing` sandbox
// (network: none). Phase 4 of the roadmap:
//   - fz_prepare  — compile a C/C++ harness with afl-clang-fast (plain or ASAN
//                   when the sanitizer runtime is present) and stage seed corpus
//   - fz_afl      — run a bounded AFL++ campaign (time/memory/timeout caps),
//                   collect crashes/hangs back into the task workspace
//   - fz_triage   — re-run each crash against the target, capture signal/exit,
//                   symbolize if possible, dedupe into buckets, severity
//   - fz_minimize — shrink a crashing input with afl-tmin (bounded)
//
// All sandbox work is ephemeral and network-isolated. Crash inputs are only
// ever re-executed inside the fuzzing sandbox against the user's own harness.
import { readFile, writeFile, mkdir, readdir, stat, copyFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeArtifact, taskRoot } from "./artifacts.js";
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

const FUZZ_ENV = "fuzzing";

async function stageInto(ctx, localPath, sandboxName) {
  const taskWs = taskRoot(ctx.cwd, ctx.taskId);
  const dest = join(taskWs, "tmp", sandboxName);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(resolve(ctx.cwd, localPath), dest);
  return dest;
}

async function stageText(ctx, name, content) {
  const taskWs = taskRoot(ctx.cwd, ctx.taskId);
  const dest = join(taskWs, "tmp", name);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, "utf8");
  return dest;
}

async function listDirFiles(dir) {
  try {
    const entries = await readdir(dir);
    return entries.filter((e) => !e.startsWith(".")).map((e) => join(dir, e));
  } catch {
    return [];
  }
}

// ── fz_prepare: compile harness + seed corpus ───────────────────────────────
async function fzPrepare(args, ctx) {
  const srcPath = resolve(ctx.cwd, args.source);
  const info = await stat(srcPath);
  if (!info.isFile()) throw new Error("source must be a file (.c/.cc/.cpp).");
  const ext = srcPath.split(".").pop().toLowerCase();
  const compiler = args.compiler === "gcc" ? "afl-gcc" : "afl-clang-fast";
  const outName = args.out || "harness";
  const asan = args.asan === true;
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, 15000), 600000);

  const srcFile = srcPath.split(/[\\/]/).pop();
  await stageInto(ctx, args.source, srcFile);
  // Seed corpus: a directory of files or a single seed file.
  const seeds = [];
  if (args.seeds_dir) {
    const dir = resolve(ctx.cwd, args.seeds_dir);
    const files = await listDirFiles(dir);
    for (const f of files.slice(0, 50)) {
      const name = f.split(/[\\/]/).pop();
      await stageInto(ctx, f, `seed-${name}`);
      seeds.push(`/workspace/tmp/seed-${name}`);
    }
  } else if (args.seed_file) {
    const name = args.seed_file.split(/[\\/]/).pop();
    await stageInto(ctx, args.seed_file, `seed-${name}`);
    seeds.push(`/workspace/tmp/seed-${name}`);
  }
  if (!seeds.length) {
    await stageText(ctx, "seed-empty", "AAAA\n");
    seeds.push("/workspace/tmp/seed-empty");
  }

  const asanPrefix = asan ? "AFL_USE_ASAN=1 " : "";
  const std = ext === "c" ? "c11" : "c++17";
  const command = [
    `cd /workspace/tmp`,
    `${asanPrefix}${compiler} -std=${std} -g -O1 ${srcFile} -o ${outName} 2>&1 | tail -20`,
    `ls -la ${outName} && echo COMPILE_OK`,
    `mkdir -p /workspace/seeds && for s in ${seeds.join(" ")}; do cp "$s" /workspace/seeds/ 2>/dev/null; done; ls /workspace/seeds | head`,
  ].join(" && ");
  const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: FUZZ_ENV, command, timeoutMs, networkPolicy: "none" });
  const ok = /COMPILE_OK/.test(result.stdout || "") && !/error:/i.test(result.stderr || "") && result.code === 0;
  if (!ok) {
    return [`fz_prepare — compile FAILED for ${args.source}`, truncate(result.stdout || result.stderr || "", 4000)].join("\n");
  }
  const lines = [
    `fz_prepare — ${args.source} → ${outName} (${compiler}${asan ? " + ASAN" : ""})`,
    `Seeds staged: ${seeds.length}`,
    "Next: fz_afl { target: '<out>' } or fz_afl { target: '<out>', duration_seconds: 60 }",
  ];
  return lines.join("\n");
}

// ── fz_afl: bounded AFL++ run ────────────────────────────────────────────────
const AFL_FLAGS = [
  "AFL_NO_UI=1",
  "AFL_SKIP_CPUFREQ=1",
  "AFL_I_DONT_CARE_ABOUT_MISSING_CRASHES=1",
  "AFL_NO_AFFINITY=1",
  "AFL_FAST_CAL=1",
];

async function fzAfl(args, ctx) {
  const target = String(args.target || "");
  if (!target) throw new Error("target is required (the compiled harness name from fz_prepare).");
  const duration = Math.min(Math.max(Number(args.duration_seconds) || 30, 5), 600);
  const memoryMb = Math.min(Math.max(Number(args.memory_mb) || 200, 50), 2048);
  const execTimeout = Math.min(Math.max(Number(args.exec_timeout_ms) || 200, 10), 5000);
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || duration * 1000 + 30000, 20000), 900000);
  const runId = `afl-${Date.now()}`;

  const command = [
    `cd /workspace && rm -rf out-${runId} && mkdir -p out-${runId}`,
    `printf 'AAAA\\n' > /workspace/seeds/seed-a 2>/dev/null || true`,
    `${AFL_FLAGS.join(" ")} afl-fuzz -V ${duration} -m ${memoryMb} -t ${execTimeout} -i /workspace/seeds -o /workspace/out-${runId} -- /workspace/tmp/${target} @@ > /workspace/afl-run.log 2>&1; true`,
    `echo "=== summary ==="; tail -25 /workspace/afl-run.log`,
    `echo "=== crash files ==="; find /workspace/out-${runId} -path '*crashes*' -name 'id:*' 2>/dev/null | sed 's#^#/#' | head -20`,
    `echo "=== hang files ==="; find /workspace/out-${runId} -path '*hangs*' -name 'id:*' 2>/dev/null | sed 's#^#/#' | head -10`,
    `echo "=== stats ==="; cat /workspace/out-${runId}/default/fuzzer_stats 2>/dev/null | grep -E 'execs_done|paths_total|unique_crashes|unique_hangs|cycles_done|execs_per_sec' || true`,
  ].join(" && ");
  const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: FUZZ_ENV, command, timeoutMs, networkPolicy: "none" });

  // Copy crashes/hangs back into the task workspace as artifacts.
  const copyDir = async (sub, kind) => {
    const remote = `find /workspace/out-${runId}/default/${sub} -name 'id:*' 2>/dev/null | head -50`;
    const listRes = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: FUZZ_ENV, command: remote, timeoutMs: 30000, networkPolicy: "none" });
    const names = String(listRes.stdout || "").split(/\r?\n/).filter((n) => n.trim());
    const files = [];
    for (const name of names) {
      const base = name.trim().split("/").pop();
      const safeBase = base.replace(/[^A-Za-z0-9._-]/g, "_"); // Windows-safe
      const dest = join(taskRoot(ctx.cwd, ctx.taskId), "crashes", kind, safeBase);
      await mkdir(dirname(dest), { recursive: true });
      const b64 = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: FUZZ_ENV, command: `base64 -w0 /workspace/out-${runId}/default/${sub}/${base} 2>/dev/null || true`, timeoutMs: 30000, networkPolicy: "none" });
      if (b64.stdout && b64.stdout.trim()) {
        const buf = Buffer.from(String(b64.stdout).trim(), "base64");
        await writeFile(dest, buf);
        files.push({ path: relative(ctx.cwd, dest).replaceAll("\\", "/"), bytes: buf.length, afl_name: base });
      }
    }
    return files;
  };

  const crashes = await copyDir("crashes", "crashes");
  const hangs = await copyDir("hangs", "hangs");

  const lines = [`AFL++ run ${runId} — target ${target}, ${duration}s`, ""];
  const summaryIdx = (result.stdout || "").indexOf("=== summary ===");
  if (summaryIdx >= 0) lines.push(truncate(result.stdout.slice(summaryIdx), 4000));
  lines.push(`\nCrashes collected: ${crashes.length}`);
  for (const c of crashes.slice(0, 10)) lines.push(`  ${c.path} (${c.bytes} bytes)`);
  lines.push(`Hangs collected: ${hangs.length}`);
  if (crashes.length) {
    lines.push("\nNext: fz_triage { crashes_dir: '.deepseek-watch/tasks/<task>/crashes/crashes', target: '<out>' }");
  }
  return lines.join("\n");
}

// ── fz_triage: crash re-run, signal capture, dedup, severity ────────────────
const SIGNAL_NAMES = {
  4: "SIGILL", 6: "SIGABRT", 8: "SIGFPE", 11: "SIGSEGV", 13: "SIGPIPE", 14: "SIGALRM", 15: "SIGTERM",
};
const ASAN_PATTERNS = [
  [/heap-buffer-overflow/i, "heap-buffer-overflow", "high"],
  [/stack-buffer-overflow/i, "stack-buffer-overflow", "high"],
  [/heap-use-after-free/i, "use-after-free", "high"],
  [/stack-use-after-return/i, "stack-use-after-return", "high"],
  [/global-buffer-overflow/i, "global-buffer-overflow", "high"],
  [/double-free/i, "double-free", "high"],
  [/alloc-dealloc-mismatch/i, "alloc-dealloc-mismatch", "medium"],
  [/SEGV/i, "SEGV", "high"],
  [/stack-overflow/i, "stack-overflow", "medium"],
  [/runtime error/i, "ubsan", "medium"],
  [/assertion/i, "assert", "medium"],
];

export function classifyCrash(stdout, stderr, exitSignal) {
  const blob = `${stdout}\n${stderr}`;
  for (const [re, label, sev] of ASAN_PATTERNS) {
    if (re.test(blob)) return { kind: label, severity: sev, evidence: (blob.match(re) || [])[0].slice(0, 60) };
  }
  if (exitSignal && SIGNAL_NAMES[exitSignal]) return { kind: SIGNAL_NAMES[exitSignal], severity: "high", evidence: `exit signal ${exitSignal}` };
  if (/ERROR: AddressSanitizer/i.test(blob)) return { kind: "asan-other", severity: "medium", evidence: "AddressSanitizer error" };
  return { kind: "unknown", severity: "low", evidence: "" };
}

export function crashBucketKey(crash) {
  // Dedup key: fault kind + first symbolized frame if available.
  const frame = crash.frames?.[0]?.func || "";
  return `${crash.kind}|${frame}`;
}

async function fzTriage(args, ctx) {
  const target = String(args.target || "");
  const crashesDir = resolve(ctx.cwd, args.crashes_dir);
  const files = (await listDirFiles(crashesDir)).filter((f) => /^id[:_]/.test(f.split(/[\\/]/).pop()));
  if (!files.length) return "No crash inputs found in crashes_dir (look for 'id:*' or 'id_*' files).";
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, 30000), 600000);
  const perRun = Math.min(Math.max(Number(args.max_crashes) || files.length, 1), 100);

  const taskWs = taskRoot(ctx.cwd, ctx.taskId);
  const runs = [];
  const triaged = [];
  for (const f of files.slice(0, perRun)) {
    const name = f.split(/[\\/]/).pop();
    await stageInto(ctx, relative(ctx.cwd, f), `crash-${name}`);
    const cmd = [
      `cd /workspace/tmp`,
      `ulimit -c 0`,
      `timeout 5 ./${target} crash-${name} > /workspace/run-out.txt 2> /workspace/run-err.txt; code=$?`,
      `echo "EXIT=$code"`,
      `head -c 2000 /workspace/run-err.txt`,
      `echo "---STDOUT---"`,
      `head -c 1500 /workspace/run-out.txt`,
    ].join(" && ");
    const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: FUZZ_ENV, command: cmd, timeoutMs: Math.min(timeoutMs, 30000), networkPolicy: "none" });
    const out = String(result.stdout || "");
    const exitMatch = out.match(/EXIT=(\d+)/);
    const exitCode = exitMatch ? Number(exitMatch[1]) : null;
    const exitSignal = exitCode != null && exitCode > 128 ? exitCode - 128 : exitCode === 124 ? null : exitCode;
    const stderr = out.split("---STDOUT---")[0]?.replace(/EXIT=\d+\s*/, "") || "";
    const stdout = out.split("---STDOUT---")[1] || "";
    const cls = classifyCrash(stdout, stderr, exitSignal);
    // Extract symbolized frames if llvm-symbolizer/addr2line is available (best effort).
    let frames = [];
    const fm = stderr.match(/^\s*(?:#[0-9]+|0x[0-9a-f]+)/gm) || [];
    for (const line of fm.slice(0, 8)) {
      const addr = (line.match(/0x[0-9a-f]+/) || [""])[0];
      const sym = (line.match(/([A-Za-z_][A-Za-z0-9_:]*)\s*\(/) || [""])[1];
      frames.push({ addr, func: sym || addr });
    }
    triaged.push({ input: name, exit_code: exitCode, signal: exitSignal, kind: cls.kind, severity: cls.severity, evidence: cls.evidence, frames, bytes: (await stat(f)).size });
    runs.push(result);
  }

  // Dedup by bucket key.
  const buckets = new Map();
  for (const t of triaged) {
    const key = crashBucketKey(t);
    if (!buckets.has(key)) buckets.set(key, { key, kind: t.kind, severity: t.severity, count: 0, examples: [] });
    const b = buckets.get(key);
    b.count++;
    if (b.examples.length < 3) b.examples.push(t.input);
  }

  const lines = [`fz_triage — ${triaged.length} crash inputs against ${target}`, ""];
  lines.push(`Buckets (${buckets.size} unique):`);
  for (const b of [...buckets.values()].sort((a, b2) => b2.count - a.count)) {
    lines.push(`  [${b.severity.toUpperCase()}] ${b.kind} × ${b.count} — e.g. ${b.examples.join(", ")}`);
  }
  lines.push("", "Per-input detail:");
  for (const t of triaged.slice(0, 20)) {
    lines.push(`  ${t.input}: ${t.kind} (${t.severity}) exit=${t.exit_code} sig=${t.signal ?? "-"}${t.frames[0]?.func ? ` first=${t.frames[0].func}` : ""}`);
  }
  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "fuzz-triage", name: `triage-${Date.now()}.json`, data: JSON.stringify({ target, buckets: [...buckets.values()], crashes: triaged }, null, 2), metadata: { target, crashes: triaged.length, buckets: buckets.size } });
  lines.push(`\nArtifact: ${artifact.path}`);
  return lines.join("\n");
}

// ── fz_minimize: afl-tmin on a crashing input ────────────────────────────────
async function fzMinimize(args, ctx) {
  const target = String(args.target || "");
  const crashPath = resolve(ctx.cwd, args.crash);
  const info = await stat(crashPath);
  if (!info.isFile()) throw new Error("crash must be a file path.");
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 120000, 15000), 600000);
  const name = crashPath.split(/[\\/]/).pop();
  await stageInto(ctx, args.crash, `min-${name}`);
  const outName = `min-${name}.min`;
  const cmd = [
    `cd /workspace/tmp`,
    `AFL_SKIP_CPUFREQ=1 AFL_I_DONT_CARE_ABOUT_MISSING_CRASHES=1 AFL_NO_AFFINITY=1 timeout 60 afl-tmin -i min-${name} -o ${outName} -- ./${target} @@ > /workspace/tmin.log 2>&1; true`,
    `echo "=== tmin log ==="; tail -8 /workspace/tmin.log`,
    `ls -la ${outName} 2>/dev/null && echo MINIMIZED && base64 -w0 ${outName}`,
  ].join(" && ");
  const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: FUZZ_ENV, command: cmd, timeoutMs, networkPolicy: "none" });
  const lines = [`fz_minimize — ${name} (${info.size} bytes)`, truncate(result.stdout || "", 3000)];
  const b64Idx = (result.stdout || "").lastIndexOf("MINIMIZED");
  if (b64Idx >= 0) {
    const b64 = String(result.stdout || "").slice(result.stdout.indexOf("MINIMIZED") + "MINIMIZED".length).trim();
    const data = Buffer.from(b64, "base64");
    const dest = join(taskRoot(ctx.cwd, ctx.taskId), "crashes", "minimized", name);
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, data);
    lines.push(`\nMinimized to ${data.length} bytes → ${relative(ctx.cwd, dest)}`);
  }
  return lines.join("\n");
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set(["fz_prepare", "fz_afl", "fz_triage", "fz_minimize"]);

export async function runFuzzTool(name, args, opts = {}, ctx = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const summary = args.source ? `Source: ${args.source}` : args.target ? `Target: ${args.target}` : "";
    const ok = await opts.askYesNo?.(`Run ${name}?\n${summary}`.trim());
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "fz_prepare": return fzPrepare(args, ctx);
    case "fz_afl": return fzAfl(args, ctx);
    case "fz_triage": return fzTriage(args, ctx);
    case "fz_minimize": return fzMinimize(args, ctx);
    default: throw new Error(`Unknown fuzz tool: ${name}`);
  }
}

export function fuzzToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    schema("fz_prepare",
      "Compile a C/C++ fuzz harness with afl-clang-fast (or afl-gcc) inside the fuzzing sandbox and stage a seed corpus. ASAN is used only if the sanitizer runtime is present in the image.",
      {
        source: { type: "string", description: "Workspace-relative .c/.cc/.cpp harness source." },
        compiler: { type: "string", enum: ["clang", "gcc"], description: "afl-clang-fast (default) or afl-gcc." },
        out: { type: "string", description: "Harness output name (default 'harness')." },
        asan: { type: "boolean", description: "Compile with AFL_USE_ASAN=1 (requires sanitizer runtime in image). Default false." },
        seeds_dir: { type: "string", description: "Optional dir of seed inputs to stage." },
        seed_file: { type: "string", description: "Optional single seed file." },
        timeout_ms: { type: "number", description: "Compile timeout. Default 120000." },
      },
      ["source"]),
    schema("fz_afl",
      "Run a bounded AFL++ campaign in the fuzzing sandbox against a prepared harness: duration, memory, and per-exec timeout caps. Collects crashes/hangs back into the task workspace as artifacts.",
      {
        target: { type: "string", description: "Harness name from fz_prepare (e.g. 'harness')." },
        duration_seconds: { type: "number", description: "Fuzz duration. Default 30, max 600." },
        memory_mb: { type: "number", description: "Per-process memory cap. Default 200." },
        exec_timeout_ms: { type: "number", description: "Per-execution timeout. Default 200." },
        timeout_ms: { type: "number", description: "Overall command timeout. Default duration + 30s." },
      },
      ["target"]),
    schema("fz_triage",
      "Crash triage and dedup: re-run each crashing input against the harness in the sandbox, capture exit signal/stderr, classify fault type (ASAN patterns or signal), symbolize frames when possible, and bucket duplicates. Writes a JSON artifact.",
      {
        crashes_dir: { type: "string", description: "Workspace-relative dir containing crash inputs (id:* files)." },
        target: { type: "string", description: "Harness name from fz_prepare." },
        max_crashes: { type: "number", description: "Max crashes to re-run. Default all, max 100." },
        timeout_ms: { type: "number", description: "Overall timeout. Default 120000." },
      },
      ["crashes_dir", "target"]),
    schema("fz_minimize",
      "Minimize a crashing input with afl-tmin (bounded, 60s) against a prepared harness. Writes the minimized input as an artifact.",
      {
        crash: { type: "string", description: "Workspace-relative path to a crash input." },
        target: { type: "string", description: "Harness name from fz_prepare." },
        timeout_ms: { type: "number", description: "Overall timeout. Default 120000." },
      },
      ["crash", "target"]),
  ];
}
