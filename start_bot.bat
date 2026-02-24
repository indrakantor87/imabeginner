@echo off
title FBS Market Analyzer - MT5 Direct Feed
cd /d "%~dp0"

:loop
cls
echo ===============================
echo FBS Market Analyzer - MT5 Direct Feed
echo ===============================
echo.
echo [INFO] Bot Mode: AUTO (Adaptive Sniper/Predator)
echo [INFO] Data Source: MT5 Terminal (8 Pairs)
echo [INFO] Status: Menunggu koneksi dari MT5...
echo.

set BOT_MODE=AUTO
set NODE_ENV=production

echo Menjalankan server Node.js...
echo Tekan CTRL+C dua kali untuk menghentikan bot sepenuhnya.
echo.

node index.js

echo.
echo [WARNING] Bot berhenti atau crash! Restarting dalam 5 detik...
timeout /t 5
goto loop
