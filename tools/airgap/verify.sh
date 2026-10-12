#!/usr/bin/env bash
# Verifies an air-gap bundle before anything from it is used (OPS-005): the signature over
# SHA256SUMS against the published public key, then every file against SHA256SUMS. Needs only
# openssl and sha256sum, so it runs on a host with no internet. The signature is ECDSA P-256
# over SHA-256 in base64, the format `cosign sign-blob --key` writes, so
# `cosign verify-blob --key cosign.pub --signature SHA256SUMS.sig SHA256SUMS` agrees.
#   bash verify.sh [path/to/cosign.pub]
set -euo pipefail
cd "$(dirname "$0")"
key=${1:-cosign.pub}
[ -f "$key" ] || { echo "verify: public key $key not found"; exit 1; }
for f in SHA256SUMS SHA256SUMS.sig; do [ -f "$f" ] || { echo "verify: $f is missing"; exit 1; }; done

sig=$(mktemp)
trap 'rm -f "$sig"' EXIT
base64 -d SHA256SUMS.sig > "$sig" 2>/dev/null || { echo "verify: SHA256SUMS.sig is not base64"; exit 1; }
if ! openssl dgst -sha256 -verify "$key" -signature "$sig" SHA256SUMS >/dev/null 2>&1; then
  echo "verify: the signature over SHA256SUMS does not match $key; do not use this bundle"
  exit 1
fi
echo "verify: signature ok ($key)"
if ! sha256sum --quiet -c SHA256SUMS; then
  echo "verify: a file does not match SHA256SUMS; do not use this bundle"
  exit 1
fi
echo "verify: $(wc -l < SHA256SUMS) files match SHA256SUMS"
