import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { bootstrapTrack, changesSince, logPosition, syncTracks } from '../sync/log';
import { resolveTrack } from '../tickets/store';

/**
 * The sync API of ADR-013 (M1-031), read-only: a client lists its sync groups, bootstraps each
 * track's tickets from a position, then follows the change log from there (`sync/log.ts`). The
 * realtime push and the client store come with M1-032.
 */
const MAX_INT = 2_147_483_647;
const seq = z.string().regex(/^\d{1,19}$/);
const bootstrapQuery = z
  .object({
    track: z.string().min(1).max(300),
    after: z.coerce.number().int().min(0).max(MAX_INT).default(0),
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  })
  .strict();
const changesQuery = z
  .object({
    after: seq.default('0'),
    limit: z.coerce.number().int().min(1).max(5000).default(1000),
  })
  .strict();

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });

export function registerSyncRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  authorizer: Authorizer,
): void {
  app.get('/api/v1/sync/groups', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ws = request.workspaceId;
    const position = await logPosition(db, ws);
    const tracks = await syncTracks(db, authorizer, ws, { userId: user.id });
    return { position, tracks };
  });

  app.get('/api/v1/sync/bootstrap', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = bootstrapQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const ws = request.workspaceId;
    const trackId = await resolveTrack(db, ws, parsed.data.track);
    const page =
      trackId === null
        ? null
        : await bootstrapTrack(db, authorizer, ws, { userId: user.id }, trackId, parsed.data);
    if (!page) return reply.code(404).send({ error: 'not_found' });
    return page;
  });

  app.get('/api/v1/sync/changes', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = changesQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    return changesSince(db, authorizer, request.workspaceId, { userId: user.id }, parsed.data);
  });
}
