import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { MAX_BULK_TICKETS } from '../bulk/model';
import { type CloneParams, cloneBody, clonePlan } from '../clone/model';
import { guardrailLimit } from '../guardrails/model';
import { SUBTICKET_RANK } from '../tickets/hierarchy';
import { SUMMARY_MAX, ticketKey } from '../tickets/model';
import { loadTicket, resolveTicket, resolveTrack } from '../tickets/store';
import { bulkOperationView, startBulkOperation } from './bulk';

/**
 * Clone and deep clone (M1-124; CORE-023; ADR-077): `POST /api/v1/tickets/:id/clone` starts a
 * bulk operation of action `clone` and answers it at once; a background job makes the copies,
 * parents first, each through the ticket create route as the person who asked
 * (`clone/run.ts`). Poll `GET /api/v1/bulk-operations/:id`; each item names the copy it made.
 *
 * - Cloning needs to see the ticket and "Create tickets" in the track the copies go to (any
 *   track the person may browse; the ticket's own by default). It does not need "Make bulk
 *   changes": one clone is one person's own change, however many tickets it copies.
 * - A subticket lives with its parent, so it is copied into its own track only.
 * - The workspace's limit on tickets per bulk operation (`tickets_per_bulk_operation`) also
 *   caps a clone.
 */
const params = z.object({ id: z.string().min(1).max(300) });

export function registerCloneRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  app.post('/api/v1/tickets/:id/clone', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const p = params.safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_request' });
    const parsed = cloneBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const issue of parsed.error.issues) {
        if (issue.code === 'unrecognized_keys')
          for (const key of issue.keys) fields[key] = 'unknown';
        else fields[String(issue.path[0] ?? 'body')] ??= 'invalid';
      }
      return reply.code(400).send({ error: 'invalid_fields', fields });
    }
    const body = parsed.data;
    const ws = request.workspaceId;
    const found = await resolveTicket(db, ws, p.data.id);
    const source = found ? await loadTicket(db, ws, found.id) : undefined;
    if (!source || source.deleted_at || !(await request.authz.seesTicket(source))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const trackId =
      body.track === undefined ? source.track_id : await resolveTrack(db, ws, body.track);
    if (trackId === null || !(await request.authz.can('browse_track', trackId))) {
      return reply.code(400).send({ error: 'invalid_fields', fields: { track: 'not_found' } });
    }
    const track = await db
      .selectFrom('track')
      .select(['key', 'archived_at'])
      .where('id', '=', trackId)
      .executeTakeFirstOrThrow();
    if (track.archived_at) return reply.code(409).send({ error: 'track_archived' });
    if (!(await request.authz.can('create_tickets', trackId))) {
      return reply.code(403).send({ error: 'forbidden', permission: 'create_tickets' });
    }
    const fields: Record<string, string> = {};
    if (source.level_rank === SUBTICKET_RANK && trackId !== source.track_id) {
      fields.track = 'subticket';
    }
    let summary: string | undefined;
    if (body.summary !== undefined) {
      summary = body.summary.trim();
      if (summary === '') fields.summary = 'required';
      else if ([...summary].length > SUMMARY_MAX) fields.summary = 'too_long';
      else if (/[\r\n]/.test(summary)) fields.summary = 'invalid';
    }
    if (Object.keys(fields).length > 0) {
      return reply.code(400).send({ error: 'invalid_fields', fields });
    }
    const limit = Math.min(
      MAX_BULK_TICKETS,
      await guardrailLimit(db, ws, 'tickets_per_bulk_operation'),
    );
    const plan = await clonePlan(
      db,
      request.authz,
      { id: source.id, trackKey: source.track_key, number: source.number },
      body,
      limit,
    );
    if (plan === 'too_many') {
      return reply.code(400).send({
        error: 'too_many_tickets',
        max: limit,
        guardrail: 'tickets_per_bulk_operation',
      });
    }
    const stored: CloneParams = {
      ticket: source.id,
      key: ticketKey(source.track_key, source.number),
      track: trackId,
      trackKey: track.key,
      ...(summary !== undefined ? { summary } : {}),
      subtickets: body.subtickets,
      descendants: body.descendants,
      attachments: body.attachments,
      links: body.links,
    };
    const row = await startBulkOperation(
      db,
      ws,
      user.id,
      'clone',
      { ...stored },
      plan.map((t) => ({ ref: t.key, ticketId: t.id })),
    );
    return reply.code(202).send({ bulkOperation: bulkOperationView(row) });
  });
}
