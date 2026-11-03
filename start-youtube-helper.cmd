@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Please install Node.js, then open this file again.
  pause
  exit /b 1
)
if not exist "node_modules\youtubei.js" (
  call npm install
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
if not exist ".tools\yt-dlp.exe" (
  call npm run setup:youtube
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
echo Preparing Melody Tab...
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)
echo Opening Melody Tab Home Server.
echo The helper will start without opening a browser.
echo Click Open website when you want to open Melody Tab on GitHub Pages.
start "" powershell.exe -NoProfile -STA -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0scripts\home-server.ps1" -StartServer
exit /b 0
