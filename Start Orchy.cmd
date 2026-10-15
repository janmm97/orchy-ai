@echo off
rem Double-click to start Orchy. The dashboard opens at http://localhost:8008 (PORT in .env).
cd /d "%~dp0"
title Orchy
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Orchy needs Node.js 20 or newer, and it isn't installed yet.
  echo   Get it from https://nodejs.org , then double-click this file again.
  echo.
  pause
  exit /b 1
)
rem Setup is safe to repeat: installs packages once, creates .env, checks the CLIs, asks about Voice and Jev the first time.
node scripts\setup.mjs --no-start
if errorlevel 1 (
  echo.
  echo   Fix the item above, then double-click this file again.
  pause
  exit /b 1
)
node orchestrator\server.mjs
rem Only keep the window open when there's an error to read; "already running" and Ctrl+C close it.
if errorlevel 1 pause
