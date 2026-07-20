@echo off
cd /d "%~dp0"
if not exist ".venv\Scripts\pythonw.exe" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install_windows.ps1"
  exit /b %errorlevel%
)
start "" ".venv\Scripts\pythonw.exe" "app.py"
