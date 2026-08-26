// Self-test for src/bounty_tools.js pure logic (CVSS mapping, asset parsing).
import assert from "node:assert";
import { assetIdentifier } from "../src/bounty_tools.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

check("asset identifier: URL → hostname", () => {
  assert.equal(assetIdentifier({ attributes: { identifier: "https://admin.example.com/path" } }), "admin.example.com");
});

check("asset identifier: bare domain → www stripped, slash trimmed", () => {
  assert.equal(assetIdentifier({ attributes: { identifier: "www.example.com/" } }), "example.com");
});

check("asset identifier: wildcard kept", () => {
  assert.equal(assetIdentifier({ attributes: { identifier: "*.example.com" } }), "*.example.com");
});

check("asset identifier: empty → empty", () => {
  assert.equal(assetIdentifier({ attributes: { identifier: "" } }), "");
});

console.log(`\n${passed} bounty-tools checks passed.`);
