import { type Kysely, sql } from 'kysely';

/**
 * The guided tutorial (ADR-115): where each person is in each section, kept on the server so it
 * follows them to another device. A section with no row has not been started. One more row, with
 * the section `offer`, says whether the first-run offer has been shown or dismissed.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE tutorial_progress (
    workspace_id integer NOT NULL REFERENCES workspace (id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    section text NOT NULL,
    state text NOT NULL CHECK (state IN ('active', 'done', 'skipped', 'shown', 'dismissed')),
    step integer NOT NULL DEFAULT 0 CHECK (step >= 0),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (workspace_id, user_id, section)
  )`.execute(db);
}
