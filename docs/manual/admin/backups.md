---
title: "Backups and restore"
audience: admins
sources: apps/server/src/backup.ts, apps/server/src/backups/schedule.ts, apps/server/src/backups/runs.ts, apps/server/src/backups/drill.ts, apps/server/src/cli.ts, apps/server/src/config.ts, apps/server/src/secrets.ts, apps/server/src/routes/backups.ts, apps/server/src/routes/admin.ts, apps/server/src/routes/trash.ts, apps/server/src/trash/purge.ts, apps/server/src/trash/policy.ts, apps/web/src/admin/SystemPage.tsx, apps/web/src/admin/TrashPage.tsx, apps/web/src/i18n/messages.en.ts, deploy/README.md, deploy/compose/docker-compose.yml, deploy/allinone/Dockerfile, deploy/allinone/entrypoint.sh, deploy/helm/README.md, deploy/helm/taskmoor/templates/workloads.yaml, tools/image/drill-backup.sh, docs/adr/0022-upgrades-and-migrations.md, docs/specs/05b-administration-security-and-self-hosting.md
accessed: 2026-11-03
attestation: own-words
---
# Backups and restore

Taskmoor backs itself up every night once first-run setup is done, and the operator CLI takes,
checks and restores backups by hand. This page covers what a backup holds, where it goes, how to
put one back, and the trash, which is the first place to look when someone deleted something by
mistake.

## What a backup holds

A backup is a directory of plain files; nothing in it is encrypted.

| Entry | Contents |
|---|---|
| `db.dump` | The whole database, in `pg_dump`'s custom format |
| `files/` | A copy of the `files` folder of the data directory: attachments kept on local disk |
| `secrets/password-peppers` | The password keyring, which every password hash depends on |
| `config.json` | Non-secret settings: `PUBLIC_URL`, `TASKMOOR_ROLE`, `TASKMOOR_VERSION` |
| `manifest.json` | The version, the time, the applied migrations, a SHA-256 checksum per entry and the row count of every table |

The row counts come from the very snapshot the dump holds, so a restore can prove that every row
came back.

With the keyring inside, a backup is as sensitive as the live site: store it encrypted or on
a protected host. The directories Taskmoor creates for backups are owner-only (mode 0700), and
the database password never appears on a command line or in the backup log.

A backup does not hold:

- attachments in an S3-compatible bucket, or in a directory that `TASKMOOR_FILES_DIR` names
  outside the data directory; back those up with their own tools;
- the pepper itself when it comes from `TASKMOOR_PASSWORD_PEPPER` rather than the keyring file;
  keep that value somewhere safe;
- the backup log, which describes the backups on this host and stays with it.

## Where backups go

| Backup | Directory |
|---|---|
| Scheduled | `scheduled-<time>` under `TASKMOOR_BACKUP_DIR`, or under `backups` in `TASKMOOR_DATA` when it is unset |
| By hand (`node cli.mjs backup`) | `backups/<time>` under `TASKMOOR_DATA`, or the directory `--out` names |
| Before an upgrade | `pre-upgrade-<time>` in the same directory as scheduled backups |

In the image `TASKMOOR_DATA` is `/data`, so backups land in `/data/backups` on the data volume.
`<time>` is UTC, for example `2026-10-30T02-30-00`. A backup taken by hand ignores
`TASKMOOR_BACKUP_DIR`: give it `--out` to put it next to the scheduled ones.

`TASKMOOR_BACKUP_DIR=off` stops a process from taking scheduled backups. The Compose kits pass
`TASKMOOR_BACKUP_DIR` from `.env`; a directory outside the data volume also needs a volume for it
in a Compose override file. `cli.mjs backup` without `--out` writes there too, so the restore
drill finds backups taken by hand.
Keeping backups on the same disk as the data protects against mistakes, not against losing the
disk, so copy them to another host as well.

## Scheduled backups

Scheduled backups are on by default. The worker role checks every five minutes and takes the
day's backup once, across all workers, when its time has come. The defaults:

| Setting | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Take a backup every day |
| `time` | `02:30` | Time of day in UTC, `HH:MM` |
| `keep` | `14` | Scheduled backups to keep, from 1 to 365; one a day, so this many days |
| `verify` | `true` | Once a week, run the restore drill on the latest scheduled backup |

After each successful scheduled backup, the oldest ones beyond `keep` are deleted. Retention only
deletes directories inside the backup directory that hold a manifest, and never a backup taken by
hand or before an upgrade: remove those yourself. A scheduled backup that fails leaves no
directory behind.

Only one backup and one drill run at a time. A run whose process stopped answering is marked
failed after five minutes. A worker without a backup directory records a failed run that says
so, and the admin status page shows it.

### Changing the schedule

Site administrators read the schedule, the next run, the last success, failure and drill, and
the recent runs with `GET /api/v1/admin/backups`, and change any of the four settings with
`PUT /api/v1/admin/backups/schedule`:

```http
PUT /api/v1/admin/backups/schedule
Content-Type: application/json

{"time": "01:15", "keep": 30}
```

Fields left out keep their value. Every change is recorded in the audit log. Where backups go is
never something the API can change: it is the operator's choice through `TASKMOOR_BACKUP_DIR`.

## Taking a backup by hand

```bash
docker compose exec taskmoor node cli.mjs backup
```

It prints the directory, its size and the number of migrations. When a scheduled backup is
running, it waits for it to finish (up to an hour). Each backup refreshes the marker
`backups/last` in the data directory, which the pre-upgrade check and the backup-age metric
read. To copy a backup off the host:

