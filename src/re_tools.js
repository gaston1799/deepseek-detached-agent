// src/re_tools.js — general-purpose binary/RE tooling for the dsw harness.
//
// Scope: analysis of files you own / are authorized to analyze. All tools are
// local-file analyzers (no network). Workspace paths are enforced by the
// dispatch layer (assertInsideWorkspace). Detection/analysis only.
//
// Tool prefix: re_  (strings, diff, asar, dotnet metadata, ghidra runner)
import { createHash } from "node:crypto";
import { readFile, stat, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeArtifact, registerArtifactFile, taskRoot } from "./artifacts.js";
import { sandboxExecute } from "./sandbox.js";
import { peTriage } from "./triage.js";

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

export function entropy(buffer) {
  if (!buffer.length) return 0;
  const counts = new Array(256).fill(0);
  for (const value of buffer) counts[value] += 1;
  return -counts.reduce((sum, count) => count ? sum + (count / buffer.length) * Math.log2(count / buffer.length) : sum, 0);
}

export function extractAsciiStrings(buffer, min = 4, max = 50000) {
  const out = [];
  let text = "";
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte >= 32 && byte < 127) { text += String.fromCharCode(byte); continue; }
    if (text.length >= min) out.push({ value: text, offset: i - text.length, length: text.length });
    text = "";
    if (out.length >= max) return out;
  }
  if (text.length >= min && out.length < max) out.push({ value: text, offset: buffer.length - text.length, length: text.length });
  return out;
}

export function extractUtf16Strings(buffer, min = 4, max = 10000) {
  const out = [];
  let text = "";
  let start = 0;
  for (let i = 0; i + 1 < buffer.length; i += 2) {
    const code = buffer[i];
    const next = buffer[i + 1];
    if (next === 0 && code >= 32 && code < 127) {
      if (!text) start = i;
      text += String.fromCharCode(code);
    } else {
      if (text.length >= min) out.push({ value: text, offset: start, length: text.length });
      text = "";
      if (out.length >= max) return out;
    }
  }
  if (text.length >= min && out.length < max) out.push({ value: text, offset: start, length: text.length });
  return out;
}

// ── re_strings: classified strings extraction ───────────────────────────────
const STRING_CLASSIFIERS = [
  [/^https?:\/\//i, "url"],
  [/^wss?:\/\//i, "websocket"],
  [/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/, "email"],
  [/^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{1,}$/, "jwt"],
  [/^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::[0-9]+)?$/i, "domain"],
  [/^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/, "ipv4"],
  [/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "guid"],
  [/^eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}$/, "jwt"],
  [/^\\\\[^\\]+\\(?:pipe|device|globalroot)\\/i, "pipe"],
  [/^(?:HKEY_(?:CLASSES_ROOT|CURRENT_USER|LOCAL_MACHINE|USERS|CURRENT_CONFIG)|HKLM|HKCU|HKCR|HKU)[\\/]/i, "registry"],
  [/^(?:[A-Za-z]:[\\/]|\\\\|\/var\/|\/etc\/|\/tmp\/|\/opt\/|\/home\/|\/usr\/|\/bin\/|\/sbin\/)/, "file_path"],
  [/^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/, "private_key"],
  [/^(?:select|insert|update|delete|create|drop|alter|grant|union|exec|truncate)\s/i, "sql"],
  [/^--?[a-z][a-z0-9_-]{1,}$/i, "command_flag"],
  [/^(?:sh|bash|cmd|powershell|pwsh|curl|wget|nc|ncat|nmap|chmod|chown|kill|ps|grep|find|tar|zip)\s/i, "shell_command"],
  [/^\/api\//i, "api_path"],
  [/^\{[\s\S]{2,}\}$/, "json"],
];

function classifyString(value, entropyValue) {
  for (const [re, label] of STRING_CLASSIFIERS) {
    if (re.test(value)) return label;
  }
  if (entropyValue >= 3.5 && value.length >= 16 && /^[A-Za-z0-9+/]{16,}={0,2}$/.test(value)) return "base64_blob";
  if (entropyValue >= 4.0 && value.length >= 16 && /^[0-9a-f]{16,}$/i.test(value)) return "hex_blob";
  return "plain";
}

export function classifyStrings(strings) {
  const grouped = {};
  for (const item of strings) {
    const e = entropy(Buffer.from(item.value, "utf8"));
    const category = classifyString(item.value, e);
    (grouped[category] ||= []).push({ ...item, entropy: Number(e.toFixed(2)) });
  }
  return grouped;
}

async function reStrings(args, ctx) {
  const target = resolve(ctx.cwd, args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("re_strings path must be a file.");
  if (info.size > 256 * 1024 * 1024) throw new Error("File too large for re_strings (max 256MB). Use offset/limit for large files.");
  const offset = Math.min(Math.max(Number(args.offset) || 0, 0), info.size);
  const limit = Math.min(Math.max(Number(args.limit) || info.size, 1), info.size - offset);
  const buffer = await readFile(target);
  const slice = buffer.subarray(offset, offset + limit);
  const minLen = Math.min(Math.max(Number(args.min_len) || 4, 3), 64);
  const includeUtf16 = args.utf16 !== false;
  const maxPerCategory = Math.min(Math.max(Number(args.max_strings) || 500, 10), 5000);

  const ascii = extractAsciiStrings(slice, minLen);
  const utf16 = includeUtf16 ? extractUtf16Strings(slice, minLen) : [];
  const combined = [...ascii.map((s) => ({ ...s, encoding: "ascii" })), ...utf16.map((s) => ({ ...s, encoding: "utf16" }))];
  const grouped = classifyStrings(combined);

  const categoryFilter = args.category ? String(args.category).toLowerCase().split(",").map((c) => c.trim()).filter(Boolean) : null;
  const lines = [`Classified strings — ${args.path} (${slice.length} bytes analyzed, min_len ${minLen})`];
  const totals = Object.entries(grouped).sort((a, b) => b[1].length - a[1].length);
  for (const [category, items] of totals) {
    if (categoryFilter && !categoryFilter.includes(category)) continue;
    lines.push(`\n[${category}] ${items.length}:`);
    for (const item of capList(items, maxPerCategory)) {
      const value = item.value.length > 200 ? `${item.value.slice(0, 200)}…` : item.value;
      lines.push(`  @${item.offset} e${item.entropy} (${item.encoding}) ${JSON.stringify(value)}`);
    }
  }
  if (categoryFilter) {
    const present = totals.map(([c]) => c);
    lines.push(`\nCategory filter requested: ${categoryFilter.join(",")} — present: ${present.join(", ")}`);
  }
  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "strings", name: `${args.path.split(/[\\/]/).pop()}.strings.json`, data: JSON.stringify(grouped, null, 2), metadata: { source: args.path, bytes: slice.length } });
  lines.push(`\nArtifact: ${artifact.path}`);
  return lines.join("\n");
}

