#!/usr/bin/env bash
# Proves M0-026 on this machine: the all-in-one image comes up with its own Postgres, keeps its
# data across a restart, and both Compose kits reach /ready. Each kit's upgrade path (M1-102)
# runs once with the same image, which has nothing to apply. Every kit serves clean URLs (M1-134). Needs the main image (TAG) built,
# for example by tools/image/smoke.sh. The fresh-VM timing (OPS-001) is the nightly matrix's job.
set -euo pipefail
cd "$(dirname "$0")/../.."

TAG=${TAG:-taskmoor:dev}
AIO=${AIO:-taskmoor-allinone:dev}
ID=$$
AIO_NAME=taskmoor-aio-$ID
VOL=taskmoor-aio-data-$ID
PG=taskmoor-ext-pg-$ID
NET=taskmoor-ext-$ID
cleanup() {
  docker rm -f "$AIO_NAME" "$PG" >/dev/null 2>&1 || true
  docker volume rm "$VOL" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker rm -f "ts-smoke-$ID-taskmoor-1" "ts-smoke-$ID-postgres-1" "ts-smoke-$ID-postgres-tls-1" "ts-smoke-ext-$ID-taskmoor-1" >/dev/null 2>&1 || true
  docker volume rm "ts-smoke-${ID}_postgres-data" "ts-smoke-${ID}_postgres-ca" "ts-smoke-${ID}_postgres-tls" "ts-smoke-${ID}_taskmoor-data" "ts-smoke-ext-${ID}_taskmoor-data" >/dev/null 2>&1 || true
  docker network rm "ts-smoke-${ID}_default" "ts-smoke-ext-${ID}_default" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Clean URLs (M1-134): a deep link answers the app itself, on a first visit and on a reload, and
# the start page (where an old hash link such as /#/tickets/ABC-1 lands) does too.
deep_links() { # base url
  for url in "$1/tickets/ABC-1" "$1/tickets/ABC-1" "$1/"; do
    code=$(curl -s -o /tmp/taskmoor-deep-$$.html -w '%{http_code}' -H 'Accept: text/html' "$url")
    if [ "$code" != 200 ] || ! grep -q taskmoor-config /tmp/taskmoor-deep-$$.html; then
      echo "$url answered $code, not the app"; return 1
    fi
  done
  rm -f /tmp/taskmoor-deep-$$.html
  echo "clean URLs: deep links open and reload"
}

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
deep_links http://127.0.0.1:18090
# ASVS 1.9.1 (ADR-111): PostgreSQL listens on no address; the backend is on the Unix socket.
listen=$(docker exec "$AIO_NAME" su-exec postgres psql -U postgres -tAc "SHOW listen_addresses")
[ -z "$(echo "$listen" | tr -d '[:space:]')" ] || { echo "all-in-one PostgreSQL listens on '$listen'"; exit 1; }
conns=$(docker exec "$AIO_NAME" su-exec postgres psql -U postgres -tAc \
  "SELECT count(*) FILTER (WHERE client_port = -1) || '|' || count(*) FILTER (WHERE client_addr IS NOT NULL)
     FROM pg_stat_activity WHERE datname = 'taskmoor' AND pid <> pg_backend_pid()")
case "$conns" in [1-9]*'|0') echo "all-in-one database: Unix socket only ($conns)" ;; *) echo "all-in-one connections: $conns"; exit 1 ;; esac
echo "restart with the same volume"
docker restart "$AIO_NAME" >/dev/null
wait_for http://127.0.0.1:18090/ready 60 "$AIO_NAME"
docker logs "$AIO_NAME" 2>&1 | grep -c "initialising PostgreSQL" | grep -qx 1 && echo "data kept: initialised once"
# Removed without a clean stop, as an out-of-memory kill would: the next start finds
# PostgreSQL's stale lock file and must still come up.
docker rm -f "$AIO_NAME" >/dev/null
# OPS-006: the upgrade by hand, with the container stopped (never beside a running one: both
# would start PostgreSQL on the same files). Same image, so nothing to apply.
out=$(docker run --rm -v "$VOL:/data" "$AIO" upgrade)
echo "$out" | tail -2
grep -q "Up to date at" <<<"$out"

