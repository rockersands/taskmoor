#!/usr/bin/env bash
# Builds the image and proves M0-025: /health answers 200 from a web-only container on the
# build machine's architecture and on the other one (amd64 or arm64) under emulation, /ready
# answers 200 next to Postgres, and the image stays under 400 MB. Needs Docker with buildx
# (Docker Desktop and Colima have it). And M1-105: the frontend artefact in the image is the
# image's version, and deep links work with hash routing (redirected to the hash route) and
# with clean URLs (the app shell).
#
#   bash tools/image/smoke.sh            # the host's architecture, then the other under emulation
#   SKIP_EMULATED=1 bash tools/image/smoke.sh   # the host's only (SKIP_ARM64=1 still works)
set -euo pipefail
cd "$(dirname "$0")/../.."

# An amd64 host emulates arm64 (QEMU); an arm64 host such as an Apple silicon Mac emulates
# amd64 (Rosetta or QEMU), so both architectures are checked wherever the script runs.
case "$(docker info --format '{{.Architecture}}')" in
  aarch64 | arm64) NATIVE=arm64 OTHER=amd64 ;;
  *) NATIVE=amd64 OTHER=arm64 ;;
esac

TAG=${TAG:-taskmoor:dev}
VERSION=$(git describe --tags --always 2>/dev/null || echo 0.0.0-dev)
NET=taskmoor-smoke-$$
PG=taskmoor-smoke-pg-$$
APP=taskmoor-smoke-app-$$
cleanup() {
  docker rm -f -v "$APP" "$PG" >/dev/null 2>&1 || true
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

echo "== build $TAG ($VERSION, $NATIVE)"
docker build --build-arg "TASKMOOR_VERSION=$VERSION" -t "$TAG" .
size=$(docker image inspect "$TAG" --format '{{.Size}}')
echo "image size: $((size / 1000000)) MB"
if [ "$size" -gt 400000000 ]; then echo "image over 400 MB"; exit 1; fi

version_of() { # url: the "version" of a JSON answer
  curl -fsS "$1" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1
}

# A page's redirect on the web-only container. packages/devtools/src/image-scripts.test.ts holds
# each expectation below against the server's rules, so the two cannot drift apart.
redirects_to() { # path, expected location
  local got
  got=$(curl -sS -o /dev/null -D - -H 'Accept: text/html' "http://127.0.0.1:18080$1" |
    tr -d '\r' | sed -n 's/^[Ll]ocation: //p')
  [ "$got" = "$2" ] || { echo "$1 went to '$got', not $2"; exit 1; }
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
# A deep link goes to its hash route (M1-105); a link from the tracker an import came from goes
# to its ticket (M1-128, IMP-011).
redirects_to /tickets/ABC-1 /#/tickets/ABC-1
redirects_to /browse/ABC-1 /#/tickets/ABC-1
echo "deep links redirect to their hash routes, imported links to their tickets"
docker rm -f -v "$APP" >/dev/null

echo "== web-only container, clean URLs"
docker run -d --rm --name "$APP" -e TASKMOOR_ROLE=web -e TASKMOOR_WEB_ROUTING=path \
  -p 18080:8080 "$TAG" >/dev/null
wait_for http://127.0.0.1:18080/health 30
shell=$(curl -fsS -H 'Accept: text/html' http://127.0.0.1:18080/tickets/ABC-1)
if ! grep -q '<base href="/" />' <<<"$shell" || ! grep -q '"routing":"path"' <<<"$shell"; then
  echo "deep link under clean URLs did not get the configured app shell"; exit 1
fi
echo "deep link serves the app shell with its runtime configuration"
redirects_to /browse/ABC-1 /tickets/ABC-1
echo "an imported link redirects to its ticket's clean URL"
docker rm -f -v "$APP" >/dev/null

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
docker rm -f -v "$APP" "$PG" >/dev/null

if [ "${SKIP_EMULATED:-${SKIP_ARM64:-}}" != "1" ]; then
  echo "== $OTHER image under emulation (this host is $NATIVE)"
  docker buildx build --platform "linux/$OTHER" --build-arg "TASKMOOR_VERSION=$VERSION" \
    -t "$TAG-$OTHER" --load . >/dev/null
  docker run -d --rm --platform "linux/$OTHER" --name "$APP" -e TASKMOOR_ROLE=web -p 18082:8080 "$TAG-$OTHER" >/dev/null
  wait_for http://127.0.0.1:18082/health 90
  curl -fsS http://127.0.0.1:18082/health; echo
  arch=$(docker image inspect "$TAG-$OTHER" --format '{{.Architecture}}')
  [ "$arch" = "$OTHER" ] || { echo "the emulated image is $arch, not $OTHER"; exit 1; }
  docker rm -f -v "$APP" >/dev/null
fi
echo "== smoke passed"
