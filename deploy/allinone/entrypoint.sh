#!/bin/sh
# Starts PostgreSQL in the container, upgrades the database when the image is newer than it
# (OPS-006), then starts the Taskmoor server as the unprivileged node user. Postgres listens on
# 127.0.0.1 only and trusts local connections, which is the container's own process; nothing
# else can reach it. The database lives under $TASKMOOR_DATA/postgres and survives container
# restarts and image upgrades through the /data volume.
#
#   taskmoor-allinone                       start: upgrade when needed, then serve
#   taskmoor-allinone upgrade [--dry-run]   only the upgrade, by hand (also retries one that
#                                           failed at start), then stop
set -eu

DATA=${TASKMOOR_DATA:-/data}
PGDATA="$DATA/postgres"
LOG="$PGDATA/postgres.log"

mkdir -p "$PGDATA" "$DATA/files"
chown -R postgres:postgres "$PGDATA"
chown node:node "$DATA" "$DATA/files"

if [ ! -f "$PGDATA/PG_VERSION" ]; then
  echo "allinone: initialising PostgreSQL in $PGDATA"
  su-exec postgres initdb -D "$PGDATA" -U postgres --auth=trust --encoding=UTF8 --locale=C >/dev/null
  {
    echo "listen_addresses = '127.0.0.1'"
    echo "shared_buffers = '256MB'"
    echo "log_min_messages = warning"
  } >> "$PGDATA/postgresql.conf"
fi

# A container stopped without its shutdown (docker rm -f, out of memory, a host crash) leaves
# PostgreSQL's lock file behind. In the next container its process id may belong to another
# process, and PostgreSQL then refuses to start, taking it for a running server. Only this
# container runs PostgreSQL on the volume (one container per volume), so a lock file whose
# process is not a postgres here is stale.
if [ -f "$PGDATA/postmaster.pid" ]; then
  pid=$(head -n 1 "$PGDATA/postmaster.pid")
  if [ "$(cat "/proc/$pid/comm" 2>/dev/null)" != "postgres" ]; then
    echo "allinone: PostgreSQL did not shut down cleanly last time; removing its stale lock file"
    rm -f "$PGDATA/postmaster.pid"
  fi
fi

su-exec postgres pg_ctl -D "$PGDATA" -w -t 60 -l "$LOG" start
if ! su-exec postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'taskmoor'" | grep -q 1; then
  su-exec postgres createdb -U postgres taskmoor
fi

export DATABASE_URL=${DATABASE_URL:-postgres://postgres@127.0.0.1:5432/taskmoor}
cd /app

stop_postgres() { su-exec postgres pg_ctl -D "$PGDATA" -m fast -w -t 60 stop >/dev/null || true; }

if [ "${1:-}" = "upgrade" ]; then
  shift
  code=0
  su-exec node node cli.mjs upgrade "$@" || code=$?
  stop_postgres
  exit "$code"
fi

# A newer image upgrades the database before serving: pre-flight checks, a backup under
# $DATA/backups/pre-upgrade-<time>, the migrations, a check of the result, and a rollback when
# anything fails. A failed upgrade is not tried again at the next start (--unattended), so a
# restarting container never piles up backups: start the previous image again, or retry with
# `docker run --rm -v <volume>:/data <image> upgrade`.
code=0
su-exec node node cli.mjs upgrade --unattended || code=$?
if [ "$code" -ne 0 ]; then
  echo "allinone: not starting: the upgrade did not complete (exit $code); the report above says why"
  stop_postgres
  exit "$code"
fi

su-exec node node server.mjs &
APP=$!

stop() {
  echo "allinone: stopping"
  kill -TERM "$APP" 2>/dev/null || true
  wait "$APP" 2>/dev/null || true
  su-exec postgres pg_ctl -D "$PGDATA" -m fast -w -t 60 stop >/dev/null
  exit 0
}
trap stop TERM INT

code=0
wait "$APP" || code=$?
stop_postgres
exit "$code"