```bash
docker compose cp taskmoor:/data/backups/2026-10-30T09-12-44 ./2026-10-30T09-12-44
```

See [Commands in each kit](#commands-in-each-kit) for the all-in-one image and Helm.

## Checking backups

### The restore drill

The drill proves that a backup can be put back, without touching the live database:

```bash
docker compose exec taskmoor node cli.mjs drill
```

It verifies the checksums, restores the backup into a scratch database named
`taskmoor_drill_<time>_<process>` on the same server, compares every table's row count and the
applied migrations with the manifest, prints how long each step took, and drops the scratch
database. `node cli.mjs drill <dir>` drills a chosen backup; without it, the newest backup in the
backup directory (`TASKMOOR_BACKUP_DIR`, else `backups` in `TASKMOOR_DATA`) is used. `--keep` leaves the scratch database for a look. The database
user needs the right to create databases, which the bundled PostgreSQL's user has.

The drill exits with 1 when a count or the migrations differ, and with 2 when it finds no
backup. Scheduled drills run weekly when `verify` is on; their outcome shows on the System status
page.

### Table checksums

`node cli.mjs checksum --wait` prints one checksum per table, over its rows in a stable order.
Equal output before a backup and after a restore means nothing was lost or changed. `--wait`
first lets the worker finish relaying events and running jobs, so the numbers hold still.

## Restoring a backup

A restore replaces the database contents and copies the backup's files back. Before you start:

1. Stop every Taskmoor process but one backend (in the Compose kit there is only one).
2. Put the backup directory where that backend can read it, for example under `/data/backups`.

```bash
docker compose cp ./2026-10-30T09-12-44 taskmoor:/data/backups/2026-10-30T09-12-44
docker compose exec taskmoor node cli.mjs restore /data/backups/2026-10-30T09-12-44 --yes
```

Without `--yes` the command refuses and exits with 2. The restore:

- verifies every checksum first, and stops before changing anything when one differs;
- reads the keyring, then restores the database with `pg_restore` (up to four jobs in parallel);
- keeps this host's backup log as it was;
- copies the backup's `files` into the data directory;
- adds the backup's password keys to this site's keyring, never replacing it, so the
  restored passwords keep working.

The site comes back exactly as it was backed up, administrators and their sessions included.
The database returns at the schema of the version that took the backup; a newer server applies
its own migrations when it next starts. The same steps restore onto a new host.

## The backups in the web app

Under **Administration**, **System status**, site administrators see a **Scheduled backups** section:

| Label | Shows |
|---|---|
| **Schedule** | "Every day at 02:30 UTC, keeping the last 14", or **Off** |
| **Next backup** | When the next one starts, or that one is running |
| **Last success** | Time and size of the last good backup |
| **Last failure** | Time and error of the last failed one, in red until a backup succeeds after it |
| **Restore drill** | When the last drill passed and how long the restore took, or why it failed |

The **Storage** section shows **Last backup** from the marker, with a warning once it is older
than a day. The page reads; the schedule changes through the API. See
[Monitoring and logs](monitoring.md) for the rest of the page.

## The trash

Deleted tickets and tracks wait in the trash before they are deleted for good, 30 days by
default. Restoring one puts it back as it was, with its history and links. This is quicker than
any backup for undoing a mistake.

- **Administration**, **Trash** lists the tickets and tracks in the trash, when each one goes for good,
  and a **Restore** button for each.
- Site administrators set **Days in the trash** (1 to 365) under **Retention** on the same page,
  or with `PUT /api/v1/admin/trash-policy` and `{"retentionDays": 60}`. A shorter time applies to
  everything already in the trash at the next purge.
- An hourly job in the worker deletes for good what has outlived the retention, with its
  history, links and files. Every permanent deletion is recorded in the audit log.
- `node cli.mjs purge-trash` runs that purge now and prints how many tickets and tracks it
  removed.
- A site administrator deletes one ticket in the trash for good at once with
  `POST /api/v1/tickets/<key or id>/purge`; its subtickets in the trash go with it.

## Commands in each kit

| Kit | Run a command |
|---|---|
| Compose, bundled PostgreSQL | `docker compose exec taskmoor node cli.mjs <command>` |
| Compose, external PostgreSQL | `docker compose -f docker-compose.external.yml exec taskmoor node cli.mjs <command>` |
| All-in-one | `docker exec -u node -e DATABASE_URL=postgres://postgres@127.0.0.1:5432/taskmoor <container> node cli.mjs <command>` |
| Helm | `kubectl exec deploy/taskmoor-app -- node cli.mjs <command>` (for a release named `taskmoor`) |

In the all-in-one image the database address is set by the start script, so a command run with
`docker exec` must be given it. Backups land under `/data/backups` on the container's volume.

The Helm chart's worker has no persistent directory, so it sets `TASKMOOR_BACKUP_DIR=off`, and
the chart has no value yet for mounting one. Back up the database with its provider's tooling
(snapshots, point-in-time recovery) and turn scheduled backups off with `{"enabled": false}`.
With local storage, a backup taken by hand in the app pod goes to its data volume. See
[Kubernetes with Helm](helm.md).

## Not yet available

Taskmoor does not yet encrypt backups, send them to S3 or SFTP, offer point-in-time recovery, or
restore a single track from a backup into a live site. For those, use your database provider's
tooling alongside Taskmoor's own backups.
