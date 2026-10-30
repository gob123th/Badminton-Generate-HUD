@echo off
rem Double-click to start the app on http://localhost:8765 (Windows)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -Port 8765
pause
