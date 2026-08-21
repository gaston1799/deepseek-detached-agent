import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { writeArtifact } from "./artifacts.js";

const DEFAULT_MAX_MATCHES = 200;
const MAX_MATCHES = 2000;
const DEFAULT_RESULT_CHARS = 1200;
const DEFAULT_TOTAL_CHARS = 24000;
const DEFAULT_REGEX_TIMEOUT = 750;
const MAX_FILE_BYTES = 100 * 1024 * 1024;

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

async function collectFiles(root, target, glob, excludes) {
  const info = await stat(target);
  if (info.isFile()) return [{ absPath: target, relPath: relative(root, target).replaceAll("\\", "/") }];
  const entries = [];
  async function visit(dir) {
    const { readdir } = await import("node:fs/promises");
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (item.isDirectory() && !excludes.has(item.name)) await visit(resolve(dir, item.name));
      else if (item.isFile()) {
        const absPath = resolve(dir, item.name);
        const relPath = relative(root, absPath).replaceAll("\\", "/");
        if (!glob || glob.test(relPath) || glob.test(item.name)) entries.push({ absPath, relPath });
      }
    }
  }
  await visit(target);
  return entries;
}

export async function boundedSearch({ cwd = process.cwd(), taskId, pattern, path = ".", glob, ignoreCase = false, maxMatches = DEFAULT_MAX_MATCHES, maxResultChars = DEFAULT_RESULT_CHARS, maxTotalChars = DEFAULT_TOTAL_CHARS, contextChars = 160, regexTimeoutMs = DEFAULT_REGEX_TIMEOUT, pageToken, allowExternal = false, excludes = [".git", ".deepseek-watch", "node_modules", "dist", "build", "out", ".next", ".cache", "coverage"] }) {
  const root = resolve(cwd);
  const requested = isAbsolute(String(path)) ? resolve(String(path)) : resolve(root, String(path || "."));
  if (!allowExternal && !isAbsolutePathInside(root, requested)) throw new Error("Path escapes workspace; use full permission for explicit external paths.");
  const max = Math.min(Math.max(Number(maxMatches) || DEFAULT_MAX_MATCHES, 1), MAX_MATCHES);
  const resultCap = Math.min(Math.max(Number(maxResultChars) || DEFAULT_RESULT_CHARS, 80), 10000);
  const totalCap = Math.min(Math.max(Number(maxTotalChars) || DEFAULT_TOTAL_CHARS, resultCap), 200000);
  const offset = pageToken ? untoken(pageToken).offset || 0 : 0;
  const files = await collectFiles(root, requested, glob ? globToRegex(glob) : null, new Set(excludes));
  const regex = (() => { try { new RegExp(pattern, ignoreCase ? "i" : ""); return true; } catch { return false; } })();
  const matches = []; let scanned = 0; let skipped = 0; let timedOut = false; let consumed = 0; let hitCap = false; let totalChars = 0;
  for (const file of files) {
    if (matches.length >= max || consumed >= totalCap) break;
    let buffer; try { buffer = await readFile(file.absPath); } catch { skipped += 1; continue; }
    if (buffer.length > MAX_FILE_BYTES || isLikelyBinary(buffer)) { skipped += 1; continue; }
    const text = buffer.toString("utf8"); const signals = fileSignals(text, buffer.length); scanned += 1;
    let found;
    try {
      found = regex
        ? await regexMatches(text, pattern, ignoreCase ? "gi" : "g", max - matches.length + offset, regexTimeoutMs)
        : literalMatches(text, pattern, ignoreCase, max - matches.length + offset);
    } catch (error) { if (error.code === "REGEX_TIMEOUT") { timedOut = true; break; } throw error; }
    for (const item of found) {
      if (consumed < offset) { consumed += 1; continue; }
      const location = lineColumn(text, item.index);
      const start = Math.max(0, item.index - contextChars); const end = Math.min(text.length, item.index + item.text.length + contextChars);
      const rawSnippet = text.slice(start, end).replace(/\r?\n/g, "\\n");
      const snippet = rawSnippet.length > resultCap ? rawSnippet.slice(0, resultCap) + "…" : rawSnippet;
      const entry = { path: file.relPath, match: item.text.slice(0, resultCap), character_offset: item.index, byte_offset: Buffer.byteLength(text.slice(0, item.index), "utf8"), line: location.line, column: location.column, snippet, minified: signals.minified };
      const serialized = JSON.stringify(entry);
      if (totalChars + serialized.length > totalCap) { hitCap = true; break; }
      matches.push(entry); consumed += 1;
      totalChars += serialized.length;
    }
    if (found.length >= max - matches.length + offset || hitCap) { hitCap = true; break; }
  }
  const more = hitCap || timedOut;
  const raw = JSON.stringify({ pattern, matches, scanned_files: scanned, skipped_files: skipped, timed_out: timedOut, result_cap: resultCap, total_cap: totalCap }, null, 2);
  const artifact = await writeArtifact({ cwd, taskId, kind: "search", name: "search-results.json", data: raw, metadata: { pattern, matches: matches.length, timed_out: timedOut } });
  return { matches, scanned_files: scanned, skipped_files: skipped, timed_out: timedOut, artifact, next_page_token: more ? token({ offset: offset + matches.length, pattern, path }) : null };
}

function isAbsolutePathInside(root, target) {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
