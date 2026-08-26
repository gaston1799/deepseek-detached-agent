# Known issues & deferred work (dsw security/RE toolkit)

Status of known bugs, hard-to-fix items, and optional Docker images. Updated
2026-08-21.

## Fixed

- **`patch_text_file`/`patch_files` corrupted content containing `

- **UTF-8 BOM in `security-allowlist.json`** — PowerShell `Set-Content -Encoding
  UTF8` wrote a BOM; Node `JSON.parse` failed silently and the allowlist loaded
  as empty, so `dsw security allow` never actually worked. Rewritten BOM-free.
- **`.NET metadata parser table numbering** — mscorlib-style assemblies use the
  ECMA-335 **6th edition** table IDs (ModuleRef=0x1a, AssemblyRef=0x23,
  MethodSpec=0x2b, GenericParamConstraint=0x2c, …), not classic .NET IDs. The
  parser now walks all 64 tables sequentially with full layouts; verified
  against real `mscorlib.dll` (3356 types / 29257 methods).
- **`net-tools.js` pcap container path** — `/workspace/<path>` was built from a
  cwd-relative path, but the sandbox mounts the **task root** at `/workspace`.
  Added `containerPath()` which rebases artifact paths relative to the task
  root. Needs a live capture to fully exercise.
- **`re_ghidra` import path** — the host binary is not mounted into the sandbox
  (only the task workspace is). The runner now copies the target into
  `taskRoot/tmp/` and imports `/workspace/tmp/target-<file>`.
- **Mojibake in `re_tools.js`** — the part-file merge via PowerShell decoded
  UTF-8 as CP1252; em-dashes/box-drawing chars were corrupted. Fixed with a
  byte-level re-encode.

## Known / hard to fix (documented, not yet resolved)

- **Ghidra headless not in `linux-re` image** — `re_ghidra` detects
  `analyzeHeadless` and returns setup instructions when missing. Fix requires
  building the optional image (~1.5 GB download) and swapping the profile:
  ```powershell
  docker build --file docker/Dockerfile.linux-re-ghidra --tag dsw/linux-re-ghidra:latest .
  # then point SANDBOX_ENVIRONMENTS["linux-re"].image at the new tag in src/sandbox.js
  ```
- **Fuzzing image lacks sanitizer runtimes** — `libclang_rt.asan`/`.fuzzer`
  are not installed, so `fz_prepare asan:true` and libFuzzer linking fail
  (plain AFL++ works). The Dockerfile has a comment + apt line for
  `libclang-rt-18-dev`; rebuilding the image enables ASAN-backed fuzzing.
  Rebuild: `docker build --file docker/Dockerfile.fuzzing --tag dsw/fuzzing:latest .`
- **`sys_ipc_discovery` URI/COM registry reads** — use the .NET Registry API
  via PowerShell (reg query is too slow per-scheme). Values are bounded
  (150 handlers / 200 COM servers). HKCR enumeration is capped at 2500 keys;
  very late-alphabet schemes may be missed.
- **Crash re-run without ASAN** — `fz_triage` classifies by exit signal when
  the harness was built without ASAN (no `heap-buffer-overflow`-style detail).
  Rebuild the fuzzing image with `libclang-rt-18-dev` and use `asan:true` for
  precise fault classification.
- **Frida / mitmproxy not in any sandbox image** — runners will be
  detection-gated like `re_ghidra`; a Dockerfile per tool is the intended path
  (e.g. `Dockerfile.linux-re-frida`, mitmproxy on `network-analysis`).
- **`re_asar` prettify is heuristic** — minified JS only gets naive newline
  insertion (`;`/`}` → newline), not a real formatter. Source maps are
  discovered and reported; fetching them gives full source.
- **`atk_injection_probe` SSRF oracle is response-difference based** — no
  external callback server, so blind SSRF needs manual verification. Payload
  set is deliberately conservative (loopback/metadata only).
- **`atk_scan_target` TCP connect scan** — no SYN stealth, no service-banner
  grab beyond HTTP; bounded to 40 ports. Fine for recon on owned hosts, not a
  full nmap replacement.
- **Windows `spawn("docker")` resolution** — `where docker` returns both an
  extensionless `docker` bash script and `docker.exe`; Node picked the script
  and failed with `spawn UNKNOWN` (errno -4094). Fixed in `sandbox.js` via
  `dockerExecutable()` which resolves `docker.exe` explicitly on win32.
