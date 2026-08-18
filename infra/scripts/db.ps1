<# 
.SYNOPSIS
    PostgreSQL management for Zenith on Windows.
    Supports portable PostgreSQL (no install required) or Docker fallback.

.DESCRIPTION
    This script manages a PostgreSQL instance for Zenith development.
    It downloads portable PostgreSQL binaries on first run, or uses Docker if available.

.PARAMETER Action
    init   - Download and initialize portable PostgreSQL (first time only)
    start  - Start the PostgreSQL server
    stop   - Stop the PostgreSQL server
    status - Check if PostgreSQL is running

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File infra/scripts/db.ps1 init
    powershell -ExecutionPolicy Bypass -File infra/scripts/db.ps1 start
    powershell -ExecutionPolicy Bypass -File infra/scripts/db.ps1 stop
#>

param(
    [Parameter(Mandatory=$true, Position=0)]
    [ValidateSet('init','start','stop','status')]
    [string]$Action
)

$ErrorActionPreference = "Stop"

# Configuration
$RootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RootDir = Split-Path -Parent $RootDir
$RootDir = Split-Path -Parent $RootDir
$PgDir = Join-Path $RootDir ".postgres"
$PgBinDir = Join-Path $PgDir "bin"
$PgDataDir = Join-Path $PgDir "data"
$PgPort = 5432
$PgUser = "zenith"
$PgPass = "zenith"
$PgDb = "zenith"
$PgVersion = "16.15-1"
$PgUrl = "https://get.enterprisedb.com/postgresql/postgresql-$PgVersion-windows-x64-binaries.zip"

function Write-Log($msg) { Write-Host "[$(Get-Date -Format 'HH:mm:ss')] $msg" }

function Test-DockerAvailable {
    try {
        docker version > $null 2>&1
        return $true
    } catch {
        return $false
    }
}

function Start-PgDocker {
    Write-Log "Starting PostgreSQL via Docker..."
    docker compose -f "$RootDir/infra/docker-compose.yml" up -d postgres
    Write-Log "PostgreSQL started on port $PgPort (Docker)"
}

function Stop-PgDocker {
    Write-Log "Stopping PostgreSQL (Docker)..."
    docker compose -f "$RootDir/infra/docker-compose.yml" stop postgres
}

function Test-PgRunning {
    try {
        $result = & "$PgBinDir\pg_ctl.exe" status -D "$PgDataDir" 2>&1
        return $result -match "server is running"
    } catch {
        return $false
    }
}

function Init-PortablePostgres {
    Write-Log "Initializing portable PostgreSQL $PgVersion..."
    
    if (Test-Path $PgDir) {
        Write-Log "PostgreSQL directory already exists at $PgDir"
        return
    }
    
    $zipPath = Join-Path $env:TEMP "postgresql-$PgVersion-windows-x64-binaries.zip"
    
    if (Test-Path $zipPath) {
        Write-Log "Download archive already exists at $zipPath - skipping download"
    } else {
        Write-Log "Downloading PostgreSQL binaries (~100 MB)..."
        try {
            Invoke-WebRequest -Uri $PgUrl -OutFile $zipPath -UseBasicParsing
        } catch {
            Write-Error "Failed to download PostgreSQL: $_"
            Write-Log "Falling back to Docker..."
            if (Test-DockerAvailable) {
                Start-PgDocker
                return
            }
            throw "Neither portable PostgreSQL nor Docker available"
        }
    }
    
    Write-Log "Extracting..."
    Expand-Archive -Path $zipPath -DestinationPath $PgDir -Force
    $extractedDir = Join-Path $PgDir "pgsql"
    if (Test-Path $extractedDir) {
        Move-Item -Path (Join-Path $extractedDir "*") -Destination $PgDir -Force
        Remove-Item $extractedDir -Recurse -Force
    }
    Remove-Item $zipPath -Force
    
    Write-Log "Initializing database cluster..."
    & "$PgBinDir\initdb.exe" -D "$PgDataDir" -U $PgUser -A scram-sha-256 > $null 2>&1
    
    # Configure postgresql.conf for local connections
    $confPath = Join-Path $PgDataDir "postgresql.conf"
    $conf = Get-Content $confPath -Raw
    $conf = $conf -replace "#listen_addresses = 'localhost'", "listen_addresses = 'localhost'"
    $conf = $conf -replace "#port = 5432", "port = $PgPort"
    $conf = $conf -replace "#max_connections = 100", "max_connections = 100"
    Set-Content $confPath $conf
    
    # Configure pg_hba.conf for password auth
    $hbaPath = Join-Path $PgDataDir "pg_hba.conf"
    $hba = Get-Content $hbaPath -Raw
    $hba = $hba -replace "host\s+all\s+all\s+127\.0\.0\.1/32\s+scram-sha-256", "host all all 127.0.0.1/32 scram-sha-256"
    $hba = $hba -replace "host\s+all\s+all\s+::1/128\s+scram-sha-256", "host all all ::1/128 scram-sha-256"
    Set-Content $hbaPath $hba
    
    Write-Log "Creating database and user..."
    Start-PortablePostgres
    Start-Sleep 3
    & "$PgBinDir\psql.exe" -h localhost -p $PgPort -U $PgUser -d postgres -c "CREATE DATABASE $PgDb;" 2>&1 | Out-Null
    & "$PgBinDir\psql.exe" -h localhost -p $PgPort -U $PgUser -d postgres -c "ALTER USER $PgUser WITH PASSWORD '$PgPass';" 2>&1 | Out-Null
    Stop-PortablePostgres
    
    Write-Log "Portable PostgreSQL initialized at $PgDir"
}

