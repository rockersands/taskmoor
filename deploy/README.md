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

## The web frontend

The image serves the frontend it was built with (`/app/web`, `version.json` beside
index.html names its version) and refuses to start the web role next to a frontend of another
version. Addresses use hash routing (`/#/boards/7`) unless you set
`TASKMOOR_WEB_ROUTING=path` for clean URLs (`/boards/7`); either way links of the other kind
still open, so switching breaks no bookmark or email. Behind a reverse proxy that serves
Taskmoor under a path, put that path in `PUBLIC_URL` (`https://example.com/tracker`).

The same folder runs on any static host (ADR-066). Its index.html carries the public runtime
configuration in a JSON block you fill without rebuilding; only these keys are accepted:

```html
<script id="taskmoor-config" type="application/json">{"apiUrl":"https://api.example.com","routing":"path","basePath":"/","instanceName":"Acme"}</script>
```

With `"routing": "path"`, add `<base href="/">` (your `basePath`) right before that block and
have the host answer unknown paths with index.html; with `"routing": "hash"` (the default) no
host rules are needed. The Builder's frontend kit (M1-111) fills both and adds the host's
fallback files. Signing in from another origin waits for M1-107.

## Upgrades

One command takes an instance from any of the last three releases (and from the latest
long-term-support release) to a new one, with no step per version (OPS-006, ADR-022):

| Kit | Upgrade |
|---|---|
| Compose | `bash upgrade.sh ghcr.io/rockersands/taskmoor:<version>` in `deploy/compose` |
| All-in-one | Start the new image on the same volume: it upgrades before it serves |
| Helm | `helm upgrade` ([`helm/README.md`](helm/README.md)) |

Each runs `node cli.mjs upgrade` from the new image, which:

1. **Checks first and changes nothing** if anything blocks: the database answers and runs
   PostgreSQL 16 or later; no other upgrade is running; no migration of a newer release is
   applied (a downgrade); the database is no more than three releases back (otherwise it names
   the release to upgrade to first); there is room for the backup; no other Taskmoor process is
   connected (a warning, or a blocker for online migrations). It then lists every migration it
   will apply with a rough time estimate.
2. **Backs up** the database, the files and the password keyring into
   `/data/backups/pre-upgrade-<time>` (or under `TASKMOOR_BACKUP_DIR`), waiting for a running
   backup to finish first. The backup log lists it as a manual backup, so scheduled retention
   never deletes it: remove it yourself once the new version has proved itself.
3. **Applies the migrations** of all the releases it crosses in one transaction, and checks the
   result against the reviewed schema before committing.
4. **Rolls back on any failure**: the transaction leaves the database exactly as it was; when a
   migration that cannot run in a transaction (`online`, such as an index built concurrently on
   a large table) has already committed, it restores the pre-upgrade backup instead and checks
   every table against it. The report names the migration that failed and what went wrong.

It exits with 0 when upgraded (or when there was nothing to do), 1 when it did not upgrade and
the database is as it was, and 3 when the rollback failed too: then keep Taskmoor stopped and
restore the backup it names (`node cli.mjs restore <dir> --yes`). The last line of its output is
the whole report as JSON; the backup log keeps the outcome with the pre-upgrade backup. To see
the checks and the plan without changing anything:

```
bash upgrade.sh ghcr.io/rockersands/taskmoor:<version> --dry-run
```

**Compose.** `upgrade.sh` pulls the image when it is missing, stops the backend (PostgreSQL keeps
running), runs the upgrade from the new image, records the new image as `TASKMOOR_IMAGE` in
`.env` and starts it. When the upgrade fails, it starts the previous image again on the
unchanged database. Like `install.sh`, it uses the external-PostgreSQL file when `DATABASE_URL`
is set and honours `TASKMOOR_COMPOSE_OVERRIDE` and `TASKMOOR_PULL=never`.

**All-in-one.** Every start runs the upgrade (`--unattended`) before the server: with nothing to
apply it costs a few queries. When an upgrade fails, the container stops with the database as it
was, and the next start of the same image does not try again (no pile of backups from a
restarting container): start the previous image, or retry by hand with the container stopped,
never beside a running one (both would start PostgreSQL on the same files):

```
docker run --rm -v taskmoor-data:/data <image> upgrade [--dry-run]
```

