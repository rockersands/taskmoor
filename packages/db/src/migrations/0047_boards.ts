import { type Kysely, sql } from 'kysely';

/**
 * Boards (M1-043; AGL-001 to AGL-006, AGL-014; ADR-049).
 *
 * - `board`: a Scrum or Kanban board in a location (a track, or the person who owns it). Its
 *   tickets are those its filter query matches (`filter_query`), less those its optional
 *   sub-filter hides (`sub_filter_query`). Saved searches (M1-063) are not built yet: they will
 *   add `saved_search_id` beside `filter_query`, with exactly one of the two set (ADR-049).
 * - The configuration is JSON the routes validate (`apps/server/src/boards/model.ts`):
 *   `columns` (name, statuses, min and max WIP), `swimlanes` (mode and query lanes),
 *   `board_filters` (named query fragments) and `card_rules` (colours and fields). Status ids in
 *   `columns` are not foreign keys: a status deleted later simply maps nowhere.
 * - `board_admin`: the people who may change a board besides the administrators of its track.
 *   Rows leave with their board or person; a board leaves with its track or owner.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE board (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      description text NOT NULL DEFAULT '',
      kind text NOT NULL CHECK (kind IN ('scrum', 'kanban')),
      location_track_id integer REFERENCES track (id) ON DELETE CASCADE,
      location_user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      filter_query text NOT NULL,
      sub_filter_query text,
      columns jsonb NOT NULL,
      swimlanes jsonb NOT NULL,
      board_filters jsonb NOT NULL DEFAULT '[]',
      board_filter_display text NOT NULL DEFAULT 'buttons'
        CHECK (board_filter_display IN ('buttons', 'dropdown')),
      card_rules jsonb NOT NULL,
      version integer NOT NULL DEFAULT 1,
      created_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((location_track_id IS NULL) <> (location_user_id IS NULL))
    )`.execute(db);
  await sql`CREATE INDEX board_workspace_name_idx ON board (workspace_id, lower(name), id)`.execute(
    db,
  );
  await sql`CREATE INDEX board_track_idx ON board (location_track_id) WHERE location_track_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX board_user_idx ON board (location_user_id) WHERE location_user_id IS NOT NULL`.execute(
    db,
  );
  await sql`
    CREATE TABLE board_admin (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      board_id integer NOT NULL REFERENCES board (id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      PRIMARY KEY (board_id, user_id)
    )`.execute(db);
  await sql`CREATE INDEX board_admin_user_idx ON board_admin (user_id)`.execute(db);
}
