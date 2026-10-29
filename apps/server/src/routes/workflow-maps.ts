import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser, type SessionUser } from '../auth';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import {
  defaultMapId,
  loadMap,
  trackMapId,
  tracksUsingMap,
  type WorkflowMap,
  workflowForType,
  workflowsOf,
} from '../workflows/maps';
import {
  type Impact,
  impactOf,
  lostByType,
  migrationView,
  planMigration,
  runningMigration,
  startMigration,
  statusMappingOf,
  statusMappingSchema,
  typeStatusMappingSchema,
} from '../workflows/migration';
import { holdWorkflow } from '../workflows/store';

/**
 * Workflow maps (M1-028; WF-001 (3); ADR-045): which workflow each ticket type uses.
 *
 * - Shared maps belong to the workspace: site and configuration administrators list, create,
 *   change and delete them, and give them to shared-mode tracks (track PATCH `workflowMapId`).
 *   The default map serves every track without one; it can change but not go.
 * - A local-mode track owns one map, made with the track; its administrators change it and may
 *   name the track's own workflows and ticket types in it besides shared ones. It goes with the
 *   track.
 * - A change of a map's default or entries that leaves tickets of its tracks in statuses their
 *   type's new workflow lacks needs `statusMapping` (or per type `typeStatusMapping`), answers
 *   409 `status_mapping_required` with the statuses and their ticket counts otherwise, and moves
 *   them in the background (`workflows/migration.ts`); `POST .../impact` shows what a change
 *   would do first. Progress is at `GET /api/v1/workflow-migrations/:id`.
 * - People who may read a track's workflow read its map at `GET /api/v1/tracks/:id/workflow-map`.
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
/** Spec 01a section 1.7: workflows per workflow map. */
export const WORKFLOWS_PER_MAP = 150;
const id = z.coerce.number().int().positive().max(MAX_INT);
const bodyId = z.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const entries = z
  .array(z.object({ ticketTypeId: bodyId, workflowId: bodyId }).strict())
  .max(1000)
  .refine(
    (list) => new Set(list.map((e) => e.ticketTypeId)).size === list.length,
    'each type once',
  );

const createBody = z
  .object({
    name,
    description: description.optional(),
    defaultWorkflowId: bodyId,
    entries: entries.optional(),
  })
  .strict();
const updateBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    defaultWorkflowId: bodyId.optional(),
    entries: entries.optional(),
    statusMapping: statusMappingSchema.optional(),
    typeStatusMapping: typeStatusMappingSchema.optional(),
  })
  .strict();
const impactBody = z
  .object({ defaultWorkflowId: bodyId.optional(), entries: entries.optional() })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

const invalid = (reply: FastifyReply, detail?: unknown) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

/** Entries as stored and compared: ticket type id to workflow id, by type. */
const entryRecord = (map: ReadonlyMap<number, number>) =>
  Object.fromEntries([...map].sort((a, b) => a[0] - b[0]).map(([t, w]) => [String(t), w]));

/** Why a map may not name these workflows and types, or null when it may. */
async function contentProblem(
  db: Db,
  workspaceId: number,
  ownerTrackId: number | null,
  defaultWorkflowId: number,
  entries: ReadonlyMap<number, number>,
): Promise<string | null> {
  const workflowIds = [...new Set([defaultWorkflowId, ...entries.values()])];
  if (workflowIds.length > WORKFLOWS_PER_MAP) return 'too_many_workflows';
  // Shared workflows and types, and a local-mode track's own (section 1.1).
  const usable = <T extends 'workflow' | 'ticket_type'>(table: T, ids: number[]) =>
    ids.length === 0
      ? Promise.resolve([])
      : db
          .selectFrom(table as 'workflow')
          .select('id')
          .where('workspace_id', '=', workspaceId)
          .where('id', 'in', ids)
          .where((eb) =>
            ownerTrackId === null
              ? eb('owner_track_id', 'is', null)
              : eb.or([eb('owner_track_id', 'is', null), eb('owner_track_id', '=', ownerTrackId)]),
          )
          .execute();
  if ((await usable('workflow', workflowIds)).length !== workflowIds.length) return 'workflowId';
  const typeIds = [...entries.keys()];
  if ((await usable('ticket_type', typeIds)).length !== typeIds.length) return 'ticketTypeId';
  return null;
}

