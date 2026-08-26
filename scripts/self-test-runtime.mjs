// Self-test for src/runtime_tools.js pure logic (diffLists snapshot diffing).
// Host PowerShell observation is exercised separately via live smoke tests.
import assert from "node:assert";
import { diffLists } from "../src/runtime_tools.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

check("diffLists: services added/removed/changed", () => {
  const before = [
    { name: "svcA", state: "Running", start: "Auto" },
    { name: "svcB", state: "Running", start: "Auto" },
  ];
  const after = [
    { name: "svcA", state: "Stopped", start: "Auto" },   // changed
    { name: "svcC", state: "Running", start: "Manual" }, // added
  ];
  const d = diffLists(before, after, (s) => s.name, "services");
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].name, "svcC");
  assert.equal(d.removed.length, 1);
  assert.equal(d.removed[0].name, "svcB");
  assert.equal(d.changed.length, 1);
  assert.equal(d.changed[0].before.state, "Running");
  assert.equal(d.changed[0].after.state, "Stopped");
});

check("diffLists: identical lists → empty diff", () => {
  const list = [{ name: "x", state: "Running" }];
  const d = diffLists(list, [...list], (s) => s.name, "services");
  assert.equal(d.added.length + d.removed.length + d.changed.length, 0);
});

check("diffLists: empty before → all added", () => {
  const d = diffLists([], [{ pid: 1, name: "a" }, { pid: 2, name: "b" }], (p) => p.pid, "processes");
  assert.equal(d.added.length, 2);
  assert.equal(d.removed.length, 0);
});

console.log(`\n${passed} runtime-tools checks passed.`);
