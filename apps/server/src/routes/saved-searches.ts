import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { boardsLeftByQuery } from '../boards/one-per-track';
import { diff, emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { DEFAULT_QUERY_TIMEOUT_MS, prepareSearch } from '../search/run';
import { savedSearchVisible } from '../search/saved';
import { nextRun, parseCron, ScheduleError, validTimeZone } from '../search/schedule';
import {
  checkShares,
  SAVED_SEARCH_SHARES,
  shareInput,
  shareKey,
  sharesOf,
  writeShares,
} from '../sharing/shares';
import { searchPerson, searchRefusal, searchScope } from './search';
import { decodeSortCursor, encodeSortCursor, sortCursorParam } from './sort-cursor';

/**
 * Saved searches (M1-063; QRY-011, QRY-012; ADR-053).
 *
 * - `GET /api/v1/saved-searches` lists those the person sees (`?filter=mine|starred`, `?q=`
 *   by name); `POST` saves one; `GET`, `PATCH` and `DELETE /api/v1/saved-searches/:id` read,
 *   change and remove one. A saved search is seen by its owner and those its shares reach
 *   (`search/saved.ts`); one the person cannot see answers 404 like one that does not exist.
 *   Anonymous visitors read public ones. Its owner changes and deletes it; site
 *   administrators may too, and only they give it to another owner. Sharing it with anyone
 *   needs the global permission "Share dashboards and saved searches".
 * - The query is checked on save as its owner would run it, saved-search references included:
 *   one that leads back to itself is refused (QRY-011 (2)). Running a saved search is running
 *   its query (`/api/v1/search`) as the person, so nobody sees a ticket through a saved search
 *   that they could not find with the query themselves.
 * - A track's board may stand on a saved search; its query then has to stay inside that track
 *   (ADR-116), and a change that would take the board elsewhere is refused
 *   (`409 board_outside_track`, naming the boards).
 * - A saved search an import could not translate (M1-094) keeps the source's text and says why
 *   in `importProblem`; saving a query clears it.
 * - `PUT` and `DELETE /api/v1/saved-searches/:id/star` star and unstar it for the person.
 * - `GET` and `POST /api/v1/saved-searches/:id/subscriptions` and
 *   `DELETE /api/v1/saved-searches/:id/subscriptions/:subscriptionId`: the person subscribes
 *   themselves, or a group with "Manage group search subscriptions" (QRY-012). The mailer is
 *   `search/subscriptions.ts`.
 *
 * Each write emits one `saved_search.*` event in its transaction.
 */
const MAX_INT = 2_147_483_647;
const idNum = z.number().int().positive().max(MAX_INT);
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const subParam = z
  .object({
    id: z.coerce.number().int().positive().max(MAX_INT),
    subscriptionId: z.coerce.number().int().positive().max(MAX_INT),
  })
  .strict();
/**
 * A page of saved searches by name, ignoring case, then id (T-310). The first page holds 500
 * at most as the list always did; `cursor` (or `after`, as the web app sends it) is the `next`
 * of the page before.
 */
export const listQuery = z
  .object({
    filter: z.enum(['visible', 'mine', 'starred']).default('visible'),
    q: z.string().max(255).optional(),
    cursor: sortCursorParam.optional(),
    after: sortCursorParam.meta({ description: 'The same as `cursor`.' }).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(500),
  })
  .strict();

const columnsInput = z.array(z.string().min(1).max(200)).max(100).nullable();
export const createBody = z
  .object({
    name: z.string().trim().min(1).max(255),
    description: z.string().max(4000).optional(),
    query: z.string().max(100_000),
    columns: columnsInput.optional(),
    shares: z.array(shareInput).max(100).optional(),
  })
  .strict();
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().max(4000).optional(),
    query: z.string().max(100_000).optional(),
    columns: columnsInput.optional(),
    shares: z.array(shareInput).max(100).optional(),
    /** Site administrators: give the saved search to another person. */
    ownerId: idNum.optional(),
    version: z.number().int().positive().optional(),
  })
  .strict();
