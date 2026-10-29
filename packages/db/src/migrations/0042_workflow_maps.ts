import { type Kysely, sql } from 'kysely';

/**
 * Workflow maps, track-local workflows and background status migrations (M1-028; WF-001 (3);
 * ADR-045).
 *
 * - `workflow_map`: which workflow each ticket type uses (`workflow_map_entry`), and the
 *   workflow every other type uses (`default_workflow_id`). Shared maps serve any number of
 *   shared-mode tracks; one map per workspace is the default (`is_default`), the one a track
 *   without a map of its own uses. A local-mode track owns exactly one map
 *   (`owner_track_id`), which only its administrators change.
 * - `workflow.owner_track_id`: a workflow a local-mode track owns, which only that track's map
 *   may name. Names are unique among the shared workflows and within each track.
 * - `track.workflow_map_id` names a track's map; null means the workspace's default map.
 *   `track.workflow_id` goes: every track keeps behaving as before, as its workflow becomes
 *   the default workflow of its map (a shared map per workflow for shared-mode tracks, the
 *   track's own map for local-mode ones).
 * - `ticket_workflow_id(workspace, track, ticket type)` resolves a ticket's workflow; the
 *   trigger that gives a ticket inserted without a status its initial status uses it.
 * - `workflow_migration` and `workflow_migration_step`: a change of map that leaves tickets in
 *   statuses their new workflow lacks moves them in the background, step by step (track,
 *   ticket type, status from and to), with progress, history rows in one change set and the
 *   person who asked as their actor.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE workflow
      ADD COLUMN owner_track_id integer REFERENCES track (id) ON DELETE CASCADE`.execute(db);
  await sql`DROP INDEX workflow_name_idx`.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_name_idx
    ON workflow (workspace_id, coalesce(owner_track_id, 0), lower(name))`.execute(db);
  await sql`CREATE INDEX workflow_owner_track_idx ON workflow (owner_track_id)
    WHERE owner_track_id IS NOT NULL`.execute(db);

  await sql`
    CREATE TABLE workflow_map (
      id serial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      name text NOT NULL,
      description text NOT NULL DEFAULT '',
      default_workflow_id integer NOT NULL REFERENCES workflow (id),
      owner_track_id integer REFERENCES track (id) ON DELETE CASCADE,
      is_default boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CHECK (NOT (is_default AND owner_track_id IS NOT NULL))
    )`.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_map_name_idx
    ON workflow_map (workspace_id, coalesce(owner_track_id, 0), lower(name))`.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_map_default_idx ON workflow_map (workspace_id)
    WHERE is_default`.execute(db);
  await sql`CREATE UNIQUE INDEX workflow_map_owner_track_idx ON workflow_map (owner_track_id)
    WHERE owner_track_id IS NOT NULL`.execute(db);
  await sql`CREATE INDEX workflow_map_workflow_idx ON workflow_map (default_workflow_id)`.execute(
    db,
  );
  await sql`
    CREATE TABLE workflow_map_entry (
      workspace_id integer NOT NULL REFERENCES workspace (id),
      map_id integer NOT NULL REFERENCES workflow_map (id) ON DELETE CASCADE,
      ticket_type_id integer NOT NULL REFERENCES ticket_type (id) ON DELETE CASCADE,
      workflow_id integer NOT NULL REFERENCES workflow (id),
      PRIMARY KEY (map_id, ticket_type_id)
    )`.execute(db);
  await sql`CREATE INDEX workflow_map_entry_workflow_idx ON workflow_map_entry (workflow_id)`.execute(
    db,
  );
  await sql`CREATE INDEX workflow_map_entry_type_idx ON workflow_map_entry (ticket_type_id)`.execute(
    db,
  );
  await sql`ALTER TABLE track ADD COLUMN workflow_map_id integer REFERENCES workflow_map (id)`.execute(
    db,
  );
  await sql`CREATE INDEX track_workflow_map_idx ON track (workflow_map_id)
    WHERE workflow_map_id IS NOT NULL`.execute(db);

  // Every workspace with a default workflow gets the default map.
  await sql`
    INSERT INTO workflow_map (workspace_id, name, description, default_workflow_id, is_default)
    SELECT w.workspace_id, 'Default workflow map', 'Every ticket type uses the default workflow',
           w.id, true
      FROM workflow w
     WHERE w.is_default`.execute(db);
  // Shared-mode tracks on another workflow: one shared map per workflow, named after it.
  await sql`
    INSERT INTO workflow_map (workspace_id, name, description, default_workflow_id)
    SELECT DISTINCT w.workspace_id, w.name || ' map',
           'Every ticket type uses ' || w.name, w.id
      FROM track t
      JOIN workflow w ON w.id = t.workflow_id
     WHERE t.mode = 'shared' AND NOT w.is_default`.execute(db);
  await sql`
    UPDATE track t SET workflow_map_id = m.id
      FROM workflow_map m
     WHERE t.mode = 'shared' AND m.owner_track_id IS NULL AND NOT m.is_default
       AND m.default_workflow_id = t.workflow_id`.execute(db);
  // Local-mode tracks own their map, whose default is the workflow they had.
  await sql`
    INSERT INTO workflow_map (workspace_id, name, description, default_workflow_id,
                              owner_track_id)
    SELECT t.workspace_id, t.key || ' workflows', '',
           coalesce(t.workflow_id, d.id), t.id
      FROM track t
      JOIN workflow d ON d.workspace_id = t.workspace_id AND d.is_default
     WHERE t.mode = 'local'`.execute(db);
  await sql`
    UPDATE track t SET workflow_map_id = m.id
      FROM workflow_map m
     WHERE t.mode = 'local' AND m.owner_track_id = t.id`.execute(db);
  await sql`DROP INDEX track_workflow_idx`.execute(db);
  await sql`ALTER TABLE track DROP COLUMN workflow_id`.execute(db);

  // A ticket's workflow: its track's map (the default map without one), for its type.
  await sql`
    CREATE FUNCTION ticket_workflow_id(p_workspace integer, p_track integer, p_type integer)
      RETURNS integer LANGUAGE sql STABLE AS $$
      SELECT coalesce(e.workflow_id, m.default_workflow_id)
        FROM workflow_map m
        LEFT JOIN workflow_map_entry e ON e.map_id = m.id AND e.ticket_type_id = p_type
       WHERE m.id = coalesce(
               (SELECT workflow_map_id FROM track WHERE id = p_track),
               (SELECT id FROM workflow_map WHERE workspace_id = p_workspace AND is_default))
    $$`.execute(db);
  await sql`
    CREATE OR REPLACE FUNCTION ticket_initial_status() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status_id IS NULL THEN
        SELECT (v.definition ->> 'initialStatusId')::int INTO NEW.status_id
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.id = ticket_workflow_id(NEW.workspace_id, NEW.track_id, NEW.ticket_type_id);
      END IF;
      RETURN NEW;
    END $$`.execute(db);

  await sql`
    CREATE TABLE workflow_migration (
      id bigserial PRIMARY KEY,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      user_id integer REFERENCES app_user (id),
      reason text NOT NULL CHECK (reason IN ('track_map', 'map_change')),
      map_id integer REFERENCES workflow_map (id) ON DELETE SET NULL,
      track_id integer REFERENCES track (id) ON DELETE SET NULL,
      status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done')),
      total integer NOT NULL CHECK (total > 0),
      migrated integer NOT NULL DEFAULT 0,
      change_set bigint NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      started_at timestamptz,
      finished_at timestamptz
    )`.execute(db);
  await sql`CREATE INDEX workflow_migration_pending_idx ON workflow_migration (workspace_id)
    WHERE status <> 'done'`.execute(db);
  // Status ids without a foreign key: a finished migration keeps its record after a status it
  // named is deleted, as history keeps ids.
  await sql`
    CREATE TABLE workflow_migration_step (
      migration_id bigint NOT NULL REFERENCES workflow_migration (id) ON DELETE CASCADE,
      workspace_id integer NOT NULL REFERENCES workspace (id),
      track_id integer NOT NULL REFERENCES track (id) ON DELETE CASCADE,
      ticket_type_id integer NOT NULL REFERENCES ticket_type (id) ON DELETE CASCADE,
      from_status_id integer NOT NULL,
      to_status_id integer NOT NULL,
      ticket_count integer NOT NULL CHECK (ticket_count > 0),
      PRIMARY KEY (migration_id, track_id, ticket_type_id, from_status_id)
    )`.execute(db);
  await sql`CREATE INDEX workflow_migration_step_ticket_idx
    ON workflow_migration_step (track_id, ticket_type_id, from_status_id)`.execute(db);
}
