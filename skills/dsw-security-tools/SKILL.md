---
name: dsw-security-tools
description: Web-app security tooling in the dsw harness — the sec_* tools, the target allowlist, and the workflow for authorized testing of your own sites (bug bounty, adware cleanup).
---

# dsw security tools

All active tools **refuse targets not in the security allowlist**
(`~/.deepseek-watch/security-allowlist.json`). Subdomains of an allowlisted
domain are allowed automatically.

## Register targets
```
dsw security allow <domain>     # e.g. dsw security allow minecraft.example.com
dsw security remove <domain>
dsw security list
```

## Tools
- `sec_http_request {url, method?, headers?, body?, redirect?, timeout_ms?, max_bytes?}` — raw HTTP(S), any method; the workhorse for API probing, auth tests, manual vulnerability checks.
- `sec_fuzz_paths {url, wordlist?: small|common, delay_ms? (>=100), max_paths? (<=300), status_filter?}` — polite path discovery; reports non-404 results.
- `sec_crt_subdomains {domain, resolve?: bool, max?}` — passive crt.sh cert-transparency enumeration plus dangling-DNS (takeover candidate) detection. crt.sh may 503; retry.
- `sec_encode {action, value, key?}` — b64/hex/url/rot13/sha1/sha256/md5/jwt_decode/xor workbench for payload building.
- `sec_extract_iocs {text?|file?, max?}` — URLs/IPv4/emails/md5/sha1/sha256/domains out of text or files.
- `sec_scan_adware {url}` — verdict clean|suspicious|infected: injected ad/malware/miner script hosts, hidden iframes, obfuscated eval/atob, popunders, redirects, mixed content.
- `sec_headers_audit {url}` — HSTS/CSP/XFO/nosniff/Referrer-Policy score, CORS origin-reflection test, cookie flags, version disclosure.

## Workflow for a new site
1. `dsw security allow <domain>`
2. `sec_scan_adware https://<domain>` — check adware first; user sites may be injected
3. `sec_headers_audit https://<domain>`
4. `sec_crt_subdomains <domain>` — attack surface + dangling DNS
5. `sec_fuzz_paths https://<domain> wordlist=common` — discovery
6. `sec_http_request` on anything interesting

## Rules
- Only targets the owner authorized. The allowlist is the guardrail — never bypass it.
- Rate limits are enforced; keep default delays. No auto-exploitation — tools are request primitives; craft payloads yourself.
