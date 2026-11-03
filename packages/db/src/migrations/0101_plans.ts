import { type Kysely, sql } from 'kysely';

/**
 * Multi-track plans (T-088; PLN-001, PLN-012; ADR-122).
 *
 * - `plan`: a view over several tracks and saved searches kept by its owner: a name, a
 *   description and `version`, which guards concurrent edits. It holds no tickets: each viewer's
 *   tickets are composed from the sources they may see, every time.
 * - `plan_source`: a track or a saved search, in the order chosen; one row per track or saved
 *   search in a plan. Boards are not sources (each belongs to one track). A source whose track
 *   or saved search is removed goes with it.
 * - `plan_share`: who else sees it, by the scopes of dashboards (ADR-060) except `public`: plans
 *   are for signed-in people only. No row: private.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE plan (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      owner_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX plan_owner_idx ON plan (workspace_id, owner_id)`.execute(db);
  await sql`
    CREATE TABLE plan_source (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      kind text NOT NULL CHECK (kind IN ('track', 'saved_search')),
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      saved_search_id integer REFERENCES saved_search (id) ON DELETE CASCADE,
      position integer NOT NULL CHECK (position >= 0),
      CHECK ((kind = 'track') = (track_id IS NOT NULL)),
      CHECK ((kind = 'saved_search') = (saved_search_id IS NOT NULL)),
      UNIQUE (plan_id, track_id),
      UNIQUE (plan_id, saved_search_id)
    )`.execute(db);
  await sql`CREATE INDEX plan_source_plan_idx ON plan_source (plan_id, position)`.execute(db);
  await sql`CREATE INDEX plan_source_track_idx ON plan_source (track_id) WHERE track_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX plan_source_saved_search_idx ON plan_source (saved_search_id) WHERE saved_search_id IS NOT NULL`.execute(
    db,
  );
  await sql`
    CREATE TABLE plan_share (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      plan_id integer NOT NULL REFERENCES plan (id) ON DELETE CASCADE,
      scope text NOT NULL CHECK (scope IN ('user', 'group', 'track', 'any_user')),
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      role_id integer REFERENCES role (id) ON DELETE CASCADE,
      CHECK ((scope = 'user') = (user_id IS NOT NULL)),
      CHECK ((scope = 'group') = (group_id IS NOT NULL)),
      CHECK ((scope = 'track') = (track_id IS NOT NULL)),
      CHECK (role_id IS NULL OR scope = 'track')
    )`.execute(db);
  await sql`CREATE INDEX plan_share_plan_idx ON plan_share (plan_id)`.execute(db);
  await sql`CREATE INDEX plan_share_user_idx ON plan_share (user_id) WHERE user_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX plan_share_group_idx ON plan_share (group_id) WHERE group_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX plan_share_track_idx ON plan_share (track_id) WHERE track_id IS NOT NULL`.execute(
    db,
  );
}
