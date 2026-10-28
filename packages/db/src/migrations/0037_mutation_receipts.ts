import { type Kysely, sql } from 'kysely';

/**
 * Mutations applied at most once (M1-032; ADR-013 "optimistic mutations with an outbox").
 *
 * - `mutation_receipt`: one row per (person, client, mutation) pair a client sent. It is
 *   written before the mutation runs, so a second copy of the pair finds it: a finished one
 *   answers with the stored response, an unfinished one is refused as in progress. Receipts are
 *   kept for a week, longer than any outbox waits.
 * - An index on the log's sequence per workspace lets the realtime role read the newest
 *   position cheaply, many times a second.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE mutation_receipt (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      client_id text NOT NULL,
      mutation_id text NOT NULL,
      method text NOT NULL,
      path text NOT NULL,
      status text NOT NULL CHECK (status IN ('pending', 'done')),
      status_code smallint,
      body jsonb,
      position bigint,
      created_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      PRIMARY KEY (user_id, client_id, mutation_id)
    )`.execute(db);
  await sql`CREATE INDEX mutation_receipt_created_idx ON mutation_receipt (created_at)`.execute(db);
  await sql`
    CREATE INDEX change_log_position_idx ON change_log (workspace_id, seq)
      WHERE seq IS NOT NULL`.execute(db);
}
