import { type Kysely, sql } from 'kysely';

/**
 * The workflow a site starts with moves freely (the user's decision; ADR-116). A status is what a
 * board's column says: any ticket goes to any status at once, nothing asks for a field, and
 * entering Closed sets the close reason Completed while leaving it clears it. Why a ticket moved
 * goes in a comment.
 *
 * Only a default workflow nobody changed gets the new version: one an administrator edited, and
 * any imported workflow, keeps its rules. An administrator can still add a required field, a guard
 * or a check to any workflow on purpose.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    workspace_id: number;
    id: number;
    definition: {
      initialStatusId: number;
      statuses: { statusId: number }[];
      transitions: { id: number; to: number }[];
    };
  }>`
    SELECT w.workspace_id, w.id, v.definition
      FROM workflow w
      JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
     WHERE w.is_default
       AND w.published_version = 1
       AND w.draft_version IS NULL`.execute(db);
  for (const row of rows) {
    const statuses = await sql<{ id: number; name: string; stage: string }>`
      SELECT id, name, stage FROM status
       WHERE workspace_id = ${row.workspace_id}
         AND id = ANY(${row.definition.statuses.map((s) => s.statusId)}::int[])
       ORDER BY sort_order`.execute(db);
    const named = (name: string) => statuses.rows.find((s) => s.name === name)?.id;
    const [fresh, active, review, closed] = [
      named('New'),
      named('Active'),
      named('In Review'),
      named('Closed'),
    ];
    // Someone renamed the seeded statuses: it is no longer the workflow this migration knows.
    if (!fresh || !active || !review || !closed) continue;
    let completed = (
      await sql<{ id: number }>`
        SELECT id FROM close_reason
         WHERE workspace_id = ${row.workspace_id} AND lower(name) = 'completed'`.execute(db)
    ).rows[0]?.id;
    if (completed === undefined) {
      const made = await sql<{ id: number }>`
        INSERT INTO close_reason (workspace_id, name, sort_order)
        SELECT ${row.workspace_id}, 'Completed', coalesce(max(sort_order), 0) + 1
          FROM close_reason WHERE workspace_id = ${row.workspace_id}
        RETURNING id`.execute(db);
      completed = made.rows[0]?.id as number;
    }
    const clear = [{ type: 'clear-field', field: 'close-reason' }];
    const definition = {
      initialStatusId: fresh,
      statuses: [fresh, active, review, closed].map((statusId) => ({ statusId })),
      // The ids of the first version stay, so history keeps naming the same steps.
      transitions: [
        { id: 5, name: 'New', from: 'any', to: fresh, effects: clear },
        { id: 1, name: 'Active', from: 'any', to: active, effects: clear },
        { id: 2, name: 'In Review', from: 'any', to: review, effects: clear },
        {
          id: 4,
          name: 'Closed',
          from: 'any',
          to: closed,
          effects: [
            { type: 'update-system-field', field: 'close-reason', value: String(completed) },
          ],
        },
      ],
    };
    await sql`
      INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
      VALUES (${row.workspace_id}, ${row.id}, 2, ${JSON.stringify(definition)}, now())`.execute(db);
    await sql`
      INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
      SELECT ${row.workspace_id}, ${row.id}, 2, unnest(${[fresh, active, review, closed]}::int[])`.execute(
      db,
    );
    await sql`UPDATE workflow SET published_version = 2 WHERE id = ${row.id}`.execute(db);
  }
}
