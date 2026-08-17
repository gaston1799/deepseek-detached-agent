// Self-test for src/security_tools.js pure logic (allowlist matching, IOC
// extraction, adware signature engine, cipher workbench).
import assert from "node:assert";
import { extractIocsFromText, hostAllowed, runCipher, scanHtmlForAdware } from "../src/security_tools.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

// Allowlist matching.
check("allowlist exact + subdomain", () => {
  const list = { domains: ["example.com"] };
  assert.equal(hostAllowed("example.com", list), true);
  assert.equal(hostAllowed("minecraft.example.com", list), true);
  assert.equal(hostAllowed("notexample.com", list), false);
  assert.equal(hostAllowed("evil.com", list), false);
  assert.equal(hostAllowed("https://example.com:8443/path", list), true);
  assert.equal(hostAllowed("", list), false);
});

// Cipher workbench round-trips.
check("encode round-trips", () => {
  assert.equal(runCipher("b64_encode", "hello"), "aGVsbG8=");
  assert.equal(runCipher("b64_decode", "aGVsbG8="), "hello");
  assert.equal(runCipher("hex_encode", "hi"), "6869");
  assert.equal(runCipher("hex_decode", "6869"), "hi");
  assert.equal(runCipher("rot13", "hello"), "uryyb");
  assert.equal(runCipher("rot13", "uryyb"), "hello");
  assert.equal(runCipher("url_decode", "a%20b"), "a b");
  assert.equal(runCipher("sha256", "abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert.equal(runCipher("xor", runCipher("xor", "secret", "key"), "key"), "secret"); // xor round-trip
  assert.equal(runCipher("b64url_encode", "hello?"), "aGVsbG8_");
});

// JWT decode shape.
check("jwt_decode shape", () => {
  const token = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhZG1pbiJ9.sig";
  const out = runCipher("jwt_decode", token);
  assert.ok(out.includes('"alg":"HS256"'));
  assert.ok(out.includes('"sub":"admin"'));
});

// IOC extraction.
check("ioc extraction", () => {
  const text = "hit http://evil.example/x?a=1 and 1.2.3.4 with admin@evil.example file 5f4dcc3b5aa765d61d8327deb882cf99 sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
  const iocs = extractIocsFromText(text);
  assert.ok(iocs.urls.includes("http://evil.example/x?a=1"));
  assert.ok(iocs.ipv4.includes("1.2.3.4"));
  assert.ok(iocs.emails.includes("admin@evil.example"));
  assert.ok(iocs.md5.includes("5f4dcc3b5aa765d61d8327deb882cf99"));
  assert.ok(iocs.sha256.includes("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"));
  assert.ok(iocs.domains.includes("evil.example"));
});

// Adware scan: injected miner + hidden iframe + obfuscated eval.
check("adware scan detects injection", () => {
  const html = `<!doctype html><html><head></head><body>
    <script src="https://cdn.example.com/app.js"></script>
    <script src="https://coinhive.min.js"></script>
    <iframe src="https://popads.net/x" style="position:absolute;left:-1000px;width:1px;height:1px"></iframe>
    <script>eval(atob("d2luZG93Lm9wZW4oImh0dHA6Ly9hZC5ldmlsLmNvbSIp"));</script>
  </body></html>`;
  const r = scanHtmlForAdware(html, "https://victim.example/");
  assert.equal(r.verdict, "infected");
  assert.ok(r.findings.some((f) => f.type === "adware-script:miner"), "miner script flagged");
  assert.ok(r.findings.some((f) => f.type === "hidden-iframe"), "hidden iframe flagged");
  assert.ok(r.findings.some((f) => f.type === "obfuscation"), "obfuscated eval flagged");
});

// Adware scan: clean page stays clean.
check("adware scan clean page", () => {
  const html = `<!doctype html><html><head></head><body><h1>Welcome</h1><script src="/app.js"></script></body></html>`;
  const r = scanHtmlForAdware(html, "https://victim.example/");
  assert.equal(r.verdict, "clean");
});

// Mixed content detection on https page.
check("mixed content flagged", () => {
  const html = `<script src="http://cdn.example.com/old.js"></script>`;
  const r = scanHtmlForAdware(html, "https://victim.example/");
  assert.ok(r.findings.some((f) => f.type === "mixed-content"));
});

console.log(`\nAll ${passed} security checks passed.`);
