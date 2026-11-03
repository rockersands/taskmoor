#!/usr/bin/env bash
# Builds the air-gap bundle (OPS-005, ADR-021): image archives, the Compose kit and the Helm
# chart, the frontend build for static hosting, a CycloneDX SBOM, SHA256SUMS and a signature.
#   SIGNING_KEY=key.pem PUBLIC_KEY=cosign.pub bash tools/airgap/bundle.sh <version> [out-dir]
# Images come from the local Docker: TASKMOOR_IMAGE (default taskmoor:<version>) and
# POSTGRES_IMAGE (default postgres:16.10-alpine, pulled if missing). SIGNING_KEY is an ECDSA
# P-256 private key in PEM; release builds use the project's key from a CI secret.
set -euo pipefail
cd "$(dirname "$0")/../.."
# Git Bash: docker must see container paths as written, other tools need path conversion.
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }
host() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

version=${1:?version}
out=${2:-dist/airgap}
app=${TASKMOOR_IMAGE:-taskmoor:$version}
db=${POSTGRES_IMAGE:-postgres:16.10-alpine}
key=${SIGNING_KEY:?SIGNING_KEY (PEM private key) is required}
pub=${PUBLIC_KEY:?PUBLIC_KEY (PEM public key) is required}
dir="$out/taskmoor-$version"

rm -rf "$dir"
mkdir -p "$dir/images" "$dir/compose" "$dir/web" "$dir/helm"

echo "== images"
docker image inspect "$db" >/dev/null 2>&1 || docker pull -q "$db" >/dev/null
docker save "$app" | gzip -6 > "$dir/images/taskmoor.tar.gz"
docker save "$db" | gzip -6 > "$dir/images/postgres.tar.gz"
{
  echo "taskmoor $app $(docker image inspect --format '{{.Id}}' "$app")"
  echo "postgres $db $(docker image inspect --format '{{.Id}}' "$db")"
} > "$dir/images.txt"

echo "== kits"
cp deploy/compose/docker-compose.yml deploy/compose/docker-compose.external.yml \
  deploy/compose/.env.example deploy/compose/install.sh deploy/compose/install.ps1 \
  deploy/compose/upgrade.sh deploy/compose/update.sh deploy/compose/taskmoor-release.pub \
  deploy/compose/README.md "$dir/compose/"
if command -v helm >/dev/null 2>&1; then
  helm package deploy/helm/taskmoor --app-version "$version" -d "$dir/helm" >/dev/null
else
  tar -czf "$dir/helm/taskmoor-chart.tgz" -C deploy/helm taskmoor
fi
cp deploy/README.md "$dir/INSTALL.md"
cp tools/airgap/verify.sh tools/airgap/install-offline.sh tools/airgap/README.md "$dir/"
cp LICENSE "$dir/"

echo "== frontend"
# The static build that the image serves, also usable on any static host (OPS-013).
container=$(docker create "$app")
docker cp "$container:/app/web" "$(host "$dir/web/taskmoor-web")" >/dev/null
docker rm "$container" >/dev/null
tar -czf "$dir/web/taskmoor-web-$version.tar.gz" -C "$dir/web" taskmoor-web
rm -rf "$dir/web/taskmoor-web"

echo "== SBOM"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock anchore/syft:v1.33.0 \
  "$app" -o cyclonedx-json -q > "$dir/sbom.cdx.json"

echo "== checksums and signature"
cp "$pub" "$dir/cosign.pub"
(cd "$dir" && find . -type f ! -name SHA256SUMS ! -name SHA256SUMS.sig ! -name cosign.pub \
  | sed 's#^\./##' | sort | xargs sha256sum > SHA256SUMS)
openssl dgst -sha256 -sign "$key" "$dir/SHA256SUMS" | base64 -w0 > "$dir/SHA256SUMS.sig"
bash "$dir/verify.sh" "$dir/cosign.pub" >/dev/null
echo "bundle: $dir ($(du -sh "$dir" | cut -f1))"
