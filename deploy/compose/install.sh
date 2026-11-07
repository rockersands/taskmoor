#!/usr/bin/env bash
# One-command install of the Compose kit (OPS-001): checks prerequisites, writes .env with a
# fresh database password when there is none, starts the stack, waits for readiness and prints
# the first-run setup link. Safe to run again: it only starts or updates what is there. With
# the bundled PostgreSQL, the first start makes a private certificate authority and the
# database's TLS certificate on this machine (the postgres-tls service, ADR-111).
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

# A switch given for this install stays in .env, so later upgrades keep it. The air-gap bundle
# turns the new-version check off this way (OPS-005, OPS-026).
if [ -n "${TASKMOOR_UPDATE_CHECK:-}" ] && ! grep -qE '^TASKMOOR_UPDATE_CHECK=' .env 2>/dev/null; then
  printf 'TASKMOOR_UPDATE_CHECK=%s\n' "$TASKMOOR_UPDATE_CHECK" >> .env
fi

# The port as Compose resolves it: the environment first, then .env, then 8080. grep finds
# nothing on most installs; that must not trip set -e.
port=${TASKMOOR_PORT:-$(grep -E '^TASKMOOR_PORT=' .env 2>/dev/null | cut -d= -f2 || true)}
port=${port:-8080}
# Something listens there: ss sees every address on Linux; elsewhere (a Mac has no ss, and its
# netstat writes addresses another way) a connection to it is tried, as the Builder's kit does.
in_use() {
  if command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | grep -q ":$1 "; then return 0; fi
  (exec 3<>"/dev/tcp/127.0.0.1/$1") >/dev/null 2>&1
}
# A port this stack's own Taskmoor holds is fine (a second run). Compose answers that with a
# container id, or with nothing and success when none runs.
if in_use "$port" && [ -z "$(docker compose -f "$file" ps -q taskmoor 2>/dev/null || true)" ]; then
  die "port $port is in use; set TASKMOOR_PORT in .env"
fi

# TASKMOOR_COMPOSE_OVERRIDE adds compose files (space-separated), for example to put the
# stack on an internal network; TASKMOOR_PULL=never installs from images already loaded
# (the air-gap bundle) and never contacts a registry.
files=(-f "$file")
for extra in ${TASKMOOR_COMPOSE_OVERRIDE:-}; do files+=(-f "$extra"); done
compose() { docker compose "${files[@]}" "$@"; }

say "starting Taskmoor with $file"
compose up -d --quiet-pull --pull "${TASKMOOR_PULL:-missing}"

# Readiness is asked from inside the container, so it works whatever the host's ports,
# firewall or network mode.
ready() {
  compose exec -T taskmoor node -e     "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"     >/dev/null 2>&1
}
say "waiting for the backend"
for _ in $(seq 1 120); do
  if ready; then break; fi
  sleep 1
done
ready || {
  compose logs --tail 40 taskmoor
  die "the backend did not become ready in 2 minutes; the log above says why"
}

# The first start moved an AI key given in .env into encrypted storage (IAM-020); from then on
# the backend ignores it, so it leaves .env. Only once the backend's log says the database holds it.
if grep -Eq '^TASKMOOR_AI_KEY=.' .env 2>/dev/null && (compose logs --no-log-prefix taskmoor 2>/dev/null || true) | grep -Eq '"msg":"AI settings (moved from|in the environment are ignored)'; then
  sed -i.bak '/^TASKMOOR_AI_KEY=/d' .env && rm -f .env.bak
  say "the AI key is in encrypted storage now: removed TASKMOOR_AI_KEY from .env"
fi

# The link line is absent once setup is complete; an empty match is the normal second run.
link=$( (compose logs --no-log-prefix taskmoor 2>/dev/null || true) | grep -o '"link":"[^"]*"' | tail -1 | cut -d'"' -f4 || true)
# Without PUBLIC_URL the backend names its own port in the container, 8080, in the link; the
# browser reaches it on the published one.
public=${PUBLIC_URL:-$(grep -E '^PUBLIC_URL=' .env 2>/dev/null | cut -d= -f2- || true)}
inside=http://localhost:8080/
if [ -z "$public" ] && [ "${link#"$inside"}" != "$link" ]; then
  link="http://localhost:$port/${link#"$inside"}"
fi
say ""
say "Taskmoor is running on port $port."
if [ -n "$link" ]; then
  say "Open this link once to create the administrator:"
  say "  $link"
else
  say "Setup is already complete; sign in at http://127.0.0.1:$port/"
fi
