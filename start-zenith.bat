@echo off
title Zenith Launcher
color 0B
cls

echo.
echo  ████████╗███████╗███╗   ██╗██╗████████╗██╗  ██╗
echo  ╚══███╔╝██╔════╝████╗  ██║██║╚══███╔══╝██║  ██║
echo    ███╔╝ █████╗  ██╔██╗ ██║██║   ███║   ███████║
echo   ███╔╝  ██╔══╝  ██║╚██╗██║██║   ███║   ██╔══██║
echo  ███████╗███████╗██║ ╚████║██║   ███║   ██║  ██║
echo  ╚══════╝╚══════╝╚═╝  ╚═══╝╚═╝   ╚══╝   ╚═╝  ╚═╝
echo.
echo  Mental Health Support Platform — Full Stack Launcher
echo  ════════════════════════════════════════════════════
echo.

set "ROOT=%~dp0"

rem ── Verify Ollama ──────────────────────────────────────────────────────────────
echo  [1/5] Checking Ollama API...
curl -s --max-time 3 http://localhost:11434/api/tags >nul 2>&1
if errorlevel 1 (
    echo.
    echo  ┌─────────────────────────────────────────────────────────┐
    echo  │  ACTION REQUIRED: Ollama is not running.                │
    echo  │                                                         │
    echo  │  Zenith uses Ollama to run the AI Buddy and embeddings. │
    echo  │  1. Please install Ollama from ollama.com               │
    echo  │  2. Run 'ollama pull llama3.2:3b' in a terminal         │
    echo  │  3. Run 'ollama pull nomic-embed-text' in a terminal    │
    echo  │  4. Start the Ollama app                                │
    echo  │  5. Press any key here to continue anyway...            │
    echo  └─────────────────────────────────────────────────────────┘
    echo.
    pause
) else (
    echo  [1/5] Ollama OK — model server is running on :11434
)
echo.

rem ── Step 2: PostgreSQL ────────────────────────────────────────────────────────
echo  [2/5] Starting PostgreSQL...
call npm run db:start --prefix "%ROOT%" >nul 2>&1
echo  [2/5] PostgreSQL ready.
echo.

rem ── Step 3: STT Sidecar ──────────────────────────────────────────────────────
echo  [3/5] Starting STT sidecar (Whisper multilingual voice engine)...
set "VENV=%ROOT%services\inference\.venv\Scripts\python.exe"
if exist "%VENV%" (
    start "Zenith — STT Sidecar [port 8090]" cmd /k "color 0A && echo [STT] Whisper multilingual sidecar starting... && "%VENV%" "%ROOT%services\inference\stt_server.py""
    echo  [3/5] STT sidecar window opened.
) else (
    echo  [3/5] WARNING: Python venv not found — voice will use browser STT only.
    echo         Run infra\install-windows.bat to set up the venv.
)
echo.

rem ── Step 4: API Server ───────────────────────────────────────────────────────
echo  [4/5] Starting API server...
start "Zenith — API Server [port 3000]" cmd /k "color 0E && echo [API] Starting Zenith API server... && cd /d "%ROOT%" && npm run dev:api"
timeout /t 4 /nobreak >nul
echo  [4/5] API server window opened.
echo.

rem ── Step 5: Background Worker (crisis detection) ─────────────────────────────
echo  [5/5] Starting background worker (crisis detection + purge)...
start "Zenith — Worker [crisis detection]" cmd /k "color 06 && echo [WORKER] Starting crisis detection worker... && cd /d "%ROOT%" && npm run dev:worker"
timeout /t 2 /nobreak >nul
echo  [5/5] Worker window opened.
echo.

rem ── Web Frontend ─────────────────────────────────────────────────────────────
echo  Starting web frontend...
start "Zenith — Web Frontend [port 5173]" cmd /k "color 0D && echo [WEB] Starting Vite dev server... && cd /d "%ROOT%" && npm run dev -w @zenith/web"
echo  Web frontend window opened.
echo.

rem ── Wait for API then open browser ───────────────────────────────────────────
echo  Waiting for API to be ready...
:wait_loop
timeout /t 2 /nobreak >nul
curl -s --max-time 2 http://localhost:3000/api/v1/health >nul 2>&1
if errorlevel 1 goto wait_loop

echo.
echo  ════════════════════════════════════════════════════
echo  ✓  All services are running!
echo.
echo     App     →  http://localhost:5173
echo     API     →  http://localhost:3000
echo     STT     →  http://localhost:8090/health
echo     Ollama  →  http://localhost:11434/api/tags
echo  ════════════════════════════════════════════════════
echo.
echo  Opening Zenith in your browser...
start "" "http://localhost:5173"
echo.
echo  Press any key to stop all services and shut down Zenith.
pause >nul

rem ── Shutdown ──────────────────────────────────────────────────────────────────
echo.
echo  Shutting down...
taskkill /FI "WindowTitle eq Zenith — STT Sidecar*" /F >nul 2>&1
taskkill /FI "WindowTitle eq Zenith — API Server*" /F >nul 2>&1
taskkill /FI "WindowTitle eq Zenith — Worker*" /F >nul 2>&1
taskkill /FI "WindowTitle eq Zenith — Web Frontend*" /F >nul 2>&1
call npm run db:stop --prefix "%ROOT%" >nul 2>&1
echo  All services stopped. Goodbye.
timeout /t 2 /nobreak >nul