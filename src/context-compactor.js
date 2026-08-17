// src/context-compactor.js — automatic context compaction for dsw sessions.
//
// DeepSeek-style chat APIs bound the request at a large input context (default
// here: 1,032,492 tokens) plus a modest completion budget (16,384). Long agent
// sessions grow the transcript without bound, so before each model request the
// wrapper asks this module whether the estimated input is at/above a threshold
// and, if so, compacts:
//
//   * the OLD prefix of the transcript is folded into ONE structured summary
//     message (LLM-generated when a key/model is available, else a
//     deterministic roll-up of goal/plan/checkpoints/last assistant notes),
//   * the RECENT tail is kept verbatim (guaranteeing tool_call_id integrity),
//   * the system message always stays first,
//   * orphaned `tool` messages at the tail boundary are never left behind.
//
// Every compaction is recorded on session.compactions[] so the effect is
// auditable and resumable. `scripts/compact-session.mjs` exposes the same
// engine as a detached CLI so another agent (or an operator) can compact a
// session file out-of-process.

import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { deepSeekHttpError } from "./api-error.js";
import { getDeepSeekApiKey } from "./config.js";
import { applyThinkingOptions } from "./deepseek-request.js";
import { isRetryableFetchError, retryBackoffMs } from "./fetch-retry.js";

export const DEFAULT_CONTEXT_LIMIT = 1_048_576; // deepseek-v4-class models: 2^20 total context (messages + completion)
export const DEFAULT_COMPLETION_TOKENS = 16_384;
export const DEFAULT_COMPACT_THRESHOLD = 0.9;
export const DEFAULT_KEEP_RECENT = 40;
export const DEFAULT_TAIL_BUDGET_RATIO = 0.1;
const DEFAULT_SUMMARY_INPUT_TOKENS = 200_000;
const COMPACT_TIMEOUT_MS = 180_000;
const COMPACT_MAX_OUTPUT_TOKENS = 4096;
// chars/4 under-counts code/JSON-heavy transcripts; judge the budget against a
// scaled usage so compaction triggers before the real tokenizer rejects the
// request (observed: API rejects at context > max even by ~300 tokens).
const TOKEN_ESTIMATE_SAFETY = 1.2;

// ---------------------------------------------------------------------------
// Token estimation (chars/4 heuristic, matching the wrapper's display math).
// ---------------------------------------------------------------------------

export function estimateTokens(text) {
  return Math.max(0, Math.ceil(String(text || "").length / 4));
}

export function estimateMessageTokens(message) {
  if (!message || typeof message !== "object") return 0;
  let total = estimateTokens(message.role || "") + 4;
  total += estimateTokens(message.content || "");
  total += estimateTokens(message.reasoning_content || "");
  if (message.name) total += estimateTokens(message.name);
  if (message.tool_call_id) total += estimateTokens(message.tool_call_id);
  if (Array.isArray(message.tool_calls)) {
    for (const call of message.tool_calls) {
      total += estimateTokens(call.id || "");
      total += estimateTokens(call.type || "");
      total += estimateTokens(call.function?.name || "");
      total += estimateTokens(call.function?.arguments || "");
    }
  }
  return total;
}

export function estimateContextTokens(messages) {
  return (messages || []).reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function clampRatio(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) return fallback;
  return parsed;
}

// ---------------------------------------------------------------------------
// Plan: WHERE to cut, WHAT to fold, whether it is needed at all. Pure.
// ---------------------------------------------------------------------------

