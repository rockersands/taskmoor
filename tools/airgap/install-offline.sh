#!/usr/bin/env bash
# Installs Taskmoor from this air-gap bundle with the Compose kit (OPS-005): verify the
# bundle, load the image archives, then run the kit's installer without contacting any
# registry. Extra arguments are passed to the kit's environment as KEY=value.
#   bash install-offline.sh [path/to/cosign.pub]
set -euo pipefail
cd "$(dirname "$0")"
bash verify.sh "${1:-cosign.pub}"

# The images are for one platform (images.txt); another's would not start here, and there is no
# registry to fetch the right ones from. A bundle from before the line was added says nothing.
want=$(awk '$1 == "platform" { print $2 }' images.txt)
have=$(docker version --format '{{.Server.Os}}/{{.Server.Arch}}')
if [ -n "$want" ] && [ "$want" != "$have" ]; then
  echo "This bundle's images are for $want servers, and this one is $have."
  echo "Nothing was changed. Install the bundle made for $have."
  exit 1
fi

echo "== loading images"
for archive in images/*.tar.gz; do
  gzip -dc "$archive" | docker load
done
# images.txt: "<role> <reference>" for each archive, written by the bundle builder.
app=$(awk '$1 == "taskmoor" { print $2 }' images.txt)
db=$(awk '$1 == "postgres" { print $2 }' images.txt)

echo "== installing"
cd compose
# No update check here (OPS-005, OPS-026): install.sh keeps this in .env for later upgrades.
TASKMOOR_IMAGE="$app" POSTGRES_IMAGE="$db" TASKMOOR_PULL=never TASKMOOR_UPDATE_CHECK=off bash install.sh
