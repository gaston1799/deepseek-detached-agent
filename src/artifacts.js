import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

const SAFE_ID = /[^A-Za-z0-9._-]+/g;
const DEFAULT_RANGE = 12000;
const MAX_RANGE = 200000;
const MAX_INDEXABLE_BYTES = 2 * 1024 * 1024;

function classifyArtifact(name, metadata = {}) {
  const lower = String(name || "").toLowerCase();
  const tags = [];
  if (/\.(pcap|pcapng)$/.test(lower)) tags.push("pcap", "network");
  if (/\.(exe|dll|sys|msi)$/.test(lower)) tags.push("windows-binary");
  if (/\.(js|mjs|cjs|ts|tsx|jsx)$/.test(lower)) tags.push("source");
  if (/\.(json|xml|csv|log|txt|md)$/.test(lower)) tags.push("text");
  if (String(metadata?.container || "")) tags.push("sandbox");
  return tags;
}

export function taskIdFor(opts = {}) {
  const explicit = String(opts.taskId || opts.agentId || "task").trim();
  return explicit.replace(SAFE_ID, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "task";
}

export function taskRoot(cwd = process.cwd(), taskId = "task") {
  return resolve(cwd, ".deepseek-watch", "tasks", taskIdFor({ taskId }));
}

export function artifactRoot(cwd = process.cwd(), taskId = "task") {
  return join(taskRoot(cwd, taskId), "artifacts");
}

function artifactIndexPath(cwd, taskId) { return join(artifactRoot(cwd, taskId), "index.json"); }

function safeName(value) {
  return String(value || "artifact").replace(SAFE_ID, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "artifact";
}

function asBuffer(data) {
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof Uint8Array) return Buffer.from(data);
  return Buffer.from(String(data ?? ""), "utf8");
}

async function updateArtifactIndex(cwd, taskId, record) {
  const file = artifactIndexPath(cwd, taskId);
  let index = { schema_version: 1, updated_at: null, artifacts: {} };
  try { index = JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; }
  index.artifacts[record.id] = { id: record.id, kind: record.kind, name: record.name, path: record.path, bytes: record.bytes, created_at: record.created_at, tags: classifyArtifact(record.name, record.metadata), searchable: record.bytes <= MAX_INDEXABLE_BYTES };
  index.updated_at = new Date().toISOString();
  await writeFile(file, `${JSON.stringify(index, null, 2)}\n`, "utf8");
}

export async function writeArtifact({ cwd = process.cwd(), taskId, kind = "output", name, data, metadata = {} }) {
  const root = artifactRoot(cwd, taskId);
  await mkdir(root, { recursive: true });
  const buffer = asBuffer(data);
  const digest = createHash("sha256").update(buffer).digest("hex");
  const id = `${Date.now()}-${randomUUID()}`;
  const fileName = `${safeName(name || kind)}-${id}${extname(String(name || "")) || ".bin"}`;
  const file = join(root, fileName);
  await writeFile(file, buffer, { flag: "wx" });
  const record = {
    schema_version: 1,
    id,
    kind: String(kind),
    name: basename(file),
    path: relative(resolve(cwd), file).replaceAll("\\", "/"),
    bytes: buffer.length,
    sha256: digest,
    created_at: new Date().toISOString(),
    metadata
  };
  await writeFile(`${file}.json`, `${JSON.stringify(record, null, 2)}\n`, "utf8", { flag: "wx" });
  await updateArtifactIndex(cwd, taskId, record);
  return record;
}

export async function registerArtifactFile({ cwd = process.cwd(), taskId, kind = "output", name, file, metadata = {} }) {
  const root = artifactRoot(cwd, taskId);
  await mkdir(root, { recursive: true });
  const source = resolve(file);
  const info = await stat(source);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(source)) digest.update(chunk);
  const id = `${Date.now()}-${randomUUID()}`;
  const record = {
    schema_version: 1,
    id,
    kind: String(kind),
    name: basename(source),
    path: relative(resolve(cwd), source).replaceAll("\\", "/"),
    bytes: info.size,
    sha256: digest.digest("hex"),
    created_at: new Date().toISOString(),
    metadata
  };
  await writeFile(`${join(root, safeName(name || kind))}-${id}.json`, `${JSON.stringify(record, null, 2)}\n`, "utf8", { flag: "wx" });
  await updateArtifactIndex(cwd, taskId, record);
  return record;
}

