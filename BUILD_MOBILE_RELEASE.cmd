@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

rem Builds the signed, non-debuggable APK for public release.
rem
rem BUILD_MOBILE_0.4.3.cmd runs assembleDebug, which is how the 2.0 candidate
rem ended up shipping with the Android debug key and android:debuggable=true.
rem Use this script for anything that leaves this machine.
rem
rem Requires mobile\android\keystore.properties -- see keystore.properties.example.
rem The build refuses to run without it rather than emitting an unsigned APK.

echo [1/5] Checking mobile TypeScript...
pushd "%~dp0mobile"
call npm run check
if errorlevel 1 (
  echo.
  echo [FAILED] npm run check
  popd
  pause
  exit /b 1
)

echo.
echo [2/5] Building web assets and syncing Capacitor Android...
call npm run android:sync
if errorlevel 1 (
  echo.
  echo [FAILED] npm run android:sync
  popd
  pause
  exit /b 1
)
popd

echo.
echo [3/5] Building signed release APK...
pushd "%~dp0mobile\android"
rem Explicit path: some environments set NoDefaultCurrentDirectoryInExePath,
rem which stops cmd finding a .bat in the working directory.
call "%~dp0mobile\android\gradlew.bat" assembleRelease
if errorlevel 1 (
  echo.
  echo [FAILED] gradlew.bat assembleRelease
  echo If it complained about keystore.properties, create it from
  echo mobile\android\keystore.properties.example first.
  popd
  pause
  exit /b 1
)
popd

set APK=mobile\android\app\build\outputs\apk\release\app-release.apk
if not exist "%APK%" (
  echo [FAILED] No release APK was produced.
  pause
  exit /b 1
)

echo.
echo [4/5] Verifying the signature is not the Android debug key...
for /f "delims=" %%B in ('dir /b /ad "%LOCALAPPDATA%\Android\Sdk\build-tools"') do set BT=%LOCALAPPDATA%\Android\Sdk\build-tools\%%B
if not exist "%BT%\apksigner.bat" (
  echo [WARN] apksigner not found; skipping the signature check.
  echo        Verify by hand before publishing.
) else (
  call "%BT%\apksigner.bat" verify --print-certs "%APK%" | findstr /C:"CN=Android Debug" >nul
  if not errorlevel 1 (
    echo.
    echo [FAILED] This APK is signed with the Android debug key. Do not publish it.
    echo          Check mobile\android\keystore.properties.
    pause
    exit /b 1
  )
  call "%BT%\apksigner.bat" verify --print-certs "%APK%"
)

echo.
echo [5/5] Copying APK to output...
if not exist output mkdir output
copy /Y "%APK%" "output\MotionControl-Android-2.0.0.apk" >nul
if errorlevel 1 (
  echo [FAILED] Could not copy APK.
  pause
  exit /b 1
)

echo.
echo [OK] Signed release APK:
echo %CD%\output\MotionControl-Android-2.0.0.apk
echo.
echo Keep the keystore backed up offline. Without it no future build can
echo update an installed copy of this app.
pause
