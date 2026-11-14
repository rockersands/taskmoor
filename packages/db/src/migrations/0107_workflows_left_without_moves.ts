import { type Kysely, sql } from 'kysely';

/**
 * Old workflows left with no moves get their free moves (T-246; WF-008 (4); ADR-116; the user's
 * decision of 2026-11-13). A workflow made empty before free moving was the rule, or imported or
 * published empty before T-246, has a published version with no transitions, so no ticket in it
 * can move. This does at the upgrade what the operator's `cli.mjs workflow-moves --repair`
 * (`apps/server/src/workflows/free-moves.ts`, `repairWorkflowMoves`) does, with its rules, so no
 * site needs a manual step:
 *
 * - each status of the workflow gets a global transition into it, named after it, in the order
 *   of the definition, numbered above every transition id any version of the workflow used;
 * - a move into a closed-stage status sets the reason free moves close with (Completed by name,
 *   else what the default workflow's published version sets on entering a closed-stage status);
 *   with none to name that status gets no move and no reason is made; any other move clears the
 *   reason;
 * - a workflow a board manages, one with a rule, and one that would get no move at all stay as
 *   they are (the CLI command still lists them).
 *
 * The moves are a new published version by nobody. A draft stays as its author saved it,
 * renumbered above the new version, as 0104 left drafts: the new version takes the draft's number
 * and the draft the next one. Statuses keep their ids and no ticket moves. Like 0089, 0104 and
 * 0105 it writes no event: an upgrade is not someone's change.
 *
 * Migrations are frozen, and this package cannot import the server, so the repair's rules are
 * written out here; the server's tests check that both give the same published definition.
 */
interface Effect {
  type?: string;
  field?: string;
  value?: unknown;
}
interface StoredTransition {
  id?: number;
  to?: number;
  effects?: Effect[];
}
interface Stored {
  statuses?: { statusId: number }[];
  transitions?: StoredTransition[];
  onCreate?: { effects?: Effect[] };
  rules?: Record<string, Effect[]>;
  board?: unknown;
}

const CLOSE_REASON = 'close-reason';
const MAX_NAME = 255;
const MAX_TRANSITIONS = 2000;

const writesReason = (e: Effect) =>
  (e.type === 'update-system-field' || e.type === 'update-field') &&
  e.field === CLOSE_REASON &&
  e.value !== null &&
  e.value !== undefined;

/** The reason free moves close with in a workspace, or null (the server's `closingReasonId`). */
async function closingReason(db: Kysely<unknown>, workspaceId: number): Promise<number | null> {
  const named = await sql<{ id: number }>`
    SELECT id FROM close_reason
     WHERE workspace_id = ${workspaceId} AND lower(name) = 'completed'`.execute(db);
  if (named.rows[0]) return named.rows[0].id;
  const { rows } = await sql<{ definition: Stored }>`
    SELECT v.definition
      FROM workflow w
      JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
     WHERE w.workspace_id = ${workspaceId} AND w.is_default`.execute(db);
  const definition = rows[0]?.definition;
  if (!definition) return null;
  const transitions = definition.transitions ?? [];
  // A default workflow that sets a reason the workspace no longer has names none.
  const set = [
    ...transitions.flatMap((t) => t.effects ?? []),
    ...(definition.onCreate?.effects ?? []),
    ...Object.values(definition.rules ?? {}).flat(),
  ].filter(writesReason);
  if (set.length > 0) {
    const known = await sql<{ id: number }>`
      SELECT id FROM close_reason WHERE workspace_id = ${workspaceId}`.execute(db);
    const ids = new Set(known.rows.map((r) => String(r.id)));
    if (set.some((e) => !ids.has(String(e.value)))) return null;
  }
  const targets = transitions.map((t) => Number(t.to));
  const closed = await sql<{ id: number }>`
    SELECT id FROM status
     WHERE workspace_id = ${workspaceId} AND stage = 'closed'
       AND id = ANY(${targets}::int[])`.execute(db);
  const closing = new Set(closed.rows.map((r) => r.id));
  const first = transitions
    .filter((t) => closing.has(Number(t.to)))
    .flatMap((t) => t.effects ?? [])
    .find(writesReason);
  return first ? Number(first.value) : null;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  const { rows } = await sql<{
    workspace_id: number;
    id: number;
    published_version: number;
    draft_version: number | null;
    definition: Stored;
  }>`
    SELECT w.workspace_id, w.id, w.published_version, w.draft_version, v.definition
      FROM workflow w
      JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
     WHERE jsonb_array_length(coalesce(v.definition -> 'transitions', '[]'::jsonb)) = 0
     ORDER BY w.id`.execute(db);
  for (const row of rows) {
    const { definition } = row;
    // A board's columns say which moves there are; a rule is someone's on purpose.
    if (definition.board || Object.keys(definition.rules ?? {}).length > 0) continue;
    const ids = (definition.statuses ?? []).map((s) => Number(s.statusId));
    if (ids.length === 0) continue;
    const found = await sql<{ id: number; name: string; stage: string }>`
      SELECT id, name, stage FROM status
       WHERE workspace_id = ${row.workspace_id} AND id = ANY(${ids}::int[])`.execute(db);
    const info = new Map(found.rows.map((s) => [s.id, s]));
    const closing = ids.some((id) => info.get(id)?.stage === 'closed')
      ? await closingReason(db, row.workspace_id)
      : null;
    const used = await sql<{ n: number | null }>`
      SELECT max((t ->> 'id')::int) AS n
        FROM workflow_version v, jsonb_array_elements(v.definition -> 'transitions') t
       WHERE v.workflow_id = ${row.id}`.execute(db);
    let next = Number(used.rows[0]?.n ?? 0) + 1;
    const transitions = ids.flatMap((statusId) => {
      const status = info.get(statusId);
      const closes = status?.stage === 'closed';
      if (!status || (closes && closing === null)) return [];
      return [
        {
          id: next++,
          name: status.name,
          from: 'any',
          to: statusId,
          effects:
            closes && closing !== null
              ? [{ type: 'update-system-field', field: CLOSE_REASON, value: String(closing) }]
              : [{ type: 'clear-field', field: CLOSE_REASON }],
        },
      ];
    });
    if (transitions.length === 0 || transitions.length > MAX_TRANSITIONS) continue;
    // The server saves only names it accepts (1 to 255 characters once trimmed).
    if (transitions.some((t) => t.name.trim().length === 0 || t.name.trim().length > MAX_NAME)) {
      continue;
    }
    const moving = { ...definition, transitions };

    const latest = await sql<{ v: number }>`
      SELECT max(version)::int AS v FROM workflow_version WHERE workflow_id = ${row.id}`.execute(
      db,
    );
    const top = Number(latest.rows[0]?.v ?? row.published_version);
    // A draft numbers above the published version: it moves up, and the new version takes its
    // number (the next one when there is none).
    const published = row.draft_version ?? top + 1;
    if (row.draft_version !== null) {
      const draft = top + 1;
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
      VALUES (${row.workspace_id}, ${row.id}, ${published}, ${JSON.stringify(moving)}, now())`.execute(
      db,
    );
    // The statuses it holds, as the server writes them for every version.
    await sql`
      INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
      SELECT ${row.workspace_id}, ${row.id}, ${published}, id
        FROM status
       WHERE workspace_id = ${row.workspace_id} AND id = ANY(${ids}::int[])`.execute(db);
    await sql`
      UPDATE workflow SET published_version = ${published}, updated_at = now()
       WHERE id = ${row.id}`.execute(db);
  }
}
