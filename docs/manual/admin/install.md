---
title: "Installing Taskmoor"
audience: admins
sources: deploy/README.md, deploy/compose/README.md, deploy/compose/docker-compose.yml, deploy/compose/docker-compose.external.yml, deploy/compose/.env.example, deploy/compose/install.sh, deploy/compose/install.ps1, deploy/allinone/Dockerfile, deploy/allinone/entrypoint.sh, Dockerfile, package.json, apps/server/src/config.ts, apps/server/src/frontend.ts, apps/server/src/main.ts, apps/web/src/api/client.ts, packages/webconfig/src/config.ts, docs/adr/0021-delivery-and-images.md, docs/adr/0066-frontend-artefact-and-runtime-config.md, docs/specs/05b-administration-security-and-self-hosting.md, docs/plan/decisions.csv
accessed: 2026-10-30
attestation: own-words
---
# Installing Taskmoor

Taskmoor is one container image that runs every part of the server: the API, the background
worker, the realtime service and the web app. PostgreSQL is the only other service it needs.
This page covers the ready-made kits; [Kubernetes with Helm](helm.md) and
[the Builder's kits](builder-kits.md) have their own pages.

## What you need

| Need | For |
|---|---|
| Docker with Compose v2 (the `docker compose` command) | The Compose kits, the all-in-one image and the Builder's backend kit |
| PostgreSQL 16 or later | Every install. The Compose kit and the all-in-one image bring PostgreSQL 16; with Helm you bring your own |
| Kubernetes 1.27 or later and Helm | The Helm chart only |
| Node.js 22.12 or later and pnpm | Building from source and running the Builder; not needed to run the image |

Taskmoor is designed to run a team of up to 50 active people on 2 vCPU and 4 GB of memory
with the all-in-one image, and up to about 500 on 2 to 4 vCPU and 4 to 8 GB.

## Getting the image

The kits name the image `ghcr.io/rockersands/taskmoor:<version>`. Taskmoor does not yet publish
release images there, so build the image from a copy of the source:

```bash
docker build --build-arg TASKMOOR_VERSION=1.0.0 -t taskmoor:dev .
docker build -f deploy/allinone/Dockerfile --build-arg BASE=taskmoor:dev -t taskmoor-allinone:dev .
```

The first command builds the main image (`taskmoor:dev` is the name the Compose files use when
`TASKMOOR_IMAGE` is not set); the second builds the all-in-one image on top of it. The build
argument stamps the version into both the server and the web app; without it the version is
`0.0.0-dev`. The image runs as the unprivileged `node` user, answers on port 8080, serves
Prometheus metrics on port 9464, keeps its files in the `/data` volume and carries the
PostgreSQL 16, 17 and 18 client tools that backups use.

## Choosing a kit

| Kit | Choose it for |
|---|---|
| Compose with bundled PostgreSQL (`deploy/compose/docker-compose.yml`) | A server of your own, up to a few hundred people |
| Compose with an external PostgreSQL (`deploy/compose/docker-compose.external.yml`) | A managed or shared database |
| All-in-one image | Trials and single-box installs: PostgreSQL inside, one `/data` volume |
| Helm chart (`deploy/helm/taskmoor`) | Kubernetes, with an external PostgreSQL; see [Kubernetes with Helm](helm.md) |
| The Builder's backend kit | A server on a domain, with HTTPS from Caddy and fresh secrets; see [the Builder's kits](builder-kits.md) |

Every kit ends the same way: the server prints a one-time setup link, and you open it to create
the first administrator ([first-run setup](first-run.md)).

## The Compose kit

The kit is the `deploy/compose` folder: two Compose files, `.env.example`, `install.sh`,
`install.ps1` and `upgrade.sh`. Both Compose files keep Taskmoor's files in the `taskmoor-data`
volume and publish port 8080 (set `TASKMOOR_PORT` for another host port).

### With the bundled PostgreSQL

```bash
cd deploy/compose
bash install.sh
```

The script:

1. checks that Docker is installed, that Compose v2 is there, and that Docker runs and this user
   may use it, and says how to fix each;
2. writes `.env` with a fresh 32-character database password when there is no `.env` yet (an
   existing one is left alone);
3. checks that the port is free, unless Taskmoor already runs;
4. starts the stack, pulling the images that are missing;
5. waits up to two minutes for the backend to be ready, asking from inside the container, and
   shows the last 40 log lines if it is not;
