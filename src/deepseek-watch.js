#!/usr/bin/env node
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { platform, release, arch, userInfo } from "node:os";
import { dirname, isAbsolute, resolve, relative } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { deepSeekHttpError } from "./api-error.js";
import { configPath, getDeepSeekApiKey, setDeepSeekApiKey } from "./config.js";
import { applyThinkingOptions } from "./deepseek-request.js";
import { listSessions, newSession, newSessionPath, readSession, sessionPath, touchSession, writeSession } from "./session-memory.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_SYSTEM_PROMPT_FILE = new URL("../prompts/default-system.md", import.meta.url);
// __SYSTEM_PROMPT__ is replaced with the file's content by the exe build step (esbuild --define).
// In normal dev/npm installs it is undefined and the file is read at runtime instead.
const EMBEDDED_SYSTEM_PROMPT = typeof __SYSTEM_PROMPT__ !== "undefined" ? __SYSTEM_PROMPT__ : null;

function usage() {
  return `dsw  (alias: d)

Usage:
  dsw
  dsw config set-key <key>
  dsw config path
  dsw -p <prompt> [options]
  dsw --prompt-file <file> [options]
  dsw --stdin [options]

Options:
  -p, --prompt <text>          Prompt content.
  --prompt-file <file>         Read prompt content from a file.
  --stdin                      Read prompt content from stdin.
  --system <text>              System prompt text.
  --system-file <file>         System prompt file. Default: prompts/default-system.md
  --print-system               Print the rendered system prompt and exit.
  --model <name>               DeepSeek model. Default: deepseek-v4-flash
  --base-url <url>             OpenAI-compatible base URL. Default: https://api.deepseek.com
  --effort <high|max>          Reasoning effort. Default: high
  --thinking <enabled|disabled>
                               DeepSeek thinking toggle. Default: enabled
  --max-tokens <number>        Max output tokens. Default: 8192
  --timeout <ms>               Request timeout per turn. Default: 600000
  --max-tool-turns <number>    Max tool call loops. Default: unlimited
  --tool-mode <parallel|sequential>
                               parallel runs tool calls concurrently; sequential runs in order. Default: parallel
  --permission <review|ask|full>
                               Session permission level. review=read-only, ask=prompt for shell, full=auto-run shell.
  --session <file>             Session memory JSON file. Default: new timestamped session.
  --resume                     Resume from --session, or pick a recent session if omitted.
  --no-save-session            Do not write session memory to disk.
  --dangerously-auto-run-commands
                               Run requested cmd/PowerShell commands without prompting.
  --no-tools                   Disable built-in read-only workspace tools.
  --no-color                   Disable ANSI colors.
  -h, --help                   Show help.
`;
}

