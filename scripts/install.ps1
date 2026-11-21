$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:PANDAWA_REPO) { $env:PANDAWA_REPO } else { "https://github.com/be-yourself-never-surrender/pandawa.git" }
$InstallDir = if ($env:PANDAWA_DIR) { $env:PANDAWA_DIR } else { Join-Path $env:USERPROFILE ".pandawa" }
$Port = if ($env:PANDAWA_PORT) { $env:PANDAWA_PORT } else { "7777" }

Write-Host ""
Write-Host "  Pandawa - Visual Agentic Team & Layered Brain Platform Installer" -ForegroundColor Yellow
Write-Host "  ----------------------------------------------------------------" -ForegroundColor DarkGray

if (!(Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "git is required. Install Git for Windows first."
  exit 1
}
if (!(Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "Node.js 22+ (recommended v24) is required. Install from https://nodejs.org/"
  exit 1
}

if (Test-Path (Join-Path $InstallDir ".git")) {
  Write-Host "-> Updating existing Pandawa installation at $InstallDir..." -ForegroundColor Cyan
  git -C $InstallDir pull --ff-only
} else {
  Write-Host "-> Cloning Pandawa into $InstallDir..." -ForegroundColor Cyan
  git clone --depth 1 $RepoUrl $InstallDir
}

Push-Location $InstallDir
try {
  Write-Host "-> Installing backend & Web Studio dependencies..." -ForegroundColor Cyan
  npm install --no-audit --no-fund
  npm --prefix web install --no-audit --no-fund

  Write-Host "-> Building Pandawa..." -ForegroundColor Cyan
  npm run build
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "  Pandawa installed successfully!" -ForegroundColor Green
Write-Host "  Run Web Studio : cd $InstallDir; `$env:PANDAWA_PORT=$Port; npm start"
Write-Host "  Open Browser   : http://localhost:$Port (default password: 11111111)"
Write-Host "  Run CLI        : node $InstallDir\dist\server\cli.js chat"
Write-Host ""
