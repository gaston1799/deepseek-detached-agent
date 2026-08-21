import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getArtifactIndex, searchArtifacts, writeArtifact } from "../src/artifacts.js";
import { addScopeAssets, decideEscalation, requireScope, setEscalationPolicy, setScope } from "../src/task-state.js";

const cwd = await mkdtemp(join(tmpdir(), "dsw-foundation-"));
try {
  const first = await writeArtifact({ cwd, taskId: "test", kind: "log", name: "first.log", data: "alpha finding" });
  await writeArtifact({ cwd, taskId: "test", kind: "log", name: "second.log", data: "beta finding" });
  const index = await getArtifactIndex({ cwd, taskId: "test" });
  assert.equal(Object.keys(index.artifacts).length, 2);
  const matches = await searchArtifacts({ cwd, taskId: "test", pattern: "finding" });
  assert.equal(matches.matches.length, 2);
  await setScope(cwd, "test", { allowed_assets: ["example.com"] });
  await addScopeAssets(cwd, "test", ["api.second.example"]);
  assert.equal((await requireScope(cwd, "test", "https://api.example.com")).allowed, true);
  assert.equal((await requireScope(cwd, "test", "https://api.second.example")).allowed, true);
  await assert.rejects(() => requireScope(cwd, "test", "https://outside.example"));
  await setEscalationPolicy(cwd, "test", { cheap_models: ["cheap"], specialist_models: ["specialist"], verifier_models: ["verifier"], max_cheap_passes: 2 });
  const decision = await decideEscalation(cwd, "test", { complexity: "high", finding_confidence: "credible", cheap_passes: 2 });
  assert.equal(decision.role, "verifier"); assert.equal(decision.model, "verifier"); assert.ok(first.id);
  console.log("foundation state/index checks passed");
} finally { await rm(cwd, { recursive: true, force: true }); }
