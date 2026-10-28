# ADR-022: Forward-only expand/contract migrations, pre-flight checks and automatic backup

- Status: Accepted
- Date: 2026-10-12
- Backlog: M0-024, M0-029, M0-030

## Context

Unattended upgrades are the promise: one command, three minor versions in one step, zero manual
steps, automatic backup, rollback on failure (OPS-006). Backups and restores must be scheduled,
verified and able to recover a single track or deleted tickets (OPS-008, OPS-009). Tables with
tens of millions of rows cannot be locked for minutes.

## Decision

- **Forward-only migrations** (ADR-007) with no down scripts. Rollback is a restore of the
  automatic pre-upgrade backup, which the upgrade command takes and verifies first.
- **Expand and contract** for anything the running version still reads: add the column or
  table and backfill in batches (release N), switch readers and writers (N), drop the old shape
  (N+1). Index builds on large tables run `CONCURRENTLY` outside the transaction; migrations
  declare `online: true` to opt in.
- **Pre-flight** before any change: upgrade path supported (N-3 to N), disk space for the
  backup and the migration, extension compatibility, backup age, `pg_version`, and a dry run
  that prints the plan. Failures stop before anything is written.
- **Upgrade harness in CI** (M0-029): fixture databases from the last three minors are
  upgraded to the candidate and the full suite runs on each.
- **Backup and restore CLI** (M0-030): `taskmoor backup` (database with `pg_dump` in
  directory format, files, configuration; encrypted; to disk, S3 or SFTP; retention rules;
  optional WAL archiving for point-in-time recovery) and `taskmoor restore` to the same or a
  new host, into a sandbox, or a single track or deleted tickets into the live site. A scheduled
  verification restores into a scratch database and reports.
- **Rolling upgrades** on Kubernetes: the backend serves API N-1 (ADR-032) and migrations are
  compatible with the previous version's code during expand, so old pods keep working.

## Options considered

| Option | For | Against |
|---|---|---|
| Forward-only, expand/contract, restore to roll back (chosen) | One tested path; works for data migrations too; matches managed Postgres | A failed contract step needs a restore, so backups are mandatory (they are) |
| Reversible down migrations | Quick rollback of schema | Data loss on down; rarely tested; false confidence |
| ORM auto-migration | No migration files | Unreviewed DDL on production tables |

## Consequences

Every migration is reviewed for lock behaviour; the harness makes "three versions in one step"
a tested claim. The restore drill is part of the release checklist and the nightly job.

## Implementation (M1-101: scheduled backups, the restore drill and the trash)

Migration 0022 adds `backup_run` (instance-wide), `trash_policy` (per workspace) and the trash
columns of `track`. Code: `apps/server/src/backups/` (schedule, log, drill),
`apps/server/src/trash/` (retention, purge), `routes/backups.ts`, `routes/trash.ts`.

- **Scheduled backups are on by default** and use the operator CLI's code path (`backup.ts`), so
  there is one way to take a backup. The worker checks every five minutes and queues the day's
  backup once across all workers (the job key names the scheduled time); nothing is taken
  before first-run setup. Defaults: every day at 02:30 UTC, keep 14, verify weekly; site
  administrators change them (`PUT /api/v1/admin/backups/schedule`, audited as
  `backup_schedule.updated`). The directory is the operator's (`TASKMOOR_BACKUP_DIR`, else
  `TASKMOOR_DATA/backups`), never the API's: an administrator cannot make the server write
  elsewhere. Retention counts scheduled backups (keep the newest N), which makes OPS-008 (1)
  exact; it only deletes directories inside the backup directory that hold a manifest, and
  never a backup taken by hand.
- **The backup log** (`backup_run`) records every backup and drill with its state, path, size,
  measurements and error. A unique partial index allows one running backup and one running drill;
  a heartbeat every 30 seconds (which also extends the job's lock, so `releaseStale` never
  starts a second copy of a long backup) tells a live run from one whose process died, which is
  marked failed after five minutes. The log is not part of a backup (`--exclude-table-data`);
  a restore keeps the live log, because it describes the backups on this host.