// ── re_diff: binary / version diffing ───────────────────────────────────────
async function blockHashes(buffer, blockSize) {
  const hashes = [];
  for (let offset = 0; offset < buffer.length; offset += blockSize) {
    const block = buffer.subarray(offset, Math.min(buffer.length, offset + blockSize));
    hashes.push(createHash("sha256").update(block).digest("hex").slice(0, 16));
  }
  return hashes;
}

export function diffBlockHashes(before, after) {
  const beforeMap = new Map();
  before.forEach((h, i) => {
    if (!beforeMap.has(h)) beforeMap.set(h, []);
    beforeMap.get(h).push(i);
  });
  const matchedAfter = new Set();
  const matchedBefore = new Set();
  for (let i = 0; i < after.length; i++) {
    const positions = beforeMap.get(after[i]);
    if (positions?.length) {
      const p = positions.find((x) => !matchedBefore.has(x));
      if (p !== undefined) { matchedBefore.add(p); matchedAfter.add(i); }
    }
  }
  const removed = before.filter((_, i) => !matchedBefore.has(i)).length;
  const added = after.filter((_, i) => !matchedAfter.has(i)).length;
  const unchanged = matchedAfter.size;
  const similarity = after.length ? (unchanged / after.length) * 100 : 100;
  return { before_blocks: before.length, after_blocks: after.length, unchanged, added, removed, similarity: Number(similarity.toFixed(1)) };
}

async function reDiff(args, ctx) {
  const beforePath = resolve(ctx.cwd, args.before);
  const afterPath = resolve(ctx.cwd, args.after);
  for (const p of [beforePath, afterPath]) {
    const info = await stat(p);
    if (!info.isFile()) throw new Error(`re_diff path is not a file: ${p}`);
  }
  const blockSize = Math.min(Math.max(Number(args.block_size) || 4096, 256), 1024 * 1024);
  const [before, after] = await Promise.all([readFile(beforePath), readFile(afterPath)]);
  const beforeHashes = await blockHashes(before, blockSize);
  const afterHashes = await blockHashes(after, blockSize);
  const stats = diffBlockHashes(beforeHashes, afterHashes);

  const lines = [
    `Binary diff — ${args.before} (${before.length} bytes) vs ${args.after} (${after.length} bytes)`,
    `Block size ${blockSize}: unchanged ${stats.unchanged}, added ${stats.added}, removed ${stats.removed} — similarity ${stats.similarity}%`,
    `sha256 before: ${createHash("sha256").update(before).digest("hex")}`,
    `sha256 after:  ${createHash("sha256").update(after).digest("hex")}`,
  ];

  const maxStrings = Math.min(Math.max(Number(args.max_strings) || 100, 10), 1000);
  const beforeStrings = new Set(extractAsciiStrings(before, 6).map((s) => s.value));
  const afterStrings = new Set(extractAsciiStrings(after, 6).map((s) => s.value));
  const addedStrings = [...afterStrings].filter((s) => !beforeStrings.has(s)).sort();
  const removedStrings = [...beforeStrings].filter((s) => !afterStrings.has(s)).sort();
  if (addedStrings.length || removedStrings.length) {
    lines.push(`\nString-level diff (new/removed, capped ${maxStrings}):`);
    if (addedStrings.length) lines.push(`  ADDED (${addedStrings.length}):\n    ${capList(addedStrings, maxStrings).join("\n    ")}`);
    if (removedStrings.length) lines.push(`  REMOVED (${removedStrings.length}):\n    ${capList(removedStrings, maxStrings).join("\n    ")}`);
  } else {
    lines.push("\nNo string-level differences found.");
  }

  // PE-aware comparison (only when both files are PE).
  const bothPe = before.toString("ascii", 0, 2) === "MZ" && after.toString("ascii", 0, 2) === "MZ";
  if (bothPe) {
    lines.push("\nPE comparison:");
    const [tb, ta] = await Promise.all([
      peTriage({ cwd: ctx.cwd, taskId: ctx.taskId, path: args.before }),
      peTriage({ cwd: ctx.cwd, taskId: ctx.taskId, path: args.after }),
    ]);
    lines.push(`  arch: ${tb.architecture} â†’ ${ta.architecture}`);
    lines.push(`  sections: ${tb.sections.map((s) => s.name).join(",")} â†’ ${ta.sections.map((s) => s.name).join(",")}`);
    const impB = tb.imports.map((i) => i.dll).join(",");
    const impA = ta.imports.map((i) => i.dll).join(",");
    if (impB !== impA) lines.push(`  import DLLs changed: ${impB || "(none)"} â†’ ${impA || "(none)"}`);
    const expB = tb.exports?.names || [];
    const expA = ta.exports?.names || [];
    const newExports = expA.filter((e) => !expB.includes(e));
    if (newExports.length) lines.push(`  new exports (${newExports.length}): ${capList(newExports, 30).join(", ")}`);
  }

  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "diff", name: `diff-${args.before.split(/[\\/]/).pop()}-vs-${args.after.split(/[\\/]/).pop()}.json`, data: JSON.stringify({ ...stats, before_sha256: createHash("sha256").update(before).digest("hex"), after_sha256: createHash("sha256").update(after).digest("hex"), added_strings: addedStrings.slice(0, 500), removed_strings: removedStrings.slice(0, 500) }, null, 2), metadata: { before: args.before, after: args.after, similarity: stats.similarity } });
  lines.push(`\nArtifact: ${artifact.path}`);
  return lines.join("\n");
}