function parseArgs(argv) {
  const opts = {
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    baseUrl: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    effort: "high",
    thinking: "enabled",
    maxTokens: 8192,
    timeout: 600000,
    maxToolTurns: null,
    toolMode: "parallel",
    permission: null,
    session: null,
    explicitSession: false,
    saveSession: true,
    resume: false,
    dangerouslyAutoRunCommands: false,
    tools: true,
    color: process.env.NO_COLOR ? false : process.stdout.isTTY
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };

    if (arg === "-h" || arg === "--help") opts.help = true;
    else if (arg === "-p" || arg === "--prompt") opts.prompt = next();
    else if (arg === "--prompt-file") opts.promptFile = next();
    else if (arg === "--stdin") opts.stdin = true;
    else if (arg === "--system") opts.system = next();
    else if (arg === "--system-file") opts.systemFile = next();
    else if (arg === "--print-system") opts.printSystem = true;
    else if (arg === "--model") opts.model = next();
    else if (arg === "--base-url") opts.baseUrl = next();
    else if (arg === "--effort") opts.effort = next();
    else if (arg === "--thinking") opts.thinking = next();
    else if (arg === "--max-tokens") opts.maxTokens = Number.parseInt(next(), 10);
    else if (arg === "--timeout") opts.timeout = Number.parseInt(next(), 10);
    else if (arg === "--max-tool-turns") opts.maxToolTurns = Number.parseInt(next(), 10);
    else if (arg === "--tool-mode") opts.toolMode = next();
    else if (arg === "--permission") opts.permission = next();
    else if (arg === "--session") {
      opts.session = next();
      opts.explicitSession = true;
    }
    else if (arg === "--resume") opts.resume = true;
    else if (arg === "--no-save-session") opts.saveSession = false;
    else if (arg === "--dangerously-auto-run-commands") opts.dangerouslyAutoRunCommands = true;
    else if (arg === "--no-tools") opts.tools = false;
    else if (arg === "--no-color") opts.color = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function validateOpts(opts) {
  if (opts.help || opts.printSystem) return;
  const promptSources = [opts.prompt, opts.promptFile, opts.stdin].filter(Boolean).length;
  if (promptSources === 0) throw new Error("Provide --prompt, --prompt-file, or --stdin.");
  if (promptSources > 1) throw new Error("Use only one prompt source.");
  if (!["enabled", "disabled"].includes(opts.thinking)) throw new Error("--thinking must be enabled or disabled.");
  if (!["high", "max"].includes(opts.effort)) throw new Error("--effort must be high or max.");
  if (!["parallel", "sequential"].includes(opts.toolMode)) throw new Error("--tool-mode must be parallel or sequential.");
  if (opts.permission && !["review", "ask", "full"].includes(opts.permission)) throw new Error("--permission must be review, ask, or full.");
  if (opts.resume && !opts.saveSession) throw new Error("--resume cannot be combined with --no-save-session.");
}

function readStdin() {
  return new Promise((resolvePromise, reject) => {
    let text = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { text += chunk; });
    process.stdin.on("error", reject);
    process.stdin.on("end", () => resolvePromise(text));
  });
}

async function loadPrompt(opts) {
  if (opts.promptFile) return readFile(resolve(opts.promptFile), "utf8");
  if (opts.stdin) return readStdin();
  return opts.prompt;
}

