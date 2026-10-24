@echo off
title Data Cleaner
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is required. Install it from https://nodejs.org & pause & exit /b 1)
start "" http://localhost:4321
node server.js
