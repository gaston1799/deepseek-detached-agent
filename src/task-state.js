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
