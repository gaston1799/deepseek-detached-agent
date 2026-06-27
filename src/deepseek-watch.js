#!/usr/bin/env node
import { appendFile, mkdir, open, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { platform, release, arch, userInfo, homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve, relative, delimiter } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { clearLine, createInterface, cursorTo } from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deepSeekHttpError } from "./api-error.js";
import { configPath, getDeepSeekApiKey, setDeepSeekApiKey } from "./config.js";
import { applyThinkingOptions } from "./deepseek-request.js";
import { listSessions, newSession, newSessionPath, readSession, sessionPath, touchSession, writeSession } from "./session-memory.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
// __SYSTEM_PROMPT__ is replaced with the file's content by the exe build step (esbuild --define).
// In normal dev/npm installs it is undefined and the file is read at runtime instead.
const EMBEDDED_SYSTEM_PROMPT = typeof __SYSTEM_PROMPT__ !== "undefined" ? __SYSTEM_PROMPT__ : null;
const DEFAULT_SYSTEM_PROMPT_FILE = EMBEDDED_SYSTEM_PROMPT ? null : new URL("../prompts/default-system.md", import.meta.url);
const EMBEDDED_UI_APP_DIR = typeof __UI_APP_DIR__ !== "undefined" ? __UI_APP_DIR__ : null;
const UI_APP_DIR = EMBEDDED_UI_APP_DIR || dirname(fileURLToPath(new URL("./ui/main.cjs", import.meta.url)));

function usage() {
  return `dsw  (alias: d)

Usage:
  dsw
  dsw -ui [options]
  dsw doctor
  dsw config set-key <key>
  dsw config set-openai-key <key>
  dsw config path
  dsw -p <prompt> [options]
  dsw --prompt-file <file> [options]
  dsw --stdin [options]

Options:
  -ui, --ui                   Launch the Electron desktop UI instead of the CLI/TUI.
  --ui-port <number>          UI control HTTP port. Default: 17891
  --ui-cdp-port <number>      Electron remote debugging/CDP port. Default: 9223
  -p, --prompt <text>          Prompt content.
  --prompt-file <file>         Read prompt content from a file.
  --stdin                      Read prompt content from stdin.
  --system <text>              System prompt text.
  --system-file <file>         System prompt file. Default: prompts/default-system.md
  --print-system               Print the rendered system prompt and exit.
  --skill <name-or-path>        Load a local skill's SKILL.md into the system prompt. Repeatable.
  --skills <a,b>               Comma-separated skills to load.
  --skill-root <dir>           Directory containing skill folders. Repeatable.
  --list-skills                List discovered local skills and exit.
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
  -o, --output <file>          Write a Markdown result file.
  --outfile <file>             Alias for --output.
  --no-output                  Suppress terminal output. Requires --output/--outfile.
  --full-chat                  Output the full chat transcript instead of final answer + touched files.
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
    output: null,
    noOutput: false,
    fullChat: false,
    resume: false,
    dangerouslyAutoRunCommands: false,
    tools: true,
    skills: [],
    skillRoots: [],
    listSkills: false,
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
    else if (arg === "--skill") opts.skills.push(next());
    else if (arg === "--skills") opts.skills.push(...next().split(",").map((item) => item.trim()).filter(Boolean));
    else if (arg === "--skill-root") opts.skillRoots.push(next());
    else if (arg === "--list-skills") opts.listSkills = true;
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
    else if (arg === "-o" || arg === "--output" || arg === "--outfile") opts.output = next();
    else if (arg === "--no-output") opts.noOutput = true;
    else if (arg === "--full-chat") opts.fullChat = true;
    else if (arg === "--dangerously-auto-run-commands") opts.dangerouslyAutoRunCommands = true;
    else if (arg === "--no-tools") opts.tools = false;
    else if (arg === "--no-color") opts.color = false;
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function validateOpts(opts) {
  if (opts.help || opts.printSystem || opts.listSkills) return;
  const promptSources = [opts.prompt, opts.promptFile, opts.stdin].filter(Boolean).length;
  if (promptSources === 0) throw new Error("Provide --prompt, --prompt-file, or --stdin.");
  if (promptSources > 1) throw new Error("Use only one prompt source.");
  if (!["enabled", "disabled"].includes(opts.thinking)) throw new Error("--thinking must be enabled or disabled.");
  if (!["high", "max"].includes(opts.effort)) throw new Error("--effort must be high or max.");
  if (!["parallel", "sequential"].includes(opts.toolMode)) throw new Error("--tool-mode must be parallel or sequential.");
  if (opts.permission && !["review", "ask", "full"].includes(opts.permission)) throw new Error("--permission must be review, ask, or full.");
  if (opts.resume && !opts.saveSession) throw new Error("--resume cannot be combined with --no-save-session.");
  if (opts.noOutput && !opts.output) throw new Error("--no-output requires --output <file> or --outfile <file>.");
  if (opts.fullChat && !opts.output) throw new Error("--full-chat requires --output <file> or --outfile <file>.");
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

function defaultSkillRoots(opts = {}) {
  const roots = [
    ...(opts.skillRoots || []),
    ...(process.env.DEEPSEEK_SKILLS_DIR ? process.env.DEEPSEEK_SKILLS_DIR.split(delimiter) : []),
    ".deepseek-watch/skills",
    join(homedir(), ".codex", "skills")
  ];
  return [...new Set(roots.filter(Boolean).map((root) => resolve(root)))];
}

function parseSkillFrontmatter(markdown, fallbackName) {
  const text = String(markdown || "");
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const meta = { name: fallbackName, description: "" };
  if (!match) return meta;
  for (const line of match[1].split(/\r?\n/)) {
    const pair = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!pair) continue;
    const key = pair[1];
    const value = pair[2].trim().replace(/^["']|["']$/g, "");
    if (key === "name" && value) meta.name = value;
    if (key === "description" && value) meta.description = value;
  }
  return meta;
}

async function discoverSkills(opts = {}) {
  const roots = defaultSkillRoots(opts);
  const skills = [];
  const seen = new Set();

  async function addSkill(root, folder, skillFile) {
    let text;
    try {
      text = await readFile(skillFile, "utf8");
    } catch {
      return;
    }
    const meta = parseSkillFrontmatter(text, folder);
    const key = `${meta.name}\0${skillFile}`;
    if (seen.has(key)) return;
    seen.add(key);
    skills.push({
      name: meta.name,
      folder,
      description: meta.description,
      root,
      path: skillFile
    });
  }

  async function scanRoot(root, includeHiddenGroups = true) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".")) {
        if (includeHiddenGroups) await scanRoot(join(root, entry.name), false);
        continue;
      }

      const skillFile = join(root, entry.name, "SKILL.md");
      await addSkill(root, entry.name, skillFile);
    }
  }

  for (const root of roots) {
    await scanRoot(root);
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
}

async function resolveSkill(opts, spec) {
  const raw = String(spec || "").trim();
  if (!raw) throw new Error("skill name or path must be non-empty.");

  const direct = resolve(raw);
  const candidates = [
    direct,
    join(direct, "SKILL.md")
  ];
  for (const candidate of candidates) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        const text = await readFile(candidate, "utf8");
        const meta = parseSkillFrontmatter(text, raw);
        return { ...meta, path: candidate, content: text };
      }
    } catch {}
  }

  const skills = await discoverSkills(opts);
  const found = skills.find((skill) => skill.name === raw || skill.folder === raw);
  if (!found) throw new Error(`Skill not found: ${raw}. Use --list-skills or list_skills.`);
  const content = await readFile(found.path, "utf8");
  return { name: found.name, description: found.description, path: found.path, content };
}

async function renderLoadedSkills(opts) {
  if (!opts.skills?.length) return "";
  const loaded = [];
  for (const spec of opts.skills) {
    const skill = await resolveSkill(opts, spec);
    loaded.push([
      `## Skill: ${skill.name}`,
      `Path: ${skill.path}`,
      "",
      skill.content.trim()
    ].join("\n"));
  }
  return [
    "",
    "---",
    "",
    "Loaded local skills:",
    "",
    ...loaded
  ].join("\n");
}

function formatSkillList(skills) {
  if (!skills.length) return "No skills found.";
  return skills.map((skill) => {
    const desc = skill.description ? ` - ${skill.description}` : "";
    return `${skill.name}${desc}\n  ${skill.path}`;
  }).join("\n");
}

function normalizeList(values) {
  return [...new Set((values || []).map((value) => String(value || "").trim()).filter(Boolean))];
}

function updateSystemMessage(session, systemPrompt) {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  const index = messages.findIndex((message) => message.role === "system");
  if (index >= 0) {
    messages[index] = { ...messages[index], content: systemPrompt };
  } else {
    messages.unshift({ role: "system", content: systemPrompt });
  }
  session.messages = messages;
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
  const openAiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const openAiModel = process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini";
  return [
    `date: ${new Date().toISOString()}`,
    `device_os: ${platform()} ${release()} ${arch()}`,
    `user: ${userInfo().username}`,
    `workspace: ${process.cwd()}`,
    `shell: ${process.env.ComSpec || process.env.SHELL || "unknown"}`,
    `node: ${process.version}`,
    `openai_vision: ${openAiConfigured ? "configured" : "not_configured"}`,
    `openai_vision_model: ${openAiModel}`,
    "openai_api_key_setup: https://platform.openai.com/api-keys",
    branch ? `git_branch: ${branch}` : "git_branch: none"
  ].join("\n");
}

async function loadSystemPrompt(opts) {
  if (opts.system) return `${opts.system.replace("{{context}}", runtimeContext())}${await renderLoadedSkills(opts)}`;
  let template;
  if (opts.systemFile) {
    template = await readFile(resolve(opts.systemFile), "utf8");
  } else if (EMBEDDED_SYSTEM_PROMPT) {
    template = EMBEDDED_SYSTEM_PROMPT;
  } else {
    template = await readFile(DEFAULT_SYSTEM_PROMPT_FILE, "utf8");
  }
  return `${template.replace("{{context}}", runtimeContext())}${await renderLoadedSkills(opts)}`;
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

function supportsTerminalLinks(opts) {
  return !opts.noOutput && process.stdout.isTTY && process.env.DEEPSEEK_NO_FILE_LINKS !== "1";
}

function terminalLink(opts, text, target) {
  if (!supportsTerminalLinks(opts)) return text;
  return `\x1b]8;;${target}\x1b\\${text}\x1b]8;;\x1b\\`;
}

function workspaceFileLink(opts, relPath, display = relPath) {
  const text = String(display || relPath || "");
  if (!text) return text;
  try {
    const abs = assertInsideWorkspace(String(relPath));
    return terminalLink(opts, text, pathToFileURL(abs).href);
  } catch {
    return text;
  }
}

function collectPathLikeValues(value, out = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectPathLikeValues(item, out);
    return out;
  }
  if (!value || typeof value !== "object") return out;
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && /(^|_)(path|file)$|^(path|file_path|prompt_file|output_file|log_file)$/i.test(key)) {
      out.add(item);
    } else {
      collectPathLikeValues(item, out);
    }
  }
  return out;
}

function applyKnownFileLinks(opts, text, paths) {
  if (!supportsTerminalLinks(opts)) return text;
  let linked = String(text || "");
  const known = [...paths].filter(Boolean).sort((a, b) => String(b).length - String(a).length);
  for (const value of known) {
    const pathText = String(value);
    linked = linked.replace(new RegExp(escapeRegex(pathText), "g"), workspaceFileLink(opts, pathText));
    if (pathText.includes("\\")) {
      const jsonEscapedPath = pathText.replace(/\\/g, "\\\\");
      linked = linked.replace(new RegExp(escapeRegex(jsonEscapedPath), "g"), workspaceFileLink(opts, pathText, jsonEscapedPath));
    }
  }
  return linked;
}

function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || "").length / 4));
}

const STREAM_STATUS_PHRASES = [
  "Generating",
  "Thinking",
  "Working",
  "Preparing",
  "Drafting"
];

