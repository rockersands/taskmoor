#!/usr/bin/env bash
# Installs Taskmoor from this air-gap bundle with the Compose kit (OPS-005): verify the
# bundle, load the image archives, then run the kit's installer without contacting any
# registry. Extra arguments are passed to the kit's environment as KEY=value.
#   bash install-offline.sh [path/to/cosign.pub]
set -euo pipefail
cd "$(dirname "$0")"
bash verify.sh "${1:-cosign.pub}"

echo "== loading images"
for archive in images/*.tar.gz; do
  gzip -dc "$archive" | docker load
done
# images.txt: "<role> <reference>" for each archive, written by the bundle builder.
app=$(awk '$1 == "taskmoor" { print $2 }' images.txt)
db=$(awk '$1 == "postgres" { print $2 }' images.txt)

echo "== installing"
cd compose
TASKMOOR_IMAGE="$app" POSTGRES_IMAGE="$db" TASKMOOR_PULL=never bash install.sh
