# Codex Detached Workflow

This is the intended token-saving pattern:

```powershell
$content = @"
Write final notes for this task.
"@

deepseek-detached --stdin -o .\out\subagent-result.md --detach <<< $content
deepseek-wait .\out\subagent-result.md
```

PowerShell does not support Bash here-strings with `<<<`. Use a prompt file or pipeline instead:

```powershell
$content | deepseek-detached --stdin -o .\out\subagent-result.md --detach
deepseek-wait .\out\subagent-result.md
```

For large prompts, prefer a prompt file:

```powershell
Set-Content -Path .\out\prompt.txt -Value $content
deepseek-detached --prompt-file .\out\prompt.txt -o .\out\subagent-result.md --detach
deepseek-wait .\out\subagent-result.md
```

The wait command intentionally prints nothing. Codex only needs the exit code and the resulting Markdown file.
