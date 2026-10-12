# Compose kits

Two ways to run the one Tracksmith image (ADR-021) with Docker Compose. Both keep the app's
files in the `tracksmith-data` volume and answer on port 8080; put a reverse proxy with TLS in
front for anything beyond a trial (the Builder's backend kit adds Caddy with automatic HTTPS).

| File | Database | Start |
|---|---|---|
| `docker-compose.yml` | Bundled PostgreSQL 16 in the `postgres-data` volume | `cp .env.example .env`, set `POSTGRES_PASSWORD`, `docker compose up -d` |
| `docker-compose.external.yml` | A PostgreSQL 16+ server you run | set `DATABASE_URL` in `.env`, `docker compose -f docker-compose.external.yml up -d` |

Check: `curl http://localhost:8080/ready` returns `{"status":"ready"}` once migrations have run
(the backend waits up to a minute for the database on its first start).

Upgrade: change `TRACKSMITH_IMAGE` in `.env` and run `docker compose up -d` again; migrations
are forward-only and run at start (ADR-022). Stop: `docker compose down` (add `-v` to delete
the data).

For a single container with Postgres inside, see `deploy/allinone`.

## Installer options

`install.sh` reads these from the environment: `TRACKSMITH_IMAGE` and `POSTGRES_IMAGE` pick the
images; `TRACKSMITH_PULL=never` installs from images already loaded (the air-gap bundle does
this) and never contacts a registry; `TRACKSMITH_COMPOSE_OVERRIDE` adds compose files, for
example one that puts the stack on an internal network. Readiness is checked from inside the
container, so it works behind any firewall or network mode.
