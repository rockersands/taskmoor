import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';

/**
 * Configuration guardrails (M1-055; CORE-026; spec 01a section 1.7): limits on how much
 * configuration one track, field, policy, map, workflow or set may hold, with defaults an
 * administrator may raise or lower. An addition that would go beyond a limit is refused with
 * 409 `guardrail_exceeded` naming the guardrail and its limit; what already exists is never
 * touched, so a lowered limit can leave usage above it until someone removes some.
 */
export const GUARDRAILS = [
  { name: 'fields_per_track', default: 700 },
  { name: 'ticket_types_per_track', default: 150 },
  { name: 'options_per_field', default: 20_000 },
  { name: 'visibility_levels_per_track', default: 50 },
  { name: 'grants_per_permission', default: 50 },
  { name: 'releases_per_track', default: 15_000 },
  { name: 'workflows_per_map', default: 150 },
  { name: 'statuses_per_workflow', default: 200 },
  { name: 'areas_per_track', default: 10_000 },
  { name: 'priorities_per_track', default: 100 },
  // Tickets one bulk operation may change (M1-130; API-007): 10,000 by default, never above the
  // 100,000 a single request carries (MAX_BULK_TICKETS).
  { name: 'tickets_per_bulk_operation', default: 10_000 },
] as const;
export type GuardrailName = (typeof GUARDRAILS)[number]['name'];
/** No limit goes above this, whatever an administrator asks. */
export const GUARDRAIL_CEILING = 1_000_000;

export function isGuardrail(name: string): name is GuardrailName {
  return GUARDRAILS.some((g) => g.name === name);
}

type Db = Kysely<Database> | Transaction<Database>;

