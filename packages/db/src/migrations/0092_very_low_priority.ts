import { type Kysely, sql } from 'kysely';

/**
 * Very low, and a ticket always has a priority (the user's decision; CORE-014).
 *
 * - **Very low** joins the bottom of a workspace's list only when the list is still the four
 *   priorities 0018 seeded, by name and in that order. Recolouring or describing one of them
 *   leaves the list as it was, so it still counts; renaming, reordering, adding or deleting one
 *   means an administrator made the list their own (M1-014), and this leaves it alone. It joins the
 *   default priority set the same way, only when the set still offers all four: another set,
 *   or one that an administrator narrowed, keeps offering what it offered.
 * - **Tickets with no priority** take their track's default: the set's own default, else the
 *   middle of what the set offers. Imported tickets keep what their source said, none included
 *   (they have a row in `import_external_id`).
 *
 * The filling is a correction, not a change anyone made: no ticket_change row, no domain event, no
 * new version or `updated_at`. The ticket's trigger still writes change_log, so local copies of
 * the board catch up (0036). `priority_id` stays nullable: imports and an empty set need it.
 */
const SEEDED = ['Urgent', 'High', 'Normal', 'Low'];

export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows: workspaces } = await sql<{
    id: number;
  }>`SELECT id FROM workspace ORDER BY id`.execute(db);
  for (const { id: ws } of workspaces) {
    const { rows: list } = await sql<{ id: number; name: string }>`
      SELECT id, name FROM priority WHERE workspace_id = ${ws} ORDER BY sort_order`.execute(db);
    if (list.map((p) => p.name).join('\n') !== SEEDED.join('\n')) continue;
    const { rows: added } = await sql<{ id: number }>`
      INSERT INTO priority (workspace_id, name, description, icon, color, sort_order)
      SELECT ${ws}, 'Very low', 'Whenever there is time', 'priority-very-low', '#a7b3c2',
             max(sort_order) + 1
        FROM priority WHERE workspace_id = ${ws}
      RETURNING id`.execute(db);
    const veryLow = added[0]?.id as number;
    await sql`
      INSERT INTO priority_set_member (workspace_id, priority_set_id, priority_id)
      SELECT ${ws}, s.id, ${veryLow}
        FROM priority_set s
       WHERE s.workspace_id = ${ws} AND s.is_default
         AND (SELECT count(*) FROM priority_set_member m
               WHERE m.priority_set_id = s.id
                 AND m.priority_id = ANY(${list.map((p) => p.id)}::int[])) = ${list.length}`.execute(
      db,
    );
  }

  await sql`
    WITH chosen AS (
      SELECT t.id AS track_id,
             COALESCE(t.priority_set_id,
               (SELECT d.id FROM priority_set d
                 WHERE d.workspace_id = t.workspace_id AND d.is_default)) AS set_id
        FROM track t
    ), fallback AS (
      SELECT c.track_id,
             COALESCE(s.default_priority_id,
               (SELECT m.priority_id
                  FROM priority_set_member m
                  JOIN priority p ON p.id = m.priority_id
                 WHERE m.priority_set_id = s.id
                 ORDER BY p.sort_order
                 OFFSET (SELECT count(*) / 2 FROM priority_set_member n
                          WHERE n.priority_set_id = s.id)
                 LIMIT 1)) AS priority_id
        FROM chosen c
        JOIN priority_set s ON s.id = c.set_id
    )
    UPDATE ticket k
       SET priority_id = f.priority_id
      FROM fallback f
     WHERE k.track_id = f.track_id
       AND k.priority_id IS NULL
       AND f.priority_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM import_external_id e
          WHERE e.workspace_id = k.workspace_id
            AND e.entity_kind = 'ticket'
            AND e.target_id = k.id)`.execute(db);
}