- **AFL crash filenames contain `:`** — invalid on Windows NTFS. `fz_afl`
  copies crashes back with Windows-safe names (`id_000000_...`); `fz_triage`
  matches both `id:*` and `id_*` patterns.
- **`fz_afl` magic-prefix harnesses are hard for AFL** — deterministic stages
  destroy rare byte prefixes; seed near the crash condition (e.g. a length
  boundary) for quick finds. Crashing seeds are skipped by AFL, so don't seed
  an already-crashing input.
- **Network capture (`net_capture_*`) relies on the `network-analysis` sandbox
  having `dumpcap`/`tshark`** — image is built; if a rebuild is needed,
  `docker/build-images.ps1` rebuilds all profiles.

## Deferred by operator

- **Ghidra / Frida / mitmproxy image builds** — deferred 2026-08-21; the agent
  can wire them (build + retag + swap profile), but a ~1.5 GB download is
  involved. Documented here instead.
- **Phase 4+ of the offensive-tool roadmap** — fuzzing workflows, crash triage,
  HackerOne scope ingestion, ROI dashboards, orphaned-container cleanup (see
  the clipboard roadmap in `task.md`/TODO notes).
`** — the
  EOL-tolerant fast path used `String.replace(old, new)`, which interprets
  `

- **UTF-8 BOM in `security-allowlist.json`** — PowerShell `Set-Content -Encoding
  UTF8` wrote a BOM; Node `JSON.parse` failed silently and the allowlist loaded
  as empty, so `dsw security allow` never actually worked. Rewritten BOM-free.
