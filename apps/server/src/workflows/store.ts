import type { Database, StatusStage } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { rewriteTickets } from '../tickets/fields';
import { definitionSchema, statusIdsOf, type WorkflowDefinition } from './model';

/**
 * Reading workflows and moving tickets between statuses (M1-023). Lock order, as for the
 * other configuration values: a ticket write holds its track (key share), then its track's
 * workflow map (key share, M1-028), then its workflow (key share), then the ticket; publishing
 * a workflow holds the workflow (update) and then rewrites tickets; a track's switch of map
 * holds the track (update), then both maps and their workflows, then tickets. Saving a draft
 * holds the workflow (no key update), then the statuses it names (key share, all of them at once in
 * id order, never in the order the definition lists them: `writeVersion`), and reads the stage of a
 * status it gives a free move only once it holds it (`heldStatusInfo`, T-237); creating a workflow
 * and a column's path do the same. A status's change
 * of stage holds every workflow whose published version or draft has the status (no key update,
 * so it never waits for a ticket write), then the status (update), as a ticket write and a draft
 * save take a workflow before a status; it holds no workflow after the status (it starts again).
 * A board's sync holds the status list (`lockList`), then its track's workflow (update), then the
 * statuses it may rename or settle (update, in id order; whether another workflow has one is read
 * only once it is held, T-237), and reads whether it may take the workflow over only once it holds
 * the list and the workflow; a column's path holds the list (when it makes a status), then the workflow, and
 * reads the published version after that (T-238). A workflow import holds the list before the
 * workflow, and deleting or reordering statuses the list before the statuses. So everywhere: the
 * status list, then workflows (by id), then statuses (ADR-116). A ticket's workflow comes from its
 * track's map and its ticket type (`workflows/maps.ts`).
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
 * Name and stage of statuses by id, each row held (key share, in id order) until the transaction
 * ends, for a free move that follows the stage (T-237). A stage change holds its status (update)
 * while it rewrites the free moves of the workflows that have it; a workflow that takes the status
 * meanwhile is not among them, so its own free move must see the stage the change leaves, not the
 * one before. Key share waits for that change and is what writing a version's statuses takes
 * anyway, after the workflow: the lock order of ADR-116.
 */
export async function heldStatusInfo(
  trx: Transaction<Database>,
  workspaceId: number,
  ids: readonly number[],
): Promise<Map<number, { name: string; stage: StatusStage }>> {
  if (ids.length === 0) return new Map();
  const rows = await trx
    .selectFrom('status')
    .select(['id', 'name', 'stage'])
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...new Set(ids)])
    .orderBy('id')
    .forKeyShare()
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

/**
 * Writes a version of a workflow, with the statuses it holds; published when asked. The statuses
 * are held first (key share, in id order), as the rows of the version would hold them one by one in
 * the order the definition lists them: a board's sync holding two of them (update, in id order)
 * would otherwise wait for this save while it waits for the sync (40P01, T-237). Held already, by
 * `heldStatusInfo` or by a sync, they are not waited for again.
 */
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
  const statusIds = [...statusIdsOf(definition)].sort((a, b) => a - b);
  await heldStatusInfo(trx, workspaceId, statusIds);
  await trx
    .insertInto('workflow_version_status')
    .values(
      statusIds.map((status_id) => ({
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
 * on, for a rewrite that moves no ticket (a status's change of stage, which holds the status
 * next, and a ticket write may be waiting for that).
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
 * the draft is rewritten in place. Null for either leaves it as it is. The new published version's
 * number, or null when there is none.
 */
export async function rewriteCurrentVersions(
  trx: Transaction<Database>,
  workspaceId: number,
  actorId: number | null,
  w: CurrentVersions,
  published: WorkflowDefinition | null,
  draft: WorkflowDefinition | null,
): Promise<number | null> {
  if (published === null) {
    if (draft && w.draftVersion !== null) {
      await writeVersion(trx, workspaceId, w.id, w.draftVersion, draft, actorId, false);
    }
    return null;
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
  return version;
}