echo "== compose kit with bundled Postgres"
(
  cd deploy/compose
  POSTGRES_PASSWORD=smoke-$ID TASKMOOR_IMAGE=$TAG TASKMOOR_PORT=18091 \
    docker compose -p "ts-smoke-$ID" up -d --quiet-pull >/dev/null
)
app="ts-smoke-$ID-taskmoor-1"
wait_for http://127.0.0.1:18091/ready 120 "$app"
curl -fsS http://127.0.0.1:18091/ready; echo
deep_links http://127.0.0.1:18091
# ASVS 1.9.1 (ADR-111): every network connection to the bundled PostgreSQL is TLS, the backend
# verifies the certificate (verify-full against the kit's authority), and plain TCP is refused.
pg="ts-smoke-$ID-postgres-1"
tls=$(docker exec "$pg" psql -U taskmoor -d taskmoor -tAc \
  "SELECT count(*) FILTER (WHERE s.ssl) || '|' || count(*) FILTER (WHERE NOT s.ssl)
     FROM pg_stat_ssl s JOIN pg_stat_activity a USING (pid)
    WHERE a.datname = 'taskmoor' AND a.client_addr IS NOT NULL")
case "$tls" in [1-9]*'|0') echo "compose database: TLS only ($tls)" ;; *) echo "compose connections (tls|plain): $tls"; exit 1 ;; esac
if docker exec -e PGPASSWORD="smoke-$ID" "$pg" psql "host=127.0.0.1 user=taskmoor dbname=taskmoor sslmode=disable" -tAc 'SELECT 1' >/dev/null 2>&1; then
  echo "a plain TCP connection to the compose database was accepted"; exit 1
fi
docker exec -e PGPASSWORD="smoke-$ID" "$pg" psql "host=localhost user=taskmoor dbname=taskmoor sslmode=verify-full sslrootcert=/tls/ca.crt" -tAc 'SELECT 1' | grep -qx 1
echo "compose database: plain TCP refused, verify-full accepted"
ca_before=$(docker exec "$pg" sha256sum /tls/ca.crt | cut -d' ' -f1)
echo "upgrade.sh to the same image: stops the backend, nothing to apply, starts it again"
out=$(
  cd deploy/compose
  COMPOSE_PROJECT_NAME="ts-smoke-$ID" POSTGRES_PASSWORD=smoke-$ID TASKMOOR_IMAGE=$TAG \
    TASKMOOR_PORT=18091 TASKMOOR_PULL=never bash upgrade.sh "$TAG"
)
echo "$out" | tail -3
grep -q "Up to date at" <<<"$out"
wait_for http://127.0.0.1:18091/ready 30 "$app"
# The authority survives the upgrade (made once, at the first start).
ca_after=$(docker exec "$pg" sha256sum /tls/ca.crt | cut -d' ' -f1)
[ "$ca_before" = "$ca_after" ] || { echo "the database's certificate authority changed in the upgrade"; exit 1; }
echo "compose database: the same certificate authority after the upgrade"
(cd deploy/compose && docker compose -p "ts-smoke-$ID" down -v >/dev/null)

echo "== compose kit with an external Postgres"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" -e POSTGRES_PASSWORD=ext-$ID postgres:16 >/dev/null
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
(
  cd deploy/compose
  DATABASE_URL=postgres://postgres:ext-$ID@$PG:5432/postgres TASKMOOR_IMAGE=$TAG TASKMOOR_PORT=18092 \
    docker compose -p "ts-smoke-ext-$ID" -f docker-compose.external.yml up -d --quiet-pull >/dev/null
)
# Compose names the container <project>-<service>-1; asking compose would need the env again.
app="ts-smoke-ext-$ID-taskmoor-1"
docker network connect "$NET" "$app"
wait_for http://127.0.0.1:18092/ready 120 "$app"
curl -fsS http://127.0.0.1:18092/ready; echo
deep_links http://127.0.0.1:18092
echo "== kits passed"
