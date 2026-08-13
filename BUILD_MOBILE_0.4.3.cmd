@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

echo [1/4] Checking mobile TypeScript...
pushd mobile
call npm run check
if errorlevel 1 (
  echo.
  echo [FAILED] npm run check
  popd
  pause
  exit /b 1
)

echo.
echo [2/4] Building web assets and syncing Capacitor Android...
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
echo [3/4] Building Android debug APK...
pushd mobile\android
call gradlew.bat assembleDebug
if errorlevel 1 (
  echo.
  echo [FAILED] gradlew.bat assembleDebug
  popd
  pause
  exit /b 1
)
popd

echo.
echo [4/4] Copying APK to output...
if not exist output mkdir output
copy /Y "mobile\android\app\build\outputs\apk\debug\app-debug.apk" "output\MotionBridge-Mobile-0.4.3-debug.apk" >nul
if errorlevel 1 (
  echo [FAILED] Could not copy APK.
  pause
  exit /b 1
)

echo.
echo [OK] APK:
echo %CD%\output\MotionBridge-Mobile-0.4.3-debug.apk
echo.
echo Do not use the old APK that was already present before this rebuild.
pause