/** Names of workflows, ticket types and statuses, for views. */
async function namesOf(
  db: Db,
  table: 'workflow' | 'ticket_type' | 'status',
  ids: Iterable<number>,
): Promise<Map<number, string>> {
  const list = [...new Set(ids)];
  if (list.length === 0) return new Map();
  const rows = await db
    .selectFrom(table as 'status')
    .select(['id', 'name'])
    .where('id', 'in', list)
    .execute();
  return new Map(rows.map((r) => [r.id, r.name]));
}

const named = (names: ReadonlyMap<number, string>, id: number) => ({
  id,
  name: names.get(id) ?? '',
});

/** A map as the API shows it, with the tracks that use it. */
async function mapView(db: Db, workspaceId: number, map: WorkflowMap) {
  const workflows = await namesOf(db, 'workflow', workflowsOf(map));
  const types = await namesOf(db, 'ticket_type', map.entries.keys());
  const entries = [...map.entries]
    .map(([ticketTypeId, workflowId]) => ({
      ticketType: named(types, ticketTypeId),
      workflow: named(workflows, workflowId),
    }))
    .sort(
      (a, b) =>
        a.ticketType.name.localeCompare(b.ticketType.name) || a.ticketType.id - b.ticketType.id,
    );
  return {
    id: map.id,
    name: map.name,
    description: map.description,
    isDefault: map.isDefault,
    trackId: map.ownerTrackId,
    defaultWorkflow: named(workflows, map.defaultWorkflowId),
    entries,
    tracks: await tracksUsingMap(db, workspaceId, map),
  };
}

/** What a change would do, with names: by ticket type, summed over the tracks. */
async function impactView(
  db: Db,
  impact: Impact,
  tracks: readonly { id: number; key: string; name: string }[],
) {
  const types = new Map<
    string,
    { ticketTypeId: number; ticketCount: number; from: number; to: number }
  >();
  for (const t of impact.types) {
    const key = `${t.ticketTypeId}:${t.from}:${t.to}`;
    const entry = types.get(key) ?? { ...t, ticketCount: 0 };
    entry.ticketCount += t.ticketCount;
    types.set(key, entry);
  }
  const lost = lostByType(impact.lost);
  const typeNames = await namesOf(db, 'ticket_type', [
    ...[...types.values()].map((t) => t.ticketTypeId),
    ...lost.map((l) => l.ticketTypeId),
  ]);
  const statusNames = await namesOf(
    db,
    'status',
    lost.map((l) => l.statusId),
  );
  const workflow = (wid: number) => ({ id: wid, name: impact.workflows.get(wid)?.name ?? '' });
  return {
    tracks,
    types: [...types.values()]
      .sort((a, b) => a.ticketTypeId - b.ticketTypeId)
      .map((t) => ({
        ticketType: named(typeNames, t.ticketTypeId),
        ticketCount: t.ticketCount,
        from: workflow(t.from),
        to: workflow(t.to),
      })),
    lostStatuses: lost.map((l) => ({
      ticketType: named(typeNames, l.ticketTypeId),
      status: named(statusNames, l.statusId),
      ticketCount: l.ticketCount,
      workflow: workflow(l.workflowId),
    })),
    ticketCount: lost.reduce((n, l) => n + l.ticketCount, 0),
  };
}

