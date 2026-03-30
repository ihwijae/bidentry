param(
  [switch]$SkipPlaywrightInstall
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

Write-Host "[1/8] Checking required tools..."
$required = @("node", "npm", "git")
foreach ($cmd in $required) {
  if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) {
    throw "Required command '$cmd' is not installed or not in PATH."
  }
}

Write-Host "[2/8] Installing root dependencies..."
if (Test-Path (Join-Path $root "package-lock.json")) {
  npm ci
} else {
  npm install
}

Write-Host "[3/8] Installing automation-engine dependencies (skip browser download)..."
$engineDir = Join-Path $root "automation-engine"
$env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1"
Push-Location $engineDir
if (Test-Path "package-lock.json") {
  npm ci
} else {
  npm install
}
Pop-Location
Remove-Item Env:PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD -ErrorAction SilentlyContinue

Write-Host "[4/8] Installing electron-app dependencies..."
$electronDir = Join-Path $root "electron-app"
Push-Location $electronDir
if (Test-Path "package-lock.json") {
  npm ci
} else {
  npm install
}
Pop-Location

Write-Host "[5/8] Restoring .env from .env.example (if needed)..."
$envPath = Join-Path $root ".env"
$envExample = Join-Path $root ".env.example"
if ((-not (Test-Path $envPath)) -and (Test-Path $envExample)) {
  Copy-Item $envExample $envPath
  Write-Host "Created .env from .env.example. Fill secrets manually."
}

Write-Host "[6/8] Optional Playwright browser install..."
if (-not $SkipPlaywrightInstall) {
  Push-Location $engineDir
  npx playwright install chromium
  Pop-Location
} else {
  Write-Host "Skipped browser install."
}

Write-Host "[7/8] Smoke test..."
npm run engine:demo

Write-Host "[8/8] Done. Next: npm run dev"
