import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { writeArtifact } from "./artifacts.js";

const DEFAULT_MAX_MATCHES = 200;
const MAX_MATCHES = 2000;
const DEFAULT_RESULT_CHARS = 1200;
const DEFAULT_TOTAL_CHARS = 24000;
const DEFAULT_REGEX_TIMEOUT = 750;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATE_FILES = 5000;
const DEFAULT_TRAVERSAL_TIMEOUT = 3000;
const DEFAULT_SEARCH_TIMEOUT = 10000;
const MAX_BEAUTIFIED_LINE_LENGTH = 240;
const MAX_BEAUTIFY_BYTES = 5 * 1024 * 1024;
const SOURCE_EXTENSIONS = /\.(?:(?:c|m)?js|jsx?|tsx?|css|scss|less|vue|svelte|html?|xml)$/i;

function globToRegex(pattern) {
  let out = "";
  const value = String(pattern || "").replace(/\\/g, "/");
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === "*" && value[i + 1] === "*") { out += ".*"; i += value[i + 2] === "/" ? 2 : 1; }
    else if (ch === "*") out += "[^/]*";
    else if (ch === "?") out += "[^/]";
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${out}$`, "i");
}

function token(value) { return Buffer.from(JSON.stringify(value)).toString("base64url"); }
function untoken(value) { try { return JSON.parse(Buffer.from(String(value), "base64url").toString("utf8")); } catch { throw new Error("Invalid search continuation token."); } }

function isLikelyBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  return sample.includes(0);
}

function fileSignals(text, bytes) {
  const lines = text.split("\n");
  const maxLine = lines.reduce((max, line) => Math.max(max, line.length), 0);
  const average = bytes / Math.max(lines.length, 1);
  return { line_count: lines.length, max_line_length: maxLine, average_line_length: Math.round(average), minified: maxLine > 10000 || average > 1000 || (bytes > 200000 && lines.length < 100) };
}

function appendIndent(output, indent) {
  if (output.length === 0 || output.at(-1) === "\n") output.push("  ".repeat(Math.max(indent, 0)));
}

function trimTrailingWhitespace(output) {
  while (output.length && /\s$/.test(output.at(-1)) && output.at(-1) !== "\n") output.pop();
}

function newline(output, indent) {
  trimTrailingWhitespace(output);
  if (output.at(-1) !== "\n") output.push("\n");
  appendIndent(output, indent);
}

// This is deliberately a conservative formatter for search context, not a source formatter.
// It only adds boundaries outside strings/comments so bundled lines cannot consume the model context.
function beautifySourceForSearch(text) {
  const output = [];
  let indent = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
  let parenDepth = 0;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];

    if (quote) {
      appendIndent(output, indent);
      output.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (lineComment) {
      output.push(ch);
      if (ch === "\n") { lineComment = false; appendIndent(output, indent); }
      continue;
    }
    if (blockComment) {
      output.push(ch);
      if (ch === "*" && next === "/") { output.push(next); i += 1; blockComment = false; newline(output, indent); }
      continue;
    }
    if ((ch === "'" || ch === '"' || ch === "`") && !quote) {
      appendIndent(output, indent);
      output.push(ch);
      quote = ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      appendIndent(output, indent);
      output.push(ch, next);
      i += 1;
      lineComment = true;
      continue;
    }
    if (ch === "/" && next === "*") {
      appendIndent(output, indent);
      output.push(ch, next);
      i += 1;
      blockComment = true;
      continue;
    }
    if (ch === "(") parenDepth += 1;
    if (ch === ")") parenDepth = Math.max(0, parenDepth - 1);
    if (ch === "{") {
      trimTrailingWhitespace(output);
      output.push(" {");
      indent += 1;
      newline(output, indent);
    } else if (ch === "}") {
      indent = Math.max(0, indent - 1);
      newline(output, indent);
      output.push("}");
      if (next !== ";" && next !== "," && next !== ")" && next !== "]") newline(output, indent);
    } else if (ch === ";" && parenDepth === 0) {
      output.push(";");
      newline(output, indent);
    } else if (ch === "\n") {
      newline(output, indent);
    } else if (/\s/.test(ch)) {
      if (output.length && output.at(-1) !== " " && output.at(-1) !== "\n") output.push(" ");
    } else {
      appendIndent(output, indent);
      output.push(ch);
    }
  }

  trimTrailingWhitespace(output);
  return output.join("").trim();
}

function wrapLongLinesForSearch(text) {
  return text.split("\n").flatMap((line) => {
    if (line.length <= MAX_BEAUTIFIED_LINE_LENGTH) return [line];
    const chunks = [];
    for (let offset = 0; offset < line.length; offset += MAX_BEAUTIFIED_LINE_LENGTH) {
      chunks.push(line.slice(offset, offset + MAX_BEAUTIFIED_LINE_LENGTH));
    }
    return chunks;
  }).join("\n");
}

