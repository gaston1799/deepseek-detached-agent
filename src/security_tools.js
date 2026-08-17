// src/security_tools.js — web-app security tooling for the dsw harness.
//
// Scope: authorized testing of YOUR OWN web properties. Every tool that makes
// an active request to a target host is gated by a security allowlist
// (~/.deepseek-watch/security-allowlist.json, managed via `dsw security allow
// <domain>`). Targets outside the allowlist are refused. Tools are request
// primitives and passive analyzers — no auto-exploitation, no weaponization.
import { createHash } from "node:crypto";
import { promises as dns } from "node:dns";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFile } from "node:fs/promises";

// ── Allowlist ────────────────────────────────────────────────────────────────
export function allowlistPath() {
  return join(homedir(), ".deepseek-watch", "security-allowlist.json");
}

export async function loadAllowlist() {
  try {
    const raw = await readFile(allowlistPath(), "utf8");
    const parsed = JSON.parse(raw);
    const domains = Array.isArray(parsed?.domains) ? parsed.domains : [];
    return { domains: domains.map((d) => String(d).toLowerCase().trim()).filter(Boolean), notes: parsed?.notes || "" };
  } catch {
    return { domains: [], notes: "" };
  }
}

export function hostAllowed(host, allowlist) {
  const h = String(host || "").toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/:\d+$/, "");
  if (!h) return false;
  return (allowlist.domains || []).some((d) => h === d || h.endsWith("." + d));
}

export function urlHost(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export async function assertAllowedUrl(url) {
  const host = urlHost(url);
  const allowlist = await loadAllowlist();
  if (hostAllowed(host, allowlist)) return host;
  const hint = allowlist.domains.length
    ? `Allowlisted: ${allowlist.domains.join(", ")}`
    : "The allowlist is empty.";
  throw new Error(
    `Target not allowlisted (${host}). ${hint} Add your own domains with: dsw security allow <domain>`
  );
}

// ── Fetch helpers ────────────────────────────────────────────────────────────
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || 15000, 1000), 60000);
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

