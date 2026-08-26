// src/bounty_tools.js — bug-bounty operations tooling for the dsw harness.
//
// Phase 5 of the roadmap:
//   - h1_config       — store HackerOne API credentials (username + token)
//   - h1_scope        — pull a program's structured scopes from the HackerOne
//                       API and seed the task allowlist/scope
//   - bounty_report   — generate a paste-ready HackerOne-style finding report
//   - bounty_dashboard— summarize ROI entries, hypotheses, viability, escalation
//   - docker_cleanup  — sweep orphaned dsw-* Docker containers
//
// HackerOne API: https://api.hackerone.com/v1/hackers/programs/{handle}/structured_scopes
// Auth: HTTP Basic with H1 API username + token (stored via h1_config, never
// in chat or source control).
import { readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { writeArtifact, taskRoot } from "./artifacts.js";
import { readConfig, writeConfig } from "./config.js";
import { addScopeAssets, getEscalationPolicy, getScope, recordRoi, setScope } from "./task-state.js";
import { allowlistPath, loadAllowlist } from "./security_tools.js";

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

async function readStateJson(cwd, taskId, name, fallback) {
  const { readFile: rf } = await import("node:fs/promises");
  try {
    return JSON.parse(await rf(join(taskRoot(cwd, taskId), `${name}.json`), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// ── h1_config: store HackerOne API credentials ───────────────────────────────
async function h1Config(args, ctx) {
  const username = String(args.username || "").trim();
  const token = String(args.token || "").trim();
  if (!username || !token) throw new Error("username and token are required — get them from HackerOne → Settings → API.");
  const config = await readConfig();
  config.hackerone = { username, token, updated_at: new Date().toISOString() };
  await writeConfig(config);
  return "HackerOne API credentials stored (username only shown here; token is kept in the config file, mode 0600).";
}

// ── h1_scope: pull structured scopes and seed the allowlist/scope ───────────
const H1_ASSET_KINDS = new Set(["URL", "DOMAIN", "CIDR", "WILDCARD", "RELEASE", "API", "DEVICE", "OTHER", "TESTFLIGHT", "GOOGLE_APP", "IOS_APP", "WINDOWS_APP", "SOURCE_CODE", "EXECUTABLE", "STOREFRONT", "HARDWARE", "ANDROID_APP"]);

function h1ApiHeaders(creds) {
  const basic = Buffer.from(`${creds.username}:${creds.token}`).toString("base64");
  return { authorization: `Basic ${basic}`, accept: "application/json", "user-agent": "dsw-bounty/1.0" };
}

export function assetIdentifier(asset) {
  const attr = asset?.attributes || {};
  const identifier = String(attr.identifier || "");
  if (!identifier) return "";
  if (/^https?:\/\//i.test(identifier)) {
    try { return new URL(identifier).hostname; } catch { return identifier; }
  }
  return identifier.replace(/^www\./i, "").replace(/\/$/, "");
}

async function fetchH1Endpoint(url, creds, timeoutMs) {
  const res = await fetch(url, { headers: h1ApiHeaders(creds), signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 401 || res.status === 403) throw new Error(`HackerOne API auth failed (HTTP ${res.status}) — check credentials with h1_config.`);
  if (!res.ok) throw new Error(`HackerOne API responded HTTP ${res.status} for ${url}`);
  return res.json();
}

async function h1Scope(args, ctx) {
  const handle = String(args.handle || "").trim();
  if (!handle) throw new Error("handle is required — e.g. 'security' for security.hackerone.com.");
  const config = await readConfig();
  const creds = config.hackerone;
  if (!creds?.username || !creds?.token) {
    return "HackerOne credentials are not configured. Run h1_config with your API username and token first.";
  }
  const timeoutMs = Math.min(Math.max(Number(args.timeout_ms) || 30000, 5000), 60000);
  const base = "https://api.hackerone.com/v1/hackers/programs";

  const scopesUrl = `${base}/${encodeURIComponent(handle)}/structured_scopes`;
  const exclusionsUrl = `${base}/${encodeURIComponent(handle)}/scope_exclusions`;

  let scopeData = { data: [] };
  let exclusionData = { data: [] };
  try { scopeData = await fetchH1Endpoint(scopesUrl, creds, timeoutMs); } catch (error) { return `Failed to fetch structured scopes: ${error.message}\n(The program may be private or the handle may be wrong.)`; }
  try { exclusionData = await fetchH1Endpoint(exclusionsUrl, creds, timeoutMs); } catch { /* exclusions optional */ }

  const inScope = [];
  const outOfScope = [];
  for (const item of scopeData.data || []) {
    const attr = item.attributes || {};
    const kind = String(attr.asset_type || "").toUpperCase();
    const identifier = String(attr.identifier || "");
    const eligible = attr.eligible_for_bounty !== false && attr.eligible_for_submission !== false;
    const entry = { kind, identifier, eligible, host: assetIdentifier(item) };
    if (attr.eligible_for_submission === false || attr.asset_type === "OTHER") outOfScope.push(entry);
    else inScope.push(entry);
  }
  for (const item of exclusionData.data || []) {
    const attr = item.attributes || {};
    outOfScope.push({ kind: String(attr.asset_type || "").toUpperCase(), identifier: String(attr.asset_identifier || attr.identifier || ""), note: String(attr.description || "") });
  }

  // Seed the task scope (allowed_assets) with in-scope hosts/URLs.
  const allowed = [...new Set(inScope.filter((e) => e.host).map((e) => e.host))];
  const excluded = [...new Set(outOfScope.filter((e) => e.host).map((e) => e.host))];
  const current = await getScope(ctx.cwd, ctx.taskId);
  await setScope(ctx.cwd, ctx.taskId, {
    ...current,
    allowed_assets: [...new Set([...current.allowed_assets, ...allowed])],
    excluded_assets: [...new Set([...current.excluded_assets, ...excluded])],
    source_artifact: `h1:${handle}`,
  });

  // Also merge hosts into the security allowlist for sec_/atk_ tools.
  const list = await loadAllowlist();
  const domainsToAdd = allowed.filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h) && !list.domains.includes(h));
  if (domainsToAdd.length) {
    const { mkdir: mk, writeFile: wf } = await import("node:fs/promises");
    const { dirname: dn } = await import("node:path");
    await mk(dn(allowlistPath()), { recursive: true });
    await wf(allowlistPath(), JSON.stringify({ ...list, domains: [...list.domains, ...domainsToAdd] }, null, 2) + "\n", "utf8");
  }

  const lines = [
    `HackerOne scope — ${handle}`,
    `In scope (${inScope.length}): ${inScope.length ? "" : "(none — check handle / program visibility)"}`,
  ];
  for (const e of capList(inScope, 80)) {
    lines.push(`  [${e.kind}] ${e.identifier}${e.eligible ? "" : " (no bounty)"}`);
  }
  lines.push(`\nOut of scope (${outOfScope.length}):`);
  for (const e of capList(outOfScope, 40)) {
    lines.push(`  [${e.kind}] ${e.identifier || e.note || "(unnamed)"}`);
  }
  lines.push(`\nSeeded ${allowed.length} in-scope host(s) into task scope; ${excluded.length} exclusion(s) added; ${domainsToAdd.length} host(s) added to the security allowlist.`);
  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "h1-scope", name: `h1-${handle}-scope.json`, data: JSON.stringify({ program: handle, in_scope: inScope, out_of_scope: outOfScope, seeded_allowed: allowed, seeded_excluded: excluded }, null, 2), metadata: { program: handle } });
  lines.push(`Artifact: ${artifact.path}`);
  return lines.join("\n");
}

// ── bounty_report: paste-ready HackerOne-style finding report ───────────────
function severityToCvss(severity) {
  switch (String(severity || "").toLowerCase()) {
    case "critical": return "9.8";
    case "high": return "8.1";
    case "medium": return "5.3";
    case "low": return "3.1";
    default: return "0.0";
  }
}

function sanitizeRepro(text) {
  return String(text || "").replace(/```/g, "` `` `").trim();
}

async function bountyReport(args, ctx) {
  const title = String(args.title || "").trim();
  if (!title) throw new Error("title is required.");
  const severity = String(args.severity || "medium").toLowerCase();
  if (!["critical", "high", "medium", "low", "informational"].includes(severity)) throw new Error("severity must be critical|high|medium|low|informational.");
  const cwe = String(args.cwe || "CWE-0").toUpperCase();
  const asset = String(args.asset || "");
  const description = String(args.description || "");
  const steps = String(args.steps || "");
  const impact = String(args.impact || "");
  const remediation = String(args.remediation || "See the linked advisory / patch notes.");
  const references = Array.isArray(args.references) ? args.references.map(String) : String(args.references || "").split(/\r?\n/).filter(Boolean);

  const md = [
    `## Summary`,
    description ? truncate(description, 4000) : "_Provide a concise summary of the vulnerability._",
    ``,
    `**Severity:** ${severity.toUpperCase()} (CVSS ~${severityToCvss(severity)})`,
    `**Weakness:** ${cwe}`,
    asset ? `**Affected asset:** ${asset}` : "",
    ``,
    `## Steps to Reproduce`,
    steps ? sanitizeRepro(steps) : `1. _Describe the first step._\n2. _Describe the second step._\n3. _Observe the issue._`,
    ``,
    `## Impact`,
    impact ? truncate(impact, 2000) : `_Describe the security impact._`,
    ``,
    `## Remediation`,
    remediation,
    references.length ? `\n## References\n${references.map((r) => `- ${r}`).join("\n")}` : "",
    ``,
    `---`,
    `_Generated by dsw bounty_report — verify all claims before submitting._`,
  ].filter((line) => line !== "");

  const content = md.join("\n");
  const dest = join(taskRoot(ctx.cwd, ctx.taskId), "reports", `${title.replace(/[^A-Za-z0-9 _-]/g, "").slice(0, 60).trim().replace(/\s+/g, "_") || "finding"}-${Date.now()}.md`);
  await mkdir(dirname(dest), { recursive: true });
  await writeFile(dest, content, "utf8");

  const lines = [
    `bounty_report — ${title} (${severity.toUpperCase()})`,
    `Report written to ${relative(ctx.cwd, dest)}`,
    ``,
    content,
  ];
  return lines.join("\n");
}

// ── bounty_dashboard: ROI / hypotheses / viability / escalation summary ─────
async function bountyDashboard(args, ctx) {
  const roi = await readStateJson(ctx.cwd, ctx.taskId, "roi", { schema_version: 1, entries: [] });
  const hypotheses = await readStateJson(ctx.cwd, ctx.taskId, "hypotheses", { schema_version: 1, entries: [] });
  const viability = await readStateJson(ctx.cwd, ctx.taskId, "viability", null);
  const policy = await getEscalationPolicy(ctx.cwd, ctx.taskId);
  const scope = await getScope(ctx.cwd, ctx.taskId);

  const lines = [`Bounty dashboard — task ${ctx.taskId}`, ""];
  lines.push(`Scope: ${scope.allowed_assets.length} allowed, ${scope.excluded_assets.length} excluded, source ${scope.source_artifact || "(manual)"}`);
  lines.push(`Hypotheses tested: ${(hypotheses.entries || []).length}`);
  const outcomes = {};
  for (const h of hypotheses.entries || []) outcomes[h.outcome] = (outcomes[h.outcome] || 0) + 1;
  if (Object.keys(outcomes).length) lines.push(`  by outcome: ${Object.entries(outcomes).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  lines.push(`Viability: ${viability ? `${viability.decision}${viability.notes ? ` — ${viability.notes}` : ""}` : "not recorded"}`);
  lines.push(`Escalation policy: cheap=${policy.cheap_models.join(",") || "(none)"} max_passes=${policy.max_cheap_passes} escalate_on=${policy.escalate_on.join(",")}`);

  const entries = (roi.entries || []).slice(-50);
  if (entries.length) {
    lines.push("", `ROI entries (last ${entries.length}):`);
    let totalCost = 0; let totalRuntime = 0; let findings = 0;
    for (const e of entries) {
      totalCost += Number(e.api_cost) || 0;
      totalRuntime += Number(e.runtime_ms) || 0;
      if (e.result && !/none|skip|abandon/i.test(e.result)) findings++;
      lines.push(`  [${e.severity || "?"}] ${e.model || "?"} ${e.result || ""} cost=$${Number(e.api_cost || 0).toFixed(4)} ${e.runtime_ms ? `${(Number(e.runtime_ms) / 1000).toFixed(1)}s` : ""}`);
    }
    lines.push(`\nTotals: ${entries.length} runs, $${totalCost.toFixed(4)} API spend, ${(totalRuntime / 1000).toFixed(1)}s runtime, ${findings} non-empty results.`);
  } else {
    lines.push("\nNo ROI entries recorded yet — use roi_record after each model run.");
  }

  const artifact = await writeArtifact({ cwd: ctx.cwd, taskId: ctx.taskId, kind: "bounty-dashboard", name: `dashboard-${Date.now()}.json`, data: JSON.stringify({ roi: entries, hypotheses: hypotheses.entries || [], viability, policy, scope }, null, 2), metadata: {} });
  lines.push(`\nArtifact: ${artifact.path}`);
  return lines.join("\n");
}

// ── docker_cleanup: sweep orphaned dsw-* containers ─────────────────────────
async function dockerCleanup(args, ctx) {
  const { sandboxOperation } = await import("./sandbox.js");
  const dryRun = args.dry_run !== false;
  const olderThanSeconds = Math.min(Math.max(Number(args.older_than_seconds) || 0, 0), 86400 * 7);
  const listed = await sandboxOperation({ cwd: ctx.cwd, taskId: ctx.taskId, operation: "list_containers" });
  const containers = Array.isArray(listed.containers) ? listed.containers : [];
  const now = Date.now();

  const stale = [];
  for (const c of containers) {
    if (!String(c.name || "").startsWith("dsw-")) continue;
    if (!olderThanSeconds) { stale.push(c); continue; }
    try {
      const insp = await sandboxOperation({ cwd: ctx.cwd, taskId: ctx.taskId, operation: "inspect", container: c.name, timeoutMs: 20000 });
      const created = insp?.stdout ? (() => { try { return JSON.parse(insp.stdout)?.[0]?.Created; } catch { return null; } })() : null;
      const createdMs = created ? new Date(created).getTime() : NaN;
      if (Number.isFinite(createdMs) && now - createdMs > olderThanSeconds * 1000) stale.push(c);
    } catch { /* unreadable → leave it */ }
  }

  const lines = [`docker_cleanup — ${containers.length} dsw-* container(s), ${stale.length} matching filter`];
  if (dryRun) lines.push("Dry run — nothing destroyed. Re-run with dry_run:false to clean.");
  for (const c of stale.slice(0, 100)) {
    lines.push(`  ${dryRun ? "[would destroy]" : "[destroyed]"} ${c.name} (${c.status || "?"})`);
  }
  if (!dryRun) {
    let destroyed = 0;
    for (const c of stale) {
      try { await sandboxOperation({ cwd: ctx.cwd, taskId: ctx.taskId, operation: "destroy", container: c.name, timeoutMs: 30000 }); destroyed++; } catch { /* already gone */ }
    }
    lines.push(`\nDestroyed ${destroyed} container(s).`);
  }
  if (!stale.length) lines.push("No stale containers found.");
  return lines.join("\n");
}

// ── Dispatch + schemas ───────────────────────────────────────────────────────
const ACTIVE_TOOLS = new Set(["h1_scope", "docker_cleanup"]);

export async function runBountyTool(name, args, opts = {}, ctx = {}) {
  if (opts.permission === "review") return "blocked by session permission: review only";
  if (ACTIVE_TOOLS.has(name) && opts.permission !== "full" && !opts.dangerouslyAutoRunCommands) {
    if (opts.noOutput) return "blocked by no-output mode";
    const summary = args.handle ? `Program: ${args.handle}` : args.title ? `Report: ${args.title}` : "";
    const ok = await opts.askYesNo?.(`Run ${name}?\n${summary}`.trim());
    if (ok === false) return "blocked by user";
  }
  switch (name) {
    case "h1_config": return h1Config(args, ctx);
    case "h1_scope": return h1Scope(args, ctx);
    case "bounty_report": return bountyReport(args, ctx);
    case "bounty_dashboard": return bountyDashboard(args, ctx);
    case "docker_cleanup": return dockerCleanup(args, ctx);
    default: throw new Error(`Unknown bounty tool: ${name}`);
  }
}

export function bountyToolSchemas() {
  const schema = (name, description, properties, required = []) => ({
    type: "function",
    function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
  });
  return [
    schema("h1_config",
      "Store HackerOne API credentials (username + token from H1 Settings → API) in the dsw config file (mode 0600). Required before h1_scope. Never put credentials in chat.",
      {
        username: { type: "string", description: "HackerOne API username (from H1 Settings → API)." },
        token: { type: "string", description: "HackerOne API token (from H1 Settings → API)." },
      },
      ["username", "token"]),
    schema("h1_scope",
      "Pull a HackerOne program's structured scopes from the Hacker API and seed the task scope + security allowlist: in-scope hosts become allowed assets, exclusions become blocked. Requires h1_config credentials.",
      {
        handle: { type: "string", description: "Program handle, e.g. 'security' for security.hackerone.com." },
        timeout_ms: { type: "number", description: "API timeout. Default 30000." },
      },
      ["handle"]),
    schema("bounty_report",
      "Generate a paste-ready HackerOne-style finding report (summary, severity/CVSS, CWE, steps to reproduce, impact, remediation, references) and write it to the task reports dir as Markdown.",
      {
        title: { type: "string", description: "Finding title." },
        severity: { type: "string", enum: ["critical", "high", "medium", "low", "informational"], description: "Default medium." },
        cwe: { type: "string", description: "CWE id, e.g. CWE-79. Default CWE-0." },
        asset: { type: "string", description: "Affected asset (URL/domain/endpoint)." },
        description: { type: "string", description: "Vulnerability summary." },
        steps: { type: "string", description: "Step-by-step repro (newline separated)." },
        impact: { type: "string", description: "Security impact." },
        remediation: { type: "string", description: "Suggested fix. Default generic." },
        references: { type: "array", items: { type: "string" }, description: "Reference URLs." },
      },
      ["title"]),
    schema("bounty_dashboard",
      "Summarize the current task's bounty operations: scope, hypotheses tested (by outcome), viability decision, escalation policy, and ROI entries (model, cost, runtime, results) with totals. Writes a JSON artifact.",
      {}),
    schema("docker_cleanup",
      "List and destroy orphaned dsw-* sandbox containers. Dry-run by default; pass dry_run:false to actually destroy. Optionally only clean containers older than N seconds.",
      {
        dry_run: { type: "boolean", description: "Default true (dry run). Set false to destroy." },
        older_than_seconds: { type: "number", description: "Only destroy containers older than this. Default 0 (all dsw-*)." },
      }),
  ];
}
