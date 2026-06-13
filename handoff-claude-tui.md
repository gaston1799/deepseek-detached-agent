# Handoff — Stabilize Windows TUI Input

**Status: COMPLETE**

## Summary

Rewrote the interactive input flow in `src/deepseek-watch.js` to eliminate all `setRawMode` usage from the menu and streaming phases. The root cause of the "second prompt frozen" bug was raw mode being enabled in `streamChat` for Esc-interrupt detection and never fully releasing stdin before the next `readline` call.

### Changes made

1. **Import**: Changed `node:readline/promises` → `node:readline` to use the callback API.

2. **`promptLine`**: Rewrote using callback-based `readline.question()` with an explicit `rl.on("SIGINT", ...)` handler that calls `process.exit(0)`, so Ctrl+C exits cleanly from any prompt state.

3. **`pickMenu`** (raw-mode arrow-key menu → numbered readline menu): No `setRawMode` used. Displays numbered choices; accepts `1`–`N` or `q`/empty to quit. Returns the same `"quit"` / item-id values callers already expected.

4. **`pickDashboardAction`**: Updated hint text to match the numbered menu UX.

5. **`renderSessionPicker`** and **`renderDashboard`**: Removed (dead code; only used by the raw-mode menu implementation).

6. **`pickSession`** (raw-mode arrow-key → numbered readline list): Same approach as `pickMenu`. Lists sessions by `sessionLabel`, accepts a number or `q` to cancel.

7. **`streamChat`**: Removed the Esc-interrupt raw-mode block (`let interrupted`, `let cleanupInterrupt`, `stdin.setRawMode(true/false)`, `stdin.pause()`). Removed the drain loop (`while (process.stdin.read() !== null) {}`). Simplified to `try { … } finally { clearTimeout(timer); }`.

8. **Interactive while loop**: Replaced the `❯` prompt (E2 9D AF, garbled on Windows CP850/CP437) with `>`. Replaced `·` hint separator with plain text.

## Files touched

- `src/deepseek-watch.js`

## Checks run

```
npm run check          → all source files parse cleanly
node src/deepseek-watch.js --help          → usage printed correctly
node src/deepseek-watch.js --print-system --system "test {{context}}"  → context rendered correctly
```

All three pass.

## Manual test notes / limitations

- Non-interactive path (`-p prompt`, `--prompt-file`, `--stdin`) is unchanged.
- The arrow-key TUI menus are replaced by numbered menus. This is intentional per the task spec ("prefer simpler numbered menu if that avoids raw-mode bugs").
- Esc-to-interrupt during streaming is removed. Ctrl+C now exits the process cleanly since no raw mode intercepts SIGINT.
- The `❯` → `>` change also fixes garbled output on Windows terminals with non-UTF-8 codepages.

## Remaining risks

- `askYesNo` still uses direct `process.stdin.once("data")` for y/N prompts. This is safe because it is only called during tool execution (between API calls, with no readline interface active). If a future refactor calls it during an active readline session, it would need to be converted.
- Session `renderChatHistory` uses `\x1b[2J\x1b[H` (clear screen) which works in CMD but may behave differently in some embedded terminals.
