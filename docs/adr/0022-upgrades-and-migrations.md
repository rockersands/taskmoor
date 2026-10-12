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
