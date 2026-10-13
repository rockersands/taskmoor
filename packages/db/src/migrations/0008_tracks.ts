import { type Kysely, sql } from 'kysely';

/**
 * Tracks (M1-006; CORE-001, CORE-002, CORE-003, CORE-025; ADR-009). Expands the track table of
 * migration 0004 (ADR-022: add only) with what a track is beyond a permission scope:
 * description, type, configuration mode, category, avatar icon and colour, the per-track
 * feature toggles of CORE-002, archiving and an update time.
 *
 * - `track_category`: workspace-scoped categories with names unique ignoring case.
 * - `track_key_history`: every key a track has had, its current one included (`replaced_at`
 *   is null for that one). One unique index over all of them means an old key keeps resolving
 *   to its track and can never be taken by another track; a trigger on `track` keeps the table
 *   complete whichever path writes the track (API, importer, direct SQL).
 * - `access_policy.is_default` marks the policy new shared-mode tracks use and local-mode
 *   tracks copy; `access_policy.owner_track_id` marks a policy owned by one local-mode track.
 * - Archiving moves the authorization epoch, because archived tracks keep only read
 *   permissions and leave the search pre-filter.
 *
 * Existing tracks become shared-mode software tracks with every feature on, which is what they
 * behaved as before.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    CREATE TABLE track_category (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX track_category_workspace_name_idx ON track_category (workspace_id, lower(name))`.execute(
    db,
  );

  await sql`
    ALTER TABLE track
      ADD COLUMN description text NOT NULL DEFAULT '',
      ADD COLUMN type text NOT NULL DEFAULT 'software'
        CHECK (type IN ('software', 'business', 'service', 'discovery')),
      ADD COLUMN mode text NOT NULL DEFAULT 'shared' CHECK (mode IN ('shared', 'local')),
      ADD COLUMN category_id integer REFERENCES track_category (id) ON DELETE SET NULL,
      ADD COLUMN icon text,
      ADD COLUMN color text,
      ADD COLUMN feature_board boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_backlog boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_sprints boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_releases boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_development boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_forms boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_approvals boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_calendar boolean NOT NULL DEFAULT true,
      ADD COLUMN feature_timeline boolean NOT NULL DEFAULT true,
      ADD COLUMN archived_at timestamptz,
      ADD COLUMN archived_by integer REFERENCES app_user (id) ON DELETE SET NULL,
      ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now(),
      ADD CONSTRAINT track_archived_by_check CHECK (archived_by IS NULL OR archived_at IS NOT NULL)`.execute(
    db,
  );
  await sql`CREATE INDEX track_category_idx ON track (category_id) WHERE category_id IS NOT NULL`.execute(
    db,
  );
  await sql`CREATE INDEX track_archived_idx ON track (workspace_id) WHERE archived_at IS NOT NULL`.execute(
    db,
  );

  // Every key a track has used. The unique index spans current and old keys of all tracks.
  await sql`
    CREATE TABLE track_key_history (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id) ON DELETE CASCADE,
      key text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      replaced_at timestamptz
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX track_key_history_key_idx ON track_key_history (workspace_id, upper(key))`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX track_key_history_current_idx ON track_key_history (track_id) WHERE replaced_at IS NULL`.execute(
    db,
  );
  await sql`CREATE INDEX track_key_history_track_idx ON track_key_history (track_id)`.execute(db);
  await sql`
    INSERT INTO track_key_history (workspace_id, track_id, key, created_at)
    SELECT workspace_id, id, key, created_at FROM track`.execute(db);

  // A new key retires the current one and is recorded; taking back one of the track's own old
  // keys revives that row. A key another track has had fails the unique index, which aborts the
  // statement that wrote the track.
  await sql`
    CREATE FUNCTION track_key_record() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        IF NEW.key = OLD.key THEN
          RETURN NULL;
        END IF;
        UPDATE track_key_history SET replaced_at = clock_timestamp()
         WHERE track_id = OLD.id AND replaced_at IS NULL AND upper(key) <> upper(NEW.key);
      END IF;
      UPDATE track_key_history SET key = NEW.key, replaced_at = NULL
       WHERE track_id = NEW.id AND upper(key) = upper(NEW.key);
      IF NOT FOUND THEN
        INSERT INTO track_key_history (workspace_id, track_id, key)
        VALUES (NEW.workspace_id, NEW.id, NEW.key);
      END IF;
      RETURN NULL;
    END $$`.execute(db);
  await sql`
    CREATE TRIGGER track_key_history_record
    AFTER INSERT OR UPDATE OF key ON track
    FOR EACH ROW EXECUTE FUNCTION track_key_record()`.execute(db);

  // Archiving changes what everyone may do in the track.
  await sql`
    CREATE TRIGGER track_archive_authz_epoch
    AFTER UPDATE OF archived_at ON track
    FOR EACH ROW EXECUTE FUNCTION authz_epoch_bump()`.execute(db);

  await sql`
    ALTER TABLE access_policy
      ADD COLUMN is_default boolean NOT NULL DEFAULT false,
      ADD COLUMN owner_track_id integer REFERENCES track (id) ON DELETE CASCADE`.execute(db);
  await sql`CREATE UNIQUE INDEX access_policy_default_idx ON access_policy (workspace_id) WHERE is_default`.execute(
    db,
  );
  await sql`CREATE UNIQUE INDEX access_policy_owner_track_idx ON access_policy (owner_track_id) WHERE owner_track_id IS NOT NULL`.execute(
    db,
  );
  // The policy migration 0004 seeded in each workspace becomes its default.
  await sql`
    UPDATE access_policy SET is_default = true
     WHERE id IN (SELECT min(id) FROM access_policy
                   WHERE name = 'Default access policy' GROUP BY workspace_id)`.execute(db);
}
