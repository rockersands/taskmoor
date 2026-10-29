import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { bulkJob } from '../bulk/jobs';
import { bulkBody, MAX_BULK_TICKETS, paramsOf } from '../bulk/model';
import { emit } from '../events/bus';
import { enqueue } from '../events/queue';
import type { FieldCatalogs } from '../fields/catalog';
import { collectIds, DEFAULT_QUERY_TIMEOUT_MS, prepareSearch } from '../search/run';
import { parseTicketKey, ticketKey } from '../tickets/model';
import { loadTickets } from '../tickets/store';
import { searchPerson, searchRefusal, searchScope } from './search';

/**
 * Bulk operations (M1-021; CORE-024): a person with "Make bulk changes" asks for an edit, a
 * move, a transition or a deletion of many tickets; a background job makes it ticket by ticket
 * through the ticket routes' own checks (`bulk/run.ts`), and these routes show how far it got,
 * what failed and why, and take a cancel.
 *
 * - Only the person who asked and site administrators see an operation.
 * - A ticket reference that names no ticket fails at once, as `not_found`; so does one the
 *   person may not see, when its turn comes, so the results never tell the two apart.
 * - The operation's creation and its cancellation are audited; the changes themselves are
 *   ticket activity, kept in each ticket's history (M1-009).
 */
const MAX_INT = 2_147_483_647;
const RESOLVE_CHUNK = 10_000;
const ITEMS_PAGE = 500;

type Db = Kysely<Database> | Transaction<Database>;

const idParam = z.object({ id: z.string().regex(/^[1-9][0-9]{0,17}$/) });
const itemsQuery = z
  .object({
    outcome: z.enum(['done', 'failed', 'skipped', 'pending']).optional(),
    after: z.coerce.number().int().min(-1).optional(),
    limit: z.coerce.number().int().min(1).max(ITEMS_PAGE).optional(),
  })
  .strict();

/** The tickets references name, in order: ids as given, keys (current or old) looked up. */
async function resolveRefs(
  db: Db,
  workspaceId: number,
  refs: readonly (number | string)[],
): Promise<{ ref: string; ticketId: number | null }[]> {
  const keyed = new Map<string, number | null>();
  const parsed: { asked: string; trackKey: string; number: number }[] = [];
  for (const ref of refs) {
    if (typeof ref === 'string' && !/^\d+$/.test(ref)) {
      const key = parseTicketKey(ref);
      if (key) parsed.push({ asked: ref, ...key });
      else keyed.set(ref, null);
    }
  }
  for (let i = 0; i < parsed.length; i += RESOLVE_CHUNK) {
    const chunk = parsed.slice(i, i + RESOLVE_CHUNK);
    const { rows } = await sql<{ track_key: string; number: number; ticket_id: number }>`
      SELECT k.track_key, k.number, h.ticket_id
        FROM unnest(${chunk.map((c) => c.trackKey)}::text[], ${chunk.map((c) => c.number)}::int[])
             AS k (track_key, number)
        JOIN track_key_history tk
          ON tk.workspace_id = ${workspaceId} AND upper(tk.key) = k.track_key
        JOIN ticket_key_history h ON h.track_id = tk.track_id AND h.number = k.number`.execute(db);
    const found = new Map(rows.map((r) => [`${r.track_key}-${r.number}`, r.ticket_id]));
    for (const c of chunk) keyed.set(c.asked, found.get(`${c.trackKey}-${c.number}`) ?? null);
  }
  return refs.map((ref) => {
    const text = String(ref);
    if (typeof ref === 'number' || /^\d+$/.test(text)) {
      const n = Number(text);
      return { ref: text, ticketId: n > 0 && n <= MAX_INT ? n : null };
    }
    return { ref: text, ticketId: keyed.get(text) ?? null };
  });
}

type OperationRow = Awaited<ReturnType<typeof operationQuery>>[number];
const operationQuery = (db: Db, workspaceId: number) =>
  db.selectFrom('bulk_operation').selectAll().where('workspace_id', '=', workspaceId).execute();

