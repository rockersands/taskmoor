import { apiOrigin, type BuilderInputs, frontendOrigin } from './inputs';
import { ENV_FILE, type Kits, MANIFEST_FILE } from './kits';

/**
 * The backend kit (M1-110; OPS-015, ADR-031) around the `.env` every kit shares.
 * - Compose (the default target): Postgres, the backend pinned to the image version, and Caddy
 *   for automatic HTTPS; `install.sh` and `install.ps1` check Docker, the ports and the DNS
 *   record, start the stack, wait for health and print the setup link; the README lists the
 *   DNS records the chosen URLs need.
 * - Helm: values for the chart and a Secret with the instance's secrets.
 * The image comes from `ghcr.io/rockersands/taskmoor` unless the run names another.
 */
export const DEFAULT_IMAGE = 'ghcr.io/rockersands/taskmoor';

/** Hosts that never get a public certificate: Caddy's own authority signs for them. */
const isLocalHost = (host: string) =>
  host === 'localhost' ||
  host.endsWith('.localhost') ||
  host.endsWith('.test') ||
  /^[\d.]+$/.test(host);

function compose(): string {
  return `# Written by the Taskmoor Builder (OPS-015): PostgreSQL, the backend at the version this kit
# was made for, and Caddy for HTTPS. Start it with install.sh (or install.ps1), which checks the
# machine first; the settings and secrets are in .env.
name: taskmoor
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: taskmoor
      POSTGRES_DB: taskmoor
      POSTGRES_PASSWORD: \${POSTGRES_PASSWORD:?run install.sh from the kit folder}
    volumes:
      - postgres-data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U taskmoor -d taskmoor"]
      interval: 5s
      timeout: 5s
      retries: 24
    restart: unless-stopped

  taskmoor:
    image: \${TASKMOOR_IMAGE:?run install.sh from the kit folder}
    env_file: [.env]
    environment:
      DATABASE_URL: postgres://taskmoor:\${POSTGRES_PASSWORD}@postgres:5432/taskmoor # secret-scan: allow
      TASKMOOR_ROLE: all
      # Caddy, on the Compose network, is the proxy whose client address is believed.
      TASKMOOR_TRUSTED_PROXIES: uniquelocal
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - taskmoor-data:/data
    restart: unless-stopped

  caddy:
    image: caddy:2
    ports:
      - "\${TASKMOOR_HTTP_PORT:-80}:80"
      - "\${TASKMOOR_HTTPS_PORT:-443}:443"
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
    depends_on:
      - taskmoor
    restart: unless-stopped

volumes:
  postgres-data:
  taskmoor-data:
  caddy-data:
  caddy-config:
`;
}

function caddyfile(host: string): string {
  return `# Written by the Taskmoor Builder: HTTPS for the backend (OPS-015). Caddy gets and renews the
# certificate itself; it needs ports 80 and 443 and the DNS record in README.md.
${host} {
${isLocalHost(host) ? '\t# A local name: Caddy signs the certificate with its own authority.\n\ttls internal\n' : ''}\tencode zstd gzip
\treverse_proxy taskmoor:8080
}
`;
}

