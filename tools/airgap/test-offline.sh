#!/usr/bin/env bash
# The air-gap test (M1-100, OPS-005): build a bundle signed with a throwaway key, show that a
# changed file and a wrong key are both refused, then install from the bundle on an internal
# Docker network that has no route out. The images are removed from the local Docker first,
# so they can only come from the bundle's archives.
#   TAG=taskmoor:dev bash tools/airgap/test-offline.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
# Git Bash: docker must see container paths as written, other tools need path conversion.
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }
host() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

TAG=${TAG:-taskmoor:dev}
ID=$$
VERSION=airgap-$ID
APP=taskmoor-airgap:$ID
DB=taskmoor-airgap-postgres:$ID
PROJECT=ts-airgap-$ID
WORK=$(mktemp -d)
cleanup() {
  (cd "$WORK/out/taskmoor-$VERSION/compose" 2>/dev/null && COMPOSE_PROJECT_NAME=$PROJECT \
    POSTGRES_PASSWORD=x docker compose -f docker-compose.yml down -v >/dev/null 2>&1) || true
  docker rmi "$APP" "$DB" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== bundle"
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/key.pem" 2>/dev/null
openssl ec -in "$WORK/key.pem" -pubout -out "$WORK/cosign.pub" 2>/dev/null
docker tag "$TAG" "$APP"
docker image inspect postgres:16.10-alpine >/dev/null 2>&1 || docker pull -q postgres:16.10-alpine >/dev/null
docker tag postgres:16.10-alpine "$DB"
TASKMOOR_IMAGE=$APP POSTGRES_IMAGE=$DB SIGNING_KEY="$WORK/key.pem" PUBLIC_KEY="$WORK/cosign.pub" \
  bash tools/airgap/bundle.sh "$VERSION" "$WORK/out"
B="$WORK/out/taskmoor-$VERSION"
grep -q '"bomFormat": *"CycloneDX"' "$B/sbom.cdx.json" && echo "SBOM: CycloneDX"

echo "== tampering is refused"
cp -r "$B" "$WORK/tampered"
echo "# changed" >> "$WORK/tampered/compose/install.sh"
if bash "$WORK/tampered/verify.sh" >/dev/null 2>&1; then echo "a changed file passed"; exit 1; fi
echo "a changed file is refused"
openssl ecparam -name prime256v1 -genkey -noout -out "$WORK/other.pem" 2>/dev/null
openssl ec -in "$WORK/other.pem" -pubout -out "$WORK/other.pub" 2>/dev/null
if bash "$B/verify.sh" "$WORK/other.pub" >/dev/null 2>&1; then echo "a wrong key passed"; exit 1; fi
echo "a key other than the signer's is refused"

echo "== offline install"
docker rmi "$APP" "$DB" >/dev/null
cat > "$WORK/internal.yml" <<'YAML'
# No route out: containers on an internal network reach each other and nothing else.
networks:
  default:
    internal: true
YAML
log="$WORK/install.log"
COMPOSE_PROJECT_NAME=$PROJECT TASKMOOR_PORT=18120 \
  TASKMOOR_COMPOSE_OVERRIDE="$(host "$WORK/internal.yml")" \
  bash "$B/install-offline.sh" "$B/cosign.pub" | tee "$log"
grep -q "setup?token=" "$log" || { echo "no setup link printed"; exit 1; }

echo "== no egress"
cd "$B/compose"
if COMPOSE_PROJECT_NAME=$PROJECT docker compose exec -T taskmoor node -e \
  "fetch('https://example.com', { signal: AbortSignal.timeout(8000) }).then(() => process.exit(0), () => process.exit(1))"; then
  echo "the container reached the internet; the test network is not offline"
  exit 1
fi
echo "the running instance has no route to the internet"
echo "== air-gap test passed"
