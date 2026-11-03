import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { childProgress } from '../tickets/progress';

const MAX_INT = 2_147_483_647;
/**
 * Every card a board's data holds at most (`limit` of GET /boards/:id/data), in one request.
 * The pages a list has loaded can add up to more; the frontend sends those in parts this size
 * (`loadSubticketProgress`). That many ids leave room in a statement, under Postgres's 65,535
 * parameters, for the permission filter, and the body stays under the 1 MiB a request may hold.
 */
const MAX_IDS = 50_000;

export const subticketProgressBody = z
  .object({ ids: z.array(z.number().int().positive().max(MAX_INT)).max(MAX_IDS) })
  .strict();

/**
 * How far along the tickets under some tickets are (CORE-032; ADR-120), for the ticket page,
 * board cards and lists. `POST /api/v1/tickets/subticket-progress` answers, for each ticket the
 * caller may see that has any, how many tickets sit under it and how many of those are in a
 * closed stage (`childProgress`, the one definition of done for progress). One statement however
 * many tickets it is asked about, and the permission filter is part of it: a ticket someone may
 * not see counts for nothing, for them. Only reads, like a search too long for a URL.
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
    const { rows } = await childProgress(request.workspaceId, parents, filter.sql).execute(db);
    return {
      progress: Object.fromEntries(
        rows.map((r) => [String(r.parent_id), { total: r.total, closed: r.closed }]),
      ),
    };
  });
}
