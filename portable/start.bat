@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo [Error] Node.js not found. Install from: https://nodejs.org/
  pause
  exit /b 1
)
start "" http://localhost:8899
node serve.cjs
pause