// ── re_asar: Electron ASAR extraction + prettify + source-map discovery ─────
// ASAR layout: [uint32 header_len+4][uint32 header_len][JSON header][data...]
export function parseAsarHeader(buffer) {
  if (buffer.length < 16) throw new Error("ASAR file too small.");
  const headerSize = buffer.readUInt32LE(4);
  if (!Number.isInteger(headerSize) || headerSize <= 0 || headerSize > buffer.length - 16) {
    throw new Error(`Invalid ASAR header size: ${headerSize}`);
  }
  const headerStart = 8;
  const header = JSON.parse(buffer.toString("utf8", headerStart, headerStart + headerSize));
  const dataStart = headerStart + headerSize;
  return { header, dataStart };
}

export function asarListFiles(header, prefix = "") {
  const out = [];
  for (const [name, entry] of Object.entries(header.files || {})) {
    const path = prefix ? `${prefix}/${name}` : name;
    if (entry.files) out.push(...asarListFiles(entry, path));
    else out.push({ path, size: entry.size ?? 0, offset: entry.offset != null ? Number(entry.offset) : null, link: entry.link || null });
  }
  return out;
}

async function reAsar(args, ctx) {
  const target = resolve(ctx.cwd, args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("re_asar path must be a file.");
  if (info.size > 1024 * 1024 * 1024) throw new Error("ASAR too large (max 1GB).");
  const buffer = await readFile(target);
  const { header, dataStart } = parseAsarHeader(buffer);
  const files = asarListFiles(header);

  const action = String(args.action || "list");
  const lines = [`ASAR — ${args.path} (${buffer.length} bytes, ${files.length} files)`];

  if (action === "list") {
    const max = Math.min(Math.max(Number(args.max_files) || 300, 10), 5000);
    for (const f of capList(files, max)) {
      lines.push(`  ${f.link ? `symlinkâ†’${f.link}` : `${String(f.size).padStart(10)}  ${f.path}`}`);
    }
    if (files.length > max) lines.push(`  (showing ${max} of ${files.length})`);
    return lines.join("\n");
  }

  if (action !== "extract") throw new Error("re_asar action must be 'list' or 'extract'.");

  const outDir = resolve(ctx.cwd, args.output_dir || join(".deepseek-watch", "tasks", ctx.taskId, "extracted", `asar-${args.path.split(/[\\/]/).pop()}`));
  const maxFiles = Math.min(Math.max(Number(args.max_files) || 2000, 10), 20000);
  if (files.length > maxFiles) throw new Error(`ASAR has ${files.length} files, max ${maxFiles} for extraction.`);
  const maxBytes = Math.min(Math.max(Number(args.max_bytes) || 500 * 1024 * 1024, 1024 * 1024), 1024 * 1024 * 1024);
  let written = 0;
  let writtenBytes = 0;
  const sourceMaps = [];
  const skipped = [];

  for (const f of files) {
    if (f.link) continue;
    if (f.offset == null) { skipped.push(`${f.path} (no offset — placeholder)`); continue; }
    const start = dataStart + f.offset;
    const end = Math.min(start + f.size, buffer.length);
    if (start >= buffer.length) { skipped.push(`${f.path} (offset out of range)`); continue; }
    const fileBuf = buffer.subarray(start, end);
    if (writtenBytes + fileBuf.length > maxBytes) { skipped.push(`${f.path} (byte budget)`); break; }
    const filePath = join(outDir, f.path);
    await mkdir(dirname(filePath), { recursive: true });
    let out = fileBuf;
    if (/\.json$/i.test(f.path)) {
      try { out = Buffer.from(JSON.stringify(JSON.parse(fileBuf.toString("utf8")), null, 2)); } catch { /* keep raw */ }
    }
    if (/\.(js|mjs|cjs)$/i.test(f.path)) {
      const text = fileBuf.toString("utf8");
      const sm = text.match(/sourceMappingURL=([^\s"']+)/i);
      if (sm) sourceMaps.push({ file: f.path, url: sm[1] });
      const hasPrettifyMarker = /\n  [a-zA-Z_]/.test(text);
      if (!hasPrettifyMarker) {
        // Light prettify: insert newlines after statement boundaries in obvious minified bundles.
        const cleaned = text
          .replace(/;/g, ";\n")
          .replace(/([}])/g, "$1\n")
          .replace(/\n{3,}/g, "\n\n");
        if (cleaned.length < text.length * 1.2 || cleaned !== text) out = Buffer.from(cleaned);
      }
    }
    await writeFile(filePath, out);
    written++;
    writtenBytes += out.length;
  }

  // Write an index of what was extracted (for artifact registration).
  const indexFile = join(outDir, "_extract-index.json");
  await writeFile(indexFile, JSON.stringify({ source: args.path, files: files.filter((f) => !f.link).slice(0, 20000), source_maps: sourceMaps.slice(0, 500), skipped: skipped.slice(0, 200) }, null, 2), "utf8");
  const artifact = await registerArtifactFile({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "asar-extract", name: `${args.path.split(/[\\/]/).pop()}.extract-index.json`, file: indexFile, metadata: { source: args.path, files_extracted: written } });

  lines.push(`Extracted ${written} files (${(writtenBytes / 1024 / 1024).toFixed(1)} MB) to ${relative(ctx.cwd, outDir)}`);
  if (skipped.length) lines.push(`Skipped ${skipped.length}: ${capList(skipped, 5).join("; ")}`);
  if (sourceMaps.length) {
    lines.push(`\nSource maps discovered (${sourceMaps.length}):`);
    for (const sm of capList(sourceMaps, 20)) lines.push(`  ${sm.file} â†’ ${sm.url}`);
  }
  lines.push(`\nArtifact: ${artifact.path}`);
  return lines.join("\n");
}


// ── re_dotnet: .NET metadata reader (ILSpy-style surface, no ILSpy needed) ──
// Implements a bounded ECMA-335 metadata parser: PE â†’ CLI header â†’ #~ tables
// (TypeDef, MethodDef, Field, TypeRef, AssemblyRef, ModuleRef) + heaps.
const BSJB = 0x424A5342;
const TABLE_NAMES = {
  0x00: "Module", 0x01: "TypeRef", 0x02: "TypeDef", 0x04: "Field", 0x06: "MethodDef",
  0x08: "Param", 0x09: "InterfaceImpl", 0x0a: "MemberRef", 0x0b: "Constant",
  0x0c: "CustomAttribute", 0x0d: "FieldMarshal", 0x0e: "DeclSecurity", 0x0f: "ClassLayout",
  0x10: "FieldLayout", 0x11: "StandAloneSig", 0x12: "EventMap", 0x14: "Event",
  0x15: "PropertyMap", 0x17: "Property", 0x18: "MethodSemantics", 0x19: "MethodImpl",
  0x1a: "ModuleRef", 0x1b: "TypeSpec", 0x1c: "ImplMap", 0x1d: "FieldRVA",
  0x1e: "EncLog", 0x1f: "EncMap", 0x20: "Assembly", 0x21: "AssemblyProcessor",
  0x22: "AssemblyOS", 0x23: "AssemblyRef", 0x24: "AssemblyRefProcessor", 0x25: "AssemblyRefOS",
  0x26: "File", 0x27: "ExportedType", 0x28: "ManifestResource", 0x29: "NestedClass",
  0x2a: "GenericParam", 0x2b: "MethodSpec", 0x2c: "GenericParamConstraint",
};

export function parseDotNetMetadata(buffer) {
  if (buffer.length < 0x40 || buffer.toString("ascii", 0, 2) !== "MZ") throw new Error("Not a PE file.");
  const pe = buffer.readUInt32LE(0x3c);
  if (pe + 24 > buffer.length || buffer.toString("ascii", pe, pe + 4) !== "PE\0\0") throw new Error("Invalid PE header.");
  const sectionCount = buffer.readUInt16LE(pe + 6);
  const optionalSize = buffer.readUInt16LE(pe + 20);
  const optional = pe + 24;
  if (optional + optionalSize > buffer.length) throw new Error("Truncated optional header.");
  const is64 = buffer.readUInt16LE(optional) === 0x20b;
  const dataDirs = optional + (is64 ? 112 : 96);
  const clrDirRva = buffer.readUInt32LE(dataDirs + 14 * 8);
  if (!clrDirRva) throw new Error("No CLI header (not a .NET assembly).");

  const sections = [];
  const sectionStart = optional + optionalSize;
  for (let i = 0; i < sectionCount && sectionStart + i * 40 + 40 <= buffer.length; i++) {
    const off = sectionStart + i * 40;
    sections.push({ va: buffer.readUInt32LE(off + 12), vsize: buffer.readUInt32LE(off + 8), raw: buffer.readUInt32LE(off + 20), raws: buffer.readUInt32LE(off + 16) });
  }
  const rvaToOffset = (rva) => {
    for (const s of sections) {
      if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.raws)) return s.raw + rva - s.va;
    }
    return rva < buffer.length ? rva : -1;
  };

  const cliOff = rvaToOffset(clrDirRva);
  if (cliOff < 0 || cliOff + 72 > buffer.length) throw new Error("CLI header out of range.");
  const metaRva = buffer.readUInt32LE(cliOff + 8);
  const metaSize = buffer.readUInt32LE(cliOff + 12);
  const metaOff = rvaToOffset(metaRva);
  if (metaOff < 0 || metaOff + metaSize > buffer.length) throw new Error("Metadata root out of range.");
  const meta = buffer.subarray(metaOff, metaOff + metaSize);
  if (meta.readUInt32LE(0) !== BSJB) throw new Error("Metadata signature not BSJB.");

  const versionLength = meta.readUInt32LE(12);
  const version = meta.toString("utf8", 16, 16 + versionLength).replace(/\0+$/, "");
  const streamCount = meta.readUInt16LE(16 + versionLength + 2);
  let streamOffset = 16 + versionLength + 4;
  const streams = {};
  for (let i = 0; i < streamCount; i++) {
    if (streamOffset + 8 > meta.length) break;
    const sOff = meta.readUInt32LE(streamOffset);
    const sSize = meta.readUInt32LE(streamOffset + 4);
    let nameEnd = streamOffset + 8;
    while (nameEnd < meta.length && meta[nameEnd] !== 0) nameEnd++;
    const name = meta.toString("ascii", streamOffset + 8, nameEnd);
    streams[name] = { offset: sOff, size: sSize };
    streamOffset = (nameEnd + 1 + 3) & ~3;
  }
  const tablesStream = streams["#~"] || streams["#-"];
  const stringsHeap = streams["#Strings"];
  const blobHeap = streams["#Blob"];
  const guidHeap = streams["#GUID"];
  if (!tablesStream) throw new Error("No #~ tables stream.");
  if (!stringsHeap) throw new Error("No #Strings heap.");

  const stringsOf = (i) => {
    const off = stringsHeap.offset + i;
    if (off < 0 || off >= meta.length) return "";
    const end = meta.indexOf(0, off);
    if (end < 0 || end > meta.length) return "";
    return meta.toString("utf8", off, end);
  };

  const strIdxSize = stringsHeap.size > 0xffff ? 4 : 2;
  const blobIdxSize = blobHeap && blobHeap.size > 0xffff ? 4 : 2;
  const guidIdxSize = guidHeap && guidHeap.size > 0x10 ? 4 : 2;

  // #~ header: valid/sorted masks + row counts.
  const tOff = tablesStream.offset;
  const valid = (BigInt(meta.readUInt32LE(tOff + 12)) << 32n) | BigInt(meta.readUInt32LE(tOff + 8));
  const rowCounts = new Array(64).fill(0);
  let cursor = tOff + 24;
  for (let i = 0; i < 64; i++) {
    if (valid & (1n << BigInt(i))) { rowCounts[i] = meta.readUInt32LE(cursor); cursor += 4; }
  }

  const tableIdxSize = (t) => ((rowCounts[t] || 0) >= 0x10000 ? 4 : 2);
  // Coded index width: 2 bytes if max row count of target tables < 2^(16 - tagBits).
  const codedWidth = (tables, tagBits) => {
    let maxRows = 0;
    for (const t of tables) maxRows = Math.max(maxRows, rowCounts[t] || 0);
    return maxRows >= (1 << (16 - tagBits)) ? 4 : 2;
  };
  const CODED = {
    TypeDefOrRef: { tables: [0x02, 0x01, 0x1b], bits: 2 },
    HasConstant: { tables: [0x04, 0x08, 0x17], bits: 2 },
    HasCustomAttribute: { tables: [0x06, 0x04, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x00, 0x0e, 0x17, 0x14, 0x11, 0x1a, 0x1b, 0x20, 0x23, 0x26, 0x27, 0x28, 0x2a, 0x2c, 0x2b], bits: 5 },
    HasFieldMarshal: { tables: [0x04, 0x08], bits: 1 },
    HasDeclSecurity: { tables: [0x02, 0x06, 0x20], bits: 2 },
    MemberRefParent: { tables: [0x02, 0x01, 0x1a, 0x06, 0x1b], bits: 3 },
    HasSemantics: { tables: [0x14, 0x17], bits: 1 },
    MethodDefOrRef: { tables: [0x06, 0x0a], bits: 1 },
    MemberForwarded: { tables: [0x04, 0x06], bits: 1 },
    Implementation: { tables: [0x26, 0x23, 0x27], bits: 2 },
    CustomAttributeType: { tables: [0x06, 0x0a], bits: 3 },
    ResolutionScope: { tables: [0x00, 0x1a, 0x23, 0x01], bits: 2 },
    TypeOrMethodDef: { tables: [0x02, 0x06], bits: 1 },
  };
  const coded = (name) => codedWidth(CODED[name].tables, CODED[name].bits);

  // Full ECMA-335 column layouts for all 64 tables, in table-id order.
  // Column specifiers: number = fixed bytes, "S"/"B"/"G" = heap index,
  // {T: n} = simple table index, {C: name} = coded index.
  const S = "S", B = "B", G = "G";
  const T = (n) => ({ T: n });
  const C = (name) => ({ C: name });
  const L = {
    0x00: [2, S, G, G, G], // Module
    0x01: [C("ResolutionScope"), S, S], // TypeRef
    0x02: [4, S, S, C("TypeDefOrRef"), T(0x04), T(0x06)], // TypeDef
    0x04: [2, S, B], // Field
    0x06: [4, 2, 2, S, B, T(0x08)], // MethodDef
    0x08: [2, 2, S], // Param
    0x09: [T(0x02), C("TypeDefOrRef")], // InterfaceImpl
    0x0a: [C("MemberRefParent"), S, B], // MemberRef
    0x0b: [1, 1, C("HasConstant"), B], // Constant
    0x0c: [C("HasCustomAttribute"), C("CustomAttributeType"), B], // CustomAttribute
    0x0d: [C("HasFieldMarshal"), B], // FieldMarshal
    0x0e: [2, C("HasDeclSecurity"), B], // DeclSecurity
    0x0f: [2, 4, T(0x02)], // ClassLayout
    0x10: [4, T(0x04)], // FieldLayout
    0x11: [B], // StandAloneSig
    0x12: [T(0x02), T(0x14)], // EventMap
    0x14: [2, S, C("TypeDefOrRef")], // Event
    0x15: [T(0x02), T(0x17)], // PropertyMap
    0x17: [2, S, B], // Property
    0x18: [2, T(0x06), C("HasSemantics")], // MethodSemantics
    0x19: [T(0x02), C("MethodDefOrRef"), C("MethodDefOrRef")], // MethodImpl
    0x1a: [S], // ModuleRef
    0x1b: [B], // TypeSpec
    0x1c: [2, C("MemberForwarded"), S, T(0x1a)], // ImplMap
    0x1d: [4, T(0x04)], // FieldRVA
    0x1e: [4, 4], // EncLog
    0x1f: [4], // EncMap
    0x20: [4, 2, 2, 2, 2, 4, B, S, S], // Assembly
    0x21: [4], // AssemblyProcessor
    0x22: [4, 4, 4], // AssemblyOS
    0x23: [2, 2, 2, 2, 4, B, S, S, B], // AssemblyRef
    0x24: [4, T(0x23)], // AssemblyRefProcessor
    0x25: [4, 4, 4, T(0x23)], // AssemblyRefOS
    0x26: [4, S, B], // File
    0x27: [4, 4, S, S, C("Implementation")], // ExportedType
    0x28: [4, 4, S, C("Implementation")], // ManifestResource
    0x29: [T(0x02), T(0x02)], // NestedClass
    0x2a: [2, 2, C("TypeOrMethodDef"), S], // GenericParam
    0x2b: [C("MethodDefOrRef"), B], // MethodSpec
    0x2c: [T(0x2a), C("TypeDefOrRef")], // GenericParamConstraint
  };
  const colWidth = (spec) => {
    if (typeof spec === "number") return spec;
    if (spec === S) return strIdxSize;
    if (spec === B) return blobIdxSize;
    if (spec === G) return guidIdxSize;
    if (spec.T !== undefined) return tableIdxSize(spec.T);
    if (spec.C !== undefined) return coded(spec.C);
    throw new Error(`Bad column spec: ${JSON.stringify(spec)}`);
  };

  // Walk tables sequentially in id order; record decoded rows for the tables we care about.
  const decode = { 0x01: true, 0x02: true, 0x04: true, 0x06: true, 0x1a: true, 0x23: true };
  const tables = {};
  for (let id = 0; id < 64; id++) {
    const count = rowCounts[id];
    if (!count) continue;
    const layout = L[id];
    if (!layout) throw new Error(`Missing ECMA-335 layout for table 0x${id.toString(16)} (rows=${count}).`);
    const rowSize = layout.reduce((a, col) => a + colWidth(col), 0);
    const rows = [];
    for (let r = 0; r < count && cursor + rowSize <= meta.length; r++) {
      rows.push(meta.subarray(cursor, cursor + rowSize));
      cursor += rowSize;
    }
    if (decode[id]) tables[id] = { name: TABLE_NAMES[id] || `table_${id}`, count, rowSize, rows, layout };
  }

  const colOffset = (id, col) => {
    let off = 0;
    for (let i = 0; i < col; i++) off += colWidth(tables[id].layout[i]);
    return off;
  };
  const readIdx = (id, row, col) => {
    const off = colOffset(id, col);
    const w = colWidth(tables[id].layout[col]);
    return w === 4 ? row.readUInt32LE(off) : row.readUInt16LE(off);
  };
  const strCol = (id, row, col) => stringsOf(readIdx(id, row, col));

  const types = (tables[0x02]?.rows || []).map((row) => {
    const name = strCol(0x02, row, 1);
    const ns = strCol(0x02, row, 2);
    const flags = row.readUInt32LE(0);
    if (!name) return null;
    return { name: ns ? `${ns}.${name}` : name, flags: `0x${flags.toString(16)}`, interface: Boolean(flags & 0x20), abstract: Boolean(flags & 0x80) };
  }).filter(Boolean);

  const methods = (tables[0x06]?.rows || []).map((row) => {
    const name = strCol(0x06, row, 3);
    if (!name) return null;
    return { name, rva: row.readUInt32LE(0), flags: `0x${row.readUInt16LE(6).toString(16)}` };
  }).filter(Boolean);

  const fields = (tables[0x04]?.rows || []).map((row) => strCol(0x04, row, 1)).filter(Boolean);

  const typeRefs = (tables[0x01]?.rows || []).map((row) => {
    const name = strCol(0x01, row, 1);
    const ns = strCol(0x01, row, 2);
    return name ? (ns ? `${ns}.${name}` : name) : null;
  }).filter(Boolean);

  const assemblyRefs = (tables[0x23]?.rows || []).map((row) => {
    const name = strCol(0x23, row, 6);
    if (!name) return null;
    const ver = [0, 2, 4, 6].map((o) => row.readUInt16LE(o)).join(".");
    return { name, version: ver };
  }).filter(Boolean);

  const moduleRefs = (tables[0x1a]?.rows || []).map((row) => strCol(0x1a, row, 0)).filter(Boolean);

  return { version, types: types.slice(0, 4000), methods: methods.slice(0, 8000), fields: fields.slice(0, 4000), type_refs: typeRefs.slice(0, 3000), assembly_refs: assemblyRefs.slice(0, 500), module_refs: moduleRefs.slice(0, 500) };
}

async function reDotnet(args, ctx) {
  const target = resolve(ctx.cwd, args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("re_dotnet path must be a file.");
  const buffer = await readFile(target);
  let meta;
  try { meta = parseDotNetMetadata(buffer); }
  catch (error) { return `Not a parseable .NET assembly: ${error.message}\nTip: run pe_triage first to confirm CLR, or re_strings for a raw look.`; }

  const lines = [`.NET metadata — ${args.path} (runtime ${meta.version})`];
  lines.push(`Types (${meta.types.length}):`);
  for (const t of capList(meta.types, 200)) lines.push(`  ${t.interface ? "[interface] " : ""}${t.abstract ? "[abstract] " : ""}${t.name}`);
  lines.push(`\nMethods (${meta.methods.length}):`);
  for (const m of capList(meta.methods, 150)) lines.push(`  ${m.name} (rva 0x${m.rva.toString(16)})`);
  const interesting = ["auth", "login", "password", "token", "admin", "deserialize", "invoke", "process", "execute", "runas", "registry", "crypto", "hash", "key", "secret", "credential"];
  const interestingMethods = meta.methods.filter((m) => interesting.some((k) => m.name.toLowerCase().includes(k)));
  if (interestingMethods.length) {
    lines.push(`\nPotentially interesting methods (${interestingMethods.length}):`);
    for (const m of capList(interestingMethods, 50)) lines.push(`  ${m.name} (rva 0x${m.rva.toString(16)})`);
  }
  lines.push(`\nFields (${meta.fields.length}): ${capList(meta.fields, 100).join(", ")}`);
  lines.push(`\nType references (${meta.type_refs.length}): ${capList(meta.type_refs, 60).join(", ")}`);
  lines.push(`\nAssembly references (${meta.assembly_refs.length}):`);
  for (const a of capList(meta.assembly_refs, 40)) lines.push(`  ${a.name} ${a.version}`);
  if (meta.module_refs.length) lines.push(`\nModule references: ${meta.module_refs.join(", ")}`);

  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "dotnet-metadata", name: `${args.path.split(/[\\/]/).pop()}.dotnet.json`, data: JSON.stringify(meta, null, 2), metadata: { source: args.path, runtime: meta.version } });
  lines.push(`\nArtifact: ${artifact.path}`);
  lines.push("\nNext: re_ghidra for native code, or re_diff to compare two versions.");
  return lines.join("\n");
}


