# Changelog

## 0.2.0 - 2026-08-21

This checkpoint adds the bounded research and sandbox foundation.

- Added DeepSeek and GLM provider configuration, including dynamic model context limits and automatic compaction thresholds.
- Added bounded code search with match limits, pagination, minified-file detection, snippets, offsets, and artifact-backed raw results.
- Added task workspaces and artifact listing, range retrieval, and bounded search.
- Added named Docker sandbox profiles and a unified sandbox execution/lifecycle interface.
- Added task scope state, hypothesis tracking, viability decisions, and ROI records.
- Added first-pass PE triage and structured TShark-backed PCAP queries.
- Added coordinator-aware prompt guidance and stricter tool-call/PowerShell reliability rules.
- Added focused self-tests and included the new modules in the project check script.

The Docker profiles and specialist analysis interfaces are foundational in this release; images and integrations that require external tools are not represented as fully live-tested production workflows yet.
