#!/usr/bin/env bash
# Builds the air-gap bundle (OPS-005, ADR-021): image archives, the Compose kit and the Helm
# chart, the frontend build for static hosting, a CycloneDX SBOM, SHA256SUMS and a signature.
#   SIGNING_KEY=key.pem PUBLIC_KEY=cosign.pub bash tools/airgap/bundle.sh <version> [out-dir]
# Images come from the local Docker: TASKMOOR_IMAGE (default taskmoor:<version>) and
# POSTGRES_IMAGE (default the Compose kit's own, pulled if missing). SIGNING_KEY is an ECDSA
# P-256 private key in PEM; a release is signed with the release key on the maintainer's
# machine (docs/ops/releases.md).
#
# A bundle is for servers of one platform, PLATFORM (default linux/amd64; or linux/arm64): an
# image archive holds one, and an air-gapped server has no registry to fetch the other from.
# Both images must hold it, and an Apple silicon Mac builds and pulls arm64 ones: an amd64
# bundle made there takes images pulled with `docker pull --platform linux/amd64` or built with
# `docker buildx build --platform linux/amd64 --load`. A missing database image is pulled for
# PLATFORM. With Docker 29's containerd image store a tag holds every platform pulled for it,
# so a Docker whose `docker image inspect` and `docker save` take --platform (28.1 and later)
# has the bundle check and save PLATFORM's image by name. An older one cannot pick a platform:
# there the tag must hold only PLATFORM's image (`docker image rm` it before the pull).
set -euo pipefail
cd "$(dirname "$0")/../.."
# Git Bash: docker must see container paths as written, other tools need path conversion.
docker() { MSYS_NO_PATHCONV=1 command docker "$@"; }
host() { if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else echo "$1"; fi; }

version=${1:?version}
out=${2:-dist/airgap}
app=${TASKMOOR_IMAGE:-taskmoor:$version}
# The database image the bundled Compose kit names, so the bundle installs what the kit is
# tested with: its postgres-tls service needs the openssl that Alpine's PostgreSQL image lacks.
kit_db=$(sed -n 's/^ *image: \${POSTGRES_IMAGE:-\([^}]*\)}.*$/\1/p' deploy/compose/docker-compose.yml | head -1)
db=${POSTGRES_IMAGE:-${kit_db:?no database image in deploy/compose/docker-compose.yml}}
key=${SIGNING_KEY:?SIGNING_KEY (PEM private key) is required}
pub=${PUBLIC_KEY:?PUBLIC_KEY (PEM public key) is required}
platform=${PLATFORM:-linux/amd64}
case "$platform" in
  linux/amd64 | linux/arm64) ;;
  *) echo "PLATFORM is linux/amd64 or linux/arm64, not $platform"; exit 1 ;;
esac
dir="$out/taskmoor-$version"

echo "== images for $platform"
# With the containerd image store (Docker 29's default) `docker pull --platform` adds a platform
# beside the ones a tag holds, a plain `docker image inspect` reports the host's and a plain
# `docker save` writes them all. So where both commands take --platform (Docker 28.1, API 1.49;
# the help hides the flag when the daemon is older), the bundle names PLATFORM in both.
# Otherwise the check is on the tag as a whole, as before.
pick=()
case "$(docker image inspect --help 2>&1)" in
  *--platform*) case "$(docker save --help 2>&1)" in *--platform*) pick=(--platform "$platform") ;; esac ;;
esac
# Expanded as ${pick[@]+"${pick[@]}"}: an empty array is an error under set -u in bash 3.2.
docker image inspect "$db" >/dev/null 2>&1 || docker pull -q --platform "$platform" "$db" >/dev/null
for image in "$app" "$db"; do
  # For a platform the tag lists but never pulled, Docker 29 answers "/" and succeeds.
  found=$(docker image inspect ${pick[@]+"${pick[@]}"} --format '{{.Os}}/{{.Architecture}}' "$image" 2>/dev/null || true)
  [ "$found" = "$platform" ] && continue
  # What the tag is for this Docker: the host's platform when the tag holds it.
  plain=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image" 2>/dev/null) || {
    echo "$image is not in this Docker: pull or build it for $platform servers (PLATFORM)."
    exit 1
  }
  if [ ${#pick[@]} -gt 0 ]; then
    echo "$image has no $platform image here, and this bundle is for $platform servers (PLATFORM)."
    echo "Pull it for them; this Docker saves $platform's image alone from a tag that holds more:"
    echo "  docker pull --platform $platform $image"
    echo "or build it for them: docker buildx build --platform $platform --load"
  else
    echo "$image is $plain here, and this bundle is for $platform servers (PLATFORM)."
    echo "This Docker cannot check or save one platform of a tag (docker image inspect and docker"
    echo "save take --platform from Docker 28.1), so the tag must hold $platform's image alone:"
    echo "remove it, then pull it for them."
    echo "  docker image rm $image"
    echo "  docker pull --platform $platform $image"
    echo "or build it for them: docker buildx build --platform $platform --load"
  fi
  case "$plain" in
    "$platform") ;;
    linux/amd64 | linux/arm64) echo "Or make the bundle for $plain servers: PLATFORM=$plain." ;;
  esac
  exit 1
done

rm -rf "$dir"
mkdir -p "$dir/images" "$dir/compose" "$dir/web" "$dir/helm"
docker save ${pick[@]+"${pick[@]}"} "$app" | gzip -6 > "$dir/images/taskmoor.tar.gz"
docker save ${pick[@]+"${pick[@]}"} "$db" | gzip -6 > "$dir/images/postgres.tar.gz"
# install-offline.sh reads the platform line and refuses a server of another one.
{
  echo "taskmoor $app $(docker image inspect ${pick[@]+"${pick[@]}"} --format '{{.Id}}' "$app")"
  echo "postgres $db $(docker image inspect ${pick[@]+"${pick[@]}"} --format '{{.Id}}' "$db")"
  echo "platform $platform"
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
container=$(docker create --platform "$platform" "$app")
docker cp "$container:/app/web" "$(host "$dir/web/taskmoor-web")" >/dev/null
docker rm -v "$container" >/dev/null
tar -czf "$dir/web/taskmoor-web-$version.tar.gz" -C "$dir/web" taskmoor-web
rm -rf "$dir/web/taskmoor-web"

echo "== SBOM"
docker run --rm -v /var/run/docker.sock:/var/run/docker.sock anchore/syft:v1.33.0 \
  "$app" -o cyclonedx-json -q > "$dir/sbom.cdx.json"

echo "== checksums and signature"
cp "$pub" "$dir/cosign.pub"
(cd "$dir" && find . -type f ! -name SHA256SUMS ! -name SHA256SUMS.sig ! -name cosign.pub \
  | sed 's#^\./##' | sort | xargs sha256sum > SHA256SUMS)
# One line of base64 with no line break, on GNU, BSD (a Mac) and BusyBox alike (-w0 is GNU's).
openssl dgst -sha256 -sign "$key" "$dir/SHA256SUMS" | base64 | tr -d '\n' > "$dir/SHA256SUMS.sig"
# The bundle checks itself as a recipient would; its reason is shown when it does not pass.
if ! checked=$(bash "$dir/verify.sh" "$dir/cosign.pub" 2>&1); then
  echo "$checked"
  exit 1
fi
echo "bundle: $dir for $platform servers ($(du -sh "$dir" | cut -f1))"
