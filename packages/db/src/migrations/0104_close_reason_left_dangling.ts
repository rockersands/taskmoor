import { type Kysely, sql } from 'kysely';

/**
 * Until T-207 a close reason could be deleted while a workflow set it (WF-008; ADR-116), and every
 * move through that transition has been refused since: `close-reason: not_found`. A published
 * version or an open draft that names a reason the workspace no longer has now names Completed,
 * made if the site deleted it too. Nothing can have moved through those transitions, so the
 * version is corrected where it stands. Earlier versions stay as they were written.
 */
interface Effect {
  type?: string;
  field?: string;
  value?: unknown;
}
interface Definition {
  transitions?: { effects?: Effect[] }[];
  onCreate?: { effects?: Effect[] };
  rules?: Record<string, Effect[]>;
}

const setting = (definition: Definition): Effect[] =>
  [
    ...(definition.transitions ?? []).flatMap((t) => t.effects ?? []),
    ...(definition.onCreate?.effects ?? []),
    ...Object.values(definition.rules ?? {}).flat(),
  ].filter(
    (e) =>
      (e.type === 'update-system-field' || e.type === 'update-field') &&
      e.field === 'close-reason' &&
      e.value !== null &&
      e.value !== undefined,
  );

export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    workspace_id: number;
    workflow_id: number;
    version: number;
    definition: Definition;
  }>`
    SELECT w.workspace_id, v.workflow_id, v.version, v.definition
      FROM workflow w
      JOIN workflow_version v
        ON v.workflow_id = w.id AND v.version IN (w.published_version, w.draft_version)
     WHERE v.definition::text LIKE '%close-reason%'
     ORDER BY v.workflow_id, v.version`.execute(db);
  const reasons = new Map<number, Set<string>>();
  for (const row of rows) {
    let known = reasons.get(row.workspace_id);
    if (!known) {
      const found = await sql<{ id: number }>`
        SELECT id FROM close_reason WHERE workspace_id = ${row.workspace_id}`.execute(db);
      known = new Set(found.rows.map((r) => String(r.id)));
      reasons.set(row.workspace_id, known);
    }
    const dangling = setting(row.definition).filter((e) => !known.has(String(e.value)));
    if (dangling.length === 0) continue;
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
      known.add(String(completed));
    }
    for (const effect of dangling) effect.value = String(completed);
    await sql`
      UPDATE workflow_version SET definition = ${JSON.stringify(row.definition)}
       WHERE workflow_id = ${row.workflow_id} AND version = ${row.version}`.execute(db);
  }
}
