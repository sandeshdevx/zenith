@echo off
title Zenith Windows Installer
color 0B
cls

echo.
echo  ████████╗███████╗███╗   ██╗██╗████████╗██╗  ██╗
echo  ╚══███╔╝██╔════╝████╗  ██║██║╚══███╔══╝██║  ██║
echo    ███╔╝ █████╗  ██╔██╗ ██║██║   ███║   ███████║
echo   ███╔╝  ██╔══╝  ██║╚██╗██║██║   ███║   ██╔══██║
echo  ███████╗███████╗██║ ╚████║██║   ███║   ██║  ██║
echo  ╚══════╝╚══════╝╚═╝  ╚═══╝╚═╝   ╚══╝   ╚═╝  ╚══╝
echo.
echo  Zenith — One-Click Windows Setup
echo  ════════════════════════════════════════════════════
echo.

set "ROOT=%~dp0"
cd /d "%ROOT%"

rem ── Check for Administrator (needed for some operations) ──────────────────────
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo  WARNING: Not running as Administrator.
    echo  Some operations may fail. Re-run as Administrator for best results.
    echo.
)

rem ── Step 1: Check Node.js ────────────────────────────────────────────────────
echo  [1/7] Checking Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo  ✗ Node.js not found!
    echo  Please install Node.js 20+ from https://nodejs.org
    echo  Then re-run this installer.
    pause
    exit /b 1
)
for /f "tokens=1" %%v in ('node --version') do set NODE_VER=%%v
echo  ✓ Node.js %NODE_VER% found

rem ── Step 2: Check/Install Ollama ─────────────────────────────────────────────
echo.
echo  [2/7] Checking Ollama...
where ollama >nul 2>&1
if errorlevel 1 (
    echo  Ollama not found. Downloading installer...
    powershell -Command "Invoke-WebRequest -Uri 'https://ollama.com/download/OllamaSetup.exe' -OutFile '%TEMP%\OllamaSetup.exe'"
    echo  Installing Ollama (silent)...
    start /wait "" "%TEMP%\OllamaSetup.exe" /S
    echo  Ollama installed. Starting service...
    ollama serve >nul 2>&1 &
    timeout /t 5 /nobreak >nul
) else (
    echo  ✓ Ollama found
)

rem Pull required models
echo  Pulling AI models (this may take a few minutes on first run)...
ollama pull llama3.2:3b
ollama pull nomic-embed-text
echo  ✓ Models ready

rem ── Step 3: PostgreSQL (Portable) ────────────────────────────────────────────
echo.
echo  [3/7] Initializing portable PostgreSQL...
powershell -ExecutionPolicy Bypass -File "%ROOT%infra\scripts\db.ps1" init
echo  ✓ PostgreSQL initialized

rem ── Step 4: Python + STT Sidecar Dependencies ────────────────────────────────
echo.
echo  [4/7] Setting up Python virtual environment for STT sidecar...
if not exist "%ROOT%services\inference\.venv" (
    python -m venv "%ROOT%services\inference\.venv"
    echo  ✓ Virtual environment created
) else (
    echo  ✓ Virtual environment exists
)

echo  Installing STT dependencies (faster-whisper, edge-tts, etc.)...
"%ROOT%services\inference\.venv\Scripts\pip.exe" install --upgrade pip >nul 2>&1
"%ROOT%services\inference\.venv\Scripts\pip.exe" install -r "%ROOT%services\inference\requirements.txt"
echo  ✓ STT dependencies installed

rem ── Step 5: Node Dependencies ────────────────────────────────────────────────
echo.
echo  [5/7] Installing Node.js dependencies (npm install)...
npm install
echo  ✓ Node dependencies installed

rem ── Step 6: Environment File ─────────────────────────────────────────────────
echo.
echo  [6/7] Setting up environment configuration...
if not exist "%ROOT%.env" (
    copy "%ROOT%.env.example" "%ROOT%.env" >nul
    echo  ✓ Created .env from .env.example
    echo.
    echo  ⚠ IMPORTANT: Edit .env and set a secure SESSION_TOKEN_SECRET
    echo     Generate one with: openssl rand -base64 32
    echo     Or use PowerShell: [Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
) else (
    echo  ✓ .env already exists
)

rem ── Step 7: Database Migration ───────────────────────────────────────────────
echo.
echo  [7/7] Running database migrations...
call npm run db:start --prefix "%ROOT%" >nul 2>&1
timeout /t 3 /nobreak >nul
npm run migrate
echo  ✓ Database migrated

rem ── Done ─────────────────────────────────────────────────────────────────────
echo.
echo  ════════════════════════════════════════════════════
echo  ✓  Zenith is ready to run!
echo  ════════════════════════════════════════════════════
echo.
echo  To start Zenith:
echo    start-zenith.bat
echo.
echo  Or manually in separate terminals:
echo    npm run dev:api       # API server (port 3000)
echo    npm run dev:worker    # Background worker
echo    npm run dev -w @zenith/web   # Web frontend (port 5173)
echo.
echo  Access points:
echo    User app:        http://localhost:5173  (or http://localhost:3000/)
echo    Counsellor dash: http://localhost:3000/dashboard/
echo    API health:      http://localhost:3000/api/v1/health
echo.
echo  Press any key to exit...
pause >nul