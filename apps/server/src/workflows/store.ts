import type { Database, StatusStage } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { rewriteTickets } from '../tickets/fields';
import { definitionSchema, statusIdsOf, type WorkflowDefinition } from './model';

/**
 * Reading workflows and moving tickets between statuses (M1-023). Lock order, as for the
 * other configuration values: a ticket write holds its track (key share), then its track's
 * workflow map (key share, M1-028), then its workflow (key share), then the ticket; publishing
 * a workflow holds the workflow (update) and then rewrites tickets; a track's switch of map
 * holds the track (update), then both maps and their workflows, then tickets. A ticket's
 * workflow comes from its track's map and its ticket type (`workflows/maps.ts`).
 */
type Db = Kysely<Database> | Transaction<Database>;

export async function defaultWorkflowId(db: Db, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('workflow')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('is_default', '=', true)
    .executeTakeFirstOrThrow();
  return row.id;
}

export async function loadDefinition(
  db: Db,
  workflowId: number,
  version: number,
): Promise<WorkflowDefinition> {
  const row = await db
    .selectFrom('workflow_version')
    .select('definition')
    .where('workflow_id', '=', workflowId)
    .where('version', '=', version)
    .executeTakeFirstOrThrow();
  return definitionSchema.parse(row.definition);
}

/**
 * A workflow and its published definition, the row held until the transaction ends: key
 * share for a ticket write (a publish waits for it, and it for a publish), update for a
 * change to the workflow itself.
 */
export async function holdWorkflow(
  trx: Transaction<Database>,
  workflowId: number,
  mode: 'share' | 'update',
) {
  const query = trx
    .selectFrom('workflow')
    .select(['id', 'name', 'published_version', 'draft_version', 'is_default'])
    .where('id', '=', workflowId);
  const row = await (mode === 'share' ? query.forKeyShare() : query.forUpdate()).executeTakeFirst();
  if (!row) return null;
  return { ...row, definition: await loadDefinition(trx, row.id, row.published_version) };
}

/** Name and stage of statuses by id. */
export async function statusInfo(
  db: Db,
  workspaceId: number,
  ids: readonly number[],
): Promise<Map<number, { name: string; stage: StatusStage }>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .selectFrom('status')
    .select(['id', 'name', 'stage'])
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...new Set(ids)])
    .execute();
  return new Map(rows.map((r) => [r.id, { name: r.name, stage: r.stage }]));
}

/**
 * Tickets, the trash included, whose workflow (their track's map for their ticket type) is
 * `workflowId` and whose status is one of `statusIds`, by status.
 */
export async function ticketsInStatuses(
  db: Db,
  workspaceId: number,
  workflowId: number,
  statusIds: readonly number[],
): Promise<Map<number, number[]>> {
  if (statusIds.length === 0) return new Map();
  const { rows } = await sql<{ id: number; status_id: number }>`
    SELECT k.id, k.status_id
      FROM ticket k
      JOIN track t ON t.id = k.track_id
      JOIN workflow_map m ON m.id = coalesce(t.workflow_map_id,
             (SELECT d.id FROM workflow_map d WHERE d.workspace_id = ${workspaceId} AND d.is_default))
      LEFT JOIN workflow_map_entry e ON e.map_id = m.id AND e.ticket_type_id = k.ticket_type_id
     WHERE k.workspace_id = ${workspaceId}
       AND k.status_id = ANY(${[...statusIds]}::int[])
       AND coalesce(e.workflow_id, m.default_workflow_id) = ${workflowId}
     ORDER BY k.id`.execute(db);
  const out = new Map<number, number[]>();
  for (const row of rows) {
    out.set(row.status_id, [...(out.get(row.status_id) ?? []), row.id]);
  }
  return out;
}

/**
 * Moves tickets from statuses to others (`mapping` from → to), each with a new version and its
 * history, as one change set. The close reason stays: only transitions, layouts and effects
 * set or clear it (WF-008). Returns how many tickets moved.
 */
export async function remapStatuses(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  tickets: ReadonlyMap<number, readonly number[]>,
  mapping: ReadonlyMap<number, number>,
): Promise<number> {
  const all = [...tickets.values()].flat();
  if (all.length === 0) return 0;
  return rewriteTickets(trx, workspaceId, actorId, all, async (ids) => {
    for (const [from, to] of mapping) {
      await sql`
        UPDATE ticket SET status_id = ${to}
         WHERE id = ANY(${ids}::int[]) AND status_id = ${from}`.execute(trx);
    }
  });
}