function truncate(text, max = 4000) {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, max)}\n…[truncated ${s.length - max} chars]` : s;
}

function capList(items, max) {
  const list = [...items];
  const capped = list.slice(0, max);
  if (list.length > max) capped.push(`…[+${list.length - max} more]`);
  return capped;
}

// ── sec_encode: encoding / crypto workbench ─────────────────────────────────
const HEX_RE = /^[0-9a-f]+$/i;

export function runCipher(action, value, key = "") {
  const v = String(value ?? "");
  switch (String(action || "").toLowerCase().replace(/-/g, "_")) {
    case "b64_encode": case "base64_encode":
      return Buffer.from(v, "utf8").toString("base64");
    case "b64_decode": case "base64_decode": {
      try { return Buffer.from(v, "base64").toString("utf8"); }
      catch { return Buffer.from(v, "base64").toString("latin1"); }
    }
    case "b64url_encode":
      return Buffer.from(v, "utf8").toString("base64url");
    case "b64url_decode": {
      try { return Buffer.from(v, "base64url").toString("utf8"); }
      catch { return Buffer.from(v, "base64url").toString("latin1"); }
    }
    case "hex_encode":
      return Buffer.from(v, "utf8").toString("hex");
    case "hex_decode":
      return Buffer.from(HEX_RE.test(v) ? v : v.replace(/\\x/g, ""), "hex").toString("utf8");
    case "url_encode":
      return encodeURIComponent(v);
    case "url_decode":
      try { return decodeURIComponent(v); } catch { return decodeURIComponent(v.replace(/\+/g, " ")); }
    case "rot13":
      return v.replace(/[a-zA-Z]/g, (c) => {
        const base = c <= "Z" ? 65 : 97;
        return String.fromCharCode(((c.charCodeAt(0) - base + 13) % 26) + base);
      });
    case "sha1": case "sha256": case "md5": {
      const algo = String(action).toLowerCase();
      return createHash(algo === "sha1" ? "sha1" : algo === "md5" ? "md5" : "sha256").update(v, "utf8").digest("hex");
    }
    case "jwt_decode": {
      const parts = v.split(".");
      if (parts.length !== 3) throw new Error("Not a JWT (expected 3 dot-separated segments).");
      const dec = (seg) => {
        const pad = seg.replace(/-/g, "+").replace(/_/g, "/");
        return Buffer.from(pad + "=".repeat((4 - (pad.length % 4)) % 4), "base64").toString("utf8");
      };
      return `header: ${truncate(dec(parts[0]), 2000)}\npayload: ${truncate(dec(parts[1]), 4000)}\nsignature: ${parts[2]}`;
    }
    case "xor": {
      if (!key) throw new Error("xor requires a --key / key argument.");
      const k = Buffer.from(String(key), "utf8");
      const out = Buffer.from(v, "utf8");
      for (let i = 0; i < out.length; i++) out[i] ^= k[i % k.length];
      return out.toString("latin1");
    }
    default:
      throw new Error(`Unknown action "${action}". Actions: b64_encode, b64_decode, b64url_encode, b64url_decode, hex_encode, hex_decode, url_encode, url_decode, rot13, sha1, sha256, md5, jwt_decode, xor (key required)`);
  }
}

async function secEncode(args) {
  return runCipher(args.action, args.value, args.key);
}

// ── sec_extract_iocs: pull indicators out of text/files ─────────────────────
const IOC_RE = {
  urls: /\bhttps?:\/\/[^\s"'<>()[\]]+/gi,
  ipv4: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)\b/g,
  emails: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  sha256: /\b[a-f0-9]{64}\b/gi,
  sha1: /\b[a-f0-9]{40}\b/gi,
  md5: /\b[a-f0-9]{32}\b/gi,
  domains: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}\b/gi,
};

export function extractIocsFromText(text) {
  const src = String(text || "");
  const results = {};
  for (const [kind, re] of Object.entries(IOC_RE)) {
    const matches = new Set();
    let m;
    const rx = new RegExp(re.source, re.flags); // keep 'g' so exec() advances
    while ((m = rx.exec(src)) !== null) {
      const value = m[0];
      if (kind === "domains" && value.startsWith("www.")) continue;
      matches.add(value.toLowerCase());
      if (matches.size > 5000) break; // safety cap on pathological inputs
      if (rx.lastIndex === m.index) rx.lastIndex += 1;
    }
    results[kind] = [...matches].sort();
  }
  return results;
}

async function secExtractIocs(args) {
  const text = args.file
    ? await readFile(args.file, "utf8")
    : String(args.text ?? "");
  if (!text.trim()) throw new Error("Provide text or a file path.");
  const max = Math.min(Number(args.max) || 50, 500);
  const iocs = extractIocsFromText(text);
  const lines = [];
  for (const [kind, list] of Object.entries(iocs)) {
    if (!list.length) continue;
    lines.push(`${kind} (${list.length}):`);
    for (const item of capList(list, max)) lines.push(`  ${item}`);
  }
  return lines.length ? lines.join("\n") : "No indicators found.";
}

// ── sec_crt_subdomains: passive cert-transparency enumeration ───────────────
async function resolveHost(host) {
  const results = [];
  for (const fn of [dns.resolve4, dns.resolve6]) {
    try {
      const addrs = await Promise.race([
        fn(host),
        new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 5000)),
      ]);
      results.push(...(addrs || []));
    } catch {
      // try next family
    }
  }
  return results;
}

async function secCrtSubdomains(args) {
  const domain = String(args.domain || "").toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) throw new Error("Provide a valid domain.");
  const response = await fetchWithTimeout(`https://crt.sh/?q=%25.${encodeURIComponent(domain)}&output=json`, {}, args.timeout_ms || 25000);
  if (!response.ok) throw new Error(`crt.sh responded HTTP ${response.status}.`);
  let entries;
  try {
    entries = await response.json();
  } catch {
    throw new Error("crt.sh did not return JSON (may be rate-limited). Retry later.");
  }
  const names = new Set();
  for (const entry of Array.isArray(entries) ? entries : []) {
    const raw = String(entry?.name_value || entry?.common_name || "");
    for (const name of raw.split(/\n+/)) {
      const clean = name.trim().toLowerCase().replace(/\*\./g, "");
      // Valid hostnames only: drop CA names ("x - example.com"), emails, spaces.
      if (!clean || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(clean)) continue;
      if (clean.endsWith(domain)) names.add(clean);
    }
  }
  const sorted = [...names].sort();
  const max = Math.min(Number(args.max) || 300, 1000);
  const shown = capList(sorted, max);
  if (!sorted.length) return `No certificates found for ${domain} (or crt.sh returned nothing).`;

  if (args.resolve === false) {
    return `crt.sh found ${sorted.length} name(s) for ${domain}:\n${shown.join("\n")}`;
  }

  const resolved = [];
  const dangling = [];
  for (const name of sorted.slice(0, 120)) {
    const addrs = await resolveHost(name);
    if (addrs.length) resolved.push(`${name} -> ${addrs.slice(0, 4).join(", ")}`);
    else dangling.push(name);
  }
  const out = [
    `crt.sh found ${sorted.length} name(s) for ${domain}. Resolved ${resolved.length} of first ${Math.min(sorted.length, 120)}:`,
    ...resolved,
  ];
  if (dangling.length) {
    out.push("", `DANGLING (cert exists but no DNS A/AAAA — takeover candidate): ${dangling.length}`);
    out.push(capList(dangling, 50).join("\n"));
  }
  return out.join("\n");
}

