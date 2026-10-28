import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import { checkLabels, LABEL_MAX, lockList, rewriteTickets, writeOrder } from '../tickets/fields';

/**
 * The workspace's lists of priorities and close reasons, priority sets, and labels (M1-014;
 * CORE-014, CORE-017; spec 01a sections 1.3 and 1.6).
 *
 * - Everyone signed in reads them; site and configuration administrators change them.
 * - Priorities and close reasons keep a manual order (`PUT .../order` lists every one).
 * - Deleting a value tickets use needs a replacement (CORE-014 (3)): the tickets take it, with
 *   their history, and for a priority so do the priority sets that offered it. A new priority
 *   joins the default priority set.
 * - A priority set chooses which priorities a track offers, and the default for new tickets
 *   (CORE-014 (2)). Tracks without one use the workspace's default set. A ticket keeps a
 *   priority its track stops offering until someone changes it.
 * - Labels are free-form; the vocabulary suggests them as people type (CORE-017 (1)).
 *   Administrators merge labels into one, which also renames one (CORE-017 (2)).
 *
 * Every successful mutation emits exactly one domain event in its transaction (ADR-015).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const name = z.string().trim().min(1).max(255);
const description = z.string().max(2000);
const icon = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, 'an icon name: lower-case letters, digits and hyphens');
const color = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'a colour as #rrggbb')
  .transform((c) => c.toLowerCase());
const unique = <T>(list: readonly T[]) => new Set(list).size === list.length;
const idList = z.array(id).min(1).max(1000).refine(unique, 'each id once');

const priorityFields = {
  name,
  description,
  icon: icon.nullable(),
  color: color.nullable(),
};
const createPriorityBody = z
  .object({
    name,
    description: description.optional(),
    icon: priorityFields.icon.optional(),
    color: priorityFields.color.optional(),
  })
  .strict();
const updatePriorityBody = z.object(priorityFields).partial().strict();
const reasonFields = { name, description };
const createReasonBody = z.object({ name, description: description.optional() }).strict();
const updateReasonBody = z.object(reasonFields).partial().strict();
const deleteQuery = z.object({ replacementId: id.optional() }).strict();

const setFields = {
  name,
  description,
  priorityIds: idList,
  defaultPriorityId: id.nullable(),
};
const createSetBody = z
  .object({
    name,
    description: description.optional(),
    priorityIds: idList,
    defaultPriorityId: setFields.defaultPriorityId.optional(),
  })
  .strict();
const updateSetBody = z
  .object({ ...setFields, isDefault: z.literal(true) })
  .partial()
  .strict();

const labelQuery = z
  .object({
    q: z.string().max(LABEL_MAX).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
const mergeLabelsBody = z
  .object({
    labels: z.array(z.string().min(1).max(LABEL_MAX)).min(1).max(100),
    into: z.string().min(1).max(LABEL_MAX),
  })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;

function uniqueViolation(error: unknown): string | null {
  const e = error as { code?: string; constraint?: string };
  return e.code === '23505' ? (e.constraint ?? '') : null;
}

const invalid = (reply: FastifyReply, detail?: string) =>
  reply.code(400).send({ error: 'invalid_request', ...(detail ? { detail } : {}) });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** Escapes LIKE wildcards so a search for "50%" means those characters. */
const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