function installSh(): string {
  return `#!/usr/bin/env bash
# Installs the Taskmoor backend this kit was made for (OPS-015): checks Docker, the ports and
# the DNS record, starts PostgreSQL, the backend and Caddy, waits for the backend and prints the
# one-time setup link. Safe to run again.
#
#   bash install.sh               # check, then install
#   bash install.sh --preflight   # only check
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\\n' "$*"; }
die() { say "install: $*" >&2; exit 1; }
setting() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- || true; }

[ -f .env ] || die "no .env here: run this script from the kit folder"
DOMAIN=$(setting TASKMOOR_DOMAIN)
PUBLIC_URL=$(setting PUBLIC_URL)
TOKEN=$(setting TASKMOOR_SETUP_TOKEN)
HTTP_PORT=\${TASKMOOR_HTTP_PORT:-$(setting TASKMOOR_HTTP_PORT)}
HTTP_PORT=\${HTTP_PORT:-80}
HTTPS_PORT=\${TASKMOOR_HTTPS_PORT:-$(setting TASKMOOR_HTTPS_PORT)}
HTTPS_PORT=\${HTTPS_PORT:-443}

# Whether something answers on a local port: a connection attempt, which works on every system.
in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1; }
# Whether a name resolves, by whatever resolver this system has.
resolves() {
  case "$1" in localhost | *.localhost) return 0 ;; esac
  if command -v getent >/dev/null 2>&1; then getent hosts "$1" >/dev/null 2>&1 && return 0; fi
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import socket, sys; socket.getaddrinfo(sys.argv[1], 443)' "$1" >/dev/null 2>&1 && return 0
  fi
  if command -v dig >/dev/null 2>&1; then [ -n "$(dig +short "$1" 2>/dev/null)" ] && return 0; fi
  if command -v nslookup >/dev/null 2>&1; then nslookup "$1" >/dev/null 2>&1 && return 0; fi
  return 1
}
running() { docker compose ps -q caddy 2>/dev/null | grep -q .; }

preflight() {
  command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/ and run this script again."
  docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command). Install the compose plugin and run again."
  docker info >/dev/null 2>&1 || die "Docker is installed but not running, or this user may not use it (try: sudo usermod -aG docker \\$USER, then sign in again)."
  if ! running; then
    for p in "$HTTP_PORT" "$HTTPS_PORT"; do
      in_use "$p" && die "port $p is in use. Caddy needs ports 80 and 443 for HTTPS: stop what listens there, or set TASKMOOR_HTTP_PORT and TASKMOOR_HTTPS_PORT in .env."
    done
  fi
  resolves "$DOMAIN" || die "$DOMAIN does not resolve. Create the DNS record in README.md, wait until it answers, then run this script again."
  say "preflight passed: Docker, ports $HTTP_PORT and $HTTPS_PORT, and $DOMAIN"
}

preflight
[ "\${1:-}" = "--preflight" ] && exit 0

say "starting Taskmoor"
docker compose up -d --quiet-pull --pull "\${TASKMOOR_PULL:-missing}"

# Readiness is asked from inside the container, whatever the host's ports or firewall.
ready() {
  docker compose exec -T taskmoor node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}
say "waiting for the backend"
for _ in $(seq 1 180); do
  if ready; then break; fi
  sleep 1
done
ready || { docker compose logs --tail 40 taskmoor; die "the backend did not become ready in 3 minutes; the log above says why"; }

# The first start moved the AI key into encrypted storage (IAM-020); from then on the backend
# ignores it, so it leaves .env. Only once the backend's log says the database holds it.
if [ -n "$(setting TASKMOOR_AI_KEY)" ] && docker compose logs --no-log-prefix taskmoor 2>/dev/null | grep -Eq '"msg":"AI settings (moved from|in the environment are ignored)'; then
  sed -i.bak '/^TASKMOOR_AI_KEY=/d' .env && rm -f .env.bak
  say "the AI key is in encrypted storage now: removed TASKMOOR_AI_KEY from .env"
fi

needed=$(docker compose exec -T taskmoor node -e "fetch('http://127.0.0.1:8080/api/v1/setup').then(r=>r.json()).then(s=>process.stdout.write(String(s.needed)))" 2>/dev/null || true)
say ""
say "Taskmoor is running at $PUBLIC_URL"
if [ "$needed" = "true" ]; then
  say "Open this link once to create the administrator:"
  say "  $PUBLIC_URL/#/setup?token=$TOKEN"
else
  say "Setup is already complete: sign in at $PUBLIC_URL"
fi
`;
}

