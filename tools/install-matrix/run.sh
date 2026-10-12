#!/usr/bin/env bash
# Times the Compose kit's install.sh on this machine and writes the result to the job summary
# (M0-028). Usage: bash tools/install-matrix/run.sh <label>
set -euo pipefail
cd "$(dirname "$0")/../.."
label=${1:-local}
export TASKMOOR_IMAGE=${TASKMOOR_IMAGE:-taskmoor:ci}
export TASKMOOR_PORT=${TASKMOOR_PORT:-18100}

cleanup() {
  (cd deploy/compose && docker compose down -v >/dev/null 2>&1) || true
  rm -f deploy/compose/.env
}
trap cleanup EXIT

start=$(date +%s)
(cd deploy/compose && bash install.sh | tee /tmp/install.log)
end=$(date +%s)
grep -q "setup?token=" /tmp/install.log || { echo "no setup link printed"; exit 1; }
curl -fsS "http://127.0.0.1:$TASKMOOR_PORT/ready" | grep -q '"ready"'
seconds=$((end - start))
echo "install on $label: ${seconds}s to /ready and the setup link"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "| $label | ${seconds}s | ok |" >> "$GITHUB_STEP_SUMMARY"
fi
test "$seconds" -lt 600
