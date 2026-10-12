#!/bin/sh
# Starts PostgreSQL in the container, then the Taskmoor server as the unprivileged node user.
# Postgres listens on 127.0.0.1 only and trusts local connections, which is the container's own
# process; nothing else can reach it. The database lives under $TASKMOOR_DATA/postgres and
# survives container restarts and image upgrades through the /data volume.
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

su-exec postgres pg_ctl -D "$PGDATA" -w -t 60 -l "$LOG" start
if ! su-exec postgres psql -U postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'taskmoor'" | grep -q 1; then
  su-exec postgres createdb -U postgres taskmoor
fi

export DATABASE_URL=${DATABASE_URL:-postgres://postgres@127.0.0.1:5432/taskmoor}
cd /app
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

wait "$APP"
code=$?
su-exec postgres pg_ctl -D "$PGDATA" -m fast -w -t 60 stop >/dev/null || true
exit "$code"
