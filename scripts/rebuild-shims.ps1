[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$PSNativeCommandUseErrorActionPreference = $false

$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
  Write-Host "[dsw] Relinking global CLI shims from $repoRoot"
  npm link
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm link failed with exit code $code." }

  Write-Host "[dsw] Verifying syntax"
  npm run check
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run check failed with exit code $code." }

  Write-Host "[dsw] Verifying patch tools self-test"
  npm run test:patch
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:patch failed with exit code $code." }

  Write-Host "[dsw] Verifying security tools self-test"
  npm run test:security
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:security failed with exit code $code." }

  Write-Host "[dsw] Verifying TUI self-test"
  npm run test:tui
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:tui failed with exit code $code." }

  Write-Host "[dsw] Verifying history self-test"
  npm run test:history
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:history failed with exit code $code." }

  Write-Host "[dsw] Verifying multi-agent coordination self-test"
  npm run test:coordination
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:coordination failed with exit code $code." }

  Write-Host "[dsw] Verifying agent park/wake end-to-end self-test"
  npm run test:coordination:e2e
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:coordination:e2e failed with exit code $code." }

  Write-Host "[dsw] Verifying fetch-retry self-test"
  npm run test:retry
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:retry failed with exit code $code." }

  Write-Host "[dsw] Verifying agent-session binding self-test"
  npm run test:agent-session
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "npm run test:agent-session failed with exit code $code." }

  Write-Host "[dsw] Installing repo skills to $HOME\.codex\skills"
  $skillSrc = Join-Path $repoRoot "skills"
  $skillDst = Join-Path $HOME ".codex\skills"
  if (Test-Path $skillSrc) {
    New-Item -ItemType Directory -Path $skillDst -Force | Out-Null
    Get-ChildItem $skillSrc -Directory | ForEach-Object {
      $dstDir = Join-Path $skillDst $_.Name
      New-Item -ItemType Directory -Path $dstDir -Force | Out-Null
      Copy-Item (Join-Path $_.FullName "SKILL.md") (Join-Path $dstDir "SKILL.md") -Force
      Write-Host "  installed skill: $($_.Name)"
    }
  }

  Write-Host "[dsw] Verifying linked commands"
  dsw --help
  $code = $LASTEXITCODE
  if ($code -ne 0) { throw "dsw --help failed with exit code $code." }

  Write-Host "[dsw] Rebuild complete. Restart any running chat sessions to pick up harness changes."
}
finally {
  Pop-Location
}
