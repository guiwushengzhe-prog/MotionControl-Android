$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ResearchSite = "F:\MotionControl\.venv-stgcn-cuda\Lib\site-packages"
$MMAction = "F:\MotionControl\MMAction2"
$env:PYTHONPATH = "$ResearchSite;$MMAction"
& (Join-Path $ProjectRoot "dist\MotionBridge-0.4.0-research-trial.exe")
