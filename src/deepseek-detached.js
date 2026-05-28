#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deepSeekHttpError } from "./api-error.js";
import { getDeepSeekApiKey } from "./config.js";
import { applyThinkingOptions } from "./deepseek-request.js";

const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_OUTPUT = "deepseek-result.md";

function usage() {
  return `dsd

Usage:
  dsd -p <prompt> -o <file> [options]
  dsd --prompt-file <file> -o <file> [options]

Options:
  -p, --prompt <text>       Prompt content.
  --prompt-file <file>      Read prompt content from a file.
  --stdin                   Read prompt content from stdin.
  -o, --output <file>       Markdown output file. Default: ${DEFAULT_OUTPUT}
  --model <name>            DeepSeek model. Default: ${DEFAULT_MODEL}
  --base-url <url>          OpenAI-compatible base URL. Default: ${DEFAULT_BASE_URL}
  --effort <high|max>       Reasoning effort. Default: high
  --thinking <enabled|disabled>
                            DeepSeek thinking toggle. Default: enabled
  --max-tokens <number>     Max output tokens. Default: 8192
  --timeout <ms>            DeepSeek request timeout. Default: 600000
  --detach                  Spawn a detached worker and return immediately.
  --no-fallback             Do not fall back to claude -p.
  --claude-cmd <command>    Claude command. Default: CLAUDE_CMD or claude
  -h, --help                Show help.
`;
}

function parseArgs(argv) {
  const opts = {
    output: DEFAULT_OUTPUT,
    model: process.env.DEEPSEEK_MODEL || DEFAULT_MODEL,
    baseUrl: process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
    effort: "high",
    thinking: "enabled",
    maxTokens: 8192,
    timeout: 600000,
    fallback: true,
    claudeCmd: process.env.CLAUDE_CMD || "claude",
    detach: false
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
    else if (arg === "-o" || arg === "--output") opts.output = next();
    else if (arg === "--model") opts.model = next();
    else if (arg === "--base-url") opts.baseUrl = next();
    else if (arg === "--effort") opts.effort = next();
    else if (arg === "--thinking") opts.thinking = next();
    else if (arg === "--max-tokens") opts.maxTokens = Number.parseInt(next(), 10);
    else if (arg === "--timeout") opts.timeout = Number.parseInt(next(), 10);
    else if (arg === "--detach") opts.detach = true;
    else if (arg === "--no-fallback") opts.fallback = false;
    else if (arg === "--claude-cmd") opts.claudeCmd = next();
    else throw new Error(`Unknown argument: ${arg}`);
  }

  return opts;
}

function validateOpts(opts) {
  if (opts.help) return;
  const promptSources = [opts.prompt, opts.promptFile, opts.stdin].filter(Boolean).length;
  if (promptSources === 0) throw new Error("Provide --prompt, --prompt-file, or --stdin.");
  if (promptSources > 1) throw new Error("Use only one prompt source.");
  if (!Number.isFinite(opts.maxTokens) || opts.maxTokens <= 0) throw new Error("--max-tokens must be a positive number.");
  if (!Number.isFinite(opts.timeout) || opts.timeout <= 0) throw new Error("--timeout must be a positive number.");
  if (!["enabled", "disabled"].includes(opts.thinking)) throw new Error("--thinking must be enabled or disabled.");
  if (!["high", "max"].includes(opts.effort)) throw new Error("--effort must be high or max.");
}

async function loadPrompt(opts) {
  if (opts.promptFile) return readFile(resolve(opts.promptFile), "utf8");
  if (opts.stdin) return readStdin();
  return opts.prompt;
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

async function materializeDetachedPrompt(opts) {
  if (opts.promptFile) return opts;
  const out = resolve(opts.output);
  const promptDir = resolve(dirname(out), ".deepseek-detached");
  await mkdir(promptDir, { recursive: true });
  const promptFile = resolve(promptDir, `prompt-${Date.now()}-${process.pid}.txt`);
  const prompt = await loadPrompt(opts);
  await writeFile(promptFile, prompt, "utf8");
  return { ...opts, prompt: undefined, stdin: false, promptFile };
}

function detachedArgv(opts) {
  const args = [];
  if (opts.promptFile) args.push("--prompt-file", opts.promptFile);
  else args.push("--prompt", opts.prompt);
  args.push("--output", opts.output);
  args.push("--model", opts.model);
  args.push("--base-url", opts.baseUrl);
  args.push("--effort", opts.effort);
  args.push("--thinking", opts.thinking);
  args.push("--max-tokens", String(opts.maxTokens));
  args.push("--timeout", String(opts.timeout));
  args.push("--claude-cmd", opts.claudeCmd);
  if (!opts.fallback) args.push("--no-fallback");
  return args;
}

async function spawnDetached(opts) {
  const workerOpts = await materializeDetachedPrompt(opts);
  const scriptPath = fileURLToPath(import.meta.url);
  const child = spawn(process.execPath, [scriptPath, ...detachedArgv(workerOpts)], {
    cwd: process.cwd(),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
}

async function callDeepSeek(opts, prompt) {
  const apiKey = await getDeepSeekApiKey();
  if (!apiKey) throw new Error("No DeepSeek API key found. Run: dsw config set-key <key>");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeout);

  try {
    const response = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(applyThinkingOptions({
        model: opts.model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: opts.maxTokens
      }, opts))
    });

    const text = await response.text();
    if (!response.ok) throw await deepSeekHttpError(new Response(text, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    }));

    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.length === 0) {
      throw new Error("DeepSeek returned no final content.");
    }
    return content;
  } finally {
    clearTimeout(timer);
  }
}

function callClaude(opts, prompt) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(opts.claudeCmd, ["-p", prompt], {
      cwd: process.cwd(),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });

    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0 && stdout.trim().length > 0) resolvePromise(stdout);
      else reject(new Error(`Claude fallback failed with code ${code}: ${stderr}`));
    });
  });
}

async function writeAtomic(path, content) {
  const out = resolve(path);
  await mkdir(dirname(out), { recursive: true });
  const tmp = `${out}.tmp-${process.pid}`;
  await writeFile(tmp, content.endsWith("\n") ? content : `${content}\n`, "utf8");
  await rename(tmp, out);
}

async function run() {
  const opts = parseArgs(process.argv.slice(2));
  validateOpts(opts);

  if (opts.help) {
    process.stdout.write(usage());
    return;
  }

  if (opts.detach) {
    await spawnDetached({ ...opts, detach: false });
    return;
  }

  const prompt = await loadPrompt(opts);
  let finalText;

  try {
    finalText = await callDeepSeek(opts, prompt);
  } catch (deepSeekError) {
    if (!opts.fallback) throw deepSeekError;
    finalText = await callClaude(opts, prompt);
  }

  await writeAtomic(opts.output, finalText);
}

run().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
