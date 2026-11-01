#!/usr/bin/env bash
# M1-113 (NFR-013, OPS-013, OPS-015): the Builder's kits on a fresh machine, end to end, with no
# manual configuration.
#
#   1. The Builder CLI makes both kits from two addresses: the backend at https://localhost:18443
#      and the frontend at http://127.0.0.1:18181/ (another site, so it signs in through OAuth
#      with PKCE), with hash routing for a plain static host.
#   2. A fresh machine starts: a privileged Docker-in-Docker container (tools/image/vm) with an
#      empty image store and nothing but Docker, Compose, bash, curl and unzip. The images come
#      from a saved archive (no registry, as on an air-gapped server, or until images are
#      published at 1.0).
#   3. The backend kit's install.sh runs on it and prints the setup link.
#   4. The frontend kit is unzipped onto a plain static server (python3 -m http.server).
#   5. Playwright (apps/web/e2e/fresh-install.spec.ts) completes the setup through the link,
#      signs in on the frontend, creates a ticket, opens a board, searches, and sees an update
#      made elsewhere arrive live.
#
# The time from the machine's start to the first sign-in must stay under 15 minutes.
#
# Needs Docker and the image built as $TAG, for example by tools/image/smoke.sh. Behind a proxy
# that re-signs TLS, set BUILD_CA to its CA file (the VM image's build needs it).
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG=${TAG:-taskmoor:dev}
VM_IMAGE=${VM_IMAGE:-taskmoor-vm:dev}
BACKEND=https://localhost:18443
FRONTEND_PORT=18181
FRONTEND=http://127.0.0.1:$FRONTEND_PORT/
VM=taskmoor-fresh-vm-$$
LIMIT_SECONDS=900

mkdir -p .cache
WORK=$(mktemp -d "$PWD/.cache/fresh-vm.XXXXXX")
STATIC_PID=
cleanup() {
  [ -n "$STATIC_PID" ] && kill "$STATIC_PID" 2>/dev/null || true
  docker rm -f -v "$VM" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== the fresh machine's image"
secret=()
[ -n "${BUILD_CA:-}" ] && secret=(--secret "id=build_ca,src=$BUILD_CA" --network host)
docker build -q "${secret[@]}" -t "$VM_IMAGE" tools/image/vm >/dev/null

echo "== the kits ($TAG)"
VERSION=$(docker run --rm --entrypoint cat "$TAG" /app/web/version.json |
  sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
# The kits carry the image's own web build: the backend refuses a frontend of another version.
cid=$(docker create "$TAG")
docker cp "$cid:/app/web" "$WORK/web" >/dev/null
docker rm -v "$cid" >/dev/null
node node_modules/tsx/dist/cli.mjs packages/devtools/src/cli/builder.ts \
  --backend-url "$BACKEND" --frontend-url "$FRONTEND" --routing hash \
  --web "$WORK/web" --out "$WORK/kits" --version "$VERSION" >/dev/null
ls "$WORK/kits"
# The images the kit's Compose file names besides Taskmoor's own (its database and Caddy).
others=$(unzip -p "$WORK/kits/taskmoor-backend-kit.zip" docker-compose.yml |
  sed -n 's/^ *image: *\([^$ ]*\) *$/\1/p' | sort -u)
for image in $others; do
  docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null
done
# The kit names the image it was made for; this run's image stands in for it.
pinned=$(unzip -p "$WORK/kits/taskmoor-backend-kit.zip" .env | sed -n 's/^TASKMOOR_IMAGE=//p')
docker tag "$TAG" "$pinned"
# shellcheck disable=SC2086
docker save "$TAG" "$pinned" $others -o "$WORK/images.tar"

echo "== a fresh machine starts"
started=$(date +%s)
docker run -d --privileged --name "$VM" -p 18443:18443 -p 18080:18080 "$VM_IMAGE" >/dev/null
for _ in $(seq 1 60); do docker exec "$VM" docker info >/dev/null 2>&1 && break; sleep 1; done
docker exec "$VM" docker info >/dev/null
docker exec "$VM" sh -c 'docker images -q | wc -l' | grep -qx 0 || {
  echo "the machine is not fresh"
  exit 1
}
docker cp "$WORK/images.tar" "$VM:/root/images.tar"
docker cp "$WORK/kits/taskmoor-backend-kit.zip" "$VM:/root/kit.zip"
docker exec "$VM" sh -c 'docker load -q -i /root/images.tar >/dev/null && rm /root/images.tar'

echo "== install.sh on it"
out=$(docker exec "$VM" bash -c 'mkdir -p /root/taskmoor && cd /root/taskmoor && unzip -q /root/kit.zip &&
  TASKMOOR_PULL=never TASKMOOR_HTTP_PORT=18080 TASKMOOR_HTTPS_PORT=18443 bash install.sh')
echo "$out" | tail -4
setup=$(grep -o "$BACKEND/#/setup?token=[A-Za-z0-9_.~-]*" <<<"$out" | head -1)
[ -n "$setup" ] || {
  echo "no setup link"
  exit 1
}
installed=$(date +%s)
echo "installed in $((installed - started)) s"

echo "== the frontend kit on a plain static server at $FRONTEND"
mkdir "$WORK/site"
(cd "$WORK/site" && unzip -q "$WORK/kits/taskmoor-frontend-kit.zip")
python3 -m http.server "$FRONTEND_PORT" --bind 127.0.0.1 --directory "$WORK/site" \
  >"$WORK/static.log" 2>&1 &
STATIC_PID=$!
for _ in $(seq 1 30); do curl -fsS "$FRONTEND" >/dev/null 2>&1 && break; sleep 0.5; done

echo "== the full journey in a browser"
(cd apps/web && TASKMOOR_FRESH_SETUP_LINK="$setup" TASKMOOR_FRESH_BACKEND="$BACKEND" \
  TASKMOOR_FRESH_FRONTEND="$FRONTEND" TASKMOOR_FRESH_MARK="$WORK/signed-in" \
  npx playwright test --config playwright.fresh.config.ts)
signed_in=$(cat "$WORK/signed-in")
total=$((signed_in - started))
echo "fresh machine to first sign-in: $total s (limit $LIMIT_SECONDS s)"
[ "$total" -le "$LIMIT_SECONDS" ] || {
  echo "over the limit"
  exit 1
}
echo "== fresh machine passed"
