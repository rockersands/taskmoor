import { type Kysely, sql } from 'kysely';

/**
 * Structures of a plan's Grid (T-089a; PLN-010; ADR-122 stage 10).
 *
 * - `plan_structure`: a saved, named recipe for the plan's tree: its steps and its columns
 *   (`spec`, checked by the server's `structureSpec` on every write). It holds no tickets: the
 *   rows are built for each viewer when read. It goes with its plan. Names are unique per plan
 *   ignoring case.
 *
 * No rows are written: a plan without structures shows the default, unsaved one.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plan_structure (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
      spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
      created_by integer NOT NULL REFERENCES app_user (id),
      updated_by integer NOT NULL REFERENCES app_user (id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      version integer NOT NULL DEFAULT 1
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX plan_structure_name_idx ON plan_structure (plan_id, lower(name))`.execute(
    db,
  );
  await sql`CREATE INDEX plan_structure_creator_idx ON plan_structure (created_by)`.execute(db);
  await sql`CREATE INDEX plan_structure_updater_idx ON plan_structure (updated_by)`.execute(db);
}
