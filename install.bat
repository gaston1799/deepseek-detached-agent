@echo off
:: Double-click launcher for install.ps1
:: Runs PowerShell with script execution allowed for this process only.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if %ERRORLEVEL% neq 0 (
  echo.
  echo   Installation failed. See errors above.
  pause
)