- **`.NET metadata parser table numbering** — mscorlib-style assemblies use the
  ECMA-335 **6th edition** table IDs (ModuleRef=0x1a, AssemblyRef=0x23,
  MethodSpec=0x2b, GenericParamConstraint=0x2c, …), not classic .NET IDs. The
  parser now walks all 64 tables sequentially with full layouts; verified
  against real `mscorlib.dll` (3356 types / 29257 methods).
- **`net-tools.js` pcap container path** — `/workspace/<path>` was built from a
  cwd-relative path, but the sandbox mounts the **task root** at `/workspace`.
  Added `containerPath()` which rebases artifact paths relative to the task
  root. Needs a live capture to fully exercise.
- **`re_ghidra` import path** — the host binary is not mounted into the sandbox
  (only the task workspace is). The runner now copies the target into
  `taskRoot/tmp/` and imports `/workspace/tmp/target-<file>`.
- **Mojibake in `re_tools.js`** — the part-file merge via PowerShell decoded
  UTF-8 as CP1252; em-dashes/box-drawing chars were corrupted. Fixed with a
  byte-level re-encode.

## Known / hard to fix (documented, not yet resolved)

- **Ghidra headless not in `linux-re` image** — `re_ghidra` detects
  `analyzeHeadless` and returns setup instructions when missing. Fix requires
  building the optional image (~1.5 GB download) and swapping the profile:
  ```powershell
  docker build --file docker/Dockerfile.linux-re-ghidra --tag dsw/linux-re-ghidra:latest .
  # then point SANDBOX_ENVIRONMENTS["linux-re"].image at the new tag in src/sandbox.js
  ```
- **Fuzzing image lacks sanitizer runtimes** — `libclang_rt.asan`/`.fuzzer`
  are not installed, so `fz_prepare asan:true` and libFuzzer linking fail
  (plain AFL++ works). The Dockerfile has a comment + apt line for
  `libclang-rt-18-dev`; rebuilding the image enables ASAN-backed fuzzing.
  Rebuild: `docker build --file docker/Dockerfile.fuzzing --tag dsw/fuzzing:latest .`
- **`sys_ipc_discovery` URI/COM registry reads** — use the .NET Registry API
  via PowerShell (reg query is too slow per-scheme). Values are bounded
  (150 handlers / 200 COM servers). HKCR enumeration is capped at 2500 keys;
  very late-alphabet schemes may be missed.
- **Crash re-run without ASAN** — `fz_triage` classifies by exit signal when
  the harness was built without ASAN (no `heap-buffer-overflow`-style detail).
  Rebuild the fuzzing image with `libclang-rt-18-dev` and use `asan:true` for
  precise fault classification.
- **Frida / mitmproxy not in any sandbox image** — runners will be
  detection-gated like `re_ghidra`; a Dockerfile per tool is the intended path
  (e.g. `Dockerfile.linux-re-frida`, mitmproxy on `network-analysis`).
- **`re_asar` prettify is heuristic** — minified JS only gets naive newline
  insertion (`;`/`}` → newline), not a real formatter. Source maps are
  discovered and reported; fetching them gives full source.
- **`atk_injection_probe` SSRF oracle is response-difference based** — no
  external callback server, so blind SSRF needs manual verification. Payload
  set is deliberately conservative (loopback/metadata only).
- **`atk_scan_target` TCP connect scan** — no SYN stealth, no service-banner
  grab beyond HTTP; bounded to 40 ports. Fine for recon on owned hosts, not a
  full nmap replacement.
- **Windows `spawn("docker")` resolution** — `where docker` returns both an
  extensionless `docker` bash script and `docker.exe`; Node picked the script
  and failed with `spawn UNKNOWN` (errno -4094). Fixed in `sandbox.js` via
  `dockerExecutable()` which resolves `docker.exe` explicitly on win32.
- **AFL crash filenames contain `:`** — invalid on Windows NTFS. `fz_afl`
  copies crashes back with Windows-safe names (`id_000000_...`); `fz_triage`
  matches both `id:*` and `id_*` patterns.
- **`fz_afl` magic-prefix harnesses are hard for AFL** — deterministic stages
  destroy rare byte prefixes; seed near the crash condition (e.g. a length
  boundary) for quick finds. Crashing seeds are skipped by AFL, so don't seed
  an already-crashing input.
- **Network capture (`net_capture_*`) relies on the `network-analysis` sandbox
  having `dumpcap`/`tshark`** — image is built; if a rebuild is needed,
  `docker/build-images.ps1` rebuilds all profiles.

## Deferred by operator

- **Ghidra / Frida / mitmproxy image builds** — deferred 2026-08-21; the agent
  can wire them (build + retag + swap profile), but a ~1.5 GB download is
  involved. Documented here instead.
- **Phase 4+ of the offensive-tool roadmap** — fuzzing workflows, crash triage,
  HackerOne scope ingestion, ROI dashboards, orphaned-container cleanup (see
  the clipboard roadmap in `task.md`/TODO notes).
`, ``  ``, `# Known issues & deferred work (dsw security/RE toolkit)

Status of known bugs, hard-to-fix items, and optional Docker images. Updated
2026-08-21.

## Fixed`, `$`, `$n` in the *replacement* as special patterns.
  Patching content like PowerShell `

- **UTF-8 BOM in `security-allowlist.json`** — PowerShell `Set-Content -Encoding
  UTF8` wrote a BOM; Node `JSON.parse` failed silently and the allowlist loaded
  as empty, so `dsw security allow` never actually worked. Rewritten BOM-free.
- **`.NET metadata parser table numbering** — mscorlib-style assemblies use the
  ECMA-335 **6th edition** table IDs (ModuleRef=0x1a, AssemblyRef=0x23,
  MethodSpec=0x2b, GenericParamConstraint=0x2c, …), not classic .NET IDs. The
  parser now walks all 64 tables sequentially with full layouts; verified
  against real `mscorlib.dll` (3356 types / 29257 methods).
- **`net-tools.js` pcap container path** — `/workspace/<path>` was built from a
  cwd-relative path, but the sandbox mounts the **task root** at `/workspace`.
  Added `containerPath()` which rebases artifact paths relative to the task
  root. Needs a live capture to fully exercise.
- **`re_ghidra` import path** — the host binary is not mounted into the sandbox
  (only the task workspace is). The runner now copies the target into
  `taskRoot/tmp/` and imports `/workspace/tmp/target-<file>`.
- **Mojibake in `re_tools.js`** — the part-file merge via PowerShell decoded
  UTF-8 as CP1252; em-dashes/box-drawing chars were corrupted. Fixed with a
  byte-level re-encode.

## Known / hard to fix (documented, not yet resolved)

- **Ghidra headless not in `linux-re` image** — `re_ghidra` detects
  `analyzeHeadless` and returns setup instructions when missing. Fix requires
  building the optional image (~1.5 GB download) and swapping the profile:
  ```powershell
  docker build --file docker/Dockerfile.linux-re-ghidra --tag dsw/linux-re-ghidra:latest .
  # then point SANDBOX_ENVIRONMENTS["linux-re"].image at the new tag in src/sandbox.js
  ```
