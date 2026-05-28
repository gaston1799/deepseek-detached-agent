# dsw — DeepSeek Watch

> Interactive DeepSeek coding agent for the terminal. Streams thinking, calls tools, reads and edits files, runs shell commands — with session memory and permission controls.

[![Node.js ≥ 18](https://img.shields.io/badge/node-%3E%3D18-brightgreen)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-lightgrey)]()

---

## Features

- **Extended thinking** — streams DeepSeek's reasoning chain live as it works
- **File tools** — read by line range, write new files, patch existing ones
- **Shell tools** — run `cmd.exe` and PowerShell with per-session permission controls
- **Session memory** — every conversation is saved; resume any previous session
- **Unlimited tool turns** — no cap on how many tool-call loops it can make
- **Detached mode** — fire a prompt in the background and poll for the output file
- **Claude fallback** — `dsd` falls back to `claude -p` if DeepSeek is unavailable
- **Zero npm dependencies** — pure Node.js (`fetch`, `fs/promises`, `child_process`)
- **OpenAI-compatible** — point at any compatible endpoint via `--base-url`

---

## Install

### Windows — one-liner

```powershell
irm https://raw.githubusercontent.com/gaston1799/deepseek-detached-agent/main/install.ps1 | iex
```

Or download [`install.bat`](install.bat) and double-click it.

The installer checks for **Git** and **Node.js ≥ 18**, installs any missing deps via `winget`, refreshes `PATH`, clones the repo, then runs `npm install -g`.

### Manual

```bash
git clone https://github.com/gaston1799/deepseek-detached-agent
cd deepseek-detached-agent
npm install -g .
```

---

## Quick start

```bash
# Save your API key once
dsw config set-key sk-xxxxxxxxxxxxxxxx

# Ask a question
dsw -p "explain this codebase"

# Open the TUI dashboard (no args)
dsw

# Resume a previous session
dsw --resume
```

---

## Commands

| Command | Alias | Description |
|---------|-------|-------------|
| `dsw` | `d` | Interactive agent — streams thinking, calls tools, saves sessions |
| `dsd` | — | Fire-and-forget: prompt → Markdown file, optional Claude fallback |
| `dswait` | — | Poll until a detached output file appears |

---

## Permission levels

| Level | What DeepSeek can do |
|-------|----------------------|
| `review` | Read files and list directories only |
| `ask` *(default)* | Same + prompts before writing files or running shell commands |
| `full` | All tools run automatically without prompting |

```bash
dsw --permission review -p "audit the auth module"
dsw --permission full   -p "refactor utils.js to use ES modules"
```

---

## Workspace tools

| Tool | Permissions | Description |
|------|-------------|-------------|
| `get_runtime_context` | all | OS, shell, Node version, git branch, date |
| `list_workspace_files` | all | List files and directories |
| `read_text_file` | all | Read a file by **line range** or byte offset |
| `write_text_file` | ask, full | Create or overwrite a file |
| `patch_text_file` | ask, full | Exact search-and-replace in a file |
| `run_cmd` | ask, full | Run a `cmd.exe` command |
| `run_powershell` | ask, full | Run a PowerShell command |

### Reading by line range

DeepSeek can target specific lines without loading the whole file:

```
read lines 40–80 of src/auth.js
```

Internally: `read_text_file { "path": "src/auth.js", "start_line": 40, "end_line": 80 }`

### Patching files

DeepSeek sends the exact text to replace and its replacement. In `ask` mode you see the preview and confirm before the change is written.

---

## dsw options

```
  -p, --prompt <text>              Prompt text
  --prompt-file <file>             Read prompt from file
  --stdin                          Read prompt from stdin
  --system <text>                  Override system prompt
  --system-file <file>             System prompt file (default: prompts/default-system.md)
  --print-system                   Print rendered system prompt and exit
  --model <name>                   Model (default: deepseek-v4-flash)
  --base-url <url>                 OpenAI-compatible base URL (default: https://api.deepseek.com)
  --effort <high|max>              Reasoning effort (default: high)
  --thinking <enabled|disabled>    Thinking toggle (default: enabled)
  --max-tokens <n>                 Max output tokens (default: 8192)
  --timeout <ms>                   Per-turn timeout ms (default: 600000)
  --max-tool-turns <n>             Cap tool-call loops (default: unlimited)
  --tool-mode <parallel|sequential>
                                   parallel = concurrent tool calls (default)
                                   sequential = run in order
  --permission <review|ask|full>   Session permission level
  --session <file>                 Session JSON file
  --resume                         Resume from --session or pick from list
  --no-save-session                Don't persist session to disk
  --dangerously-auto-run-commands  Auto-approve all commands and file writes
  --no-tools                       Disable all workspace tools
  --no-color                       Disable ANSI colors
  -h, --help                       Show help
```

---

## dsd — detached runner

```bash
# Foreground — writes result to out.md when done
dsd -p "summarise the last 10 commits" -o out.md

# Background — exits immediately, worker runs detached
dsd -p "..." -o out.md --detach
dswait out.md --timeout 120000   # wait up to 2 min
```

```
  -p, --prompt <text>
  --prompt-file <file>
  --stdin
  -o, --output <file>         Output Markdown file (default: deepseek-result.md)
  --model / --base-url / --effort / --thinking / --max-tokens / --timeout
  --detach                    Spawn background worker and exit
  --no-fallback               Don't fall back to claude -p on error
  --claude-cmd <cmd>          Claude CLI path (default: CLAUDE_CMD or claude)
```

---

## Configuration

```bash
dsw config set-key <key>   # save to %APPDATA%\deepseek-detached-agent\config.json
dsw config path            # show config file location
```

Environment variables (take priority over saved config):

```env
DEEPSEEK_API_KEY=sk-...
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_BASE_URL=https://api.deepseek.com
CLAUDE_CMD=claude
NO_COLOR=1
```

---

## Session memory

Sessions are saved to `.deepseek-watch/sessions/` in the working directory.

```bash
dsw --resume                        # arrow-key picker, sorted by last used
dsw --session path/to/session.json  # explicit file
dsw --no-save-session               # ephemeral — nothing written
```

---

## Troubleshooting

| Error | Cause | Fix |
|-------|-------|-----|
| `HTTP 401: Authentication Fails` | Invalid API key | `dsw config set-key sk-...` |
| `HTTP 402: Insufficient Balance` | Account needs credit | Top up on DeepSeek Platform |
| `No DeepSeek API key found` | No key set | Set `DEEPSEEK_API_KEY` or run `dsw config set-key` |

---

## License

MIT © 2026 [gaston1799](https://github.com/gaston1799)
