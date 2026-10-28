#!/usr/bin/env bash
# The restore benchmark (M1-101, done-when "1M-ticket restore < 30 min"): a database with
# TICKETS synthetic tickets (default 1,000,000) and their history, a backup with the operator
# CLI, then the restore drill, which restores into a scratch database, checks every table and
# reports each step's time. Everything it creates is removed at the end.
#
#   ADMIN_URL=postgres://postgres@localhost:5432/postgres bash tools/backup/bench-restore.sh [TICKETS]
#
# The password comes from PGPASSWORD or ~/.pgpass (or the URL in your shell), never from a file
# in the repository.
# Needs psql, pg_dump and pg_restore of the server's major version, and about 4 GB of disk per
# million tickets (the database, the backup and the scratch copy). WORK names the directory for
# the backup (default: a temporary one).
set -euo pipefail
cd "$(dirname "$0")/../.."

TICKETS=${1:-1000000}
PER_TRACK=$(( (TICKETS + 9) / 10 ))
: "${ADMIN_URL:?set ADMIN_URL to a connection that may create databases}"
NAME=taskmoor_bench_restore_$$
DB_URL=$(node -e 'const u = new URL(process.argv[1]); u.pathname = "/" + process.argv[2]; console.log(u.toString())' "$ADMIN_URL" "$NAME")
WORK=${WORK:-$(mktemp -d)}
CLI=(node apps/server/node_modules/tsx/dist/cli.mjs apps/server/src/cli.ts)
cleanup() {
  psql "$ADMIN_URL" -qc "DROP DATABASE IF EXISTS $NAME WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK/data"
}
trap cleanup EXIT

seconds() { echo "$(( $2 - $1 ))"; }
now() { date +%s; }

echo "== database $NAME with $((PER_TRACK * 10)) tickets"
psql "$ADMIN_URL" -qc "CREATE DATABASE $NAME"
DATABASE_URL=$DB_URL "${CLI[@]}" migrate >/dev/null
t0=$(now)
psql "$DB_URL" -q -v per_track="$PER_TRACK" -f tools/backup/seed-tickets.sql
echo "seeded in $(seconds "$t0" "$(now)") s"

echo "== backup"
mkdir -p "$WORK/data"
t0=$(now)
DATABASE_URL=$DB_URL TASKMOOR_DATA="$WORK/data" "${CLI[@]}" backup | tail -1
echo "backup took $(seconds "$t0" "$(now)") s; $(du -sh "$WORK/data/backups" | cut -f1) on disk"

echo "== restore drill"
t0=$(now)
DATABASE_URL=$DB_URL TASKMOOR_DATA="$WORK/data" "${CLI[@]}" drill | grep -v '^{'
echo "drill took $(seconds "$t0" "$(now)") s in all"

echo "== restore in place (replaces the benchmark database, as node cli.mjs restore does)"
t0=$(now)
DATABASE_URL=$DB_URL TASKMOOR_DATA="$WORK/data" "${CLI[@]}" restore "$(ls -d "$WORK"/data/backups/*/ | head -1)" --yes | tail -1
echo "restore took $(seconds "$t0" "$(now)") s"
