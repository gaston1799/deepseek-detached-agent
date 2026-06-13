# Claude Handoff - Stabilize Windows TUI Input

current_phase: phase-3-tui-input-rewrite

prompt_file: task.md

output_file: handoff-claude-tui.md

log_file: logs/claude-tui.log

allowed_scope:
- `src/deepseek-watch.js`
- `README.md` only if CLI behavior docs need a small update

forbidden_scope:
- Do not edit `.git/`.
- Do not edit smoke fixture files.
- Do not change tool schemas or tool implementations except if strictly required for terminal input flow.
- Do not change API request behavior.
- Do not add npm dependencies unless blocked and clearly justified.

## Problem

The interactive dashboard/TUI is unstable on Windows CMD after the first prompt. The app can leave stdin in an unusable state where the second prompt `❯` appears but typed input, Enter, Esc, and Ctrl+C do not behave correctly.

Observed user report:

```text
after first prompt it sends ❯ where i can type but nothing works ctrl+c doesnt work esc doesnt work either
```

## Node Terminal Guidance To Follow

Use Node's built-in terminal primitives conservatively:

- Official Node TTY docs say raw mode changes input so characters are available one by one and terminal special processing is disabled. Raw mode must be turned off reliably after menu navigation.
- Official Node readline docs say readline interfaces keep the process waiting for input until closed, and Ctrl+C should emit `SIGINT`/close behavior through readline unless overridden.
- Avoid mixing raw-mode menu key handling and readline prompts without a cleanup boundary.
- A robust Windows CMD path is acceptable even if it is less fancy than a full TUI.

References:
- https://nodejs.org/api/tty.html
- https://nodejs.org/api/readline.html

## Task

Rewrite the interactive input flow to be robust on Windows CMD/PowerShell:

1. Keep non-interactive command usage working:
   - `d -p "prompt"`
   - `dsw -p "prompt"`
   - `--prompt-file`
   - `--stdin`

2. For no-arg interactive mode:
   - It may keep arrow-key menus only if raw mode cleanup is provably safe.
   - Prefer a simpler numbered menu if that avoids raw-mode bugs.
   - `Ctrl+C` must exit cleanly from menu and prompt states.
   - `/exit`, `/quit`, and `/end` must exit from the follow-up prompt.
   - After each assistant turn, the follow-up prompt must accept normal text and Enter.

3. Terminal state safety:
   - Add helper(s) to reset stdin state before and after raw-mode menu use.
   - Avoid draining readable data in a way that can eat user input for the next prompt.
   - Ensure readline instances are closed in `finally`.
   - Add a process-level SIGINT handler only if it improves cleanup without breaking readline.

4. Keep behavior understandable:
   - If switching to numbered menus, keep labels clear.
   - Do not over-engineer a full curses UI.

## Checks

Run:

```powershell
npm run check
node src/deepseek-watch.js --help
node src/deepseek-watch.js --print-system --system "test {{context}}"
```

If practical, also run a quick manual non-interactive smoke:

```powershell
node src/deepseek-watch.js -p "hi" --no-tools --max-tool-turns 0
```

Only run that last command if a DeepSeek API key is configured and it will not block.

## Output Contract

Create `handoff-claude-tui.md` only after all work and checks are complete.

If blocked, still create `handoff-claude-tui.md` with:
- Status: BLOCKED
- Reason
- Files touched
- Checks run
- Next action

If complete, create `handoff-claude-tui.md` with:
- Status: COMPLETE
- Summary
- Files touched
- Checks run
- Manual test notes or limitations
- Remaining risks