function randomStatusPhrase(phrases = STREAM_STATUS_PHRASES) {
  return phrases[Math.floor(Math.random() * phrases.length)] || "Working";
}

function createStatusLine(opts, phrase = "Working", initialTokens = 0) {
  if (opts.noOutput || !process.stdout.isTTY) {
    return {
      isActive() { return false; },
      addTokens() {},
      setTokens() {},
      setPhrase() {},
      clear() {},
      stop() {}
    };
  }

  let tokens = initialTokens;
  let currentPhrase = phrase;
  let active = true;
  let visible = false;
  const started = Date.now();

  const render = () => {
    if (!active) return;
    const dots = ".".repeat((Math.floor((Date.now() - started) / 750) % 3) + 1);
    clearLine(process.stdout, 0);
    cursorTo(process.stdout, 0);
    process.stdout.write(dim(opts, `  ${currentPhrase}${dots} (${tokens} tokens)`));
    visible = true;
  };

  const timer = setInterval(render, 750);
  render();

  return {
    isActive() {
      return active;
    },
    addTokens(value) {
      tokens += estimateTokens(value);
      render();
    },
    setTokens(value) {
      tokens = Math.max(0, Math.ceil(Number(value) || 0));
      render();
    },
    setPhrase(value) {
      currentPhrase = value || currentPhrase;
      render();
    },
    clear() {
      if (!visible) return;
      clearLine(process.stdout, 0);
      cursorTo(process.stdout, 0);
      visible = false;
    },
    stop() {
      active = false;
      clearInterval(timer);
      this.clear();
    }
  };
}

function toolStatusPhrase(name) {
  if (name === "write_text_file") return "Writing file";
  if (name === "patch_text_file" || name === "patch_files") return "Patching files";
  if (name === "run_cmd" || name === "run_powershell" || name === "functions_shell_command" || name === "functions.shell_command") return "Running command";
  if (name === "web_search" || name === "web_fetch") return "Reading web";
  if (name === "analyze_image_openai" || name === "view_image") return "Reading image";
  return randomStatusPhrase(["Running tool", "Working", "Processing"]);
}

// ── Workspace traversal helpers ────────────────────────────────────────────

const DEFAULT_TRAVERSE_EXCLUDES = [
  ".git", ".deepseek-watch", "node_modules", "dist", "build", "out", ".next", ".nuxt",
  ".cache", "__pycache__", "coverage", ".nyc_output", ".tsbuildinfo"
];

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".webp", ".tiff",
  ".pdf", ".zip", ".tar", ".gz", ".bz2", ".7z", ".rar",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat",
  ".db", ".sqlite", ".sqlite3", ".wasm",
  ".ttf", ".otf", ".woff", ".woff2",
  ".mp3", ".mp4", ".avi", ".mov", ".wav", ".ogg", ".mkv",
  ".class", ".jar", ".pyc"
]);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globToRegex(pattern) {
  let re = "";
  let i = 0;
  const norm = pattern.replace(/\\/g, "/");
  while (i < norm.length) {
    const ch = norm[i];
    if (ch === "*" && norm[i + 1] === "*") {
      re += ".*";
      i += 2;
      if (norm[i] === "/") i++;
    } else if (ch === "*") {
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "{") {
      const end = norm.indexOf("}", i);
      if (end === -1) { re += "\\{"; i++; }
      else {
        const alts = norm.slice(i + 1, end).split(",").map(escapeRegex);
        re += `(?:${alts.join("|")})`;
        i = end + 1;
      }
    } else if (/[.+^$|()[\]\\]/.test(ch)) {
      re += `\\${ch}`;
      i++;
    } else {
      re += ch;
      i++;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

async function isBinaryFile(absPath) {
  if (BINARY_EXTS.has(extname(absPath).toLowerCase())) return true;
  try {
    const fh = await open(absPath, "r");
    try {
      const buf = Buffer.alloc(512);
      const { bytesRead } = await fh.read(buf, 0, 512, 0);
      return buf.subarray(0, bytesRead).includes(0);
    } finally {
      await fh.close();
    }
  } catch {
    return false;
  }
}

async function* walkDir(root, dir, { excludeDirNames = DEFAULT_TRAVERSE_EXCLUDES, excludeGlobRxs = [], type = "all", depth = 0, maxDepth = Infinity } = {}) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const abs = join(dir, entry.name);
    const rel = relative(root, abs).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (excludeDirNames.includes(entry.name)) continue;
      if (excludeGlobRxs.some((rx) => rx.test(rel))) continue;
      if (type !== "file") yield { absPath: abs, relPath: rel, isDir: true };
      if (depth < maxDepth) yield* walkDir(root, abs, { excludeDirNames, excludeGlobRxs, type, depth: depth + 1, maxDepth });
    } else if (entry.isFile()) {
      if (excludeGlobRxs.some((rx) => rx.test(rel))) continue;
      if (type !== "dir") yield { absPath: abs, relPath: rel, isDir: false };
    }
  }
}

async function runGit(gitArgs, cwd = process.cwd()) {
  return new Promise((resolvePromise) => {
    const child = spawn("git", gitArgs, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 30000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { clearTimeout(timer); resolvePromise({ ok: false, out: "", err: err.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolvePromise({ ok: code === 0, out: stdout, err: stderr }); });
  });
}

async function buildTreeLines(absDir, prefix, depth, maxDepth) {
  if (depth > maxDepth) return [];
  let entries;
  try { entries = await readdir(absDir, { withFileTypes: true }); } catch { return []; }
  const visible = entries.filter((e) => !DEFAULT_TRAVERSE_EXCLUDES.includes(e.name));
  const lines = [];
  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i];
    const isLast = i === visible.length - 1;
    lines.push(`${prefix}${isLast ? "└── " : "├── "}${entry.name}${entry.isDirectory() ? "/" : ""}`);
    if (entry.isDirectory() && depth < maxDepth) {
      const sub = await buildTreeLines(join(absDir, entry.name), prefix + (isLast ? "    " : "│   "), depth + 1, maxDepth);
      lines.push(...sub);
    }
  }
  return lines;
}

// ──────────────────────────────────────────────────────────────────────────

function label(opts, icon, text, code = "1;36") {
  return color(opts, code, `${icon} ${text}`);
}

function heading(opts, text, kind = "info") {
  if (opts.noOutput) return;
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
  if (opts.noOutput) return;
  process.stderr.write(`  ${color(opts, "2;35", `${ICONS.session} session`)}  ${dim(opts, terminalLink(opts, path, pathToFileURL(resolve(path)).href))}\n`);
}

function compactDisplayString(value, max = 700) {
  const text = String(value || "");
  if (text.length <= max) return text;
  const head = Math.floor(max * 0.65);
  const tail = Math.max(80, max - head - 80);
  return `${text.slice(0, head)}\n... [truncated ${text.length - max} chars] ...\n${text.slice(-tail)}`;
}

function compactToolArgsForDisplay(value) {
  if (Array.isArray(value)) return value.map(compactToolArgsForDisplay);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" && ["content", "old_string", "new_string"].includes(key)) {
      out[key] = compactDisplayString(item);
      out[`${key}_display_note`] = `truncated for terminal display; original length ${item.length} chars`;
    } else {
      out[key] = compactToolArgsForDisplay(item);
    }
  }
  return out;
}

function formatJsonish(raw, name = "") {
  try {
    const parsed = JSON.parse(raw || "{}");
    const shouldCompact = ["write_text_file", "patch_text_file", "patch_files"].includes(name);
    return JSON.stringify(shouldCompact ? compactToolArgsForDisplay(parsed) : parsed, null, 2);
  } catch {
    return compactDisplayString(raw, 1600);
  }
}

function writeToolCall(opts, name, rawArgs) {
  if (opts.noOutput) return;
  process.stdout.write(`  ${yellow(opts, "▹")} ${bold(opts, name)}\n`);
  let display = formatJsonish(rawArgs, name);
  try {
    display = applyKnownFileLinks(opts, display, collectPathLikeValues(JSON.parse(rawArgs || "{}")));
  } catch {}
  process.stdout.write(`${dim(opts, display).split("\n").map((line) => `    ${line}`).join("\n")}\n`);
}

function writeToolResult(opts, result, knownPaths = []) {
  if (opts.noOutput) return;
  const text = String(result);
  const display = text.length > 4000 ? `${text.slice(0, 4000)}\n  …` : text;
  const isError = text === "blocked by user" || text.startsWith("Tool error:") || text.startsWith("command error:");
  const code = isError ? "31" : "2";
  const paths = new Set([...(knownPaths || []), ...(opts.touchedFiles || [])]);
  const linked = applyKnownFileLinks(opts, display, paths);
  process.stdout.write(`${color(opts, code, linked.split("\n").map((line) => `    ${line}`).join("\n"))}\n`);
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

function nowIso() {
  return new Date().toISOString();
}

function jsonResult(value) {
  return JSON.stringify(value, null, 2);
}

function parseCommandLineArgs(value) {
  const text = String(value || "").trim();
  if (!text) return [];
  const args = [];
  let current = "";
  let quote = "";
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaped) current += "\\";
  if (quote) throw new Error("Unclosed quote in cli_args.");
  if (current) args.push(current);
  return args;
}

function compactMessageForSummary(message, max = 500) {
  const role = message.role || "message";
  if (role === "tool") return `[tool ${message.tool_call_id || ""}] ${compactText(message.content, max)}`;
  if (message.tool_calls?.length) {
    const names = message.tool_calls.map((call) => call.function?.name || "tool").join(", ");
    const content = compactText(message.content || "", max);
    return content ? `[assistant tools: ${names}] ${content}` : `[assistant tools: ${names}]`;
  }
  return `[${role}] ${compactText(message.content || "", max)}`;
}

function decodeHtmlEntities(value) {
  const named = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };
  return String(value || "").replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity) => {
    const key = entity.toLowerCase();
    if (key[0] === "#") {
      const radix = key[1] === "x" ? 16 : 10;
      const codePoint = Number.parseInt(key.slice(radix === 16 ? 2 : 1), radix);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    return Object.prototype.hasOwnProperty.call(named, key) ? named[key] : match;
  });
}

function stripHtml(value) {
  return decodeHtmlEntities(String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim());
}

function htmlToText(value) {
  const html = String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|main|header|footer|aside|nav|h[1-6]|li|tr|blockquote|pre)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  return decodeHtmlEntities(html)
    .replace(/\r\n/g, "\n")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function htmlTitle(value) {
  const match = String(value || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match ? stripHtml(match[1]) : "";
}

function unwrapDuckDuckGoUrl(rawUrl) {
  const decoded = decodeHtmlEntities(rawUrl);
  try {
    const url = new URL(decoded, "https://duckduckgo.com");
    const uddg = url.searchParams.get("uddg");
    return uddg || url.href;
  } catch {
    return decoded;
  }
}

function formatSearchResults(provider, query, results) {
  if (!results.length) return `No ${provider} results for: ${query}`;
  const lines = [`${provider} results for: ${query}`, ""];
  results.forEach((result, index) => {
    lines.push(`${index + 1}. ${result.title || "(untitled)"}`);
    lines.push(`   URL: ${result.url}`);
    if (result.snippet) lines.push(`   Snippet: ${result.snippet}`);
    lines.push("");
  });
  return lines.join("\n").trimEnd();
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function parseDuckDuckGoHtml(html, maxResults) {
  const results = [];
  const blockPattern = /<div[^>]+class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]+class="[^"]*\bresult\b|<\/body>)/gi;
  const blocks = html.match(blockPattern) || [];
  for (const block of blocks) {
    const anchor = block.match(/<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = unwrapDuckDuckGoUrl(anchor[1]);
    const title = stripHtml(anchor[2]);
    if (!url || !title) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>|<div[^>]+class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
    const snippet = stripHtml(snippetMatch?.[1] || snippetMatch?.[2] || "");
    results.push({ title, url, snippet });
    if (results.length >= maxResults) break;
  }
  return results;
}

