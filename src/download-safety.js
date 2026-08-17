import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { promises as dns } from "node:dns";

const KNOWN_RISKS = [
  { re: /s3\.us-east-2\.amazonaws\.com\/saoletto\/.*\.html/i, reason: "Known JavaScript-stub download path" },
  { re: /(?:trk\.)?sparkrainstorm\.host/i, reason: "Known affiliate-tracker domain" },
  { re: /(?:mydownloadsitecenter|dropfluxy|ythestarsarequ|bstlar|loot-link|lootdest)\.com/i, reason: "Known deceptive-download or monetized-wall host" },
  { re: /setup[_ -]?(?:is[_ -]?)?ready.*\.exe/i, reason: "Generic downloader filename pattern" },
];

export const DOWNLOADS_DIR = join(homedir(), "Downloads");
export const QUARANTINE_DIR = join(homedir(), ".deepseek-watch", "quarantine");
export const SAFETY_STATE_PATH = join(homedir(), ".deepseek-watch", "safety-state.json");

function validUrl(raw) {
  try {
    const url = new URL(String(raw));
    return ["http:", "https:"].includes(url.protocol) ? url : null;
  } catch { return null; }
}

export function classifyUrl(raw) {
  const url = validUrl(raw);
  if (!url) return { verdict: "invalid", reasons: ["Not an HTTP(S) URL."], url: String(raw) };
  const full = url.href;
  const reasons = KNOWN_RISKS.filter((entry) => entry.re.test(full)).map((entry) => entry.reason);
  if (/\.(?:exe|msi|scr|bat|cmd|ps1)(?:[?#]|$)/i.test(url.pathname)) reasons.push("Executable or script download requires quarantine verification");
  if (/bit\.ly|tinyurl\.com|t\.co|is\.gd|cutt\.ly|shorturl/i.test(url.hostname)) reasons.push("URL shortener hides the destination");
  const verdict = reasons.some((reason) => /stub|affiliate|deceptive|generic/i.test(reason)) ? "scam" : reasons.length ? "caution" : "unknown";
  return { verdict, url: full, host: url.hostname, reasons: [...new Set(reasons)], suggestedAction: verdict === "scam" ? "Do not open or download. Use the official publisher source." : "If downloaded, verify in quarantine before opening." };
}

function safeDownloadName(value) {
  const raw = basename(value || "download.bin").replace(/[^a-z0-9._-]/gi, "_");
  return raw || "download.bin";
}

async function fetchDownload(url, maxRedirects = 5) {
  let current = new URL(url);
  const redirects = [];
  for (let attempt = 0; attempt <= maxRedirects; attempt += 1) {
    const response = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(60000) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const target = response.headers.get("location");
      if (!target) throw new Error(`Redirect ${response.status} did not include Location.`);
      current = new URL(target, current);
      if (!['http:', 'https:'].includes(current.protocol)) throw new Error("Redirected to a non-HTTP(S) URL.");
      redirects.push(current.href);
      continue;
    }
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return { bytes, response, finalUrl: current.href, redirects };
  }
  throw new Error(`Too many redirects (>${maxRedirects}).`);
}

function entropy(bytes) {
  if (!bytes.length) return 0;
  const counts = new Array(256).fill(0);
  for (const byte of bytes) counts[byte] += 1;
  let value = 0;
  for (const count of counts) if (count) { const p = count / bytes.length; value -= p * Math.log2(p); }
  return Number(value.toFixed(3));
}

function printableStrings(bytes, max = 80) {
  return bytes.toString("latin1").match(/[\x20-\x7e]{6,}/g)?.slice(0, max) || [];
}

export async function fileAnalyze(file) {
  const bytes = await readFile(file);
  const info = await stat(file);
  const isPe = bytes.subarray(0, 2).toString("ascii") === "MZ";
  const strings = printableStrings(bytes);
  const suspiciousStrings = strings.filter((item) => /(powershell|cmd\.exe|rundll32|reg add|schtasks|https?:\/\/|appdata|startup)/i.test(item)).slice(0, 30);
  return { path: file, size_bytes: info.size, sha256: createHash("sha256").update(bytes).digest("hex"), extension: extname(file).toLowerCase(), is_pe: isPe, entropy: entropy(bytes), suspicious_strings: suspiciousStrings, string_sample: strings.slice(0, 30), packer_heuristic: isPe && entropy(bytes) > 7.2 ? "high-entropy PE; may be packed or compressed" : "none" };
}

export async function verifyDownload(input, options = {}) {
  const url = validUrl(input);
  const quarantine = resolve(options.quarantineDir || QUARANTINE_DIR);
  await mkdir(quarantine, { recursive: true });
  let file;
  let source = input;
  let redirects = [];
  if (url) {
    const preflight = classifyUrl(url.href);
    if (preflight.verdict === "scam") return { verdict: "suspicious", preflight, downloaded: false, reason: "Known scam signature; download was not attempted." };
    const download = await fetchDownload(url.href);
    redirects = download.redirects;
    const disposition = download.response.headers.get("content-disposition") || "";
    const named = disposition.match(/filename\*?=(?:UTF-8''|"?)([^";]+)/i)?.[1] || new URL(download.finalUrl).pathname;
    file = join(quarantine, `${Date.now()}-${safeDownloadName(named)}`);
    await writeFile(file, download.bytes);
    source = download.finalUrl;
  } else {
    const candidate = resolve(String(input));
    const allowedRoots = [resolve(process.cwd()), resolve(DOWNLOADS_DIR), quarantine];
    if (!isAbsolute(String(input)) || !allowedRoots.some((root) => candidate === root || candidate.startsWith(`${root}\\`))) throw new Error("Local files must be under the workspace, Downloads, or quarantine directory.");
    const data = await readFile(candidate);
    file = join(quarantine, `${Date.now()}-${safeDownloadName(candidate)}`);
    await writeFile(file, data);
  }
  const analysis = await fileAnalyze(file);
  const verdict = analysis.is_pe && analysis.entropy > 7.2 ? "suspicious" : analysis.extension.match(/\.(exe|msi|scr|bat|cmd|ps1)$/) ? "unsigned" : "clean";
  return { verdict, source, redirects, quarantine_path: file, authenticode: "not checked (Windows signature check must be requested through a reviewed shell command)", defender: "not scanned automatically", ...analysis };
}

export async function readSafetyState() {
  try { return JSON.parse(await readFile(SAFETY_STATE_PATH, "utf8")); } catch { return { version: 1, updatedAt: "", entries: {}, knownScamUrls: [] }; }
}

export async function trackSafetyState(key, value) {
  const state = await readSafetyState();
  if (value !== undefined) state.entries[String(key)] = value;
  state.updatedAt = new Date().toISOString();
  await mkdir(resolve(SAFETY_STATE_PATH, ".."), { recursive: true });
  await writeFile(SAFETY_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  return value === undefined ? state.entries[String(key)] ?? null : state.entries[String(key)];
}

export async function watchDownloads(since) {
  const files = await (async () => { try { return await (await import("node:fs/promises")).readdir(DOWNLOADS_DIR, { withFileTypes: true }); } catch { return []; } })();
  const cutoff = since ? new Date(since).getTime() : 0;
  const entries = [];
  for (const item of files) {
    if (!item.isFile()) continue;
    const full = join(DOWNLOADS_DIR, item.name);
    const info = await stat(full);
    if (info.mtimeMs < cutoff) continue;
    entries.push({ path: full, size_bytes: info.size, modified_at: info.mtime.toISOString(), state: item.name.endsWith(".crdownload") ? "in_progress" : "complete_candidate" });
  }
  return entries.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
}

export async function dnsLookup(domain) {
  const host = validUrl(domain)?.hostname || String(domain).replace(/^https?:\/\//, "").split("/")[0];
  const [a, aaaa, mx] = await Promise.allSettled([dns.resolve4(host), dns.resolve6(host), dns.resolveMx(host)]);
  return { domain: host, A: a.status === "fulfilled" ? a.value : [], AAAA: aaaa.status === "fulfilled" ? aaaa.value : [], MX: mx.status === "fulfilled" ? mx.value : [] };
}

export async function whoisLookup(domain) {
  const host = validUrl(domain)?.hostname || String(domain).replace(/^https?:\/\//, "").split("/")[0];
  const response = await fetch(`https://rdap.org/domain/${encodeURIComponent(host)}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`RDAP lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  return { domain: host, handle: data.handle || "", status: data.status || [], events: data.events || [], nameservers: data.nameservers?.map((entry) => entry.ldhName || entry.unicodeName).filter(Boolean) || [] };
}

export async function certLogs(domain) {
  const host = validUrl(domain)?.hostname || String(domain).replace(/^https?:\/\//, "").split("/")[0];
  const response = await fetch(`https://crt.sh/?q=${encodeURIComponent(host)}&output=json`, { signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`crt.sh lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  return data.slice(0, 100).map((entry) => ({ issuer: entry.issuer_name, name_value: entry.name_value, not_before: entry.not_before, not_after: entry.not_after, serial_number: entry.serial_number }));
}

export async function virusTotalLookup(value) {
  const key = process.env.VT_API_KEY || process.env.VIRUSTOTAL_API_KEY;
  if (!key) return { configured: false, message: "Set VT_API_KEY or VIRUSTOTAL_API_KEY to enable VirusTotal lookups." };
  const id = encodeURIComponent(String(value));
  const kind = /^[a-f0-9]{64}$/i.test(String(value)) ? "files" : "urls";
  const response = await fetch(`https://www.virustotal.com/api/v3/${kind}/${id}`, { headers: { "x-apikey": key }, signal: AbortSignal.timeout(30000) });
  if (!response.ok) throw new Error(`VirusTotal lookup failed: HTTP ${response.status}`);
  const data = await response.json();
  return { configured: true, data: data.data?.attributes?.last_analysis_stats || data.data?.attributes || {} };
}