// ── Adware / injected-content blocklist (curated, category-tagged) ──────────
const ADWARE_HOSTS = [
  // miners
  ["coin-hive.com", "miner"], ["coinhive", "miner"], ["cryptoloot.pro", "miner"],
  ["webminepool.com", "miner"], ["minexmr.com", "miner"], ["minergate.com", "miner"],
  ["crypto-loot.com", "miner"], ["authedmine.com", "miner"], ["minecrunch.co", "miner"],
  // popunders / ad networks
  ["popads.net", "ad"], ["propellerads.com", "ad"], ["adsterra.com", "ad"],
  ["adcash.com", "ad"], ["exoclick.com", "ad"], ["hilltopads.net", "ad"],
  ["juicyads.com", "ad"], ["yllix.com", "ad"], ["popunder.ru", "ad"],
  ["adskeeper.com", "ad"], ["admaven.com", "ad"], ["mgid.com", "ad"],
  ["onclasrv.com", "ad"], ["adpushup.com", "ad"], ["adspyglass.com", "ad"],
  ["4dsply.com", "ad"], ["serving-sys.com", "ad"], ["adnxs.com", "ad"],
  ["adsrvr.org", "ad"], ["openx.net", "ad"], ["rubiconproject.com", "ad"],
  ["criteo.com", "ad"], ["taboola.com", "ad"], ["outbrain.com", "ad"],
  ["doubleclick.net", "ad"], ["googlesyndication.com", "ad"], ["googletagservices.com", "ad"],
  // trackers commonly injected
  ["statcounter.com", "tracker"], ["addthis.com", "tracker"], ["addtoany.com", "tracker"],
  ["sharethis.com", "tracker"], ["chartbeat.com", "tracker"], ["scorecardresearch.com", "tracker"],
  ["hotjar.com", "tracker"], ["clicky.com", "tracker"],
  // malware-adjacent
  ["adoric.com", "malware"], ["weborama.com", "malware"], ["trafficjunky.net", "malware"],
  ["realclix.com", "malware"], ["safelinkconverter.com", "malware"],
];

function hostFromSrc(value) {
  const match = String(value || "").match(/^https?:\/\/([^/]+)/i) || String(value || "").match(/^\/\/([^/]+)/i);
  return match ? match[1].toLowerCase() : "";
}

function tagAdwareHost(value) {
  const host = hostFromSrc(value);
  if (!host) return null;
  for (const [domain, category] of ADWARE_HOSTS) {
    if (host === domain || host.endsWith("." + domain)) return { host, category, matched: domain };
  }
  return null;
}