function parseDuckDuckGoLiteHtml(html, maxResults) {
  const results = [];
  const anchorPattern = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = anchorPattern.exec(html)) && results.length < maxResults) {
    const title = stripHtml(match[2]);
    const url = unwrapDuckDuckGoUrl(match[1]);
    if (!title || !url) continue;
    if (/duckduckgo\.com\/(html|lite)/i.test(url)) continue;
    if (results.some((result) => result.url === url)) continue;
    results.push({ title, url, snippet: "" });
  }
  return results;
}

async function duckDuckGoSearch(query, maxResults, timeRange) {
  const params = new URLSearchParams({ q: query });
  const timeMap = { day: "d", week: "w", month: "m", year: "y" };
  if (timeMap[timeRange]) params.set("df", timeMap[timeRange]);
  const response = await fetchWithTimeout("https://html.duckduckgo.com/html/", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "Mozilla/5.0 deepseek-detached-agent"
    },
    body: params.toString()
  });
  if (!response.ok) throw new Error(`DuckDuckGo search failed: HTTP ${response.status}`);
  const html = await response.text();
  const results = parseDuckDuckGoHtml(html, maxResults);
  if (results.length) return formatSearchResults("DuckDuckGo", query, results);

  const liteUrl = new URL("https://lite.duckduckgo.com/lite/");
  liteUrl.searchParams.set("q", query);
  if (timeMap[timeRange]) liteUrl.searchParams.set("df", timeMap[timeRange]);
  const liteResponse = await fetchWithTimeout(liteUrl, {
    headers: { "User-Agent": "Mozilla/5.0 deepseek-detached-agent" }
  });
  if (!liteResponse.ok) throw new Error(`DuckDuckGo Lite search failed: HTTP ${liteResponse.status}`);
  const liteHtml = await liteResponse.text();
  return formatSearchResults("DuckDuckGo Lite", query, parseDuckDuckGoLiteHtml(liteHtml, maxResults));
}

async function braveSearch(query, maxResults) {
  const key = process.env.BRAVE_SEARCH_API_KEY;
  if (!key) return null;
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "application/json",
      "X-Subscription-Token": key
    }
  });
  if (!response.ok) throw new Error(`Brave search failed: HTTP ${response.status}`);
  const data = await response.json();
  const results = (data.web?.results || []).slice(0, maxResults).map((item) => ({
    title: stripHtml(item.title),
    url: item.url,
    snippet: stripHtml(item.description)
  }));
  return formatSearchResults("Brave Search", query, results);
}

async function webSearch(args) {
  const query = String(args.query || "").trim();
  if (!query) throw new Error("query must be a non-empty string.");
  const maxResults = Math.min(Math.max(Number(args.max_results) || 5, 1), 10);
  const site = String(args.site || "").trim();
  const scopedQuery = site ? `${query} site:${site}` : query;
  const brave = await braveSearch(scopedQuery, maxResults);
  if (brave) return brave;
  return duckDuckGoSearch(scopedQuery, maxResults, args.time_range);
}

async function webFetch(args) {
  const rawUrl = String(args.url || "").trim();
  if (!rawUrl) throw new Error("url must be a non-empty string.");
  const url = new URL(rawUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("url must use http or https.");

  const maxChars = Math.min(Math.max(Number(args.max_chars) || 12000, 1000), 50000);
  const offset = Math.max(Number(args.offset) || 0, 0);
  const response = await fetchWithTimeout(url, {
    headers: {
      "Accept": "text/html, text/plain, application/xhtml+xml, application/xml;q=0.9, */*;q=0.5",
      "User-Agent": "Mozilla/5.0 deepseek-detached-agent"
    }
  }, Math.min(Number(args.timeout_ms) || 20000, 60000));
  if (!response.ok) throw new Error(`Fetch failed: HTTP ${response.status}`);

  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();
  const text = /html|xml|xhtml/i.test(contentType) || /<html|<!doctype html/i.test(raw)
    ? htmlToText(raw)
    : raw.replace(/\r\n/g, "\n").trim();
  const title = /html|xhtml/i.test(contentType) ? htmlTitle(raw) : "";
  const chunk = text.slice(offset, offset + maxChars);
  const nextOffset = offset + maxChars < text.length ? offset + maxChars : null;

  if (args.structured) {
    return JSON.stringify({
      url: url.href,
      title,
      content_type: contentType,
      content: chunk,
      next_offset: nextOffset,
      total_chars: text.length
    }, null, 2);
  }

  const lines = [`URL: ${url.href}`];
  if (title) lines.push(`Title: ${title}`);
  if (contentType) lines.push(`Content-Type: ${contentType}`);
  lines.push("", chunk || "(no readable text)");
  if (nextOffset != null) lines.push("", `[chunk ${offset}-${offset + chunk.length} of ${text.length} chars; continue with offset ${nextOffset}]`);
  return lines.join("\n");
}

const IMAGE_MIME_BY_EXT = new Map([
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".bmp", "image/bmp"],
  [".svg", "image/svg+xml"]
]);

function imageMime(path) {
  return IMAGE_MIME_BY_EXT.get(extname(path).toLowerCase()) || "application/octet-stream";
}

function imageDimensions(buffer, mime) {
  if (mime === "image/png" && buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (mime === "image/gif" && buffer.length >= 10 && buffer.toString("ascii", 0, 3) === "GIF") {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (mime === "image/bmp" && buffer.length >= 26 && buffer.toString("ascii", 0, 2) === "BM") {
    return { width: buffer.readUInt32LE(18), height: Math.abs(buffer.readInt32LE(22)) };
  }
  if (mime === "image/webp" && buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const chunk = buffer.toString("ascii", 12, 16);
    if (chunk === "VP8X" && buffer.length >= 30) {
      return {
        width: 1 + buffer.readUIntLE(24, 3),
        height: 1 + buffer.readUIntLE(27, 3)
      };
    }
    if (chunk === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
  }
  if (mime === "image/svg+xml") {
    const text = buffer.subarray(0, Math.min(buffer.length, 5000)).toString("utf8");
    const svg = text.match(/<svg\b[^>]*>/i)?.[0] || "";
    const width = Number.parseFloat(svg.match(/\bwidth=["']?([0-9.]+)/i)?.[1] || "");
    const height = Number.parseFloat(svg.match(/\bheight=["']?([0-9.]+)/i)?.[1] || "");
    if (Number.isFinite(width) && Number.isFinite(height)) return { width, height };
    const viewBox = svg.match(/\bviewBox=["']\s*[-0-9.]+\s+[-0-9.]+\s+([0-9.]+)\s+([0-9.]+)/i);
    if (viewBox) return { width: Number.parseFloat(viewBox[1]), height: Number.parseFloat(viewBox[2]) };
  }
  if (mime === "image/jpeg" && buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) { offset += 1; continue; }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      if (length < 2) break;
      if (marker >= 0xc0 && marker <= 0xc3) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}

async function viewImage(args) {
  const target = assertInsideWorkspace(args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Path is not a file.");
  const mime = imageMime(args.path);
  if (!mime.startsWith("image/")) throw new Error(`Unsupported image extension: ${extname(args.path) || "(none)"}`);
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 4000000, 1), 12000000);
  const includeData = args.include_data_url !== false;
  const buffer = await readFile(target);
  const dimensions = imageDimensions(buffer, mime);
  const result = {
    path: args.path,
    mime,
    size_bytes: info.size,
    dimensions,
    vision_available: false,
    note: "This tool does not visually interpret image content. Use analyze_image_openai for real image understanding when OPENAI_API_KEY is configured.",
    data_url_included: includeData && buffer.length <= maxBytes
  };
  if (includeData && buffer.length <= maxBytes) {
    result.data_url = `data:${mime};base64,${buffer.toString("base64")}`;
  } else if (includeData) {
    result.data_url_note = `Image is ${buffer.length} bytes, above max_bytes=${maxBytes}; raise max_bytes or set include_data_url=false for metadata only.`;
  }
  return JSON.stringify(result, null, 2);
}

function extractOpenAiOutputText(data) {
  if (typeof data.output_text === "string" && data.output_text.trim()) return data.output_text.trim();
  const chunks = [];
  for (const item of data.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") chunks.push(content.text);
      if (typeof content.output_text === "string") chunks.push(content.output_text);
    }
  }
  return chunks.join("\n").trim();
}

async function analyzeImageOpenAI(args) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set. Create an OpenAI API key, then set $env:OPENAI_API_KEY before running d/dsw.");

  const target = assertInsideWorkspace(args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("Path is not a file.");
  const mime = imageMime(args.path);
  if (!mime.startsWith("image/")) throw new Error(`Unsupported image extension: ${extname(args.path) || "(none)"}`);
  const buffer = await readFile(target);
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 12000000, 1), 20000000);
  if (buffer.length > maxBytes) {
    throw new Error(`Image is ${buffer.length} bytes, above max_bytes=${maxBytes}. Crop/compress it or raise max_bytes.`);
  }

  const prompt = String(args.prompt || "Describe the image precisely. If it contains text or code, transcribe it exactly before summarizing.").trim();
  const model = String(args.model || process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini").trim();
  const maxOutputTokens = Math.min(Math.max(Number(args.max_output_tokens) || 1200, 100), 8000);
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const response = await fetchWithTimeout("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_output_tokens: maxOutputTokens,
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: prompt },
            { type: "input_image", image_url: dataUrl }
          ]
        }
      ]
    })
  }, Math.min(Number(args.timeout_ms) || 60000, 180000));

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`OpenAI vision request failed: HTTP ${response.status}${text ? ` ${compactText(text, 800)}` : ""}`);
  }

  const data = await response.json();
  const output = extractOpenAiOutputText(data);
  if (!output) return JSON.stringify({ path: args.path, model, output: "", raw_status: data.status || null }, null, 2);
  return output;
}

