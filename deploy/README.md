# Installing Taskmoor

One image runs every role (ADR-021). Pick a kit:

| Kit | For | Where |
|---|---|---|
| Compose with bundled PostgreSQL | A server of your own, up to a few hundred users | [`compose/`](compose/README.md) |
| Compose with an external PostgreSQL | A managed or shared database | [`compose/`](compose/README.md) |
| All-in-one container | Trials and single-box installs: PostgreSQL inside, one `/data` volume | [`allinone/`](allinone/Dockerfile) |

Every kit ends the same way: the backend logs a line like

```
{"msg":"first-run setup","link":"http://localhost:8080/#/setup?token=..."}
```

Open that link (`docker compose logs taskmoor` shows it) to create the first administrator.
The token works once and expires after 24 hours; restarting the backend prints a new one. Set
`PUBLIC_URL` (for example `https://tracker.example.com`) so the link and the session cookies
match the address people use, and `TASKMOOR_SETUP_TOKEN` to choose the token yourself, as an
installer or a test does.

Before an upgrade, run the pre-upgrade check (ADR-022): it blocks on a database that is
unreachable, older than PostgreSQL 16 or migrated by a newer release, and warns about disk
space and backup age:

```
docker compose exec taskmoor node cli.mjs check-upgrade
```

Then change the image tag and start again; migrations run at start (`node cli.mjs migrate`
runs them on their own, `node cli.mjs status` shows what is pending).

## Backups

A backup is a directory with the database (`pg_dump` custom format), the uploaded files, the
password keyring, the non-secret configuration and a manifest with a checksum per entry
(OPS-008). With the keyring inside, a backup is as sensitive as the live instance: store it
encrypted or on a protected host.

```
docker compose exec taskmoor node cli.mjs backup
```

It lands under `/data/backups/<timestamp>` on the `taskmoor-data` volume (`--out <dir>` picks
another place; copy it off the host afterwards) and refreshes the marker that the pre-upgrade
check reads, which warns when the last backup is older than a day. To restore, stop everything
but one backend, put the backup directory under `/data/backups`, then (OPS-009):

```
docker compose exec taskmoor node cli.mjs restore /data/backups/<timestamp> --yes
```

The restore verifies the checksums first, replaces the database contents and the files, and
leaves the instance exactly as it was backed up, including the administrators and their
sessions. The backup's password keys are added to this instance's keyring, never replacing it,
so the restored passwords keep working. `node cli.mjs checksum` prints one checksum per table; CI runs the whole drill
(back up, wipe, restore, compare) with `tools/image/drill-backup.sh` on every push.

**Scheduled backups are on by default** (M1-101, OPS-008). Once first-run setup is done, the
worker backs up every day at 02:30 UTC into `/data/backups/scheduled-<time>` (the
`TASKMOOR_BACKUP_DIR` variable names another directory; `off` stops this process from taking
them) and keeps the last 14; backups taken by hand are never removed by that retention. The
directory is created owner-only (0700) and the database password never appears on a command
line or in the backup log. Once a week a scheduled backup is followed by the restore drill.
Site administrators see the schedule, the last success, the last failure and the last drill
under Settings, System status, and change the time, the number kept and the weekly drill with
`PUT /api/v1/admin/backups/schedule`.

The restore drill proves a backup can be put back without touching the live database
(`node cli.mjs drill [<dir>]`, by default the newest backup): it checks the checksums, restores
into a scratch database on the same server, compares every table's row count with the counts
the backup took from the very snapshot it dumped, prints how long each step took and drops the
scratch database (`--keep` leaves it for a look). It needs a database user that may create
databases, which the kits' user may.

```
docker compose exec taskmoor node cli.mjs drill
```

The trash keeps deleted tickets and tracks for 30 days (Settings, Trash; site administrators
choose 1 to 365); an hourly job in the worker then deletes them for good, with their history,
and records each permanent deletion in the audit log. `node cli.mjs purge-trash` runs it now.

The Builder (M1) generates these files with fresh secrets and a reverse proxy with HTTPS; until
then, copy the examples and fill them by hand.

## Sign-in security

- **Password pepper.** Every password hash also depends on a secret key kept outside the
  database (ASVS 2.4.5). The instance creates it on first start in
  `/data/secrets/password-peppers`; keep that volume, and keep backups, which carry the key.
  To manage the key yourself, set `TASKMOOR_PASSWORD_PEPPER` (32 characters or more). The Helm
  chart creates one Secret for every pod and keeps it across upgrades and uninstalls.
- **Reverse proxies.** Sign-in is limited per account and per client address (five free
  failures per account, then a lock that doubles from 30 seconds to 15 minutes; 50 failures per
  address in 15 minutes). Behind a proxy, set `TASKMOOR_TRUSTED_PROXIES` to its address, its
  network (for example `uniquelocal` for private networks) or both; otherwise every visitor
  looks like the proxy. The Helm chart trusts private addresses by default.
- **Locked out?** An administrator can make a one-time password link for anyone; from the
  host, the operator CLI makes one for any account, the administrator's included:

```
docker compose exec taskmoor node cli.mjs password-link admin@example.com
```

## Audit log

Sign-ins, refused sign-ins and lockouts, changes to people, groups, roles, access policies and
grants, and changes to settings go to an append-only audit log in which every record carries
the hash of the one before it (IAM-013, ADR-034). Site administrators search it and export it
as CSV or JSON Lines through the API (`/api/v1/audit`, `/api/v1/audit/export`) and set how many
months it keeps (`/api/v1/audit/settings`: 12 by default, 0 keeps everything); once a day the
worker drops the months older than that. To check that no record was edited, removed or added:

```
docker compose exec taskmoor node cli.mjs audit-verify
```

It prints each workspace's chain status and exits with 1 when a chain is broken. Someone with
full rights on the database could rewrite a chain from start to end, so keep the head hash it
prints, or the last line of an export, somewhere else as well.

## Monitoring

Each process serves Prometheus metrics on an internal port, `9464` by default (`METRICS_PORT`,
`0` turns it off; `METRICS_HOST` picks the address). The Compose kits do not publish it: a
Prometheus on the same Docker network scrapes `taskmoor:9464/metrics`. The metrics cover
request latency per route (`taskmoor_http_request_duration_seconds`), statement latency
(`taskmoor_db_query_duration_seconds`), the database pool
(`taskmoor_db_pool_connections`), the age of the last backup
(`taskmoor_backup_age_seconds`), the version and roles (`taskmoor_build_info`) and the
usual process metrics.
`observability/` has an example Prometheus configuration (`prometheus.yml`), alert rules
(`alerts.yml`: instance down, server errors, slow requests and statements, a queueing database
pool, an old or missing backup) and a Grafana dashboard (`grafana-dashboard.json`).

Traces are off unless an OpenTelemetry collector is configured with the standard variables
(`OTEL_EXPORTER_OTLP_ENDPOINT`, or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, plus
`OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_SERVICE_NAME` if needed). Each request becomes a server
span that continues an incoming `traceparent`, with one child span per database statement (its
SQL text, never its parameters). Nothing leaves the server by default.

Site administrators see the same picture in the app under Settings, System status: version and
uptime, database connection, size, migrations and pool, free disk space, the last backup, and
the runtime.
