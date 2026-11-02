#!/usr/bin/env bash
# One-command upgrade of the Compose kit (OPS-006, ADR-022):
#
#   bash upgrade.sh <image>             for example: bash upgrade.sh ghcr.io/rockersands/taskmoor:1.4.0
#   bash upgrade.sh <image> --dry-run   the checks and the plan only; nothing changes or stops
#
# It pulls the image when it is missing, makes the database's TLS certificate when the kit has
# none yet (ADR-111), stops the backend (PostgreSQL keeps running), runs
# `node cli.mjs upgrade` from the new image (pre-flight checks, a backup under
# /data/backups/pre-upgrade-<time>, the migrations, a check of the result, and a rollback when
# anything fails), then starts the new image and records it in .env. When the upgrade fails,
# the database is as it was and the previous image starts again. Exit codes: 0 upgraded (or
# nothing to do), 1 not upgraded and running the previous image, 3 the rollback failed too:
# the backend stays stopped and the output says which backup to restore.
#
# Like install.sh it uses docker-compose.external.yml when DATABASE_URL is set (in the
# environment or .env), honours TASKMOOR_COMPOSE_OVERRIDE, and TASKMOOR_PULL=never never
# contacts a registry.
set -euo pipefail
cd "$(dirname "$0")"

say() { printf '%s\n' "$*"; }
die() { say "upgrade: $1" >&2; exit "${2:-1}"; } # message, exit code (1)

new=${1:-}
[ -n "$new" ] && [ "${new#-}" = "$new" ] || die "usage: bash upgrade.sh <image> [--dry-run]" 2
dry=
if [ "${2:-}" = "--dry-run" ]; then dry=--dry-run; elif [ -n "${2:-}" ]; then die "unknown option ${2}" 2; fi

command -v docker >/dev/null 2>&1 || die "Docker is not installed"
docker compose version >/dev/null 2>&1 || die "Docker Compose v2 is missing (the 'docker compose' command)"

if [ -n "${DATABASE_URL:-}" ] || grep -qE '^DATABASE_URL=' .env 2>/dev/null; then
  file=docker-compose.external.yml
else
  file=docker-compose.yml
fi
files=(-f "$file")
for extra in ${TASKMOOR_COMPOSE_OVERRIDE:-}; do files+=(-f "$extra"); done
compose() { docker compose "${files[@]}" "$@"; }

# The image running now is the one to go back to; without a container, the configured one.
running=$(compose ps -q taskmoor 2>/dev/null || true)
old=
if [ -n "$running" ]; then old=$(docker inspect --format '{{.Config.Image}}' "$running" 2>/dev/null || true); fi
if [ -z "$old" ]; then
  old=${TASKMOOR_IMAGE:-$(grep -E '^TASKMOOR_IMAGE=' .env 2>/dev/null | cut -d= -f2- || true)}
fi
old=${old:-taskmoor:dev}

if ! docker image inspect "$new" >/dev/null 2>&1; then
  [ "${TASKMOOR_PULL:-missing}" != never ] || die "$new is not loaded and TASKMOOR_PULL=never"
  say "pulling $new"
  docker pull "$new" >/dev/null
fi

# The new image's command line against this kit's database and data volume. Its password
# stays in the container's environment, never on a command line.
upgrade() { TASKMOOR_IMAGE=$new compose run --rm -T taskmoor node cli.mjs upgrade "$@"; }

ready() {
  compose exec -T taskmoor node -e \
    "fetch('http://127.0.0.1:8080/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}
start() { # image
  TASKMOOR_IMAGE=$1 compose up -d taskmoor >/dev/null
  for _ in $(seq 1 120); do
    if ready; then return 0; fi
    sleep 1
  done
  compose logs --tail 40 taskmoor
  die "the backend ($1) did not become ready in 2 minutes; the log above says why"
}

# TLS to the bundled PostgreSQL (ASVS 1.9.1, ADR-111). A kit file with the postgres-tls service
# makes the certificate when it is missing, and PostgreSQL restarts with TLS once when it ran
# without it (an install from before, given the new kit file). Compose does both on `up`.
tls=
if [ "$file" = docker-compose.yml ] && compose config --services 2>/dev/null | grep -qx postgres-tls; then
  tls=yes
fi
db_ssl() { compose exec -T postgres psql -U taskmoor -d taskmoor -tAc 'SHOW ssl' 2>/dev/null | tr -d '[:space:]' || true; }
db_ready() { compose exec -T postgres pg_isready -U taskmoor -d taskmoor >/dev/null 2>&1; }

if [ -n "$dry" ]; then
  say "dry run of the upgrade from $old to $new (the backend keeps running)"
  if [ -n "$tls" ] && [ "$(db_ssl)" != on ]; then
    say "PostgreSQL runs without TLS: the upgrade first makes its certificate and restarts it once with TLS (ADR-111); the database checks run then"
    exit 0
  fi
  upgrade --dry-run
  exit $?
fi

if [ -n "$tls" ]; then
  say "checking the database certificate (TLS to PostgreSQL)"
  compose up -d postgres >/dev/null
  for _ in $(seq 1 60); do
    if db_ready; then break; fi
    sleep 1
  done
  db_ready || die "PostgreSQL did not come back with TLS; see: docker compose logs postgres-tls postgres"
fi

say "upgrading from $old to $new; the backend stops for the backup and the migrations"
compose stop taskmoor >/dev/null
set +e
upgrade
code=$?
set -e

if [ "$code" -eq 0 ]; then
  if [ -f .env ]; then
    if grep -qE '^TASKMOOR_IMAGE=' .env; then
      sed -i.bak "s|^TASKMOOR_IMAGE=.*|TASKMOOR_IMAGE=$new|" .env && rm -f .env.bak
    else
      printf 'TASKMOOR_IMAGE=%s\n' "$new" >> .env
    fi
    say "recorded TASKMOOR_IMAGE=$new in .env"
  else
    say "no .env here: set TASKMOOR_IMAGE=$new wherever you keep this kit's settings"
  fi
  start "$new"
  say "Taskmoor $new is running."
  exit 0
fi
if [ "$code" -eq 3 ]; then
  die "the upgrade and its rollback failed; the backend stays stopped. Restore the pre-upgrade backup named above with: TASKMOOR_IMAGE=$new docker compose ${files[*]} run --rm taskmoor node cli.mjs restore <dir> --yes" 3
fi
say "the upgrade did not complete; the database is as it was. Starting $old again."
start "$old"
die "not upgraded: see the report above; $old is running"