function installPs1(): string {
  return `# Installs the Taskmoor backend this kit was made for (OPS-015), on Windows with Docker Desktop:
# checks Docker, the ports and the DNS record, starts the stack, waits for the backend and prints
# the one-time setup link. Safe to run again.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1              # check, then install
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Preflight   # only check
param([switch]$Preflight)
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

function Fail($message) { Write-Error "install: $message"; exit 1 }
function Setting($name) {
  $line = Get-Content .env -ErrorAction SilentlyContinue | Where-Object { $_ -like "$name=*" } | Select-Object -First 1
  if ($line) { return $line.Substring($name.Length + 1) } else { return '' }
}

if (-not (Test-Path .env)) { Fail 'no .env here: run this script from the kit folder' }
$Domain = Setting 'TASKMOOR_DOMAIN'
$PublicUrl = Setting 'PUBLIC_URL'
$Token = Setting 'TASKMOOR_SETUP_TOKEN'
$HttpPort = if ($env:TASKMOOR_HTTP_PORT) { $env:TASKMOOR_HTTP_PORT } elseif (Setting 'TASKMOOR_HTTP_PORT') { Setting 'TASKMOOR_HTTP_PORT' } else { '80' }
$HttpsPort = if ($env:TASKMOOR_HTTPS_PORT) { $env:TASKMOOR_HTTPS_PORT } elseif (Setting 'TASKMOOR_HTTPS_PORT') { Setting 'TASKMOOR_HTTPS_PORT' } else { '443' }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed. Install Docker Desktop and run this script again.' }
docker compose version *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker Compose v2 is missing (the "docker compose" command).' }
docker info *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker is installed but not running. Start Docker Desktop and run again.' }
$running = (docker compose ps -q caddy 2>$null)
if (-not $running) {
  foreach ($p in @($HttpPort, $HttpsPort)) {
    if (Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue) {
      Fail "port $p is in use. Caddy needs ports 80 and 443: stop what listens there, or set TASKMOOR_HTTP_PORT and TASKMOOR_HTTPS_PORT in .env."
    }
  }
}
if ($Domain -ne 'localhost' -and -not $Domain.EndsWith('.localhost')) {
  try { Resolve-DnsName -Name $Domain -ErrorAction Stop | Out-Null }
  catch { Fail "$Domain does not resolve. Create the DNS record in README.md, wait until it answers, then run this script again." }
}
Write-Output "preflight passed: Docker, ports $HttpPort and $HttpsPort, and $Domain"
if ($Preflight) { exit 0 }

Write-Output 'starting Taskmoor'
$pull = if ($env:TASKMOOR_PULL) { $env:TASKMOOR_PULL } else { 'missing' }
docker compose up -d --quiet-pull --pull $pull
if ($LASTEXITCODE -ne 0) { Fail 'docker compose up failed; see above.' }

Write-Output 'waiting for the backend'
$ready = $false
for ($i = 0; $i -lt 180; $i++) {
  docker compose exec -T taskmoor node -e "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" *> $null
  if ($LASTEXITCODE -eq 0) { $ready = $true; break }
  Start-Sleep -Seconds 1
}
if (-not $ready) { docker compose logs --tail 40 taskmoor; Fail 'the backend did not become ready in 3 minutes; the log above says why' }

$needed = docker compose exec -T taskmoor node -e "fetch('http://127.0.0.1:8080/api/v1/setup').then(r=>r.json()).then(s=>process.stdout.write(String(s.needed)))" 2>$null
Write-Output ''
Write-Output "Taskmoor is running at $PublicUrl"
if ($needed -eq 'true') {
  Write-Output 'Open this link once to create the administrator:'
  Write-Output "  $PublicUrl/#/setup?token=$Token"
} else {
  Write-Output "Setup is already complete: sign in at $PublicUrl"
}
`;
}

function readme(inputs: BuilderInputs, image: string): string {
  const api = new URL(apiOrigin(inputs)).hostname;
  const front = new URL(frontendOrigin(inputs)).hostname;
  const records = [`| \`${api}\` | A (and AAAA for IPv6) | this server's public address |`];
  const frontNote =
    front === api
      ? 'The frontend is served from the same address, so no other record is needed.'
      : `The frontend at \`${front}\` is served by its static host: create the record that host asks for.`;
  return `# Taskmoor backend kit

Made by the Taskmoor Builder for \`${apiOrigin(inputs)}\`, running \`${image}\`.

## DNS

Before installing, point the backend's name at this server:

| Name | Record | Value |
|---|---|---|
${records.join('\n')}

${frontNote} Ports 80 and 443 must reach this server: Caddy uses them to get the HTTPS
certificate and to serve the API.

## Install

1. Copy this folder to the server and open a shell in it.
2. Run \`bash install.sh\` (on Windows with Docker Desktop: \`powershell -File install.ps1\`).
   It checks Docker, the ports and the DNS record first; \`--preflight\` only checks.
3. Open the setup link it prints once, to create the first administrator.

\`.env\` holds the instance's secrets: keep it private and back it up with the data volumes.
\`connection-manifest.json\` is the instance's signed description; the frontend kit carries the
same one.
`;
}