// ── re_ghidra: headless Ghidra runner (needs ghidra in the linux-re image) ──
const GHIDRA_PROBE = "command -v analyzeHeadless 2>/dev/null || ls /opt/ghidra*/support/analyzeHeadless 2>/dev/null | head -1";

async function reGhidra(args, ctx) {
  const target = resolve(ctx.cwd, args.path);
  const info = await stat(target);
  if (!info.isFile()) throw new Error("re_ghidra path must be a file.");
  const fileName = args.path.split(/[\\/]/).pop();
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 600000, 30000), 1800000);

  const probe = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: "linux-re", command: GHIDRA_PROBE, timeoutMs: 30000, networkPolicy: "none" });
  const headless = String(probe.stdout || "").trim().split(/\n/)[0];
  if (!headless) {
    return [
      "Ghidra headless is not installed in the linux-re sandbox image.",
      "Install it by extending docker/Dockerfile.linux-re (see docker/README.md), or run:",
      "  docker build --file docker/Dockerfile.linux-re-ghidra --tag dsw/linux-re-ghidra:latest .",
      "Then point SANDBOX_ENVIRONMENTS['linux-re'].image at the new image in src/sandbox.js.",
    ].join("\n");
  }

  const projectName = `proj_${Date.now()}`;
  const scriptDir = "/opt/ghidra-scripts";
  const outFile = "/workspace/ghidra-decomp.txt";
  const script = [
    "import ghidra.app.decompiler.DecompInterface;",
    "import ghidra.util.task.ConsoleTaskMonitor;",
    "import java.io.*;",
    "public class DecompileAll {",
    "  public static void main(String[] args) throws Exception {",
    "    if (args.length < 1) { System.err.println(\"no outfile\"); return; }",
    "    PrintWriter pw = new PrintWriter(new FileWriter(args[0]));",
    "    DecompInterface di = new DecompInterface();",
    "    di.openProgram(currentProgram);",
    "    var fm = currentProgram.getFunctionManager();",
    "    var funcs = fm.getFunctions(true);",
    "    while (funcs.hasNext()) {",
    "      var f = funcs.next();",
    "      pw.println(\"// ===== \" + f.getName() + \" @ \" + f.getEntryPoint() + \" =====\");",
    "      try {",
    "        var res = di.decompileFunction(f, 30, new ConsoleTaskMonitor());",
    "        if (res != null && res.decompileCompleted()) pw.println(res.getDecompiledFunction().getC());",
    "        else pw.println(\"// (decompile failed)\");",
    "      } catch (Exception e) { pw.println(\"// (decompile error: \" + e + \")\"); }",
    "    }",
    "    pw.close();",
    "    di.dispose();",
    "  }",
    "}",
  ].join("\n");

  // Stage the script AND a copy of the target binary into the task workspace,
  // which the sandbox mounts at /workspace (the host binary is not mounted).
  const taskWs = taskRoot(ctx.cwd, ctx.taskId);
  const scriptLocal = join(taskWs, "tmp", "DecompileAll.java");
  const binLocal = join(taskWs, "tmp", `target-${fileName}`);
  await mkdir(dirname(scriptLocal), { recursive: true });
  await writeFile(scriptLocal, script, "utf8");
  await writeFile(binLocal, await readFile(target));

  const maxFunctions = Math.min(Math.max(Number(args.max_functions) || 200, 10), 5000);
  const command = [
    `mkdir -p /workspace/ghidra-project ${scriptDir}`,
    `cp /workspace/tmp/DecompileAll.java ${scriptDir}/`,
    `cd /workspace && ${headless} /workspace/ghidra-project ${projectName} -import "/workspace/tmp/target-${fileName}" -scriptPath ${scriptDir} -postScript DecompileAll.java ${outFile} -scriptlog /workspace/ghidra-script.log`,
    `head -c 400000 ${outFile} 2>/dev/null || true`,
  ].join(" && ");
  const result = await sandboxExecute({ cwd: ctx.cwd, taskId: ctx.taskId, environment: "linux-re", command, timeoutMs, networkPolicy: "none" });

  const out = truncate(result.stdout || "", 24000);
  const err = result.stderr ? truncate(result.stderr, 4000) : "";
  const lines = [`Ghidra headless — ${args.path} (max ${maxFunctions} functions)`, out, err ? `stderr: ${err}` : ""];
  if (result.timed_out) lines.push("\nâš  Ghidra timed out — try --timeout-ms higher or analyze a smaller file.");
  return lines.join("\n");
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set(["re_ghidra"]);

