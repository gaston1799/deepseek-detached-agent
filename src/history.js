// src/history.js — session-history rendering for resumed interactive sessions.
//
// Older messages are summarized to keep the resume view usable; the FINAL
// assistant/user message renders in full (with markdown-lite styling) so a
// resumed session always shows the actual last answer, not a 900-char cut.
import { renderMarkdownLine } from "./tui.js";

export function compactText(value, max = 900) {
  const text = String(value || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n...`;
}

export function historyTitle(message) {
  if (message.role === "user") return "you";
  if (message.role === "assistant") return "assistant";
  if (message.role === "tool") return "tool";
  return message.role || "message";
}

export function historyBody(message) {
  if (message.role === "tool") {
    return compactText(message.content, 500);
  }
  if (message.tool_calls?.length) {
    const calls = message.tool_calls.map((call) => call.function?.name || "tool").join(", ");
    const content = compactText(message.content, 500);
    return content ? `${content}\n[tool calls: ${calls}]` : `[tool calls: ${calls}]`;
  }
  return compactText(message.content, message.role === "assistant" ? 900 : 700);
}

// Full body for the final message: the last answer must be readable on resume.
export function fullHistoryBody(message, max = 12000) {
  const text = String(message.content || "").replace(/\r\n/g, "\n").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}\n… [truncated ${text.length - max} chars]`;
}

export function renderChatHistory(opts, session, { maxMessages = 18, write = (text) => process.stdout.write(text) } = {}) {
  const all = (session.messages || []).filter((message) => message.role !== "system");
  const messages = all.slice(-maxMessages);
  const hidden = all.length - messages.length;

  write("\x1b[2J\x1b[H");
  write(`  ${bold(opts, "Session history")}\n`);
  write(`  ${dim(opts, `permission ${session.config?.permission || "ask"}  -  ${messages.length} of ${all.length} shown`)}\n\n`);

  if (messages.length === 0) {
    write(`  ${dim(opts, "No previous messages.")}\n\n`);
    return;
  }

  if (hidden > 0) {
    write(`  ${dim(opts, `… ${hidden} older message${hidden !== 1 ? "s" : ""} hidden`)}\n\n`);
  }

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const isLast = i === messages.length - 1;
    const title = historyTitle(message);
    const colorCode = message.role === "user" ? "1;36" : message.role === "assistant" ? "1;32" : "1;33";

    if (isLast && (message.role === "assistant" || message.role === "user")) {
      // Full final message, markdown-styled, marked as latest.
      write(`  ${bold(opts, "▸")} ${color(opts, colorCode, `${title} (latest)`)}\n`);
      const fence = { inFence: () => false, setFence: () => {} };
      const styled = (line) => renderMarkdownLine(opts, line, { inFence: fence.inFence, setFence: fence.setFence });
      const lines = fullHistoryBody(message).split("\n").map((line) => styled(line));
      if (fence.inFence()) lines.push("```");
      write(`${lines.join("\n")}\n\n`);
      continue;
    }

    const body = historyBody(message);
    write(`  ${color(opts, colorCode, title)}\n`);
    write(`${dim(opts, body.split("\n").map((line) => `    ${line}`).join("\n"))}\n\n`);
  }
}

function dim(opts, text) { return opts?.color ? `\x1b[2m${text}\x1b[0m` : text; }
function bold(opts, text) { return opts?.color ? `\x1b[1m${text}\x1b[0m` : text; }
function color(opts, code, text) { return opts?.color ? `\x1b[${code}m${text}\x1b[0m` : text; }
