import { type Kysely, sql } from 'kysely';

/**
 * Configuration guardrails (M1-055; CORE-026; spec 01a section 1.7): a workspace's own limit for
 * a guardrail, where an administrator changed it. A guardrail without a row has its default.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE guardrail_limit (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      value integer NOT NULL CHECK (value >= 1),
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by integer REFERENCES app_user (id),
      PRIMARY KEY (workspace_id, name)
    )`.execute(db);
}
