import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { logPosition } from './log';

/**
 * Mutations applied at most once (M1-032; ADR-013). A client's outbox sends every mutation
 * with `taskmoor-client-id` and `taskmoor-mutation-id`; a receipt for the pair is written
 * before the mutation runs.
 *
 * - A second copy of a finished pair (a replay after a lost answer, an offline queue sent
 *   twice) gets the stored answer with `taskmoor-replayed: true`, and nothing runs again.
 * - A second copy while the first still runs is refused (409 `mutation_in_progress`). One
 *   unfinished for over five minutes was cut off by a crash, and whether it happened is not
 *   known (409 `mutation_outcome_unknown`): the client drops it and reads the truth from the
 *   change log. It never runs a second time.
 * - The same mutation id for another method or path is refused (409 `mutation_id_reused`).
 * - A server error removes the receipt: the mutation did not happen, and a retry may run it.
 * - Every answer carries `taskmoor-position`, the change log position that includes the
 *   mutation, so the client knows when its own change has come back through the log.
 *
 * Requests without the headers behave as before.
 */
const CLIENT_HEADER = 'taskmoor-client-id';
const MUTATION_HEADER = 'taskmoor-mutation-id';
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** A receipt unfinished this long belongs to a request a crash cut off. */
const STALE_MS = 5 * 60 * 1000;
/** Larger answers are not kept: a replay of such a mutation answers without a body. */
const MAX_BODY = 256 * 1024;

declare module 'fastify' {
  interface FastifyRequest {
    mutationReceipt?: { clientId: string; mutationId: string };
  }
}

const header = (request: FastifyRequest, name: string) => {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
};

export function registerMutationReceipts(app: FastifyInstance, db: Kysely<Database>): void {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!MUTATING.has(request.method) || !request.user) return;
    const clientId = header(request, CLIENT_HEADER);
    const mutationId = header(request, MUTATION_HEADER);
    if (clientId === undefined && mutationId === undefined) return;
    if (!clientId || !mutationId || !ID.test(clientId) || !ID.test(mutationId)) {
      return reply.code(400).send({ error: 'invalid_mutation_id' });
    }
    const path = request.url.split('?')[0] ?? request.url;
    const claimed = await db
      .insertInto('mutation_receipt')
      .values({
        workspace_id: request.workspaceId,
        user_id: request.user.id,
        client_id: clientId,
        mutation_id: mutationId,
        method: request.method,
        path,
        status: 'pending',
      })
      .onConflict((oc) => oc.columns(['user_id', 'client_id', 'mutation_id']).doNothing())
      .returning('mutation_id')
      .executeTakeFirst();
    if (claimed) {
      request.mutationReceipt = { clientId, mutationId };
      return;
    }
    const earlier = await db
      .selectFrom('mutation_receipt')
      .select(['method', 'path', 'status', 'status_code', 'body', 'position', 'created_at'])
      .where('user_id', '=', request.user.id)
      .where('client_id', '=', clientId)
      .where('mutation_id', '=', mutationId)
      .executeTakeFirst();
    if (!earlier || earlier.status === 'pending') {
      const stale = earlier && Date.now() - earlier.created_at.getTime() > STALE_MS;
      return reply
        .code(409)
        .send({ error: stale ? 'mutation_outcome_unknown' : 'mutation_in_progress' });
    }
    if (earlier.method !== request.method || earlier.path !== path) {
      return reply.code(409).send({ error: 'mutation_id_reused' });
    }
    reply.header('taskmoor-replayed', 'true');
    if (earlier.position) reply.header('taskmoor-position', earlier.position);
    reply.code(earlier.status_code ?? 200);
    return earlier.body === null ? reply.send() : reply.send(earlier.body);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const receipt = request.mutationReceipt;
    if (!receipt || !request.user) return payload;
    const key = (eb: Kysely<Database>) =>
      eb
        .updateTable('mutation_receipt')
        .where('user_id', '=', request.user?.id as number)
        .where('client_id', '=', receipt.clientId)
        .where('mutation_id', '=', receipt.mutationId);
    if (reply.statusCode >= 500) {
      await db
        .deleteFrom('mutation_receipt')
        .where('user_id', '=', request.user.id)
        .where('client_id', '=', receipt.clientId)
        .where('mutation_id', '=', receipt.mutationId)
        .execute();
      return payload;
    }
    const position = await logPosition(db, request.workspaceId);
    let body: string | null = null;
    if (typeof payload === 'string' && payload.length <= MAX_BODY) {
      const type = String(reply.getHeader('content-type') ?? '');
      if (type.includes('json') && payload !== '') body = payload;
    }
    await key(db)
      .set({
        status: 'done',
        status_code: reply.statusCode,
        body,
        position,
        finished_at: new Date(),
      })
      .execute();
    reply.header('taskmoor-position', position);
    return payload;
  });
}

/** Removes receipts older than a week; returns how many went. */
export async function trimMutationReceipts(
  db: Kysely<Database>,
  now = new Date(),
): Promise<number> {
  const { rows } = await sql<{ n: number }>`
    WITH gone AS (
      DELETE FROM mutation_receipt WHERE created_at < ${new Date(now.getTime() - 7 * 86_400_000)}
      RETURNING 1)
    SELECT count(*)::int AS n FROM gone`.execute(db);
  return rows[0]?.n ?? 0;
}
