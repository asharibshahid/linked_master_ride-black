param(
  [switch]$SkipVerification
)

$ErrorActionPreference = "Stop"

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$dashboardRoot = Join-Path $repositoryRoot "dashboard"
$liveAlias = "ots-chat.vercel.app"

Push-Location $dashboardRoot
try {
  # Vercel writes progress to stderr even after a successful JSON deployment response.
  # cmd.exe keeps that progress stream out of PowerShell's native-command error pipeline.
  $rawDeployment = (& $env:ComSpec /d /c "vercel.cmd deploy --prod --yes --format json --no-color 2>nul" | Out-String).Trim()
  if ($LASTEXITCODE -ne 0) {
    throw "Vercel production deployment failed."
  }

  try {
    $deployment = $rawDeployment | ConvertFrom-Json
  } catch {
    throw "Vercel did not return deployment JSON; the live alias was not changed."
  }

  $deploymentUrl = [string]$deployment.url
  if (-not $deploymentUrl -and $deployment.deployment) {
    $deploymentUrl = [string]$deployment.deployment.url
  }
  if (-not $deploymentUrl -or $deploymentUrl -notmatch '^https://') {
    throw "Deployment URL was missing; the live alias was not changed."
  }

  & $env:ComSpec /d /c "vercel.cmd alias set $deploymentUrl $liveAlias --no-color 2>nul"
  if ($LASTEXITCODE -ne 0) {
    throw "The production deployment succeeded, but moving $liveAlias failed."
  }
} finally {
  Pop-Location
}

if (-not $SkipVerification) {
  $response = Invoke-WebRequest -Uri "https://$liveAlias/" -UseBasicParsing
  if ($response.StatusCode -ne 200 -or $response.Content -notmatch '<title>ACE OTS Supplier</title>') {
    throw "$liveAlias did not return the expected dashboard after aliasing."
  }

  $app = Invoke-WebRequest -Uri "https://$liveAlias/app.js" -UseBasicParsing
  if ($app.Headers["Cache-Control"] -notmatch 'no-store') {
    throw "$liveAlias app.js is missing the required no-store cache policy."
  }
  foreach ($asset in @(@("index.html", $response), @("app.js", $app))) {
    $localHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $dashboardRoot $asset[0])).Hash
    $remoteBytes = [Text.Encoding]::UTF8.GetBytes([string]$asset[1].Content)
    $remoteHash = (Get-FileHash -Algorithm SHA256 -InputStream ([IO.MemoryStream]::new($remoteBytes))).Hash
    if ($localHash -ne $remoteHash) {
      throw "$liveAlias is serving a different $($asset[0]) than the deployed release."
    }
  }
}

Write-Host "Dashboard deployed and $liveAlias now points to $deploymentUrl"