export async function listArtifacts({ cwd = process.cwd(), taskId }) {
  const root = artifactRoot(cwd, taskId);
  let entries;
  try { entries = await readdir(root); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  const records = [];
  for (const name of entries.filter((item) => item.endsWith(".json") && item !== "index.json")) {
    try { records.push(JSON.parse(await readFile(join(root, name), "utf8"))); } catch {}
  }
  return records.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
}

export async function getArtifact({ cwd = process.cwd(), taskId, artifact }) {
  const root = artifactRoot(cwd, taskId);
  const records = await listArtifacts({ cwd, taskId });
  const record = records.find((item) => item.id === artifact || item.name === artifact || item.path === artifact);
  if (!record) throw new Error(`Artifact not found: ${artifact}`);
  const file = resolve(cwd, record.path);
  const info = await stat(file);
  return { record, file, info };
}

export async function readArtifactRange({ cwd = process.cwd(), taskId, artifact, offset = 0, maxBytes = DEFAULT_RANGE }) {
  const found = await getArtifact({ cwd, taskId, artifact });
  const start = Math.max(0, Number(offset) || 0);
  const length = Math.min(Math.max(Number(maxBytes) || DEFAULT_RANGE, 1), MAX_RANGE);
  const data = await readFile(found.file);
  const chunk = data.subarray(start, start + length);
  return {
    artifact: found.record,
    offset: start,
    bytes: chunk.length,
    next_offset: start + chunk.length < data.length ? start + chunk.length : null,
    content: chunk.toString("utf8")
  };
}

export async function searchArtifact({ cwd = process.cwd(), taskId, artifact, pattern, maxMatches = 50, contextChars = 160 }) {
  const found = await getArtifact({ cwd, taskId, artifact });
  const text = (await readFile(found.file)).toString("utf8");
  const needle = String(pattern || "");
  if (!needle) throw new Error("pattern is required");
  const limit = Math.min(Math.max(Number(maxMatches) || 50, 1), 500);
  const radius = Math.min(Math.max(Number(contextChars) || 160, 20), 2000);
  const matches = [];
  let from = 0;
  while (matches.length < limit) {
    const index = text.indexOf(needle, from);
    if (index < 0) break;
    matches.push({ offset: index, match: needle, snippet: text.slice(Math.max(0, index - radius), Math.min(text.length, index + needle.length + radius)) });
    from = index + Math.max(needle.length, 1);
  }
  return { artifact: found.record, matches, truncated: from < text.length && matches.length >= limit };
}

export async function getArtifactIndex({ cwd = process.cwd(), taskId }) {
  try { return JSON.parse(await readFile(artifactIndexPath(cwd, taskId), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return { schema_version: 1, updated_at: null, artifacts: {} }; throw error; }
}

export async function searchArtifacts({ cwd = process.cwd(), taskId, pattern, maxMatches = 50, contextChars = 160 }) {
  const records = await listArtifacts({ cwd, taskId });
  const query = String(pattern || "");
  if (!query) throw new Error("pattern is required");
  const limit = Math.min(Math.max(Number(maxMatches) || 50, 1), 500);
  const results = [];
  for (const record of records) {
    if (results.length >= limit) break;
    if (record.bytes > MAX_INDEXABLE_BYTES) continue;
    const found = await searchArtifact({ cwd, taskId, artifact: record.id, pattern: query, maxMatches: limit - results.length, contextChars });
    for (const match of found.matches) results.push({ artifact: { id: record.id, kind: record.kind, name: record.name }, ...match });
  }
  return { pattern: query, matches: results, truncated: results.length >= limit, index: await getArtifactIndex({ cwd, taskId }) };
}
