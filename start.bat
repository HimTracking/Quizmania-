@echo off
setlocal
cd /d "%~dp0"
echo ========================================
echo          QUIZARENA STARTER
echo ========================================
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or newer from https://nodejs.org/ and reopen this file.
  pause
  exit /b 1
)
if not exist .env (
  copy .env.example .env >nul
  echo Created .env from .env.example. Change credentials before public deployment.
)
echo Installing/checking required packages...
call npm install
if errorlevel 1 (
  echo Package installation failed. Check the error above.
  pause
  exit /b 1
)
echo Starting QuizArena...
echo Keep this window open while using the website.
echo Website: http://localhost:3000
echo Admin:   http://localhost:3000/admin
call npm start
pause
