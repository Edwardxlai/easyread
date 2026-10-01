@echo off
rem EasyRead launcher for Windows. First run creates .venv and installs; later runs just start.
setlocal
cd /d "%~dp0"
set PYTHONUTF8=1
if exist ".venv\Scripts\pythonw.exe" goto run

echo Setting up EasyRead (first run only, about a minute)...
where uv >nul 2>nul
if %errorlevel%==0 (
  uv venv .venv --python 3.12 || goto fail
  uv pip install --python .venv\Scripts\python.exe -e . || goto fail
  goto run
)
where py >nul 2>nul
if %errorlevel%==0 ( py -3 -m venv .venv ) else ( python -m venv .venv )
if not exist ".venv\Scripts\python.exe" goto nopython
".venv\Scripts\python.exe" -m pip install -q -e . || goto fail

:run
start "" ".venv\Scripts\pythonw.exe" -m easyread serve --open --exit-on-close
exit /b 0

:nopython
echo.
echo Python 3.10 or newer is required. Download it from https://www.python.org/downloads/
echo (tick "Add python.exe to PATH" during install), then double-click start.cmd again.
pause
exit /b 1

:fail
echo.
echo Setup failed. See the messages above.
pause
exit /b 1