function compactText(value, max = 900) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n...`;
}

function historyTitle(message) {
  if (message.role === "user") return "you";
  if (message.role === "assistant") return "assistant";
  if (message.role === "tool") return "tool";
  return message.role || "message";
}

function historyBody(message) {
  if (message.role === "tool") {
    return compactText(message.content, 500);
  }

  if (message.tool_calls?.length) {
    const calls = message.tool_calls
      .map((call) => call.function?.name || "tool")
      .join(", ");
    const content = compactText(message.content, 500);
    return content ? `${content}\n[tool calls: ${calls}]` : `[tool calls: ${calls}]`;
  }

  return compactText(message.content, message.role === "assistant" ? 900 : 700);
}

function renderChatHistory(opts, session, maxMessages = 18) {
  const messages = (session.messages || [])
    .filter((message) => message.role !== "system")
    .slice(-maxMessages);

  process.stdout.write("\x1b[2J\x1b[H");
  process.stdout.write(`  ${bold(opts, "Session history")}\n`);
  process.stdout.write(`  ${dim(opts, `permission ${session.config?.permission || "ask"}  -  ${messages.length} shown`)}\n\n`);

  if (messages.length === 0) {
    process.stdout.write(`  ${dim(opts, "No previous messages.")}\n\n`);
    return;
  }

  for (const message of messages) {
    const title = historyTitle(message);
    const body = historyBody(message);
    const colorCode = message.role === "user" ? "1;36" : message.role === "assistant" ? "1;32" : "1;33";
    process.stdout.write(`  ${color(opts, colorCode, title)}\n`);
    process.stdout.write(`${dim(opts, body.split("\n").map((line) => `    ${line}`).join("\n"))}\n\n`);
  }
}

function sessionLabel(item, index) {
  const prompt = item.firstUserPrompt.replace(/\s+/g, " ").slice(0, 70);
  const when = item.updatedAt || item.createdAt || "unknown";
  const permission = item.permission ? `[${item.permission}]` : "";
  return `${String(index + 1).padStart(2, " ")}  ${when} ${permission}  ${prompt || "(no prompt)"}`;
}

async function pickMenu(opts, title, hint, items) {
  process.stdout.write(`\n  ${bold(opts, title)}\n`);
  process.stdout.write(`  ${dim(opts, hint)}\n\n`);
  items.forEach((item, i) => {
    process.stdout.write(`  ${dim(opts, `${i + 1}.`)} ${item.label}\n`);
  });
  process.stdout.write("\n");
  while (true) {
    const answer = await promptLine(`  Enter choice (1-${items.length}, q to quit): `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "") return "quit";
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= items.length) return items[n - 1].id;
    process.stdout.write(`  Invalid. Enter 1-${items.length} or q.\n`);
  }
}

async function pickDashboardAction(opts) {
  return pickMenu(opts, "DeepSeek Watch", "Enter a number and press Enter. q to quit.", [
    { id: "new", label: "New run" },
    { id: "resume", label: "Resume session" },
    { id: "config", label: "Show config path" },
    { id: "help", label: "Show help" },
    { id: "quit", label: "Quit" }
  ]);
}

function promptLine(question) {
  return new Promise((resolve) => {
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try { process.stdin.setRawMode(false); } catch {}
    }
    process.stdin.resume();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on("SIGINT", () => {
      rl.close();
      process.stdout.write("\n");
      process.exit(0);
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
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
    const session = await readSession(opts.session);
    renderChatHistory(opts, session);
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

  process.stdout.write(`\n  ${bold(opts, "Sessions")}\n\n`);
  items.forEach((item, i) => {
    process.stdout.write(`  ${sessionLabel(item, i)}\n`);
  });
  process.stdout.write("\n");
  while (true) {
    const answer = await promptLine(`  Choose session (1-${items.length}, q to cancel): `);
    const trimmed = answer.trim().toLowerCase();
    if (trimmed === "q" || trimmed === "") throw new Error("Session selection cancelled.");
    const n = parseInt(trimmed, 10);
    if (n >= 1 && n <= items.length) return items[n - 1].path;
    process.stdout.write(`  Invalid. Enter 1-${items.length} or q.\n`);
  }
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
        description: "List files and directories under the workspace. Supports recursive listing, glob filtering, and metadata. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path:             { type: "string",  description: "Workspace-relative directory. Defaults to workspace root." },
            recursive:        { type: "boolean", description: "Recurse into subdirectories. Default false (flat listing for backwards compat)." },
            glob:             { type: "string",  description: "Glob pattern to filter entries, e.g. '**/*.ts'." },
            exclude_glob:     { type: "string",  description: "Glob pattern to exclude entries, e.g. '**/*.min.js'." },
            exclude_patterns: { type: "array",   items: { type: "string" }, description: "Additional directory names to exclude beyond the default set." },
            max:              { type: "number",  description: "Max entries to return. Default 200." },
            offset:           { type: "number",  description: "Pagination cursor. Default 0." },
            type:             { type: "string",  enum: ["file", "dir", "all"], description: "Filter by entry type. Default all." },
            include_metadata: { type: "boolean", description: "Include size_bytes and modified_iso per entry. Default false." }
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
            path:       { type: "string",  description: "Workspace-relative file path." },
            start_line: { type: "number",  description: "First line to read (1-based, inclusive). Returns line text instead of raw bytes." },
            end_line:   { type: "number",  description: "Last line to read (1-based, inclusive). Use with start_line. Defaults to start_line + 99." },
            max_bytes:  { type: "number",  description: "Max bytes to read in byte mode. Defaults to 20000." },
            offset:     { type: "number",  description: "Byte offset to start from in byte mode. Defaults to 0." },
            structured: { type: "boolean", description: "Return JSON {content, next_offset, total_bytes} instead of plain text. Enables cursor-based chained reads." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "view_image",
        description: "Read a workspace image file and return JSON metadata, dimensions when detectable, and a base64 data URL when small enough. Does not visually interpret content. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative image path." },
            include_data_url: { type: "boolean", description: "Include a data:image/... base64 URL. Default true." },
            max_bytes: { type: "number", description: "Maximum image bytes to include in data_url. Default 4000000, max 12000000." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "analyze_image_openai",
        description: "Use OpenAI vision to visually inspect a workspace image and return text analysis or exact transcription. Requires OPENAI_API_KEY. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative image path." },
            prompt: { type: "string", description: "Vision prompt. For screenshots/code, ask to transcribe text exactly before summarizing." },
            model: { type: "string", description: "OpenAI vision-capable model. Defaults to OPENAI_VISION_MODEL or gpt-4.1-mini." },
            max_output_tokens: { type: "number", description: "Maximum OpenAI output tokens. Default 1200, max 8000." },
            max_bytes: { type: "number", description: "Maximum image bytes to send. Default 12000000, max 20000000." },
            timeout_ms: { type: "number", description: "OpenAI request timeout. Default 60000, max 180000." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "list_skills",
        description: "List local skills discovered from --skill-root, DEEPSEEK_SKILLS_DIR, .deepseek-watch/skills, and ~/.codex/skills. Read-only.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "read_skill",
        description: "Read a local skill's SKILL.md by skill name, folder name, or path. Use this before following a skill that was not loaded with --skill. Read-only.",
        parameters: {
          type: "object",
          properties: {
            name: { type: "string", description: "Skill name, skill folder name, SKILL.md path, or skill directory path." }
          },
          required: ["name"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_search",
        description: "Search the web for current or external information. Read-only. Uses BRAVE_SEARCH_API_KEY when set, otherwise DuckDuckGo HTML/Lite results.",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query." },
            max_results: { type: "number", description: "Number of results to return, 1-10. Defaults to 5." },
            site: { type: "string", description: "Optional domain to restrict results, e.g. github.com." },
            time_range: { type: "string", enum: ["day", "week", "month", "year"], description: "Optional freshness hint for DuckDuckGo fallback." }
          },
          required: ["query"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "web_fetch",
        description: "Fetch a URL and return readable page text. Use after web_search when snippets are not enough. Read-only.",
        parameters: {
          type: "object",
          properties: {
            url: { type: "string", description: "HTTP or HTTPS URL to fetch." },
            max_chars: { type: "number", description: "Maximum text characters to return. Default 12000, max 50000." },
            offset: { type: "number", description: "Character offset for reading the next chunk of a long page. Default 0." },
            timeout_ms: { type: "number", description: "Fetch timeout in milliseconds. Default 20000, max 60000." },
            structured: { type: "boolean", description: "Return JSON with content, next_offset, total_chars, title, and content_type." }
          },
          required: ["url"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "create_goal",
        description: "Create or replace the current persistent session goal. Stored in the session JSON.",
        parameters: {
          type: "object",
          properties: {
            objective: { type: "string", description: "Concrete objective for the session." },
            token_budget: { type: "number", description: "Optional positive token budget." }
          },
          required: ["objective"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_goal",
        description: "Return the current persistent session goal, or null if none exists.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "update_goal",
        description: "Mark the current goal complete or blocked and optionally add a note.",
        parameters: {
          type: "object",
          properties: {
            status: { type: "string", enum: ["complete", "blocked"], description: "Final goal status." },
            note: { type: "string", description: "Optional note explaining the status." }
          },
          required: ["status"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "update_plan",
        description: "Replace the visible persistent session plan with explicit step statuses.",
        parameters: {
          type: "object",
          properties: {
            explanation: { type: "string", description: "Optional plan update note." },
            plan: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  step: { type: "string", description: "Task step." },
                  status: { type: "string", enum: ["pending", "in_progress", "completed"], description: "Step status." }
                },
                required: ["step", "status"],
                additionalProperties: false
              }
            }
          },
          required: ["plan"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_plan",
        description: "Return the current persistent session plan.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "session_health",
        description: "Report saved-session health, goal status, plan progress, checkpoints, touched files, and tool-call repair needs.",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    },
    {
      type: "function",
      function: {
        name: "checkpoint_session",
        description: "Append a compact checkpoint to the session JSON.",
        parameters: {
          type: "object",
          properties: {
            label: { type: "string", description: "Optional checkpoint label." },
            summary: { type: "string", description: "Optional checkpoint summary." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "summarize_session",
        description: "Return a compact recent session summary without dumping the full transcript.",
        parameters: {
          type: "object",
          properties: {
            max_messages: { type: "number", description: "Number of recent non-system messages to summarize. Default 12, max 50." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "handoff_status",
        description: "Inspect a handoff output file and optional log tail. Read-only.",
        parameters: {
          type: "object",
          properties: {
            output_file: { type: "string", description: "Workspace-relative handoff output file." },
            log_file: { type: "string", description: "Optional workspace-relative handoff log file." },
            tail_lines: { type: "number", description: "Optional log tail line count. Default 40, max 200." }
          },
          required: ["output_file"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "handoff_wait",
        description: "Wait for a handoff output file to appear and optionally print its content. Read-only.",
        parameters: {
          type: "object",
          properties: {
            output_file: { type: "string", description: "Workspace-relative handoff output file." },
            timeout_seconds: { type: "number", description: "Timeout in seconds. Default 300, max 7200." },
            poll_ms: { type: "number", description: "Polling interval in milliseconds. Default 1000." },
            print_content: { type: "boolean", description: "Include output file content when found. Default false." }
          },
          required: ["output_file"],
          additionalProperties: false
        }
      }
    }
  ];

  schemas.push(
    {
      type: "function",
      function: {
        name: "search_code",
        description: "Search workspace files for a regex or literal pattern. Skips binary files and common build/dep dirs. Read-only.",
        parameters: {
          type: "object",
          properties: {
            pattern:          { type: "string",  description: "Regex or literal string to search for." },
            path:             { type: "string",  description: "Workspace-relative file or subdirectory to scope the search." },
            glob:             { type: "string",  description: "File filter glob, e.g. '*.ts' or 'src/**/*.js'." },
            ignore_case:      { type: "boolean", description: "Case-insensitive match. Default false." },
            max_results:      { type: "number",  description: "Max matches to return. Default 200." },
            context_lines:    { type: "number",  description: "Lines of surrounding context per match (0–5). Default 0." },
            respect_gitignore:{ type: "boolean", description: "Apply default excludes (.git, node_modules, dist, …). Default true." }
          },
          required: ["pattern"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "read_text_files",
        description: "Batch-read multiple workspace files in one call. Returns a JSON object keyed by path. Per-file errors don't fail the batch. Read-only.",
        parameters: {
          type: "object",
          properties: {
            files: {
              type: "array",
              description: "List of files to read.",
              items: {
                type: "object",
                properties: {
                  path:       { type: "string", description: "Workspace-relative file path." },
                  start_line: { type: "number", description: "First line (1-based, inclusive)." },
                  end_line:   { type: "number", description: "Last line (1-based, inclusive)." },
                  max_bytes:  { type: "number", description: "Max bytes to read. Default 20000." }
                },
                required: ["path"],
                additionalProperties: false
              }
            }
          },
          required: ["files"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_status",
        description: "Show git working-tree status (short format). Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path to scope." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_diff",
        description: "Show git diff. Defaults to unstaged changes. Read-only.",
        parameters: {
          type: "object",
          properties: {
            staged:        { type: "boolean", description: "Show staged (indexed) changes. Default false." },
            target_branch: { type: "string",  description: "Compare against this branch/ref, e.g. 'main'." },
            path:          { type: "string",  description: "Scope diff to this workspace-relative path." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_log",
        description: "Show git commit log (one-line format). Read-only.",
        parameters: {
          type: "object",
          properties: {
            path:        { type: "string", description: "Scope log to this workspace-relative path." },
            max_entries: { type: "number", description: "Max commits to return. Default 20." }
          },
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "git_blame",
        description: "Show git blame for a file (who last changed each line). Read-only.",
        parameters: {
          type: "object",
          properties: {
            file_path:  { type: "string", description: "Workspace-relative file path." },
            start_line: { type: "number", description: "First line to blame (1-based)." },
            end_line:   { type: "number", description: "Last line to blame (1-based)." }
          },
          required: ["file_path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "stat_file",
        description: "Return metadata for a file or directory: size, modification time, type, binary flag. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "glob",
        description: "Discover workspace files matching a glob pattern (no shell). Read-only.",
        parameters: {
          type: "object",
          properties: {
            pattern: { type: "string", description: "Glob pattern, e.g. 'packages/*/package.json' or 'src/**/*.ts'." },
            max:     { type: "number", description: "Max paths to return. Default 100." }
          },
          required: ["pattern"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "cache_set",
        description: "Store a string value in the session cache under a key. Saved with the session JSON for resumed runs.",
        parameters: {
          type: "object",
          properties: {
            key:   { type: "string", description: "Cache key." },
            value: { type: "string", description: "String value to store." }
          },
          required: ["key", "value"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "cache_get",
        description: "Retrieve a value from the session cache by key. Returns the string value or 'null' if not set.",
        parameters: {
          type: "object",
          properties: {
            key: { type: "string", description: "Cache key to look up." }
          },
          required: ["key"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "path_exists",
        description: "Check whether a workspace path exists. Returns JSON {exists, type}. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "is_text_file",
        description: "Sniff first 512 bytes to determine whether a file is text or binary. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "get_related_files",
        description: "Scan a file for import/require/include statements and return the referenced module paths. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "Workspace-relative file path." }
          },
          required: ["path"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "tree",
        description: "Print a visual directory tree (like the 'tree' command). Skips common build/dep directories. Read-only.",
        parameters: {
          type: "object",
          properties: {
            path:      { type: "string", description: "Workspace-relative root. Defaults to workspace root." },
            max_depth: { type: "number", description: "Maximum tree depth. Default 3, max 8." }
          },
          additionalProperties: false
        }
      }
    }
  );

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
        name: "patch_files",
        description: "Apply multiple old_string→new_string replacements across one or more files atomically. All old_strings must match before any file is written. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            edits: {
              type: "array",
              description: "List of edits to apply.",
              items: {
                type: "object",
                properties: {
                  path:        { type: "string",  description: "Workspace-relative file path." },
                  old_string:  { type: "string",  description: "Exact text to find." },
                  new_string:  { type: "string",  description: "Replacement text." },
                  replace_all: { type: "boolean", description: "Replace every occurrence instead of just the first." }
                },
                required: ["path", "old_string", "new_string"],
                additionalProperties: false
              }
            }
          },
          required: ["edits"],
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
    },
    {
      type: "function",
      function: {
        name: "functions_shell_command",
        description: "Execute a shell command in the workspace using PowerShell on Windows. Supports an optional workspace-relative working directory. Blocked in review permission mode. User is prompted unless full/auto-run mode.",
        parameters: {
          type: "object",
          properties: {
            command:    { type: "string", description: "Command to run." },
            workdir:    { type: "string", description: "Workspace-relative working directory. Defaults to workspace root." },
            timeout_ms: { type: "number", description: "Timeout in milliseconds. Defaults to 120000." }
          },
          required: ["command"],
          additionalProperties: false
        }
      }
    },
    {
      type: "function",
      function: {
        name: "handoff_start",
        description: "Start a bounded delegated LLM handoff. Writes CLI output to a log file and rejects stale output files.",
        parameters: {
          type: "object",
          properties: {
            prompt_file: { type: "string", description: "Workspace-relative prompt file to read." },
            output_file: { type: "string", description: "Workspace-relative output file expected from the handoff." },
            log_file: { type: "string", description: "Workspace-relative log file for CLI stdout/stderr." },
            cli: { type: "string", description: "CLI executable. Default claude." },
            cli_args: { type: "string", description: "Optional CLI arguments, shell-like quoted string." },
            timeout_seconds: { type: "number", description: "Timeout hint included in status output. Default 7200." }
          },
          required: ["prompt_file", "output_file", "log_file"],
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

async function writeAtomicMarkdown(path, content) {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  await writeFile(tmp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  await rename(tmp, out);
}

function markdownFence(value) {
  const text = String(value || "");
  const fence = text.includes("```") ? "````" : "```";
  return `${fence}\n${text}\n${fence}`;
}

function finalAssistantContent(session) {
  const messages = session.messages || [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === "assistant" && typeof message.content === "string" && message.content.trim()) {
      return message.content.trim();
    }
  }
  return "";
}

function formatTouchedFiles(session) {
  const files = [...new Set(session.touchedFiles || [])].sort();
  if (!files.length) return "- None";
  return files.map((file) => `- ${file}`).join("\n");
}

function formatOutputMarkdown(opts, session) {
  if (opts.fullChat) {
    const lines = ["# DeepSeek Watch Transcript", ""];
    for (const message of session.messages || []) {
      if (message.role === "system") continue;
      lines.push(`## ${historyTitle(message)}`, "");
      if (message.reasoning_content) {
        lines.push("### Thinking", "", message.reasoning_content.trim(), "");
      }
      if (message.tool_calls?.length) {
        lines.push("### Tool Calls", "");
        for (const call of message.tool_calls) {
          lines.push(`#### ${call.function?.name || "tool"}`, "", markdownFence(call.function?.arguments || "{}"), "");
        }
        lines.push("");
      }
      lines.push(message.content ? message.content.trim() : "(empty)", "");
    }
    lines.push("## Files Touched", "", formatTouchedFiles(session), "");
    return lines.join("\n");
  }

  return [
    "# DeepSeek Watch Result",
    "",
    "## Final Response",
    "",
    finalAssistantContent(session) || "(no final response)",
    "",
    "## Files Touched",
    "",
    formatTouchedFiles(session),
    ""
  ].join("\n");
}

