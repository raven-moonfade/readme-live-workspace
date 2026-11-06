@echo off
rem ReadMe startup (no console; see logs\boot_error.log on failure)
cd /d "%~dp0"
if not exist "%~dp0.venv\Scripts\pythonw.exe" (
  echo Missing .venv. Initializing the runtime...
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1"
  if errorlevel 1 (
    echo Initialization failed. See the error above.
    pause
    exit /b 1
  )
)
start "" "%~dp0.venv\Scripts\pythonw.exe" "%~dp0app.py"
