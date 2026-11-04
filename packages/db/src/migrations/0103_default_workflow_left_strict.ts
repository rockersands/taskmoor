import { type Kysely, sql } from 'kysely';

/**
 * The cases 0089 left on the old strict default workflow though nobody chose a rule (the user's
 * decision of 2026-11-04; WF-008; ADR-116): a site that had renamed a seeded status, and one with
 * an open draft. Only a default workflow still published at version 1, exactly as the first seed
 * wrote it, gets the free-moving version: the match is on that version's own transitions, so a
 * renamed status does not hide it and anything an administrator published stays as it is.
 *
 * Statuses keep their ids. An open draft stays what its author saved, renumbered above the new
 * published version.
 */
interface Seeded {
  id: number;
  name: string;
  from: 'any' | number[];
  to: number;
  layout?: unknown[];
  guards?: unknown;
  checks?: unknown[];
  effects?: unknown[];
}

const asSeeded = (transitions: Seeded[], initial: number) => {
  const by = new Map(transitions.map((t) => [t.id, t]));
  const [start, review, back, close, reopen] = [1, 2, 3, 4, 5].map((id) => by.get(id));
  if (transitions.length !== 5 || !start || !review || !back || !close || !reopen) return null;
  if (
    start.name !== 'Start' ||
    review.name !== 'Send to review' ||
    back.name !== 'Back to active' ||
    close.name !== 'Close' ||
    reopen.name !== 'Reopen' ||
    close.from !== 'any' ||
    start.to !== back.to ||
    reopen.to !== initial
  ) {
    return null;
  }
  return { fresh: initial, active: start.to, review: review.to, closed: close.to };
};

export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    workspace_id: number;
    id: number;
    draft_version: number | null;
    definition: { initialStatusId: number; transitions: Seeded[] };
  }>`
    SELECT w.workspace_id, w.id, w.draft_version, v.definition
      FROM workflow w
      JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
     WHERE w.is_default AND w.published_version = 1`.execute(db);
  for (const row of rows) {
    const seeded = asSeeded(row.definition.transitions, row.definition.initialStatusId);
    if (!seeded) continue;
    const { fresh, active, review, closed } = seeded;
    const ids = [fresh, active, review, closed];
    const names = await sql<{ id: number; name: string }>`
      SELECT id, name FROM status WHERE id = ANY(${ids}::int[])`.execute(db);
    const nameOf = (id: number) => names.rows.find((s) => s.id === id)?.name ?? '';
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
      statuses: ids.map((statusId) => ({ statusId })),
      // The ids of the first version stay, as in 0089, so history keeps naming the same steps.
      transitions: [
        { id: 5, name: nameOf(fresh), from: 'any', to: fresh, effects: clear },
        { id: 1, name: nameOf(active), from: 'any', to: active, effects: clear },
        { id: 2, name: nameOf(review), from: 'any', to: review, effects: clear },
        {
          id: 4,
          name: nameOf(closed),
          from: 'any',
          to: closed,
          effects: [
            { type: 'update-system-field', field: 'close-reason', value: String(completed) },
          ],
        },
      ],
    };
    // A draft numbers above the published version: it moves up, and the new version takes its
    // number (version 2 when there is none, as 0089 gave everyone else).
    const published = row.draft_version ?? 2;
    if (row.draft_version !== null) {
      const draft = row.draft_version + 1;
      await sql`
        INSERT INTO workflow_version
          (workspace_id, workflow_id, version, definition, created_by, created_at)
        SELECT workspace_id, workflow_id, ${draft}, definition, created_by, created_at
          FROM workflow_version
         WHERE workflow_id = ${row.id} AND version = ${row.draft_version}`.execute(db);
      await sql`
        INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
        SELECT workspace_id, workflow_id, ${draft}, status_id
          FROM workflow_version_status
         WHERE workflow_id = ${row.id} AND version = ${row.draft_version}`.execute(db);
      await sql`UPDATE workflow SET draft_version = ${draft} WHERE id = ${row.id}`.execute(db);
      await sql`
        DELETE FROM workflow_version
         WHERE workflow_id = ${row.id} AND version = ${row.draft_version}`.execute(db);
    }
    await sql`
      INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
      VALUES (${row.workspace_id}, ${row.id}, ${published}, ${JSON.stringify(definition)}, now())`.execute(
      db,
    );
    await sql`
      INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
      SELECT ${row.workspace_id}, ${row.id}, ${published}, unnest(${ids}::int[])`.execute(db);
    await sql`UPDATE workflow SET published_version = ${published} WHERE id = ${row.id}`.execute(
      db,
    );
  }
}
