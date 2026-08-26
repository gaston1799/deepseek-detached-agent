// Self-test for src/offensive_tools.js pure logic (JWT lab, JS intelligence
// extraction, port list parsing, TCP probe helper shape). No network needed.
import assert from "node:assert";
import { createHmac } from "node:crypto";
import { decodeJwtToken, extractJsIntel, jwtSignatureValid, parsePortList } from "../src/offensive_tools.js";

let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log(`  PASS ${name}`);
}

function makeJwt(header, payload, secret) {
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const h = enc(header);
  const p = enc(payload);
  const sig = secret ? createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url") : "";
  return `${h}.${p}.${sig}`;
}

// ── JWT decode / verify ──────────────────────────────────────────────────────
check("jwt decode header+payload", () => {
  const token = makeJwt({ alg: "HS256", typ: "JWT" }, { sub: "admin", exp: 9999999999 }, "secret");
  const { header, payload } = decodeJwtToken(token);
  assert.equal(header.alg, "HS256");
  assert.equal(payload.sub, "admin");
});

check("jwt rejects malformed tokens", () => {
  assert.throws(() => decodeJwtToken("not.a.jwt"));
  assert.throws(() => decodeJwtToken("a.b")); // 2 segments
});

check("jwt weak-secret signature verification", () => {
  const token = makeJwt({ alg: "HS256" }, { user: "admin" }, "secret");
  assert.equal(jwtSignatureValid(token, "secret"), true);
  assert.equal(jwtSignatureValid(token, "wrongsecret"), false);
  assert.equal(jwtSignatureValid("a.b.c", "secret"), false);
});

// ── JS intelligence extraction ───────────────────────────────────────────────
check("js intel extracts endpoints, params, sourcemaps, secrets", () => {
  const js = `
    const API = "/api/v2/users?limit=10&active=true";
    fetch('/auth/login').then(r => r.json());
    axios.get("/api/orders/123");
    const ws = new WebSocket("wss://example.com/socket");
    //# sourceMappingURL=/static/app.js.map
    const key = "AKIAIOSFODNN7EXAMPLE";
    const gh = "ghp_abcdefghijklmnopqrstuvwxyz1234567890";
  `;
  const intel = extractJsIntel(js, "https://example.com/app.js");
  assert.ok(intel.endpoints.has("/api/v2/users"));
  assert.ok(intel.endpoints.has("/auth/login"));
  assert.ok(intel.endpoints.has("/api/orders/123"));
  assert.ok(intel.params.has("limit"));
  assert.ok(intel.params.has("active"));
  assert.ok(intel.ws_urls.has("wss://example.com/socket"));
  assert.ok([...intel.sourcemaps].some((s) => s.includes("app.js.map")));
  assert.ok(intel.secrets.some((s) => s.type === "AWS access key"));
  assert.ok(intel.secrets.some((s) => s.type === "GitHub personal access token"));
});

check("js intel masks secret values, keeps context", () => {
  const intel = extractJsIntel(`const k = "AKIAIOSFODNN7EXAMPLE";`, "https://x.test/a.js");
  const aws = intel.secrets.find((s) => s.type === "AWS access key");
  assert.ok(aws);
  assert.ok(!aws.value.includes("AKIAIOSFODNN7EXAMPLE")); // masked
  assert.ok(aws.context.includes("AKIA"));
});

// ── Port list parsing ────────────────────────────────────────────────────────
check("port list parsing", () => {
  assert.deepEqual(parsePortList("80,443,8080"), [80, 443, 8080]);
  const range = parsePortList("8000-8003");
  assert.deepEqual(range, [8000, 8001, 8002, 8003]);
  assert.equal(parsePortList(""), null);
  assert.equal(parsePortList(null), null);
  assert.equal(parsePortList("70000"), null); // out of range
  assert.equal(parsePortList("abc"), null);
});

console.log(`\n${passed} offensive-tools checks passed.`);
