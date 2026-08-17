// Self-test for the EOL-tolerant patch helpers (must mirror src/deepseek-watch.js).
"use strict";
const assert = require("node:assert");

function detectEol(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeEolMap(content) {
  const normChars = [];
  const origStart = [];
  const origEnd = [];
  for (let i = 0; i < content.length; i++) {
    if (content.charCodeAt(i) === 13 && content.charCodeAt(i + 1) === 10) {
      normChars.push("\n");
      origStart.push(i);
      origEnd.push(i + 2);
      i += 1;
    } else {
      normChars.push(content[i]);
      origStart.push(i);
      origEnd.push(i + 1);
    }
  }
  return { norm: normChars.join(""), origStart, origEnd };
}

function normIncludes(content, needle) {
  if (content.includes(needle)) return true;
  return content.replace(/\r\n/g, "\n").includes(String(needle).replace(/\r\n/g, "\n"));
}

function patchEolTolerant(content, oldString, newString, { replaceAll = false } = {}) {
  newString = String(newString == null ? "" : newString);
  // Fast path: byte-exact match (respects the documented behavior).
  if (content.includes(oldString)) {
    if (replaceAll) {
      const parts = content.split(oldString);
      return { content: parts.join(newString), count: parts.length - 1 };
    }
    return { content: content.replace(oldString, newString), count: 1 };
  }
  // CRLF/LF tolerant fallback: match on normalized text, splice the original.
  const fileEol = detectEol(content);
  const { norm, origStart, origEnd } = normalizeEolMap(content);
  const normOld = oldString.replace(/\r\n/g, "\n");
  const indices = [];
  let from = 0;
  while (true) {
    const idx = norm.indexOf(normOld, from);
    if (idx === -1) break;
    indices.push(idx);
    from = idx + Math.max(normOld.length, 1);
  }
  if (!indices.length) return null;
  const normNew = newString.replace(/\r\n/g, "\n").replace(/\n/g, fileEol);
  const targets = replaceAll ? indices : indices.slice(0, 1);
  let out = content;
  for (let i = targets.length - 1; i >= 0; i--) {
    const idx = targets[i];
    const start = origStart[idx];
    const end = origEnd[idx + normOld.length - 1];
    out = out.slice(0, start) + normNew + out.slice(end);
  }
  return { content: out, count: targets.length };
}

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

// 1. LF file, LF needle -> exact path, LF insert.
check("exact path LF/LF", () => {
  const c = "a\nb\nc\n";
  const r = patchEolTolerant(c, "b", "B");
  assert.equal(r.count, 1);
  assert.equal(r.content, "a\nB\nc\n");
});

// 2. CRLF file, LF needle (the classic Windows mismatch) -> tolerant path, CRLF insert, rest untouched.
check("tolerant CRLF file / LF needle", () => {
  const c = "line1\r\nOLD\r\nline3\r\n";
  const r = patchEolTolerant(c, "line1\nOLD\nline3", "line1\nNEW\nline3");
  assert.equal(r.count, 1);
  assert.equal(r.content, "line1\r\nNEW\r\nline3\r\n");
});

// 3. Multi-line block insert preserves CRLF.
check("tolerant multi-line insert CRLF", () => {
  const c = "x\r\nfunction foo() {\r\n  return 1;\r\n}\r\ny\r\n";
  const r = patchEolTolerant(c, "function foo() {\n  return 1;\n}", "function foo() {\n  return 2;\n}");
  assert.equal(r.count, 1);
  assert.equal(r.content, "x\r\nfunction foo() {\r\n  return 2;\r\n}\r\ny\r\n");
});

// 4. replace_all with CRLF file / LF needle, two occurrences.
check("tolerant replace_all", () => {
  const c = "a\r\nT\r\nb\r\nT\r\nc\r\n";
  const r = patchEolTolerant(c, "T", "Z", { replaceAll: true });
  assert.equal(r.count, 2);
  assert.equal(r.content, "a\r\nZ\r\nb\r\nZ\r\nc\r\n");
});

// 5. Mixed endings: dominant CRLF, LF needle that does NOT match byte-exactly
// (CRLF sits where the needle has LF) -> tolerant path splices with dominant EOL.
check("mixed EOL file (tolerant path)", () => {
  const c = "a\r\nb\r\nc\nd\r\n";
  const r = patchEolTolerant(c, "b\nc", "B\nC");
  assert.equal(r.count, 1);
  assert.equal(r.content, "a\r\nB\r\nC\nd\r\n");
});

// 6. Not found -> null.
check("not found returns null", () => {
  assert.equal(patchEolTolerant("abc\ndef\n", "zzz"), null);
});

// 7. normIncludes across EOL styles.
check("normIncludes CRLF needle in LF file", () => {
  assert.equal(normIncludes("a\nb\n", "a\r\nb"), true);
  assert.equal(normIncludes("a\r\nb\r\n", "a\nb"), true);
  assert.equal(normIncludes("a\nb\n", "x"), false);
});

// 8. Simulate the patch_files same-file grouping (multi-edit ordering).
check("patch_files same-file ordering simulation", () => {
  const content = "async function a() {\n  return 1;\n}\n\nasync function b() {\n  return 2;\n}\n";
  const edits = [
    { old_string: "return 1;", new_string: "return 10;", replace_all: false },
    { old_string: "return 2;", new_string: "return 20;", replace_all: false },
  ];
  let cur = content;
  let total = 0;
  for (const e of edits) {
    const r = patchEolTolerant(cur, e.old_string, e.new_string, { replaceAll: e.replace_all });
    assert.ok(r);
    cur = r.content;
    total += r.count;
  }
  assert.equal(total, 2);
  assert.ok(cur.includes("return 10;") && cur.includes("return 20;"));
});

console.log(`\nAll ${passed} checks passed.`);