export async function runReTool(name, args, opts = {}, ctx = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const ok = await opts.askYesNo?.(`Run ${name}?\nPath: ${args.path}`);
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "re_strings": return reStrings(args, ctx);
    case "re_diff": return reDiff(args, ctx);
    case "re_asar": return reAsar(args, ctx);
    case "re_dotnet": return reDotnet(args, ctx);
    case "re_ghidra": return reGhidra(args, ctx);
    default: throw new Error(`Unknown RE tool: ${name}`);
  }
}

export function reToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    schema("re_strings",
      "Classified strings extraction from any workspace file: URLs, emails, domains, IPs, GUIDs, JWTs, pipes, registry keys, file paths, SQL, shell commands, API paths, base64/hex blobs with entropy, ASCII and UTF-16 extraction. Writes a JSON artifact.",
      {
        path: { type: "string", description: "Workspace-relative file path." },
        min_len: { type: "number", description: "Minimum string length. Default 4." },
        max_strings: { type: "number", description: "Max strings per category. Default 500." },
        utf16: { type: "boolean", description: "Also extract UTF-16LE strings. Default true." },
        category: { type: "string", description: "Comma-separated category filter: url,email,domain,ipv4,guid,jwt,pipe,registry,file_path,private_key,sql,command_flag,shell_command,api_path,json,base64_blob,hex_blob,plain." },
        offset: { type: "number", description: "Byte offset to start. Default 0." },
        limit: { type: "number", description: "Bytes to analyze from offset. Default: whole file." },
      },
      ["path"]),
    schema("re_diff",
      "Binary/version diffing between two workspace files: block-hash similarity, string-level added/removed, and PE-aware comparison (arch, sections, import DLLs, new exports). Writes a JSON artifact.",
      {
        before: { type: "string", description: "Original file path (workspace-relative)." },
        after: { type: "string", description: "Updated file path (workspace-relative)." },
        block_size: { type: "number", description: "Hash block size in bytes. Default 4096." },
        max_strings: { type: "number", description: "Max strings per side in the string diff. Default 100." },
      },
      ["before", "after"]),
    schema("re_asar",
      "Electron ASAR analysis: list contents (paths, sizes, symlinks) or extract all files to the task workspace with JSON prettified, JS source-map URLs discovered, and an extract-index artifact.",
      {
        path: { type: "string", description: "Workspace-relative .asar file path." },
        action: { type: "string", enum: ["list", "extract"], description: "Default list." },
        output_dir: { type: "string", description: "Extract destination (workspace-relative). Default: .deepseek-watch/tasks/<task>/extracted/asar-<name>." },
        max_files: { type: "number", description: "Max files to list/extract. Default 300 list / 2000 extract." },
        max_bytes: { type: "number", description: "Max extraction bytes. Default 500MB." },
      },
      ["path"]),
    schema("re_dotnet",
      ".NET assembly metadata reader (ILSpy-style surface without ILSpy): types, methods with RVA, fields, type references, assembly references, module references via ECMA-335 metadata parsing. Writes a JSON artifact.",
      {
        path: { type: "string", description: "Workspace-relative .NET DLL/EXE path." },
      },
      ["path"]),
    schema("re_ghidra",
      "Headless Ghidra analysis of a workspace binary inside the linux-re sandbox: full-program decompilation to C text via a post-script. Requires Ghidra installed in the linux-re image (see tool output if missing).",
      {
        path: { type: "string", description: "Workspace-relative binary path to import." },
        max_functions: { type: "number", description: "Max functions to decompile. Default 200." },
        timeout_ms: { type: "number", description: "Analysis timeout. Default 600000 (10 min)." },
      },
      ["path"]),
  ];
}
