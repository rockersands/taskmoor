#!/usr/bin/env bash
# Directory sync end to end against a real OpenLDAP (M1-082 done-when: 10,000 people in groups
# nested four levels deep, synced in under two minutes). Builds a small slapd image from
# tools/ldap/Dockerfile, loads a generated directory, runs
# apps/server/src/ldap/openldap.e2e.test.ts against it over StartTLS, and removes the container.
# Every password and the TLS key are made here per run and live only in the container and this
# process. Needs Docker, openssl and Node.
#
#   bash tools/ldap/openldap-test.sh
#   TASKMOOR_OPENLDAP_PEOPLE=100000 bash tools/ldap/openldap-test.sh    # IAM-005 (1)'s size
#   bash tools/ldap/openldap-test.sh --local    # this machine's slapd instead of Docker
#
# --local runs the same configuration with an installed slapd (Debian or Ubuntu: apt-get
# install slapd ldap-utils) in a temporary folder, for machines without Docker.
# OPENLDAP_PORT picks the port (default 3389).
set -euo pipefail

IMAGE=taskmoor-openldap-e2e
NAME=taskmoor-openldap-e2e
PORT="${OPENLDAP_PORT:-3389}"
PEOPLE="${TASKMOOR_OPENLDAP_PEOPLE:-10000}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

secret() { head -c 30 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32; }
export TASKMOOR_OPENLDAP_ROOT_PASSWORD="$(secret)"
export TASKMOOR_OPENLDAP_BIND_PASSWORD="$(secret)"
export TASKMOOR_OPENLDAP_USER_PASSWORD="$(secret)"

LOCAL=0
[ "${1:-}" = "--local" ] && LOCAL=1

stage="$(mktemp -d)"
cleanup() {
  if [ "$LOCAL" = 1 ]; then
    [ -f "$stage/slapd/run/slapd.pid" ] && kill "$(cat "$stage/slapd/run/slapd.pid")" 2>/dev/null || true
  else
    docker rm -f "$NAME" >/dev/null 2>&1 || true
  fi
  rm -rf "$stage"
}
trap cleanup EXIT

mkdir -p "$stage/tls" "$stage/seed"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost" \
  -keyout "$stage/tls/key.pem" -out "$stage/tls/cert.pem" 2>/dev/null
node "$HERE/generate-ldif.mjs" "$PEOPLE" "$stage/seed/directory.ldif"

run_tests() {
  cd "$ROOT"
  local pnpm_cmd=(pnpm)
  command -v pnpm >/dev/null 2>&1 || pnpm_cmd=(corepack pnpm)
  TASKMOOR_OPENLDAP_URL="ldap://localhost:$PORT" \
    TASKMOOR_OPENLDAP_CA="$stage/tls/cert.pem" \
    TASKMOOR_OPENLDAP_PEOPLE="$PEOPLE" \
    "${pnpm_cmd[@]}" verify --only=tests -- apps/server/src/ldap/openldap.e2e.test.ts
}

if [ "$LOCAL" = 1 ]; then
  dir="$stage/slapd"
  mkdir -p "$dir/db" "$dir/run"
  hash="$(slappasswd -s "$TASKMOOR_OPENLDAP_ROOT_PASSWORD")"
  sed -e "s|@ROOT_PASSWORD_HASH@|$hash|" \
    -e "s|/etc/ldap/taskmoor/tls|$stage/tls|" \
    -e "s|/var/lib/ldap|$dir/db|" \
    -e "s|/run/slapd|$dir/run|" \
    "$HERE/slapd.conf" >"$dir/slapd.conf"
  slapadd -q -f "$dir/slapd.conf" -l "$stage/seed/directory.ldif"
  slapd -f "$dir/slapd.conf" -h "ldap://localhost:$PORT/"
  for _ in $(seq 1 60); do
    ldapsearch -x -H "ldap://localhost:$PORT" -b "" -s base namingContexts >/dev/null 2>&1 && break
    sleep 1
  done
  run_tests
  exit 0
fi

docker build -q -t "$IMAGE" "$HERE" >/dev/null
docker rm -f "$NAME" >/dev/null 2>&1 || true
# Created, given the directory and the certificate, then started: no bind mount, so it works
# the same on every host.
docker create --name "$NAME" -p "127.0.0.1:$PORT:389" \
  -e LDAP_ROOT_PASSWORD="$TASKMOOR_OPENLDAP_ROOT_PASSWORD" "$IMAGE" >/dev/null
docker cp "$stage/seed" "$NAME:/etc/ldap/taskmoor/"
docker cp "$stage/tls" "$NAME:/etc/ldap/taskmoor/"
docker start "$NAME" >/dev/null

ready=0
for _ in $(seq 1 120); do
  if docker exec "$NAME" ldapsearch -x -H ldap://localhost -b "" -s base namingContexts >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 1
done
if [ "$ready" != 1 ]; then
  echo "openldap-test: slapd did not come up" >&2
  docker logs --tail 50 "$NAME" >&2
  exit 1
fi

run_tests
