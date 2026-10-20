@echo off
setlocal
cd /d "%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass ^
  -File "%~dp0scripts\taskboard.ps1" -Action start

set "TASKBOARD_EXIT=%ERRORLEVEL%"
if not "%TASKBOARD_EXIT%"=="0" (
  echo.
  echo Taskboard failed to start. Review the message above and logs in .taskboard-runtime.
  pause
)
exit /b %TASKBOARD_EXIT%
