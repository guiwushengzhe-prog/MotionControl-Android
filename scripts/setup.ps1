$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"

Write-Host "[1/3] Creating Python environment" -ForegroundColor Cyan
if (-not (Test-Path -LiteralPath $VenvPython)) {
    python -m venv (Join-Path $ProjectRoot ".venv")
}

Write-Host "[2/3] Installing desktop dependencies" -ForegroundColor Cyan
& $VenvPython -m pip install --upgrade pip -i "https://pypi.org/simple" --timeout 60 --retries 3
& $VenvPython -m pip install -e "${ProjectRoot}[dev]" -i "https://pypi.org/simple" --timeout 60 --retries 3

Write-Host "[3/3] Building mobile application" -ForegroundColor Cyan
Push-Location (Join-Path $ProjectRoot "mobile")
try {
    npm install
    npm run build
} finally {
    Pop-Location
}

Write-Host "Done. Run .\scripts\start.ps1" -ForegroundColor Green
Write-Host "Xbox output uses the bundled ViGEmClient and requires the ViGEmBus system driver; see docs\XBOX.md." -ForegroundColor Yellow
