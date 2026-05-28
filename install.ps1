<#
.SYNOPSIS
  Installs deepseek-detached-agent (commands: dsw, d, dsd, dswait) globally.

.DESCRIPTION
  Checks for Git and Node.js >= 18, installs missing deps via winget,
  refreshes PATH, then clones the repo (or reuses the current directory)
  and runs npm install -g.

.PARAMETER RepoUrl
  Git clone URL. Defaults to the placeholder below — update before distributing.

.PARAMETER Branch
  Branch to clone. Default: main.

.PARAMETER InstallDir
  Where to clone if not running from inside the repo.
  Default: %LOCALAPPDATA%\deepseek-detached-agent

.EXAMPLE
  # Run from outside the repo (downloads and installs):
  irm https://raw.githubusercontent.com/OWNER/REPO/main/install.ps1 | iex

  # Run from inside the repo (installs current working tree):
  .\install.ps1
#>
[CmdletBinding()]
param(
  [string]$RepoUrl    = "https://github.com/gaston1799/deepseek-detached-agent",
  [string]$Branch     = "main",
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA "deepseek-detached-agent")
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── colours ──────────────────────────────────────────────────────────────────

function Write-Banner {
  Write-Host ""
  Write-Host "  deepseek-detached-agent installer" -ForegroundColor Cyan
  Write-Host "  $(('─' * 36))" -ForegroundColor DarkGray
  Write-Host ""
}

function Write-Step { param([string]$msg) Write-Host "  ▸ $msg" -ForegroundColor Cyan }
function Write-Ok   { param([string]$msg) Write-Host "  ✓ $msg" -ForegroundColor Green }
function Write-Warn { param([string]$msg) Write-Host "  ! $msg" -ForegroundColor Yellow }
function Write-Fail {
  param([string]$msg)
  Write-Host "  ✕ $msg" -ForegroundColor Red
  Write-Host ""
  exit 1
}

# ── helpers ───────────────────────────────────────────────────────────────────

function Test-Command {
  param([string]$Name)
  return $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Invoke-Refresh-Path {
  $machine = [System.Environment]::GetEnvironmentVariable("PATH", "Machine")
  $user    = [System.Environment]::GetEnvironmentVariable("PATH", "User")
  $env:PATH = "$machine;$user"
}

function Get-NodeMajor {
  try {
    $ver = & node --version 2>$null
    if ($ver -match '^v(\d+)') { return [int]$Matches[1] }
  } catch {}
  return 0
}

function Invoke-Winget-Install {
  param([string]$Id, [string]$Label)
  Write-Step "Installing $Label via winget..."
  $result = winget install `
    --id    $Id `
    --silent `
    --accept-package-agreements `
    --accept-source-agreements `
    2>&1
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335212) {
    # -1978335212 = APPINSTALLER_ERROR_ALREADY_INSTALLED (treat as success)
    Write-Warn "winget exited $LASTEXITCODE — check output above."
  }
  Invoke-Refresh-Path
}

# ── main ─────────────────────────────────────────────────────────────────────

Write-Banner

# winget availability
Write-Step "Checking winget..."
if (-not (Test-Command "winget")) {
  Write-Warn "winget not found."
  Write-Warn "Install 'App Installer' from the Microsoft Store and re-run."
  Write-Fail "winget is required to auto-install dependencies."
}
Write-Ok "winget found."

# ── Node.js ──────────────────────────────────────────────────────────────────

Write-Step "Checking Node.js >= 18..."
$nodeMajor = Get-NodeMajor
if ($nodeMajor -ge 18) {
  Write-Ok "Node.js v$nodeMajor found — $(& node --version)."
} else {
  if ($nodeMajor -gt 0) {
    Write-Warn "Node.js v$nodeMajor is too old (need >= 18). Upgrading..."
  }
  Invoke-Winget-Install "OpenJS.NodeJS.LTS" "Node.js LTS"
  $nodeMajor = Get-NodeMajor
  if ($nodeMajor -lt 18) {
    Write-Fail "Node.js install failed. Install manually from https://nodejs.org then re-run."
  }
  Write-Ok "Node.js $(& node --version) installed."
}

# ── Git ───────────────────────────────────────────────────────────────────────

Write-Step "Checking Git..."
if (Test-Command "git") {
  Write-Ok "Git found — $(& git --version)."
} else {
  Invoke-Winget-Install "Git.Git" "Git"
  Invoke-Refresh-Path   # git may update PATH differently from node
  if (-not (Test-Command "git")) {
    Write-Fail "Git install failed. Install manually from https://git-scm.com then re-run."
  }
  Write-Ok "Git installed — $(& git --version)."
}

# ── source directory ──────────────────────────────────────────────────────────

$repoDir = $null

if (Test-Path (Join-Path (Get-Location) ".git")) {
  Write-Ok "Running from inside the repo — using current directory."
  $repoDir = (Get-Location).Path
} elseif (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Step "Updating existing clone at $InstallDir..."
  Set-Location $InstallDir
  & git pull --ff-only
  if ($LASTEXITCODE -ne 0) { Write-Fail "git pull failed." }
  $repoDir = $InstallDir
} else {
  Write-Step "Cloning $RepoUrl ($Branch) to $InstallDir..."
  & git clone --branch $Branch --depth 1 $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Write-Fail "git clone failed." }
  $repoDir = $InstallDir
  Write-Ok "Cloned."
}

Set-Location $repoDir

# ── global install ────────────────────────────────────────────────────────────

Write-Step "Running npm install -g ..."
& npm install -g .
if ($LASTEXITCODE -ne 0) { Write-Fail "npm install -g failed." }
Invoke-Refresh-Path

# ── verify ────────────────────────────────────────────────────────────────────

Write-Host ""
if (Test-Command "dsw") {
  Write-Ok "dsw is on PATH.  Run: dsw --help"
  Write-Ok "'d' short alias is also available."
} else {
  Write-Warn "dsw not found on PATH yet."
  $npmBin = & npm bin -g 2>$null
  Write-Warn "npm global bin: $npmBin"
  Write-Warn "Add it to your PATH or restart your terminal, then run: dsw --help"
}

Write-Host ""
Write-Host "  Set your API key:  dsw config set-key <your-deepseek-key>" -ForegroundColor DarkGray
Write-Host ""
