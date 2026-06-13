# Handoff — Codex-Style Tool Layer (Phase 1)

## Status: COMPLETE

## Summary

Added `functions.shell_command` as a model-visible alias for PowerShell execution with workspace-constrained `workdir` support. The existing `run_cmd` and `run_powershell` tools are unchanged.

Key design decisions:
- `runLocalCommand` and `maybeRunShellTool` gained an optional `cwd` parameter (defaulting to `process.cwd()`), so no behaviour change for existing callers.
- `functions.shell_command` resolves `workdir` through `assertInsideWorkspace`, enforcing the workspace boundary before any shell execution.
- Default timeout is 120 000 ms (vs 60 000 ms for legacy tools), matching the task spec example.
- `review` permission mode blocks the tool the same way it blocks `run_cmd` and `run_powershell`.
- `shouldRunToolsSequentially` includes `"functions.shell_command"` so interactive ask-mode prompts serialize correctly.

## Files touched

- `src/deepseek-watch.js` — `runLocalCommand`, `maybeRunShellTool`, `toolSchemas`, `runTool`, `shouldRunToolsSequentially`
- `prompts/default-system.md` — shell guidance line updated to mention `functions.shell_command`
- `README.md` — workspace tools table updated with new row

## Checks run

```
npm run check
```

Result: all source files passed `node --check` with no errors.

## Remaining risks

- No automated test suite; the tool path is exercised only at runtime.
- `workdir` defaults to `resolve(process.cwd())`, which is always inside the workspace when the process is launched from within it — but if the process CWD is outside the workspace root at startup the default would be blocked. Acceptable for current use patterns.
- `functions.shell_command` name contains a dot; some OpenAI-compatible endpoints may reject non-alphanumeric tool names. Verify against the target model/endpoint if issues arise.
