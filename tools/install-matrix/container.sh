#!/usr/bin/env bash
# Runs the Compose kit's install.sh from inside a fresh container of another distribution,
# using this machine's Docker daemon through its socket (M0-028). It proves the script and its
# prerequisites check on that userland; the containers it starts run on the host daemon.
# Usage: bash tools/install-matrix/container.sh debian:12 | rockylinux:9
set -euo pipefail
cd "$(dirname "$0")/../.."
image=${1:?distribution image}
export TASKMOOR_IMAGE=${TASKMOOR_IMAGE:-taskmoor:ci}
port=${TASKMOOR_PORT:-18101}

case "$image" in
  debian:*|ubuntu:*)
    prepare='apt-get update -q && apt-get install -y -q curl ca-certificates gnupg >/dev/null && install -m 0755 -d /etc/apt/keyrings && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc && . /etc/os-release && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/$ID $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list && apt-get update -q && apt-get install -y -q docker-ce-cli docker-compose-plugin >/dev/null' ;;
  rockylinux:*|almalinux:*|*ubi9*)
    # curl-minimal already provides curl on these images and conflicts with the full package.
    prepare='dnf install -y -q dnf-plugins-core >/dev/null && dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo && dnf install -y -q docker-ce-cli docker-compose-plugin >/dev/null' ;;
  *) echo "no prerequisite recipe for $image"; exit 1 ;;
esac

cleanup() {
  (cd deploy/compose && docker compose -p "ts-matrix" down -v >/dev/null 2>&1) || true
  rm -f deploy/compose/.env
}
trap cleanup EXIT

start=$(date +%s)
docker run --rm --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$PWD/deploy/compose:/kit" \
  -e TASKMOOR_IMAGE -e TASKMOOR_PORT="$port" -e COMPOSE_PROJECT_NAME=ts-matrix \
  "$image" bash -c "$prepare && cd /kit && bash install.sh" | tee /tmp/install.log
end=$(date +%s)
grep -q "setup?token=" /tmp/install.log || { echo "no setup link printed"; exit 1; }
seconds=$((end - start))
echo "install from $image: ${seconds}s including the prerequisites"
if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  echo "| $image (container) | ${seconds}s | ok |" >> "$GITHUB_STEP_SUMMARY"
fi
test "$seconds" -lt 600
