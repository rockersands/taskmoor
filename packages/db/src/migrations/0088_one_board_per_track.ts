import { type Kysely, sql } from 'kysely';

/**
 * One board per track (ADR-116). The index holds the rule. Boards already there are never
 * removed:
 *
 * - a board kept by a person whose query is exactly one track, `track = KEY`, becomes that track's
 *   board when the track has none;
 * - of several boards on one track, the one managing its workflow, or else the oldest, stays; the
 *   rest go to the person who made them (or the workspace's first person), where they can still
 *   be read but no longer count as the track's.
 *
 * New boards kept by a person are refused by the API, so the location columns stay as they are.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    WITH wanted AS (
      SELECT DISTINCT ON (t.id) b.id AS board_id, t.id AS track_id
        FROM board b
        JOIN track t
          ON t.workspace_id = b.workspace_id
         AND lower(t.key) = lower(
               substring(b.filter_query FROM '^\\s*track\\s*=\\s*"?([A-Za-z0-9_-]+)"?\\s*$'))
       WHERE b.location_track_id IS NULL
         AND t.deleted_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM board o WHERE o.location_track_id = t.id)
       ORDER BY t.id, b.id
    )
    UPDATE board b
       SET location_track_id = wanted.track_id, location_user_id = NULL
      FROM wanted
     WHERE b.id = wanted.board_id`.execute(db);
  await sql`
    WITH kept AS (
      SELECT DISTINCT ON (location_track_id) id
        FROM board
       WHERE location_track_id IS NOT NULL
       ORDER BY location_track_id, manages_workflow DESC, id
    )
    UPDATE board b
       SET location_track_id = NULL,
           manages_workflow = false,
           location_user_id = coalesce(
             b.created_by,
             (SELECT min(u.id) FROM app_user u WHERE u.workspace_id = b.workspace_id))
     WHERE b.location_track_id IS NOT NULL
       AND b.id NOT IN (SELECT id FROM kept)`.execute(db);
  await sql`CREATE UNIQUE INDEX board_one_per_track_idx ON board (location_track_id)
    WHERE location_track_id IS NOT NULL`.execute(db);
}