const OBFUSCATION_PATTERNS = [
  [/eval\s*\(\s*(?:atob|String\.fromCharCode|unescape)/i, "eval() with decoded/assembled payload", "obfuscation"],
  [/document\.write\s*\(\s*(?:atob|String\.fromCharCode|unescape|\\x)/i, "document.write() with encoded payload", "obfuscation"],
  [/fromCharCode\s*\(\s*[0-9]+(?:\s*,\s*[0-9]+){20,}/, "large String.fromCharCode() chain (classic obfuscation)", "obfuscation"],
  [/\\x[0-9a-f]{2}(?:\\x[0-9a-f]{2}){40,}/i, "long \\xNN hex-escape sequence", "obfuscation"],
  [/atob\(\s*["'][A-Za-z0-9+/=]{80,}["']\s*\)/, "atob() with very long base64", "obfuscation"],
  [/unescape\(\s*["'][^"']{100,}["']\s*\)/i, "unescape() with long encoded string", "obfuscation"],
  [/location\.(?:href|replace|assign)\s*=\s*["'](?!https?:[/][/](?:[a-z0-9.-]*\.)?(?:example\.com))/i, "inline JS location change", "redirect"],
  [/top\.location|parent\.location/i, "top/parent location manipulation (frame-break / redirect)", "redirect"],
  [/window\.open\s*\(\s*["'][^"']*["']\s*,\s*["']_?blank["']/i, "window.open to a new window", "popup"],
  [/on(?:unload|beforeunload)\s*=\s*["']?window\.open/i, "popunder via unload handler", "popup"],
  [/coinhive|cryptonight|cryptoloot|webminepool|miner\.js|crypto-loot/i, "crypto-miner indicator", "miner"],
  [/<script[^>]*>\s*\/?\*[^*]{0,20}\*\/?\s*document\.write/i, "commented script injecting document.write", "obfuscation"],
];

const HIDDEN_IFRAME_PATTERNS = [
  [/display\s*:\s*none/i, "display:none"],
  [/visibility\s*:\s*hidden/i, "visibility:hidden"],
  [/width\s*:\s*1?0?px/i, "1px-ish width"],
  [/height\s*:\s*1?0?px/i, "1px-ish height"],
  [/position\s*:\s*absolute[^>]*left\s*:\s*-/i, "positioned off-screen left"],
  [/opacity\s*:\s*0(?:\.\d+)?\b/i, "opacity 0"],
];

export function scanHtmlForAdware(html, pageUrl = "") {
  const findings = [];
  const src = String(html || "");
  const lower = src.toLowerCase();
  const pageIsHttps = String(pageUrl).toLowerCase().startsWith("https://");

  const add = (severity, type, detail, evidence) => {
    findings.push({
      severity,
      type,
      detail,
      evidence: String(evidence || "").replace(/\s+/g, " ").slice(0, 200),
    });
  };

  // 1. Script / iframe / link sources against blocklist + mixed content.
  const scripts = [...src.matchAll(/<\s*script\b[^>]*>/gi)].map((m) => m[0]);
  const iframes = [...src.matchAll(/<\s*iframe\b[^>]*>/gi)].map((m) => m[0]);
  const thirdParty = new Set();

  for (const tag of scripts) {
    const srcAttr = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    const inline = tag.includes(">") ? tag.slice(tag.indexOf(">") + 1) : "";
    if (srcAttr) {
      if (pageIsHttps && /^http:\/\//i.test(srcAttr)) add("warn", "mixed-content", `http:// script on https page`, tag);
      const tagged = tagAdwareHost(srcAttr);
      if (tagged) add(tagged.category === "malware" ? "high" : tagged.category === "miner" ? "high" : "medium", `adware-script:${tagged.category}`, `${tagged.matched} loaded from script`, tag);
      if (/coinhive|cryptonight|cryptoloot|webminepool|miner\.js|crypto-loot|authedmine/i.test(srcAttr)) {
        add("high", "adware-script:miner", `miner script path in <script src>`, tag);
      }
      const host = hostFromSrc(srcAttr);
      if (host) thirdParty.add(host);
    }
  }

  for (const tag of iframes) {
    const srcAttr = (tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1];
    if (srcAttr) {
      const tagged = tagAdwareHost(srcAttr);
      if (tagged) add(tagged.category === "malware" ? "high" : "medium", `adware-iframe:${tagged.category}`, `${tagged.matched} embedded via iframe`, tag);
      if (pageIsHttps && /^http:\/\//i.test(srcAttr)) add("warn", "mixed-content", "http:// iframe on https page", tag);
      const host = hostFromSrc(srcAttr);
      if (host) thirdParty.add(host);
    }
    const style = (tag.match(/\bstyle\s*=\s*["']([^"']*)["']/i) || [])[1] || "";
    for (const [re, label] of HIDDEN_IFRAME_PATTERNS) {
      if (re.test(style)) { add("medium", "hidden-iframe", `iframe hidden via ${label}`, tag); break; }
    }
  }

  // 2. Meta refresh to a different host.
  const metaRefresh = [...src.matchAll(/<meta[^>]*http-equiv\s*=\s*["']?refresh["']?[^>]*>/gi)].map((m) => m[0]);
  for (const meta of metaRefresh) {
    const urlMatch = meta.match(/url\s*=\s*["']?([^"'>\s]+)/i);
    if (urlMatch && urlHost(urlMatch[1]) && urlHost(urlMatch[1]) !== urlHost(pageUrl)) {
      add("medium", "redirect", `meta refresh to ${urlMatch[1]}`, meta);
    }
  }

  // 3. Inline script obfuscation.
  const inlineScripts = [...src.matchAll(/<\s*script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
  for (const m of inlineScripts) {
    const body = m[2] || "";
    if (!body.trim()) continue;
    for (const [re, label, type] of OBFUSCATION_PATTERNS) {
      const hit = body.match(re);
      if (hit) {
        add(type === "miner" ? "high" : type === "obfuscation" ? "high" : "medium", type, label, hit[0].slice(0, 120));
        break;
      }
    }
  }

  // 4. Third-party script count heuristic.
  if (thirdParty.size > 10) {
    add("info", "third-party-exposure", `${thirdParty.size} distinct third-party script/iframe hosts`, [...thirdParty].sort().join(", "));
  }

  const severityRank = { high: 3, medium: 2, warn: 1, info: 0 };
  findings.sort((a, b) => (severityRank[b.severity] || 0) - (severityRank[a.severity] || 0));

  const hasHigh = findings.some((f) => f.severity === "high");
  const hasMedium = findings.some((f) => f.severity === "medium");
  const verdict = hasHigh ? "infected" : hasMedium ? "suspicious" : "clean";
  return { verdict, findings };
}

async function secScanAdware(args) {
  const url = String(args.url || "");
  await assertAllowedUrl(url);
  const response = await fetchWithTimeout(url, { redirect: "follow" }, args.timeout_ms || 20000);
  const html = await response.text();
  const result = scanHtmlForAdware(html, url);
  const lines = [`VERDICT: ${result.verdict.toUpperCase()} — ${url} (HTTP ${response.status})`];
  if (!result.findings.length) {
    lines.push("No adware/injection signatures found.");
    return lines.join("\n");
  }
  for (const f of result.findings) {
    lines.push(`[${f.severity.toUpperCase()}] ${f.type}: ${f.detail}`);
    if (f.evidence) lines.push(`    evidence: ${truncate(f.evidence, 160)}`);
  }
  return lines.join("\n");
}

// ── sec_headers_audit: security-header scoring ──────────────────────────────
const HEADER_CHECKS = [
  ["strict-transport-security", "fail", "HSTS missing on an HTTPS site — add Strict-Transport-Security: max-age=31536000; includeSubDomains"],
  ["content-security-policy", "warn", "CSP missing — add a Content-Security-Policy header (start with default-src 'self')"],
  ["x-frame-options", "fail", "X-Frame-Options missing (and no CSP frame-ancestors) — add X-Frame-Options: DENY (or SAMEORIGIN)"],
  ["x-content-type-options", "fail", "X-Content-Type-Options missing — add X-Content-Type-Options: nosniff"],
  ["referrer-policy", "warn", "Referrer-Policy missing — add Referrer-Policy: strict-origin-when-cross-origin"],
  ["permissions-policy", "info", "Permissions-Policy missing (informational)"],
];

async function secHeadersAudit(args) {
  const url = String(args.url || "");
  await assertAllowedUrl(url);
  const response = await fetchWithTimeout(url, { redirect: "follow", headers: { "user-agent": "dsw-security-audit/1.0" } }, args.timeout_ms || 20000);
  const headers = response.headers;
  const get = (name) => headers.get(name);

  const lines = [`Security headers — ${url} (HTTP ${response.status})`];
  let pass = 0;
  let total = 0;

  for (const [name, level, note] of HEADER_CHECKS) {
    const value = get(name);
    total += 1;
    if (value) {
      pass += 1;
      lines.push(`[OK]   ${name}: ${truncate(value, 140)}`);
    } else if (name === "x-frame-options" && /frame-ancestors/i.test(get("content-security-policy") || "")) {
      pass += 1;
      lines.push(`[OK]   x-frame-options: covered by CSP frame-ancestors`);
    } else {
      lines.push(`[${level.toUpperCase()}] ${name}: ${note}`);
    }
  }

  // CORS reflection check.
  const acao = get("access-control-allow-origin");
  if (acao) {
    if (acao.trim() === "*") {
      lines.push(`[WARN] CORS: Access-Control-Allow-Origin: * (allows any origin to read responses)`);
    } else {
      const probe = await fetchWithTimeout(url, {
        redirect: "follow",
        headers: { origin: "https://evil.example", "user-agent": "dsw-security-audit/1.0" },
      }, args.timeout_ms || 15000).catch(() => null);
      const reflected = probe?.headers?.get("access-control-allow-origin");
      if (reflected && reflected.includes("evil.example")) {
        lines.push(`[FAIL] CORS: ACAO reflects arbitrary Origin (${reflected}) — credentials-scoped CORS misconfiguration risk`);
      } else {
        lines.push(`[OK]   CORS: ACAO = ${truncate(acao, 100)} (does not reflect arbitrary origins)`);
      }
    }
  }

  // Cookie flags.
  let setCookies = [];
  try { setCookies = headers.getSetCookie ? headers.getSetCookie() : []; } catch { /* older undici */ }
  if (!setCookies.length) {
    const raw = get("set-cookie");
    if (raw) setCookies = [raw];
  }
  for (const cookie of setCookies.slice(0, 10)) {
    const flags = [];
    if (!/;\s*secure\b/i.test(cookie)) flags.push("missing Secure");
    if (!/;\s*httponly\b/i.test(cookie)) flags.push("missing HttpOnly");
    if (!/;\s*samesite\b/i.test(cookie)) flags.push("missing SameSite");
    if (flags.length) lines.push(`[WARN] cookie: ${truncate(cookie.split(";")[0], 60)} — ${flags.join(", ")}`);
  }

  // Info headers.
  for (const name of ["server", "x-powered-by", "via", "x-aspnet-version"]) {
    const value = get(name);
    if (value) lines.push(`[INFO] ${name}: ${truncate(value, 120)} (version disclosure)`);
  }

  lines.push("", `Score: ${pass}/${total} core headers present.`);
  return lines.join("\n");
}

// ── sec_http_request: raw request primitive ─────────────────────────────────
async function secHttpRequest(args) {
  const url = String(args.url || "");
  if (!url) throw new Error("url is required.");
  await assertAllowedUrl(url);
  const method = String(args.method || "GET").toUpperCase();
  const headers = { "user-agent": "dsw-http-request/1.0", ...(args.headers || {}) };
  const redirect = String(args.redirect || "follow");
  const timeoutMs = Number(args.timeout_ms) || 15000;
  const maxBytes = Math.min(Number(args.max_bytes) || 65536, 1048576);

  const body = args.body === undefined
    ? undefined
    : typeof args.body === "string" ? args.body : JSON.stringify(args.body);
  if (body !== undefined) headers["content-type"] = headers["content-type"] || "application/json";

  const started = Date.now();
  const response = await fetchWithTimeout(url, { method, headers, body, redirect }, timeoutMs);
  const durationMs = Date.now() - started;

  const outHeaders = {};
  response.headers.forEach((value, key) => { outHeaders[key] = value; });

  let bodyText = "";
  let binary = false;
  try {
    const buf = Buffer.from(await response.arrayBuffer());
    if (buf.length > maxBytes) {
      bodyText = `[body truncated to ${maxBytes} bytes of ${buf.length}]`;
    }
    const preview = buf.subarray(0, Math.min(maxBytes, buf.length));
    if (buf.length && !preview.includes(0)) bodyText += preview.toString("utf8");
    else if (buf.length) { binary = true; bodyText = `[binary body, ${buf.length} bytes, first bytes: ${preview.subarray(0, 64).toString("hex")}]`; }
  } catch (e) {
    bodyText = `[body read failed: ${e.message}]`;
  }

  const out = {
    method, url, status: response.status, statusText: response.statusText,
    duration_ms: durationMs, final_url: response.url || url, redirect: response.redirected,
    headers: outHeaders, binary,
  };
  return [
    `${method} ${url} -> ${response.status} ${response.statusText} (${durationMs}ms, redirects=${response.redirected})`,
    ...Object.entries(outHeaders).map(([k, v]) => `  ${k}: ${truncate(v, 200)}`),
    "", bodyText,
  ].join("\n");
}

// ── sec_fuzz_paths: polite path discovery ───────────────────────────────────
const WORDLISTS = {
  small: ["admin", "login", "logout", "register", "api", "v1", "config", "backup", "db", "uploads", "files", "static", "assets", "img", "js", "css", "wp-admin", "wp-content", "administrator", "panel", "phpmyadmin", "robots.txt", "sitemap.xml", "favicon.ico", ".git", ".env", ".htaccess", "index.php", "info.php", "test", "dev", "staging", "beta", "old", "temp", "cron", "scripts"],
  common: ["admin", "administrator", "admin/login", "login", "logout", "register", "signup", "api", "api/v1", "api/v2", "swagger", "swagger-ui", "docs", "graphql", "rest", "config", "configuration", "backup", "backups", "database", "db", "sql", "dump", "uploads", "upload", "files", "file", "download", "assets", "static", "img", "images", "media", "js", "css", "vendor", "node_modules", "wp-admin", "wp-login.php", "wp-content", "wp-includes", "wp-json", "administrator", "admin123", "panel", "cpanel", "phpmyadmin", "mysql", "robots.txt", "sitemap.xml", "sitemap_index.xml", "crossdomain.xml", ".well-known", ".env", ".env.local", ".git", ".git/config", ".git/HEAD", ".svn", ".htaccess", ".htpasswd", ".DS_Store", "index.php", "info.php", "phpinfo.php", "test.php", "shell.php", "config.php", "db.php", "connection.php", "backup.zip", "backup.sql", "dump.sql", "db.sql", "site.zip", "www.zip", "test", "dev", "staging", "beta", "old", "temp", "tmp", "cron", "cron.php", "scripts", "server-status", "server-info", "health", "healthz", "status", "metrics", "debug", "error", "errors", "404", "500", "console", "dashboard", "user", "users", "profile", "settings", "search", "feed", "rss", "atom", "xmlrpc.php", "web.config", "package.json", "composer.json", "Dockerfile", "docker-compose.yml", ".npmrc", ".htaccess.bak", "index.html.bak"],
};

async function secFuzzPaths(args) {
  const base = String(args.url || "");
  if (!base) throw new Error("url is required.");
  await assertAllowedUrl(base);
  const root = base.replace(/\/+$/, "");
  const wordlist = Array.isArray(args.wordlist)
    ? args.wordlist.map(String)
    : WORDLISTS[String(args.wordlist || "small")] || WORDLISTS.small;
  const list = [...new Set(wordlist)].slice(0, Math.min(Number(args.max_paths) || 200, 300));
  const delay = Math.max(Number(args.delay_ms) || 150, 100);
  const filter = String(args.status_filter || "");

  const findings = [];
  let tested = 0;
  for (const word of list) {
    const target = `${root}/${word}`;
    try {
      const response = await fetchWithTimeout(target, { method: "GET", redirect: "follow", headers: { "user-agent": "dsw-path-fuzz/1.0" } }, 8000);
      tested += 1;
      const status = response.status;
      if (status === 404) continue;
      if (filter && !String(status).includes(filter)) continue;
      const size = Number(response.headers.get("content-length")) || 0;
      const finalUrl = response.redirected ? response.url : "";
      findings.push({ path: word, status, size, final_url: finalUrl });
    } catch {
      tested += 1;
    }
    await new Promise((r) => setTimeout(r, delay));
  }
  if (!findings.length) {
    return `Fuzzed ${tested} paths on ${base} — all returned 404 (or errors). Clean.`;
  }
  const lines = [`Fuzzed ${tested} paths on ${base} — ${findings.length} non-404:`, ...findings.map((f) => `  ${String(f.status).padEnd(4)} ${f.size.toString().padEnd(8)} /${f.path}${f.final_url ? ` -> ${f.final_url}` : ""}`)];
  return lines.join("\n");
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set(["sec_http_request", "sec_fuzz_paths"]);

export async function runSecurityTool(name, args, opts = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const summary = args.url ? `Target: ${args.url}` : "";
    const ok = await opts.askYesNo?.(`Run ${name}?\n${summary}`.trim());
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "sec_encode": return secEncode(args);
    case "sec_extract_iocs": return secExtractIocs(args);
    case "sec_crt_subdomains": return secCrtSubdomains(args);
    case "sec_scan_adware": return secScanAdware(args);
    case "sec_headers_audit": return secHeadersAudit(args);
    case "sec_http_request": return secHttpRequest(args);
    case "sec_fuzz_paths": return secFuzzPaths(args);
    default: throw new Error(`Unknown security tool: ${name}`);
  }
}

export function securityToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    schema("sec_http_request",
      "Raw HTTP(S) request against an ALLOWLISTED host (register with `dsw security allow <domain>`). Method/headers/body/redirect control. No auto-exploitation — a curl-class primitive.",
      {
        method: { type: "string", description: "HTTP method. Default GET." },
        url: { type: "string", description: "Full URL. Host must be allowlisted." },
        headers: { type: "object", description: "Extra request headers." },
        body: { type: "string", description: "Request body (object → JSON)." },
        redirect: { type: "string", enum: ["follow", "manual", "error"], description: "Redirect policy. Default follow." },
        timeout_ms: { type: "number", description: "Timeout in ms. Default 15000." },
        max_bytes: { type: "number", description: "Max response body bytes to show. Default 65536." },
      },
      ["url"]),
    schema("sec_fuzz_paths",
      "Polite path discovery against an ALLOWLISTED base URL (rate-limited, max 300 paths). Reports non-404 results. Use only on hosts you own.",
      {
        url: { type: "string", description: "Base URL (e.g. https://example.com). Host must be allowlisted." },
        wordlist: { type: "string", enum: ["small", "common"], description: "Built-in wordlist. Default small." },
        delay_ms: { type: "number", description: "Delay between requests, min 100. Default 150." },
        max_paths: { type: "number", description: "Max paths to test, max 300. Default 200." },
        status_filter: { type: "string", description: "Only report statuses containing this string (e.g. 2, 30, 403)." },
      },
      ["url"]),
    schema("sec_crt_subdomains",
      "Passive subdomain enumeration via certificate transparency (crt.sh), with optional DNS resolution and dangling-DNS (takeover candidate) detection.",
      {
        domain: { type: "string", description: "Domain to enumerate, e.g. example.com." },
        resolve: { type: "boolean", description: "Resolve names and flag dangling DNS. Default true." },
        max: { type: "number", description: "Max names to list. Default 300." },
        timeout_ms: { type: "number", description: "crt.sh timeout. Default 25000." },
      },
      ["domain"]),
    schema("sec_encode",
      "Encoding/crypto workbench: base64, base64url, hex, url, rot13, sha1, sha256, md5, JWT decode, XOR (key required).",
      {
        action: { type: "string", enum: ["b64_encode", "b64_decode", "b64url_encode", "b64url_decode", "hex_encode", "hex_decode", "url_encode", "url_decode", "rot13", "sha1", "sha256", "md5", "jwt_decode", "xor"], description: "Operation." },
        value: { type: "string", description: "Input value." },
        key: { type: "string", description: "Key for xor." },
      },
      ["action", "value"]),
    schema("sec_extract_iocs",
      "Extract indicators from text or a file: URLs, IPv4, emails, MD5/SHA1/SHA256 hashes, domains.",
      {
        text: { type: "string", description: "Text to scan." },
        file: { type: "string", description: "Workspace-relative file to scan instead of text." },
        max: { type: "number", description: "Max per category. Default 50." },
      }),
    schema("sec_scan_adware",
      "Fetch an ALLOWLISTED page and scan for injected adware: known ad/malware/miner script hosts, hidden iframes, obfuscated eval/atob payloads, popunders, redirects, mixed content, third-party exposure. Verdict: clean/suspicious/infected.",
      {
        url: { type: "string", description: "Page URL. Host must be allowlisted." },
        timeout_ms: { type: "number", description: "Fetch timeout. Default 20000." },
      },
      ["url"]),
    schema("sec_headers_audit",
      "Fetch an ALLOWLISTED URL and score security headers (HSTS, CSP, X-Frame-Options, nosniff, Referrer-Policy, Permissions-Policy), test CORS origin reflection, check cookie flags, and note version-disclosure headers.",
      {
        url: { type: "string", description: "URL to audit. Host must be allowlisted." },
        timeout_ms: { type: "number", description: "Fetch timeout. Default 20000." },
      },
      ["url"]),
  ];
}
