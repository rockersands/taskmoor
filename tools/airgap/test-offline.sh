#!/usr/bin/env bash
# The air-gap test (M1-100, OPS-005): build a bundle signed with a throwaway key, show that a
# changed file and a wrong key are both refused, then install from the bundle on an internal
# Docker network that has no route out. The images are removed from the local Docker first,
# so they can only come from the bundle's archives. There, the bundled embedding model embeds
# new tickets and finds a similar one (M1-078, AI-012 (1)).
#   TAG=taskmoor:dev bash tools/airgap/test-offline.sh
set -euo pipefail
cd "$(dirname "$0")/../.."
ROOT=$(pwd)
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
# The database image bundle.sh takes by default: the one the bundled Compose kit names.
KIT_DB=$(sed -n 's/^ *image: \${POSTGRES_IMAGE:-\([^}]*\)}.*$/\1/p' deploy/compose/docker-compose.yml | head -1)
docker image inspect "$KIT_DB" >/dev/null 2>&1 || docker pull -q "$KIT_DB" >/dev/null
docker tag "$KIT_DB" "$DB"
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
grep -qx 'TASKMOOR_UPDATE_CHECK=off' .env || { echo "the new-version check is not off in .env"; exit 1; }
echo "the new-version check is off (OPS-026)"

echo "== embeddings offline (M1-078)"
# The bundled model embeds new tickets and finds a similar one, with no AI key and no route out.
token=$(sed -n 's/.*setup?token=\([A-Za-z0-9_-]*\).*/\1/p' "$log" | head -1)
COMPOSE_PROJECT_NAME=$PROJECT docker compose exec -T taskmoor node --input-type=module - "$token" \
  < "$ROOT/tools/airgap/check-embeddings.mjs"
COMPOSE_PROJECT_NAME=$PROJECT docker compose logs taskmoor 2>/dev/null | grep -o '"msg":"similar tickets[^"]*"' | head -1
echo "== air-gap test passed"