6. prints the setup link, or says that setup is already complete.

It is safe to run again: it only starts or updates what is there. On Windows run
`powershell -ExecutionPolicy Bypass -File install.ps1`, which does the same except the port
check.

To do it by hand: copy `.env.example` to `.env`, set `POSTGRES_PASSWORD` to a long random
string, run `docker compose up -d`, and wait until `curl http://localhost:8080/ready` answers
`{"status":"ready"}`. On its first start the backend waits up to a minute for the database.

### With your own PostgreSQL

Give the script the connection URL; it then uses `docker-compose.external.yml` and writes the
URL into `.env`:

```bash
DATABASE_URL='postgres://taskmoor:secret@db.example.com:5432/taskmoor' bash install.sh
```

The server must run PostgreSQL 16 or later. Give Taskmoor a database of its own, owned by the
user in the URL: the backend creates and migrates its tables on start. The restore drill also
needs a user that may create databases. By hand, put `DATABASE_URL` in `.env` and run
`docker compose -f docker-compose.external.yml up -d`.

### The .env file

The Compose files pass these settings from `.env` to the server:

| Setting | Meaning |
|---|---|
| `POSTGRES_PASSWORD` | The bundled database's password (bundled kit only; required) |
| `DATABASE_URL` | Your PostgreSQL (external kit only; required) |
| `PUBLIC_URL` | The address people use, such as `https://tracker.example.com` |
| `TASKMOOR_SETUP_TOKEN` | A setup token of your choosing, for installers |
| `TASKMOOR_ROLE` | The roles this container runs; `all` by default |
| `TASKMOOR_WEB_ROUTING` | `path` (clean URLs, the default here) or `hash` |
| `TASKMOOR_TRUSTED_PROXIES` | The reverse proxy in front, so sign-in limits see the real client |
| `TASKMOOR_PASSWORD_PEPPER` | Your own password pepper (32 characters or more) |
| `LOG_LEVEL` | `info` by default |

`TASKMOOR_IMAGE`, `POSTGRES_IMAGE` and `TASKMOOR_PORT` choose the images and the host port.
The Compose files also pass the mail settings (`TASKMOOR_SMTP_*`), S3 storage and the virus
scanner (`TASKMOOR_STORAGE`, `TASKMOOR_S3_*`, `TASKMOOR_SCAN_CLAMD`), `TASKMOOR_BACKUP_DIR`,
`TASKMOOR_IMPORT_DIR`, `TASKMOOR_QUERY_TIMEOUT_MS`, `METRICS_PORT` and the `OTEL_*` tracing
variables from `.env`, for example:

```text
TASKMOOR_SMTP_URL=smtp://mail.example.com:587
TASKMOOR_SMTP_USER=taskmoor@example.com
TASKMOOR_SMTP_PASSWORD=...
TASKMOOR_SMTP_FROM="Taskmoor <taskmoor@example.com>"
```

Anything else, such as another volume, goes in an override file next to the kit, for example
`docker-compose.override.yml`; run `TASKMOOR_COMPOSE_OVERRIDE=docker-compose.override.yml bash
install.sh` (and name it the same way for `upgrade.sh`). Every variable is in the
[configuration reference](configuration.md).

### Installer options

`install.sh` reads these from the environment: `TASKMOOR_IMAGE` and `POSTGRES_IMAGE` pick the
images; `TASKMOOR_PULL=never` installs from images already loaded and never contacts a
registry; `TASKMOOR_COMPOSE_OVERRIDE` adds Compose files (several, separated by spaces).
`install.ps1` takes neither of the last two. Stop the stack with `docker compose down`; adding
`-v` also deletes the data.

## The all-in-one image

The all-in-one image runs PostgreSQL 16 and Taskmoor in one container, with everything in one
volume:

```bash
docker run -d --name taskmoor -p 8080:8080 -v taskmoor-data:/data taskmoor-allinone:dev
docker logs taskmoor
```

On the first start it creates the database under `/data/postgres`. PostgreSQL listens on
127.0.0.1 inside the container only. Every start first runs the upgrade, then the server, so
starting a newer image on the same volume upgrades it. Give settings with `-e`, for example
`-e PUBLIC_URL=https://tracker.example.com`. Run only one container per volume: two would
start PostgreSQL on the same files.