function helmValues(inputs: BuilderInputs, image: string, version: string): string {
  return `# Written by the Taskmoor Builder: values for deploy/helm/taskmoor (OPS-015).
# helm install taskmoor deploy/helm/taskmoor -f values.yaml after kubectl apply -f secret.yaml.
image:
  repository: ${image}
  tag: "${version}"
publicUrl: "${apiOrigin(inputs)}"
webRouting: ${inputs.routing}
database:
  # Add DATABASE_URL (your PostgreSQL) to the taskmoor-kit secret before installing.
  existingSecret: taskmoor-kit
setupToken:
  existingSecret: taskmoor-kit
passwordPepper:
  existingSecret: taskmoor-kit
extraEnv:
  - name: TASKMOOR_INSTANCE_ID
    valueFrom: { secretKeyRef: { name: taskmoor-kit, key: TASKMOOR_INSTANCE_ID } }
  - name: TASKMOOR_INSTANCE_KEY
    valueFrom: { secretKeyRef: { name: taskmoor-kit, key: TASKMOOR_INSTANCE_KEY } }
  # Wraps the AI provider keys the backend stores (M1-075, ADR-098).
  - name: TASKMOOR_MASTER_KEY
    valueFrom: { secretKeyRef: { name: taskmoor-kit, key: TASKMOOR_MASTER_KEY } }
  - name: TASKMOOR_ALLOWED_ORIGINS
    value: "${frontendOrigin(inputs)}"
  - name: TASKMOOR_OAUTH_REDIRECT_URIS
    value: "${new URL(inputs.frontendUrl).href}"
`;
}

function helmSecret(env: Record<string, string>): string {
  const keys = [
    'TASKMOOR_SETUP_TOKEN',
    'TASKMOOR_PASSWORD_PEPPER',
    'TASKMOOR_INSTANCE_ID',
    'TASKMOOR_INSTANCE_KEY',
    'TASKMOOR_TOKEN_SIGNING_KEY',
    'TASKMOOR_MASTER_KEY',
  ];
  return `# Written by the Taskmoor Builder: the instance's secrets for Kubernetes. Keep this file private.
# Add DATABASE_URL for your PostgreSQL, then: kubectl apply -f secret.yaml
apiVersion: v1
kind: Secret
metadata:
  name: taskmoor-kit
type: Opaque
stringData:
${keys.map((k) => `  ${k}: "${env[k] ?? ''}"`).join('\n')}
  # DATABASE_URL: your PostgreSQL's connection URL, with its user, password, host and database.
`;
}

function readEnv(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
}

/** The backend kit's files for the chosen target. */
export function backendKit(
  kits: Kits,
  inputs: BuilderInputs,
  options: { image?: string } = {},
): Record<string, string> {
  const image = options.image ?? DEFAULT_IMAGE;
  const version = kits.manifest.manifest.backendVersion;
  const env = kits.backend[ENV_FILE] ?? '';
  const manifest = kits.backend[MANIFEST_FILE] ?? '';
  if (inputs.target === 'helm') {
    return {
      'values.yaml': helmValues(inputs, image, version),
      'secret.yaml': helmSecret(readEnv(env)),
      [MANIFEST_FILE]: manifest,
    };
  }
  const host = new URL(apiOrigin(inputs)).hostname;
  return {
    [ENV_FILE]: `${env}TASKMOOR_IMAGE=${image}:${version}\nTASKMOOR_DOMAIN=${host}\n`,
    'docker-compose.yml': compose(),
    Caddyfile: caddyfile(host),
    'install.sh': installSh(),
    'install.ps1': installPs1(),
    'README.md': readme(inputs, `${image}:${version}`),
    [MANIFEST_FILE]: manifest,
  };
}
