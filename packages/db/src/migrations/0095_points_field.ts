import { type Kysely, sql } from 'kysely';

/**
 * A Points field, and the boards that estimate with it (the user's decision; AGL-006, AGL-007).
 *
 * Per workspace:
 *
 * - **The field.** A shared number field named Points, Story points or Puntos, the oldest if there
 *   are several, is the workspace's own and stays as it is. Without one this makes `Points`, with
 *   a context over every track and type, like any new shared field, so it is searchable and on
 *   every form. Stored in English; the web app names it in the person's language (`fieldName`).
 *   A shared field of another type already called Points holds the name: nothing is made there, as
 *   the name is unique and it is not this migration's to take.
 * - **The boards.** A board that still has the default statistic, the original time estimate,
 *   estimates with the field from now on, or with its own track's such field on a local-mode
 *   track. Left as they are: a board that names a field (someone chose it), one counting tickets
 *   (nobody gets that by default), and one over tickets that do hold time estimates, whose sprint
 *   reports would drop to zero. Their cards still show points, as a card falls back to a field of
 *   this name (`pointsFieldOf`).
 *
 * Tickets keep their values. Administrators may rename or remove the field afterwards. No domain
 * event, no new version or `updated_at`: nobody changed a board.
 */
const NAMES = ['points', 'story points', 'puntos'];

export async function up(db: Kysely<unknown>): Promise<void> {
  const named = sql`type = 'number' AND lower(trim(name)) = ANY(${NAMES}::text[])`;
  const { rows: workspaces } = await sql<{ id: number }>`
    SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id: ws } of workspaces) {
    const { rows: found } = await sql<{ id: number }>`
      SELECT id FROM field
       WHERE workspace_id = ${ws} AND track_id IS NULL AND ${named}
       ORDER BY id LIMIT 1`.execute(db);
    let shared = found[0]?.id ?? null;
    if (shared === null) {
      const { rows: made } = await sql<{ id: number }>`
        INSERT INTO field (workspace_id, name, type)
        VALUES (${ws}, 'Points', 'number')
        ON CONFLICT (workspace_id, coalesce(track_id, 0), lower(name)) DO NOTHING
        RETURNING id`.execute(db);
      shared = made[0]?.id ?? null;
      if (shared !== null) {
        const { rows: context } = await sql<{ id: number }>`
          INSERT INTO field_context (workspace_id, field_id, name)
          VALUES (${ws}, ${shared}, 'Default')
          RETURNING id`.execute(db);
        await sql`
          INSERT INTO field_context_scope (workspace_id, field_id, context_id, track_id, ticket_type_id)
          VALUES (${ws}, ${shared}, ${context[0]?.id as number}, NULL, NULL)`.execute(db);
      }
    }
    await sql`
      WITH target AS (
        SELECT b.id,
               COALESCE(
                 (SELECT f.id FROM field f
                   WHERE f.workspace_id = ${ws} AND f.track_id = b.location_track_id
                     AND f.type = 'number' AND lower(trim(f.name)) = ANY(${NAMES}::text[])
                   ORDER BY f.id LIMIT 1),
                 ${shared}::integer) AS field_id
          FROM board b
         WHERE b.workspace_id = ${ws}
           AND COALESCE(b.sprint_settings #>> '{estimation,statistic}', 'originalEstimate')
               = 'originalEstimate'
           AND NOT EXISTS (
             SELECT 1 FROM ticket k
              WHERE k.track_id = b.location_track_id AND k.original_estimate IS NOT NULL)
      )
      UPDATE board b
         SET sprint_settings =
               '{"timeTracking": "remainingEstimate", "parallelSprints": false}'::jsonb
               || b.sprint_settings
               || jsonb_build_object(
                    'estimation',
                    jsonb_build_object('statistic', 'field', 'fieldId', t.field_id))
        FROM target t
       WHERE b.id = t.id AND t.field_id IS NOT NULL`.execute(db);
  }
}
