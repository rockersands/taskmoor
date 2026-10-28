import { type Kysely, sql } from 'kysely';

/**
 * The change log of ADR-013 (M1-031): every committed change to a ticket, a track or the
 * authorization data, in commit order, for clients that keep a local copy.
 *
 * - Row triggers on `ticket` and `track` write one row per change with a snapshot of the row
 *   (a ticket without its rich text, which clients read when they open it); a ticket that moves
 *   leaves a delete in its old track's group and an upsert in the new one. Writes of every kind,
 *   bulk rewrites included, reach the log without the application's help.
 * - A change to `authz_epoch` (memberships, grants, policies, levels) writes a workspace row
 *   that tells clients their sync groups or visibility may have changed.
 * - The sequence is given at commit: a deferred constraint trigger takes a transaction-scoped
 *   advisory lock and numbers the transaction's rows, so sequence order is commit order and a
 *   reader that has seen `seq` has seen everything below it. The lock is taken only at commit,
 *   after the transaction's own row locks, so it cannot deadlock with them.
 * - Rows are kept for a retention period (30 days unless set); `change_log_floor` records the
 *   highest sequence removed, below which a client must bootstrap again.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SEQUENCE change_seq`.execute(db);
  await sql`
    CREATE TABLE change_log (
      id bigserial PRIMARY KEY,
      seq bigint UNIQUE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer,
      entity text NOT NULL CHECK (entity IN ('ticket', 'track', 'authz')),
      entity_id integer NOT NULL,
      op text NOT NULL CHECK (op IN ('upsert', 'delete')),
      data jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`
    CREATE INDEX change_log_group_idx ON change_log (workspace_id, track_id, seq)
      WHERE seq IS NOT NULL`.execute(db);
  await sql`CREATE INDEX change_log_created_idx ON change_log (created_at)`.execute(db);
  await sql`
    CREATE TABLE change_log_floor (
      workspace_id integer PRIMARY KEY REFERENCES workspace (id),
      floor_seq bigint NOT NULL DEFAULT 0,
      retention_days integer NOT NULL DEFAULT 30 CHECK (retention_days BETWEEN 1 AND 365)
    )`.execute(db);
  await sql`INSERT INTO change_log_floor (workspace_id) SELECT id FROM workspace`.execute(db);

  // Numbering at commit, under one lock for the whole log.
  await sql`
    CREATE FUNCTION change_log_number() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      PERFORM pg_advisory_xact_lock(4172031);
      UPDATE change_log SET seq = nextval('change_seq') WHERE id = NEW.id AND seq IS NULL;
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE CONSTRAINT TRIGGER change_log_number AFTER INSERT ON change_log
      DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION change_log_number()`.execute(db);

  // A ticket as clients keep it: everything but the rich text.
  await sql`
    CREATE FUNCTION change_log_ticket() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE
      snapshot jsonb;
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO change_log (workspace_id, track_id, entity, entity_id, op)
        VALUES (OLD.workspace_id, OLD.track_id, 'ticket', OLD.id, 'delete');
        RETURN NULL;
      END IF;
      IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NULL;
      END IF;
      snapshot := to_jsonb(NEW) - 'description' - 'environment';
      IF TG_OP = 'UPDATE' AND OLD.track_id <> NEW.track_id THEN
        INSERT INTO change_log (workspace_id, track_id, entity, entity_id, op)
        VALUES (OLD.workspace_id, OLD.track_id, 'ticket', OLD.id, 'delete');
      END IF;
      INSERT INTO change_log (workspace_id, track_id, entity, entity_id, op, data)
      VALUES (NEW.workspace_id, NEW.track_id, 'ticket', NEW.id, 'upsert', snapshot);
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER ticket_change_log AFTER INSERT OR UPDATE OR DELETE ON ticket
      FOR EACH ROW EXECUTE FUNCTION change_log_ticket()`.execute(db);

  await sql`
    CREATE FUNCTION change_log_track() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        INSERT INTO change_log (workspace_id, track_id, entity, entity_id, op)
        VALUES (OLD.workspace_id, OLD.id, 'track', OLD.id, 'delete');
        RETURN NULL;
      END IF;
      IF TG_OP = 'UPDATE' AND NEW IS NOT DISTINCT FROM OLD THEN
        RETURN NULL;
      END IF;
      INSERT INTO change_log (workspace_id, track_id, entity, entity_id, op, data)
      VALUES (NEW.workspace_id, NEW.id, 'track', NEW.id, 'upsert',
              jsonb_build_object('id', NEW.id, 'key', NEW.key, 'name', NEW.name,
                'type', NEW.type, 'mode', NEW.mode, 'owner_id', NEW.owner_id,
                'archived_at', NEW.archived_at, 'deleted_at', NEW.deleted_at,
                'updated_at', NEW.updated_at));
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER track_change_log AFTER INSERT OR UPDATE OR DELETE ON track
      FOR EACH ROW EXECUTE FUNCTION change_log_track()`.execute(db);

  await sql`
    CREATE FUNCTION change_log_authz() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      -- One row per transaction and workspace, however many grants it changed.
      IF current_setting('taskmoor.authz_logged_' || NEW.workspace_id, true) = 'yes' THEN
        RETURN NULL;
      END IF;
      PERFORM set_config('taskmoor.authz_logged_' || NEW.workspace_id, 'yes', true);
      INSERT INTO change_log (workspace_id, track_id, entity, entity_id, op, data)
      VALUES (NEW.workspace_id, NULL, 'authz', NEW.workspace_id, 'upsert',
              jsonb_build_object('epoch', NEW.epoch));
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER authz_epoch_change_log AFTER INSERT OR UPDATE ON authz_epoch
      FOR EACH ROW EXECUTE FUNCTION change_log_authz()`.execute(db);
}
