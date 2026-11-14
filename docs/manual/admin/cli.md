---
title: "The operator CLI"
audience: admins
sources: apps/server/src/updates/check.ts, apps/server/src/cli.ts, apps/server/src/config.ts, apps/server/src/backup.ts, apps/server/src/backups/drill.ts, apps/server/src/backups/schedule.ts, apps/server/src/upgrade.ts, apps/server/src/upgrade-check.ts, apps/server/src/directory.ts, apps/server/src/audit/chain.ts, apps/server/src/fields/jobs.ts, apps/server/src/workflows/free-moves.ts, apps/server/src/reports/events.ts, apps/server/src/trash/purge.ts, apps/server/src/export/write.ts, Dockerfile, deploy/README.md, deploy/compose/upgrade.sh, deploy/allinone/Dockerfile, deploy/allinone/entrypoint.sh, deploy/helm/README.md, deploy/helm/taskmoor/templates/workloads.yaml, docs/adr/0022-upgrades-and-migrations.md, apps/server/src/embeddings/backfill.ts, docs/adr/0106-local-embeddings-and-vector-search.md
accessed: 2026-11-06
attestation: own-words
---
# The operator CLI

The Taskmoor image ships a command line for operators, `cli.mjs`, next to the server in `/app`.
It upgrades, backs up, restores and checks a site, writes exports, and makes a password
link when an administrator is locked out. It talks to the database directly, so it runs where
the backend runs, with the backend's environment.

## Running it

| Kit | Run a command |
|---|---|
| Compose, bundled PostgreSQL | `docker compose exec taskmoor node cli.mjs <command>` |
| Compose, external PostgreSQL | `docker compose -f docker-compose.external.yml exec taskmoor node cli.mjs <command>` |
| All-in-one | `docker exec -u node -e DATABASE_URL=postgres://postgres@127.0.0.1:5432/taskmoor <container> node cli.mjs <command>` |
| Helm | `kubectl exec deploy/taskmoor-app -- node cli.mjs <command>` (for a release named `taskmoor`) |

In the all-in-one image the start script sets the database address for the server only, so a
command run with `docker exec` must be given it; `-u node` keeps the files it writes owned by the
app's user. The all-in-one start script also takes `upgrade` itself, for a container that is
stopped: `docker run --rm -v taskmoor-data:/data <image> upgrade [--dry-run]`.

The CLI reads the same variables as the server. Every command but `mcp` needs `DATABASE_URL`, and
stops with exit code 2 without it. `TASKMOOR_DATA` (set to `/data` in the image) gives the data
directory, `TASKMOOR_BACKUP_DIR` the backup directory, and `PUBLIC_URL` the address in password
links. See [Configuration reference](configuration.md).

`node cli.mjs help` prints the usage line.

## Commands at a glance

| Command | Does | Exit codes besides 0 |
|---|---|---|
| `upgrade [--dry-run] [--no-backup] [--unattended]` | Checks, backs up, migrates, verifies, rolls back on failure | 1 not upgraded, 3 rollback failed |
| `check-upgrade` | The pre-upgrade checks alone | 1 something blocks |
| `frontends` | The registered frontends on other hosts, one origin per line; `update.sh` names them when it finishes | 1 failed |
| `migrate` | Applies pending migrations, nothing else | 1 failed |
| `status` | Applied and pending migrations as JSON | 1 failed |
| `backup [--out <dir>]` | A full backup | 1 failed |
| `restore <dir> --yes` | Puts a backup back | 1 failed, 2 no directory or no `--yes` |
| `drill [<dir>] [--keep]` | Restores a backup into a scratch database and checks it | 1 mismatch, 2 no backup found |
| `checksum [--wait]` | One checksum per table | 1 failed |
| `export <dir> [--tracks KEY,KEY]` | The site in Taskmoor's export format | 2 no folder, folder not empty or unknown track |
| `purge-trash` | Deletes for good what outlived the trash retention | 1 failed |
| `field-values [--repair]` | Checks the custom field search tables | 1 differences left unrepaired |
| `workflow-moves [--repair]` | Lists the workflows in which no ticket can move, and gives them free moves | 1 some left without moves |
| `report-verify` | Replays every ticket's report events | 1 a ticket differs |
| `embeddings [--rebuild]` | Embeds every ticket and comment that lacks an embedding, for similar tickets | 2 embeddings are off |
| `password-link <email>` | A one-time link to set a password | 1 no active account, 2 no email |
| `audit-verify` | Checks the audit log's hash chains | 1 a chain is broken |
| `allowlist-off` | Turns the IP allowlist off, for an administrator locked out by it | |
| `mcp` | MCP over standard input and output | 2 `TASKMOOR_URL` or `TASKMOOR_TOKEN` missing |

Any command exits with 1 when it fails with an error, printed on standard error with passwords
in connection URLs replaced by `***`. An unknown command prints the usage line and exits with 2.

## Upgrades and migrations

### upgrade

Takes the database from an earlier release to this image's version: pre-flight checks, a
pre-upgrade backup, every pending migration in one transaction, a check against the reviewed
schema, and a rollback on any failure. The last line of its output is the whole report as JSON.

| Option | Effect |
|---|---|
| `--dry-run` | Prints the checks and the plan; changes nothing |
| `--no-backup` | Takes no backup, for databases whose provider keeps them; refuses plans with online migrations |
| `--unattended` | For an image that upgrades at start: a target whose last attempt failed is not tried again |

