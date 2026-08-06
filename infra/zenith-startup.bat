@echo off
rem ═══════════════════════════════════════════════════════════════════════════
rem  Zenith full-stack startup — run this MANUALLY when you need all services.
rem  Usage: double-click this file, or run it from a terminal.
rem  NOTE: Autostart at logon is DISABLED. This is intentional.
rem ═══════════════════════════════════════════════════════════════════════════

set "DEPLOY=%LOCALAPPDATA%\zenith"

rem ── Verify install ────────────────────────────────────────────────────────
if not exist "%DEPLOY%\config.cmd" (
    echo [zenith-startup] ERROR: Not installed. Run infra\install-windows.bat first.
    pause
    exit /b 1
)

rem ── 1. PostgreSQL ─────────────────────────────────────────────────────────
echo [zenith-startup] Starting PostgreSQL...
call "%LOCALAPPDATA%\zenith\pgsql\bin\pg_ctl.exe" -D "%LOCALAPPDATA%\zenith\pgdata" -w start

rem ── 2. Ollama LLM server ──────────────────────────────────────────────────
echo [zenith-startup] Starting Ollama...
start "zenith-ollama" /min "%LOCALAPPDATA%\Programs\Ollama\ollama.exe" serve

rem ── 3. Give Postgres + Ollama a moment to bind their ports ────────────────
ping -n 6 127.0.0.1 >nul

rem ── 4. Start app services (each in its own minimised window) ──────────────
echo [zenith-startup] Starting STT sidecar...
start "zenith-stt"    /min "%DEPLOY%\run-stt.cmd"

echo [zenith-startup] Starting API server...
start "zenith-api"    /min "%DEPLOY%\run-api.cmd"

echo [zenith-startup] Starting worker...
start "zenith-worker" /min "%DEPLOY%\run-worker.cmd"

rem ── 5. Tunnel — starts last; it waits internally for the API health check ─
echo [zenith-startup] Starting Cloudflare Tunnel...
start "zenith-tunnel" /min "%DEPLOY%\run-tunnel.cmd"

echo [zenith-startup] All services launched. Tunnel URL will appear in the zenith-tunnel window.
