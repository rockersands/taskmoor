#!/usr/bin/env bash
# The S3 attachment store against a real S3-compatible service (M1-016): starts MinIO in
# Docker with credentials made here per run, then runs packages/storage/src/s3.live.test.ts
# (round trip, ranges, multipart upload, refusal over the limit with no parts left behind,
# presigned URLs with response headers and expiry) and removes the container. Nothing it uses
# is stored anywhere. Needs Docker and Node.
#
#   bash tools/storage/minio-test.sh
#   TASKMOOR_MINIO_IMAGE=<image:tag> bash tools/storage/minio-test.sh
#
# Docker Hub no longer has minio/minio (October 2026). Without TASKMOOR_MINIO_IMAGE the first
# image that pulls is used, and named in the output: MinIO's own release on quay.io, then the
# community-maintained fork pgsty/minio. Both are pinned to a release.
#
# Against another store (AWS S3, R2, Garage, Ceph), skip Docker and give its details in the
# environment instead; the test creates the bucket when it is missing and works under a
# random prefix:
#
#   TASKMOOR_S3_TEST_ENDPOINT=https://... TASKMOOR_S3_TEST_ACCESS_KEY_ID=... \
#   TASKMOOR_S3_TEST_SECRET_ACCESS_KEY=... TASKMOOR_S3_TEST_BUCKET=... \
#     pnpm verify --only=tests -- packages/storage/src/s3.live.test.ts
set -euo pipefail

IMAGES="${TASKMOOR_MINIO_IMAGE:-quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z pgsty/minio:RELEASE.2026-06-18T00-00-00Z}"
IMAGE=
for candidate in $IMAGES; do
  if docker pull --quiet "$candidate" >/dev/null 2>&1; then
    IMAGE=$candidate
    break
  fi
  echo "minio-test: cannot pull $candidate"
done
if [ -z "$IMAGE" ]; then
  echo "minio-test: no MinIO image could be pulled" >&2
  exit 1
fi
echo "minio-test: using $IMAGE"
NAME=taskmoor-minio-e2e
PORT="${MINIO_PORT:-9000}"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

secret() { head -c 30 /dev/urandom | base64 | tr -d '/+=\n' | head -c 32; }
user="taskmoor$(secret | head -c 8)"
password="$(secret)"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:9000" \
  -e MINIO_ROOT_USER="$user" -e MINIO_ROOT_PASSWORD="$password" \
  "$IMAGE" server /data >/dev/null
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/minio/health/live" >/dev/null 2>&1 && break
  sleep 1
done

cd "$ROOT"
pnpm_cmd=(pnpm)
command -v pnpm >/dev/null 2>&1 || pnpm_cmd=(corepack pnpm)
TASKMOOR_S3_TEST_ENDPOINT="http://127.0.0.1:$PORT" \
  TASKMOOR_S3_TEST_ACCESS_KEY_ID="$user" \
  TASKMOOR_S3_TEST_SECRET_ACCESS_KEY="$password" \
  TASKMOOR_S3_TEST_BUCKET=taskmoor-live-test \
  "${pnpm_cmd[@]}" verify --only=tests -- packages/storage/src/s3.live.test.ts