function Start-PortablePostgres {
    if (Test-PgRunning) {
        Write-Log "PostgreSQL already running on port $PgPort"
        return
    }
    Write-Log "Starting portable PostgreSQL on port $PgPort..."
    $logFile = Join-Path $PgDataDir "postgresql.log"
    & "$PgBinDir\pg_ctl.exe" start -D "$PgDataDir" -l $logFile -w -t 30
    Write-Log "PostgreSQL started (PID: $((Get-Process -Name postgres -ErrorAction SilentlyContinue).Id -join ', '))"
}

function Stop-PortablePostgres {
    if (-not (Test-PgRunning)) {
        Write-Log "PostgreSQL not running"
        return
    }
    Write-Log "Stopping portable PostgreSQL..."
    & "$PgBinDir\pg_ctl.exe" stop -D "$PgDataDir" -m fast -w -t 30
    Write-Log "PostgreSQL stopped"
}

function Get-PgStatus {
    if (Test-Path $PgDir) {
        if (Test-PgRunning) {
            Write-Log "Portable PostgreSQL: RUNNING on port $PgPort"
            Write-Log "  Data: $PgDataDir"
            Write-Log "  Bin:  $PgBinDir"
            return
        } else {
            Write-Log "Portable PostgreSQL: STOPPED"
            return
        }
    }
    
    if (Test-DockerAvailable) {
        $container = docker ps --filter "name=zenith-postgres" --format "{{.Status}}"
        if ($container) {
            Write-Log "Docker PostgreSQL: $container"
            return
        }
    }
    
    Write-Log "PostgreSQL: NOT INITIALIZED (run 'init' first)"
}

# Main
switch ($Action) {
    'init' {
        if (Test-DockerAvailable) {
            Write-Log "Docker detected. Use 'docker compose -f infra/docker-compose.yml up -d postgres' instead."
            Write-Log "Continuing with portable PostgreSQL for zero-dependency setup..."
        }
        Init-PortablePostgres
    }
    'start' {
        if (Test-Path $PgDir) {
            Start-PortablePostgres
        } elseif (Test-DockerAvailable) {
            Start-PgDocker
        } else {
            Write-Error "PostgreSQL not initialized. Run 'init' first."
            exit 1
        }
    }
    'stop' {
        if (Test-Path $PgDir) {
            Stop-PortablePostgres
        } elseif (Test-DockerAvailable) {
            Stop-PgDocker
        } else {
            Write-Log "No PostgreSQL instance found to stop"
        }
    }
    'status' {
        Get-PgStatus
    }
}