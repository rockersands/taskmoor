#!/usr/bin/env bash
# The restore drill (M0-030): set up an instance in the Compose kit, back it up, wipe it,
# restore, and prove every table checksum and the setup state came back. Needs the main image
# (TAG) built and Docker Compose.
set -euo pipefail
cd "$(dirname "$0")/../.."
# Git Bash on Windows rewrites /data/... arguments into Windows paths; docker must see them as
# is, while curl and coreutils still need the conversion (/dev/null, $WORK).
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }

TAG=${TAG:-taskmoor:dev}
ID=$$
PROJECT=ts-drill-$ID
PORT=18095
WORK=$(mktemp -d)
# docker cp needs a native path for the host side; Git Bash hands out a POSIX one.
HOST_WORK=$WORK
command -v cygpath >/dev/null 2>&1 && HOST_WORK=$(cygpath -w "$WORK")
cleanup() {
  (cd deploy/compose && POSTGRES_PASSWORD=x TASKMOOR_IMAGE=$TAG docker compose -p "$PROJECT" down -v >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

compose() { (cd deploy/compose && POSTGRES_PASSWORD=drill-$ID TASKMOOR_IMAGE=$TAG TASKMOOR_PORT=$PORT TASKMOOR_SETUP_TOKEN=drill-token-0123456789 docker compose -p "$PROJECT" "$@"); }
app() { docker exec -e TASKMOOR_SETUP_TOKEN=drill-token-0123456789 "$PROJECT-taskmoor-1" "$@"; }
# GNU grep stops reading at the first match when its output goes to /dev/null, and curl then
# fails with a write error (exit 23), so the setup state is read into a variable instead.
expect_setup() {
  local body
  body=$(curl -fsS "http://127.0.0.1:$PORT/api/v1/setup")
  case "$body" in
    *"\"needed\":$1"*) ;;
    *) echo "unexpected setup state: $body"; return 1 ;;
  esac
}
wait_ready() {
  for _ in $(seq 1 120); do curl -fsS "http://127.0.0.1:$PORT/ready" >/dev/null 2>&1 && return 0; sleep 1; done
  docker logs "$PROJECT-taskmoor-1" 2>&1 | tail -20; return 1
}

echo "== start and set up"
compose up -d --quiet-pull >/dev/null
wait_ready
curl -fsS -X POST "http://127.0.0.1:$PORT/api/v1/setup" -H 'content-type: application/json' \
  -d '{"token":"drill-token-0123456789","instanceName":"Drill","admin":{"name":"Drill","email":"drill@example.com","password":"a long enough passphrase"}}' >/dev/null
expect_setup false
app node cli.mjs checksum > "$WORK/before.json"
echo "tables: $(grep -c ':' "$WORK/before.json")"

echo "== backup"
app node cli.mjs backup --out /data/backups/drill | tail -2
app node cli.mjs check-upgrade | grep -E "^ok +backup"
docker cp "$PROJECT-taskmoor-1:/data/backups/drill" "$HOST_WORK/backup" >/dev/null

echo "== wipe and start empty"
compose down -v >/dev/null
compose up -d --quiet-pull >/dev/null
wait_ready
expect_setup true

echo "== restore"
app mkdir -p /data/backups
docker cp "$HOST_WORK/backup" "$PROJECT-taskmoor-1:/data/backups/drill" >/dev/null
app node cli.mjs restore /data/backups/drill --yes | tail -1
app node cli.mjs checksum > "$WORK/after.json"
if diff -q "$WORK/before.json" "$WORK/after.json" >/dev/null; then
  echo "table checksums match"
else
  echo "checksums differ:"; diff "$WORK/before.json" "$WORK/after.json" || true; exit 1
fi
expect_setup false
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/v1/session" -H 'content-type: application/json' \
  -d '{"email":"drill@example.com","password":"a long enough passphrase"}')
test "$code" = "200" && echo "the restored administrator signs in"
echo "== drill passed"
