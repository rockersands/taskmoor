import type { Database, JsonValue } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { FieldCatalogs } from '../fields/catalog';
import { customFieldViews } from '../fields/values';
import { type TicketView, ticketQuery, ticketView } from '../tickets/store';

/**
 * The home page's lists (M1-052; AGL-018, AGL-019): the tickets a person follows and the ones
 * they opened lately. Assigned tickets come from search (`assignee = currentUser()`).
 *
 * - `GET /api/v1/me/followed-tickets` and `GET /api/v1/me/recent-tickets` list tickets the
 *   person may see now, through the same filter as search (browse permission, ticket grants,
 *   visibility levels): following a ticket or having opened it gives no access of its own.
 * - `PUT /api/v1/me/recent-tickets/:id` records that the person opened a ticket they may see
 *   (the ticket view calls it). It keeps the last 50 per person, is personal history rather
 *   than a change to shared data, and emits no event (exempt in the contract test).
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const listQuery = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) }).strict();
/** Visits kept per person. */
export const RECENT_KEPT = 50;

export function registerHomeRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
): void {
  /** Ticket views in the order of `ids`, of the tickets the person may see now. */
  async function views(request: FastifyRequest, ids: readonly number[]): Promise<TicketView[]> {
    if (ids.length === 0) return [];
    const ws = request.workspaceId;
    const filter = await request.authz.ticketFilter();
    const rows = await ticketQuery(db, ws)
      .where('k.id', 'in', [...ids])
      .where('k.deleted_at', 'is', null)
      .where(filter.sql)
      .execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = ids.flatMap((ticketId) => {
      const row = byId.get(ticketId);
      return row ? [row] : [];
    });
    const parents = ordered.flatMap((r) => (r.parent_id === null ? [] : [r.parent_id]));
    const visible = await request.authz.visibleTickets(parents);
    const custom = await customFieldViews(db, ws, await catalogs.get(ws), ordered);
    return ordered.map((r) =>
      ticketView(
        r,
        r.parent_id !== null && visible.has(r.parent_id),
        (custom.get(r.id) ?? {}) as Record<string, JsonValue>,
      ),
    );
  }

  const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });

  app.get('/api/v1/me/followed-tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = listQuery.safeParse(request.query);
    if (!q.success) return invalid(reply);
    const filter = await request.authz.ticketFilter();
    // Open tickets first, then the most recently updated.
    const rows = await db
      .selectFrom('ticket_follower as f')
      .innerJoin('ticket as k', 'k.id', 'f.ticket_id')
      .innerJoin('status as s', 's.id', 'k.status_id')
      .select('k.id')
      .where('f.user_id', '=', user.id)
      .where('f.workspace_id', '=', request.workspaceId)
      .where('k.deleted_at', 'is', null)
      .where(filter.sql)
      .orderBy(sql`s.stage = 'closed'`)
      .orderBy('k.updated_at', 'desc')
      .orderBy('k.id', 'desc')
      .limit(q.data.limit)
      .execute();
    return {
      tickets: await views(
        request,
        rows.map((r) => r.id),
      ),
    };
  });

  app.get('/api/v1/me/recent-tickets', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const q = listQuery.safeParse(request.query);
    if (!q.success) return invalid(reply);
    const rows = await db
      .selectFrom('ticket_visit')
      .select('ticket_id')
      .where('user_id', '=', user.id)
      .where('workspace_id', '=', request.workspaceId)
      .orderBy('visited_at', 'desc')
      .orderBy('ticket_id', 'desc')
      .limit(RECENT_KEPT)
      .execute();
    const tickets = await views(
      request,
      rows.map((r) => r.ticket_id),
    );
    return { tickets: tickets.slice(0, q.data.limit) };
  });

  app.put('/api/v1/me/recent-tickets/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ws = request.workspaceId;
    const filter = await request.authz.ticketFilter();
    const ticket = await db
      .selectFrom('ticket as k')
      .select('k.id')
      .where('k.id', '=', params.data.id)
      .where('k.workspace_id', '=', ws)
      .where('k.deleted_at', 'is', null)
      .where(filter.sql)
      .executeTakeFirst();
    if (!ticket) return reply.code(404).send({ error: 'not_found' });
    await db.transaction().execute(async (trx) => {
      await trx
        .insertInto('ticket_visit')
        .values({ workspace_id: ws, user_id: user.id, ticket_id: ticket.id })
        .onConflict((oc) =>
          oc.columns(['user_id', 'ticket_id']).doUpdateSet({ visited_at: sql`now()` }),
        )
        .execute();
      // Only the latest visits are kept.
      await sql`
        DELETE FROM ticket_visit
         WHERE user_id = ${user.id}
           AND ticket_id NOT IN (
             SELECT ticket_id FROM ticket_visit WHERE user_id = ${user.id}
              ORDER BY visited_at DESC, ticket_id DESC LIMIT ${RECENT_KEPT})`.execute(trx);
    });
    return reply.code(204).send();
  });
}
