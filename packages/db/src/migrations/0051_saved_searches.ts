import { type Kysely, sql } from 'kysely';

/**
 * Saved searches (M1-063; QRY-011, QRY-012, AGL-001; ADR-053).
 *
 * - `saved_search`: a named query kept by its owner, with a description and the result columns
 *   chosen for it (`columns`, null for the default set). Names are unique per owner, ignoring
 *   case. A saved search leaves with its owner; administrators give it to someone else first.
 * - `saved_search_share`: who else sees it. One row per scope: a person (`user`), a group, a
 *   track (every member, or the actors of one role when `role_id` is set), every signed-in
 *   person (`any_user`) or anyone, anonymous visitors included (`public`). No row: private.
 * - `saved_search_star`: the saved searches a person starred.
 * - `saved_search_subscription`: the results emailed on a schedule to a person or to each
 *   member of a group, each seeing only the tickets they may see. `next_run_at` is when it is
 *   due; the schedule is read in `time_zone`.
 * - `board.saved_search_id`: a board on a saved search (ADR-049); exactly one of it and
 *   `filter_query` is set. A saved search in use by a board cannot be deleted.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE saved_search (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      owner_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      description text NOT NULL DEFAULT '',
      query text NOT NULL CHECK (char_length(query) <= 100000),
      columns jsonb,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX saved_search_owner_name_idx
    ON saved_search (workspace_id, owner_id, lower(name))`.execute(db);
  await sql`CREATE INDEX saved_search_name_idx ON saved_search (workspace_id, lower(name), id)`.execute(
    db,
  );
  await sql`
    CREATE TABLE saved_search_share (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      saved_search_id integer NOT NULL REFERENCES saved_search (id) ON DELETE CASCADE,
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
  await sql`CREATE INDEX saved_search_share_search_idx ON saved_search_share (saved_search_id)`.execute(
    db,
  );
  await sql`CREATE INDEX saved_search_share_user_idx ON saved_search_share (user_id) WHERE user_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX saved_search_share_group_idx ON saved_search_share (group_id) WHERE group_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX saved_search_share_track_idx ON saved_search_share (track_id) WHERE track_id IS NOT NULL`.execute(
    db,
  );
  await sql`
    CREATE TABLE saved_search_star (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      saved_search_id integer NOT NULL REFERENCES saved_search (id) ON DELETE CASCADE,
      user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      starred_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, saved_search_id)
    )`.execute(db);
  await sql`CREATE INDEX saved_search_star_search_idx ON saved_search_star (saved_search_id)`.execute(
    db,
  );
  await sql`
    CREATE TABLE saved_search_subscription (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      saved_search_id integer NOT NULL REFERENCES saved_search (id) ON DELETE CASCADE,
      created_by integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      recipient_user_id integer REFERENCES app_user (id) ON DELETE CASCADE,
      recipient_group_id integer REFERENCES user_group (id) ON DELETE CASCADE,
      schedule text NOT NULL CHECK (schedule IN ('daily', 'weekly', 'monthly', 'cron')),
      hour integer NOT NULL DEFAULT 8 CHECK (hour BETWEEN 0 AND 23),
      minute integer NOT NULL DEFAULT 0 CHECK (minute BETWEEN 0 AND 59),
      weekday integer CHECK (weekday BETWEEN 0 AND 6),
      day_of_month integer CHECK (day_of_month BETWEEN 1 AND 31),
      cron text CHECK (char_length(cron) <= 200),
      time_zone text NOT NULL DEFAULT 'UTC',
      only_if_results boolean NOT NULL DEFAULT false,
      next_run_at timestamptz NOT NULL,
      last_run_at timestamptz,
      last_sent integer,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((recipient_user_id IS NULL) <> (recipient_group_id IS NULL)),
      CHECK ((schedule = 'cron') = (cron IS NOT NULL)),
      CHECK (schedule <> 'weekly' OR weekday IS NOT NULL),
      CHECK (schedule <> 'monthly' OR day_of_month IS NOT NULL)
    )`.execute(db);
  await sql`CREATE INDEX saved_search_subscription_due_idx ON saved_search_subscription (next_run_at)`.execute(
    db,
  );
  await sql`CREATE INDEX saved_search_subscription_search_idx ON saved_search_subscription (saved_search_id)`.execute(
    db,
  );
  await sql`ALTER TABLE board
    ADD COLUMN saved_search_id integer REFERENCES saved_search (id) ON DELETE RESTRICT,
    ALTER COLUMN filter_query DROP NOT NULL,
    ADD CONSTRAINT board_source_check CHECK ((filter_query IS NULL) <> (saved_search_id IS NULL))`.execute(
    db,
  );
  await sql`CREATE INDEX board_saved_search_idx ON board (saved_search_id) WHERE saved_search_id IS NOT NULL`.execute(
    db,
  );
}
