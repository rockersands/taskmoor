import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { diff, emit } from '../events/bus';
import {
  type Limits,
  RATE_LIMIT_BOUNDS,
  type RateLimiter,
  type RateLimitPolicies,
  type RateLimitPolicy,
  readRateLimits,
} from '../ratelimit/limiter';
import { type ApiClient, topClients, type UsageRecorder } from '../ratelimit/usage';

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the rate limits and the usage dashboard count this request against (M1-066). */
    apiClient: ApiClient | null;
    /** Whether the rate limits refused this request. */
    throttled: boolean;
  }
}

/** Routes outside the limits: the meta endpoint answers before anyone signs in. */
const EXEMPT = new Set(['/api/meta']);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The client a request counts against: its token, its person, or its address. */
export function clientOf(request: FastifyRequest): ApiClient {
  if (request.apiToken) return { kind: 'token', id: String(request.apiToken.id) };
  if (request.user) return { kind: 'user', id: String(request.user.id) };
  return { kind: 'address', id: request.ip };
}

function refuse(
  reply: FastifyReply,
  scope: 'token' | 'user' | 'address' | 'ticket',
  retryAfterSeconds: number,
) {
  return reply
    .code(429)
    .header('retry-after', String(retryAfterSeconds))
    .send({ error: 'rate_limited', scope, retryAfterSeconds });
}

/**
 * Applies the rate limits to every API request (M1-066; API-010 (1)) after it is authenticated,
 * answers each with the `RateLimit-*` headers of its client's bucket (spec 02a section 1.1),
 * and counts it for the usage dashboard when it is answered.
 */
export function registerRateLimits(
  app: FastifyInstance,
  options: { limiter: RateLimiter; policies: RateLimitPolicies; usage: UsageRecorder },
): void {
  const { limiter, policies, usage } = options;
  app.decorateRequest('apiClient', null);
  app.decorateRequest('throttled', false);
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/') || reply.sent) return;
    const path = request.routeOptions.url ?? '';
    if (EXEMPT.has(path)) return;
    const client = clientOf(request);
    request.apiClient = client;
    const policy = await policies.get(request.workspaceId);
    const taken = limiter.take(
      `${request.workspaceId}:${client.kind}:${client.id}`,
      policy[client.kind],
    );
    reply
      .header('ratelimit-limit', String(taken.limit))
      .header('ratelimit-remaining', String(taken.remaining))
      .header('ratelimit-reset', String(taken.resetSeconds));
    if (!taken.allowed) {
      request.throttled = true;
      return refuse(reply, client.kind, taken.retryAfterSeconds);
    }
    // Writes to one ticket, whoever sends them (by the key or id the route was given).
    const ticket = (request.params as { id?: unknown } | undefined)?.id;
    if (WRITES.has(request.method) && path.startsWith('/api/v1/tickets/:id') && ticket) {
      const write = limiter.take(
        `${request.workspaceId}:ticket:${String(ticket).toUpperCase()}`,
        policy.ticketWrite,
      );
      if (!write.allowed) {
        request.throttled = true;
        return refuse(reply, 'ticket', write.retryAfterSeconds);
      }
    }
  });
  app.addHook('onResponse', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const path = request.routeOptions.url ?? '';
    if (EXEMPT.has(path)) return;
    usage.record(
      request.workspaceId,
      request.apiClient ?? clientOf(request),
      reply.statusCode,
      request.throttled,
    );
  });
}

const limits = z
  .object({
    rate: z.number().int().min(RATE_LIMIT_BOUNDS.rate.min).max(RATE_LIMIT_BOUNDS.rate.max),
    burst: z.number().int().min(RATE_LIMIT_BOUNDS.burst.min).max(RATE_LIMIT_BOUNDS.burst.max),
  })
  .strict();
const policyBody = z
  .object({
    token: limits.optional(),
    user: limits.optional(),
    address: limits.optional(),
    ticketWrite: limits.optional(),
  })
  .strict();
const usageQuery = z.object({ window: z.enum(['hour', 'day']).default('hour') });

const flat = (p: RateLimitPolicy) => ({
  tokenRate: p.token.rate,
  tokenBurst: p.token.burst,
  userRate: p.user.rate,
  userBurst: p.user.burst,
  addressRate: p.address.rate,
  addressBurst: p.address.burst,
  ticketWriteRate: p.ticketWrite.rate,
  ticketWriteBurst: p.ticketWrite.burst,
});

/**
 * The rate limits and the usage dashboard for site administrators (M1-066; API-010 (2)):
 * read and change the workspace's limits, and the 20 busiest clients of the last hour or day.
 */
export function registerRateLimitRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { policies: RateLimitPolicies; usage: UsageRecorder; now?: () => number },
): void {
  const now = options.now ?? (() => Date.now());
  app.get('/api/v1/admin/rate-limits', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { limits: await readRateLimits(db, request.workspaceId), bounds: RATE_LIMIT_BOUNDS };
  });

  app.put('/api/v1/admin/rate-limits', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = policyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const asked = parsed.data as Partial<Record<keyof RateLimitPolicy, Limits>>;
    const next = await db.transaction().execute(async (trx) => {
      const before = await readRateLimits(trx, request.workspaceId);
      const policy: RateLimitPolicy = { ...before, ...asked };
      const row = {
        token_rate: policy.token.rate,
        token_burst: policy.token.burst,
        user_rate: policy.user.rate,
        user_burst: policy.user.burst,
        address_rate: policy.address.rate,
        address_burst: policy.address.burst,
        ticket_write_rate: policy.ticketWrite.rate,
        ticket_write_burst: policy.ticketWrite.burst,
        updated_at: new Date(),
      };
      await trx
        .insertInto('rate_limit_policy')
        .values({ workspace_id: request.workspaceId, ...row })
        .onConflict((oc) => oc.column('workspace_id').doUpdateSet(row))
        .execute();
      const changes = diff(flat(before), flat(policy));
      if (Object.keys(changes).length > 0) {
        await emit(
          trx,
          { workspaceId: request.workspaceId, actorId: admin.id },
          { type: 'rate_limits.updated', subjectId: request.workspaceId, payload: { changes } },
        );
      }
      return policy;
    });
    options.policies.set(request.workspaceId, next);
    return { limits: next, bounds: RATE_LIMIT_BOUNDS };
  });

  app.get('/api/v1/admin/api-usage', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = usageQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    // What this process counted so far, so the page is current.
    await options.usage.flush();
    return {
      window: parsed.data.window,
      clients: await topClients(db, request.workspaceId, parsed.data.window, new Date(now())),
    };
  });
}
