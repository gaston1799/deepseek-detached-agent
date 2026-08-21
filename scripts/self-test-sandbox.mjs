import assert from "node:assert/strict";
import { SANDBOX_ENVIRONMENTS, sandboxOperation } from "../src/sandbox.js";

const environments = await sandboxOperation({ operation: "list_environments" });
assert.equal(environments.length, 6);
for (const name of ["linux-general", "linux-re", "web-testing", "fuzzing", "network-analysis", "android-tools"]) {
  assert.ok(SANDBOX_ENVIRONMENTS[name]);
  assert.ok(environments.some((item) => item.name === name));
}
assert.equal(SANDBOX_ENVIRONMENTS["linux-general"].network, "none");
console.log("sandbox profile checks passed");