/** Writes a version of a workflow, with the statuses it holds; published when asked. */
export async function writeVersion(
  trx: Transaction<Database>,
  workspaceId: number,
  workflowId: number,
  version: number,
  definition: WorkflowDefinition,
  actorId: number | null,
  published: boolean,
) {
  await trx
    .deleteFrom('workflow_version')
    .where('workflow_id', '=', workflowId)
    .where('version', '=', version)
    .execute();
  await trx
    .insertInto('workflow_version')
    .values({
      workspace_id: workspaceId,
      workflow_id: workflowId,
      version,
      definition: JSON.stringify(definition),
      created_by: actorId,
      ...(published ? { published_at: new Date(), published_by: actorId } : {}),
    })
    .execute();
  await trx
    .insertInto('workflow_version_status')
    .values(
      [...statusIdsOf(definition)].map((status_id) => ({
        workspace_id: workspaceId,
        workflow_id: workflowId,
        version,
        status_id,
      })),
    )
    .execute();
}

/** A workflow with its published version and its draft, as a rewrite of both reads them. */
export interface CurrentVersions {
  id: number;
  name: string;
  publishedVersion: number;
  draftVersion: number | null;
  published: WorkflowDefinition;
  draft: WorkflowDefinition | null;
}

/**
 * These workflows, by id, each row held until the transaction ends, with their current versions.
 * `update` also waits for ticket writes on them, as a publish does; `no key update` lets them go
 * on, for a rewrite that moves no ticket and holds a row a ticket write may wait for (a status).
 */
export async function holdCurrentVersions(
  trx: Transaction<Database>,
  ids: readonly number[],
  lock: 'update' | 'no key update' = 'update',
): Promise<CurrentVersions[]> {
  if (ids.length === 0) return [];
  const held = await sql<{
    id: number;
    name: string;
    published_version: number;
    draft_version: number | null;
  }>`
    SELECT id, name, published_version, draft_version FROM workflow
     WHERE id = ANY(${[...new Set(ids)]}::int[]) ORDER BY id
       FOR ${sql.raw(lock === 'update' ? 'UPDATE' : 'NO KEY UPDATE')}`.execute(trx);
  const out: CurrentVersions[] = [];
  for (const row of held.rows) {
    out.push({
      id: row.id,
      name: row.name,
      publishedVersion: row.published_version,
      draftVersion: row.draft_version,
      published: await loadDefinition(trx, row.id, row.published_version),
      draft:
        row.draft_version === null ? null : await loadDefinition(trx, row.id, row.draft_version),
    });
  }
  return out;
}

/**
 * Writes a held workflow's rewritten versions; statuses do not change, so no ticket moves. A new
 * `published` definition becomes a new published version, and the draft (rewritten, or as it was)
 * moves above it, since a draft always numbers above the published version. With only a `draft`,
 * the draft is rewritten in place. Null for either leaves it as it is.
 */
export async function rewriteCurrentVersions(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  w: CurrentVersions,
  published: WorkflowDefinition | null,
  draft: WorkflowDefinition | null,
): Promise<void> {
  if (published === null) {
    if (draft && w.draftVersion !== null) {
      await writeVersion(trx, workspaceId, w.id, w.draftVersion, draft, actorId, false);
    }
    return;
  }
  const latest = await sql<{ v: number }>`
    SELECT max(version)::int AS v FROM workflow_version WHERE workflow_id = ${w.id}`.execute(trx);
  const version = Number(latest.rows[0]?.v) + 1;
  await writeVersion(trx, workspaceId, w.id, version, published, actorId, true);
  const kept = draft ?? w.draft;
  const draftVersion = kept ? version + 1 : null;
  if (kept) await writeVersion(trx, workspaceId, w.id, version + 1, kept, actorId, false);
  await trx
    .updateTable('workflow')
    .set({ published_version: version, draft_version: draftVersion, updated_at: new Date() })
    .where('id', '=', w.id)
    .execute();
  if (kept && w.draftVersion !== null) {
    await trx
      .deleteFrom('workflow_version')
      .where('workflow_id', '=', w.id)
      .where('version', '=', w.draftVersion)
      .execute();
  }
}
