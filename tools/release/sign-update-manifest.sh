#!/usr/bin/env bash
# Writes the signed statement update.sh checks (OPS-025, ADR-117): which image is this version.
# Attach both files it writes to the GitHub release, whose tag is v<version>:
#
#   SIGNING_KEY=key.pem bash tools/release/sign-update-manifest.sh <version> <image>@sha256:<digest> [out-dir]
#
# The digest is the pushed image's, for every platform at once:
#   docker buildx imagetools inspect ghcr.io/rockersands/taskmoor:<version> --format '{{.Manifest.Digest}}'
# SIGNING_KEY is the release key (ECDSA P-256 in PEM, tools/airgap/taskmoor-release.pub is its
# public half); the signature has the format `cosign sign-blob --key` writes, as for the air-gap
# bundle. PUBLIC_KEY names another public key to check against, for a fork or a test.
set -euo pipefail
version=${1:?version, for example 1.4.0}
image=${2:?image with its digest, for example ghcr.io/rockersands/taskmoor@sha256:...}
out=${3:-dist/release}
key=${SIGNING_KEY:?SIGNING_KEY (PEM private key) is required}
pub=${PUBLIC_KEY:-$(dirname "$0")/../airgap/taskmoor-release.pub}

[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "sign: $version is not a version like 1.4.0" >&2; exit 2; }
[[ "$image" =~ ^[a-z0-9][a-z0-9._:/-]*@sha256:[0-9a-f]{64}$ ]] || { echo "sign: $image does not end in @sha256:<digest>" >&2; exit 2; }

mkdir -p "$out"
printf 'version=%s\nimage=%s\n' "$version" "$image" > "$out/taskmoor-release.txt"
openssl dgst -sha256 -sign "$key" "$out/taskmoor-release.txt" | base64 | tr -d '\n' > "$out/taskmoor-release.txt.sig"

# The statement must verify with the key the kits carry before anyone downloads it.
sig=$(mktemp)
trap 'rm -f "$sig"' EXIT
base64 -d < "$out/taskmoor-release.txt.sig" > "$sig"
if ! openssl dgst -sha256 -verify "$pub" -signature "$sig" "$out/taskmoor-release.txt" >/dev/null 2>&1; then
  echo "sign: the signature does not verify with $pub: this is not the release key" >&2
  exit 1
fi
echo "signed: $out/taskmoor-release.txt and $out/taskmoor-release.txt.sig"