function searchView(text, relPath, signals, bytes) {
  if (!signals.minified) return { text, mode: "source" };
  if (bytes > MAX_BEAUTIFY_BYTES) return { text, mode: "bounded" };
  if (/\.json$/i.test(relPath)) {
    try { return { text: JSON.stringify(JSON.parse(text), null, 2), mode: "beautified" }; }
    catch { /* Fall through to the source formatter for JSON-like bundles. */ }
  }
  if (SOURCE_EXTENSIONS.test(relPath)) return { text: beautifySourceForSearch(text), mode: "beautified" };
  return { text: wrapLongLinesForSearch(text), mode: "wrapped" };
}

function lineColumn(text, offset) {
  const before = text.slice(0, offset);
  const line = before.split("\n").length;
  const last = before.lastIndexOf("\n");
  return { line, column: offset - last };
}

function literalMatches(text, pattern, ignoreCase, max) {
  const source = ignoreCase ? text.toLowerCase() : text;
  const needle = ignoreCase ? pattern.toLowerCase() : pattern;
  const found = [];
  let from = 0;
  while (found.length < max) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    found.push({ index, text: text.slice(index, index + pattern.length) });
    from = index + Math.max(needle.length, 1);
  }
  return found;
}

function regexMatches(text, pattern, flags, max, timeoutMs) {
  return new Promise((resolvePromise, reject) => {
    const worker = new Worker(`
      const { parentPort, workerData } = require("node:worker_threads");
      try {
        const rx = new RegExp(workerData.pattern, workerData.flags.includes("g") ? workerData.flags : workerData.flags + "g");
        const matches = []; let match;
        while (matches.length < workerData.max && (match = rx.exec(workerData.text)) !== null) {
          matches.push({ index: match.index, text: match[0] });
          if (match[0] === "") rx.lastIndex += 1;
        }
        parentPort.postMessage({ matches });
      } catch (error) { parentPort.postMessage({ error: error.message }); }
    `, { eval: true, workerData: { text, pattern, flags, max } });
    const timer = setTimeout(() => { void worker.terminate(); reject(Object.assign(new Error("regex execution timeout"), { code: "REGEX_TIMEOUT" })); }, Math.min(Math.max(Number(timeoutMs) || DEFAULT_REGEX_TIMEOUT, 25), 10000));
    worker.once("message", (message) => { clearTimeout(timer); void worker.terminate(); message.error ? reject(new Error(message.error)) : resolvePromise(message.matches); });
    worker.once("error", (error) => { clearTimeout(timer); void worker.terminate(); reject(error); });
  });
}

function isFilesystemRoot(path) {
  const normalized = resolve(path);
  return dirname(normalized) === normalized;
}

async function collectFiles(root, target, glob, excludes, { maxFiles, timeoutMs }) {
  const info = await stat(target);
  if (info.isFile()) return { files: [{ absPath: target, relPath: relative(root, target).replaceAll("\\", "/") }], truncated: false, visitedEntries: 1, reason: null };
  const entries = [];
  const startedAt = Date.now();
  let visitedEntries = 0;
  let truncated = false;
  let reason = null;
  async function visit(dir) {
    if (truncated) return;
    if (Date.now() - startedAt >= timeoutMs) { truncated = true; reason = "traversal_timeout"; return; }
    const { readdir } = await import("node:fs/promises");
    let children;
    try { children = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const item of children) {
      if (truncated) return;
      visitedEntries += 1;
      if (visitedEntries > maxFiles) { truncated = true; reason = "candidate_file_limit"; return; }
      if (Date.now() - startedAt >= timeoutMs) { truncated = true; reason = "traversal_timeout"; return; }
      if (item.isDirectory() && !excludes.has(item.name)) await visit(resolve(dir, item.name));
      else if (item.isFile()) {
        const absPath = resolve(dir, item.name);
        const relPath = relative(root, absPath).replaceAll("\\", "/");
        if (!glob || glob.test(relPath) || glob.test(item.name)) entries.push({ absPath, relPath });
      }
    }
  }
  await visit(target);
  return { files: entries, truncated, visitedEntries, reason };
}