export function registerWorkflowMapRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  async function isAdmin(request: FastifyRequest): Promise<boolean> {
    const global = await request.authz.global();
    return global.has('site_admin') || global.has('configuration_admin');
  }

  /** 401, then 403 for everyone but site and configuration administrators. */
  async function requireAdmin(request: FastifyRequest, reply: FastifyReply) {
    const user = requireUser(request, reply);
    if (!user) return null;
    if (await isAdmin(request)) return user;
    await reply.code(403).send({ error: 'forbidden' });
    return null;
  }

  /**
   * The map a route names and whether the caller may use it: administrators any map; a
   * local-mode track's administrators its own (changes only while the track is not archived).
   * Answers the refusal itself; 403 before 404 for shared or unknown maps.
   */
  async function mapAccess(
    request: FastifyRequest,
    reply: FastifyReply,
    write: boolean,
  ): Promise<{ user: SessionUser; map: WorkflowMap } | null> {
    const user = requireUser(request, reply);
    if (!user) return null;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const map = await loadMap(db, request.workspaceId, params.data.id);
    const admin = await isAdmin(request);
    if (!map || map.ownerTrackId === null) {
      if (!admin) {
        await reply.code(403).send({ error: 'forbidden' });
        return null;
      }
      if (!map) {
        await notFound(reply);
        return null;
      }
      return { user, map };
    }
    const track = await db
      .selectFrom('track')
      .select(['archived_at', 'deleted_at'])
      .where('id', '=', map.ownerTrackId)
      .executeTakeFirst();
    const held = track && !track.deleted_at ? await request.authz.track(map.ownerTrackId) : null;
    if (!held || !(held.has('browse_track') || held.has('administer_track') || admin)) {
      await notFound(reply);
      return null;
    }
    if (write && track?.archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return null;
    }
    if (!held.has('administer_track') && !admin) {
      await reply.code(403).send({ error: 'forbidden' });
      return null;
    }
    return { user, map };
  }

  app.get('/api/v1/workflow-maps', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const ws = request.workspaceId;
    const rows = await db
      .selectFrom('workflow_map as m')
      .innerJoin('workflow as w', 'w.id', 'm.default_workflow_id')
      .select([
        'm.id',
        'm.name',
        'm.description',
        'm.is_default',
        'w.id as workflow_id',
        'w.name as workflow_name',
        (eb) =>
          eb
            .selectFrom('workflow_map_entry as e')
            .select(sql<string>`count(*)`.as('n'))
            .whereRef('e.map_id', '=', 'm.id')
            .as('entry_count'),
        (eb) =>
          eb
            .selectFrom('track as t')
            .select(sql<string>`count(*)`.as('n'))
            .where('t.workspace_id', '=', ws)
            .where((t) =>
              t.or([
                t('t.workflow_map_id', '=', t.ref('m.id')),
                t.and([t('t.workflow_map_id', 'is', null), t('m.is_default', '=', true)]),
              ]),
            )
            .as('track_count'),
      ])
      .where('m.workspace_id', '=', ws)
      .where('m.owner_track_id', 'is', null)
      .orderBy('m.is_default', 'desc')
      .orderBy(sql`lower(m.name)`)
      .execute();
    return {
      workflowMaps: rows.map((m) => ({
        id: m.id,
        name: m.name,
        description: m.description,
        isDefault: m.is_default,
        defaultWorkflow: { id: m.workflow_id, name: m.workflow_name },
        entryCount: Number(m.entry_count ?? 0),
        trackCount: Number(m.track_count ?? 0),
      })),
    };
  });

  app.post('/api/v1/workflow-maps', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const entryMap = new Map((body.entries ?? []).map((e) => [e.ticketTypeId, e.workflowId]));
    try {
      const created = await db.transaction().execute(async (trx) => {
        const problem = await contentProblem(trx, ws, null, body.defaultWorkflowId, entryMap);
        if (problem) return { problem };
        const row = await trx
          .insertInto('workflow_map')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            default_workflow_id: body.defaultWorkflowId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (entryMap.size > 0) {
          await trx
            .insertInto('workflow_map_entry')
            .values(
              [...entryMap].map(([ticket_type_id, workflow_id]) => ({
                workspace_id: ws,
                map_id: row.id,
                ticket_type_id,
                workflow_id,
              })),
            )
            .execute();
        }
        await emit(trx, by(request), {
          type: 'workflow_map.created',
          subjectId: row.id,
          payload: {
            name: body.name,
            defaultWorkflowId: body.defaultWorkflowId,
            entries: entryRecord(entryMap),
            trackId: null,
          },
        });
        return { id: row.id };
      });
      if ('problem' in created) return invalid(reply, created.problem);
      const map = (await loadMap(db, ws, created.id)) as WorkflowMap;
      return reply.code(201).send({ workflowMap: await mapView(db, ws, map) });
    } catch (error) {
      if (uniqueViolation(error) === 'workflow_map_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.get('/api/v1/workflow-maps/:id', async (request, reply) => {
    const access = await mapAccess(request, reply, false);
    if (!access) return reply;
    return { workflowMap: await mapView(db, request.workspaceId, access.map) };
  });

  /** The map as a change would leave it. */
  const changed = (
    map: WorkflowMap,
    change: {
      defaultWorkflowId?: number | undefined;
      entries?: { ticketTypeId: number; workflowId: number }[] | undefined;
    },
  ): WorkflowMap => ({
    ...map,
    defaultWorkflowId: change.defaultWorkflowId ?? map.defaultWorkflowId,
    entries: change.entries
      ? new Map(change.entries.map((e) => [e.ticketTypeId, e.workflowId]))
      : map.entries,
  });

  // What a change of default or entries would do to the tickets of the map's tracks.
  app.post('/api/v1/workflow-maps/:id/impact', async (request, reply) => {
    const access = await mapAccess(request, reply, false);
    if (!access) return reply;
    const parsed = impactBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    const map = access.map;
    const next = changed(map, parsed.data);
    const problem = await contentProblem(
      db,
      ws,
      map.ownerTrackId,
      next.defaultWorkflowId,
      next.entries,
    );
    if (problem) return invalid(reply, problem);
    const tracks = await tracksUsingMap(db, ws, map);
    const impact = await impactOf(
      db,
      ws,
      tracks.map((t) => t.id),
      (_, type) => workflowForType(map, type),
      (_, type) => workflowForType(next, type),
    );
    return { impact: await impactView(db, impact, tracks) };
  });

  app.patch('/api/v1/workflow-maps/:id', async (request, reply) => {
    const access = await mapAccess(request, reply, true);
    if (!access) return reply;
    const parsed = updateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const mapId = access.map.id;
    // Read through the pool before the transaction: formulas recompute for moved tickets.
    const catalog = await catalogs.get(ws);
    try {
      const result = await db.transaction().execute(async (trx) => {
        // The map first: ticket writes hold it shared, so none uses the old one meanwhile.
        const map = await loadMap(trx, ws, mapId, 'update');
        if (!map) return { missing: true as const };
        const next = changed(map, body);
        const problem = await contentProblem(
          trx,
          ws,
          map.ownerTrackId,
          next.defaultWorkflowId,
          next.entries,
        );
        if (problem) return { problem };
        const changes = diff<Record<string, unknown>>(
          {
            name: map.name,
            description: map.description,
            defaultWorkflowId: map.defaultWorkflowId,
            entries: entryRecord(map.entries),
          },
          {
            name: body.name,
            description: body.description,
            defaultWorkflowId: body.defaultWorkflowId,
            entries: body.entries ? entryRecord(next.entries) : undefined,
          },
        );
        const remaps = changes.defaultWorkflowId !== undefined || changes.entries !== undefined;
        if (!remaps && (body.statusMapping || body.typeStatusMapping)) {
          return { badStatusMapping: true as const };
        }
        if (Object.keys(changes).length === 0) return { map };
        let statusMigration: Awaited<ReturnType<typeof startMigration>> | null = null;
        let statusMapped = 0;
        if (remaps) {
          const tracks = await tracksUsingMap(trx, ws, map);
          const trackIds = tracks.map((t) => t.id);
          const running = await runningMigration(trx, ws, trackIds);
          if (running !== null) return { migrationRunning: running };
          // Every workflow either version names, in id order, so none is published under it.
          const named = new Set([...workflowsOf(map), ...workflowsOf(next)]);
          for (const workflowId of [...named].sort((a, b) => a - b)) {
            await holdWorkflow(trx, workflowId, 'share');
          }
          const impact = await impactOf(
            trx,
            ws,
            trackIds,
            (_, type) => workflowForType(map, type),
            (_, type) => workflowForType(next, type),
          );
          const plan = planMigration(
            impact,
            statusMappingOf(body.statusMapping, body.typeStatusMapping),
          );
          if (!plan.ok) {
            return 'required' in plan
              ? { statusMappingRequired: plan.required }
              : { badStatusMapping: true as const };
          }
          await trx
            .updateTable('workflow_map')
            .set({ default_workflow_id: next.defaultWorkflowId })
            .where('id', '=', map.id)
            .execute();
          await trx.deleteFrom('workflow_map_entry').where('map_id', '=', map.id).execute();
          if (next.entries.size > 0) {
            await trx
              .insertInto('workflow_map_entry')
              .values(
                [...next.entries].map(([ticket_type_id, workflow_id]) => ({
                  workspace_id: ws,
                  map_id: map.id,
                  ticket_type_id,
                  workflow_id,
                })),
              )
              .execute();
          }
          if (plan.steps.length > 0) {
            statusMigration = await startMigration(
              trx,
              catalog,
              {
                workspaceId: ws,
                userId: access.user.id,
                reason: 'map_change',
                mapId: map.id,
                trackId: map.ownerTrackId,
              },
              plan.steps,
            );
            statusMapped = plan.ticketCount;
          }
        }
        await trx
          .updateTable('workflow_map')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            updated_at: new Date(),
          })
          .where('id', '=', map.id)
          .execute();
        await emit(trx, by(request), {
          type: 'workflow_map.updated',
          subjectId: map.id,
          payload: {
            changes,
            ...(statusMapped > 0 ? { statusMapped } : {}),
            ...(statusMigration ? { statusMigrationId: statusMigration.id } : {}),
          },
        });
        return { map: (await loadMap(trx, ws, map.id)) as WorkflowMap, statusMigration };
      });
      if ('missing' in result) return notFound(reply);
      if ('problem' in result) return invalid(reply, result.problem);
      if ('badStatusMapping' in result) return invalid(reply, 'statusMapping');
      if ('migrationRunning' in result) {
        return reply
          .code(409)
          .send({ error: 'status_migration_running', migrationId: result.migrationRunning });
      }
      if ('statusMappingRequired' in result) {
        return reply
          .code(409)
          .send({ error: 'status_mapping_required', statuses: result.statusMappingRequired });
      }
      return {
        workflowMap: await mapView(db, ws, result.map),
        ...('statusMigration' in result && result.statusMigration
          ? { statusMigration: result.statusMigration }
          : {}),
      };
    } catch (error) {
      if (uniqueViolation(error) === 'workflow_map_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/workflow-maps/:id', async (request, reply) => {
    const access = await mapAccess(request, reply, true);
    if (!access) return reply;
    const ws = request.workspaceId;
    if (access.map.ownerTrackId !== null) return reply.code(409).send({ error: 'owned_by_track' });
    if (access.map.isDefault) return reply.code(409).send({ error: 'default_map' });
    const result = await db.transaction().execute(async (trx) => {
      const map = await loadMap(trx, ws, access.map.id, 'update');
      if (!map) return { missing: true as const };
      const tracks = await tracksUsingMap(trx, ws, map);
      if (tracks.length > 0) return { inUse: tracks };
      await trx.deleteFrom('workflow_map').where('id', '=', map.id).execute();
      await emit(trx, by(request), {
        type: 'workflow_map.deleted',
        subjectId: map.id,
        payload: { name: map.name },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'workflow_map_in_use', tracks: result.inUse });
    }
    return reply.code(204).send();
  });

  /** A track the caller may read the workflows of (WF-002's read-only view), or the refusal. */
  async function readableTrack(request: FastifyRequest, reply: FastifyReply, trackId: number) {
    const held = await request.authz.track(trackId);
    const admin = await isAdmin(request);
    if (!admin && !held.has('view_readonly_workflow') && !held.has('administer_track')) {
      await (held.has('browse_track')
        ? reply.code(403).send({ error: 'forbidden', permission: 'view_readonly_workflow' })
        : notFound(reply));
      return null;
    }
    const track = await db
      .selectFrom('track')
      .select(['id', 'type_set_id', 'mode'])
      .where('id', '=', trackId)
      .where('workspace_id', '=', request.workspaceId)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!track) {
      await notFound(reply);
      return null;
    }
    return track;
  }

  // A track's map, read-only, with the workflow each ticket type it offers uses (WF-001 (3)).
  app.get('/api/v1/tracks/:id/workflow-map', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const track = await readableTrack(request, reply, params.data.id);
    if (!track) return reply;
    const mapId = await trackMapId(db, ws, track.id);
    const map = mapId === undefined ? null : await loadMap(db, ws, mapId);
    if (!map) return notFound(reply);
    const offered =
      track.type_set_id === null
        ? []
        : await db
            .selectFrom('type_set_member as s')
            .innerJoin('ticket_type as t', 't.id', 's.ticket_type_id')
            .select(['t.id', 't.name'])
            .where('s.type_set_id', '=', track.type_set_id)
            .orderBy('s.sort_order')
            .execute();
    const workflows = await namesOf(db, 'workflow', [
      ...workflowsOf(map),
      ...offered.map((t) => workflowForType(map, t.id)),
    ]);
    return {
      workflowMap: await mapView(db, ws, map),
      ticketTypes: offered.map((t) => ({
        ticketType: { id: t.id, name: t.name },
        workflow: named(workflows, workflowForType(map, t.id)),
      })),
    };
  });

  // What switching a shared-mode track to another map would do.
  app.get('/api/v1/tracks/:id/workflow-map/impact', async (request, reply) => {
    if (!(await requireAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = z
      .object({ workflowMapId: z.union([z.literal('default'), id]) })
      .strict()
      .safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const ws = request.workspaceId;
    const track = await db
      .selectFrom('track')
      .select(['id', 'key', 'name', 'mode', 'workflow_map_id'])
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', ws)
      .where('deleted_at', 'is', null)
      .executeTakeFirst();
    if (!track) return notFound(reply);
    if (track.mode === 'local')
      return invalid(reply, 'a local-mode track keeps its own workflow map');
    const fallback = await defaultMapId(db, ws);
    const was = await loadMap(db, ws, track.workflow_map_id ?? fallback);
    const nextId = query.data.workflowMapId === 'default' ? fallback : query.data.workflowMapId;
    const next = await loadMap(db, ws, nextId);
    if (!was || !next || next.ownerTrackId !== null) return invalid(reply, 'workflowMapId');
    const impact = await impactOf(
      db,
      ws,
      [track.id],
      (_, type) => workflowForType(was, type),
      (_, type) => workflowForType(next, type),
    );
    return {
      impact: await impactView(db, impact, [{ id: track.id, key: track.key, name: track.name }]),
    };
  });

  // How far a status migration got (M1-028): for the person who asked, administrators, and the
  // administrators of the track it ran for.
  app.get('/api/v1/workflow-migrations/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const params = z
      .object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/) })
      .safeParse(request.params);
    if (!params.success) return notFound(reply);
    const row = await db
      .selectFrom('workflow_migration')
      .selectAll()
      .where('id', '=', params.data.id)
      .where('workspace_id', '=', request.workspaceId)
      .executeTakeFirst();
    if (!row) return notFound(reply);
    const allowed =
      row.user_id === user.id ||
      (await isAdmin(request)) ||
      (row.track_id !== null && (await request.authz.can('administer_track', row.track_id)));
    if (!allowed) return notFound(reply);
    const steps = await db
      .selectFrom('workflow_migration_step')
      .select(['track_id', 'ticket_type_id', 'from_status_id', 'to_status_id', 'ticket_count'])
      .where('migration_id', '=', row.id)
      .orderBy('track_id')
      .orderBy('ticket_type_id')
      .orderBy('from_status_id')
      .execute();
    return {
      statusMigration: {
        ...migrationView(row),
        steps: steps.map((s) => ({
          trackId: s.track_id,
          ticketTypeId: s.ticket_type_id,
          fromStatusId: s.from_status_id,
          toStatusId: s.to_status_id,
          ticketCount: s.ticket_count,
        })),
      },
    };
  });
}
