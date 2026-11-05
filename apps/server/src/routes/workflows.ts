import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { contentDisposition } from '../attachments/filename';
import { requireGlobal, requireUser, type SessionUser } from '../auth';
import { diff, emit } from '../events/bus';
import { enforceLimit } from '../guardrails/model';
import { lockList, writeOrder } from '../tickets/fields';
import { closingReasonId, completedReasonId } from '../workflows/board-managed';
import { closeReasonProblem } from '../workflows/close-reasons';
import {
  followingStage,
  freeTransition,
  freeTransitions,
  statusesWantingFreeMove,
} from '../workflows/free-moving';
import {
  defaultMapId,
  loadMap,
  mapsNaming,
  trackMapId,
  tracksUsingWorkflow,
  workflowForType,
} from '../workflows/maps';
import { runningMigration } from '../workflows/migration';
import {
  definitionProblem,
  definitionSchema,
  removedStatuses,
  statusIdsOf,
  type WorkflowDefinition,
} from '../workflows/model';
import {
  holdCurrentVersions,
  holdWorkflow,
  loadDefinition,
  remapStatuses,
  rewriteCurrentVersions,
  statusInfo,
  ticketsInStatuses,
  writeVersion,
} from '../workflows/store';
import {
  documentRefusal,
  documentSchema,
  MissingStatus,
  unlistedStatus,
  type WorkflowDocument,
} from '../workflows/transfer';
import { exportDocument, type ImportResult, importDocument } from '../workflows/transfer-store';

/**
 * Statuses and workflows (M1-023; CORE-014, WF-001, WF-002; spec 01a sections 1.6 and 3).
 *
 * - Statuses are the workspace's ordered list, each in a stage (new, active, closed).
 *   Everyone signed in reads them; site and configuration administrators change them. A
 *   status keeps its stage while tickets are in it (their Closed time stamps depend on it),
 *   and is deleted only when no ticket and no current workflow version uses it. When its
 *   stage changes, the free moves into it follow (T-209): see `followStage`.
 * - A workflow is versioned data. Administrators save a draft (`PUT .../draft`), see what
 *   publishing it would do (`GET .../impact`), and publish it: statuses the draft drops take
 *   their tickets to the statuses `statusMapping` names, with history, and the next
 *   transition uses the new version (WF-002 (1), (2)). Any earlier version can be restored
 *   as the draft (WF-002 (3)). A new workflow is published as version 1.
 * - A track's members holding "View read-only workflow" (or administering it) read the
 *   workflow its map gives a ticket type at `GET /api/v1/tracks/:id/workflow?ticketTypeId=`
 *   (the map's default workflow without one).
 * - A local-mode track may own workflows (M1-028, `trackId` on create): its administrators
 *   change them as configuration administrators change shared ones, and only its own map may
 *   name them. Lists show shared workflows, and a track's own with `?trackId=`.
 * - Which tracks use a workflow ("used by", the impact of a publish) comes from the workflow
 *   maps that name it; a publish waits while a status migration runs over one of those tracks
 *   (409 `status_migration_running`).
 *
 * - A workflow version goes out as a file in Taskmoor's own format and comes back into this
 *   or another workspace as a new workflow or a new draft of one (M1-127, WF-011,
 *   `/api/v1/admin/workflows`; `workflows/transfer.ts`): statuses match by name or are
 *   created, and the answer reports what the file named that the workspace has no match for.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const stage = z.enum(['new', 'active', 'closed']);
const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;

const createStatusBody = z.object({ name, description: description.optional(), stage }).strict();
const updateStatusBody = z.object({ name, description, stage }).partial().strict();
const createWorkflowBody = z
  .object({
    name,
    description: description.optional(),
    /**
     * With no transitions, left out or empty, the workflow moves freely (WF-008 (4)): a global
     * transition into each status. A list that names some is the administrator's choice.
     */
    definition: definitionSchema.extend({
      transitions: definitionSchema.shape.transitions.optional(),
    }),
    /** A local-mode track that owns it (M1-028); shared when left out. */
    trackId: id.optional(),
  })
  .strict();
const updateWorkflowBody = z.object({ name, description }).partial().strict();
/** For each status a draft drops that tickets are in: the status they go to. */
const statusMapping = z.record(z.string().regex(/^\d{1,10}$/), id);
const publishBody = z.object({ statusMapping: statusMapping.optional() }).strict();
/** Workflow files (M1-127): the document is checked on its own, for a precise refusal. */
const MAX_DOCUMENT_BYTES = 8 * 1024 * 1024;
const importNewBody = z
  .object({
    document: z.unknown(),
    /** The new workflow's name and description; the document's when left out. */
    name: name.optional(),
    description: description.optional(),
    trackId: id.optional(),
  })
  .strict();
const importDraftBody = z.object({ document: z.unknown() }).strict();

/** An import whose result cannot be saved: nothing it did stays (the transaction rolls back). */
class ImportRefused extends Error {
  constructor(readonly detail: unknown) {
    super('import refused');
  }
}

/** What an import answers beside the workflow: how statuses came in, and what did not map. */
const reportOf = (result: ImportResult) => ({
  statuses: result.statuses,
  problems: result.problems,
});

type Db = Kysely<Database> | Transaction<Database>;
/** A draft's definition, or how to make it from the workflow's current one. */
type DraftSource =
  | WorkflowDefinition
  | ((trx: Transaction<Database>, current: WorkflowDefinition) => Promise<WorkflowDefinition>);

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

const invalid = (reply: FastifyReply, detail?: unknown) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

