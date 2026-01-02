param(
  [Parameter(Mandatory = $true)]
  [string]$Header,
  [Parameter(Mandatory = $true)]
  [string[]]$Symbols,
  [string]$OutPath = "dist_zig/__wm_cache/c_headers/probe_tmp.zig"
)

$template = Get-Content -Raw "debugScripts/cinfer/c_header_probe.zig"
$symbolLines = ($Symbols | ForEach-Object { "  `"$($_)`"," }) -join "`n"
$source = $template.Replace("{{HEADER}}", $Header).Replace("{{SYMBOLS}}", $symbolLines)

$outDir = Split-Path -Parent $OutPath
if ($outDir -and -not (Test-Path $outDir)) {
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
}

$source | Set-Content -Path $OutPath -Encoding utf8
zig run $OutPath
