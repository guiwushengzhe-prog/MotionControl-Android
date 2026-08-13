@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

set "PY=.venv-pc\Scripts\python.exe"
if not exist "%PY%" set "PY=python"

echo Running core regression tests...
"%PY%" -m pytest -q --ignore=tests/test_action_model_onnx.py --ignore=tests/test_vigem_driver.py
if errorlevel 1 (
  echo.
  echo [FAILED] Core regression tests failed.
  pause
  exit /b 1
)

echo.
echo [OK] Core regression tests passed.
pause
