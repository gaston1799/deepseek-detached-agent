#!/usr/bin/env node
// Self-test: agent id → session file binding in the watch CLI.
//   run 1: --agent-id test-agent-1 creates a session recording the agent id.
//   run 2: same agent id resumes that exact session (prompt appended).
//   run 3: --agent-id test-agent-1 --new starts a fresh session (second file).
// Uses a local mock DeepSeek server so no API key is needed.
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");
const WATCH_CLI = join(REPO, "src", "deepseek-watch.js");

const SSE_BODY = [
  'data: {"choices":[{"delta":{"content":"hello from mock"},"finish_reason":null}]}',
  "",
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
  "",
  "data: [DONE]",
  ""
].join("\n");

function startMockServer() {
  const server = createServer((req, res) => {
    if (req.url !== "/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(SSE_BODY);
    });
  });
  return new Promise((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise({ server, port: server.address().port }));
  });
}

function runCli(cwd, port, extraArgs) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [
      WATCH_CLI,
      "--base-url", `http://127.0.0.1:${port}`,
      "--timeout", "10000",
      "--no-tools",
      "--no-color",
      "--tui-quiet",
      "--coord-dir", join(cwd, "coordination"),
      ...extraArgs
    ], {
      cwd,
      env: { ...process.env, DEEPSEEK_API_KEY: "sk-test" },
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolvePromise({ code: -1, stdout, stderr, error }));
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

async function sessionFiles(cwd) {
  const dir = join(cwd, ".deepseek-watch", "sessions");
  try {
    return (await readdir(dir)).filter((name) => name.endsWith(".json")).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

const results = [];
function check(name, condition, detail) {
  results.push({ name, ok: Boolean(condition) });
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${condition ? "" : `\n      ${detail}`}`);
}

const { server, port } = await startMockServer();
const cwd = await mkdtemp(join(tmpdir(), "dsw-agent-session-test-"));
try {
  const agentId = "test-agent-1";

  // Run 1: first launch → creates a session recording the agent id.
  const run1 = await runCli(cwd, port, ["--agent-id", agentId, "-p", "run one"]);
  check("run 1 exits 0", run1.code === 0, `code=${run1.code} stderr=${run1.stderr.slice(0, 200)}`);
  let files = await sessionFiles(cwd);
  check("run 1 created exactly one session", files.length === 1, `files=${files.length}`);
  const session1 = JSON.parse(await readFile(files[0], "utf8"));
  check("session records agent id", session1.config?.agentId === agentId, JSON.stringify(session1.config));

  // Run 2: same agent id → resumes the SAME session file (still one file).
  const run2 = await runCli(cwd, port, ["--agent-id", agentId, "-p", "run two"]);
  check("run 2 exits 0", run2.code === 0, `code=${run2.code} stderr=${run2.stderr.slice(0, 200)}`);
  files = await sessionFiles(cwd);
  check("run 2 reused the session (still one file)", files.length === 1, `files=${files.length}`);
  const session2 = JSON.parse(await readFile(files[0], "utf8"));
  const userPrompts = session2.messages.filter((message) => message.role === "user").map((message) => String(message.content));
  check("run 2 appended its prompt (resumed)", userPrompts.includes("run two"), JSON.stringify(userPrompts));

  // Run 3: --new → fresh session file for the same agent id.
  const run3 = await runCli(cwd, port, ["--agent-id", agentId, "--new", "-p", "run three"]);
  check("run 3 exits 0", run3.code === 0, `code=${run3.code} stderr=${run3.stderr.slice(0, 200)}`);
  files = await sessionFiles(cwd);
  check("run 3 --new created a second session", files.length === 2, `files=${files.length}`);

  // The newest session (run 3) holds "run three"; both record the agent id.
  const parsed = [];
  for (const file of files) parsed.push({ file, data: JSON.parse(await readFile(file, "utf8")) });
  parsed.sort((a, b) => (b.data.updatedAt || "").localeCompare(a.data.updatedAt || ""));
  check("new session records agent id too", parsed.every((entry) => entry.data.config?.agentId === agentId), JSON.stringify(parsed.map((entry) => entry.data.config?.agentId)));
  const freshPrompts = parsed[0].data.messages.filter((message) => message.role === "user").map((message) => String(message.content));
  check("--new session started fresh (only run three)", freshPrompts.length === 1 && freshPrompts[0] === "run three", JSON.stringify(freshPrompts));

  // Run 4: --resume --new must be rejected.
  const run4 = await runCli(cwd, port, ["--agent-id", agentId, "--resume", "--new", "-p", "bad"]);
  check("--resume --new rejected", run4.code === 1 && /cannot be combined/.test(`${run4.stderr}\n${run4.stdout}`), `code=${run4.code} out=${run4.stdout.slice(0, 200)} err=${run4.stderr.slice(0, 200)}`);
} finally {
  server.close();
  await rm(cwd, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} agent-session checks failed.`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${results.length} agent-session checks passed.`);
}