export function computeCompactionPlan(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const limit = Math.max(Number(options.limit) || DEFAULT_CONTEXT_LIMIT, 2000);
  const threshold = clampRatio(options.threshold, DEFAULT_COMPACT_THRESHOLD);
  const keepRecent = Math.max(Number(options.keepRecent) || DEFAULT_KEEP_RECENT, 2);
  const tailBudget = Math.max(Number(options.tailBudgetRatio) || DEFAULT_TAIL_BUDGET_RATIO, 0.05) * limit;
  // The API counts messages + completion against ONE context window; the
  // messages budget is what remains after reserving the completion budget.
  const completion = Math.min(Math.max(Number(options.completionTokens) || DEFAULT_COMPLETION_TOKENS, 0), Math.floor(limit / 2));
  const messagesBudget = Math.max(limit - completion, 1000);
  const scaled = (raw) => Math.round(raw * TOKEN_ESTIMATE_SAFETY);

  const usageRaw = estimateContextTokens(list);
  const usage = scaled(usageRaw);
  const target = messagesBudget * threshold;
  if (usage < target) {
    return { needed: false, usage: usageRaw, usageScaled: usage, target, limit, messagesBudget, threshold, completion, keepStart: -1, prefix: [], tail: list, prefixTokens: 0, tailTokens: usageRaw };
  }

  // Ideal cut: everything before the most recent `keepRecent` messages.
  let keepStart = Math.max(1, list.length - keepRecent);

  // Never start the kept tail on an orphaned tool result (its assistant
  // tool_calls message lives just before the cut).
  while (keepStart > 0 && list[keepStart]?.role === "tool") keepStart -= 1;

  // Nothing left to fold (system + one message), or tail is the whole list.
  if (keepStart <= 1 || keepStart >= list.length - 1) {
    return { needed: false, usage: usageRaw, usageScaled: usage, target, limit, messagesBudget, threshold, completion, keepStart: -1, prefix: [], tail: list, prefixTokens: 0, tailTokens: usageRaw };
  }

  // Shrink the tail from the old side while it exceeds the tail budget.
  // Always stop on a non-tool boundary so the suffix stays API-consistent.
  while (keepStart < list.length - 1) {
    if (scaled(estimateContextTokens(list.slice(keepStart))) <= tailBudget) break;
    keepStart += 1;
    while (keepStart < list.length - 1 && list[keepStart]?.role === "tool") keepStart += 1;
  }

  const prefix = list.slice(0, keepStart);
  const tail = list.slice(keepStart);
  const prefixTokens = estimateContextTokens(prefix);
  const tailTokens = estimateContextTokens(tail);
  const projectedTokens = scaled(tailTokens) + estimateTokens('<context_compaction></context_compaction>');
  return { needed: true, usage: usageRaw, usageScaled: usage, target, limit, messagesBudget, threshold, completion, keepStart, prefix, tail, prefixTokens, tailTokens, projectedTokens };
}

// ---------------------------------------------------------------------------
// Summarizer input: a bounded, head+tail excerpt of the folded prefix so a
// modest compaction call never has to ingest 90% of a 1M-token transcript.
// ---------------------------------------------------------------------------

export function truncateTranscriptForSummary(messages, maxTokens = DEFAULT_SUMMARY_INPUT_TOKENS) {
  const list = Array.isArray(messages) ? messages : [];
  if (!list.length) return "(empty transcript)";
  const budgetChars = Math.max(Number(maxTokens) || DEFAULT_SUMMARY_INPUT_TOKENS, 4000) * 4;
  const perMessage = 500;

  const render = (message) => {
    const role = message.role || "message";
    const prefixBits = [];
    if (message.tool_call_id) prefixBits.push(`tool:${message.tool_call_id}`);
    if (Array.isArray(message.tool_calls)) {
      prefixBits.push(`tool_calls: ${message.tool_calls.map((call) => call.function?.name || "?").join(", ")}`);
    }
    let text = String(message.content || "");
    if (message.role === "assistant" && message.reasoning_content) {
      text = `${text} [reasoning: ${String(message.reasoning_content).slice(0, 160)}…]`;
    }
    const prefix = prefixBits.length ? `[${prefixBits.join(" | ")}] ` : "";
    return `[${role}] ${prefix}${text}`;
  };

  const lines = list.map(render);
  let total = 0;
  for (const line of lines) total += Math.min(line.length, perMessage) + 1;

  if (total <= budgetChars) return lines.map((line) => (line.length > perMessage ? `${line.slice(0, perMessage)}…` : line)).join("\n");

  // Head + tail: keep the mission start and the immediately-pre-tail context.
  const headRatio = 0.3;
  const headLines = [];
  const tailLines = [];
  let headChars = 0;
  let tailChars = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const capped = line.length > perMessage ? `${line.slice(0, perMessage)}…` : line;
    if (i < lines.length * headRatio && headChars < budgetChars * headRatio) {
      headLines.push(capped);
      headChars += capped.length + 1;
    } else if (tailChars < budgetChars * (1 - headRatio)) {
      tailLines.push(capped);
      tailChars += capped.length + 1;
    }
  }
  const marker = `… [${list.length - headLines.length - tailLines.length} messages elided for compaction input] …`;
  return [...headLines, marker, ...tailLines].join("\n");
}

const SUMMARIZER_SYSTEM_PROMPT = [
  "You are the context compactor for a long-running AI coding-agent session. Older messages have been folded away and the agent's context window was about to overflow.",
  "",
  "Produce a STRUCTURED Markdown summary of the transcript below. It will be injected as the agent's memory, so precision beats prose.",
  "",
  "Sections (in this order):",
  "## Mission & goals — what the agent set out to do.",
  "## Completed work — what was done, with exact file paths, function/route/task names, and key decisions. Include git/task identifiers verbatim.",
  "## Current state — what exists right now (files, processes, claims, leases, branch), exactly as known.",
  "## Open items & next steps — what remains, in priority order.",
  "## Important facts — paths, commands, config keys, hashes, ids, ports, error strings. No paraphrasing of identifiers.",
  "## Risks & caveats — traps, broken things, red tests, constraints (e.g. \"do not touch X\").",
  "",
  "Rules: never invent facts; if the transcript does not say, say unknown. Keep identifiers byte-exact. Total length: under 3000 tokens. Terse bullets, no filler, no sign-off."
].join("\n");

