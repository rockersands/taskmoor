import { type Kysely, sql } from 'kysely';

/**
 * Releases across tracks (T-089c; PLN-007; ADR-122 stage 4).
 *
 * - `cross_track_release`: lines up several tracks' own releases on one end. It belongs to the
 *   workspace, not to a plan, and holds no tickets: its work is the target tickets of its linked
 *   releases. Its end is a fixed day, or when its work completes (no day). Names are not unique:
 *   a unique name would answer "taken" for one the person may not see, and so tell them it exists.
 * - `cross_track_release_member`: a linked release. `release_id` is the key, so a release is in at
 *   most one (two would pull it towards two dates); `(cross_track_release_id, track_id)` is unique,
 *   so at most one release per track. Both limits can be dropped later without moving data. The
 *   foreign key on `(release_id, track_id)` keeps the track right; deleting a release or purging a
 *   track removes its row.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE cross_track_release (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      owner_id integer NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
      name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 255),
      description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
      end_rule text NOT NULL CHECK (end_rule IN ('fixed_date', 'work_complete')),
      release_date date,
      version integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK ((end_rule = 'fixed_date') = (release_date IS NOT NULL))
    )`.execute(db);
  await sql`CREATE INDEX cross_track_release_owner_idx
    ON cross_track_release (workspace_id, owner_id)`.execute(db);
  await sql`CREATE INDEX cross_track_release_list_idx
    ON cross_track_release (workspace_id, release_date, id)`.execute(db);
  await sql`CREATE UNIQUE INDEX release_id_track_key ON release (id, track_id)`.execute(db);
  await sql`
    CREATE TABLE cross_track_release_member (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      cross_track_release_id integer NOT NULL
        REFERENCES cross_track_release (id) ON DELETE CASCADE,
      release_id integer PRIMARY KEY,
      track_id integer NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT cross_track_release_member_track_key UNIQUE (cross_track_release_id, track_id),
      FOREIGN KEY (release_id, track_id) REFERENCES release (id, track_id) ON DELETE CASCADE
    )`.execute(db);
  await sql`CREATE INDEX cross_track_release_member_track_idx
    ON cross_track_release_member (track_id)`.execute(db);
}