function gitBranch() {
  const result = spawnSync("git", ["branch", "--show-current"], {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function runtimeContext() {
  const branch = gitBranch();
  return [
    `date: ${new Date().toISOString()}`,
    `device_os: ${platform()} ${release()} ${arch()}`,
    `user: ${userInfo().username}`,
    `workspace: ${process.cwd()}`,
    `shell: ${process.env.ComSpec || process.env.SHELL || "unknown"}`,
    `node: ${process.version}`,
    branch ? `git_branch: ${branch}` : "git_branch: none"
  ].join("\n");
}

async function loadSystemPrompt(opts) {
  if (opts.system) return opts.system.replace("{{context}}", runtimeContext());
  let template;
  if (opts.systemFile) {
    template = await readFile(resolve(opts.systemFile), "utf8");
  } else if (EMBEDDED_SYSTEM_PROMPT) {
    template = EMBEDDED_SYSTEM_PROMPT;
  } else {
    template = await readFile(DEFAULT_SYSTEM_PROMPT_FILE, "utf8");
  }
  return template.replace("{{context}}", runtimeContext());
}

function color(opts, code, text) {
  return opts.color ? `\x1b[${code}m${text}\x1b[0m` : text;
}

const ICONS = {
  thinking: "◌",
  final: "▸",
  tools: "◆",
  session: "◉",
  warn: "✕",
  ok: "✓"
};

function dim(opts, text) {
  return color(opts, "2", text);
}

function cyan(opts, text) {
  return color(opts, "36", text);
}

function green(opts, text) {
  return color(opts, "32", text);
}

function yellow(opts, text) {
  return color(opts, "33", text);
}

function red(opts, text) {
  return color(opts, "31", text);
}

function bold(opts, text) {
  return color(opts, "1", text);
}

function label(opts, icon, text, code = "1;36") {
  return color(opts, code, `${icon} ${text}`);
}

function heading(opts, text, kind = "info") {
  const styles = {
    thinking: ["2;36", ICONS.thinking],
    final: ["1;32", ICONS.final],
    tools: ["1;33", ICONS.tools],
    session: ["2;35", ICONS.session],
    warn: ["1;31", ICONS.warn],
    info: ["1;36", "·"]
  };
  const [code, icon] = styles[kind] || styles.info;
  const prefix = `${icon} ${text} `;
  const fill = Math.max(0, 72 - prefix.length);
  process.stdout.write(`\n${color(opts, code, prefix)}${dim(opts, "─".repeat(fill))}\n`);
}

function writeSessionNotice(opts, path) {
  process.stderr.write(`  ${color(opts, "2;35", `${ICONS.session} session`)}  ${dim(opts, path)}\n`);
}

function formatJsonish(raw) {
  try {
    return JSON.stringify(JSON.parse(raw || "{}"), null, 2);
  } catch {
    return raw;
  }
}

function writeToolCall(opts, name, rawArgs) {
  process.stdout.write(`  ${yellow(opts, "▹")} ${bold(opts, name)}\n`);
  process.stdout.write(`${dim(opts, formatJsonish(rawArgs)).split("\n").map((line) => `    ${line}`).join("\n")}\n`);
}

function writeToolResult(opts, result) {
  const text = String(result);
  const display = text.length > 4000 ? `${text.slice(0, 4000)}\n  …` : text;
  const isError = text === "blocked by user" || text.startsWith("Tool error:") || text.startsWith("command error:");
  const code = isError ? "31" : "2";
  process.stdout.write(`${color(opts, code, display.split("\n").map((line) => `    ${line}`).join("\n"))}\n`);
}

function readTextFileDisplay(args, result) {
  const path = args?.path || "(unknown)";
  const text = String(result);
  if (text.startsWith("File too large:")) return `read_text_file ${path}\n${text}`;
  const offset = Number(args?.offset) || 0;
  const suffix = offset > 0 ? ` from offset ${offset}` : "";
  return `read_text_file ${path}${suffix}`;
}

function toolDisplayResult(name, args, result) {
  if (name === "read_text_file") return readTextFileDisplay(args, result);
  return result;
}

function sessionLabel(item, index) {
  const prompt = item.firstUserPrompt.replace(/\s+/g, " ").slice(0, 70);
  const when = item.updatedAt || item.createdAt || "unknown";
  const permission = item.permission ? `[${item.permission}]` : "";
  return `${String(index + 1).padStart(2, " ")}  ${when} ${permission}  ${prompt || "(no prompt)"}`;
}

function renderSessionPicker(opts, items, selected) {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`  ${bold(opts, "DeepSeek  sessions")}\n`);
  process.stdout.write(`  ${dim(opts, "↑↓ navigate  Enter select  Esc cancel")}\n\n`);
  items.forEach((item, index) => {
    const marker = index === selected ? color(opts, "1;32", "▸") : " ";
    const line = `  ${marker} ${sessionLabel(item, index)}`;
    process.stdout.write(`${index === selected ? bold(opts, line) : dim(opts, line)}\n`);
  });
}

function renderDashboard(opts, items, selected) {
  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`  ${bold(opts, "DeepSeek  watch")}\n`);
  process.stdout.write(`  ${dim(opts, "↑↓ navigate  Enter select  Esc quit")}\n\n`);
  items.forEach((item, index) => {
    const marker = index === selected ? color(opts, "1;32", "▸") : " ";
    const line = `  ${marker} ${item.label}`;
    process.stdout.write(`${index === selected ? bold(opts, line) : dim(opts, line)}\n`);
  });
}

async function pickMenu(opts, title, hint, items) {
  return new Promise((resolvePromise) => {
    let selected = 0;
    const stdin = process.stdin;
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const render = () => {
      process.stdout.write("\x1b[2J\x1b[H");
      process.stdout.write(`  ${bold(opts, title)}\n`);
      process.stdout.write(`  ${dim(opts, hint)}\n\n`);
      items.forEach((item, index) => {
        const marker = index === selected ? color(opts, "1;32", "▸") : " ";
        const line = `  ${marker} ${item.label}`;
        process.stdout.write(`${index === selected ? bold(opts, line) : dim(opts, line)}\n`);
      });
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003" || key === "\u001b") {
        cleanup();
        resolvePromise("quit");
        return;
      }
      if (key === "\r" || key === "\n") {
        const id = items[selected].id;
        cleanup();
        resolvePromise(id);
        return;
      }
      if (key === "\u001b[A") selected = Math.max(0, selected - 1);
      if (key === "\u001b[B") selected = Math.min(items.length - 1, selected + 1);
      render();
    };

    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
    render();
  });
}

