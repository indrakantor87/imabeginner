@echo off
cd /d "%~dp0"
echo ===============================
echo FBS Market Analyzer - Start Bot
echo ===============================
echo.
echo Mode bot dikunci ke: AUTO
echo (SNIPER dan PREDATOR_SCALP dikombinasikan otomatis oleh engine)
echo.

set BOT_MODE=AUTO
set NODE_ENV=production
title FBS Bot - AUTO
echo Menjalankan bot dengan mode AUTO ...
echo Tekan CTRL+C untuk menghentikan bot.
echo.

node index.js

pause