function statusRows(db: Db, workspaceId: number) {
  return db
    .selectFrom('status')
    .select(['id', 'name', 'description', 'stage', 'sort_order'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('sort_order')
    .execute();
}
type StatusRow = Awaited<ReturnType<typeof statusRows>>[number];
const statusView = (s: StatusRow) => ({
  id: s.id,
  name: s.name,
  description: s.description,
  stage: s.stage,
  order: s.sort_order,
});

async function knownStatuses(db: Db, workspaceId: number): Promise<Set<number>> {
  const rows = await db
    .selectFrom('status')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .execute();
  return new Set(rows.map((r) => r.id));
}

/** Stores a version's definition and the statuses it uses. */
export function registerWorkflowRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const configAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireGlobal(request, reply, 'site_admin', 'configuration_admin');

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  /**
   * Whether the caller may administer a local-mode track's own configuration: its
   * administrators and site and configuration administrators, while it is not archived (for
   * changes). Answers the refusal itself; a track the caller cannot see is not found.
   */
  async function mayConfigureTrack(
    request: FastifyRequest,
    reply: FastifyReply,
    trackId: number,
    write: boolean,
  ): Promise<boolean> {
    const track = await db
      .selectFrom('track')
      .select(['mode', 'archived_at', 'deleted_at'])
      .where('id', '=', trackId)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    const held = track && !track.deleted_at ? await request.authz.track(trackId) : null;
    const admin = await isAdmin(request);
    if (!track || !held || !(held.has('browse_track') || held.has('administer_track') || admin)) {
      await notFound(reply);
      return false;
    }
    if (write && track.archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return false;
    }
    if (held.has('administer_track') || admin) return true;
    await reply.code(403).send({ error: 'forbidden' });
    return false;
  }

  /**
   * The workflow a route names and who may use it: site and configuration administrators any
   * workflow; a local-mode track's administrators the workflows it owns (M1-028). Answers the
   * refusal itself (403 before 404 for a shared or unknown workflow, as before).
   */
  async function workflowAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
  ): Promise<{ user: SessionUser; ownerTrackId: number | null } | null> {
    const user = requireUser(request, reply);
    if (!user) return null;
    const params = z.object({ id }).safeParse({ id: (request.params as { id?: unknown }).id });
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const row = await workflowRow(request.workspaceId, params.data.id);
    if (!row || row.owner_track_id === null) {
      if (!(await isAdmin(request))) {
        await reply.code(403).send({ error: 'forbidden' });
        return null;
      }
      if (!row) {
        await notFound(reply);
        return null;
      }
      return { user, ownerTrackId: null };
    }
    if (!(await mayConfigureTrack(request, reply, row.owner_track_id, write))) return null;
    return { user, ownerTrackId: row.owner_track_id };
  }

  async function workflowRow(workspaceId: number, workflowId: number) {
    return db
      .selectFrom('workflow')
      .selectAll()
      .where('id', '=', workflowId)
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst();
  }

  /** A workflow with its published version, its draft and the tracks using it. */
  async function workflowView(workspaceId: number, workflowId: number) {
    const row = await workflowRow(workspaceId, workflowId);
    if (!row) return null;
    const versions = await db
      .selectFrom('workflow_version')
      .select(['version', 'definition', 'created_at', 'published_at'])
      .where('workflow_id', '=', workflowId)
      .where('version', 'in', [row.published_version, row.draft_version ?? row.published_version])
      .execute();
    const version = (v: number | null) => {
      const found = versions.find((x) => x.version === v);
      return found
        ? {
            version: found.version,
            definition: definitionSchema.parse(found.definition),
            createdAt: found.created_at.toISOString(),
            publishedAt: found.published_at?.toISOString() ?? null,
          }
        : null;
    };
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      isDefault: row.is_default,
      published: version(row.published_version),
      draft: version(row.draft_version),
      /** The local-mode track that owns it; null for a shared workflow. */
      trackId: row.owner_track_id,
      tracks: await tracksUsingWorkflow(db, workspaceId, row.id),
      /** The workflow maps that name it (M1-028). */
      maps: await mapsNaming(db, workspaceId, row.id),
    };
  }

  /** What publishing the draft does: the statuses it drops, with their tickets. */
  async function impactOf(trx: Db, workspaceId: number, workflowId: number) {
    const row = await trx
      .selectFrom('workflow')
      .select(['published_version', 'draft_version', 'is_default'])
      .where('id', '=', workflowId)
      .executeTakeFirstOrThrow();
    if (row.draft_version === null) return null;
    const published = await loadDefinition(trx, workflowId, row.published_version);
    const draft = await loadDefinition(trx, workflowId, row.draft_version);
    const removed = removedStatuses(published, draft);
    const tickets = await ticketsInStatuses(trx, workspaceId, workflowId, removed);
    return {
      draft,
      tickets,
      removedStatuses: removed.map((statusId) => ({
        statusId,
        ticketCount: tickets.get(statusId)?.length ?? 0,
      })),
    };
  }

  /**
   * The free moves into a status that changed stage follow it (T-209; WF-008): on every workflow
   * whose published version or draft has one, entering a status made closed-stage sets the reason
   * free moves close with, and so stamps the Closed time, as a new closing column does; entering
   * one that left the closed stage clears that reason. A changed published version becomes a new
   * one and the draft is rewritten, as when a close reason is replaced; no ticket is in the status
   * (the stage cannot change while one is), so none moves. With no reason to close with, nothing
   * changes. The ids of the workflows changed, for the status's one event.
   */
  async function followStage(
    trx: Transaction<Database>,
    actor: { workspaceId: number; actorId: number | null },
    statusId: number,
    closes: boolean,
  ): Promise<number[]> {
    const { rows } = await sql<{ id: number }>`
      SELECT DISTINCT w.id
        FROM workflow w
        JOIN workflow_version_status s
          ON s.workflow_id = w.id AND s.version IN (w.published_version, w.draft_version)
       WHERE w.workspace_id = ${actor.workspaceId} AND s.status_id = ${statusId}`.execute(trx);
    if (rows.length === 0) return [];
    // Both ways the reason matters: a move out of the closed stage clears only this one.
    const completedId = await closingReasonId(trx, actor.workspaceId);
    if (completedId === null) return [];
    const changed: number[] = [];
    for (const w of await holdCurrentVersions(
      trx,
      rows.map((r) => r.id),
    )) {
      const published = followingStage(w.published, statusId, closes, completedId);
      const draft = w.draft && followingStage(w.draft, statusId, closes, completedId);
      if (!published && !draft) continue;
      await rewriteCurrentVersions(trx, actor.workspaceId, actor.actorId, w, published, draft);
      changed.push(w.id);
    }
    return changed;
  }

  // Statuses (CORE-014)

  app.get('/api/v1/statuses', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { statuses: (await statusRows(db, request.workspaceId)).map(statusView) };
  });

  app.post('/api/v1/statuses', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = createStatusBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        await lockList(trx, ws, 'status');
        const last = await trx
          .selectFrom('status')
          .select(sql<number>`coalesce(max(sort_order), 0)`.as('n'))
          .where('workspace_id', '=', ws)
          .executeTakeFirstOrThrow();
        const created = await trx
          .insertInto('status')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            stage: body.stage,
            sort_order: Number(last.n) + 1,
          })
          .returning(['id', 'name', 'description', 'stage', 'sort_order'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'status.created',
          subjectId: created.id,
          payload: { name: created.name, stage: created.stage },
        });
        return created;
      });
      return reply.code(201).send({ status: statusView(row) });
    } catch (error) {
      if (uniqueViolation(error) === 'status_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.put('/api/v1/statuses/order', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = z
      .object({ statusIds: z.array(id).min(1).max(10_000).refine(unique, 'each id once') })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ids = parsed.data.statusIds;
    const ws = request.workspaceId;
    const done = await db.transaction().execute(async (trx) => {
      await lockList(trx, ws, 'status');
      const all = await knownStatuses(trx, ws);
      if (all.size !== ids.length || ids.some((i) => !all.has(i))) return false;
      await writeOrder(trx, 'status', ids);
      await emit(trx, by(request), {
        type: 'status.reordered',
        subjectId: ws,
        payload: { statusIds: ids },
      });
      return true;
    });
    if (!done) return invalid(reply, 'statusIds must list every status once');
    return { statuses: (await statusRows(db, ws)).map(statusView) };
  });

  app.patch('/api/v1/statuses/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateStatusBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const result = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('status')
          .select(['id', 'name', 'description', 'stage', 'sort_order'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', ws)
          .forUpdate()
          .executeTakeFirst();
        if (!current) return { missing: true as const };
        const changes = diff<Record<string, unknown>>(
          { name: current.name, description: current.description, stage: current.stage },
          body,
        );
        if (Object.keys(changes).length === 0) return { status: current };
        if (changes.stage) {
          // Tickets in it would cross into or out of the closed stage without closing.
          const used = await trx
            .selectFrom('ticket')
            .select(sql<string>`count(*)`.as('n'))
            .where('status_id', '=', current.id)
            .executeTakeFirstOrThrow();
          if (Number(used.n) > 0) return { inUse: Number(used.n) };
        }
        const updated = await trx
          .updateTable('status')
          .set({ ...body, updated_at: new Date() })
          .where('id', '=', current.id)
          .returning(['id', 'name', 'description', 'stage', 'sort_order'])
          .executeTakeFirstOrThrow();
        const workflowIds = changes.stage
          ? await followStage(trx, by(request), current.id, updated.stage === 'closed')
          : [];
        await emit(trx, by(request), {
          type: 'status.updated',
          subjectId: current.id,
          payload: { changes, ...(workflowIds.length > 0 ? { workflowIds } : {}) },
        });
        return { status: updated };
      });
      if ('missing' in result) return notFound(reply);
      if ('inUse' in result) {
        return reply.code(409).send({ error: 'status_in_use', ticketCount: result.inUse });
      }
      return { status: statusView(result.status) };
    } catch (error) {
      if (uniqueViolation(error) === 'status_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/statuses/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      await lockList(trx, ws, 'status');
      const current = await trx
        .selectFrom('status')
        .select(['id', 'name'])
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { missing: true as const };
      const workflows = await trx
        .selectFrom('workflow_version_status as s')
        .innerJoin('workflow as w', 'w.id', 's.workflow_id')
        .select(['w.id', 'w.name'])
        .distinct()
        .where('s.status_id', '=', current.id)
        .where((eb) =>
          eb.or([
            eb('s.version', '=', eb.ref('w.published_version')),
            eb('s.version', '=', eb.ref('w.draft_version')),
          ]),
        )
        .execute();
      const tickets = await trx
        .selectFrom('ticket')
        .select(sql<string>`count(*)`.as('n'))
        .where('status_id', '=', current.id)
        .executeTakeFirstOrThrow();
      if (workflows.length > 0 || Number(tickets.n) > 0) {
        return { inUse: { workflows, ticketCount: Number(tickets.n) } };
      }
      // Older versions keep the id in their definitions; restoring one now names the status
      // as unknown.
      await trx.deleteFrom('workflow_version_status').where('status_id', '=', current.id).execute();
      await trx.deleteFrom('status').where('id', '=', current.id).execute();
      const rest = await statusRows(trx, ws);
      await writeOrder(
        trx,
        'status',
        rest.map((s) => s.id),
      );
      await emit(trx, by(request), {
        type: 'status.deleted',
        subjectId: current.id,
        payload: { name: current.name },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('inUse' in result) return reply.code(409).send({ error: 'status_in_use', ...result.inUse });
    return reply.code(204).send();
  });

  // Workflows (WF-001, WF-002)

  app.get('/api/v1/workflows', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const query = z.object({ trackId: id.optional() }).strict().safeParse(request.query);
    if (!query.success) return invalid(reply);
    const trackId = query.data.trackId;
    // Shared workflows for administrators; with a track, its own too, for its administrators.
    if (trackId === undefined) {
      if (!(await configAdmin(request, reply))) return reply;
    } else if (!(await mayConfigureTrack(request, reply, trackId, false))) {
      return reply;
    }
    const ws = request.workspaceId;
    const defaultMap = await defaultMapId(db, ws);
    const rows = await db
      .selectFrom('workflow as w')
      .select([
        'w.id',
        'w.name',
        'w.description',
        'w.is_default',
        'w.published_version',
        'w.draft_version',
        'w.owner_track_id',
        // Tracks whose workflow map names it (M1-028).
        sql<string>`(
          SELECT count(*) FROM track t
            JOIN workflow_map m ON m.id = coalesce(t.workflow_map_id, ${defaultMap})
           WHERE t.workspace_id = ${ws}
             AND (m.default_workflow_id = w.id
                  OR EXISTS (SELECT 1 FROM workflow_map_entry e
                              WHERE e.map_id = m.id AND e.workflow_id = w.id)))`.as('track_count'),
      ])
      .where('w.workspace_id', '=', ws)
      .where((eb) =>
        trackId === undefined
          ? eb('w.owner_track_id', 'is', null)
          : eb.or([eb('w.owner_track_id', 'is', null), eb('w.owner_track_id', '=', trackId)]),
      )
      .orderBy('w.is_default', 'desc')
      .orderBy(sql`lower(w.name)`)
      .execute();
    return {
      workflows: rows.map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description,
        isDefault: w.is_default,
        publishedVersion: w.published_version,
        draftVersion: w.draft_version,
        trackId: w.owner_track_id,
        trackCount: Number(w.track_count ?? 0),
      })),
    };
  });

  app.get('/api/v1/workflows/:id', async (request, reply) => {
    if (!(await workflowAccess(request, reply, false))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const view = await workflowView(request.workspaceId, params.data.id);
    if (!view) return notFound(reply);
    return { workflow: view };
  });

  // A track's workflow, read-only, for those who may see it (WF-002).
  app.get('/api/v1/tracks/:id/workflow', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const held = await request.authz.track(params.data.id);
    const global = await request.authz.global();
    const admin = global.has('site_admin') || global.has('configuration_admin');
    if (!admin && !held.has('view_readonly_workflow') && !held.has('administer_track')) {
      return held.has('browse_track')
        ? reply.code(403).send({ error: 'forbidden', permission: 'view_readonly_workflow' })
        : notFound(reply);
    }
    const query = z.object({ ticketTypeId: id.optional() }).strict().safeParse(request.query);
    if (!query.success) return invalid(reply);
    // The workflow the track's map gives the type, or the map's default (M1-028).
    const mapId = await trackMapId(db, ws, params.data.id);
    const map = mapId === undefined ? null : await loadMap(db, ws, mapId);
    if (!map) return notFound(reply);
    const ticketTypeId = query.data.ticketTypeId ?? null;
    const workflowId =
      ticketTypeId === null ? map.defaultWorkflowId : workflowForType(map, ticketTypeId);
    const row = await workflowRow(ws, workflowId);
    if (!row) return notFound(reply);
    return {
      workflow: {
        id: row.id,
        name: row.name,
        description: row.description,
        version: row.published_version,
        definition: await loadDefinition(db, row.id, row.published_version),
        workflowMapId: map.id,
        ticketTypeId,
      },
    };
  });

  app.post('/api/v1/workflows', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createWorkflowBody.safeParse(request.body);
    if (!parsed.success) {
      return (await configAdmin(request, reply)) ? invalid(reply) : reply;
    }
    const body = parsed.data;
    const ws = request.workspaceId;
    const trackId = body.trackId ?? null;
    await enforceLimit(db, ws, 'statuses_per_workflow', body.definition.statuses.length);
    if (trackId === null) {
      if (!(await configAdmin(request, reply))) return reply;
    } else {
      if (!(await mayConfigureTrack(request, reply, trackId, true))) return reply;
      const track = await db
        .selectFrom('track')
        .select('mode')
        .where('id', '=', trackId)
        .executeTakeFirstOrThrow();
      if (track.mode !== 'local')
        return invalid(reply, 'a shared-mode track uses shared workflows');
    }
    const given: WorkflowDefinition = {
      ...body.definition,
      transitions: body.definition.transitions ?? [],
    };
    const problem =
      definitionProblem(given, await knownStatuses(db, ws)) ??
      (await closeReasonProblem(db, ws, given));
    if (problem) return invalid(reply, problem);
    try {
      const workflowId = await db.transaction().execute(async (trx) => {
        const definition =
          given.transitions.length > 0 ? given : await movingFreely(trx, by(request), given);
        const row = await trx
          .insertInto('workflow')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            owner_track_id: trackId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await writeVersion(trx, ws, row.id, 1, definition, user.id, true);
        await emit(trx, by(request), {
          type: 'workflow.created',
          subjectId: row.id,
          payload: {
            name: body.name,
            statusIds: [...statusIdsOf(definition)],
            transitionCount: definition.transitions.length,
            ...(trackId !== null ? { trackId } : {}),
          },
        });
        return row.id;
      });
      return reply.code(201).send({ workflow: await workflowView(ws, workflowId) });
    } catch (error) {
      if (uniqueViolation(error) === 'workflow_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.patch('/api/v1/workflows/:id', async (request, reply) => {
    if (!(await workflowAccess(request, reply, true))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateWorkflowBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const found = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('workflow')
          .select(['id', 'name', 'description'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', ws)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current) return false;
        const changes = diff<Record<string, unknown>>(
          { name: current.name, description: current.description },
          body,
        );
        if (Object.keys(changes).length === 0) return true;
        await trx
          .updateTable('workflow')
          .set({ ...body, updated_at: new Date() })
          .where('id', '=', current.id)
          .execute();
        await emit(trx, by(request), {
          type: 'workflow.updated',
          subjectId: current.id,
          payload: { changes },
        });
        return true;
      });
      if (!found) return notFound(reply);
      return { workflow: await workflowView(ws, params.data.id) };
    } catch (error) {
      if (uniqueViolation(error) === 'workflow_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  /** The definition with a global transition into each of its statuses (WF-008 (4)). */
  async function movingFreely(
    trx: Transaction<Database>,
    actor: { workspaceId: number; actorId: number | null },
    definition: WorkflowDefinition,
  ): Promise<WorkflowDefinition> {
    const ids = definition.statuses.map((s) => s.statusId);
    const info = await statusInfo(trx, actor.workspaceId, ids);
    const statuses = ids.flatMap((id) => {
      const status = info.get(id);
      return status ? [{ id, ...status }] : [];
    });
    const completedId = statuses.some((s) => s.stage === 'closed')
      ? await completedReasonId(trx, actor)
      : null;
    return { ...definition, transitions: freeTransitions(statuses, completedId) };
  }

  /**
   * Writes a definition as the draft, after the published version; its version, or null. A
   * function gives the definition from the current one (the draft, else the published version),
   * read once the workflow is held.
   */
  async function writeDraft(
    trx: Transaction<Database>,
    request: FastifyRequest,
    workflowId: number,
    given: DraftSource,
  ): Promise<{ version: number; name: string } | null> {
    const ws = request.workspaceId;
    const row = await trx
      .selectFrom('workflow')
      .select(['id', 'name', 'published_version', 'draft_version'])
      .where('id', '=', workflowId)
      .where('workspace_id', '=', ws)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!row) return null;
    const version = row.draft_version ?? row.published_version + 1;
    const definition =
      typeof given === 'function'
        ? await given(
            trx,
            await loadDefinition(trx, row.id, row.draft_version ?? row.published_version),
          )
        : given;
    // A draft number may have been used by a discarded draft: it is replaced.
    await writeVersion(trx, ws, row.id, version, definition, request.user?.id ?? null, false);
    await trx
      .updateTable('workflow')
      .set({ draft_version: version, updated_at: new Date() })
      .where('id', '=', row.id)
      .execute();
    return { version, name: row.name };
  }

  /** Saves a definition as the draft, after the published version. */
  async function saveDraft(
    request: FastifyRequest,
    workflowId: number,
    definition: DraftSource,
    restoredFrom: number | null,
  ) {
    return db.transaction().execute(async (trx) => {
      const draft = await writeDraft(trx, request, workflowId, definition);
      if (!draft) return null;
      await emit(trx, by(request), {
        type: 'workflow.draft_saved',
        subjectId: workflowId,
        payload: { version: draft.version, restoredFrom },
      });
      return draft.version;
    });
  }

  app.put('/api/v1/workflows/:id/draft', async (request, reply) => {
    if (!(await workflowAccess(request, reply, true))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = z.object({ definition: definitionSchema }).strict().safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    const problem =
      definitionProblem(parsed.data.definition, await knownStatuses(db, ws)) ??
      (await closeReasonProblem(db, ws, parsed.data.definition));
    if (problem) return invalid(reply, problem);
    await enforceLimit(db, ws, 'statuses_per_workflow', parsed.data.definition.statuses.length);
    const version = await saveDraft(
      request,
      params.data.id,
      (trx, current) => withFreeMoves(trx, ws, params.data.id, current, parsed.data.definition),
      null,
    );
    if (version === null) return notFound(reply);
    return { workflow: await workflowView(ws, params.data.id) };
  });

  /**
   * A draft with the free moves its new statuses get (T-210; WF-008 (4)), as the editor's Add a
   * status gives them: see `statusesWantingFreeMove`. A closing status takes the reason free moves
   * close with, and none when the workspace has no reason to name. New transitions number above
   * every id any version of the workflow used, since history names transitions by id. A draft the
   * additions would push past a limit is saved as sent.
   */
  async function withFreeMoves(
    trx: Transaction<Database>,
    workspaceId: number,
    workflowId: number,
    current: WorkflowDefinition,
    draft: WorkflowDefinition,
  ): Promise<WorkflowDefinition> {
    const wanting = statusesWantingFreeMove(current, draft);
    if (wanting.length === 0) return draft;
    const info = await statusInfo(trx, workspaceId, wanting);
    const closing = wanting.some((id) => info.get(id)?.stage === 'closed')
      ? await closingReasonId(trx, workspaceId)
      : null;
    const used = await sql<{ n: number | null }>`
      SELECT max((t ->> 'id')::int) AS n
        FROM workflow_version v, jsonb_array_elements(v.definition -> 'transitions') t
       WHERE v.workflow_id = ${workflowId}`.execute(trx);
    let next = Math.max(Number(used.rows[0]?.n ?? 0), ...draft.transitions.map((t) => t.id)) + 1;
    const added = wanting.flatMap((statusId) => {
      const status = info.get(statusId);
      const closes = status?.stage === 'closed';
      if (!status || (closes && closing === null)) return [];
      return [freeTransition(statusId, status.name, closes, closing, next++)];
    });
    if (added.length === 0) return draft;
    const shaped = { ...draft, transitions: [...draft.transitions, ...added] };
    return definitionSchema.safeParse(shaped).success ? shaped : draft;
  }

  // What a closing status sets when the editor adds it to a workflow that moves freely (WF-008):
  // the same answer the server's own paths use, made here if the workspace has no reason to name.
  app.post('/api/v1/workflows/:id/completed-reason', async (request, reply) => {
    if (!(await workflowAccess(request, reply, true))) return reply;
    const closeReasonId = await db.transaction().execute(async (trx) => {
      const found = await closingReasonId(trx, request.workspaceId);
      if (found !== null) return found;
      const made = await completedReasonId(trx, by(request));
      await emit(trx, by(request), {
        type: 'close_reason.created',
        subjectId: made,
        payload: { name: 'Completed' },
      });
      return made;
    });
    return { closeReasonId };
  });

  app.delete('/api/v1/workflows/:id/draft', async (request, reply) => {
    if (!(await workflowAccess(request, reply, true))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom('workflow')
        .select(['id', 'draft_version'])
        .where('id', '=', params.data.id)
        .where('workspace_id', '=', ws)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!row) return 'missing';
      if (row.draft_version === null) return 'no_draft';
      await trx
        .updateTable('workflow')
        .set({ draft_version: null, updated_at: new Date() })
        .where('id', '=', row.id)
        .execute();
      await trx
        .deleteFrom('workflow_version')
        .where('workflow_id', '=', row.id)
        .where('version', '=', row.draft_version)
        .execute();
      await emit(trx, by(request), {
        type: 'workflow.draft_discarded',
        subjectId: row.id,
        payload: { version: row.draft_version },
      });
      return 'done';
    });
    if (result === 'missing') return notFound(reply);
    if (result === 'no_draft') return reply.code(409).send({ error: 'no_draft' });
    return reply.code(204).send();
  });

  app.get('/api/v1/workflows/:id/impact', async (request, reply) => {
    if (!(await workflowAccess(request, reply, false))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const row = await workflowRow(ws, params.data.id);
    if (!row) return notFound(reply);
    const impact = await impactOf(db, ws, row.id);
    if (!impact) return reply.code(409).send({ error: 'no_draft' });
    return {
      removedStatuses: impact.removedStatuses,
      tracks: await tracksUsingWorkflow(db, ws, row.id),
    };
  });

  // The draft becomes current; dropped statuses take their tickets where the mapping says.
  app.post('/api/v1/workflows/:id/publish', async (request, reply) => {
    const user = (await workflowAccess(request, reply, true))?.user;
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = publishBody.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    const mapping = new Map(
      Object.entries(parsed.data.statusMapping ?? {}).map(([from, to]) => [Number(from), to]),
    );
    const result = await db.transaction().execute(async (trx) => {
      // The workflow first, so no ticket write against the old version is in between.
      const held = await holdWorkflow(trx, params.data.id, 'update');
      if (!held) return { missing: true as const };
      const impact = await impactOf(trx, ws, held.id);
      if (!impact) return { conflict: 'no_draft' };
      // A reason deleted after the draft was saved would refuse every move into its status.
      const closing = await closeReasonProblem(trx, ws, impact.draft);
      if (closing) return { closing };
      // A status migration still moving tickets into this workflow keeps it as it is (M1-028).
      const running = await runningMigration(
        trx,
        ws,
        (await tracksUsingWorkflow(trx, ws, held.id)).map((t) => t.id),
      );
      if (running !== null) return { migrationRunning: running };
      const statuses = statusIdsOf(impact.draft);
      const needed = impact.removedStatuses.filter((r) => r.ticketCount > 0);
      const unmapped = needed.filter((r) => !mapping.has(r.statusId));
      if (unmapped.length > 0) {
        return { mappingRequired: needed };
      }
      for (const r of needed) {
        if (!statuses.has(mapping.get(r.statusId) as number)) {
          return { badMapping: r.statusId };
        }
      }
      const used = new Map(needed.map((r) => [r.statusId, mapping.get(r.statusId) as number]));
      const ticketCount = await remapStatuses(trx, ws, user.id, impact.tickets, used);
      const version = held.draft_version as number;
      await trx
        .updateTable('workflow_version')
        .set({ published_at: new Date(), published_by: user.id })
        .where('workflow_id', '=', held.id)
        .where('version', '=', version)
        .execute();
      await trx
        .updateTable('workflow')
        .set({ published_version: version, draft_version: null, updated_at: new Date() })
        .where('id', '=', held.id)
        .execute();
      await emit(trx, by(request), {
        type: 'workflow.published',
        subjectId: held.id,
        payload: {
          version,
          removedStatuses: impact.removedStatuses.map((r) => r.statusId),
          statusMapping: Object.fromEntries([...used].map(([from, to]) => [String(from), to])),
          ticketCount,
        },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('conflict' in result) return reply.code(409).send({ error: result.conflict });
    if ('closing' in result) return invalid(reply, result.closing);
    if ('migrationRunning' in result) {
      return reply
        .code(409)
        .send({ error: 'status_migration_running', migrationId: result.migrationRunning });
    }
    if ('mappingRequired' in result) {
      return reply
        .code(409)
        .send({ error: 'status_mapping_required', statuses: result.mappingRequired });
    }
    if ('badMapping' in result) {
      return invalid(reply, { statusMapping: result.badMapping, problem: 'not_in_workflow' });
    }
    return { workflow: await workflowView(ws, params.data.id) };
  });

  app.get('/api/v1/workflows/:id/versions', async (request, reply) => {
    if (!(await workflowAccess(request, reply, false))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const row = await workflowRow(request.workspaceId, params.data.id);
    if (!row) return notFound(reply);
    const versions = await db
      .selectFrom('workflow_version as v')
      .leftJoin('app_user as c', 'c.id', 'v.created_by')
      .leftJoin('app_user as p', 'p.id', 'v.published_by')
      .select([
        'v.version',
        'v.created_at',
        'c.id as created_by',
        'c.name as created_by_name',
        'v.published_at',
        'p.id as published_by',
        'p.name as published_by_name',
      ])
      .where('v.workflow_id', '=', row.id)
      .orderBy('v.version', 'desc')
      .execute();
    return {
      versions: versions.map((v) => ({
        version: v.version,
        state:
          v.version === row.published_version
            ? 'published'
            : v.version === row.draft_version
              ? 'draft'
              : 'earlier',
        createdAt: v.created_at.toISOString(),
        createdBy: v.created_by === null ? null : { id: v.created_by, name: v.created_by_name },
        publishedAt: v.published_at?.toISOString() ?? null,
        publishedBy:
          v.published_by === null ? null : { id: v.published_by, name: v.published_by_name },
      })),
    };
  });

  app.get('/api/v1/workflows/:id/versions/:version', async (request, reply) => {
    if (!(await workflowAccess(request, reply, false))) return reply;
    const params = z.object({ id, version: id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const row = await workflowRow(request.workspaceId, params.data.id);
    if (!row) return notFound(reply);
    const version = await db
      .selectFrom('workflow_version')
      .select(['version', 'definition'])
      .where('workflow_id', '=', row.id)
      .where('version', '=', params.data.version)
      .executeTakeFirst();
    if (!version) return notFound(reply);
    return { version: version.version, definition: definitionSchema.parse(version.definition) };
  });

  // An earlier version comes back as the draft, to publish like any other (WF-002 (3)).
  app.post('/api/v1/workflows/:id/versions/:version/restore', async (request, reply) => {
    if (!(await workflowAccess(request, reply, true))) return reply;
    const params = z.object({ id, version: id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const row = await workflowRow(ws, params.data.id);
    if (!row) return notFound(reply);
    if (params.data.version === row.draft_version)
      return reply.code(409).send({ error: 'is_draft' });
    const source = await db
      .selectFrom('workflow_version')
      .select('definition')
      .where('workflow_id', '=', row.id)
      .where('version', '=', params.data.version)
      .executeTakeFirst();
    if (!source) return notFound(reply);
    const definition = definitionSchema.parse(source.definition);
    const problem =
      definitionProblem(definition, await knownStatuses(db, ws)) ??
      (await closeReasonProblem(db, ws, definition));
    if (problem) return reply.code(409).send({ error: 'cannot_restore', detail: problem });
    await saveDraft(request, row.id, definition, params.data.version);
    return { workflow: await workflowView(ws, row.id) };
  });

  app.delete('/api/v1/workflows/:id', async (request, reply) => {
    if (!(await workflowAccess(request, reply, true))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      const held = await holdWorkflow(trx, params.data.id, 'update');
      if (!held) return { missing: true as const };
      if (held.is_default) return { conflict: 'default_workflow' };
      // A workflow a map names stays (M1-028): the map changes first.
      const maps = await mapsNaming(trx, ws, held.id);
      if (maps.length > 0) {
        return { inUse: { tracks: await tracksUsingWorkflow(trx, ws, held.id), maps } };
      }
      await trx.deleteFrom('workflow').where('id', '=', held.id).execute();
      await emit(trx, by(request), {
        type: 'workflow.deleted',
        subjectId: held.id,
        payload: { name: held.name },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('conflict' in result) return reply.code(409).send({ error: result.conflict });
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'workflow_in_use', ...result.inUse });
    }
    return reply.code(204).send();
  });

  // Workflow files (M1-127, WF-011): Taskmoor's own format, read by any workspace.

  /** The document in a body, or the refusal sent. */
  async function readDocument(
    reply: FastifyReply,
    body: unknown,
  ): Promise<WorkflowDocument | null> {
    const refusal = documentRefusal(body);
    if (refusal) {
      await reply.code(400).send({ error: refusal });
      return null;
    }
    const parsed = documentSchema.safeParse(body);
    if (!parsed.success) {
      await invalid(reply, {
        document: parsed.error.issues
          .slice(0, 10)
          .map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
      return null;
    }
    const unlisted = unlistedStatus(parsed.data);
    if (unlisted !== null) {
      await invalid(reply, {
        document: [{ path: 'statuses', message: `status ${unlisted} is not in the table` }],
      });
      return null;
    }
    return parsed.data;
  }

  /** A definition an import made, checked as a saved one is; refused otherwise. */
  async function checkImported(trx: Transaction<Database>, ws: number, result: ImportResult) {
    const problem = definitionProblem(result.definition, await knownStatuses(trx, ws));
    if (problem) throw new ImportRefused(problem);
  }

  app.get('/api/v1/admin/workflows/:id/export', async (request, reply) => {
    if (!(await workflowAccess(request, reply, false))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ version: id.optional() }).strict().safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const ws = request.workspaceId;
    const row = await workflowRow(ws, params.data.id);
    if (!row) return notFound(reply);
    const version = query.data.version ?? row.published_version;
    const stored = await db
      .selectFrom('workflow_version')
      .select('definition')
      .where('workflow_id', '=', row.id)
      .where('version', '=', version)
      .executeTakeFirst();
    if (!stored) return notFound(reply);
    let document: WorkflowDocument;
    try {
      document = await exportDocument(db, ws, row, definitionSchema.parse(stored.definition));
    } catch (error) {
      if (!(error instanceof MissingStatus)) throw error;
      // An earlier version naming a status deleted since (the current ones keep theirs).
      return reply.code(409).send({ error: 'unknown_status', statusId: error.statusId });
    }
    await emit(db, by(request), {
      type: 'workflow.exported',
      subjectId: row.id,
      payload: { version },
    });
    return reply
      .header('content-type', 'application/json; charset=utf-8')
      .header('content-disposition', contentDisposition('attachment', `${row.name}.workflow.json`))
      .send(`${JSON.stringify(document, null, 2)}\n`);
  });

  // A new workflow from a file, published as its version 1 like any new workflow.
  app.post(
    '/api/v1/admin/workflows/import',
    { bodyLimit: MAX_DOCUMENT_BYTES },
    async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const parsed = importNewBody.safeParse(request.body);
      if (!parsed.success) {
        return (await configAdmin(request, reply)) ? invalid(reply) : reply;
      }
      const ws = request.workspaceId;
      const trackId = parsed.data.trackId ?? null;
      if (trackId === null) {
        if (!(await configAdmin(request, reply))) return reply;
      } else {
        if (!(await mayConfigureTrack(request, reply, trackId, true))) return reply;
        const track = await db
          .selectFrom('track')
          .select('mode')
          .where('id', '=', trackId)
          .executeTakeFirstOrThrow();
        if (track.mode !== 'local') {
          return invalid(reply, 'a shared-mode track uses shared workflows');
        }
      }
      const document = await readDocument(reply, parsed.data.document);
      if (!document) return reply;
      await enforceLimit(db, ws, 'statuses_per_workflow', document.definition.statuses.length);
      const workflowName = parsed.data.name ?? document.workflow.name;
      try {
        const done = await db.transaction().execute(async (trx) => {
          const result = await importDocument(trx, ws, document, trackId);
          await checkImported(trx, ws, result);
          const row = await trx
            .insertInto('workflow')
            .values({
              workspace_id: ws,
              name: workflowName,
              description: parsed.data.description ?? document.workflow.description,
              owner_track_id: trackId,
            })
            .returning('id')
            .executeTakeFirstOrThrow();
          await writeVersion(trx, ws, row.id, 1, result.definition, user.id, true);
          await emit(trx, by(request), {
            type: 'workflow.imported',
            subjectId: row.id,
            payload: {
              name: workflowName,
              version: 1,
              draft: false,
              createdStatusIds: result.statuses
                .filter((s) => s.outcome === 'created')
                .map((s) => s.statusId),
              problems: result.problems.length,
              ...(trackId !== null ? { trackId } : {}),
            },
          });
          return { workflowId: row.id, result };
        });
        return reply.code(201).send({
          workflow: await workflowView(ws, done.workflowId),
          report: reportOf(done.result),
        });
      } catch (error) {
        if (error instanceof ImportRefused) return invalid(reply, error.detail);
        if (uniqueViolation(error) === 'workflow_name_idx') {
          return reply.code(409).send({ error: 'name_taken' });
        }
        throw error;
      }
    },
  );

  // A file as the next draft of a workflow, to check and publish like any other draft.
  app.post(
    '/api/v1/admin/workflows/:id/import',
    { bodyLimit: MAX_DOCUMENT_BYTES },
    async (request, reply) => {
      const access = await workflowAccess(request, reply, true);
      if (!access) return reply;
      const params = z.object({ id }).safeParse(request.params);
      const parsed = importDraftBody.safeParse(request.body);
      if (!params.success || !parsed.success) return invalid(reply);
      const document = await readDocument(reply, parsed.data.document);
      if (!document) return reply;
      const ws = request.workspaceId;
      await enforceLimit(db, ws, 'statuses_per_workflow', document.definition.statuses.length);
      try {
        const done = await db.transaction().execute(async (trx) => {
          const result = await importDocument(trx, ws, document, access.ownerTrackId);
          await checkImported(trx, ws, result);
          const draft = await writeDraft(trx, request, params.data.id, result.definition);
          // Deleted meanwhile: nothing the import created stays.
          if (!draft) throw new ImportRefused(null);
          await emit(trx, by(request), {
            type: 'workflow.imported',
            subjectId: params.data.id,
            payload: {
              name: draft.name,
              version: draft.version,
              draft: true,
              createdStatusIds: result.statuses
                .filter((s) => s.outcome === 'created')
                .map((s) => s.statusId),
              problems: result.problems.length,
              ...(access.ownerTrackId !== null ? { trackId: access.ownerTrackId } : {}),
            },
          });
          return result;
        });
        return { workflow: await workflowView(ws, params.data.id), report: reportOf(done) };
      } catch (error) {
        if (error instanceof ImportRefused) {
          return error.detail === null ? notFound(reply) : invalid(reply, error.detail);
        }
        throw error;
      }
    },
  );
}
