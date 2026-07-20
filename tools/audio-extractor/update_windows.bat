@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1"
  exit /b %errorlevel%
)
".venv\Scripts\python.exe" -m pip install --upgrade --pre "yt-dlp[default]"
pause