async function maybeWriteOutput(opts, session) {
  if (!opts.output) return;
  await writeAtomicMarkdown(opts.output, formatOutputMarkdown(opts, session));
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

function runLocalCommand(exe, args, timeoutMs, cwd = process.cwd()) {
  return new Promise((resolvePromise) => {
    const child = spawn(exe, args, {
      cwd,
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

function commandStatus(command, args = ["--version"]) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    windowsHide: true
  });
  return {
    ok: result.status === 0,
    status: result.status,
    stdout: (result.stdout || "").trim(),
    stderr: (result.stderr || "").trim(),
    error: result.error?.message || ""
  };
}

function maskedSecretStatus(value) {
  if (!value) return "not set";
  const text = String(value);
  if (text.length <= 10) return "set";
  return `set (${text.slice(0, 7)}...${text.slice(-4)})`;
}

function setUserEnvironmentVariable(name, value) {
  const key = String(value || "").trim();
  if (!key) throw new Error(`${name} cannot be empty.`);
  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `[Environment]::SetEnvironmentVariable('${name}', $env:DSW_SECRET_VALUE, 'User')`
      ],
      {
        encoding: "utf8",
        windowsHide: true,
        env: { ...process.env, DSW_SECRET_VALUE: key }
      }
    );
    if (result.status !== 0) {
      throw new Error((result.stderr || result.stdout || `Failed to set ${name}`).trim());
    }
    return `${name} saved to the Windows user environment. Open a new terminal for it to appear automatically.`;
  }
  throw new Error(`Automatic persistent ${name} setup is only implemented on Windows. Add export ${name}="..." to your shell profile.`);
}

async function doctor() {
  const deepSeekKey = await getDeepSeekApiKey();
  const openAiKey = process.env.OPENAI_API_KEY || "";
  const skills = await discoverSkills({});
  const dswStatus = commandStatus("dsw", ["--help"]);
  const pbcStatus = commandStatus("pbc", ["--help"]);
  const lines = [
    "DeepSeek Watch Doctor",
    "",
    `Workspace: ${process.cwd()}`,
    `Node: ${process.version}`,
    `Config path: ${configPath()}`,
    "",
    "DeepSeek",
    `  API key: ${deepSeekKey ? maskedSecretStatus(deepSeekKey) : "not set"}`,
    `  Setup: dsw config set-key <deepseek-key>`,
    "",
    "OpenAI vision",
    `  OPENAI_API_KEY: ${maskedSecretStatus(openAiKey)}`,
    `  OPENAI_VISION_MODEL: ${process.env.OPENAI_VISION_MODEL || "gpt-4.1-mini (default)"}`,
    `  Tool: analyze_image_openai ${openAiKey ? "available" : "blocked until OPENAI_API_KEY is set"}`,
    "  Create key: https://platform.openai.com/api-keys",
    "  Billing/limits: https://platform.openai.com/settings/organization/billing/overview",
    "  Current terminal: $env:OPENAI_API_KEY = \"sk-proj-...\"",
    "  Persist for new terminals: dsw config set-openai-key <openai-key>",
    "",
    "CLI",
    `  dsw on PATH: ${dswStatus.ok ? "yes" : "no"}`,
    `  pbc on PATH: ${pbcStatus.ok ? "yes" : "no"}`,
    "",
    "Skills",
    `  discovered: ${skills.length}`,
    ...skills.slice(0, 8).map((skill) => `  - ${skill.name}: ${skill.path}`),
    skills.length > 8 ? `  ... ${skills.length - 8} more` : ""
  ].filter((line) => line !== "");
  return lines.join("\n");
}

async function maybeRunShellTool(opts, shellName, command, timeoutMs, cwd = process.cwd()) {
  const timeout = Math.min(Number(timeoutMs) || 60000, 600000);
  if (!command || typeof command !== "string") return "command error: command must be a non-empty string";
  if (opts.permission === "review") return "blocked by session permission: review only";

  if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const ok = await askYesNo(`Allow ${shellName} command?\n${command}\n`);
    if (!ok) return "blocked by user";
  }

  if (shellName === "cmd") return runLocalCommand("cmd.exe", ["/d", "/s", "/c", command], timeout, cwd);
  return runLocalCommand("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], timeout, cwd);
}

function activeSession(opts) {
  if (!opts.sessionObject) throw new Error("No active session object.");
  return opts.sessionObject;
}

function validatePlanItems(plan) {
  if (!Array.isArray(plan)) throw new Error("plan must be an array.");
  const allowed = new Set(["pending", "in_progress", "completed"]);
  return plan.map((item, index) => {
    const step = String(item?.step || "").trim();
    const status = String(item?.status || "").trim();
    if (!step) throw new Error(`plan[${index}].step must be non-empty.`);
    if (!allowed.has(status)) throw new Error(`plan[${index}].status must be pending, in_progress, or completed.`);
    return { step, status };
  });
}

function planProgress(plan = []) {
  const counts = { pending: 0, in_progress: 0, completed: 0, total: plan.length };
  for (const item of plan) {
    if (Object.prototype.hasOwnProperty.call(counts, item.status)) counts[item.status] += 1;
  }
  return counts;
}

