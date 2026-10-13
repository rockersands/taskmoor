import { type Kysely, sql } from 'kysely';

/**
 * The domain event bus and job queue (M1-005; ADR-015). Every mutation writes one row in
 * domain_event in the same transaction as the change, so an event exists exactly when the
 * change does. A relay hands unpublished events to subscribers as jobs; workers claim jobs with
 * FOR UPDATE SKIP LOCKED, retry with backoff, and keep the error. A job's key stays unique after
 * it completes, so a relay that crashes after enqueueing cannot deliver an event twice.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE domain_event (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      type text NOT NULL,
      version smallint NOT NULL DEFAULT 1,
      actor_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      subject_type text NOT NULL,
      subject_id text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      published_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX domain_event_unpublished_idx ON domain_event (id) WHERE published_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX domain_event_subject_idx ON domain_event (workspace_id, subject_type, subject_id, id)`.execute(
    db,
  );

  await sql`
    CREATE TABLE job (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      task text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}',
      key text UNIQUE,
      run_at timestamptz NOT NULL DEFAULT now(),
      attempts integer NOT NULL DEFAULT 0,
      max_attempts integer NOT NULL DEFAULT 25,
      locked_at timestamptz,
      locked_by text,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      started_at timestamptz,
      done_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX job_ready_idx ON job (run_at, id) WHERE done_at IS NULL AND locked_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX job_locked_idx ON job (locked_at) WHERE locked_at IS NOT NULL AND done_at IS NULL`.execute(
    db,
  );
}
