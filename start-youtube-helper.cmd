@echo off
setlocal
cd /d "%~dp0"
if not exist "node_modules\youtubei.js" (
  echo Please run npm install in this folder first.
  pause
  exit /b 1
)
if not exist ".tools\yt-dlp.exe" (
  call npm run setup:youtube
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist "dist\index.html" (
  call npm run build
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Opening Melody Tab Home Server.
echo Click Start server, then Open website in the new window.
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\home-server.ps1"
exit /b 0
