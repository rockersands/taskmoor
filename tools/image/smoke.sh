#!/usr/bin/env bash
# Builds the image and proves M0-025: /health answers 200 from a web-only container on the
# build machine's architecture and under arm64 emulation, /ready answers 200 next to Postgres,
# and the image stays under 400 MB. Needs Docker with buildx (Docker Desktop has it).
# And M1-105: the frontend artefact in the image is the image's version, and deep links work
# with hash routing (redirected to the hash route) and with clean URLs (the app shell).
#
#   bash tools/image/smoke.sh            # amd64 (or the host's) plus arm64 under QEMU
#   SKIP_ARM64=1 bash tools/image/smoke.sh
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG=${TAG:-taskmoor:dev}
VERSION=$(git describe --tags --always 2>/dev/null || echo 0.0.0-dev)
NET=taskmoor-smoke-$$
PG=taskmoor-smoke-pg-$$
APP=taskmoor-smoke-app-$$
cleanup() {
  docker rm -f "$APP" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() { # url, seconds
  for _ in $(seq 1 "$2"); do
    if curl -fsS "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "no answer from $1 after $2 s"; docker logs "$APP" 2>&1 | tail -20; return 1
}

echo "== build $TAG ($VERSION)"
docker build --build-arg "TASKMOOR_VERSION=$VERSION" -t "$TAG" .
size=$(docker image inspect "$TAG" --format '{{.Size}}')
echo "image size: $((size / 1000000)) MB"
if [ "$size" -gt 400000000 ]; then echo "image over 400 MB"; exit 1; fi

version_of() { # url: the "version" of a JSON answer
  curl -fsS "$1" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1
}

echo "== web-only container, no database, hash routing"
docker run -d --rm --name "$APP" -e TASKMOOR_ROLE=web -p 18080:8080 "$TAG" >/dev/null
wait_for http://127.0.0.1:18080/health 30
curl -fsS http://127.0.0.1:18080/health; echo
server=$(version_of http://127.0.0.1:18080/health)
web=$(version_of http://127.0.0.1:18080/version.json)
if [ "$server" != "$VERSION" ] || [ "$web" != "$VERSION" ]; then
  echo "versions differ: image $VERSION, server $server, frontend $web"; exit 1
fi
echo "frontend artefact and server are both $VERSION"
deep=$(curl -sS -o /dev/null -D - -H 'Accept: text/html' http://127.0.0.1:18080/browse/ABC-1 \
  | tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
if [ "$deep" != "/#/browse/ABC-1" ]; then
  echo "deep link under hash routing went to: $deep"; exit 1
fi
echo "deep link redirects to its hash route"
docker rm -f "$APP" >/dev/null

echo "== web-only container, clean URLs"
docker run -d --rm --name "$APP" -e TASKMOOR_ROLE=web -e TASKMOOR_WEB_ROUTING=path \
  -p 18080:8080 "$TAG" >/dev/null
wait_for http://127.0.0.1:18080/health 30
shell=$(curl -fsS -H 'Accept: text/html' http://127.0.0.1:18080/browse/ABC-1)
if ! grep -q '<base href="/" />' <<<"$shell" || ! grep -q '"routing":"path"' <<<"$shell"; then
  echo "deep link under clean URLs did not get the configured app shell"; exit 1
fi
echo "deep link serves the app shell with its runtime configuration"
docker rm -f "$APP" >/dev/null

echo "== all roles next to Postgres 16"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=smoke postgres:16 >/dev/null # secret-scan: allow
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
# No --rm here: a crashed container keeps its logs for wait_for to print; cleanup removes it.
docker run -d --name "$APP" --network "$NET" -p 18081:8080 \
  -e DATABASE_URL=postgres://postgres:smoke@$PG:5432/postgres "$TAG" >/dev/null # secret-scan: allow
wait_for http://127.0.0.1:18081/ready 60
curl -fsS http://127.0.0.1:18081/ready; echo
curl -fsS http://127.0.0.1:18081/health; echo
docker rm -f "$APP" "$PG" >/dev/null

if [ "${SKIP_ARM64:-}" != "1" ]; then
  echo "== arm64 image under emulation"
  docker buildx build --platform linux/arm64 --build-arg "TASKMOOR_VERSION=$VERSION" \
    -t "$TAG-arm64" --load . >/dev/null
  docker run -d --rm --platform linux/arm64 --name "$APP" -e TASKMOOR_ROLE=web -p 18082:8080 "$TAG-arm64" >/dev/null
  wait_for http://127.0.0.1:18082/health 90
  curl -fsS http://127.0.0.1:18082/health; echo
  docker rm -f "$APP" >/dev/null
fi
echo "== smoke passed"