## Public address and reverse proxies

Set `PUBLIC_URL` to the address people type. Without it the server assumes
`http://localhost:8080`. The setup link, the links in emails and the session cookies follow it:
cookies are marked secure only when `PUBLIC_URL` starts with `https://`.

The Compose kits and the all-in-one image answer plain HTTP on port 8080. For anything beyond
a trial, put a reverse proxy with TLS in front (the Builder's backend kit brings Caddy), and:

- set `TASKMOOR_TRUSTED_PROXIES` to the proxy's address or network (`uniquelocal` covers
  private networks); otherwise every visitor looks like the proxy to the sign-in limits;
- let the proxy pass WebSocket upgrades: live updates and co-editing use
  `/api/v1/sync/socket` and `/api/v1/collab` on the same port.

Prefer a host name of its own. When `PUBLIC_URL` has a path (`https://example.com/tracker`),
that path becomes the base of the app's pages, but the app still calls the API at `/api/` on
the host's root, so the proxy must pass both.

## Clean URLs or hash routing

| Mode | Addresses | Where it is the default |
|---|---|---|
| `path` (clean URLs) | `/boards/7`; the server answers every page address with the app | The Compose kits, the all-in-one image, Helm and the Builder's kits |
| `hash` | `/#/boards/7`; the server redirects `/boards/7` there | A server started without a kit |

Set `TASKMOOR_WEB_ROUTING=hash` (Helm: `webRouting: hash`) when something in front of Taskmoor
cannot pass deep links through. Links of the other kind still open after a switch, so no
bookmark or email breaks. Setup, password and unsubscribe links always keep their token after
`#`, so it never reaches a server log.

## Serving the frontend from a static host

The image serves the web app it was built with (`/app/web`), and refuses to start the web role
next to a web app of another version (`version.json` beside `index.html` names it). The same
folder runs on any static host. Its `index.html` holds the public settings in a JSON block that
you fill without rebuilding:

```text
<script id="taskmoor-config" type="application/json">{"apiUrl":"https://api.example.com","routing":"path","basePath":"/","instanceName":"Acme"}</script>
```

The accepted keys are `apiUrl`, `routing`, `basePath`, `instanceName`, `instanceId` and
`instanceKey`; anything else is ignored with a warning in the browser console. With
`"routing": "path"`, add `<base href="/">` (your `basePath`) right before the block and have the
host answer unknown paths with `index.html`. The Builder's frontend kit does all of this for
you, with integrity hashes and the host's fallback files ([the Builder's kits](builder-kits.md)).
Taskmoor does not yet support signing in from another origin: the web app and the API must be
reachable on the same origin.

## Building from source

```bash
corepack pnpm install
TASKMOOR_VERSION=1.0.0 corepack pnpm build
DATABASE_URL='postgres://taskmoor:secret@localhost:5432/taskmoor' \
  TASKMOOR_DATA=/var/lib/taskmoor TASKMOOR_WEB_DIR=apps/web/dist \
  node apps/server/dist/server.mjs
```

`pnpm build` writes the web app to `apps/web/dist` and the bundled server and operator CLI to
`apps/server/dist`, both stamped with the version. Without `TASKMOOR_DATA` the server keeps no
attachments, no password pepper and no scheduled backups, and says so in its log. Backups need
`pg_dump` and `pg_restore` of the database's major version (`TASKMOOR_PG_BIN` names their
folder).

## Where data lives

| Install | Database | Files, backups and keys |
|---|---|---|
| Compose, bundled | Volume `postgres-data` | Volume `taskmoor-data`, mounted at `/data` |
| Compose, external | Your PostgreSQL server | Volume `taskmoor-data` |
| All-in-one | `/data/postgres` in the one volume | The same volume |
| Helm | Your PostgreSQL server | The `<release>-data` volume claim, or the S3 bucket |
| Builder's backend kit | Volume `postgres-data` | Volume `taskmoor-data`; `caddy-data` keeps the certificates |

Under `/data`, `files` holds attachments, `backups` holds backups, `imports` holds files for
imports, and `secrets/password-peppers` holds the password pepper. Keep that file: without it no
stored password verifies. Keep `.env` private and with your backups, since it holds the
database password. Next: [first-run setup](first-run.md), [backups](backups.md),
[upgrades](upgrades.md) and [monitoring](monitoring.md).