const subscribeBody = z
  .object({
    /** A group to send to; without it, the person subscribes themselves. */
    groupId: idNum.optional(),
    schedule: z.enum(['daily', 'weekly', 'monthly', 'cron']),
    hour: z.number().int().min(0).max(23).default(8),
    minute: z.number().int().min(0).max(59).default(0),
    /** 0 is Sunday. */
    weekday: z.number().int().min(0).max(6).optional(),
    dayOfMonth: z.number().int().min(1).max(28).optional(),
    cron: z.string().min(1).max(200).optional(),
    timeZone: z.string().min(1).max(100).optional(),
    onlyIfResults: z.boolean().default(false),
  })
  .strict();

type Db = Kysely<Database> | Transaction<Database>;
type Row = {
  id: number;
  name: string;
  description: string;
  query: string;
  columns: JsonValue | null;
  import_problem: string | null;
  owner_id: number;
  owner_name: string;
  version: number;
  created_at: Date;
  updated_at: Date;
};

const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });
const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

export function registerSavedSearchRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: { timeoutMs?: number } = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  const rows = (trx: Db, ws: number) =>
    trx
      .selectFrom('saved_search as s')
      .innerJoin('app_user as o', 'o.id', 's.owner_id')
      .select([
        's.id',
        's.name',
        's.description',
        's.query',
        's.columns',
        's.import_problem',
        's.owner_id',
        'o.name as owner_name',
        's.version',
        's.created_at',
        's.updated_at',
      ])
      .where('s.workspace_id', '=', ws);

  async function view(request: FastifyRequest, list: Row[]) {
    const userId = request.user?.id ?? null;
    const shares = await sharesOf(
      db,
      SAVED_SEARCH_SHARES,
      list.map((r) => r.id),
    );
    const starred =
      userId === null || list.length === 0
        ? new Set<number>()
        : new Set(
            (
              await db
                .selectFrom('saved_search_star')
                .select('saved_search_id')
                .where('user_id', '=', userId)
                .where(
                  'saved_search_id',
                  'in',
                  list.map((r) => r.id),
                )
                .execute()
            ).map((r) => r.saved_search_id),
          );
    const admin = userId !== null && (await request.authz.isSiteAdmin());
    return list.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      query: r.query,
      columns: r.columns,
      // Why a query an import brought does not run here (M1-094); null for every other one.
      importProblem: r.import_problem,
      owner: { id: r.owner_id, name: r.owner_name },
      shares: shares.get(r.id) ?? [],
      starred: starred.has(r.id),
      editable: userId !== null && (r.owner_id === userId || admin),
      version: r.version,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    }));
  }

  /** The saved search when the person sees it (site administrators see every one). */
  async function visible(request: FastifyRequest, id: number): Promise<Row | undefined> {
    const userId = request.user?.id ?? null;
    const ws = request.workspaceId;
    const admin = userId !== null && (await request.authz.isSiteAdmin());
    let q = rows(db, ws).where('s.id', '=', id);
    if (!admin) q = q.where(savedSearchVisible(ws, userId));
    return q.executeTakeFirst();
  }

  async function mayManage(request: FastifyRequest, row: Row): Promise<boolean> {
    const userId = request.user?.id ?? null;
    if (userId === null) return false;
    return row.owner_id === userId || (await request.authz.isSiteAdmin());
  }

  /**
   * Checks the query as the person would run it; true when it was refused and answered (a
   * reply is thenable, so it is never returned from an async function).
   */
  async function refuseQuery(
    request: FastifyRequest,
    reply: FastifyReply,
    query: string,
    self?: { id: number; name: string },
  ): Promise<boolean> {
    const { ws, filter, catalog, catalogue } = await searchScope(db, catalogs, request, false);
    try {
      await prepareSearch({
        db,
        workspaceId: ws,
        catalog,
        catalogue,
        filter,
        q: query,
        ...searchPerson(request),
        ...(self ? { savedSearch: self } : {}),
      });
      return false;
    } catch (error) {
      await searchRefusal(reply, error, timeoutMs);
      return true;
    }
  }

  const nameTaken = async (ws: number, ownerId: number, name: string, except?: number) => {
    let q = db
      .selectFrom('saved_search')
      .select('id')
      .where('workspace_id', '=', ws)
      .where('owner_id', '=', ownerId)
      .where(sql<boolean>`lower(name) = lower(${name})`);
    if (except !== undefined) q = q.where('id', '!=', except);
    return Boolean(await q.executeTakeFirst());
  };

  app.get('/api/v1/saved-searches', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    let q = rows(db, ws).where(savedSearchVisible(ws, user.id));
    if (parsed.data.filter === 'mine') q = q.where('s.owner_id', '=', user.id);
    if (parsed.data.filter === 'starred') {
      q = q.where(
        sql<boolean>`EXISTS (SELECT 1 FROM saved_search_star st
          WHERE st.saved_search_id = s.id AND st.user_id = ${user.id})`,
      );
    }
    const text = parsed.data.q?.trim();
    if (text) {
      q = q.where(sql<boolean>`strpos(lower(s.name), lower(${text})) > 0`);
    }
    const { limit } = parsed.data;
    const after = parsed.data.cursor ?? parsed.data.after;
    const start = after === undefined ? null : decodeSortCursor(after);
    if (start) {
      q = q.where(sql<boolean>`(lower(s.name), s.id) > (${start[0]}::text, ${start[1]}::int)`);
    }
    const list = await q
      .select(sql<string>`lower(s.name)`.as('sort_name'))
      .orderBy(sql`lower(s.name)`)
      .orderBy('s.id')
      .limit(limit + 1)
      .execute();
    const more = list.length > limit;
    if (more) list.length = limit;
    const last = list[list.length - 1];
    const next = more && last ? encodeSortCursor(last.sort_name, last.id) : null;
    return { savedSearches: await view(request, list), next };
  });

  app.post('/api/v1/saved-searches', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const shares = body.shares ?? [];
    const checked = await checkShares(db, request, shares);
    if (checked.forbidden) {
      return reply.code(403).send({ error: 'forbidden', permission: 'share_saved_searches' });
    }
    if (Object.keys(checked.fields).length > 0) return invalidFields(reply, checked.fields);
    if (await nameTaken(ws, user.id, body.name)) return invalidFields(reply, { name: 'taken' });
    if (await refuseQuery(request, reply, body.query)) return reply;
    const id = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('saved_search')
        .values({
          workspace_id: ws,
          owner_id: user.id,
          name: body.name,
          description: body.description ?? '',
          query: body.query,
          columns: body.columns ? JSON.stringify(body.columns) : null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await writeShares(trx, SAVED_SEARCH_SHARES, ws, row.id, shares);
      await emit(trx, by(request), {
        type: 'saved_search.created',
        subjectId: row.id,
        payload: { name: body.name, query: body.query, shares: shares.map((s) => s.scope) },
      });
      return row.id;
    });
    const row = await rows(db, ws).where('s.id', '=', id).executeTakeFirstOrThrow();
    return reply.code(201).send({ savedSearch: (await view(request, [row]))[0] });
  });

  app.get('/api/v1/saved-searches/:id', async (request, reply) => {
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    return { savedSearch: (await view(request, [row]))[0] };
  });

  app.patch('/api/v1/saved-searches/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = updateBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await mayManage(request, row))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'edit_saved_search' });
    }
    if (body.ownerId !== undefined && body.ownerId !== row.owner_id) {
      if (!(await request.authz.isSiteAdmin())) {
        return reply.code(403).send({ error: 'forbidden', permission: 'site_admin' });
      }
      const owner = await db
        .selectFrom('app_user')
        .select('id')
        .where('id', '=', body.ownerId)
        .where('workspace_id', '=', ws)
        .where('deactivated_at', 'is', null)
        .executeTakeFirst();
      if (!owner) return invalidFields(reply, { ownerId: 'not_found' });
    }
    const ownerId = body.ownerId ?? row.owner_id;
    const name = body.name ?? row.name;
    if (
      (body.name !== undefined || ownerId !== row.owner_id) &&
      (await nameTaken(ws, ownerId, name, row.id))
    ) {
      return invalidFields(reply, { name: 'taken' });
    }
    const sharesBefore = (await sharesOf(db, SAVED_SEARCH_SHARES, [row.id])).get(row.id) ?? [];
    if (body.shares !== undefined) {
      const before = new Set(sharesBefore.map(shareKey));
      const added = body.shares.filter((s) => !before.has(shareKey(s)));
      const checked = await checkShares(db, request, added);
      if (checked.forbidden) {
        return reply.code(403).send({ error: 'forbidden', permission: 'share_saved_searches' });
      }
      const dup = body.shares.map(shareKey);
      if (new Set(dup).size !== dup.length) checked.fields.shares = 'duplicate';
      if (Object.keys(checked.fields).length > 0) return invalidFields(reply, checked.fields);
    }
    if (body.query !== undefined) {
      if (await refuseQuery(request, reply, body.query, { id: row.id, name })) return reply;
      const left = await boardsLeftByQuery(db, ws, row.id, body.query);
      if (left.length > 0) {
        return reply.code(409).send({ error: 'board_outside_track', boards: left });
      }
    }
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('saved_search')
        .select('version')
        .where('id', '=', row.id)
        .forUpdate()
        .executeTakeFirst();
      if (!current) return { missing: true as const };
      if (body.version !== undefined && body.version !== current.version) {
        return { conflict: current.version };
      }
      const before = {
        name: row.name,
        description: row.description,
        query: row.query,
        columns: row.columns,
        ownerId: row.owner_id,
        shares: sharesBefore.map(shareKey).sort(),
      };
      const after = {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
        ...(body.query !== undefined ? { query: body.query } : {}),
        ...(body.columns !== undefined ? { columns: body.columns } : {}),
        ...(body.ownerId !== undefined ? { ownerId: body.ownerId } : {}),
        ...(body.shares !== undefined ? { shares: body.shares.map(shareKey).sort() } : {}),
      };
      const changes = diff(before as Record<string, unknown>, after as Record<string, unknown>);
      if (Object.keys(changes).length === 0) return { unchanged: true as const };
      await trx
        .updateTable('saved_search')
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.description !== undefined ? { description: body.description } : {}),
          ...(body.query !== undefined ? { query: body.query, import_problem: null } : {}),
          ...(body.columns !== undefined
            ? { columns: body.columns === null ? null : JSON.stringify(body.columns) }
            : {}),
          ...(body.ownerId !== undefined ? { owner_id: body.ownerId } : {}),
          version: current.version + 1,
          updated_at: new Date(),
        })
        .where('id', '=', row.id)
        .execute();
      if (body.shares !== undefined)
        await writeShares(trx, SAVED_SEARCH_SHARES, ws, row.id, body.shares);
      await emit(trx, by(request), {
        type: 'saved_search.updated',
        subjectId: row.id,
        payload: { changes },
      });
      return { updated: true as const };
    });
    if ('missing' in outcome) return notFound(reply);
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    const fresh = await rows(db, ws).where('s.id', '=', row.id).executeTakeFirstOrThrow();
    return { savedSearch: (await view(request, [fresh]))[0] };
  });

  app.delete('/api/v1/saved-searches/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    if (!(await mayManage(request, row))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'edit_saved_search' });
    }
    const boards = await db
      .selectFrom('board')
      .select(['id', 'name'])
      .where('saved_search_id', '=', row.id)
      .orderBy('id')
      .execute();
    if (boards.length > 0) {
      return reply.code(409).send({ error: 'in_use', boards: boards.map((b) => b.id) });
    }
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('saved_search').where('id', '=', row.id).execute();
      await emit(trx, by(request), {
        type: 'saved_search.deleted',
        subjectId: row.id,
        payload: { name: row.name },
      });
    });
    return reply.code(204).send();
  });

  for (const method of ['put', 'delete'] as const) {
    app[method]('/api/v1/saved-searches/:id/star', async (request, reply) => {
      const user = requireUser(request, reply);
      if (!user) return reply;
      const p = idParam.safeParse(request.params);
      if (!p.success) return notFound(reply);
      const row = await visible(request, p.data.id);
      if (!row) return notFound(reply);
      await db.transaction().execute(async (trx) => {
        if (method === 'put') {
          const added = await trx
            .insertInto('saved_search_star')
            .values({
              workspace_id: request.workspaceId,
              saved_search_id: row.id,
              user_id: user.id,
            })
            .onConflict((oc) => oc.doNothing())
            .executeTakeFirst();
          if (Number(added.numInsertedOrUpdatedRows ?? 0) === 0) return;
        } else {
          const removed = await trx
            .deleteFrom('saved_search_star')
            .where('saved_search_id', '=', row.id)
            .where('user_id', '=', user.id)
            .executeTakeFirst();
          if (Number(removed.numDeletedRows) === 0) return;
        }
        await emit(trx, by(request), {
          type: method === 'put' ? 'saved_search.starred' : 'saved_search.unstarred',
          subjectId: row.id,
          payload: {},
        });
      });
      return reply.code(204).send();
    });
  }

  const subscriptionView = (s: {
    id: number;
    recipient_user_id: number | null;
    recipient_group_id: number | null;
    recipient_name: string | null;
    created_by: number;
    schedule: string;
    hour: number;
    minute: number;
    weekday: number | null;
    day_of_month: number | null;
    cron: string | null;
    time_zone: string;
    only_if_results: boolean;
    next_run_at: Date;
    last_run_at: Date | null;
    last_sent: number | null;
    last_error: string | null;
  }) => ({
    id: s.id,
    recipient:
      s.recipient_user_id !== null
        ? { userId: s.recipient_user_id, name: s.recipient_name ?? '' }
        : { groupId: s.recipient_group_id, name: s.recipient_name ?? '' },
    createdBy: s.created_by,
    schedule: s.schedule,
    hour: s.hour,
    minute: s.minute,
    weekday: s.weekday,
    dayOfMonth: s.day_of_month,
    cron: s.cron,
    timeZone: s.time_zone,
    onlyIfResults: s.only_if_results,
    nextRunAt: s.next_run_at,
    lastRunAt: s.last_run_at,
    lastSent: s.last_sent,
    lastError: s.last_error,
  });

  const subscriptions = (ws: number) =>
    db
      .selectFrom('saved_search_subscription as u')
      .leftJoin('app_user as p', 'p.id', 'u.recipient_user_id')
      .leftJoin('user_group as g', 'g.id', 'u.recipient_group_id')
      .select([
        'u.id',
        'u.saved_search_id',
        'u.recipient_user_id',
        'u.recipient_group_id',
        sql<string | null>`coalesce(p.name, g.name)`.as('recipient_name'),
        'u.created_by',
        'u.schedule',
        'u.hour',
        'u.minute',
        'u.weekday',
        'u.day_of_month',
        'u.cron',
        'u.time_zone',
        'u.only_if_results',
        'u.next_run_at',
        'u.last_run_at',
        'u.last_sent',
        'u.last_error',
      ])
      .where('u.workspace_id', '=', ws);

  app.get('/api/v1/saved-searches/:id/subscriptions', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    let q = subscriptions(request.workspaceId).where('u.saved_search_id', '=', row.id);
    if (!(await mayManage(request, row))) {
      q = q.where((eb) =>
        eb.or([eb('u.created_by', '=', user.id), eb('u.recipient_user_id', '=', user.id)]),
      );
    }
    const list = await q.orderBy('u.id').execute();
    return { subscriptions: list.map(subscriptionView) };
  });

  app.post('/api/v1/saved-searches/:id/subscriptions', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const parsed = subscribeBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const ws = request.workspaceId;
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    const fields: Record<string, string> = {};
    if (body.groupId !== undefined) {
      if (!(await request.authz.hasGlobal('manage_group_subscriptions'))) {
        return reply
          .code(403)
          .send({ error: 'forbidden', permission: 'manage_group_subscriptions' });
      }
      const g = await db
        .selectFrom('user_group')
        .select('id')
        .where('id', '=', body.groupId)
        .where('workspace_id', '=', ws)
        .executeTakeFirst();
      if (!g) fields.groupId = 'not_found';
    }
    if (body.schedule === 'weekly' && body.weekday === undefined) fields.weekday = 'required';
    if (body.schedule === 'monthly' && body.dayOfMonth === undefined) {
      fields.dayOfMonth = 'required';
    }
    if (body.schedule === 'cron') {
      if (body.cron === undefined) fields.cron = 'required';
      else {
        try {
          parseCron(body.cron);
        } catch (error) {
          if (!(error instanceof ScheduleError)) throw error;
          fields.cron = error.message;
        }
      }
    }
    const timeZone = body.timeZone ?? user.timeZone ?? 'UTC';
    if (!validTimeZone(timeZone)) fields.timeZone = 'invalid';
    if (Object.keys(fields).length > 0) return invalidFields(reply, fields);
    const schedule = {
      schedule: body.schedule,
      hour: body.hour,
      minute: body.minute,
      weekday: body.schedule === 'weekly' ? (body.weekday ?? null) : null,
      dayOfMonth: body.schedule === 'monthly' ? (body.dayOfMonth ?? null) : null,
      cron: body.schedule === 'cron' ? (body.cron ?? null) : null,
      timeZone,
    };
    const next = nextRun(schedule, new Date());
    if (!next) return invalidFields(reply, { cron: 'never_runs' });
    const id = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('saved_search_subscription')
        .values({
          workspace_id: ws,
          saved_search_id: row.id,
          created_by: user.id,
          recipient_user_id: body.groupId === undefined ? user.id : null,
          recipient_group_id: body.groupId ?? null,
          schedule: schedule.schedule,
          hour: schedule.hour,
          minute: schedule.minute,
          weekday: schedule.weekday,
          day_of_month: schedule.dayOfMonth,
          cron: schedule.cron,
          time_zone: timeZone,
          only_if_results: body.onlyIfResults,
          next_run_at: next,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      await emit(trx, by(request), {
        type: 'saved_search.subscribed',
        subjectId: row.id,
        payload: {
          subscriptionId: created.id,
          recipientUserId: body.groupId === undefined ? user.id : null,
          recipientGroupId: body.groupId ?? null,
          schedule: body.schedule,
        },
      });
      return created.id;
    });
    const fresh = await subscriptions(ws).where('u.id', '=', id).executeTakeFirstOrThrow();
    return reply.code(201).send({ subscription: subscriptionView(fresh) });
  });

  app.delete('/api/v1/saved-searches/:id/subscriptions/:subscriptionId', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = subParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    const sub = await db
      .selectFrom('saved_search_subscription')
      .select(['id', 'created_by', 'recipient_user_id'])
      .where('id', '=', p.data.subscriptionId)
      .where('saved_search_id', '=', row.id)
      .executeTakeFirst();
    if (!sub) return notFound(reply);
    const own = sub.created_by === user.id || sub.recipient_user_id === user.id;
    if (!own && !(await mayManage(request, row))) return notFound(reply);
    await db.transaction().execute(async (trx) => {
      await trx.deleteFrom('saved_search_subscription').where('id', '=', sub.id).execute();
      await emit(trx, by(request), {
        type: 'saved_search.unsubscribed',
        subjectId: row.id,
        payload: { subscriptionId: sub.id },
      });
    });
    return reply.code(204).send();
  });
}