async function pathExistsAbs(absPath) {
  try {
    await stat(absPath);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function readTail(absPath, tailLines) {
  try {
    const text = await readFile(absPath, "utf8");
    const lines = text.split(/\r?\n/);
    return lines.slice(-tailLines).join("\n");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function handoffCliArgs(cli, prompt, promptFile, cliArgs) {
  const parsed = parseCommandLineArgs(cliArgs);
  const lower = String(cli || "").toLowerCase();
  if (lower.includes("claude")) return ["-p", prompt, ...parsed];
  const hasPrompt = parsed.some((arg) => ["-p", "--prompt", "--prompt-file", "--stdin"].includes(arg));
  if (hasPrompt) return parsed;
  return ["--prompt-file", promptFile, ...parsed];
}

async function runTool(opts, name, args) {
  if (name === "get_runtime_context") return runtimeContext();

  if (name === "create_goal") {
    const session = activeSession(opts);
    const objective = String(args.objective || "").trim();
    if (!objective) throw new Error("objective must be non-empty.");
    const budget = args.token_budget == null ? undefined : Number(args.token_budget);
    if (budget !== undefined && (!Number.isFinite(budget) || budget <= 0)) throw new Error("token_budget must be positive when provided.");
    const now = nowIso();
    session.goal = {
      objective,
      status: "active",
      ...(budget !== undefined ? { token_budget: budget } : {}),
      createdAt: now,
      updatedAt: now,
      notes: []
    };
    return jsonResult(session.goal);
  }

  if (name === "get_goal") {
    return jsonResult(activeSession(opts).goal || null);
  }

  if (name === "update_goal") {
    const session = activeSession(opts);
    if (!session.goal) throw new Error("No active goal. Use create_goal first.");
    const status = String(args.status || "");
    if (!["complete", "blocked"].includes(status)) throw new Error("status must be complete or blocked.");
    const now = nowIso();
    session.goal.status = status;
    session.goal.updatedAt = now;
    if (!Array.isArray(session.goal.notes)) session.goal.notes = [];
    if (args.note) session.goal.notes.push({ at: now, note: String(args.note) });
    return jsonResult(session.goal);
  }

  if (name === "update_plan") {
    const session = activeSession(opts);
    session.plan = validatePlanItems(args.plan);
    if (args.explanation) {
      session.planExplanation = String(args.explanation);
      session.planUpdatedAt = nowIso();
    }
    return jsonResult({ plan: session.plan, explanation: session.planExplanation || "", progress: planProgress(session.plan) });
  }

  if (name === "get_plan") {
    const session = activeSession(opts);
    return jsonResult({ plan: session.plan || [], explanation: session.planExplanation || "", progress: planProgress(session.plan || []) });
  }

  if (name === "session_health") {
    const session = activeSession(opts);
    const repaired = repairToolCallHistory(session.messages || []);
    return jsonResult({
      version: session.version || null,
      createdAt: session.createdAt || "",
      updatedAt: session.updatedAt || "",
      workspace: session.workspace || process.cwd(),
      message_count: (session.messages || []).length,
      non_system_message_count: (session.messages || []).filter((message) => message.role !== "system").length,
      tool_history_repairs_needed: repaired.repairs,
      touched_files: session.touchedFiles || [],
      goal: session.goal || null,
      plan_progress: planProgress(session.plan || []),
      checkpoint_count: Array.isArray(session.checkpoints) ? session.checkpoints.length : 0,
      latest_checkpoint: Array.isArray(session.checkpoints) && session.checkpoints.length ? session.checkpoints[session.checkpoints.length - 1] : null
    });
  }

  if (name === "checkpoint_session") {
    const session = activeSession(opts);
    if (!Array.isArray(session.checkpoints)) session.checkpoints = [];
    const checkpoint = {
      label: String(args.label || `checkpoint ${session.checkpoints.length + 1}`),
      summary: String(args.summary || finalAssistantContent(session) || "(no summary)"),
      createdAt: nowIso()
    };
    session.checkpoints.push(checkpoint);
    return jsonResult(checkpoint);
  }

  if (name === "summarize_session") {
    const session = activeSession(opts);
    const maxMessages = Math.min(Math.max(Number(args.max_messages) || 12, 1), 50);
    const messages = (session.messages || []).filter((message) => message.role !== "system").slice(-maxMessages);
    return [
      `Session summary (${messages.length} recent messages)`,
      session.goal ? `Goal: ${session.goal.objective} [${session.goal.status}]` : "Goal: none",
      `Plan: ${planProgress(session.plan || []).completed}/${planProgress(session.plan || []).total} completed`,
      "",
      ...messages.map((message) => compactMessageForSummary(message))
    ].join("\n");
  }

  if (name === "handoff_status") {
    const outputPath = assertInsideWorkspace(args.output_file);
    const logPath = args.log_file ? assertInsideWorkspace(args.log_file) : null;
    const tailLines = Math.min(Math.max(Number(args.tail_lines) || 40, 1), 200);
    const outputExists = await pathExistsAbs(outputPath);
    const logExists = logPath ? await pathExistsAbs(logPath) : false;
    const result = {
      output_file: args.output_file,
      output_exists: outputExists,
      log_file: args.log_file || null,
      log_exists: logExists,
      output: outputExists ? compactText(await readFile(outputPath, "utf8"), 4000) : "",
      log_tail: logExists ? await readTail(logPath, tailLines) : ""
    };
    return jsonResult(result);
  }

  if (name === "handoff_wait") {
    const outputPath = assertInsideWorkspace(args.output_file);
    const timeoutMs = Math.min(Math.max(Number(args.timeout_seconds) || 300, 1), 7200) * 1000;
    const pollMs = Math.min(Math.max(Number(args.poll_ms) || 1000, 100), 30000);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pathExistsAbs(outputPath)) {
        if (args.print_content) return await readFile(outputPath, "utf8");
        return `Handoff output ready: ${args.output_file}`;
      }
      await sleep(pollMs);
    }
    return `Timed out waiting for handoff output: ${args.output_file}`;
  }

  if (name === "handoff_start") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const promptPath = assertInsideWorkspace(args.prompt_file);
    const outputPath = assertInsideWorkspace(args.output_file);
    const logPath = assertInsideWorkspace(args.log_file);
    const promptInfo = await stat(promptPath);
    if (!promptInfo.isFile()) throw new Error("prompt_file is not a file.");
    if (await pathExistsAbs(outputPath)) throw new Error("output_file already exists; remove it or choose a fresh output file.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      const ok = await askYesNo(`Start handoff?\nPrompt: ${args.prompt_file}\nOutput: ${args.output_file}\nLog: ${args.log_file}`);
      if (!ok) return "blocked by user";
    }
    await mkdir(dirname(logPath), { recursive: true });
    const prompt = await readFile(promptPath, "utf8");
    const cli = String(args.cli || "claude");
    const childArgs = handoffCliArgs(cli, prompt, promptPath, args.cli_args);
    await appendFile(logPath, `[${nowIso()}] starting ${cli} ${childArgs.map((arg) => JSON.stringify(arg)).join(" ")}\n`, "utf8");
    const logFd = openSync(logPath, "a");
    const child = spawn(cli, childArgs, {
      cwd: process.cwd(),
      detached: true,
      windowsHide: true,
      shell: process.platform === "win32",
      stdio: ["ignore", logFd, logFd]
    });
    closeSync(logFd);
    child.on("error", (error) => {
      appendFile(logPath, `\n[${nowIso()}] spawn error: ${error.message}\n`, "utf8").catch(() => {});
    });
    child.unref();
    return jsonResult({
      started: true,
      pid: child.pid,
      cli,
      output_file: args.output_file,
      log_file: args.log_file,
      timeout_seconds: Math.min(Math.max(Number(args.timeout_seconds) || 7200, 1), 7200)
    });
  }

  if (name === "list_workspace_files") {
    const workspaceRoot = resolve(process.cwd());
    const target = assertInsideWorkspace(args.path || ".");
    const max = Math.min(Number(args.max) || 200, 2000);
    const offset = Math.max(Number(args.offset) || 0, 0);
    const typeFilter = args.type || "all";
    const includeMetadata = args.include_metadata === true;
    const globRx = args.glob ? globToRegex(args.glob) : null;
    const excludeGlobRxs = args.exclude_glob ? [globToRegex(args.exclude_glob)] : [];
    const userExcludes = Array.isArray(args.exclude_patterns) ? args.exclude_patterns : [];
    const excludeDirNames = [...DEFAULT_TRAVERSE_EXCLUDES, ...userExcludes];

    if (!args.recursive) {
      const entries = await readdir(target, { withFileTypes: true });
      let list = entries;
      if (typeFilter === "file") list = list.filter((e) => e.isFile());
      else if (typeFilter === "dir") list = list.filter((e) => e.isDirectory());
      if (globRx) list = list.filter((e) => globRx.test(e.name));
      const page = list.slice(offset, offset + max);
      if (!includeMetadata) {
        return page.map((e) => `${e.isDirectory() ? "dir " : "file"} ${e.name}`).join("\n");
      }
      const lines = [];
      for (const e of page) {
        try {
          const info = await stat(join(target, e.name));
          const size = e.isFile() ? ` ${info.size}B` : "";
          const mtime = info.mtime.toISOString().slice(0, 19) + "Z";
          lines.push(`${e.isDirectory() ? "dir " : "file"} ${e.name}${size} modified=${mtime}`);
        } catch {
          lines.push(`${e.isDirectory() ? "dir " : "file"} ${e.name}`);
        }
      }
      return lines.join("\n");
    }

    const items = [];
    for await (const item of walkDir(workspaceRoot, target, { excludeDirNames, excludeGlobRxs, type: typeFilter })) {
      if (globRx && !globRx.test(item.relPath) && !globRx.test(item.relPath.split("/").pop())) continue;
      items.push(item);
    }
    const page = items.slice(offset, offset + max);
    const hasMore = items.length > offset + max;

    if (!includeMetadata) {
      const lines = page.map((item) => `${item.isDir ? "dir " : "file"} ${item.relPath}`);
      if (hasMore) lines.push(`[${items.length - offset - max} more; use offset=${offset + max}]`);
      return lines.join("\n");
    }
    const lines = [];
    for (const item of page) {
      try {
        const info = await stat(item.absPath);
        const size = !item.isDir ? ` ${info.size}B` : "";
        const mtime = info.mtime.toISOString().slice(0, 19) + "Z";
        lines.push(`${item.isDir ? "dir " : "file"} ${item.relPath}${size} modified=${mtime}`);
      } catch {
        lines.push(`${item.isDir ? "dir " : "file"} ${item.relPath}`);
      }
    }
    if (hasMore) lines.push(`[${items.length - offset - max} more; use offset=${offset + max}]`);
    return lines.join("\n");
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
    if (args.structured) {
      return JSON.stringify({
        content: chunk,
        next_offset: dataEnd < data.length ? dataEnd : null,
        total_bytes: data.length
      });
    }
    const more = dataEnd < data.length ? `\n\n[chunk ${offset}-${dataEnd} of ${data.length} bytes; continue with offset ${dataEnd}]` : "";
    return `${chunk}${more}`;
  }

  if (name === "web_search") {
    return webSearch(args);
  }

  if (name === "web_fetch") {
    return webFetch(args);
  }

  if (name === "view_image") {
    return viewImage(args);
  }

  if (name === "analyze_image_openai") {
    return analyzeImageOpenAI(args);
  }

  if (name === "list_skills") {
    return formatSkillList(await discoverSkills(opts));
  }

  if (name === "read_skill") {
    const skill = await resolveSkill(opts, args.name);
    return [
      `Skill: ${skill.name}`,
      `Path: ${skill.path}`,
      "",
      skill.content
    ].join("\n");
  }

  if (name === "write_text_file") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const target = assertInsideWorkspace(args.path);
    if (typeof args.content !== "string") throw new Error("content must be a string.");
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      let exists = false;
      try { await stat(target); exists = true; } catch {}
      const ok = await askYesNo(`${exists ? "Overwrite" : "Create"} file: ${args.path}?`);
      if (!ok) return "blocked by user";
    }
    await atomicWriteFile(target, args.content);
    opts.touchedFiles?.add(args.path);
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
      if (opts.noOutput) return "blocked by no-output mode";
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
    opts.touchedFiles?.add(args.path);
    return `Patched ${args.path} (${count} replacement${count !== 1 ? "s" : ""})`;
  }

  if (name === "run_cmd") {
    return maybeRunShellTool(opts, "cmd", args.command, args.timeout_ms);
  }

  if (name === "run_powershell") {
    return maybeRunShellTool(opts, "powershell", args.command, args.timeout_ms);
  }

  if (name === "functions_shell_command" || name === "functions.shell_command") {
    const cwd = args.workdir ? assertInsideWorkspace(args.workdir) : resolve(process.cwd());
    return maybeRunShellTool(opts, "powershell", args.command, args.timeout_ms ?? 120000, cwd);
  }

  if (name === "search_code") {
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required");
    let searchRe;
    try { searchRe = new RegExp(pattern, args.ignore_case ? "i" : ""); }
    catch { searchRe = new RegExp(escapeRegex(pattern), args.ignore_case ? "i" : ""); }
    const workspaceRoot = resolve(process.cwd());
    const searchRoot = args.path ? assertInsideWorkspace(args.path) : workspaceRoot;
    let searchRootInfo;
    try {
      searchRootInfo = await stat(searchRoot);
    } catch {
      throw new Error(`search path does not exist: ${args.path}`);
    }
    const maxResults = Math.min(Number(args.max_results) || 200, 1000);
    const contextLines = Math.min(Math.max(Number(args.context_lines) || 0, 0), 5);
    const globRx = args.glob ? globToRegex(args.glob) : null;
    const userExcludes = Array.isArray(args.exclude_patterns) ? args.exclude_patterns : [];
    const excludeDirNames = args.respect_gitignore === false
      ? userExcludes
      : [...DEFAULT_TRAVERSE_EXCLUDES, ...userExcludes];
    const results = [];
    const searchItems = searchRootInfo.isFile()
      ? [{ absPath: searchRoot, relPath: relative(workspaceRoot, searchRoot).replace(/\\/g, "/"), isDir: false }]
      : walkDir(workspaceRoot, searchRoot, { excludeDirNames, type: "file" });
    outer: for await (const item of searchItems) {
      if (globRx && !globRx.test(item.relPath) && !globRx.test(item.relPath.split("/").pop())) continue;
      if (await isBinaryFile(item.absPath)) continue;
      let text;
      try { text = await readFile(item.absPath, "utf8"); } catch { continue; }
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (searchRe.test(lines[i])) {
          const s = Math.max(0, i - contextLines);
          const e = Math.min(lines.length - 1, i + contextLines);
          const snippet = lines.slice(s, e + 1).map((line, off) => {
            const ln = s + off + 1;
            const mark = s + off === i ? ">" : " ";
            return `${mark}${String(ln).padStart(5)}: ${line}`;
          }).join("\n");
          results.push(`${item.relPath}:${i + 1}\n${snippet}`);
          if (results.length >= maxResults) break outer;
        }
      }
    }
    if (!results.length) return `No matches for: ${pattern}`;
    const sep = "\n" + "─".repeat(60) + "\n";
    return results.join(sep) + (results.length >= maxResults ? `\n[capped at ${maxResults} results]` : "");
  }

  if (name === "read_text_files") {
    const files = Array.isArray(args.files) ? args.files : [];
    if (!files.length) return JSON.stringify({});
    const result = {};
    await Promise.all(files.map(async (spec) => {
      const filePath = typeof spec === "string" ? spec : spec?.path;
      if (!filePath) return;
      try {
        const target = assertInsideWorkspace(filePath);
        const info = await stat(target);
        if (!info.isFile()) { result[filePath] = { error: "not a file" }; return; }
        if (spec.start_line != null) {
          const text = await readFile(target, "utf8");
          const lines = text.split("\n");
          const total = lines.length;
          const start = Math.max(1, Number(spec.start_line));
          const end = spec.end_line != null ? Math.min(Number(spec.end_line), total) : Math.min(start + 99, total);
          result[filePath] = `[lines ${start}–${end} of ${total}]\n${lines.slice(start - 1, end).join("\n")}`;
        } else {
          const maxBytes = Math.min(Number(spec.max_bytes) || 20000, 200000);
          const data = await readFile(target);
          result[filePath] = data.subarray(0, maxBytes).toString("utf8");
        }
      } catch (e) {
        result[filePath] = { error: e.message };
      }
    }));
    return JSON.stringify(result, null, 2);
  }

  if (name === "git_status") {
    const gitArgs = ["status", "--short", "--branch"];
    if (args.path) gitArgs.push("--", assertInsideWorkspace(args.path));
    const r = await runGit(gitArgs);
    return r.out.trim() || r.err.trim() || "clean";
  }

  if (name === "git_diff") {
    const gitArgs = ["diff"];
    if (args.staged) gitArgs.push("--staged");
    if (args.target_branch) gitArgs.push(String(args.target_branch));
    if (args.path) gitArgs.push("--", assertInsideWorkspace(args.path));
    const r = await runGit(gitArgs);
    return r.out || "(no diff)";
  }

  if (name === "git_log") {
    const max = Math.min(Number(args.max_entries) || 20, 100);
    const gitArgs = ["log", `--max-count=${max}`, "--oneline", "--decorate"];
    if (args.path) gitArgs.push("--", assertInsideWorkspace(args.path));
    const r = await runGit(gitArgs);
    return r.out.trim() || "(no commits)";
  }

  if (name === "git_blame") {
    const target = assertInsideWorkspace(args.file_path);
    const gitArgs = ["blame"];
    if (args.start_line != null && args.end_line != null) {
      gitArgs.push("-L", `${args.start_line},${args.end_line}`);
    } else if (args.start_line != null) {
      gitArgs.push("-L", `${args.start_line},${args.start_line}`);
    }
    gitArgs.push(target);
    const r = await runGit(gitArgs);
    return r.out || r.err || "(no output)";
  }

  if (name === "stat_file") {
    const target = assertInsideWorkspace(args.path);
    const info = await stat(target);
    const type = info.isDirectory() ? "dir" : info.isFile() ? "file" : "other";
    const is_binary = info.isFile() ? await isBinaryFile(target) : false;
    return JSON.stringify({ path: args.path, type, size_bytes: info.size, modified_iso: info.mtime.toISOString(), is_binary }, null, 2);
  }

  if (name === "patch_files") {
    if (opts.permission === "review") return "blocked by session permission: review only";
    const edits = Array.isArray(args.edits) ? args.edits : [];
    if (!edits.length) return "No edits provided.";
    const preflights = await Promise.all(edits.map(async (edit) => {
      try {
        const target = assertInsideWorkspace(edit.path);
        const info = await stat(target);
        if (!info.isFile()) return { edit, ok: false, error: "not a file", target: null, content: null };
        const content = await readFile(target, "utf8");
        if (!content.includes(edit.old_string)) return { edit, ok: false, error: "old_string not found", target, content };
        return { edit, ok: true, error: null, target, content };
      } catch (e) {
        return { edit, ok: false, error: e.message, target: null, content: null };
      }
    }));
    const failures = preflights.filter((p) => !p.ok);
    if (failures.length) {
      return `Preflight failed — no files written:\n${failures.map((f) => `  ${f.edit.path}: ${f.error}`).join("\n")}`;
    }
    if (opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
      if (opts.noOutput) return "blocked by no-output mode";
      const preview = edits.map((e) => `  ${e.path}: ${e.old_string.slice(0, 60)}${e.old_string.length > 60 ? "…" : ""}`).join("\n");
      const ok = await askYesNo(`Patch ${edits.length} file${edits.length !== 1 ? "s" : ""}?\n${preview}`);
      if (!ok) return "blocked by user";
    }
    const written = [];
    for (const { edit, content, target } of preflights) {
      const newContent = edit.replace_all
        ? content.split(edit.old_string).join(edit.new_string)
        : content.replace(edit.old_string, edit.new_string);
      await atomicWriteFile(target, newContent);
      opts.touchedFiles?.add(edit.path);
      written.push(`  ${edit.path}`);
    }
    return `Patched ${written.length} file${written.length !== 1 ? "s" : ""}:\n${written.join("\n")}`;
  }

  if (name === "cache_set") {
    if (!opts.sessionCache) opts.sessionCache = {};
    opts.sessionCache[String(args.key)] = String(args.value);
    return `Cached key: ${args.key}`;
  }

  if (name === "cache_get") {
    const val = opts.sessionCache?.[String(args.key)];
    return val !== undefined ? val : "null";
  }

  if (name === "glob") {
    const pattern = String(args.pattern || "");
    if (!pattern) throw new Error("pattern is required");
    const max = Math.min(Number(args.max) || 100, 1000);
    const workspaceRoot = resolve(process.cwd());
    const globRx = globToRegex(pattern);
    const results = [];
    for await (const item of walkDir(workspaceRoot, workspaceRoot, { excludeDirNames: DEFAULT_TRAVERSE_EXCLUDES })) {
      if (globRx.test(item.relPath)) {
        results.push(item.relPath);
        if (results.length >= max) break;
      }
    }
    return results.join("\n") || "(no matches)";
  }

  if (name === "path_exists") {
    const target = assertInsideWorkspace(args.path);
    try {
      const info = await stat(target);
      return JSON.stringify({ exists: true, type: info.isDirectory() ? "dir" : "file" });
    } catch {
      return JSON.stringify({ exists: false });
    }
  }

  if (name === "is_text_file") {
    const target = assertInsideWorkspace(args.path);
    try {
      const info = await stat(target);
      if (!info.isFile()) return JSON.stringify({ is_text: false, reason: "not a file" });
      const binary = await isBinaryFile(target);
      return JSON.stringify({ is_text: !binary });
    } catch (e) {
      return JSON.stringify({ error: e.message });
    }
  }

  if (name === "get_related_files") {
    const target = assertInsideWorkspace(args.path);
    const text = await readFile(target, "utf8");
    const importPatterns = [
      /import\s+(?:[\w*{},\s]+from\s+)?['"]([^'"]+)['"]/g,
      /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
      /#include\s+[<"]([^>"]+)[>"]/g,
      /from\s+['"]([^'"]+)['"]/g
    ];
    const refs = new Set();
    for (const pattern of importPatterns) {
      for (const match of text.matchAll(pattern)) refs.add(match[1]);
    }
    return [...refs].join("\n") || "(no imports found)";
  }

  if (name === "tree") {
    const target = assertInsideWorkspace(args.path || ".");
    const maxDepth = Math.min(Number(args.max_depth) || 3, 8);
    const relLabel = relative(process.cwd(), target).replace(/\\/g, "/") || ".";
    const lines = [`${relLabel}/`];
    const sub = await buildTreeLines(target, "", 0, maxDepth);
    lines.push(...sub);
    return lines.join("\n");
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
  return calls.some((call) => ["run_cmd", "run_powershell", "functions_shell_command", "functions.shell_command"].includes(call.function?.name));
}