- **Consistency:** the backup counts every table's rows in a repeatable-read transaction that
  exports its snapshot, and pg_dump dumps that very snapshot (`--snapshot`), so the manifest's
  `rowCounts` match the dump exactly.
- **Secrets:** a backup holds the password keyring and sealed values, so the scheduled backup
  directory is created owner-only (0700). The database password moves from the URL to
  `PGPASSWORD` for pg_dump and pg_restore, so it is never on a command line (the process list,
  error messages); errors are stored and printed with URL passwords redacted.
- **The restore drill** (`node cli.mjs drill`, and weekly after a scheduled backup): verify the
  checksums, create a scratch database on the same server, `pg_restore --jobs=N` into it,
  compare every table's row count with the manifest and the applied migrations, report the
  time of each step, drop the scratch database whatever happened. Restores (the drill and
  `restore`) run pg_restore with up to four parallel jobs. It needs CREATEDB, which the kits'
  database user has; elsewhere it fails with that reason.
- **Kubernetes:** the chart's worker has no persistent volume, so it sets
  `TASKMOOR_BACKUP_DIR=off` and the status page reports a failed scheduled backup with the
  reason until the administrator turns them off (the database provider backs up) or mounts a
  volume.

The trash (CORE-025 (3)) is part of user-error recovery (OPS-009):

- **Retention** is a workspace setting, 1 to 365 days, default 30 (`trash_policy`,
  `PUT /api/v1/admin/trash-policy`); the purge date shown on a ticket or track follows it.
- **The purge job** runs hourly in the worker (one run per hour across workers) and deletes, in
  batches of 200 tickets per transaction, tickets in the trash longer than the retention, then
  such tracks. A run stops between batches after three minutes, so the worker's other jobs
  (the audit log among them) never wait long, and queues the next run at once when more is
  left. A ticket leaves with the subtickets that cannot live without it; its history,
  links, web links, followers, votes, releases and areas cascade. The tickets that stay record
  the loss in their history (a `link` row, or a `parent` row for a child elsewhere). Each
  permanent deletion is one audited event (`ticket.purged`, `track.purged`, with the reason
  `retention` or `admin`), so the audit log keeps `ticket.deleted` and `ticket.purged` after the
  ticket's own history is gone. Site administrators can purge one ticket or track at once.
- **Tracks in the trash** (`DELETE /api/v1/tracks/:id`, `POST .../undelete`, by site and
  configuration administrators) keep their tickets, releases, areas and keys untouched. The
  authorizer grants nothing in such a track, to anyone, and leaves it out of every pre-filter,
  so the track and its tickets are invisible everywhere; only the trash routes show it to those
  who may restore it. Its keys stay reserved, so a restore never clashes; the purge frees them.
  A track purge runs in batches and marks the track first (`purge_started_at`), so a track half
  emptied can never be restored and the next purge run finishes it.

**Measured** (2026-10-28, cloud container, 4 vCPU, PostgreSQL 16.15, other sessions busy on the
same machine; `bash tools/backup/bench-restore.sh 1000000`): 1,000,000 tickets in ten tracks
with 5,000,000 history rows, 1,000,000 followers and 200,000 links (1.5 GB database, 8.2 million
rows in all). Backup 22 s (107 MB dump: the synthetic text compresses far better than real
text). Restore drill 36 s (restore into a scratch database 35 s with four pg_restore jobs, row
counts of 69 tables checked in 0.6 s); `node cli.mjs restore --yes` in place 39 s. The done-when
budget is 30 minutes. Purging: a 20,000-ticket track in 4 s, 20,000 single tickets past the
retention (one audited event each) in 10 s.

Not done here: encryption and remote targets (S3, SFTP), point-in-time recovery, and restoring a
single track or deleted tickets from a backup into the live site (OPS-009 (2)).
