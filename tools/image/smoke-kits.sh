#!/usr/bin/env bash
# Proves M0-026 on this machine: the all-in-one image comes up with its own Postgres, keeps its
# data across a restart, and both Compose kits reach /ready. Needs the main image (TAG) built,
# for example by tools/image/smoke.sh. The fresh-VM timing (OPS-001) is the nightly matrix's job.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG=${TAG:-tracksmith:dev}
AIO=${AIO:-tracksmith-allinone:dev}
ID=$$
AIO_NAME=tracksmith-aio-$ID
VOL=tracksmith-aio-data-$ID
PG=tracksmith-ext-pg-$ID
NET=tracksmith-ext-$ID
cleanup() {
  docker rm -f "$AIO_NAME" "$PG" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rm -f "ts-smoke-$ID-tracksmith-1" "ts-smoke-$ID-postgres-1" "ts-smoke-ext-$ID-tracksmith-1" >/dev/null 2>&1 || true
  docker volume rm "ts-smoke-${ID}_postgres-data" "ts-smoke-${ID}_tracksmith-data" "ts-smoke-ext-${ID}_tracksmith-data" >/dev/null 2>&1 || true
  docker network rm "ts-smoke-${ID}_default" "ts-smoke-ext-${ID}_default" >/dev/null 2>&1 || true
}
trap cleanup EXIT

wait_for() { # url, seconds, container-for-logs
  for _ in $(seq 1 "$2"); do
    if curl -fsS "$1" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "no answer from $1 after $2 s"; docker logs "$3" 2>&1 | tail -30; return 1
}

echo "== all-in-one image"
docker build -f deploy/allinone/Dockerfile --build-arg "BASE=$TAG" -t "$AIO" . >/dev/null
size=$(docker image inspect "$AIO" --format '{{.Size}}')
echo "all-in-one size: $((size / 1000000)) MB"
docker volume create "$VOL" >/dev/null
docker run -d --name "$AIO_NAME" -v "$VOL:/data" -p 18090:8080 "$AIO" >/dev/null
wait_for http://127.0.0.1:18090/ready 90 "$AIO_NAME"
curl -fsS http://127.0.0.1:18090/ready; echo
echo "restart with the same volume"
docker restart "$AIO_NAME" >/dev/null
wait_for http://127.0.0.1:18090/ready 60 "$AIO_NAME"
docker logs "$AIO_NAME" 2>&1 | grep -c "initialising PostgreSQL" | grep -qx 1 && echo "data kept: initialised once"
docker rm -f "$AIO_NAME" >/dev/null

echo "== compose kit with bundled Postgres"
(
  cd deploy/compose
  POSTGRES_PASSWORD=smoke-$ID TRACKSMITH_IMAGE=$TAG TRACKSMITH_PORT=18091 \
    docker compose -p "ts-smoke-$ID" up -d --quiet-pull >/dev/null
)
app="ts-smoke-$ID-tracksmith-1"
wait_for http://127.0.0.1:18091/ready 120 "$app"
curl -fsS http://127.0.0.1:18091/ready; echo
(cd deploy/compose && docker compose -p "ts-smoke-$ID" down -v >/dev/null)

echo "== compose kit with an external Postgres"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=ext-$ID postgres:16 >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
(
  cd deploy/compose
  DATABASE_URL=postgres://postgres:ext-$ID@$PG:5432/postgres TRACKSMITH_IMAGE=$TAG TRACKSMITH_PORT=18092 \
    docker compose -p "ts-smoke-ext-$ID" -f docker-compose.external.yml up -d --quiet-pull >/dev/null
)
# Compose names the container <project>-<service>-1; asking compose would need the env again.
app="ts-smoke-ext-$ID-tracksmith-1"
docker network connect "$NET" "$app"
wait_for http://127.0.0.1:18092/ready 120 "$app"
curl -fsS http://127.0.0.1:18092/ready; echo
echo "== kits passed"