// ---------------------------------------------------------------------------
// Summarizers.
// ---------------------------------------------------------------------------

export async function summarizeWithLlm(opts, transcript) {
  const apiKey = await getDeepSeekApiKey();
  if (!apiKey) throw new Error("No DeepSeek API key found for context compaction (set one with `dsw config set-key <key>`).");

  const body = {
    model: opts.model,
    messages: [
      { role: "system", content: SUMMARIZER_SYSTEM_PROMPT },
      { role: "user", content: transcript }
    ],
    stream: false,
    max_tokens: COMPACT_MAX_OUTPUT_TOKENS
  };
  applyThinkingOptions(body, { thinking: "disabled" });

  for (let attempt = 1; ; attempt += 1) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), COMPACT_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(`${String(opts.baseUrl || "https://api.deepseek.com").replace(/\/$/, "")}/chat/completions`, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify(body)
        });
      } finally {
        clearTimeout(timer);
      }
      if (!response.ok) throw await deepSeekHttpError(response);
      const data = await response.json();
      const summary = String(data.choices?.[0]?.message?.content || "").trim();
      if (!summary) throw new Error("compactor returned an empty summary.");
      // Strip a markdown code fence if the model wrapped the whole answer.
      return summary.replace(/^```(?:markdown|md)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
    } catch (error) {
      const retryable = isRetryableFetchError(error) && !(error instanceof Error && error.message.includes("empty summary"));
      if (!retryable) throw error;
      const delay = retryBackoffMs(Number(opts.retryDelay) || 1000, Number(opts.retryMaxDelay) || 30000, attempt);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, delay));
    }
  }
}

export function buildDeterministicSummary(session, prefix) {
  const parts = [];
  parts.push("# Context compaction summary (deterministic roll-up)");
  if (session?.goal) {
    parts.push("", "## Mission & goals", `- [${session.goal.status}] ${session.goal.objective}`);
  }
  const plan = Array.isArray(session?.plan) ? session.plan : [];
  if (plan.length) {
    const counts = plan.reduce((acc, item) => { acc[item.status] = (acc[item.status] || 0) + 1; return acc; }, {});
    parts.push("", "## Plan", `- ${counts.completed || 0}/${plan.length} steps completed`, ...plan.map((item) => `- [${item.status}] ${item.step}`));
  }
  const checkpoints = Array.isArray(session?.checkpoints) ? session.checkpoints.slice(-5) : [];
  if (checkpoints.length) {
    parts.push("", "## Recent checkpoints", ...checkpoints.map((checkpoint) => `- ${checkpoint.createdAt || ""}: ${String(checkpoint.summary || "").slice(0, 400)}`));
  }
  const prefixList = Array.isArray(prefix) ? prefix : [];
  const lastAssistants = prefixList.filter((message) => message.role === "assistant" && message.content).slice(-3);
  if (lastAssistants.length) {
    parts.push("", "## Last assistant notes (from folded messages)", ...lastAssistants.map((message) => `- ${String(message.content).slice(0, 300)}`));
  }
  const folded = prefixList.filter((message) => message.role !== "system").length;
  parts.push("", "## Compacted away", `- ${folded} earlier message${folded === 1 ? "" : "s"} were folded into this summary to free context. The full transcript remains in the session file's history before this compaction.`);

  const importantFacts = prefixList
    .flatMap((message) => {
      if (!Array.isArray(message.tool_calls)) return [];
      return message.tool_calls
        .map((call) => call.function?.name || "")
        .filter((name) => ["patch_files", "write_text_file", "run_cmd", "run_powershell", "git_commit", "agent_handoff", "agent_claim"].includes(name))
        .map((name) => `- tool ${name}`);
    });
  const uniqueFacts = [...new Set(importantFacts)].slice(0, 20);
  if (uniqueFacts.length) {
    parts.push("", "## Tool activity in folded messages", ...uniqueFacts);
  }
  return parts.join("\n");
}

// ---------------------------------------------------------------------------
// Apply + orchestrate.
// ---------------------------------------------------------------------------

