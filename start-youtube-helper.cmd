@echo off
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
call npm run helper
pause