function repairToolCallHistory(messages) {
  const repaired = [];
  let repairs = 0;

  for (let i = 0; i < (messages || []).length; i += 1) {
    const message = messages[i];
    if (message.role === "tool") {
      repairs += 1;
      continue;
    }

    repaired.push(message);
    const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    if (message.role !== "assistant" || calls.length === 0) continue;

    const missing = new Map();
    calls.forEach((call, index) => {
      const id = call.id || `missing_tool_call_${index}`;
      missing.set(id, call.function?.name || "tool");
    });

    let j = i + 1;
    while (j < messages.length && messages[j].role === "tool") {
      const toolMessage = messages[j];
      if (missing.has(toolMessage.tool_call_id)) {
        repaired.push(toolMessage);
        missing.delete(toolMessage.tool_call_id);
      } else {
        repairs += 1;
      }
      j += 1;
    }

    for (const [toolCallId, toolName] of missing) {
      repaired.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: `Tool result unavailable: previous session ended before ${toolName} completed.`
      });
      repairs += 1;
    }

    i = j - 1;
  }

  return { messages: repaired, repairs };
}

function installStreamInterruptHandler(opts, controller) {
  if (!opts.interactiveChat || !process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return () => {};
  }

  const stdin = process.stdin;
  const onData = (chunk) => {
    const text = chunk.toString("utf8");
    if (text === "\u001b" || text === "\u0003") {
      opts.interrupted = true;
      if (!opts.noOutput) process.stderr.write("\n[interrupted]\n");
      controller.abort();
    }
  };

  stdin.resume();
  stdin.setRawMode(true);
  stdin.on("data", onData);

  return () => {
    stdin.off("data", onData);
    try { stdin.setRawMode(false); } catch {}
    stdin.resume();
  };
}