async function pickDashboardAction(opts) {
  return pickMenu(opts, "DeepSeek Watch", "Arrow keys to move, Enter to select, Esc/Ctrl+C to quit.", [
    { id: "new", label: "New run" },
    { id: "resume", label: "Resume session" },
    { id: "config", label: "Show config path" },
    { id: "help", label: "Show help" },
    { id: "quit", label: "Quit" }
  ]);
}

async function promptLine(question) {
  if (process.stdin.isTTY) {
    return new Promise((resolvePromise) => {
      let value = "";
      const stdin = process.stdin;
      const cleanup = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
      };
      const onData = (chunk) => {
        const key = chunk.toString("utf8");
        if (key === "\u0003") {
          cleanup();
          resolvePromise("/exit");
          return;
        }
        if (key === "\u001b") {
          // Clear typed input and redraw prompt — ESC at idle does nothing actionable
          process.stdout.write("\b \b".repeat(value.length));
          value = "";
          return;
        }
        if (key === "\r" || key === "\n") {
          cleanup();
          resolvePromise(value);
          return;
        }
        if (key === "\b" || key === "\u007f") {
          if (value.length > 0) {
            value = value.slice(0, -1);
            process.stdout.write("\b \b");
          }
          return;
        }
        if (key >= " ") {
          value += key;
          process.stdout.write(key);
        }
      };

      process.stdout.write(question);
      stdin.resume();
      stdin.setRawMode(true);
      stdin.on("data", onData);
    });
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

async function pickPermission(opts) {
  return pickMenu(opts, "Permission level", "Choose what this session may do.", [
    { id: "review", label: "Review only - read files, no shell commands" },
    { id: "ask", label: "Ask before commands - prompt for cmd/PowerShell" },
    { id: "full", label: "Full access - auto-run cmd/PowerShell" }
  ]);
}

async function dashboardOpts() {
  const opts = parseArgs([]);
  if (!process.stdin.isTTY) {
    opts.help = true;
    return opts;
  }

  const action = await pickDashboardAction(opts);
  if (action === "quit") {
    opts.quit = true;
    return opts;
  }
  if (action === "help") {
    opts.help = true;
    return opts;
  }
  if (action === "config") {
    process.stdout.write(`${configPath()}\n`);
    opts.quit = true;
    return opts;
  }

  if (action === "resume") {
    opts.resume = true;
    opts.session = await pickSession(opts);
  } else {
    const permission = await pickPermission(opts);
    if (permission === "quit") {
      opts.quit = true;
      return opts;
    }
    opts.permission = permission;
  }
  opts.interactiveChat = true;
  const prompt = await promptLine("Prompt> ");
  if (!prompt.trim()) {
    opts.quit = true;
    return opts;
  }
  opts.prompt = prompt;
  return opts;
}

async function pickSession(opts) {
  const items = await listSessions();
  if (items.length === 0) throw new Error("No saved sessions found.");
  if (!process.stdin.isTTY) return items[0].path;

  return new Promise((resolvePromise, reject) => {
    let selected = 0;
    const stdin = process.stdin;
    const cleanup = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stdout.write("\n");
    };
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === "\u0003" || key === "\u001b") {
        cleanup();
        reject(new Error("Session selection cancelled."));
        return;
      }
      if (key === "\r" || key === "\n") {
        const path = items[selected].path;
        cleanup();
        resolvePromise(path);
        return;
      }
      if (key === "\u001b[A") selected = Math.max(0, selected - 1);
      if (key === "\u001b[B") selected = Math.min(items.length - 1, selected + 1);
      renderSessionPicker(opts, items, selected);
    };

    stdin.resume();
    stdin.setRawMode(true);
    stdin.on("data", onData);
    renderSessionPicker(opts, items, selected);
  });
}

