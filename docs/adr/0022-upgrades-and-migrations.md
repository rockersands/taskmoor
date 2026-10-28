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
  automatic pre-upgrade backup, which the upgrade command takes and verifies first. (M1-102:
  while nothing has committed, the rollback of the one migration transaction is enough; the
  restore is for upgrades with online migrations. See "Implementation (M1-102)".)
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

## Implementation (M1-102: the upgrade command)

`node cli.mjs upgrade [--dry-run] [--no-backup] [--unattended]` (`apps/server/src/upgrade.ts`)
is the one command of OPS-006. The Compose kit wraps it in `deploy/compose/upgrade.sh <image>`
(stop the backend, run the new image's command, record the image and start it, or start the
previous image again when it fails); the all-in-one image runs it before every start. The Helm
chart keeps its `check-upgrade` hook and the migration at the first new pod's start. No new
table: the backup log of M1-101 records the pre-upgrade backup and the outcome.

- **How migrations run.** All pending ordinary migrations, across every release the upgrade
  crosses, run in **one transaction** together with the bookkeeping rows and the verification,
  on one connection holding a session-level advisory lock for the whole run
  (`packages/db/src/migrate.ts`; the server's start and `migrate` use the same runner). A
  database therefore lands on the new release or stays exactly where it was, never on a schema
  no release has. One transaction per migration was rejected: a failure in the third release
  would leave the database between releases, which only a restore could undo. The price is
  that locks taken early are held until the commit; that is why large-table changes are online
  migrations, which this runner now supports: a migration module that exports
  `online = true` runs alone outside any transaction (each statement commits), and splits the
  plan into segments, each run of ordinary migrations being one transaction.
- **What rollback means.** While nothing has committed (no online migration in the plan, or the
  failure came before the first), the transaction's rollback is the rollback: Postgres DDL is
  transactional. The command does not take that on trust; it compares the migration list and
  the schema snapshot with the ones taken before. Only sequence values taken by rolled-back
  inserts stay taken (gaps in ids). Once something has committed, or an online migration failed
  part way, the rollback is a **restore of the pre-upgrade backup in place**: first every
  relation, routine, type, extension and schema that did not exist before the upgrade is
  dropped (`pg_restore --clean` drops and recreates only what the dump holds, and a new table
  referencing an old one would block the old one's drop), then `restore` puts the database back
  (not the files or the keyring, which migrations do not touch), keeping the live backup log,
  and the result is checked like the restore drill: migrations as in the manifest, schema as
  before, every table's row count as the backup's snapshot. Writes made between the backup and
  the restore would be lost, so a plan with online migrations is refused while other Taskmoor
  processes are connected, and without a backup (`--no-backup`).
- **Verification** runs inside the last transaction before the commit: nothing pending and
  every table, column and index of the reviewed golden schema present as reviewed
  (`EXPECTED_SCHEMA`, the schema golden now shipped in the build). Objects of the operator's
  own (an extra index) are reported, never a failure. A failed verification rolls back.
- **Pre-flight**, read-only, every finding a line with ok, warn or block: database reachable,
  PostgreSQL 16+, the upgrade lock free (another upgrade blocks), no unknown migration (a
  downgrade), none pending out of order, the **upgrade path rule** (`packages/db/src/releases.ts`:
  a release is the last migration it ships; supported starts are the last three earlier
  releases counted by distinct schema, plus the latest LTS release (OPS-007); fewer than three
  releases means every start; an empty database is an install), a backup directory with room
  (the last backup's size and a fifth more, else the database and files as they are), a running
  backup (the upgrade waits for it, an hour at most), other Taskmoor processes (warn; block for
  online plans), and for `--unattended` a failed earlier attempt at the same target. The dry
  run adds the plan: every migration with the existing tables its code changes and a rough
  estimate at 50 MB/s of their size (OPS-006 (3)); a rehearsal on a restored copy would measure
  instead and is left for later. Extension compatibility (OPS-006) waits for extensions (ADR-026).
- **The pre-upgrade backup** goes through the backup path of M1-101 into
  `<backup dir>/pre-upgrade-<time>` and is logged as a `manual` backup with
  `purpose: 'pre-upgrade'`, so scheduled retention, which counts only scheduled backups, never
  removes it. The log's kinds were not extended: the row must be writable by the schema the
  database has before the upgrade. A database from before the log (migration 0022) is backed up
  all the same and the entry is written once the upgrade created the table. The outcome
  (`upgrade: {outcome, from, to, failedMigration, rollback, error, seconds}`) is added to that
  entry, after a restore too. An empty database takes no backup.
- **Unattended runs** (the all-in-one start) leave `upgrade-failed.json` in the backup directory
  after a failure and refuse the same target at the next start, so a restarting container never
  takes backup after backup; a run by hand always tries and a success removes the marker.
- **Exit codes**: 0 upgraded or nothing to do, 1 not upgraded with the database as before, 3 the
  rollback failed too (the report names the backup to restore by hand). The last output line is
  the report as JSON.

Tested (`apps/server/src/upgrade.test.ts`, `packages/db/src/migrate.test.ts`,
`releases.test.ts`): releases modelled as points in today's migration list (1.0 to 1.3, this
build 1.4, as the M0-029 harness does) upgrade from each of the last three in one call, with
the reviewed schema, every seeded row and the logged backup; 1.0 is refused before anything is
written; failures injected by test-only migration sets (nothing ships) roll back by transaction
after two real migrations ran, and by restore after an online index and a segment of new
tables, types, functions and a schema committed; every case compares migrations, schema and
every table's checksum with the state before. Not run here: `upgrade.sh` and the all-in-one
entrypoint against Docker (CI's kit smoke test runs both with the same image).
