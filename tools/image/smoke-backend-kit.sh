#!/usr/bin/env bash
# The Builder's backend kit end to end (M1-110; OPS-015): makes a kit for https://localhost with
# the Builder CLI, runs its install.sh against the image built as $TAG (no registry), and checks
# that it reaches health behind Caddy's HTTPS, prints the setup link, and serves the kit's own
# instance identity at /api/meta. Ports 18080 and 18443 stand in for 80 and 443. Needs Docker
# and the image (tools/image/smoke.sh builds it). The fresh-VM run with real DNS is the nightly
# matrix's job.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG=${TAG:-taskmoor:dev}
# Inside the checkout, not the system temp folder: Colima and Docker Desktop on a Mac share only
# the home folder with their VM, so a kit elsewhere could not mount its Caddyfile.
mkdir -p .cache
WORK=$(mktemp -d "$PWD/.cache/kit-smoke.XXXXXX")
cleanup() {
  (cd "$WORK/kit" 2>/dev/null && docker compose down -v >/dev/null 2>&1) || true
  rm -rf "$WORK"
}
trap cleanup EXIT

# The image's own version: the kit pins it, and the backend refuses a frontend of another.
VERSION=$(docker run --rm --entrypoint cat "$TAG" /app/web/version.json | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
echo "== kit for https://localhost:18443 ($TAG, version $VERSION)"
node node_modules/tsx/dist/cli.mjs packages/devtools/src/cli/builder.ts \
  --backend-url https://localhost:18443 --frontend-url https://localhost:18443/ \
  --out "$WORK/out" --version "$VERSION" >/dev/null
mkdir "$WORK/kit"
(cd "$WORK/kit" && unzip -q "$WORK/out/taskmoor-backend-kit.zip")
instance=$(sed -n 's/^TASKMOOR_INSTANCE_ID=//p' "$WORK/kit/.env")

echo "== install.sh"
out=$(cd "$WORK/kit" && TASKMOOR_IMAGE=$TAG TASKMOOR_PULL=missing TASKMOOR_HTTP_PORT=18080 TASKMOOR_HTTPS_PORT=18443 bash install.sh)
echo "$out" | tail -4
grep -q "https://localhost:18443/#/setup?token=" <<<"$out" || { echo "no setup link"; exit 1; }

echo "== through Caddy's HTTPS"
for _ in $(seq 1 30); do curl -fsSk https://localhost:18443/health >/dev/null 2>&1 && break; sleep 1; done
curl -fsSk https://localhost:18443/health; echo
served=$(curl -fsSk https://localhost:18443/api/meta | sed -n 's/.*"instance":{"id":"\([^"]*\)".*/\1/p')
[ "$served" = "$instance" ] || { echo "meta serves instance $served, the kit made $instance"; exit 1; }
echo "the backend serves the kit's instance $instance"

echo "== install.sh again: nothing to do, setup still offered until it is done"
(cd "$WORK/kit" && TASKMOOR_IMAGE=$TAG TASKMOOR_PULL=missing TASKMOOR_HTTP_PORT=18080 TASKMOOR_HTTPS_PORT=18443 bash install.sh | tail -1)
echo "== backend kit passed"