const view = (row: OperationRow) => ({
  id: Number(row.id),
  action: row.action,
  params: row.params,
  status: row.status,
  cancelRequested: row.cancel_requested,
  total: row.total,
  succeeded: row.succeeded,
  failed: row.failed,
  skipped: row.skipped,
  pending: Math.max(0, row.total - row.succeeded - row.failed - row.skipped),
  userId: row.user_id,
  createdAt: row.created_at.toISOString(),
  startedAt: row.started_at?.toISOString() ?? null,
  finishedAt: row.finished_at?.toISOString() ?? null,
});

export interface BulkRouteOptions {
  /** How long each statement of a selection by query may run (QRY-010 (3)). */
  queryTimeoutMs?: number;
}

export function registerBulkRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: BulkRouteOptions = {},
): void {
  const timeoutMs = options.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  const forbidden = (reply: FastifyReply) =>
    reply.code(403).send({ error: 'forbidden', permission: 'bulk_change' });
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

  /** An operation the caller may see: their own, or any for a site administrator. */
  async function visible(request: FastifyRequest, id: string): Promise<OperationRow | null> {
    const user = request.user;
    if (!user) return null;
    const row = await db
      .selectFrom('bulk_operation')
      .selectAll()
      .where('workspace_id', '=', request.workspaceId)
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) return null;
    if (row.user_id !== user.id && !(await request.authz.isSiteAdmin())) return null;
    return row;
  }

  app.post('/api/v1/bulk-operations', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    if (!(await request.authz.hasGlobal('bulk_change'))) return forbidden(reply);
    const parsed = bulkBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: 'invalid_fields',
        fields: Object.fromEntries(
          parsed.error.issues.map((i) => [i.path.join('.') || 'body', i.code]),
        ),
      });
    }
    const body = parsed.data;
    const ws = request.workspaceId;
    if ((body.tickets === undefined) === (body.query === undefined)) {
      return reply
        .code(400)
        .send({ error: 'invalid_fields', fields: { tickets: 'tickets_or_query' } });
    }
    let items: { ref: string; ticketId: number | null }[];
    if (body.query !== undefined) {
      // The query's results as the person sees them (QRY-008), in its order (M1-037).
      let chosen: { ids: number[]; more: boolean };
      try {
        const { filter, catalog, catalogue } = await searchScope(db, catalogs, request, false);
        const { compiled } = await prepareSearch({
          db,
          workspaceId: ws,
          catalog,
          catalogue,
          filter,
          q: body.query,
          ...searchPerson(request),
        });
        chosen = await collectIds(db, compiled, { max: MAX_BULK_TICKETS, timeoutMs });
      } catch (error) {
        return searchRefusal(reply, error, timeoutMs);
      }
      if (chosen.more) {
        return reply.code(400).send({ error: 'too_many_tickets', max: MAX_BULK_TICKETS });
      }
      if (chosen.ids.length === 0) return reply.code(400).send({ error: 'no_tickets' });
      items = chosen.ids.map((id) => ({ ref: String(id), ticketId: id }));
    } else {
      items = await resolveRefs(db, ws, body.tickets ?? []);
    }
    const row = await db.transaction().execute(async (trx) => {
      const created = await trx
        .insertInto('bulk_operation')
        .values({
          workspace_id: ws,
          user_id: user.id,
          action: body.action,
          params: JSON.stringify(paramsOf(body)),
          total: items.length,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      for (let i = 0; i < items.length; i += RESOLVE_CHUNK) {
        const chunk = items.slice(i, i + RESOLVE_CHUNK);
        const missing = JSON.stringify({ error: 'not_found' });
        await sql`
          INSERT INTO bulk_item (operation_id, workspace_id, position, ref, ticket_id, outcome,
              status_code, error, finished_at)
          SELECT ${Number(created.id)}, ${ws}, i.position, i.ref, i.ticket_id,
                 CASE WHEN i.ticket_id IS NULL THEN 'failed' END,
                 CASE WHEN i.ticket_id IS NULL THEN 404 END,
                 CASE WHEN i.ticket_id IS NULL THEN ${missing}::jsonb END,
                 CASE WHEN i.ticket_id IS NULL THEN now() END
            FROM unnest(${chunk.map((_, j) => i + j)}::int[], ${chunk.map((c) => c.ref)}::text[],
                        ${chunk.map((c) => c.ticketId)}::int[]) AS i (position, ref, ticket_id)`.execute(
          trx,
        );
      }
      const unknown = items.filter((it) => it.ticketId === null).length;
      if (unknown > 0) {
        await trx
          .updateTable('bulk_operation')
          .set({ failed: unknown })
          .where('id', '=', created.id)
          .execute();
      }
      await emit(
        trx,
        { workspaceId: ws, actorId: user.id },
        {
          type: 'bulk_operation.created',
          subjectId: Number(created.id),
          payload: { action: body.action, total: items.length },
        },
      );
      await enqueue(trx, [bulkJob(ws, created.id)]);
      return { ...created, failed: unknown };
    });
    return reply.code(202).send({ bulkOperation: view(row) });
  });

  app.get('/api/v1/bulk-operations', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const rows = await db
      .selectFrom('bulk_operation')
      .selectAll()
      .where('workspace_id', '=', request.workspaceId)
      .where('user_id', '=', user.id)
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(50)
      .execute();
    return { bulkOperations: rows.map(view) };
  });

  app.get('/api/v1/bulk-operations/:id', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    return { bulkOperation: view(row) };
  });

  // Per-ticket results, in the order given, a page at a time; keys only for tickets the reader
  // may see now.
  app.get('/api/v1/bulk-operations/:id/items', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const p = idParam.safeParse(request.params);
    const q = itemsQuery.safeParse(request.query);
    if (!p.success) return notFound(reply);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    const limit = q.data.limit ?? 100;
    let query = db
      .selectFrom('bulk_item')
      .select(['position', 'ref', 'ticket_id', 'outcome', 'status_code', 'error'])
      .where('operation_id', '=', row.id)
      .where('position', '>', q.data.after ?? -1)
      .orderBy('position')
      .limit(limit + 1);
    if (q.data.outcome === 'pending') query = query.where('outcome', 'is', null);
    else if (q.data.outcome) query = query.where('outcome', '=', q.data.outcome);
    const items = await query.execute();
    const page = items.slice(0, limit);
    const tickets = await loadTickets(
      db,
      request.workspaceId,
      page.flatMap((i) => (i.ticket_id === null ? [] : [i.ticket_id])),
    );
    const seen = await request.authz.visibleTickets([...tickets.keys()]);
    return {
      items: page.map((i) => {
        const t = i.ticket_id === null ? undefined : tickets.get(i.ticket_id);
        return {
          position: i.position,
          ref: i.ref,
          key: t && seen.has(t.id) ? ticketKey(t.track_key, t.number) : null,
          outcome: i.outcome ?? 'pending',
          statusCode: i.status_code,
          error: i.error,
        };
      }),
      next: items.length > limit ? (page[page.length - 1]?.position ?? null) : null,
    };
  });

  app.post('/api/v1/bulk-operations/:id/cancel', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = idParam.safeParse(request.params);
    if (!p.success) return notFound(reply);
    const row = await visible(request, p.data.id);
    if (!row) return notFound(reply);
    if (row.status === 'done' || row.status === 'cancelled') {
      return reply.code(409).send({ error: 'finished', status: row.status });
    }
    const updated = await db.transaction().execute(async (trx) => {
      const changed = await trx
        .updateTable('bulk_operation')
        .set({ cancel_requested: true })
        .where('id', '=', row.id)
        .where('cancel_requested', '=', false)
        .returningAll()
        .executeTakeFirst();
      if (changed) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: user.id },
          {
            type: 'bulk_operation.cancelled',
            subjectId: Number(row.id),
            payload: { action: row.action, total: row.total },
          },
        );
      }
      return changed ?? row;
    });
    return reply.code(202).send({ bulkOperation: view(updated) });
  });
}