function priorityRows(db: Db, workspaceId: number) {
  return db
    .selectFrom('priority')
    .select(['id', 'name', 'description', 'icon', 'color', 'sort_order'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('sort_order')
    .execute();
}
type PriorityRow = Awaited<ReturnType<typeof priorityRows>>[number];
const priorityView = (r: PriorityRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  icon: r.icon,
  color: r.color,
  order: r.sort_order,
});

function reasonRows(db: Db, workspaceId: number) {
  return db
    .selectFrom('close_reason')
    .select(['id', 'name', 'description', 'sort_order'])
    .where('workspace_id', '=', workspaceId)
    .orderBy('sort_order')
    .execute();
}
type ReasonRow = Awaited<ReturnType<typeof reasonRows>>[number];
const reasonView = (r: ReasonRow) => ({
  id: r.id,
  name: r.name,
  description: r.description,
  order: r.sort_order,
});

/** Priority sets with their priorities in the workspace's order and the tracks using them. */
async function setViews(db: Db, workspaceId: number, setId?: number) {
  let query = db
    .selectFrom('priority_set as s')
    .select([
      's.id',
      's.name',
      's.description',
      's.is_default',
      's.default_priority_id',
      (eb) =>
        eb
          .selectFrom('track')
          .select(sql<string>`count(*)`.as('n'))
          .where((w) =>
            w.or([
              w('track.priority_set_id', '=', w.ref('s.id')),
              w.and([w('track.priority_set_id', 'is', null), w('s.is_default', '=', true)]),
            ]),
          )
          .where('track.workspace_id', '=', workspaceId)
          .as('track_count'),
    ])
    .where('s.workspace_id', '=', workspaceId)
    .orderBy('s.is_default', 'desc')
    .orderBy(sql`lower(s.name)`)
    .orderBy('s.id');
  if (setId !== undefined) query = query.where('s.id', '=', setId);
  const sets = await query.execute();
  if (sets.length === 0) return [];
  const members = await db
    .selectFrom('priority_set_member as m')
    .innerJoin('priority as p', 'p.id', 'm.priority_id')
    .select(['m.priority_set_id', 'm.priority_id'])
    .where(
      'm.priority_set_id',
      'in',
      sets.map((s) => s.id),
    )
    .orderBy('p.sort_order')
    .execute();
  return sets.map((s) => ({
    id: s.id,
    name: s.name,
    description: s.description,
    isDefault: s.is_default,
    priorityIds: members.filter((m) => m.priority_set_id === s.id).map((m) => m.priority_id),
    defaultPriorityId: s.default_priority_id,
    trackCount: Number(s.track_count ?? 0),
  }));
}

/** Priorities of the workspace among `ids`. */
async function knownPriorities(db: Db, workspaceId: number, ids: readonly number[]) {
  const rows = await db
    .selectFrom('priority')
    .select('id')
    .where('workspace_id', '=', workspaceId)
    .where('id', 'in', [...ids])
    .execute();
  return rows.length === new Set(ids).size;
}

export function registerPriorityRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });
  const configAdmin = (request: FastifyRequest, reply: FastifyReply) =>
    requireGlobal(request, reply, 'site_admin', 'configuration_admin');

  /**
   * A list's new order: `ids` must name every value once. Answers false when it does not.
   */
  async function reorder(
    trx: Transaction<Database>,
    workspaceId: number,
    table: 'priority' | 'close_reason',
    ids: readonly number[],
  ): Promise<boolean> {
    await lockList(trx, workspaceId, table);
    const rows = await trx
      .selectFrom(table)
      .select('id')
      .where('workspace_id', '=', workspaceId)
      .execute();
    const all = new Set(rows.map((r) => r.id));
    if (all.size !== ids.length || ids.some((i) => !all.has(i))) return false;
    await writeOrder(trx, table, ids);
    return true;
  }

  // Priorities (CORE-014)

  app.get('/api/v1/priorities', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { priorities: (await priorityRows(db, request.workspaceId)).map(priorityView) };
  });

  app.post('/api/v1/priorities', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = createPriorityBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        await lockList(trx, ws, 'priority');
        const last = await trx
          .selectFrom('priority')
          .select(sql<number>`coalesce(max(sort_order), 0)`.as('n'))
          .where('workspace_id', '=', ws)
          .executeTakeFirstOrThrow();
        const created = await trx
          .insertInto('priority')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            icon: body.icon ?? null,
            color: body.color ?? null,
            sort_order: Number(last.n) + 1,
          })
          .returning(['id', 'name', 'description', 'icon', 'color', 'sort_order'])
          .executeTakeFirstOrThrow();
        // The default set offers every priority unless an administrator narrows it.
        await sql`
          INSERT INTO priority_set_member (workspace_id, priority_set_id, priority_id)
          SELECT ${ws}, id, ${created.id} FROM priority_set
           WHERE workspace_id = ${ws} AND is_default`.execute(trx);
        await emit(trx, by(request), {
          type: 'priority.created',
          subjectId: created.id,
          payload: { name: created.name },
        });
        return created;
      });
      return reply.code(201).send({ priority: priorityView(row) });
    } catch (error) {
      if (uniqueViolation(error) === 'priority_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.put('/api/v1/priorities/order', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = z.object({ priorityIds: idList }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ids = parsed.data.priorityIds;
    const ws = request.workspaceId;
    const done = await db.transaction().execute(async (trx) => {
      if (!(await reorder(trx, ws, 'priority', ids))) return false;
      await emit(trx, by(request), {
        type: 'priority.reordered',
        subjectId: ws,
        payload: { priorityIds: ids },
      });
      return true;
    });
    if (!done) return invalid(reply, 'priorityIds must list every priority once');
    return { priorities: (await priorityRows(db, ws)).map(priorityView) };
  });

  app.patch('/api/v1/priorities/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updatePriorityBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('priority')
          .select(['id', 'name', 'description', 'icon', 'color', 'sort_order'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', ws)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current) return null;
        const changes = diff<Record<string, unknown>>(
          {
            name: current.name,
            description: current.description,
            icon: current.icon,
            color: current.color,
          },
          body,
        );
        if (Object.keys(changes).length === 0) return current;
        const updated = await trx
          .updateTable('priority')
          .set({ ...body, updated_at: new Date() })
          .where('id', '=', current.id)
          .returning(['id', 'name', 'description', 'icon', 'color', 'sort_order'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'priority.updated',
          subjectId: current.id,
          payload: { changes },
        });
        return updated;
      });
      if (!row) return notFound(reply);
      return { priority: priorityView(row) };
    } catch (error) {
      if (uniqueViolation(error) === 'priority_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // The replacement takes its place on tickets and in priority sets (CORE-014 (3)).
  app.delete('/api/v1/priorities/:id', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = deleteQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const priorityId = params.data.id;
    const replacementId = query.data.replacementId ?? null;
    if (replacementId === priorityId) return invalid(reply, 'replacementId');
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      await lockList(trx, ws, 'priority');
      // The value first, then its tickets: no ticket write can start pointing at it now.
      const held = await trx
        .selectFrom('priority')
        .select(['id', 'name'])
        .where('workspace_id', '=', ws)
        .where('id', 'in', replacementId === null ? [priorityId] : [priorityId, replacementId])
        .orderBy('id')
        .forUpdate()
        .execute();
      const current = held.find((p) => p.id === priorityId);
      if (!current) return { missing: true as const };
      if (replacementId !== null && !held.some((p) => p.id === replacementId)) {
        return { badReplacement: true as const };
      }
      const tickets = await trx
        .selectFrom('ticket')
        .select('id')
        .where('priority_id', '=', priorityId)
        .execute();
      if (tickets.length > 0 && replacementId === null) {
        return { inUse: tickets.length };
      }
      const ticketCount = await rewriteTickets(
        trx,
        ws,
        user.id,
        tickets.map((t) => t.id),
        async (ids) => {
          await trx
            .updateTable('ticket')
            .set({ priority_id: replacementId })
            .where('id', 'in', ids)
            .execute();
        },
      );
      // Sets that offered it offer the replacement, and default to it where it was theirs.
      if (replacementId !== null) {
        await sql`
          INSERT INTO priority_set_member (workspace_id, priority_set_id, priority_id)
          SELECT workspace_id, priority_set_id, ${replacementId} FROM priority_set_member
           WHERE priority_id = ${priorityId}
          ON CONFLICT DO NOTHING`.execute(trx);
      }
      await trx
        .updateTable('priority_set')
        .set({ default_priority_id: replacementId, updated_at: new Date() })
        .where('default_priority_id', '=', priorityId)
        .execute();
      await trx.deleteFrom('priority_set_member').where('priority_id', '=', priorityId).execute();
      await trx.deleteFrom('priority').where('id', '=', priorityId).execute();
      const rest = await priorityRows(trx, ws);
      await writeOrder(
        trx,
        'priority',
        rest.map((p) => p.id),
      );
      await emit(trx, by(request), {
        type: 'priority.deleted',
        subjectId: priorityId,
        payload: { name: current.name, replacementId, ticketCount },
      });
      return { ticketCount };
    });
    if ('missing' in result) return notFound(reply);
    if ('badReplacement' in result) return invalid(reply, 'replacementId');
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'in_use', ticketCount: result.inUse });
    }
    return reply.code(204).send();
  });

  // Priority sets (CORE-014 (2))

  app.get('/api/v1/priority-sets', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { prioritySets: await setViews(db, request.workspaceId) };
  });

  app.post('/api/v1/priority-sets', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = createSetBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const defaultId = body.defaultPriorityId ?? null;
    if (defaultId !== null && !body.priorityIds.includes(defaultId)) {
      return invalid(reply, 'defaultPriorityId must be one of priorityIds');
    }
    if (!(await knownPriorities(db, ws, body.priorityIds))) return invalid(reply, 'priorityIds');
    try {
      const setId = await db.transaction().execute(async (trx) => {
        const row = await trx
          .insertInto('priority_set')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            default_priority_id: defaultId,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await trx
          .insertInto('priority_set_member')
          .values(
            body.priorityIds.map((priority_id) => ({
              workspace_id: ws,
              priority_set_id: row.id,
              priority_id,
            })),
          )
          .execute();
        await emit(trx, by(request), {
          type: 'priority_set.created',
          subjectId: row.id,
          payload: { name: body.name, priorityIds: body.priorityIds, defaultPriorityId: defaultId },
        });
        return row.id;
      });
      const [view] = await setViews(db, ws, setId);
      return reply.code(201).send({ prioritySet: view });
    } catch (error) {
      if (uniqueViolation(error) === 'priority_set_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.patch('/api/v1/priority-sets/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateSetBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    const setId = params.data.id;
    if (body.priorityIds && !(await knownPriorities(db, ws, body.priorityIds))) {
      return invalid(reply, 'priorityIds');
    }
    try {
      const result = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('priority_set')
          .select(['id', 'name', 'description', 'is_default', 'default_priority_id'])
          .where('id', '=', setId)
          .where('workspace_id', '=', ws)
          .forUpdate()
          .executeTakeFirst();
        if (!current) return { missing: true as const };
        const members = await trx
          .selectFrom('priority_set_member as m')
          .innerJoin('priority as p', 'p.id', 'm.priority_id')
          .select('m.priority_id')
          .where('m.priority_set_id', '=', setId)
          .orderBy('p.sort_order')
          .execute();
        const was = members.map((m) => m.priority_id);
        const priorityIds = body.priorityIds ?? was;
        const defaultId =
          body.defaultPriorityId !== undefined
            ? body.defaultPriorityId
            : current.default_priority_id !== null &&
                priorityIds.includes(current.default_priority_id)
              ? current.default_priority_id
              : null;
        if (defaultId !== null && !priorityIds.includes(defaultId)) {
          return { badDefault: true as const };
        }
        const sameMembers =
          priorityIds.length === was.length && priorityIds.every((p) => was.includes(p));
        const changes = diff<Record<string, unknown>>(
          {
            name: current.name,
            description: current.description,
            priorityIds: [...was].sort((a, b) => a - b),
            defaultPriorityId: current.default_priority_id,
            isDefault: current.is_default,
          },
          {
            name: body.name,
            description: body.description,
            priorityIds: sameMembers ? undefined : [...priorityIds].sort((a, b) => a - b),
            defaultPriorityId: defaultId,
            isDefault: body.isDefault,
          },
        );
        if (Object.keys(changes).length === 0) return { done: true as const };
        if (changes.isDefault) {
          // The default set moves here; tracks that used the old one by default now use this.
          await trx
            .updateTable('priority_set')
            .set({ is_default: false, updated_at: new Date() })
            .where('workspace_id', '=', ws)
            .where('is_default', '=', true)
            .execute();
        }
        await trx
          .updateTable('priority_set')
          .set({
            ...(body.name !== undefined ? { name: body.name } : {}),
            ...(body.description !== undefined ? { description: body.description } : {}),
            ...(changes.isDefault ? { is_default: true } : {}),
            default_priority_id: defaultId,
            updated_at: new Date(),
          })
          .where('id', '=', setId)
          .execute();
        if (!sameMembers) {
          await trx
            .deleteFrom('priority_set_member')
            .where('priority_set_id', '=', setId)
            .where('priority_id', 'not in', priorityIds)
            .execute();
          await trx
            .insertInto('priority_set_member')
            .values(
              priorityIds.map((priority_id) => ({
                workspace_id: ws,
                priority_set_id: setId,
                priority_id,
              })),
            )
            .onConflict((oc) => oc.doNothing())
            .execute();
        }
        await emit(trx, by(request), {
          type: 'priority_set.updated',
          subjectId: setId,
          payload: { changes },
        });
        return { done: true as const };
      });
      if ('missing' in result) return notFound(reply);
      if ('badDefault' in result) {
        return invalid(reply, 'defaultPriorityId must be one of priorityIds');
      }
      const [view] = await setViews(db, ws, setId);
      return { prioritySet: view };
    } catch (error) {
      if (uniqueViolation(error) === 'priority_set_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  // Tracks that used the set go back to the default set.
  app.delete('/api/v1/priority-sets/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const setId = params.data.id;
    const result = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('priority_set')
        .select(['name', 'is_default'])
        .where('id', '=', setId)
        .where('workspace_id', '=', ws)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { missing: true as const };
      if (current.is_default) return { isDefault: true as const };
      const tracks = await trx
        .updateTable('track')
        .set({ priority_set_id: null, updated_at: new Date() })
        .where('priority_set_id', '=', setId)
        .returning('id')
        .execute();
      await trx.deleteFrom('priority_set').where('id', '=', setId).execute();
      await emit(trx, by(request), {
        type: 'priority_set.deleted',
        subjectId: setId,
        payload: { name: current.name, trackCount: tracks.length },
      });
      return { done: true as const };
    });
    if ('missing' in result) return notFound(reply);
    if ('isDefault' in result) return reply.code(409).send({ error: 'default_set' });
    return reply.code(204).send();
  });

  // Close reasons (CORE-014)

  app.get('/api/v1/close-reasons', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    return { closeReasons: (await reasonRows(db, request.workspaceId)).map(reasonView) };
  });

  app.post('/api/v1/close-reasons', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = createReasonBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        await lockList(trx, ws, 'close_reason');
        const last = await trx
          .selectFrom('close_reason')
          .select(sql<number>`coalesce(max(sort_order), 0)`.as('n'))
          .where('workspace_id', '=', ws)
          .executeTakeFirstOrThrow();
        const created = await trx
          .insertInto('close_reason')
          .values({
            workspace_id: ws,
            name: body.name,
            description: body.description ?? '',
            sort_order: Number(last.n) + 1,
          })
          .returning(['id', 'name', 'description', 'sort_order'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'close_reason.created',
          subjectId: created.id,
          payload: { name: created.name },
        });
        return created;
      });
      return reply.code(201).send({ closeReason: reasonView(row) });
    } catch (error) {
      if (uniqueViolation(error) === 'close_reason_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.put('/api/v1/close-reasons/order', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const parsed = z.object({ closeReasonIds: idList }).strict().safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ids = parsed.data.closeReasonIds;
    const ws = request.workspaceId;
    const done = await db.transaction().execute(async (trx) => {
      if (!(await reorder(trx, ws, 'close_reason', ids))) return false;
      await emit(trx, by(request), {
        type: 'close_reason.reordered',
        subjectId: ws,
        payload: { closeReasonIds: ids },
      });
      return true;
    });
    if (!done) return invalid(reply, 'closeReasonIds must list every close reason once');
    return { closeReasons: (await reasonRows(db, ws)).map(reasonView) };
  });

  app.patch('/api/v1/close-reasons/:id', async (request, reply) => {
    if (!(await configAdmin(request, reply))) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const parsed = updateReasonBody.safeParse(request.body);
    if (!params.success || !parsed.success) return invalid(reply);
    const body = parsed.data;
    const ws = request.workspaceId;
    try {
      const row = await db.transaction().execute(async (trx) => {
        const current = await trx
          .selectFrom('close_reason')
          .select(['id', 'name', 'description', 'sort_order'])
          .where('id', '=', params.data.id)
          .where('workspace_id', '=', ws)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!current) return null;
        const changes = diff<Record<string, unknown>>(
          { name: current.name, description: current.description },
          body,
        );
        if (Object.keys(changes).length === 0) return current;
        const updated = await trx
          .updateTable('close_reason')
          .set({ ...body, updated_at: new Date() })
          .where('id', '=', current.id)
          .returning(['id', 'name', 'description', 'sort_order'])
          .executeTakeFirstOrThrow();
        await emit(trx, by(request), {
          type: 'close_reason.updated',
          subjectId: current.id,
          payload: { changes },
        });
        return updated;
      });
      if (!row) return notFound(reply);
      return { closeReason: reasonView(row) };
    } catch (error) {
      if (uniqueViolation(error) === 'close_reason_name_idx') {
        return reply.code(409).send({ error: 'name_taken' });
      }
      throw error;
    }
  });

  app.delete('/api/v1/close-reasons/:id', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    const query = deleteQuery.safeParse(request.query);
    if (!params.success || !query.success) return invalid(reply);
    const reasonId = params.data.id;
    const replacementId = query.data.replacementId ?? null;
    if (replacementId === reasonId) return invalid(reply, 'replacementId');
    const ws = request.workspaceId;
    const result = await db.transaction().execute(async (trx) => {
      await lockList(trx, ws, 'close_reason');
      const held = await trx
        .selectFrom('close_reason')
        .select(['id', 'name'])
        .where('workspace_id', '=', ws)
        .where('id', 'in', replacementId === null ? [reasonId] : [reasonId, replacementId])
        .orderBy('id')
        .forUpdate()
        .execute();
      const current = held.find((r) => r.id === reasonId);
      if (!current) return { missing: true as const };
      if (replacementId !== null && !held.some((r) => r.id === replacementId)) {
        return { badReplacement: true as const };
      }
      const tickets = await trx
        .selectFrom('ticket')
        .select('id')
        .where('close_reason_id', '=', reasonId)
        .execute();
      if (tickets.length > 0 && replacementId === null) return { inUse: tickets.length };
      const ticketCount = await rewriteTickets(
        trx,
        ws,
        user.id,
        tickets.map((t) => t.id),
        async (ids) => {
          await trx
            .updateTable('ticket')
            .set({ close_reason_id: replacementId })
            .where('id', 'in', ids)
            .execute();
        },
      );
      await trx.deleteFrom('close_reason').where('id', '=', reasonId).execute();
      const rest = await reasonRows(trx, ws);
      await writeOrder(
        trx,
        'close_reason',
        rest.map((r) => r.id),
      );
      await emit(trx, by(request), {
        type: 'close_reason.deleted',
        subjectId: reasonId,
        payload: { name: current.name, replacementId, ticketCount },
      });
      return { ticketCount };
    });
    if ('missing' in result) return notFound(reply);
    if ('badReplacement' in result) return invalid(reply, 'replacementId');
    if ('inUse' in result) {
      return reply.code(409).send({ error: 'in_use', ticketCount: result.inUse });
    }
    return reply.code(204).send();
  });

  // Labels (CORE-017)

  // Suggestions as someone types: labels that start with what they typed, ignoring case.
  app.get('/api/v1/labels', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = labelQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const q = parsed.data;
    let query = db
      .selectFrom('label')
      .select('name')
      .where('workspace_id', '=', request.workspaceId);
    const typed = q.q?.trim() ?? '';
    if (typed !== '') {
      query = query.where(sql<boolean>`lower(name) LIKE ${`${likeEscape(typed.toLowerCase())}%`}`);
    }
    const rows = await query.orderBy(sql`lower(name)`).orderBy('name').limit(q.limit).execute();
    return { labels: rows.map((r) => r.name) };
  });

  // Every ticket with one of `labels` gets `into` in its place, once (CORE-017 (2)).
  app.post('/api/v1/labels/merge', async (request, reply) => {
    const user = await configAdmin(request, reply);
    if (!user) return reply;
    const parsed = mergeLabelsBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const into = checkLabels([parsed.data.into]);
    const from = checkLabels(parsed.data.labels);
    if (!into.ok || into.labels.length !== 1) return invalid(reply, 'into');
    if (!from.ok) return invalid(reply, 'labels');
    const target = into.labels[0] as string;
    const labels = from.labels.filter((l) => l !== target);
    if (labels.length === 0) return invalid(reply, 'labels');
    const ws = request.workspaceId;
    const ticketCount = await db.transaction().execute(async (trx) => {
      const tickets = await trx
        .selectFrom('ticket')
        .select('id')
        .where('workspace_id', '=', ws)
        .where(sql<boolean>`labels && ${labels}::text[]`)
        .execute();
      const count = await rewriteTickets(
        trx,
        ws,
        user.id,
        tickets.map((t) => t.id),
        async (ids) => {
          // Each label keeps the place of its first occurrence.
          await sql`
            UPDATE ticket SET labels = coalesce((
              SELECT array_agg(l ORDER BY first) FROM (
                SELECT l, min(o) AS first FROM (
                  SELECT CASE WHEN x = ANY(${labels}::text[]) THEN ${target} ELSE x END AS l, o
                    FROM unnest(ticket.labels) WITH ORDINALITY AS u (x, o)
                ) named GROUP BY l
              ) firsts), '{}')
             WHERE id = ANY(${ids}::int[])`.execute(trx);
        },
      );
      await trx
        .deleteFrom('label')
        .where('workspace_id', '=', ws)
        .where('name', 'in', labels)
        .execute();
      await trx
        .insertInto('label')
        .values({ workspace_id: ws, name: target })
        .onConflict((oc) => oc.doNothing())
        .execute();
      await emit(trx, by(request), {
        type: 'label.merged',
        subjectId: ws,
        payload: { labels, into: target, ticketCount: count },
      });
      return count;
    });
    return { into: target, labels, ticketCount };
  });
}
