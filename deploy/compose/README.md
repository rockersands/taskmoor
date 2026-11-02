# Compose kits

Two ways to run the one Taskmoor image (ADR-021) with Docker Compose. Both keep the app's
files in the `taskmoor-data` volume and answer on port 8080; put a reverse proxy with TLS in
front for anything beyond a trial (the Builder's backend kit adds Caddy with automatic HTTPS).

| File | Database | Start |
|---|---|---|
| `docker-compose.yml` | Bundled PostgreSQL 16 with pgvector (for similar tickets, ADR-106) in the `postgres-data` volume | `cp .env.example .env`, set `POSTGRES_PASSWORD`, `docker compose up -d` |
| `docker-compose.external.yml` | A PostgreSQL 16+ server you run | set `DATABASE_URL` in `.env`, `docker compose -f docker-compose.external.yml up -d` |

Check: `curl http://localhost:8080/ready` returns `{"status":"ready"}` once migrations have run
(the backend waits up to a minute for the database on its first start).

With the bundled PostgreSQL the backend connects over TLS (`sslmode=verify-full`): the
`postgres-tls` service makes a private certificate authority and the server's certificate at
the first start, keeps the authority's key in the `postgres-ca` volume and the certificates in
`postgres-tls`, and PostgreSQL refuses plain connections (ADR-111). `POSTGRES_IMAGE` must be a
Debian-based PostgreSQL image (it needs `openssl`).

An external server needs the `pg_trgm` extension, which ships with PostgreSQL (the `contrib`
package on some distributions) and every managed service. The migrations create it; it is a
trusted extension, so the database's owner may, and a role without the `CREATE` privilege on
the database needs an administrator to run `CREATE EXTENSION pg_trgm` first (ADR-069).

Upgrade: `bash upgrade.sh <image>` (for example `ghcr.io/rockersands/taskmoor:1.4.0`; add
`--dry-run` to see the checks and the plan first). It first gives the bundled PostgreSQL its
TLS certificate when it has none (an install from an earlier kit), stops the backend, runs the new image's
`node cli.mjs upgrade` (checks, a backup under `/data/backups/pre-upgrade-<time>`, the
migrations, a rollback on any failure), records the image in `.env` and starts it; when the
upgrade fails, the previous image starts again on the unchanged database (`../README.md`,
Upgrades). Stop: `docker compose down` (add `-v` to delete the data).

For a single container with Postgres inside, see `deploy/allinone`.

## Installer options

`install.sh` reads these from the environment: `TASKMOOR_IMAGE` and `POSTGRES_IMAGE` pick the
images; `TASKMOOR_PULL=never` installs from images already loaded (the air-gap bundle does
this) and never contacts a registry; `TASKMOOR_COMPOSE_OVERRIDE` adds compose files, for
example one that puts the stack on an internal network. Readiness is checked from inside the
container, so it works behind any firewall or network mode.
