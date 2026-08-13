$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$driver = pnputil /enum-drivers 2>$null | Select-String -Pattern "vigembus.inf" -Context 0,3
if ($driver) {
    Write-Host "ViGEmBus driver found. MotionBridge already contains its user-mode Xbox client." -ForegroundColor Green
    $driver
    exit 0
}

Write-Host "ViGEmBus driver is not installed." -ForegroundColor Yellow
Write-Host "Install the signed driver intentionally from the official release page, reboot if requested, then restart MotionBridge:"
Write-Host "https://github.com/nefarius/ViGEmBus/releases"
