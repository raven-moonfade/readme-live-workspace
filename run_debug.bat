@echo off
rem ReadMe — 调试启动（保留控制台窗口，能看到实时输出）
cd /d "%~dp0"
"%~dp0.venv\Scripts\python.exe" "%~dp0app.py"
pause