- **Fuzzing image lacks sanitizer runtimes** — `libclang_rt.asan`/`.fuzzer`
  are not installed, so `fz_prepare asan:true` and libFuzzer linking fail
  (plain AFL++ works). The Dockerfile has a comment + apt line for
  `libclang-rt-18-dev`; rebuilding the image enables ASAN-backed fuzzing.
  Rebuild: `docker build --file docker/Dockerfile.fuzzing --tag dsw/fuzzing:latest .`
- **`sys_ipc_discovery` URI/COM registry reads** — use the .NET Registry API
  via PowerShell (reg query is too slow per-scheme). Values are bounded
  (150 handlers / 200 COM servers). HKCR enumeration is capped at 2500 keys;
  very late-alphabet schemes may be missed.
- **Crash re-run without ASAN** — `fz_triage` classifies by exit signal when
  the harness was built without ASAN (no `heap-buffer-overflow`-style detail).
  Rebuild the fuzzing image with `libclang-rt-18-dev` and use `asan:true` for
  precise fault classification.
- **Frida / mitmproxy not in any sandbox image** — runners will be
  detection-gated like `re_ghidra`; a Dockerfile per tool is the intended path
  (e.g. `Dockerfile.linux-re-frida`, mitmproxy on `network-analysis`).
- **`re_asar` prettify is heuristic** — minified JS only gets naive newline
  insertion (`;`/`}` → newline), not a real formatter. Source maps are
  discovered and reported; fetching them gives full source.
- **`atk_injection_probe` SSRF oracle is response-difference based** — no
  external callback server, so blind SSRF needs manual verification. Payload
  set is deliberately conservative (loopback/metadata only).
- **`atk_scan_target` TCP connect scan** — no SYN stealth, no service-banner
  grab beyond HTTP; bounded to 40 ports. Fine for recon on owned hosts, not a
  full nmap replacement.
- **Windows `spawn("docker")` resolution** — `where docker` returns both an
  extensionless `docker` bash script and `docker.exe`; Node picked the script
  and failed with `spawn UNKNOWN` (errno -4094). Fixed in `sandbox.js` via
  `dockerExecutable()` which resolves `docker.exe` explicitly on win32.
- **AFL crash filenames contain `:`** — invalid on Windows NTFS. `fz_afl`
  copies crashes back with Windows-safe names (`id_000000_...`); `fz_triage`
  matches both `id:*` and `id_*` patterns.
- **`fz_afl` magic-prefix harnesses are hard for AFL** — deterministic stages
  destroy rare byte prefixes; seed near the crash condition (e.g. a length
  boundary) for quick finds. Crashing seeds are skipped by AFL, so don't seed
  an already-crashing input.
- **Network capture (`net_capture_*`) relies on the `network-analysis` sandbox
  having `dumpcap`/`tshark`** — image is built; if a rebuild is needed,
  `docker/build-images.ps1` rebuilds all profiles.

## Deferred by operator

- **Ghidra / Frida / mitmproxy image builds** — deferred 2026-08-21; the agent
  can wire them (build + retag + swap profile), but a ~1.5 GB download is
  involved. Documented here instead.
- **Phase 4+ of the offensive-tool roadmap** — fuzzing workflows, crash triage,
  HackerOne scope ingestion, ROI dashboards, orphaned-container cleanup (see
  the clipboard roadmap in `task.md`/TODO notes).
...'` silently scrambled the file (and
  could corrupt the harness source itself). Fixed in `patchEolTolerant` by
  using `split/join` (literal) for the fast path. NOTE: the running wrapper
  process loads the old code into memory at startup — restart `dsw` to pick
  up this fix. Verified on disk via a fresh-process harness test.

- **UTF-8 BOM in `security-allowlist.json`** — PowerShell `Set-Content -Encoding
  UTF8` wrote a BOM; Node `JSON.parse` failed silently and the allowlist loaded
  as empty, so `dsw security allow` never actually worked. Rewritten BOM-free.
