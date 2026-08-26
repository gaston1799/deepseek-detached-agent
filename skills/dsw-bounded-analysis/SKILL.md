---
name: dsw-bounded-analysis
description: Use the dsw artifact, sandbox, scope, packet-capture, PE-triage, and escalation tools for bounded authorized analysis.
---

# Bounded analysis workflow

0. For an authorized HackerOne target, run a cheap PBC viability pass before specialists: `pbc doctor`, then open the target in a dedicated tab, retrieve bounded text/snapshot state, and score attack surface, auth/IPC/installer signals, likely impact, payout, scope restrictions, and duplicate saturation. Persist `viability_set` as `CONTINUE`, `ESCALATE`, or `DROP`; then call `model_escalation_decide`.
1. Before a target-facing action, use `scope_set`; target-facing `sec_*` and allowlisted sandbox work fail closed unless the target matches `allowed_assets`. A scope may contain many assets. Use `scope_add_assets` and `scope_remove_assets` during the same session rather than creating a new worker.
2. Keep large output in artifacts. Use `artifact_list`, `artifact_index`, `artifact_search_all`, `artifact_search`, and `artifact_read_range`; do not request whole logs or captures.
3. Use `sandbox_execute` with a named environment for isolated work. It is ephemeral by default and returns bounded previews plus complete stdout/stderr artifacts. Use `sandbox_manage cleanup_orphans` after interrupted work.
4. Use `net_capture_start` with bounded duration, file size, and ring count, then `net_capture_stop` to obtain a PCAPNG artifact. Query it with the `net_*` tools.
5. Run `pe_triage` before specialist binary work. It reports PE metadata, imports/exports, resources, signatures, debug/CLR/Electron indicators, and routing hints.
6. Configure available worker models with `model_escalation_set` and call `model_escalation_decide` before waking a more expensive worker. It recommends a role; it does not invoke a model automatically.
7. Do not recursively search from a filesystem/drive root. Start in the task workspace or use an explicit narrow path; bounded search returns traversal-truncation metadata when its file or time cap is reached, and the next step is to narrow the path or glob rather than retry unchanged.
