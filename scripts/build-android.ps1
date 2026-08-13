$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$MobileRoot = Join-Path $ProjectRoot "mobile"
$AndroidRoot = Join-Path $MobileRoot "android"
$SdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$ApkPath = Join-Path $AndroidRoot "app\build\outputs\apk\debug\app-debug.apk"

if (-not (Test-Path -LiteralPath $SdkRoot)) {
    throw "Android SDK not found at $SdkRoot. Install it through Android Studio first."
}

Push-Location $MobileRoot
try {
    npm run android:sync
    if ($LASTEXITCODE -ne 0) {
        throw "Android web sync failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

$env:ANDROID_HOME = $SdkRoot
$env:ANDROID_SDK_ROOT = $SdkRoot
$CachedGradle = Get-ChildItem "$env:USERPROFILE\.gradle\wrapper\dists\gradle-8.13-bin" -Recurse -Filter gradle.bat -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty FullName
$Gradle = if ($CachedGradle) { $CachedGradle } else { Join-Path $AndroidRoot "gradlew.bat" }

Push-Location $AndroidRoot
try {
    & $Gradle assembleDebug --no-daemon
    if ($LASTEXITCODE -ne 0) {
        throw "Gradle failed with exit code $LASTEXITCODE"
    }
} finally {
    Pop-Location
}

if (-not (Test-Path -LiteralPath $ApkPath)) {
    throw "Gradle finished without producing $ApkPath"
}
$Hash = Get-FileHash -LiteralPath $ApkPath -Algorithm SHA256
Write-Host "APK ready: $ApkPath" -ForegroundColor Green
Write-Host "SHA256: $($Hash.Hash)"
