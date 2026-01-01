# Workman Helix Extension Installer for Windows
# Run: .\install.ps1

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$HelixConfigDir = "$env:APPDATA\helix"
$HelixRuntimeDir = "$HelixConfigDir\runtime"
$QueriesDir = "$HelixRuntimeDir\queries\workman"

Write-Host "Workman Helix Extension Installer" -ForegroundColor Cyan
Write-Host "=================================" -ForegroundColor Cyan
Write-Host ""

# Create directories if they don't exist
Write-Host "[1/4] Creating directories..." -ForegroundColor Yellow
if (!(Test-Path $HelixConfigDir)) {
  New-Item -ItemType Directory -Path $HelixConfigDir -Force | Out-Null
  Write-Host "  Created: $HelixConfigDir"
}
if (!(Test-Path $QueriesDir)) {
  New-Item -ItemType Directory -Path $QueriesDir -Force | Out-Null
  Write-Host "  Created: $QueriesDir"
}

# Copy query files
Write-Host "[2/4] Copying query files..." -ForegroundColor Yellow
Copy-Item -Path "$ScriptDir\queries\workman\*" -Destination $QueriesDir -Force
Write-Host "  Copied highlights.scm, indents.scm, injections.scm"

# Append to languages.toml (or create if doesn't exist)
Write-Host "[3/4] Updating languages.toml..." -ForegroundColor Yellow
$LanguagesToml = "$HelixConfigDir\languages.toml"
$SourceToml = Get-Content "$ScriptDir\languages.toml" -Raw

if (Test-Path $LanguagesToml) {
  $ExistingContent = Get-Content $LanguagesToml -Raw
  if ($ExistingContent -match "name = `"workman`"") {
    Write-Host "  WARNING: Workman config already exists in languages.toml" -ForegroundColor Red
    Write-Host "  Please manually merge or remove the existing config first."
  }
  else {
    Add-Content -Path $LanguagesToml -Value "`n`n# ─────────────────────────────────────────────────────────────────────────────`n# Workman Language (auto-added by installer)`n# ─────────────────────────────────────────────────────────────────────────────`n"
    Add-Content -Path $LanguagesToml -Value $SourceToml
    Write-Host "  Appended Workman config to existing languages.toml"
  }
}
else {
  Copy-Item -Path "$ScriptDir\languages.toml" -Destination $LanguagesToml
  Write-Host "  Created new languages.toml"
}

# Fetch and build grammar
Write-Host "[4/4] Fetching and building Tree-sitter grammar..." -ForegroundColor Yellow

# Find hx executable
$hxPath = $null
try {
  $hxPath = (Get-Command hx -ErrorAction SilentlyContinue).Source
}
catch {}

if (-not $hxPath) {
  # Try common WinGet location
  $wingetHx = "$env:LOCALAPPDATA\Microsoft\WinGet\Links\hx.exe"
  if (Test-Path $wingetHx) {
    $hxPath = $wingetHx
  }
}

if ($hxPath) {
  Write-Host "  Found hx at: $hxPath"
  Write-Host "  Running: hx --grammar fetch"
  & $hxPath --grammar fetch
  Write-Host "  Running: hx --grammar build"
  & $hxPath --grammar build
}
else {
  Write-Host "  WARNING: 'hx' not found. Please run manually:" -ForegroundColor Red
  Write-Host "    hx --grammar fetch"
  Write-Host "    hx --grammar build"
}

Write-Host ""
Write-Host "Installation complete!" -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Cyan
Write-Host "  1. Restart Helix (changes to languages.toml require restart)"
Write-Host "  2. Open a .wm file to test"
Write-Host "  3. Run :lsp-restart if you need to reload the language server"
Write-Host ""
Write-Host "Config locations:" -ForegroundColor Cyan
Write-Host "  languages.toml: $LanguagesToml"
Write-Host "  queries:        $QueriesDir"
