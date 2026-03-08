# Ensure provider node_modules exists and copy ws from repo root (fix MODULE_NOT_FOUND for ws)
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$provNm = Join-Path $root 'apps\provider\node_modules'
$wsTarget = Join-Path $root 'node_modules\ws'
$wsLink = Join-Path $provNm 'ws'

if (-not (Test-Path $provNm)) { New-Item -ItemType Directory -Path $provNm -Force | Out-Null }
if (-not (Test-Path $wsTarget)) {
  Write-Error "Root node_modules\ws not found at $wsTarget. Run npm install from repo root first."
  exit 1
}
if (Test-Path $wsLink) { Remove-Item $wsLink -Force -Recurse -ErrorAction SilentlyContinue }
# Симлинк требует прав администратора; используем копирование
Copy-Item -Path $wsTarget -Destination $wsLink -Recurse -Force
Write-Host "Copied ws to apps\provider\node_modules\ws"

if (Test-Path (Join-Path $wsLink 'package.json')) {
  Write-Host "Done. Restart the provider (e.g. npm run start:provider:dev)."
} else {
  Write-Host "ERROR: ws still missing at $wsLink. Ensure root node_modules/ws exists (npm install from repo root)."
  exit 1
}
