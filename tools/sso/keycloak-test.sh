#!/usr/bin/env bash
# Single sign-on end to end against a real Keycloak (M1-080): starts Keycloak with the test
# realm in a container, runs apps/server/src/sso/keycloak.e2e.test.ts against it, and removes
# the container. Needs Docker. KEYCLOAK_PORT picks the host port (default 8180).
set -euo pipefail

IMAGE=quay.io/keycloak/keycloak:26.7.4
PORT="${KEYCLOAK_PORT:-8180}"
NAME=taskmoor-keycloak-e2e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# Created, given the realm, then started: no bind mount, so it works the same on every host.
docker create --name "$NAME" -p "127.0.0.1:$PORT:8080" "$IMAGE" start-dev --import-realm >/dev/null
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
stage="$(mktemp -d)"
mkdir "$stage/import"
cp "$HERE/keycloak-realm.json" "$stage/import/taskmoor.json"
docker cp "$stage/import" "$NAME:/opt/keycloak/data/"
rm -rf "$stage"
docker start "$NAME" >/dev/null

issuer="http://localhost:$PORT/realms/taskmoor"
for _ in $(seq 1 120); do
  if curl -sf "$issuer/.well-known/openid-configuration" >/dev/null; then break; fi
  sleep 2
done
if ! curl -sf "$issuer/.well-known/openid-configuration" >/dev/null; then
  echo "keycloak-test: Keycloak did not come up" >&2
  docker logs --tail 50 "$NAME" >&2
  exit 1
fi

cd "$ROOT"
pnpm_cmd=(pnpm)
command -v pnpm >/dev/null 2>&1 || pnpm_cmd=(corepack pnpm)
TASKMOOR_KEYCLOAK_URL="$issuer" "${pnpm_cmd[@]}" verify --only=tests -- apps/server/src/sso/keycloak.e2e.test.ts
