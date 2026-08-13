$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$PcPython = Join-Path $ProjectRoot ".venv-pc\Scripts\python.exe"
$DefaultPython = Join-Path $ProjectRoot ".venv\Scripts\python.exe"
$VenvPython = if (Test-Path -LiteralPath $PcPython) { $PcPython } else { $DefaultPython }
$StagingDist = Join-Path $ProjectRoot "build\release-pc"
$StagingWork = Join-Path $ProjectRoot "build\motionbridge-release"
$StagingExe = Join-Path $StagingDist "MotionBridge.exe"
$ExePath = Join-Path $ProjectRoot "dist\MotionBridge-0.3.0-lab-mvp.exe"

if (-not (Test-Path -LiteralPath $VenvPython)) {
    throw "Run .\scripts\setup.ps1 first."
}

& $VenvPython -m pip install -e "${ProjectRoot}[package]" -i "https://pypi.org/simple" --timeout 60 --retries 3
if ($LASTEXITCODE -ne 0) {
    throw "Dependency installation failed with exit code $LASTEXITCODE"
}

Push-Location $ProjectRoot
try {
    & $VenvPython -m PyInstaller --noconfirm --clean --distpath $StagingDist --workpath $StagingWork motionbridge.spec
    if ($LASTEXITCODE -ne 0) {
        throw "PyInstaller failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $StagingExe)) {
    throw "PyInstaller finished without producing $StagingExe"
}
Copy-Item -LiteralPath $StagingExe -Destination $ExePath -Force
$Hash = Get-FileHash -LiteralPath $ExePath -Algorithm SHA256
Write-Host "Windows app ready: $ExePath" -ForegroundColor Green
Write-Host "SHA256: $($Hash.Hash)"
