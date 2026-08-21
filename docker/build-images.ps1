[CmdletBinding()]
param([string]$Tag = "latest")
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$profiles = @("linux-general", "linux-re", "web-testing", "fuzzing", "network-analysis", "android-tools")
foreach ($profile in $profiles) {
  $image = "dsw/$profile`:$Tag"
  docker build --file (Join-Path $root "docker\Dockerfile.$profile") --tag $image $root
  if ($LASTEXITCODE -ne 0) { throw "Failed to build $image" }
}
