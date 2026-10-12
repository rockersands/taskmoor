#!/usr/bin/env bash
# One-command install of the Compose kit (OPS-001): checks prerequisites, writes .env with a
# fresh database password when there is none, starts the stack, waits for readiness and prints
# the first-run setup link. Safe to run again: it only starts or updates what is there.
#
#   bash install.sh                 # bundled PostgreSQL
#   DATABASE_URL=postgres://... bash install.sh   # your own PostgreSQL
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { say "install: $*" >&2; exit 1; }

command -v docker >/dev/null 2>&1 || die "Docker is not installed. See https://docs.docker.com/engine/install/ and run this script again."
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command). Install the compose plugin and run again."
docker info >/dev/null 2>&1 || die "Docker is installed but not running, or this user may not use it (try: sudo usermod -aG docker \$USER, then sign in again)."

if [ -n "${DATABASE_URL:-}" ]; then
  file=docker-compose.external.yml
  if [ ! -f .env ]; then
    printf 'DATABASE_URL=%s\n' "$DATABASE_URL" > .env
    chmod 600 .env
    say "wrote .env with your DATABASE_URL"
  fi
else
  file=docker-compose.yml
  if [ ! -f .env ]; then
    password=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 32)
    printf 'POSTGRES_PASSWORD=%s\n' "$password" > .env
    chmod 600 .env
    say "wrote .env with a fresh database password"
  fi
fi

# grep finds nothing on most installs; that must not trip set -e.
port=$(grep -E '^TRACKSMITH_PORT=' .env 2>/dev/null | cut -d= -f2 || true)
port=${port:-8080}
for p in "$port"; do
  if (command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$p ") || (command -v netstat >/dev/null 2>&1 && netstat -ltn 2>/dev/null | grep -q ":$p "); then
    docker compose -f "$file" ps -q tracksmith >/dev/null 2>&1 || die "port $p is in use; set TRACKSMITH_PORT in .env"
  fi
done

say "starting Tracksmith with $file"
docker compose -f "$file" up -d --quiet-pull

say "waiting for the backend"
for _ in $(seq 1 120); do
  if curl -fsS "http://127.0.0.1:$port/ready" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$port/ready" >/dev/null 2>&1 || {
  docker compose -f "$file" logs --tail 40 tracksmith
  die "the backend did not become ready in 2 minutes; the log above says why"
}

# The link line is absent once setup is complete; an empty match is the normal second run.
link=$( (docker compose -f "$file" logs --no-log-prefix tracksmith 2>/dev/null || true) | grep -o '"link":"[^"]*"' | tail -1 | cut -d'"' -f4 || true)
say ""
say "Tracksmith is running on port $port."
if [ -n "$link" ]; then
  say "Open this link once to create the administrator:"
  say "  $link"
else
  say "Setup is already complete; sign in at http://127.0.0.1:$port/"
fi
