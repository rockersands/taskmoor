import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireGlobal, requireSiteAdmin } from '../auth';
import { withEvent } from '../events/bus';
import { resolveTicket } from '../tickets/store';
import { setTrashRetentionDays, TRASH_RETENTION_LIMITS, trashRetentionDays } from '../trash/policy';
import { purgeTicketNow } from '../trash/purge';

/**
 * The trash beyond deleting and restoring (M1-101, CORE-025 (3)):
 *
 * - `GET` and `PUT /api/v1/admin/trash-policy`: how many days the trash keeps tickets and
 *   tracks (site administrators; 1 to 365, default 30). A shorter retention applies at the
 *   next purge run to everything already in the trash.
 * - `POST /api/v1/tickets/:id/purge`: deletes one ticket in the trash for good, with its
 *   subtickets, before the retention ends (site administrators). A subticket that went with
 *   its parent goes with the parent.
 *
 * Deleting and restoring tickets are in `tickets.ts`, tracks in `tracks.ts`; the purge job in
 * `trash/purge.ts`.
 */
const policyBody = z
  .object({
    retentionDays: z.number().int().min(TRASH_RETENTION_LIMITS.min).max(TRASH_RETENTION_LIMITS.max),
  })
  .strict();
const params = z.object({ id: z.string().min(1).max(300) });

export function registerTrashRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.get('/api/v1/admin/trash-policy', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return {
      retentionDays: await trashRetentionDays(db, request.workspaceId),
      limits: TRASH_RETENTION_LIMITS,
    };
  });

  app.put('/api/v1/admin/trash-policy', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = policyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const to = parsed.data.retentionDays;
    const ws = request.workspaceId;
    const retentionDays = await withEvent(
      db,
      { workspaceId: ws, actorId: admin.id },
      async (trx) => {
        const from = await trashRetentionDays(trx, ws);
        if (from === to) return { result: to, event: null };
        await setTrashRetentionDays(trx, ws, to);
        return {
          result: to,
          event: {
            type: 'trash_policy.updated',
            subjectId: ws,
            payload: { changes: { retentionDays: { from, to } } },
          },
        };
      },
    );
    return { retentionDays, limits: TRASH_RETENTION_LIMITS };
  });

  app.post('/api/v1/tickets/:id/purge', async (request, reply) => {
    const admin = await requireGlobal(request, reply, 'site_admin');
    if (!admin) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_request' });
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, p.data.id);
    const ticket = found
      ? await db
          .selectFrom('ticket')
          .select(['id', 'track_id'])
          .where('id', '=', found.id)
          .where('workspace_id', '=', ws)
          .executeTakeFirst()
      : undefined;
    // A ticket of a track in the trash goes with its track.
    if (!ticket || !(await request.authz.can('browse_track', ticket.track_id))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const outcome = await purgeTicketNow(db, ws, ticket.id, admin.id);
    if ('refused' in outcome) {
      return outcome.refused === 'not_found'
        ? reply.code(404).send({ error: 'not_found' })
        : reply.code(409).send({ error: outcome.refused });
    }
    return { purged: outcome.purged };
  });
}
