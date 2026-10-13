import { type Kysely, sql } from 'kysely';

/**
 * The audit log (M1-003; ADR-034, IAM-013): an append-only, hash-chained record of security,
 * permission, configuration and sign-in events.
 *
 * - `audit_event` is partitioned by month on `recorded_at`, the time a record joined the log.
 *   The application creates each month's partition when it is first needed and the retention
 *   job creates the next one ahead; retention drops whole partitions. No partition exists
 *   right after this migration.
 * - Each workspace has its own chain: `seq` counts from 1, `prev_hash` is the previous record's
 *   `hash` (64 zeros before the first), and `hash` is SHA-256 over `prev_hash` and a canonical
 *   serialisation of the record (apps/server/src/audit/chain.ts). `audit_chain` holds each
 *   chain's head, which appends lock to stay in order, and the checkpoint retention leaves
 *   behind: the last hash of the dropped range, where verification starts.
 * - Rows can be neither updated nor deleted, also not through a partition; only dropping a
 *   whole partition removes them.
 * - `domain_event.ip` keeps the client address of the request that caused an event, so the
 *   audit record of a sign-in or an admin change says where it came from.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE domain_event ADD COLUMN ip text`.execute(db);

  await sql`
    CREATE TABLE audit_event (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      seq bigint NOT NULL,
      recorded_at timestamptz NOT NULL,
      occurred_at timestamptz NOT NULL,
      actor_id integer,
      action text NOT NULL,
      subject_type text,
      subject_id text,
      details jsonb NOT NULL DEFAULT '{}',
      ip text,
      source_event_id bigint,
      prev_hash text NOT NULL,
      hash text NOT NULL,
      PRIMARY KEY (workspace_id, seq, recorded_at)
    ) PARTITION BY RANGE (recorded_at)`.execute(db);
  // Filters of the audit search (newest first by seq within each).
  await sql`CREATE INDEX audit_event_actor_idx ON audit_event (workspace_id, actor_id, seq)`.execute(
    db,
  );
  await sql`CREATE INDEX audit_event_action_idx ON audit_event (workspace_id, action text_pattern_ops, seq)`.execute(
    db,
  );
  await sql`CREATE INDEX audit_event_subject_idx ON audit_event (workspace_id, subject_type, subject_id, seq)`.execute(
    db,
  );
  // At-least-once delivery: an event already in the log is not appended again.
  await sql`
    CREATE INDEX audit_event_source_idx ON audit_event (workspace_id, source_event_id)
     WHERE source_event_id IS NOT NULL`.execute(db);

  await sql`
    CREATE FUNCTION audit_event_refuse_change() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'audit_event is append-only: % is not allowed', TG_OP
        USING ERRCODE = 'restrict_violation';
    END
    $$`.execute(db);
  // Row triggers on a partitioned table are cloned to every partition, present and future.
  await sql`
    CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON audit_event
      FOR EACH ROW EXECUTE FUNCTION audit_event_refuse_change()`.execute(db);
  await sql`
    CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON audit_event
      FOR EACH STATEMENT EXECUTE FUNCTION audit_event_refuse_change()`.execute(db);

  await sql`
    CREATE TABLE audit_chain (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      head_seq bigint NOT NULL DEFAULT 0,
      head_hash text NOT NULL DEFAULT repeat('0', 64),
      head_recorded_at timestamptz,
      checkpoint_seq bigint NOT NULL DEFAULT 0,
      checkpoint_hash text NOT NULL DEFAULT repeat('0', 64),
      checkpoint_at timestamptz
    )`.execute(db);
}
