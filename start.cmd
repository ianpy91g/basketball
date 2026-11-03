@echo off
cd /d "%~dp0"
python server.py --open-browser
if errorlevel 1 pause