export async function boundedSearch({ cwd = process.cwd(), taskId, pattern, path = ".", glob, ignoreCase = false, maxMatches = DEFAULT_MAX_MATCHES, maxResultChars = DEFAULT_RESULT_CHARS, maxTotalChars = DEFAULT_TOTAL_CHARS, contextChars = 160, regexTimeoutMs = DEFAULT_REGEX_TIMEOUT, maxCandidateFiles = DEFAULT_MAX_CANDIDATE_FILES, traversalTimeoutMs = DEFAULT_TRAVERSAL_TIMEOUT, searchTimeoutMs = DEFAULT_SEARCH_TIMEOUT, pageToken, allowExternal = false, excludes = [".git", ".deepseek-watch", "node_modules", "dist", "build", "out", ".next", ".cache", "coverage"] }) {
  const root = resolve(cwd);
  const requested = isAbsolute(String(path)) ? resolve(String(path)) : resolve(root, String(path || "."));
  if (!allowExternal && !isAbsolutePathInside(root, requested)) throw new Error("Path escapes workspace; use full permission for explicit external paths.");
  if (isFilesystemRoot(requested)) throw new Error("Refusing to recursively search a filesystem root. Change to a project directory or an explicit file/subdirectory.");
  const max = Math.min(Math.max(Number(maxMatches) || DEFAULT_MAX_MATCHES, 1), MAX_MATCHES);
  const resultCap = Math.min(Math.max(Number(maxResultChars) || DEFAULT_RESULT_CHARS, 80), 10000);
  const totalCap = Math.min(Math.max(Number(maxTotalChars) || DEFAULT_TOTAL_CHARS, resultCap), 200000);
  const offset = pageToken ? untoken(pageToken).offset || 0 : 0;
  const traversal = await collectFiles(root, requested, glob ? globToRegex(glob) : null, new Set(excludes), {
    maxFiles: Math.min(Math.max(Number(maxCandidateFiles) || DEFAULT_MAX_CANDIDATE_FILES, 1), 20000),
    timeoutMs: Math.min(Math.max(Number(traversalTimeoutMs) || DEFAULT_TRAVERSAL_TIMEOUT, 100), 30000)
  });
  const files = traversal.files;
  const searchDeadline = Date.now() + Math.min(Math.max(Number(searchTimeoutMs) || DEFAULT_SEARCH_TIMEOUT, 250), 60000);
  const regex = (() => { try { new RegExp(pattern, ignoreCase ? "i" : ""); return true; } catch { return false; } })();
  const matches = []; let scanned = 0; let skipped = 0; let timedOut = false; let consumed = 0; let hitCap = false; let totalChars = 0; let beautifiedFiles = 0;
  for (const file of files) {
    if (Date.now() >= searchDeadline) { timedOut = true; break; }
    if (matches.length >= max || consumed >= totalCap) break;
    let buffer; try { buffer = await readFile(file.absPath); } catch { skipped += 1; continue; }
    if (buffer.length > MAX_FILE_BYTES || isLikelyBinary(buffer)) { skipped += 1; continue; }
    const text = buffer.toString("utf8"); const signals = fileSignals(text, buffer.length); const view = searchView(text, file.relPath, signals, buffer.length); scanned += 1;
    if (view.mode === "beautified") beautifiedFiles += 1;
    const searchableText = view.text;
    let found;
    try {
      found = regex
        ? await regexMatches(searchableText, pattern, ignoreCase ? "gi" : "g", max - matches.length + offset, Math.min(regexTimeoutMs, Math.max(searchDeadline - Date.now(), 25)))
        : literalMatches(searchableText, pattern, ignoreCase, max - matches.length + offset);
    } catch (error) { if (error.code === "REGEX_TIMEOUT") { timedOut = true; break; } throw error; }
    for (const item of found) {
      if (consumed < offset) { consumed += 1; continue; }
      const location = lineColumn(searchableText, item.index);
      const start = Math.max(0, item.index - contextChars); const end = Math.min(searchableText.length, item.index + item.text.length + contextChars);
      const rawSnippet = searchableText.slice(start, end).replace(/\r?\n/g, "\\n");
      const snippet = rawSnippet.length > resultCap ? rawSnippet.slice(0, resultCap) + "…" : rawSnippet;
      const entry = { path: file.relPath, match: item.text.slice(0, resultCap), character_offset: item.index, byte_offset: Buffer.byteLength(searchableText.slice(0, item.index), "utf8"), line: location.line, column: location.column, snippet, minified: signals.minified, search_view: view.mode };
      const serialized = JSON.stringify(entry);
      if (totalChars + serialized.length > totalCap) { hitCap = true; break; }
      matches.push(entry); consumed += 1;
      totalChars += serialized.length;
    }
    if (found.length >= max - matches.length + offset || hitCap) { hitCap = true; break; }
  }
  const more = hitCap || timedOut;
  const raw = JSON.stringify({ pattern, matches, scanned_files: scanned, skipped_files: skipped, beautified_files: beautifiedFiles, timed_out: timedOut, traversal_truncated: traversal.truncated, traversal_reason: traversal.reason, visited_entries: traversal.visitedEntries, result_cap: resultCap, total_cap: totalCap }, null, 2);
  const artifact = await writeArtifact({ cwd, taskId, kind: "search", name: "search-results.json", data: raw, metadata: { pattern, matches: matches.length, timed_out: timedOut, traversal_truncated: traversal.truncated } });
  return { matches, scanned_files: scanned, skipped_files: skipped, beautified_files: beautifiedFiles, timed_out: timedOut, traversal_truncated: traversal.truncated, traversal_reason: traversal.reason, visited_entries: traversal.visitedEntries, artifact, next_page_token: more ? token({ offset: offset + matches.length, pattern, path }) : null };
}

function isAbsolutePathInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
