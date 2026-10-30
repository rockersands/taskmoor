import { type Kysely, sql } from 'kysely';

/**
 * Teams (M1-123; CORE-027; ADR-076).
 *
 * - `team`: a site-wide team with a name (unique in the workspace, any case), a description
 *   and an optional lead. Unlike a group it grants nothing: it says who works together, and
 *   other records point at it by id, so renaming a team renames it everywhere at once.
 * - `team_member`: the people in a team; a person may be in several. Members leave with the
 *   team or their account; the lead does not have to be a member.
 * - `board.team_id`: the team a board belongs to; `area.owner_team_id`: the team that owns an
 *   area. Both are cleared when the team is deleted.
 * - `field.type` takes `team`: a single-value Team field whose values are team ids, indexed in
 *   `v_option` like groups (ADR-008).
 *
 * The type constraint is extended from what the database holds, not rewritten from a list, so
 * migrations made in parallel that add types of their own keep them whichever runs first.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE team (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
      lead_id integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX team_name_idx ON team (workspace_id, lower(name))`.execute(db);
  await sql`CREATE INDEX team_lead_idx ON team (lead_id) WHERE lead_id IS NOT NULL`.execute(db);
  await sql`
    CREATE TABLE team_member (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      team_id integer NOT NULL REFERENCES team (id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      added_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, user_id)
    )`.execute(db);
  await sql`CREATE INDEX team_member_user_idx ON team_member (user_id)`.execute(db);

  await sql`ALTER TABLE board ADD COLUMN team_id integer REFERENCES team (id) ON DELETE SET NULL`.execute(
    db,
  );
  await sql`CREATE INDEX board_team_idx ON board (team_id) WHERE team_id IS NOT NULL`.execute(db);
  await sql`ALTER TABLE area ADD COLUMN owner_team_id integer REFERENCES team (id) ON DELETE SET NULL`.execute(
    db,
  );
  await sql`CREATE INDEX area_owner_team_idx ON area (owner_team_id) WHERE owner_team_id IS NOT NULL`.execute(
    db,
  );

  const { rows } = await sql<{ def: string }>`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'field'::regclass AND conname = 'field_type_check'`.execute(db);
  const types = [...(rows[0]?.def ?? '').matchAll(/'([a-z-]+)'::text/g)].map((m) => m[1] as string);
  if (types.length === 0) throw new Error('0060: field_type_check not found');
  const list = sql.join([...new Set([...types, 'team'])].map((v) => sql.lit(v)));
  await sql`ALTER TABLE field DROP CONSTRAINT field_type_check`.execute(db);
  await sql`ALTER TABLE field ADD CONSTRAINT field_type_check CHECK (type IN (${list}))`.execute(
    db,
  );
}
