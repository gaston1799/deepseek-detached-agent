import { readFile, writeFile, mkdir } from "node:fs/promises";
import { taskRoot } from "./artifacts.js";

function statePath(cwd, taskId, name) { return `${taskRoot(cwd, taskId)}/${name}.json`; }

async function readState(cwd, taskId, name, fallback) {
  try { return JSON.parse(await readFile(statePath(cwd, taskId, name), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function writeState(cwd, taskId, name, value) {
  await mkdir(taskRoot(cwd, taskId), { recursive: true });
  await writeFile(statePath(cwd, taskId, name), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  return value;
}

export async function getScope(cwd, taskId) { return readState(cwd, taskId, "scope", { schema_version: 1, allowed_assets: [], excluded_assets: [], allowed_classes: [], excluded_classes: [], restrictions: [], source_artifact: null, updated_at: null }); }

export async function setScope(cwd, taskId, scope) {
  const value = {
    schema_version: 1,
    allowed_assets: Array.isArray(scope.allowed_assets) ? scope.allowed_assets.map(String) : [],
    excluded_assets: Array.isArray(scope.excluded_assets) ? scope.excluded_assets.map(String) : [],
    allowed_classes: Array.isArray(scope.allowed_classes) ? scope.allowed_classes.map(String) : [],
    excluded_classes: Array.isArray(scope.excluded_classes) ? scope.excluded_classes.map(String) : [],
    restrictions: Array.isArray(scope.restrictions) ? scope.restrictions.map(String) : [],
    source_artifact: scope.source_artifact || null,
    updated_at: new Date().toISOString()
  };
  return writeState(cwd, taskId, "scope", value);
}

export async function addScopeAssets(cwd, taskId, assets) {
  const current = await getScope(cwd, taskId);
  const additions = Array.isArray(assets) ? assets.map(String) : [];
  return setScope(cwd, taskId, { ...current, allowed_assets: [...new Set([...current.allowed_assets, ...additions])] });
}

export async function removeScopeAssets(cwd, taskId, assets) {
  const current = await getScope(cwd, taskId);
  const remove = new Set((Array.isArray(assets) ? assets : []).map((item) => String(item).toLowerCase()));
  return setScope(cwd, taskId, { ...current, allowed_assets: current.allowed_assets.filter((asset) => !remove.has(String(asset).toLowerCase())) });
}

function assetMatches(target, rule) {
  const t = String(target || "").toLowerCase();
  const r = String(rule || "").toLowerCase().trim();
  if (!r) return false;
  try {
    if (/^https?:\/\//.test(r)) return new URL(t).hostname === new URL(r).hostname || new URL(t).hostname.endsWith(`.${new URL(r).hostname}`);
  } catch {}
  return t === r || t.endsWith(`.${r}`) || t.includes(r);
}

export async function checkScope(cwd, taskId, target, vulnerabilityClass = "") {
  const scope = await getScope(cwd, taskId);
  const excluded = scope.excluded_assets.some((rule) => assetMatches(target, rule));
  const allowed = scope.allowed_assets.some((rule) => assetMatches(target, rule));
  const classExcluded = scope.excluded_classes.some((rule) => String(vulnerabilityClass).toLowerCase().includes(String(rule).toLowerCase()));
  const classAllowed = !scope.allowed_classes.length || scope.allowed_classes.some((rule) => String(vulnerabilityClass).toLowerCase().includes(String(rule).toLowerCase()));
  return { allowed: !excluded && allowed && !classExcluded && classAllowed, target, vulnerability_class: vulnerabilityClass, reason: excluded ? "asset_excluded" : classExcluded ? "class_excluded" : !allowed ? "asset_not_in_scope" : !classAllowed ? "class_not_in_scope" : "allowed" };
}

export async function requireScope(cwd, taskId, target, vulnerabilityClass = "") {
  const scope = await getScope(cwd, taskId);
  if (!scope.allowed_assets.length) throw new Error("Target blocked: task scope has no allowed_assets. Use scope_set with reviewed authorization first.");
  const decision = await checkScope(cwd, taskId, target, vulnerabilityClass);
  if (!decision.allowed) throw new Error(`Target blocked by task scope: ${decision.reason}`);
  return decision;
}

export async function recordHypothesis(cwd, taskId, input) {
  const current = await readState(cwd, taskId, "hypotheses", { schema_version: 1, entries: [] });
  const entry = { id: `${Date.now()}-${current.entries.length + 1}`, hypothesis: String(input.hypothesis || ""), evidence: String(input.evidence || ""), test: String(input.test || ""), outcome: String(input.outcome || ""), rejected_reason: String(input.rejected_reason || ""), artifacts: Array.isArray(input.artifacts) ? input.artifacts.map(String) : [], created_at: new Date().toISOString() };
  current.entries.push(entry); current.updated_at = new Date().toISOString();
  await writeState(cwd, taskId, "hypotheses", current); return entry;
}

export async function recordViability(cwd, taskId, input) {
  const value = { decision: String(input.decision || "").toUpperCase(), factors: input.factors || {}, notes: String(input.notes || ""), created_at: new Date().toISOString() };
  if (!["CONTINUE", "ESCALATE", "DROP"].includes(value.decision)) throw new Error("viability decision must be CONTINUE, ESCALATE, or DROP.");
  return writeState(cwd, taskId, "viability", value);
}

export async function recordRoi(cwd, taskId, input) {
  const current = await readState(cwd, taskId, "roi", { schema_version: 1, entries: [] });
  current.entries.push({ ...input, created_at: new Date().toISOString() }); current.updated_at = new Date().toISOString();
  await writeState(cwd, taskId, "roi", current); return current.entries.at(-1);
}

const DEFAULT_ESCALATION_POLICY = {
  schema_version: 1,
  cheap_models: ["deepseek-v4-flash", "glm-4.7"],
  specialist_models: [],
  verifier_models: [],
  max_cheap_passes: 3,
  escalate_on: ["high_complexity", "credible_finding", "ambiguous_evidence", "native_re"],
  updated_at: null
};

export async function getEscalationPolicy(cwd, taskId) { return readState(cwd, taskId, "escalation-policy", { ...DEFAULT_ESCALATION_POLICY }); }

export async function setEscalationPolicy(cwd, taskId, input) {
  const value = {
    ...DEFAULT_ESCALATION_POLICY,
    cheap_models: Array.isArray(input.cheap_models) ? input.cheap_models.map(String) : DEFAULT_ESCALATION_POLICY.cheap_models,
    specialist_models: Array.isArray(input.specialist_models) ? input.specialist_models.map(String) : [],
    verifier_models: Array.isArray(input.verifier_models) ? input.verifier_models.map(String) : [],
    max_cheap_passes: Math.min(Math.max(Number(input.max_cheap_passes) || 3, 1), 20),
    escalate_on: Array.isArray(input.escalate_on) ? input.escalate_on.map(String) : DEFAULT_ESCALATION_POLICY.escalate_on,
    updated_at: new Date().toISOString()
  };
  return writeState(cwd, taskId, "escalation-policy", value);
}

export async function decideEscalation(cwd, taskId, input = {}) {
  const policy = await getEscalationPolicy(cwd, taskId);
  const complexity = String(input.complexity || "low").toLowerCase();
  const finding = String(input.finding_confidence || "none").toLowerCase();
  const cheapPasses = Math.max(0, Number(input.cheap_passes) || 0);
  const needsVerifier = ["high", "validated", "credible"].includes(finding) && policy.verifier_models.length;
  const needsSpecialist = complexity === "high" || ["credible", "high", "ambiguous"].includes(finding) || cheapPasses >= policy.max_cheap_passes;
  const role = needsVerifier ? "verifier" : needsSpecialist ? "specialist" : "cheap";
  const models = role === "verifier" ? policy.verifier_models : role === "specialist" ? policy.specialist_models : policy.cheap_models;
  return { role, model: models[0] || null, requires_configured_model: !models.length, reasons: [complexity === "high" ? "high_complexity" : null, ["credible", "high", "ambiguous"].includes(finding) ? "finding_requires_review" : null, cheapPasses >= policy.max_cheap_passes ? "cheap_pass_limit_reached" : null].filter(Boolean), policy };
}
