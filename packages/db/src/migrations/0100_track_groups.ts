import { type Kysely, sql } from 'kysely';

/**
 * Personal track groups (CORE-034, IAM-034; ADR-121). A person gathers tracks on the Tracks page
 * into named groups of their own; a track sits in at most one of a person's groups, which the
 * unique key on `(owner_id, track_id)` holds, and the composite key keeps each row's owner the
 * group's. Order and whether a group is minimized are the person's, remembered here.
 *
 * Sharing a group shows it to another person and may give them a role on its tracks. The role
 * is an ordinary `track_role_actor` row; `track_group_access` records which shares hold it, so
 * taking a share back removes only what shares gave and never a role the person had otherwise.
 * A recipient orders and minimizes a shared group for themselves, on the share's row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE TABLE track_group (
    id serial PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id),
    owner_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
    position integer NOT NULL,
    minimized boolean NOT NULL DEFAULT false,
    copied_from integer REFERENCES track_group (id) ON DELETE SET NULL,
    given_by integer REFERENCES app_user (id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, owner_id)
  )`.execute(db);
  await sql`CREATE INDEX track_group_owner_idx ON track_group (owner_id, position)`.execute(db);

  await sql`CREATE TABLE track_group_track (
    workspace_id integer NOT NULL REFERENCES workspace (id),
    group_id integer NOT NULL,
    owner_id integer NOT NULL,
    track_id integer NOT NULL REFERENCES track (id) ON DELETE CASCADE,
    position integer NOT NULL,
    PRIMARY KEY (group_id, track_id),
    UNIQUE (owner_id, track_id),
    FOREIGN KEY (group_id, owner_id) REFERENCES track_group (id, owner_id) ON DELETE CASCADE
  )`.execute(db);
  await sql`CREATE INDEX track_group_track_track_idx ON track_group_track (track_id)`.execute(db);

  await sql`CREATE TABLE track_group_share (
    id serial PRIMARY KEY,
    workspace_id integer NOT NULL REFERENCES workspace (id),
    group_id integer NOT NULL REFERENCES track_group (id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    role_id integer REFERENCES role (id) ON DELETE SET NULL,
    shared_by integer REFERENCES app_user (id) ON DELETE SET NULL,
    position integer NOT NULL,
    minimized boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (group_id, user_id)
  )`.execute(db);
  await sql`CREATE INDEX track_group_share_user_idx ON track_group_share (user_id)`.execute(db);

  await sql`CREATE TABLE track_group_access (
    workspace_id integer NOT NULL REFERENCES workspace (id),
    share_id integer NOT NULL REFERENCES track_group_share (id) ON DELETE CASCADE,
    track_id integer NOT NULL REFERENCES track (id) ON DELETE CASCADE,
    role_id integer NOT NULL REFERENCES role (id) ON DELETE CASCADE,
    user_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
    PRIMARY KEY (share_id, track_id)
  )`.execute(db);
  // Whether a role a person holds in a track came from shares: looked up on every change.
  await sql`CREATE INDEX track_group_access_role_idx
    ON track_group_access (track_id, role_id, user_id)`.execute(db);
}
