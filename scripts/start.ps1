$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VenvPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$MobileIndex = Join-Path $ProjectRoot "mobile\dist\index.html"

if (-not (Test-Path -LiteralPath $VenvPython)) {
    throw "Development environment not found. Run .\scripts\setup.ps1 first."
}
if (-not (Test-Path -LiteralPath $MobileIndex)) {
    throw "Mobile build not found. Run .\scripts\setup.ps1 first."
}

Push-Location $ProjectRoot
try {
    & $VenvPython -m motionbridge.cli
} finally {
    Pop-Location
}