**The advanced path.** `node cli.mjs check-upgrade` runs the checks alone (the Helm chart's
pre-upgrade hook); `node cli.mjs migrate` applies pending migrations without a backup or
checks, as the server does when it starts on an older database; `node cli.mjs status` shows
what is applied and pending. `node cli.mjs upgrade --no-backup` skips the backup when the
database provider keeps its own (snapshots, point-in-time recovery): a failure is then rolled
back by the transaction alone, and plans with online migrations are refused.

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

## Attachments

Files attached to tickets live on local disk by default, under `/data/files` on the data volume
(`TASKMOOR_FILES_DIR` names another directory), so they are in every backup. Larger sites put
them in an S3-compatible bucket (AWS S3, MinIO, Garage, Ceph, R2) with these variables; keys
and secrets come from the environment or a secrets manager, never from a file in the kit:

| Variable | Meaning |
|---|---|
| `TASKMOOR_S3_BUCKET` | The bucket; setting it makes S3 the store for new files (`TASKMOOR_STORAGE=local` keeps disk) |
| `TASKMOOR_S3_ENDPOINT` | The store's address, for anything but AWS (path-style addressing then) |
| `TASKMOOR_S3_PUBLIC_ENDPOINT` | The address browsers reach it at, when it differs; downloads are signed for it |
| `TASKMOOR_S3_REGION`, `TASKMOOR_S3_PREFIX` | Region (default `us-east-1`) and a key prefix such as `taskmoor/` |
| `TASKMOOR_S3_ACCESS_KEY_ID`, `TASKMOOR_S3_SECRET_ACCESS_KEY` | Credentials; without them the AWS default chain (instance role, IRSA) applies |
| `TASKMOOR_S3_SSE`, `TASKMOOR_S3_SSE_KMS_KEY_ID` | Server-side encryption (`AES256` or `aws:kms`) |
| `TASKMOOR_S3_URL_TTL` | Seconds a signed download URL lives (default 300, at most 3600) |
| `TASKMOOR_SCAN_CLAMD` | ClamAV's daemon (`host:3310` or `unix:/path`); files are served once it finds them clean |

The bucket stays private: browsers download through URLs the server signs for five minutes,
after checking that the person may see the ticket. Give the bucket a lifecycle rule that aborts
incomplete multipart uploads after a day (the worker also aborts those older than a day).
Files already on disk stay readable after a switch to S3 while the data volume is mounted.
Site administrators set the largest file allowed (1 GB by default, no upper limit) with
`PUT /api/v1/admin/attachment-settings`; there is no storage quota.

## Exports and imports

Site administrators download the whole workspace at any time as documented files
(`docs/export-format.md`): `GET /api/v1/admin/export` streams a ZIP, and
`docker compose exec taskmoor node cli.mjs export /data/exports/<name>` writes the same into a
folder. Imports of CSV files (`docs/csv-import.md`) and of such exports read files named by path
only inside `/data/imports` (`TASKMOOR_IMPORT_DIR` names another directory, `off` refuses
paths); uploads of up to 16 MB need no folder.

## Email notifications

Notification emails go through an SMTP server you name with these variables; the password comes
from the environment or a secrets manager, never from a file in the kit. Without
`TASKMOOR_SMTP_URL` notifications still reach the inbox and email waits unsent.

| Variable | Meaning |
|---|---|
| `TASKMOOR_SMTP_URL` | `smtp://host:587` (STARTTLS when offered) or `smtps://host:465`; no credentials in it |
| `TASKMOOR_SMTP_USER`, `TASKMOOR_SMTP_PASSWORD` | The sign-in, both or neither |
| `TASKMOOR_SMTP_FROM` | The From address, for example `Taskmoor <taskmoor@example.com>` |

`PUBLIC_URL` must be set for the links in emails. Changes to one ticket within two minutes
arrive in one email (site administrators set the window and the digest hour with
`PUT /api/v1/admin/email-settings`); people choose instant email, daily or weekly digests, quiet
hours and events on their Account page. Every email carries a one-click unsubscribe link
(RFC 8058). There is no daily sending cap; your SMTP provider may have one.

## Search

Every search runs read-only and stops after `TASKMOOR_QUERY_TIMEOUT_MS` milliseconds (default
30000, between 100 and 600000); a query that runs longer answers `503 query_timeout` and holds
nothing. Site administrators see the SQL of a query and the planner's plan for it with
`GET /api/v1/admin/search/explain?q=...` (add `analyze=true` to run it under the same timeout).
Postgres plans searches best when it knows the storage: on SSDs set `random_page_cost = 1.1`
and `effective_cache_size` to about three quarters of the memory Postgres can use.

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
