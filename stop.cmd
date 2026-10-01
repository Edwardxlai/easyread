@echo off
rem Stop only this EasyRead service, without closing unrelated Python programs.
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
if not exist ".venv\Scripts\python.exe" (
  echo EasyRead is not installed in this folder.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" -m easyread stop
if errorlevel 1 pause