/** Every guardrail's limit in a workspace: its own where set, the default otherwise. */
export async function guardrailLimits(
  db: Db,
  workspaceId: number,
): Promise<Record<GuardrailName, number>> {
  const rows = await db
    .selectFrom('guardrail_limit')
    .select(['name', 'value'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  const own = new Map(rows.map((r) => [r.name, r.value]));
  return Object.fromEntries(
    GUARDRAILS.map((g) => [g.name, own.get(g.name) ?? g.default]),
  ) as Record<GuardrailName, number>;
}

export async function guardrailLimit(
  db: Db,
  workspaceId: number,
  name: GuardrailName,
): Promise<number> {
  return (await guardrailLimits(db, workspaceId))[name];
}

/** The refusal of an addition that would take `count` past the limit, or null. */
export async function beyondLimit(
  db: Db,
  workspaceId: number,
  name: GuardrailName,
  count: number,
): Promise<{ error: 'guardrail_exceeded'; guardrail: GuardrailName; limit: number } | null> {
  const limit = await guardrailLimit(db, workspaceId, name);
  return count > limit ? { error: 'guardrail_exceeded', guardrail: name, limit } : null;
}

/**
 * Thrown inside a route's transaction when an addition would go past a limit: the transaction
 * rolls back and the app answers 409 with the body (the handler in `app.ts`).
 */
export class GuardrailExceeded extends Error {
  constructor(
    readonly body: { error: 'guardrail_exceeded'; guardrail: GuardrailName; limit: number },
  ) {
    super(`${body.guardrail} is limited to ${body.limit}`);
  }
}

/** Refuses, by throwing GuardrailExceeded, when `count` would go past the limit. */
export async function enforceLimit(
  db: Db,
  workspaceId: number,
  name: GuardrailName,
  count: number,
): Promise<void> {
  const over = await beyondLimit(db, workspaceId, name, count);
  if (over) throw new GuardrailExceeded(over);
}

/** Where a guardrail is used most: the largest count and what holds it. */
export interface Usage {
  value: number;
  where: { kind: string; id: number; name: string } | null;
}

/** The custom fields a track would see with `fieldId` added to `trackIds` (null: every track). */
export async function fieldsPerTrackWith(
  db: Db,
  workspaceId: number,
  fieldId: number | null,
  trackIds: readonly number[] | null,
): Promise<number> {
  const { rows } = await sql<{ n: number | null }>`
    SELECT max((
      SELECT count(DISTINCT s.field_id)::int FROM field_context_scope s
       WHERE s.workspace_id = ${workspaceId}
         AND s.field_id IS DISTINCT FROM ${fieldId}::int
         AND (s.track_id IS NULL OR s.track_id = t.id)
    )) AS n
      FROM track t
     WHERE t.workspace_id = ${workspaceId}
       AND (${trackIds === null} OR t.id = ANY(${trackIds ?? []}::int[]))`.execute(db);
  return (rows[0]?.n ?? 0) + (fieldId === null ? 0 : 1);
}

/** The largest usage of every guardrail in a workspace, for the admin page (CORE-026 (1)). */
export async function guardrailUsage(
  db: Db,
  workspaceId: number,
): Promise<Record<GuardrailName, Usage>> {
  const top = async (
    query: ReturnType<typeof sql<{ id: number; name: string; n: number }>>,
    kind: string,
  ): Promise<Usage> => {
    const { rows } = await query.execute(db);
    const row = rows[0];
    return row
      ? { value: Number(row.n), where: { kind, id: row.id, name: row.name } }
      : { value: 0, where: null };
  };
  const ws = workspaceId;
  const [
    fields,
    types,
    options,
    levels,
    grants,
    releases,
    maps,
    statuses,
    areas,
    priorities,
    bulk,
  ] = await Promise.all([
    top(
      sql`SELECT t.id, t.key AS name, (
              SELECT count(DISTINCT s.field_id)::int FROM field_context_scope s
               WHERE s.workspace_id = ${ws} AND (s.track_id IS NULL OR s.track_id = t.id)) AS n
              FROM track t WHERE t.workspace_id = ${ws} ORDER BY n DESC, t.id LIMIT 1`,
      'track',
    ),
    top(
      sql`SELECT s.id, s.name, count(m.ticket_type_id)::int AS n
              FROM type_set s JOIN type_set_member m ON m.type_set_id = s.id
             WHERE s.workspace_id = ${ws} GROUP BY s.id ORDER BY n DESC, s.id LIMIT 1`,
      'type_set',
    ),
    top(
      sql`SELECT f.id, f.name, count(o.id)::int AS n
              FROM field f JOIN field_option o ON o.field_id = f.id
             WHERE f.workspace_id = ${ws} GROUP BY f.id ORDER BY n DESC, f.id LIMIT 1`,
      'field',
    ),
    top(
      sql`SELECT p.id, p.name, count(l.id)::int AS n
              FROM visibility_policy p JOIN visibility_level l ON l.policy_id = p.id
             WHERE p.workspace_id = ${ws} GROUP BY p.id ORDER BY n DESC, p.id LIMIT 1`,
      'visibility_policy',
    ),
    top(
      sql`SELECT p.id, p.name || ': ' || g.permission AS name, count(*)::int AS n
              FROM access_policy p JOIN access_grant g ON g.policy_id = p.id
             WHERE p.workspace_id = ${ws} GROUP BY p.id, g.permission
             ORDER BY n DESC, p.id LIMIT 1`,
      'access_policy',
    ),
    top(
      sql`SELECT t.id, t.key AS name, count(r.id)::int AS n
              FROM track t JOIN release r ON r.track_id = t.id AND r.archived_at IS NULL
             WHERE t.workspace_id = ${ws} GROUP BY t.id ORDER BY n DESC, t.id LIMIT 1`,
      'track',
    ),
    top(
      sql`SELECT m.id, m.name, (
              SELECT count(DISTINCT w)::int FROM (
                SELECT m.default_workflow_id AS w
                UNION SELECT e.workflow_id FROM workflow_map_entry e WHERE e.map_id = m.id) x) AS n
              FROM workflow_map m WHERE m.workspace_id = ${ws} ORDER BY n DESC, m.id LIMIT 1`,
      'workflow_map',
    ),
    top(
      sql`SELECT w.id, w.name, count(s.status_id)::int AS n
              FROM workflow w JOIN workflow_version_status s
                ON s.workflow_id = w.id AND s.version = w.published_version
             WHERE w.workspace_id = ${ws} GROUP BY w.id ORDER BY n DESC, w.id LIMIT 1`,
      'workflow',
    ),
    top(
      sql`SELECT t.id, t.key AS name, count(a.id)::int AS n
              FROM track t JOIN area a ON a.track_id = t.id AND a.archived_at IS NULL
             WHERE t.workspace_id = ${ws} GROUP BY t.id ORDER BY n DESC, t.id LIMIT 1`,
      'track',
    ),
    top(
      sql`SELECT s.id, s.name, count(m.priority_id)::int AS n
              FROM priority_set s JOIN priority_set_member m ON m.priority_set_id = s.id
             WHERE s.workspace_id = ${ws} GROUP BY s.id ORDER BY n DESC, s.id LIMIT 1`,
      'priority_set',
    ),
    top(
      sql`SELECT b.id, b.action AS name, b.total AS n
              FROM bulk_operation b WHERE b.workspace_id = ${ws} ORDER BY n DESC, b.id LIMIT 1`,
      'bulk_operation',
    ),
  ]);
  return {
    fields_per_track: fields,
    ticket_types_per_track: types,
    options_per_field: options,
    visibility_levels_per_track: levels,
    grants_per_permission: grants,
    releases_per_track: releases,
    workflows_per_map: maps,
    statuses_per_workflow: statuses,
    areas_per_track: areas,
    priorities_per_track: priorities,
    tickets_per_bulk_operation: bulk,
  };
}
