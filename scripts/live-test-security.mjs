// Live smoke of the security tools via runSecurityTool (permission: full).
import { runSecurityTool } from "../src/security_tools.js";

const opts = { permission: "full" };
async function run(name, args) {
  const t0 = Date.now();
  try {
    const out = await runSecurityTool(name, args, opts);
    console.log(`\n===== ${name} (${Date.now() - t0}ms) =====\n${out}`);
  } catch (e) {
    console.log(`\n===== ${name} ERROR (${Date.now() - t0}ms) =====\n${e.message}`);
  }
}

await run("sec_encode", { action: "jwt_decode", value: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJzZWN1cml0eS10ZXN0Iiwicm9sZSI6ImFkbWluIn0.sig" });
await run("sec_extract_iocs", { text: "user visited http://evil.example/x and 10.0.0.5; sha256 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08; contact admin@evil.example" });
await run("sec_crt_subdomains", { domain: "example.com", resolve: true, max: 30 });
await run("sec_headers_audit", { url: "https://example.com/" });
await run("sec_scan_adware", { url: "https://example.com/" });
await run("sec_http_request", { url: "https://example.com/", method: "GET", timeout_ms: 10000 });
await run("sec_fuzz_paths", { url: "https://example.com/", wordlist: "small", max_paths: 8 });
await run("sec_http_request", { url: "https://not-allowlisted-test.invalid/" }); // must be REFUSED
await run("sec_scan_adware", { url: "https://another-not-allowlisted.invalid/" }); // must be REFUSED
