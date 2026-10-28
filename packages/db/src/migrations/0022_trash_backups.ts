import { type Kysely, sql } from 'kysely';

/**
 * The trash for tracks, the trash retention setting and the backup log (M1-101; CORE-025,
 * OPS-008, OPS-009; ADR-022).
 *
 * - `track.deleted_at`, `deleted_by`: a deleted track waits in the trash, with its tickets,
 *   releases and areas untouched, until it is restored or purged. It keeps its keys, so no
 *   other track can take them while it may come back. `purge_started_at` marks a track whose
 *   permanent deletion has begun (it runs in batches); such a track can no longer be restored.
 *   Moving a track in or out of the trash changes what everyone may do there, so it moves the
 *   authorization epoch, as archiving does.
 * - `trash_policy`: how many days the workspace's trash keeps tickets and tracks before the
 *   purge job deletes them for good (default 30, at least 1, at most 365).
 * - `backup_run`: every backup the scheduler or the operator CLI takes and every restore drill,
 *   with its state, where it went, its size and what the drill measured. Backups are of the
 *   whole instance, so the table is instance-wide. At most one backup and one drill run at a
 *   time; `heartbeat_at` tells a live run from one whose process died.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE track
      ADD COLUMN deleted_at timestamptz,
      ADD COLUMN deleted_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      ADD COLUMN purge_started_at timestamptz,
      ADD CONSTRAINT track_deleted_by_check CHECK (deleted_by IS NULL OR deleted_at IS NOT NULL),
      ADD CONSTRAINT track_purge_started_check
        CHECK (purge_started_at IS NULL OR deleted_at IS NOT NULL)`.execute(db);
  await sql`CREATE INDEX track_trash_idx ON track (workspace_id, deleted_at) WHERE deleted_at IS NOT NULL`.execute(
    db,
  );
  await sql`
    CREATE TRIGGER track_trash_authz_epoch
    AFTER UPDATE OF deleted_at ON track
    FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);

  await sql`
    CREATE TABLE trash_policy (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`INSERT INTO trash_policy (workspace_id) SELECT id FROM workspace`.execute(db);

  await sql`
    CREATE TABLE backup_run (
      id bigserial PRIMARY KEY,
      kind text NOT NULL CHECK (kind IN ('scheduled', 'manual', 'drill')),
      state text NOT NULL DEFAULT 'running' CHECK (state IN ('running', 'succeeded', 'failed')),
      started_at timestamptz NOT NULL DEFAULT now(),
      heartbeat_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      path text,
      size_bytes bigint CHECK (size_bytes >= 0),
      details jsonb NOT NULL DEFAULT '{}',
      error text,
      pruned_at timestamptz,
      CONSTRAINT backup_run_finished_check CHECK ((state = 'running') = (finished_at IS NULL))
    )`.execute(db);
  // One backup and one drill at a time, whoever starts them.
  await sql`CREATE UNIQUE INDEX backup_run_running_idx ON backup_run ((kind = 'drill')) WHERE state = 'running'`.execute(
    db,
  );
  await sql`CREATE INDEX backup_run_kind_idx ON backup_run (kind, started_at DESC)`.execute(db);
}
