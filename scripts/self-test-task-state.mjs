import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkScope, getScope, recordHypothesis, recordRoi, recordViability, setScope } from "../src/task-state.js";

const cwd = await mkdtemp(join(tmpdir(), "dsw-task-state-"));
try {
  await setScope(cwd, "task", { allowed_assets: ["example.com"], excluded_assets: ["admin.example.com"], allowed_classes: ["xss", "auth"] });
  assert.equal((await checkScope(cwd, "task", "https://www.example.com/page", "xss")).allowed, true);
  assert.equal((await checkScope(cwd, "task", "https://admin.example.com", "xss")).allowed, false);
  assert.equal((await checkScope(cwd, "task", "https://example.com", "ssrf")).allowed, false);
  assert.equal((await recordViability(cwd, "task", { decision: "CONTINUE" })).decision, "CONTINUE");
  assert.ok((await recordHypothesis(cwd, "task", { hypothesis: "h", test: "t", outcome: "negative" })).id);
  assert.equal((await recordRoi(cwd, "task", { model: "test", result: "none" })).result, "none");
  assert.equal((await getScope(cwd, "task")).allowed_assets[0], "example.com");
  console.log("task scope/state checks passed");
} finally { await rm(cwd, { recursive: true, force: true }); }
