import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';

const MAX_INT = 2_147_483_647;
/** More than a board or a page of a list shows at once. */
const MAX_IDS = 2000;

export const subticketProgressBody = z
  .object({ ids: z.array(z.number().int().positive().max(MAX_INT)).max(MAX_IDS) })
  .strict();

/**
 * How far along the tickets under some tickets are (CORE-032; ADR-120), for the ticket page,
 * board cards and lists. `POST /api/v1/tickets/subticket-progress` answers, for each ticket the
 * caller may see that has any, how many tickets sit under it and how many of those are in a
 * closed stage. One statement however many tickets it is asked about, and the permission filter
 * is part of it: a ticket someone may not see counts for nothing, for them. Only reads, like a
 * search too long for a URL.
 */
export function registerSubticketRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.post('/api/v1/tickets/subticket-progress', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = subticketProgressBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const asked = [...new Set(parsed.data.ids)];
    if (asked.length === 0) return { progress: {} };
    const parents = [...(await request.authz.visibleTickets(asked))];
    if (parents.length === 0) return { progress: {} };
    const filter = await request.authz.ticketFilter();
    const rows = await db
      .selectFrom('ticket as k')
      .innerJoin('status as st', 'st.id', 'k.status_id')
      .select([
        'k.parent_id',
        sql<string>`count(*)`.as('total'),
        sql<string>`count(*) FILTER (WHERE st.stage = 'closed')`.as('closed'),
      ])
      .where('k.workspace_id', '=', request.workspaceId)
      .where('k.parent_id', 'in', parents)
      .where('k.deleted_at', 'is', null)
      .where(filter.sql)
      .groupBy('k.parent_id')
      .execute();
    return {
      progress: Object.fromEntries(
        rows.map((r) => [
          String(r.parent_id),
          { total: Number(r.total), closed: Number(r.closed) },
        ]),
      ),
    };
  });
}
