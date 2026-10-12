# One-command install of the Compose kit on Windows (OPS-001): checks Docker, writes .env with a
# fresh database password when there is none, starts the stack, waits for readiness and prints
# the first-run setup link. Run again at any time.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   $env:DATABASE_URL = "postgres://..."; powershell -ExecutionPolicy Bypass -File install.ps1
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Fail($message) { Write-Error "install: $message"; exit 1 }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  Fail "Docker Desktop is not installed. See https://docs.docker.com/desktop/ and run this script again."
}
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker Compose v2 is missing (the 'docker compose' command)." }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail "Docker is installed but not running. Start Docker Desktop and run again." }

if ($env:DATABASE_URL) {
  $file = 'docker-compose.external.yml'
  if (-not (Test-Path .env)) {
    "DATABASE_URL=$($env:DATABASE_URL)" | Out-File -Encoding ascii .env
    Write-Host 'wrote .env with your DATABASE_URL'
  }
} else {
  $file = 'docker-compose.yml'
  if (-not (Test-Path .env)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $password = ([Convert]::ToBase64String($bytes) -replace '[/+=]', '').Substring(0, 32)
    "POSTGRES_PASSWORD=$password" | Out-File -Encoding ascii .env
    Write-Host 'wrote .env with a fresh database password'
  }
}

# The port as Compose resolves it: the environment first, then .env, then 8080.
$port = 8080
$portLine = Get-Content .env | Where-Object { $_ -match '^TRACKSMITH_PORT=' }
if ($portLine) { $port = [int]($portLine -split '=')[1] }
if ($env:TRACKSMITH_PORT) { $port = [int]$env:TRACKSMITH_PORT }

Write-Host "starting Tracksmith with $file"
docker compose -f $file up -d --quiet-pull
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed' }

Write-Host 'waiting for the backend'
$ready = $false
for ($i = 0; $i -lt 120; $i++) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/ready" -TimeoutSec 2
    if ($r.StatusCode -eq 200) { $ready = $true; break }
  } catch {}
  Start-Sleep -Seconds 1
}
if (-not $ready) {
  docker compose -f $file logs --tail 40 tracksmith
  Fail 'the backend did not become ready in 2 minutes; the log above says why'
}

$logs = docker compose -f $file logs --no-log-prefix tracksmith 2>$null | Out-String
$link = [regex]::Matches($logs, '"link":"([^"]*)"') | Select-Object -Last 1 | ForEach-Object { $_.Groups[1].Value }
Write-Host ''
Write-Host "Tracksmith is running on port $port."
if ($link) {
  Write-Host 'Open this link once to create the administrator:'
  Write-Host "  $link"
} else {
  Write-Host "Setup is already complete; sign in at http://127.0.0.1:$port/"
}
