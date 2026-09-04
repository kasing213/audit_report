@echo off
REM ============================================================
REM  Double-click this file to (re)start the outreach worker.
REM  Safe to run anytime: if it's already up, it just restarts it.
REM ============================================================
set "PM2_HOME=C:\Users\SH Computer\.pm2"

echo Starting outreach-worker under pm2...
call pm2 start "D:\audit-sales\scripts\telegram-worker\ecosystem.config.js"
call pm2 save
echo.
echo Current status:
call pm2 list
echo.
echo If "outreach-worker" shows status "online", it is back up.
pause
