// Self-test for src/fuzz_tools.js pure logic (crash classification, bucket keys).
import assert from "node:assert";
import { classifyCrash, crashBucketKey } from "../src/fuzz_tools.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

check("classify: heap-buffer-overflow (ASAN)", () => {
  const cls = classifyCrash("", "ERROR: AddressSanitizer: heap-buffer-overflow on address 0x602000000010", 11);
  assert.equal(cls.kind, "heap-buffer-overflow");
  assert.equal(cls.severity, "high");
});

check("classify: use-after-free", () => {
  const cls = classifyCrash("", "ERROR: AddressSanitizer: heap-use-after-free", 11);
  assert.equal(cls.kind, "use-after-free");
  assert.equal(cls.severity, "high");
});

check("classify: signal fallback SIGSEGV", () => {
  const cls = classifyCrash("", "", 11);
  assert.equal(cls.kind, "SIGSEGV");
  assert.equal(cls.severity, "high");
});

check("classify: unknown → low", () => {
  const cls = classifyCrash("normal output", "", 0);
  assert.equal(cls.kind, "unknown");
  assert.equal(cls.severity, "low");
});

check("bucket: same kind+frame dedupes, different frame separates", () => {
  const a = { kind: "SIGSEGV", frames: [{ func: "parse_input" }] };
  const b = { kind: "SIGSEGV", frames: [{ func: "parse_input" }] };
  const c = { kind: "SIGSEGV", frames: [{ func: "another_fn" }] };
  assert.equal(crashBucketKey(a), crashBucketKey(b));
  assert.notEqual(crashBucketKey(a), crashBucketKey(c));
});

check("bucket: different kind separates even with same frame", () => {
  const a = { kind: "SIGSEGV", frames: [{ func: "x" }] };
  const b = { kind: "double-free", frames: [{ func: "x" }] };
  assert.notEqual(crashBucketKey(a), crashBucketKey(b));
});

console.log(`\n${passed} fuzz-tools checks passed.`);