It exits with 0 when upgraded, up to date or after a dry run, 1 when it did not upgrade and the
database is as it was, and 3 when the rollback failed too. The Compose kit's `upgrade.sh` and the
all-in-one image run it for you. See [Upgrades](upgrades.md).

### check-upgrade

Runs the read-only checks: the database answers and runs PostgreSQL 16 or later, no migration
of a newer release is applied, the upgrade path is supported, there is disk space, and a recent
backup exists. Each line starts with `ok`, `warn` or `BLOCK`. It exits with 1 while anything
blocks. The Helm chart runs it before every `helm upgrade`.

### migrate

Applies pending migrations and exits, printing `Up to date.` or the migrations applied. It takes
no backup and runs no checks, like the server when it starts on an older database. Prefer
`upgrade` unless you back up some other way.

### status

Prints the migration status as JSON: `applied`, `pending`, `unknown` (applied by a newer release)
and `outOfOrder`.

## Backups

### backup

Backs up the database, the files and the password keyring. Without `--out`, the backup goes to
`backups/<time>` under `TASKMOOR_DATA`. It waits up to an hour while a scheduled backup runs, and
prints the directory, its size and its number of migrations. See
[Backups and restore](backups.md).

### restore

`node cli.mjs restore <dir> --yes` verifies the backup's checksums, replaces the database
contents, copies the files back and merges the password keyring. Stop every other Taskmoor
process first; without `--yes` it only says so. It prints the time and version of the backup it
restored.

### drill

Restores a backup into a scratch database on the same server, compares every table's row count
and the migrations with the backup's manifest, prints the time of each step and a JSON report,
then drops the scratch database. Without `<dir>` it takes the newest backup in the backup
directory; `--keep` leaves the scratch database and prints how to drop it. The database user must
be allowed to create databases.

### checksum

Prints a JSON object with one entry per table: its row count and a checksum of its rows, as
`<rows>:<md5>`. `--wait` first waits (up to a minute) for the worker to publish pending events
and run due jobs. Compare the output before a backup and after a restore.

## Data

### export

`node cli.mjs export <dir>` writes the site in Taskmoor's export format into a new or empty
folder; `--tracks KEY,KEY` exports only those tracks and what belongs to them. The last line is a
JSON summary: the folder, the seconds it took, the records per kind and the number of files. Each
export is recorded in the audit log. In the image, write under the data volume:

```bash
docker compose exec taskmoor node cli.mjs export /data/exports/2026-10-30
```

See [Importing and exporting](import-export.md).

### purge-trash

Deletes for good every ticket and track that has been in the trash longer than the retention, as
the worker's hourly job does, and prints how many it removed.

### field-values

Custom field values are also kept in side tables that searches filter, sort and count by. This
command compares them
with the values stored on every ticket and prints one JSON line per site: tickets checked,
how many differ, how many were repaired, and the ids of up to 100 that differ. `--repair` rewrites
the ones that differ. The worker runs the same check once a day.

### workflow-moves

Lists the workflows whose published version has no transitions at all, so no ticket in them can
move: workflows made empty before free moving became the rule, and any imported from a file, or
published from an earlier version, that had none. It prints one JSON line per site: how many
it found (`withoutMoves`), how many it repaired and their ids. `--repair` gives each one a
transition from any status into each of its statuses, as a new workflow gets, and publishes that
as the workflow's next version; a move into a closed-stage status sets the close reason free
moves close with. Each workflow it repairs records one published version by the system in the
audit log. A draft someone saved stays as it is; saving it gives it the same moves. A workflow
with a rule, or one a board manages, is left for you to edit, stays listed and makes the command
exit with 1. See [Workflows](workflows.md).

### report-verify

Replays every ticket's report events and compares the result with the tickets as they are, so
reports can be trusted to rebuild from their events. It prints one JSON line per site with
`ok`, the number of differences and the first 20. Tickets older than the change history report
as having no history.

### embeddings

Embeds, with the bundled model (or the endpoint `TASKMOOR_EMBEDDINGS` names), every ticket and
comment whose embedding is missing, made by another model or older than its text, and sets up
pgvector's index where the database has the extension. It prints progress, then one JSON line
per site: what it embedded, how lookups run (`pgvector` or `exact`) and how many tickets
and comments have an embedding. `--rebuild` deletes the site's embeddings first and makes
them all again. The worker does the same in the background on its own; see
[similar tickets](similar-tickets.md).

## Accounts and security

### password-link

```bash
docker compose exec taskmoor node cli.mjs password-link admin@example.com
```

Prints a one-time link to set a password, for any active account, administrators included: an
account without a password gets an activation link, one with a password a reset link. The link
is valid for three days and works once. Set `PUBLIC_URL` so the link carries the right address.
The link's creation is recorded in the audit log. See [People and groups](people-and-groups.md).

### allowlist-off

Turns off the IP allowlist of every site where it is on ([network
access](permissions.md#network-access-the-ip-allowlist)), for an administrator who saved a list
that keeps them out. The change is in the audit log without a person as its actor.

### audit-verify

Walks every site's audit hash chain and prints one JSON line each: `ok`, the records
checked, where checking started, the head's sequence number and hash, and the first broken
record. Keep the head hash somewhere else as well. See [Monitoring and logs](monitoring.md).

## The MCP bridge

### mcp

`node cli.mjs mcp` lets an MCP client that only speaks over standard input and output reach a
running Taskmoor server. Each line on standard input is a JSON-RPC message, sent to the server at
`TASKMOOR_URL` with the API token in `TASKMOOR_TOKEN`; answers come back on standard output and
logs go to standard error. It needs no database. See [The MCP server](mcp.md).
