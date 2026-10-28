import { type Kysely, sql } from 'kysely';

/**
 * Bulk operations (M1-021; CORE-024): a change asked for many tickets at once, run as a
 * background job that acts for the person who asked, through the same checks a request makes.
 *
 * - `bulk_operation`: what was asked (action and its parameters), by whom, how far it got
 *   (counts kept as items finish) and whether a cancel was asked for.
 * - `bulk_item`: one row per ticket in the order given, with its outcome once run: done,
 *   failed with the answer the ticket's own route gave (status and body), or skipped after a
 *   cancel. `ref` keeps what was asked (an id or a key); `ticket_id` is the ticket it named,
 *   null when it named none. No foreign key on the ticket: a purged ticket keeps its result.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE bulk_operation (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      action text NOT NULL CHECK (action IN ('edit', 'move', 'transition', 'delete')),
      params jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'done', 'cancelled')),
      cancel_requested boolean NOT NULL DEFAULT false,
      total integer NOT NULL CHECK (total > 0),
      succeeded integer NOT NULL DEFAULT 0,
      failed integer NOT NULL DEFAULT 0,
      skipped integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX bulk_operation_user_idx
    ON bulk_operation (workspace_id, user_id, created_at DESC)`.execute(db);
  await sql`
    CREATE TABLE bulk_item (
      operation_id bigint NOT NULL REFERENCES bulk_operation (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      position integer NOT NULL,
      ref text NOT NULL,
      ticket_id integer,
      outcome text CHECK (outcome IN ('done', 'failed', 'skipped')),
      status_code smallint,
      error jsonb,
      finished_at timestamptz,
      PRIMARY KEY (operation_id, position)
    )`.execute(db);
  await sql`CREATE INDEX bulk_item_pending_idx
    ON bulk_item (operation_id, position) WHERE outcome IS NULL`.execute(db);
  await sql`CREATE INDEX bulk_item_failed_idx
    ON bulk_item (operation_id, position) WHERE outcome = 'failed'`.execute(db);
}