export function applyCompaction(messages, { keepStart, summary, meta = {} }) {
  const list = Array.isArray(messages) ? messages : [];
  const system = list[0]?.role === "system" ? list[0] : null;
  const tail = list.slice(Math.max(Number(keepStart) || 1, 1));
  const at = meta.at || new Date().toISOString();
  const summaryMessage = {
    role: "user",
    content: [
      `<context_compaction at="${at}" method="${meta.method || "auto"}" from_tokens="${meta.usage ?? ""}" to_tokens="${meta.projectedTokens ?? ""}">`,
      String(summary || "").trim(),
      "</context_compaction>"
    ].join("\n")
  };
  return system ? [system, summaryMessage, ...tail] : [summaryMessage, ...tail];
}

export async function compactSession(opts, session, hooks = {}) {
  if (!session || !Array.isArray(session.messages)) return null;
  const method = String(opts.compactMethod || "auto").toLowerCase();
  if (method === "off" || method === "detached") return null; // detached is handled by the wrapper/spawn path

  const plan = computeCompactionPlan(session.messages, {
    limit: opts.contextLimit,
    threshold: opts.compactForce ? 0.01 : opts.compactAt,
    keepRecent: opts.compactKeepRecent,
    completionTokens: opts.maxTokens
  });
  if (!plan.needed) return null;

  if (typeof hooks.onStart === "function") hooks.onStart(plan, method);

  const at = new Date().toISOString();
  let summary;
  let usedMethod;
  if (method === "llm" || method === "auto") {
    try {
      const transcript = truncateTranscriptForSummary(plan.prefix);
      summary = await summarizeWithLlm(opts, transcript);
      usedMethod = "llm";
    } catch (error) {
      if (method === "auto") {
        summary = buildDeterministicSummary(session, plan.prefix);
        usedMethod = `truncate_fallback (${error.message.slice(0, 120)})`;
      } else {
        throw error;
      }
    }
  } else {
    summary = buildDeterministicSummary(session, plan.prefix);
    usedMethod = "truncate";
  }

  const meta = {
    at,
    method: usedMethod,
    usage: plan.usage,
    usageScaled: plan.usageScaled,
    target: plan.target,
    limit: plan.limit,
    messagesBudget: plan.messagesBudget,
    threshold: plan.threshold,
    projectedTokens: plan.projectedTokens,
    foldedMessages: plan.prefix.filter((message) => message.role !== "system").length,
    keptMessages: plan.tail.length,
    keptStartIndex: plan.keepStart
  };
  session.messages = applyCompaction(session.messages, { keepStart: plan.keepStart, summary, meta });
  if (!Array.isArray(session.compactions)) session.compactions = [];
  session.compactions.push(meta);
  session.updatedAt = at;
  return meta;
}

// ---------------------------------------------------------------------------
// Detached mode: spawn scripts/compact-session.mjs against a persisted copy
// of the session, then merge the compacted transcript back in-process.
// ---------------------------------------------------------------------------

export async function compactSessionDetached(opts, session) {
  if (!session || !Array.isArray(session.messages)) return null;
  if (opts.compactMethod !== "detached") return null;
  if (!opts.session) throw new Error("detached compaction requires --session (a persisted session file).");

  const plan = computeCompactionPlan(session.messages, {
    limit: opts.contextLimit,
    threshold: opts.compactAt,
    keepRecent: opts.compactKeepRecent
  });
  if (!plan.needed) return null;

  const script = fileURLToPath(new URL("../scripts/compact-session.mjs", import.meta.url));
  const tmpIn = `${opts.session}.compact-in-${process.pid}-${Date.now()}.json`;
  const tmpOut = `${opts.session}.compact-out-${process.pid}-${Date.now()}.json`;
  await mkdir(dirname(tmpIn), { recursive: true });
  await writeFile(tmpIn, `${JSON.stringify(session, null, 2)}\n`, "utf8");
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [
        script, tmpIn,
        "--out", tmpOut,
        "--at", String(opts.compactAt),
        "--limit", String(opts.contextLimit),
        "--keep-recent", String(opts.compactKeepRecent),
        "--method", "llm",
        "--completion", String(opts.maxTokens)
      ], { windowsHide: true });
      let stderr = "";
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      const timer = setTimeout(() => child.kill(), COMPACT_TIMEOUT_MS + 30_000);
      child.on("error", reject);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolvePromise(null);
        else reject(new Error(`compactor process exited ${code}: ${stderr.trim().slice(-400)}`));
      });
    });

    const result = JSON.parse(await readFile(tmpOut, "utf8"));
    if (!result.compacted) return null;
    if (!Array.isArray(result.messages) || !result.messages.length) throw new Error("compactor returned an empty transcript.");
    session.messages = result.messages;
    session.compactions = Array.isArray(result.compactions) ? result.compactions : [];
    session.updatedAt = new Date().toISOString();
    return result.meta || session.compactions[session.compactions.length - 1] || null;
  } finally {
    await unlink(tmpIn).catch(() => {});
    await unlink(tmpOut).catch(() => {});
  }
}
