// Self-test for src/re_tools.js pure logic (strings classification, ASAR
// header/list, block-hash diff, .NET metadata parsing). No sandbox/network.
import assert from "node:assert";
import { readFileSync } from "node:fs";
import { classifyStrings, diffBlockHashes, entropy, extractAsciiStrings, parseAsarHeader, asarListFiles, parseDotNetMetadata } from "../src/re_tools.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

// ── entropy ──────────────────────────────────────────────────────────────────
check("entropy: empty = 0, single-byte = 0, varied > 0", () => {
  assert.equal(entropy(Buffer.alloc(0)), 0);
  assert.equal(entropy(Buffer.from("AAAA")), 0); // all same byte → 0 bits of uncertainty
  assert.ok(entropy(Buffer.from("0123456789abcdef0123456789abcdef")) > 3.5);
});

// ── strings classification ───────────────────────────────────────────────────
check("strings classification", () => {
  const grouped = classifyStrings([
    { value: "https://evil.example/x?a=1" },
    { value: "admin@example.com" },
    { value: "1.2.3.4" },
    { value: "D:\\Windows\\System32\\cmd.exe" },
    { value: "\\\\.\\pipe\\svc" },
    { value: "HKEY_LOCAL_MACHINE\\SOFTWARE\\X" },
    { value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.sig" },
    { value: "-----BEGIN RSA PRIVATE KEY-----" },
    { value: "SELECT * FROM users" },
    { value: "/api/v1/login" },
    { value: "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA=" },
  ]);
  assert.ok(grouped.url.some((s) => s.value === "https://evil.example/x?a=1"));
  assert.ok(grouped.email.some((s) => s.value === "admin@example.com"));
  assert.ok(grouped.ipv4.some((s) => s.value === "1.2.3.4"));
  assert.ok(grouped.file_path.some((s) => s.value === "D:\\Windows\\System32\\cmd.exe"));
  assert.ok(grouped.pipe.some((s) => s.value === "\\\\.\\pipe\\svc"));
  assert.ok(grouped.registry.some((s) => s.value === "HKEY_LOCAL_MACHINE\\SOFTWARE\\X"));
  assert.ok(grouped.jwt.some((s) => s.value.startsWith("eyJhbGciOiJIUzI1NiJ9")));
  assert.ok(grouped.private_key.some((s) => s.value.includes("BEGIN RSA")));
  assert.ok(grouped.sql.some((s) => s.value === "SELECT * FROM users"));
  assert.ok(grouped.api_path.some((s) => s.value === "/api/v1/login"));
  assert.ok(grouped.base64_blob.some((s) => s.value === "MTIzNDU2Nzg5MDEyMzQ1Njc4OTA="));
});

check("ascii extraction respects min length", () => {
  const buf = Buffer.from("ab\x00longstring123\x00z", "binary");
  const strings = extractAsciiStrings(buf, 4);
  assert.deepEqual(strings.map((s) => s.value), ["longstring123"]);
});

// ── block-hash diff ──────────────────────────────────────────────────────────
check("block diff: identical files → 100%", () => {
  const a = ["aa", "bb", "cc"];
  const stats = diffBlockHashes(a, [...a]);
  assert.equal(stats.similarity, 100);
  assert.equal(stats.added, 0);
  assert.equal(stats.removed, 0);
});

check("block diff: added block detected", () => {
  const stats = diffBlockHashes(["aa", "bb"], ["aa", "bb", "zz"]);
  assert.equal(stats.added, 1);
  assert.equal(stats.similarity, Number(((2 / 3) * 100).toFixed(1)));
});

// ── ASAR header parsing ──────────────────────────────────────────────────────
function buildAsar(files) {
  // files: [{path:"a/b.txt", data:Buffer}]
  const fileTree = {};
  for (const f of files) {
    const parts = f.path.split("/");
    let node = fileTree;
    for (let i = 0; i < parts.length - 1; i++) {
      node[parts[i]] ||= { files: {} };
      node = node[parts[i]].files;
    }
    node[parts[parts.length - 1]] = { size: f.data.length, offset: "0" }; // patched below
  }
  // offsets must be sequential from dataStart; patch with real values later.
  const header = { files: fileTree };
  const headerJson = JSON.stringify(header);
  const headerSize = Buffer.byteLength(headerJson);
  const dataStart = 8 + headerSize;
  let offset = 0;
  const offsets = new Map();
  for (const f of files) { offsets.set(f.path, offset); offset += f.data.length; }
  // rebuild header with real offsets
  const assignOffsets = (node, prefix) => {
    for (const [name, entry] of Object.entries(node)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (entry.files) assignOffsets(entry.files, p);
      else entry.offset = String(offsets.get(p));
    }
  };
  assignOffsets(fileTree, "");
  const headerJson2 = JSON.stringify({ files: fileTree });
  const headerSize2 = Buffer.byteLength(headerJson2);
  const dataStart2 = 8 + headerSize2;
  const out = Buffer.alloc(dataStart2 + offset);
  out.writeUInt32LE(headerSize2 + 4, 0);
  out.writeUInt32LE(headerSize2, 4);
  out.write(headerJson2, 8, "utf8");
  for (const f of files) { out.set(f.data, dataStart2 + offsets.get(f.path)); }
  return out;
}

check("asar header parse + list", () => {
  const asar = buildAsar([
    { path: "app/main.js", data: Buffer.from("console.log(1)") },
    { path: "app/package.json", data: Buffer.from('{"name":"x"}') },
  ]);
  const { header, dataStart } = parseAsarHeader(asar);
  const files = asarListFiles(header);
  assert.equal(files.length, 2);
  assert.ok(files.some((f) => f.path === "app/main.js" && f.size === 14));
  assert.ok(dataStart > 8);
});

// ── .NET metadata parsing (real assembly if available) ───────────────────────
check("dotnet metadata parse from real .NET assembly", () => {
  const candidates = [
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\mscorlib.dll",
    "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.dll",
    "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\mscorlib.dll",
  ];
  let buffer = null;
  for (const c of candidates) {
    try { buffer = readFileSync(c); break; } catch { /* try next */ }
  }
  if (!buffer) { console.log("    (skipped — no .NET Framework assembly found)"); return; }
  const meta = parseDotNetMetadata(buffer);
  assert.ok(meta.types.length > 0, "expected types");
  assert.ok(meta.methods.length > 0, "expected methods");
  assert.ok(meta.types.some((t) => /System\./.test(t.name) || /Microsoft\./.test(t.name)));
  console.log(`    (parsed ${buffer.length} bytes: ${meta.types.length} types, ${meta.methods.length} methods, ${meta.assembly_refs.length} assembly refs)`);
});

check("dotnet metadata rejects non-CLR PE", () => {
  const fake = Buffer.alloc(1024);
  fake.write("MZ", 0, "ascii");
  fake.writeUInt32LE(0x40, 0x3c);
  fake.write("PE\0\0", 0x40, "ascii");
  fake.writeUInt16LE(0x20b, 0x40 + 24); // PE32+
  assert.throws(() => parseDotNetMetadata(fake), /No CLI header/);
});

console.log(`\n${passed} re-tools checks passed.`);
