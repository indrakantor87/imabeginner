@echo off
cd /d "%~dp0"
echo ===============================
echo SMART BOT - AUTO TRADING SYSTEM
echo ===============================
echo.
echo Mode: AUTO (Trend Follow + Predator)
echo.

:loop
echo [START] Menjalankan SMART BOT.exe...
"SMART BOT.exe"
echo.
echo ⚠️ Bot berhenti atau crash. Restarting otomatis dalam 5 detik...
timeout /t 5
goto loop