async function streamChat(opts, messages) {
  const apiKey = await getDeepSeekApiKey();
  if (!apiKey) throw new Error("No DeepSeek API key found. Run: dsw config set-key <key>");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);
  const cleanupInterrupt = installStreamInterruptHandler(opts, controller);
  const toolCalls = [];
  let content = "";
  let reasoningContent = "";
  let phase = "";
  let status = createStatusLine(opts, randomStatusPhrase());
  const ensureToolStatus = () => {
    if (status.isActive()) return status;
    status = createStatusLine(opts, "Preparing tools");
    return status;
  };
  try {
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
          status.addTokens(delta.reasoning_content);
          status.stop();
          if (phase !== "thinking") {
            heading(opts, "thinking", "thinking");
            phase = "thinking";
          }
          reasoningContent += delta.reasoning_content;
          if (!opts.noOutput) process.stdout.write(dim(opts, delta.reasoning_content));
        }

        if (delta.content) {
          status.addTokens(delta.content);
          status.stop();
          if (phase !== "final") {
            heading(opts, "final", "final");
            phase = "final";
          }
          content += delta.content;
          if (!opts.noOutput) process.stdout.write(applyKnownFileLinks(opts, delta.content, opts.touchedFiles || []));
        }

        if (delta.tool_calls) {
          const toolStatus = ensureToolStatus();
          toolStatus.setPhrase("Preparing tools");
          toolStatus.addTokens(JSON.stringify(delta.tool_calls));
          mergeToolDelta(toolCalls, delta.tool_calls);
        }
      }
    }

    status.stop();
    if (!opts.noOutput) process.stdout.write("\n");
    return { role: "assistant", content, reasoning_content: reasoningContent, tool_calls: toolCalls.length ? toolCalls : undefined };
  } catch (error) {
    status.stop();
    if (opts.interrupted || error?.name === "AbortError") {
      if (!opts.noOutput) process.stdout.write("\n");
      return {
        role: "assistant",
        content: content.trim() ? `${content.trim()}\n\n[interrupted by user]` : "[interrupted by user]",
        reasoning_content: reasoningContent,
        interrupted: true
      };
    }
    throw error;
  } finally {
    status.stop();
    cleanupInterrupt();
    opts.interrupted = false;
    clearTimeout(timer);
  }
}

async function processAgentTurns(opts, session) {
  for (let turn = 0; opts.maxToolTurns === null || turn <= opts.maxToolTurns; turn += 1) {
    const assistant = await streamChat(opts, session.messages);
    session.messages.push(assistant);
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));

    if (assistant.interrupted) return;
    if (!assistant.tool_calls?.length) return;
    heading(opts, "tool calls", "tools");

    const sequential = shouldRunToolsSequentially(opts, assistant.tool_calls);
    let executions = [];
    if (!sequential) {
      const status = createStatusLine(opts, "Running tools", assistant.tool_calls.reduce((sum, call) => sum + estimateTokens(call.function?.arguments || ""), 0));
      try {
        executions = await Promise.all(assistant.tool_calls.map((call) => executeToolCall(opts, call)));
      } finally {
        status.stop();
      }
    }

    for (const call of assistant.tool_calls) {
      let execution;
      if (sequential) {
        const status = createStatusLine(opts, toolStatusPhrase(call.function?.name || "tool"), estimateTokens(call.function?.arguments || ""));
        try {
          execution = await executeToolCall(opts, call);
        } finally {
          status.stop();
        }
      } else {
        execution = executions.shift();
      }
      writeToolCall(opts, execution.name, execution.rawArgs);
      writeToolResult(opts, toolDisplayResult(execution.name, execution.args, execution.result), collectPathLikeValues(execution.args));
      session.messages.push({ role: "tool", tool_call_id: execution.call.id, content: String(execution.result) });
      session.touchedFiles = [...(opts.touchedFiles || [])];
      session.cache = { ...(opts.sessionCache || {}) };
      if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    }
  }

  throw new Error(`Stopped after ${opts.maxToolTurns} tool turns (--max-tool-turns).`);
}

function isExitCommand(text) {
  return ["/exit", "/quit", "/end", "exit", "quit"].includes(text.trim().toLowerCase());
}

function parseUiArgs(argv) {
  const opts = {
    port: Number.parseInt(process.env.DEEPSEEK_UI_PORT || "17891", 10),
    cdpPort: Number.parseInt(process.env.DEEPSEEK_UI_CDP_PORT || "9223", 10)
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`Missing value for ${arg}`);
      return argv[i];
    };
    if (arg === "--ui-port") opts.port = Number.parseInt(next(), 10);
    else if (arg === "--ui-cdp-port" || arg === "--cdp-port") opts.cdpPort = Number.parseInt(next(), 10);
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else throw new Error(`Unknown UI argument: ${arg}`);
  }
  if (!Number.isFinite(opts.port) || opts.port <= 0) throw new Error("--ui-port must be a positive number.");
  if (!Number.isFinite(opts.cdpPort) || opts.cdpPort <= 0) throw new Error("--ui-cdp-port must be a positive number.");
  return opts;
}

function electronCommand() {
  const cmd = process.platform === "win32" ? "electron.cmd" : "electron";
  const exe = process.platform === "win32" ? "electron.exe" : "electron";
  const local = resolve(process.cwd(), "node_modules", ".bin", cmd);
  const repoLocal = resolve(UI_APP_DIR, "..", "..", "node_modules", ".bin", cmd);
  const localExe = resolve(process.cwd(), "node_modules", "electron", "dist", exe);
  const repoLocalExe = resolve(UI_APP_DIR, "..", "..", "node_modules", "electron", "dist", exe);
  for (const candidate of [repoLocalExe, localExe, repoLocal, local]) {
    const result = spawnSync(candidate, ["--version"], { encoding: "utf8", windowsHide: true });
    if (result.status === 0) return candidate;
  }
  const pathResult = spawnSync(cmd, ["--version"], { encoding: "utf8", windowsHide: true });
  if (pathResult.status === 0) return cmd;
  throw new Error("Electron was not found. Run `npm install` in the deepseek-detached-agent repo, then retry `d -ui`.");
}

function cliLaunchEnv() {
  const script = process.argv[1] && process.argv[1].endsWith("deepseek-watch.js") ? resolve(process.argv[1]) : "";
  return {
    DEEPSEEK_UI_CLI_EXE: process.execPath,
    DEEPSEEK_UI_CLI_SCRIPT: script,
    DEEPSEEK_UI_WORKSPACE: process.cwd()
  };
}

function launchElectronUi(argv) {
  const opts = parseUiArgs(argv);
  if (opts.help) {
    process.stdout.write("Usage: d -ui [--ui-port 17891] [--ui-cdp-port 9223]\n");
    return;
  }
  const electron = electronCommand();
  const args = [
    `--remote-debugging-port=${opts.cdpPort}`,
    UI_APP_DIR
  ];
  const env = {
    ...process.env,
    ...cliLaunchEnv(),
    DEEPSEEK_UI_PORT: String(opts.port),
    DEEPSEEK_UI_CDP_PORT: String(opts.cdpPort)
  };
  const child = spawn(electron, args, {
    cwd: process.cwd(),
    env,
    stdio: "inherit",
    windowsHide: false
  });
  child.on("exit", (code) => {
    process.exitCode = code ?? 0;
  });
}

async function run() {
  const argv = process.argv.slice(2);
  if (argv[0] === "-ui" || argv[0] === "--ui" || argv[0] === "ui") {
    launchElectronUi(argv.slice(1));
    return;
  }
  if (argv[0] === "doctor") {
    process.stdout.write(`${await doctor()}\n`);
    return;
  }

  if (argv[0] === "config") {
    const command = argv[1];
    if (command === "set-key") {
      await setDeepSeekApiKey(argv[2] || "");
      process.stdout.write(`Saved DeepSeek API key to ${configPath()}\n`);
      return;
    }
    if (command === "set-openai-key") {
      process.stdout.write(`${setUserEnvironmentVariable("OPENAI_API_KEY", argv[2] || "")}\n`);
      return;
    }
    if (command === "path") {
      process.stdout.write(`${configPath()}\n`);
      return;
    }
    throw new Error("Unknown config command. Use: dsw config set-key <key> or dsw config set-openai-key <key>");
  }

  const opts = argv.length === 0 ? await dashboardOpts() : parseArgs(argv);
  if (opts.quit) return;
  validateOpts(opts);

  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (opts.listSkills) {
    process.stdout.write(`${formatSkillList(await discoverSkills(opts))}\n`);
    return;
  }

  let resumedSession = null;
  if (!opts.session && opts.resume) {
    opts.session = await pickSession(opts);
  }
  if (opts.resume) {
    resumedSession = await readSession(opts.session);
    if (!opts.skills.length && Array.isArray(resumedSession.config?.skills)) {
      opts.skills = normalizeList(resumedSession.config.skills);
    }
    if (!opts.skillRoots.length && Array.isArray(resumedSession.config?.skillRoots)) {
      opts.skillRoots = normalizeList(resumedSession.config.skillRoots);
    }
  }

  opts.skills = normalizeList(opts.skills);
  opts.skillRoots = normalizeList(opts.skillRoots);

  const systemPrompt = await loadSystemPrompt(opts);
  if (opts.printSystem) {
    process.stdout.write(`${systemPrompt}\n`);
    return;
  }

  const userPrompt = await loadPrompt(opts);
  if (!opts.session) {
    opts.session = newSessionPath();
  }

  const session = opts.resume
    ? resumedSession
    : newSession({
      model: opts.model,
      baseUrl: opts.baseUrl,
      workspace: process.cwd(),
      systemPrompt,
      userPrompt,
      config: {
        permission: opts.permission || (opts.dangerouslyAutoRunCommands ? "full" : "ask"),
        toolMode: opts.toolMode,
        skills: opts.skills,
        skillRoots: opts.skillRoots
      }
    });

  if (opts.resume && (opts.skills.length || opts.skillRoots.length)) {
    updateSystemMessage(session, systemPrompt);
  }

  const repairedHistory = repairToolCallHistory(session.messages);
  if (repairedHistory.repairs > 0) {
    session.messages = repairedHistory.messages;
    if (!opts.noOutput) {
      process.stderr.write(`Repaired ${repairedHistory.repairs} invalid saved tool message${repairedHistory.repairs === 1 ? "" : "s"} before resume.\n`);
    }
  }

  opts.permission = opts.permission || session.config?.permission || (opts.dangerouslyAutoRunCommands ? "full" : "ask");
  opts.toolMode = opts.toolMode || session.config?.toolMode || "parallel";
  if (opts.permission === "full") opts.dangerouslyAutoRunCommands = true;
  session.config = {
    ...(session.config || {}),
    permission: opts.permission,
    toolMode: opts.toolMode,
    skills: opts.skills,
    skillRoots: opts.skillRoots
  };
  opts.touchedFiles = new Set(session.touchedFiles || []);
  opts.sessionCache = { ...(session.cache || {}) };
  opts.sessionObject = session;

  if (opts.resume) {
    session.messages.push({ role: "user", content: userPrompt });
  }

  if (opts.saveSession) {
    await writeSession(opts.session, touchSession(session));
    writeSessionNotice(opts, sessionPath(opts.session));
  }

  await processAgentTurns(opts, session);
  session.touchedFiles = [...opts.touchedFiles];
  session.cache = { ...(opts.sessionCache || {}) };
  if (opts.saveSession) await writeSession(opts.session, touchSession(session));
  await maybeWriteOutput(opts, session);

  while (opts.interactiveChat) {
    process.stdout.write(`\n  ${dim(opts, "Enter to send, /exit to quit, Ctrl+C to exit")}\n`);
    const nextPrompt = await promptLine("  > ");
    if (!nextPrompt.trim()) continue;
    if (isExitCommand(nextPrompt)) return;
    session.messages.push({ role: "user", content: nextPrompt });
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    await processAgentTurns(opts, session);
    session.touchedFiles = [...opts.touchedFiles];
    session.cache = { ...(opts.sessionCache || {}) };
    if (opts.saveSession) await writeSession(opts.session, touchSession(session));
    await maybeWriteOutput(opts, session);
  }
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