- **`.NET metadata parser table numbering** — mscorlib-style assemblies use the
  ECMA-335 **6th edition** table IDs (ModuleRef=0x1a, AssemblyRef=0x23,
  MethodSpec=0x2b, GenericParamConstraint=0x2c, …), not classic .NET IDs. The
  parser now walks all 64 tables sequentially with full layouts; verified
  against real `mscorlib.dll` (3356 types / 29257 methods).
- **`net-tools.js` pcap container path** — `/workspace/<path>` was built from a
  cwd-relative path, but the sandbox mounts the **task root** at `/workspace`.
  Added `containerPath()` which rebases artifact paths relative to the task
  root. Needs a live capture to fully exercise.
- **`re_ghidra` import path** — the host binary is not mounted into the sandbox
  (only the task workspace is). The runner now copies the target into
  `taskRoot/tmp/` and imports `/workspace/tmp/target-<file>`.
- **Mojibake in `re_tools.js`** — the part-file merge via PowerShell decoded
  UTF-8 as CP1252; em-dashes/box-drawing chars were corrupted. Fixed with a
  byte-level re-encode.

## Known / hard to fix (documented, not yet resolved)

- **Ghidra headless not in `linux-re` image** — `re_ghidra` detects
  `analyzeHeadless` and returns setup instructions when missing. Fix requires
  building the optional image (~1.5 GB download) and swapping the profile:
  ```powershell
  docker build --file docker/Dockerfile.linux-re-ghidra --tag dsw/linux-re-ghidra:latest .
  # then point SANDBOX_ENVIRONMENTS["linux-re"].image at the new tag in src/sandbox.js
  ```
- **Fuzzing image lacks sanitizer runtimes** — `libclang_rt.asan`/`.fuzzer`
  are not installed, so `fz_prepare asan:true` and libFuzzer linking fail
  (plain AFL++ works). The Dockerfile has a comment + apt line for
  `libclang-rt-18-dev`; rebuilding the image enables ASAN-backed fuzzing.
  Rebuild: `docker build --file docker/Dockerfile.fuzzing --tag dsw/fuzzing:latest .`
- **`sys_ipc_discovery` URI/COM registry reads** — use the .NET Registry API
  via PowerShell (reg query is too slow per-scheme). Values are bounded
  (150 handlers / 200 COM servers). HKCR enumeration is capped at 2500 keys;
  very late-alphabet schemes may be missed.
- **Crash re-run without ASAN** — `fz_triage` classifies by exit signal when
  the harness was built without ASAN (no `heap-buffer-overflow`-style detail).
  Rebuild the fuzzing image with `libclang-rt-18-dev` and use `asan:true` for
  precise fault classification.
- **Frida / mitmproxy not in any sandbox image** — runners will be
  detection-gated like `re_ghidra`; a Dockerfile per tool is the intended path
  (e.g. `Dockerfile.linux-re-frida`, mitmproxy on `network-analysis`).
- **`re_asar` prettify is heuristic** — minified JS only gets naive newline
  insertion (`;`/`}` → newline), not a real formatter. Source maps are
  discovered and reported; fetching them gives full source.
- **`atk_injection_probe` SSRF oracle is response-difference based** — no
  external callback server, so blind SSRF needs manual verification. Payload
  set is deliberately conservative (loopback/metadata only).
- **`atk_scan_target` TCP connect scan** — no SYN stealth, no service-banner
  grab beyond HTTP; bounded to 40 ports. Fine for recon on owned hosts, not a
  full nmap replacement.
- **Windows `spawn("docker")` resolution** — `where docker` returns both an
  extensionless `docker` bash script and `docker.exe`; Node picked the script
  and failed with `spawn UNKNOWN` (errno -4094). Fixed in `sandbox.js` via
  `dockerExecutable()` which resolves `docker.exe` explicitly on win32.
- **AFL crash filenames contain `:`** — invalid on Windows NTFS. `fz_afl`
  copies crashes back with Windows-safe names (`id_000000_...`); `fz_triage`
  matches both `id:*` and `id_*` patterns.
- **`fz_afl` magic-prefix harnesses are hard for AFL** — deterministic stages
  destroy rare byte prefixes; seed near the crash condition (e.g. a length
  boundary) for quick finds. Crashing seeds are skipped by AFL, so don't seed
  an already-crashing input.
- **Network capture (`net_capture_*`) relies on the `network-analysis` sandbox
  having `dumpcap`/`tshark`** — image is built; if a rebuild is needed,
  `docker/build-images.ps1` rebuilds all profiles.

## Deferred by operator

- **Ghidra / Frida / mitmproxy image builds** — deferred 2026-08-21; the agent
  can wire them (build + retag + swap profile), but a ~1.5 GB download is
  involved. Documented here instead.
- **Phase 4+ of the offensive-tool roadmap** — fuzzing workflows, crash triage,
  HackerOne scope ingestion, ROI dashboards, orphaned-container cleanup (see
  the clipboard roadmap in `task.md`/TODO notes).