function toolSchemas(opts) {
  const schemas = [
    {
      type: "function",
      function: {
        name: "get_runtime_context",
        description: "Return OS, shell, workspace, date, Node, and git branch context.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "list_workspace_files",
        description: "List files and directories under the workspace. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative directory. Defaults to workspace root." },
            max: { type: "number", description: "Maximum entries to return. Defaults to 80." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_text_file",
        description: "Read a UTF-8 text file inside the workspace. Prefer start_line/end_line for targeted reads; use offset/max_bytes for chunked byte reads of large files.",
        parameters: {
          type: "object",
          properties: {
            path:       { type: "string", description: "Workspace-relative file path." },
            start_line: { type: "number", description: "First line to read (1-based, inclusive). Returns line text instead of raw bytes." },
            end_line:   { type: "number", description: "Last line to read (1-based, inclusive). Use with start_line. Defaults to start_line + 99." },
            max_bytes:  { type: "number", description: "Max bytes to read in byte mode. Defaults to 20000." },
            offset:     { type: "number", description: "Byte offset to start from in byte mode. Defaults to 0." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    }
  ];

  if (opts.permission === "review") return schemas;

  schemas.push(
    {
      type: "function",
      function: {
        name: "write_text_file",
        description: "Write or overwrite a UTF-8 file inside the workspace. Creates parent directories. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            path:    { type: "string", description: "Workspace-relative file path." },
            content: { type: "string", description: "Full file content to write." }
          },
          required: ["path", "content"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "patch_text_file",
        description: "Replace the first occurrence of old_string with new_string in a workspace file. Fails if old_string is not found. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            path:        { type: "string",  description: "Workspace-relative file path." },
            old_string:  { type: "string",  description: "Exact text to find." },
            new_string:  { type: "string",  description: "Replacement text." },
            replace_all: { type: "boolean", description: "Replace every occurrence instead of just the first. Defaults to false." }
          },
          required: ["path", "old_string", "new_string"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_cmd",
        description: "Request execution of a Windows cmd.exe command in the workspace. The user is prompted unless dangerous auto-run mode is enabled.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "Command text to pass to cmd.exe /d /s /c." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 60000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "run_powershell",
        description: "Request execution of a PowerShell command in the workspace. The user is prompted unless dangerous auto-run mode is enabled.",
        parameters: {
          type: "object",
          properties: {
            command: { type: "string", description: "PowerShell command text." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 60000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    }
  );

  return schemas;
}

async function atomicWriteFile(absPath, content) {
  await mkdir(dirname(absPath), { recursive: true });
  const tmp = `${absPath}.tmp-${process.pid}`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, absPath);
}

function assertInsideWorkspace(path) {
  const root = resolve(process.cwd());
  const localPath = path === "/" || path === "\\" ? "." : path;
  const target = resolve(root, localPath || ".");
  const rel = relative(root, target);
  if (rel === ".." || rel.startsWith(`..\\`) || rel.startsWith("../") || isAbsolute(rel)) {
    throw new Error("Path escapes workspace.");
  }
  return target;
}

function askYesNo(question) {
  if (!process.stdin.isTTY) return Promise.resolve(false);
  return new Promise((resolvePromise) => {
    process.stdout.write(`\n${question} [y/N] `);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (data) => {
      process.stdin.pause();
      resolvePromise(["y", "yes"].includes(data.trim().toLowerCase()));
    });
  });
}

function runLocalCommand(exe, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise(`command error: ${error.message}`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const parts = [`exit_code=${code}`];
      if (timedOut) parts.push("timed_out=true");
      if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
      if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
      resolvePromise(parts.join("\n"));
    });
  });
}

async function maybeRunShellTool(opts, shellName, command, timeoutMs) {
  const timeout = Math.min(Number(timeoutMs) || 60000, 600000);
  if (!command || typeof command !== "string") return "command error: command must be a non-empty string";
  if (opts.permission === "review") return "blocked by session permission: review only";

  if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    const ok = await askYesNo(`Allow ${shellName} command?\n${command}\n`);
    if (!ok) return "blocked by user";
  }

  if (shellName === "cmd") return runLocalCommand("cmd.exe", ["/d", "/s", "/c", command], timeout);
  return runLocalCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], timeout);
}

