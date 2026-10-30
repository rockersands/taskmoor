import { type Kysely, sql } from 'kysely';

/**
 * Dashboards (M1-064; RPT-004, RPT-005; ADR-060).
 *
 * - `dashboard`: a page of widgets kept by its owner: a name, a description, a layout of one to
 *   three columns and the widgets in order (`widgets`, an array checked by the API: an id, a
 *   kind, a column, a title and the kind's settings). `version` guards concurrent edits.
 *   `is_default`: the dashboard an administrator chose for everyone's home; at most one per
 *   workspace, and every signed-in person sees it.
 * - `dashboard_share`: who else sees it, by the scopes saved searches use (ADR-053): a person, a
 *   group, a track (every member, or the actors of one role), every signed-in person, or anyone.
 *   No row: private.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE dashboard (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      owner_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      description text NOT NULL DEFAULT '',
      layout text NOT NULL DEFAULT 'two'
        CHECK (layout IN ('one', 'two', 'two-wide-left', 'two-wide-right', 'three')),
      widgets jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(widgets) = 'array'),
      is_default boolean NOT NULL DEFAULT false,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE INDEX dashboard_owner_idx ON dashboard (workspace_id, owner_id)`.execute(db);
  await sql`CREATE UNIQUE INDEX dashboard_default_idx ON dashboard (workspace_id) WHERE is_default`.execute(
    db,
  );
  await sql`
    CREATE TABLE dashboard_share (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      dashboard_id integer NOT NULL REFERENCES dashboard (id) ON DELETE CASCADE,
      scope text NOT NULL CHECK (scope IN ('user', 'group', 'track', 'any_user', 'public')),
      user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      track_id integer REFERENCES track (id) ON DELETE CASCADE,
      role_id integer REFERENCES role (id) ON DELETE CASCADE,
      CHECK ((scope = 'user') = (user_id IS NOT NULL)),
      CHECK ((scope = 'group') = (group_id IS NOT NULL)),
      CHECK ((scope = 'track') = (track_id IS NOT NULL)),
      CHECK (role_id IS NULL OR scope = 'track')
    )`.execute(db);
  await sql`CREATE INDEX dashboard_share_dashboard_idx ON dashboard_share (dashboard_id)`.execute(
    db,
  );
  await sql`CREATE INDEX dashboard_share_user_idx ON dashboard_share (user_id) WHERE user_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX dashboard_share_group_idx ON dashboard_share (group_id) WHERE group_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX dashboard_share_track_idx ON dashboard_share (track_id) WHERE track_id IS NOT NULL`.execute(
    db,
  );
}
