# Zenith local PostgreSQL helper (portable binaries, no admin required).
# Usage: powershell -ExecutionPolicy Bypass -File infra/scripts/db.ps1 <init|start|stop|status>

param([Parameter(Mandatory = $true)][ValidateSet("init", "start", "stop", "status")][string]$Command)

$PgBin = "$env:LOCALAPPDATA\zenith\pgsql\bin"
$PgData = "$env:LOCALAPPDATA\zenith\pgdata"
$PgLog = "$env:LOCALAPPDATA\zenith\pgdata.log"

if (-not (Test-Path "$PgBin\pg_ctl.exe")) {
    Write-Error "PostgreSQL binaries not found at $PgBin. Extract the portable zip there first (see README)."
    exit 1
}

switch ($Command) {
    "init" {
        if (Test-Path "$PgData\PG_VERSION") { Write-Output "Already initialized at $PgData"; exit 0 }
        $pwFile = "$env:TEMP\zenith-pg-pw.txt"
        Set-Content -Path $pwFile -Value "zenith" -Encoding ascii -NoNewline
        & "$PgBin\initdb.exe" -D $PgData -U zenith -A scram-sha-256 --pwfile=$pwFile -E UTF8
        Remove-Item $pwFile -Force
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        & "$PgBin\pg_ctl.exe" -D $PgData -l $PgLog -w start
        if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
        $env:PGPASSWORD = "zenith"
        & "$PgBin\createdb.exe" -U zenith -h localhost zenith
        Write-Output "Database 'zenith' ready on localhost:5432 (user: zenith)"
    }
    "start" {
        & "$PgBin\pg_ctl.exe" -D $PgData -l $PgLog -w start
    }
    "stop" {
        & "$PgBin\pg_ctl.exe" -D $PgData stop
    }
    "status" {
        & "$PgBin\pg_ctl.exe" -D $PgData status
    }
}