async function runTool(opts, name, args) {
  if (name === "get_runtime_context") return runtimeContext();

  if (name === "list_workspace_files") {
    const target = assertInsideWorkspace(args.path || ".");
    const max = Math.min(Number(args.max) || 80, 500);
    const entries = await readdir(target, { withFileTypes: true });
    return entries.slice(0, max).map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`).join("\n");
  }

  if (name === "read_text_file") {
    const target = assertInsideWorkspace(args.path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Path is not a file.");

    if (args.start_line != null) {
      const text = await readFile(target, "utf8");
      const lines = text.split("\n");
      const total = lines.length;
      const start = Math.max(1, Number(args.start_line));
      const end = args.end_line != null ? Math.min(Number(args.end_line), total) : Math.min(start + 99, total);
      return `[lines ${start}–${end} of ${total} in ${args.path}]\n${lines.slice(start - 1, end).join("\n")}`;
    }

    const maxBytes = Math.min(Number(args.max_bytes) || 20000, 200000);
    const offset = Math.max(Number(args.offset) || 0, 0);
    const explicitOffset = Object.prototype.hasOwnProperty.call(args, "offset");
    if (info.size > maxBytes && !explicitOffset) {
      return [
        `File too large: ${args.path} is ${info.size} bytes; max_bytes is ${maxBytes}.`,
        "Use start_line/end_line for targeted reads, or offset/max_bytes for byte chunks:",
        `read_text_file {"path":"${args.path}","start_line":1,"end_line":100}`,
        `read_text_file {"path":"${args.path}","offset":0,"max_bytes":${maxBytes}}`
      ].join("\n");
    }
    const data = await readFile(target);
    const dataEnd = Math.min(offset + maxBytes, data.length);
    const chunk = data.subarray(offset, dataEnd).toString("utf8");
    const more = dataEnd < data.length ? `\n\n[chunk ${offset}-${dataEnd} of ${data.length} bytes; continue with offset ${dataEnd}]` : "";
    return `${chunk}${more}`;
  }

  if (name === "write_text_file") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const target = assertInsideWorkspace(args.path);
    if (typeof args.content !== "string") throw new Error("content must be a string.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      let exists = false;
      try { await stat(target); exists = true; } catch {}
      const ok = await askYesNo(`${exists ? "Overwrite" : "Create"} file: ${args.path}?`);
      if (!ok) return "blocked by user";
    }
    await atomicWriteFile(target, args.content);
    return `Wrote ${args.path} (${args.content.length} chars)`;
  }

  if (name === "patch_text_file") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const target = assertInsideWorkspace(args.path);
    const info = await stat(target);
    if (!info.isFile()) throw new Error("Path is not a file.");
    const content = await readFile(target, "utf8");
    if (!content.includes(args.old_string)) throw new Error("old_string not found in file.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      const preview = args.old_string.slice(0, 120);
      const ok = await askYesNo(`Patch ${args.path}?\nReplace: ${preview}${args.old_string.length > 120 ? "…" : ""}`);
      if (!ok) return "blocked by user";
    }
    const replaceAll = args.replace_all === true;
    const newContent = replaceAll
      ? content.split(args.old_string).join(args.new_string)
      : content.replace(args.old_string, args.new_string);
    const count = replaceAll ? content.split(args.old_string).length - 1 : 1;
    await atomicWriteFile(target, newContent);
    return `Patched ${args.path} (${count} replacement${count !== 1 ? "s" : ""})`;
  }

  if (name === "run_cmd") {
    return maybeRunShellTool(opts, "cmd", args.command, args.timeout_ms);
  }

  if (name === "run_powershell") {
    return maybeRunShellTool(opts, "powershell", args.command, args.timeout_ms);
  }

  throw new Error(`Unknown tool: ${name}`);
}

function mergeToolDelta(toolCalls, deltas) {
  for (const delta of deltas || []) {
    const index = delta.index ?? toolCalls.length;
    toolCalls[index] ||= { id: "", type: "function", function: { name: "", arguments: "" } };
    if (delta.id) toolCalls[index].id += delta.id;
    if (delta.type) toolCalls[index].type = delta.type;
    if (delta.function?.name) toolCalls[index].function.name += delta.function.name;
    if (delta.function?.arguments) toolCalls[index].function.arguments += delta.function.arguments;
  }
}

async function executeToolCall(opts, call) {
  const name = call.function?.name || "(unknown)";
  const rawArgs = call.function?.arguments || "{}";
  let args = {};
  let result;

  try {
    args = JSON.parse(rawArgs || "{}");
    result = await runTool(opts, name, args);
  } catch (error) {
    result = `Tool error: ${error.message}`;
  }

  return { call, name, rawArgs, args, result };
}

function shouldRunToolsSequentially(opts, calls) {
  if (opts.toolMode === "sequential") return true;
  if (opts.dangerouslyAutoRunCommands) return false;
  return calls.some((call) => ["run_cmd", "run_powershell"].includes(call.function?.name));
}

async function streamChat(opts, messages) {
  const apiKey = await getDeepSeekApiKey();
  if (!apiKey) throw new Error("No DeepSeek API key found. Run: dsw config set-key <key>");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  const toolCalls = [];
  let content = "";
  let reasoningContent = "";
  let phase = "";
  let interrupted = false;
  let cleanupInterrupt = () => {};

  try {
    if (opts.interactiveChat && process.stdin.isTTY) {
      const stdin = process.stdin;
      const onData = (chunk) => {
        if (chunk.toString("utf8") === "\u001b") {
          interrupted = true;
          process.stdout.write(`\n${red(opts, `${ICONS.warn} interrupted`)}\n`);
          controller.abort();
        }
      };
      stdin.resume();
      stdin.setRawMode(true);
      stdin.on("data", onData);
      cleanupInterrupt = () => {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener("data", onData);
      };
    }

    const body = {
      model: opts.model,
      messages,
      stream: true,
      max_tokens: opts.maxTokens
    };
    applyThinkingOptions(body, opts);
    if (opts.tools) body.tools = toolSchemas(opts);

    const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) throw await deepSeekHttpError(response);
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        const data = JSON.parse(payload);
        const delta = data.choices?.[0]?.delta || {};

        if (delta.reasoning_content) {
          if (phase !== "thinking") {
            heading(opts, "thinking", "thinking");
            phase = "thinking";
          }
          reasoningContent += delta.reasoning_content;
          process.stdout.write(dim(opts, delta.reasoning_content));
        }

        if (delta.content) {
          if (phase !== "final") {
            heading(opts, "final", "final");
            phase = "final";
          }
          content += delta.content;
          process.stdout.write(delta.content);
        }

        if (delta.tool_calls) mergeToolDelta(toolCalls, delta.tool_calls);
      }
    }

    process.stdout.write("\n");
    return { role: "assistant", content, reasoning_content: reasoningContent, tool_calls: toolCalls.length ? toolCalls : undefined };
  } catch (error) {
    if (interrupted) {
      return { role: "assistant", content: "[interrupted by user]", reasoning_content: reasoningContent };
    }
    throw error;
  } finally {
    cleanupInterrupt();
    clearTimeout(timer);
    // Drain any buffered keystrokes (e.g. leftover escape sequence bytes) so
    // the next promptLine() doesn't inherit stale raw-mode input.
    if (process.stdin.isTTY) {
      try { while (process.stdin.read() !== null) {} } catch {}
    }
  }
}

async function processAgentTurns(opts, session) {
  for (let turn = 0; opts.maxToolTurns === null || turn <= opts.maxToolTurns; turn += 1) {
    const assistant = await streamChat(opts, session.messages);
    session.messages.push(assistant);
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));

    if (!assistant.tool_calls?.length) return;
    heading(opts, "tool calls", "tools");

    const sequential = shouldRunToolsSequentially(opts, assistant.tool_calls);
    const executions = sequential
      ? []
      : await Promise.all(assistant.tool_calls.map((call) => executeToolCall(opts, call)));

    for (const call of assistant.tool_calls) {
      const execution = sequential ? await executeToolCall(opts, call) : executions.shift();
      writeToolCall(opts, execution.name, execution.rawArgs);
      writeToolResult(opts, toolDisplayResult(execution.name, execution.args, execution.result));
      session.messages.push({ role: "tool", tool_call_id: execution.call.id, content: String(execution.result) });
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    }
  }

  throw new Error(`Stopped after ${opts.maxToolTurns} tool turns (--max-tool-turns).`);
}

function isExitCommand(text) {
  return ["/exit", "/quit", "/end", "exit", "quit"].includes(text.trim().toLowerCase());
}

async function run() {
  const argv = process.argv.slice(2);
  if (argv[0] === "config") {
    const command = argv[1];
    if (command === "set-key") {
      await setDeepSeekApiKey(argv[2] || "");
      process.stdout.write(`Saved DeepSeek API key to ${configPath()}\n`);
      return;
    }
    if (command === "path") {
      process.stdout.write(`${configPath()}\n`);
      return;
    }
    throw new Error("Unknown config command. Use: dsw config set-key <key>");
  }

  const opts = argv.length === 0 ? await dashboardOpts() : parseArgs(argv);
  if (opts.quit) return;
  validateOpts(opts);

  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  const systemPrompt = await loadSystemPrompt(opts);
  if (opts.printSystem) {
    process.stdout.write(`${systemPrompt}\n`);
    return;
  }

  const userPrompt = await loadPrompt(opts);
  if (!opts.session) {
    opts.session = opts.resume ? await pickSession(opts) : newSessionPath();
  }

  const session = opts.resume
    ? await readSession(opts.session)
    : newSession({
      model: opts.model,
      baseUrl: opts.baseUrl,
      workspace: process.cwd(),
      systemPrompt,
      userPrompt,
      config: {
        permission: opts.permission || (opts.dangerouslyAutoRunCommands ? "full" : "ask"),
        toolMode: opts.toolMode
      }
    });

  opts.permission = opts.permission || session.config?.permission || (opts.dangerouslyAutoRunCommands ? "full" : "ask");
  opts.toolMode = opts.toolMode || session.config?.toolMode || "parallel";
  if (opts.permission === "full") opts.dangerouslyAutoRunCommands = true;
  session.config = { ...(session.config || {}), permission: opts.permission, toolMode: opts.toolMode };

  if (opts.resume) {
    session.messages.push({ role: "user", content: userPrompt });
  }

  if (opts.saveSession) {
    await writeSession(opts.session, touchSession(session));
    writeSessionNotice(opts, sessionPath(opts.session));
  }

  await processAgentTurns(opts, session);

  while (opts.interactiveChat) {
    process.stdout.write(`
  ${dim(opts, "esc clear  ·  ctrl+c exit")}
`);
    const nextPrompt = await promptLine("  ❯ ");
    if (!nextPrompt.trim()) continue;
    if (isExitCommand(nextPrompt)) return;
    session.messages.push({ role: "user", content: nextPrompt });
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    await processAgentTurns(opts, session);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
