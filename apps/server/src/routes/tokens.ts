import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin, requireUser } from '../auth';
import { ADMIN_GLOBAL_PERMISSIONS } from '../authz/permissions';
import { diff, emit } from '../events/bus';
import {
  DEFAULT_OVERLAP_HOURS,
  expiryFields,
  expiryFrom,
  findTokenView,
  isExpiryProblem,
  issueApiToken,
  MAX_OVERLAP_HOURS,
  POLICY_LIMITS,
  rotateApiToken,
  scopesField,
  TOKEN_VIEW_COLUMNS,
  type TokenPolicy,
  tokenNameField,
  tokenPolicy,
  toTokenView,
} from '../tokens/api-tokens';

const id = z.coerce.number().int().positive();
const idParams = z.object({ id });

const createBody = z
  .object({ name: tokenNameField, scopes: scopesField, ...expiryFields })
  .strict();

export const rotateBody = z
  .object({
    overlapHours: z.number().int().min(0).max(MAX_OVERLAP_HOURS).default(DEFAULT_OVERLAP_HOURS),
    ...expiryFields,
  })
  .strict();

const listQuery = z.object({
  status: z.enum(['active', 'expired', 'revoked', 'all']).default('all'),
  ownerId: id.optional(),
  kind: z.enum(['person', 'service']).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});

const expiringQuery = z.object({
  withinDays: z.coerce.number().int().min(1).max(365).optional(),
});

const bulkBody = z
  .object({
    ownerId: id.optional(),
    createdBefore: z.string().datetime({ offset: true }).optional(),
    all: z.literal(true).optional(),
    /** Count what would be revoked without revoking it, for a confirmation step. */
    dryRun: z.boolean().default(false),
  })
  .strict();

const policyBody = z
  .object({
    maxLifetimeDays: z
      .number()
      .int()
      .min(POLICY_LIMITS.maxLifetimeDays.min)
      .max(POLICY_LIMITS.maxLifetimeDays.max)
      .optional(),
    reminderDays: z
      .number()
      .int()
      .min(POLICY_LIMITS.reminderDays.min)
      .max(POLICY_LIMITS.reminderDays.max)
      .optional(),
  })
  .strict();

const invalid = (reply: FastifyReply, error = 'invalid_request') => reply.code(400).send({ error });

/** Sends the 400 for a refused expiry; the body says the maximum when that was the reason. */
function expiryRefused(reply: FastifyReply, problem: { error: string }) {
  return reply.code(400).send(problem);
}

/**
 * API tokens (M1-004; IAM-007, ADR-035).
 *
 * People manage their own tokens from a browser session (never with a token): create with a
 * name, scopes and an expiry within the policy, see each once, list, revoke and rotate.
 * Site administrators see every token, revoke one or many at once (of an owner, created
 * before a date, or all), list those due for rotation and set the policy.
 */
export function registerTokenRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const tokenRows = (workspaceId: number) =>
    db
      .selectFrom('api_token as t')
      .innerJoin('app_user as u', 'u.id', 't.user_id')
      .where('t.workspace_id', '=', workspaceId);

  const by = (request: FastifyRequest, actorId: number) => ({
    workspaceId: request.workspaceId,
    actorId,
  });

  // The signed-in person's tokens, newest first, and the limits a new one must keep.
  app.get('/api/v1/account/tokens', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const rows = await tokenRows(request.workspaceId)
      .select([...TOKEN_VIEW_COLUMNS])
      .where('t.user_id', '=', user.id)
      .orderBy('t.created_at', 'desc')
      .orderBy('t.id', 'desc')
      .execute();
    const now = new Date();
    return {
      tokens: rows.map((row) => toTokenView(row, now)),
      policy: await tokenPolicy(db, request.workspaceId),
    };
  });

  app.post('/api/v1/account/tokens', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = createBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { name, scopes } = parsed.data;
    // The admin scope is for people who administer something; anyone else would hold a token
    // that promises more than it can do.
    if (scopes.includes('admin')) {
      const held = await request.authz.global();
      if (!ADMIN_GLOBAL_PERMISSIONS.some((p) => held.has(p))) {
        return invalid(reply, 'scope_not_allowed');
      }
    }
    const now = new Date();
    const expiresAt = expiryFrom(parsed.data, await tokenPolicy(db, request.workspaceId), now);
    if (isExpiryProblem(expiresAt)) return expiryRefused(reply, expiresAt);
    const issued = await db.transaction().execute(async (trx) => {
      const created = await issueApiToken(trx, {
        workspaceId: request.workspaceId,
        userId: user.id,
        name,
        scopes,
        expiresAt,
        createdBy: user.id,
        now,
      });
      await emit(trx, by(request, user.id), {
        type: 'token.created',
        subjectId: created.id,
        payload: {
          ownerId: user.id,
          ownerKind: 'person',
          name,
          scopes,
          expiresAt: expiresAt.toISOString(),
        },
      });
      return created;
    });
    const view = await findTokenView(db, request.workspaceId, issued.id);
    return reply.code(201).send({ token: issued.token, apiToken: view });
  });

  app.delete('/api/v1/account/tokens/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const outcome = await revokeOne(request, user.id, params.data.id, user.id);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  app.post('/api/v1/account/tokens/:id/rotate', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const params = idParams.safeParse(request.params);
    const parsed = rotateBody.safeParse(request.body ?? {});
    if (!params.success || !parsed.success) return invalid(reply);
    return rotateAndReply(db, request, reply, {
      tokenId: params.data.id,
      ownerId: user.id,
      actorId: user.id,
      by: 'self',
      body: parsed.data,
    });
  });

  // Administration: the inventory of every token in the workspace (IAM-007).
  app.get('/api/v1/admin/tokens', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = listQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const { status, ownerId, kind, limit, offset } = parsed.data;
    const now = new Date();
    let base = tokenRows(request.workspaceId);
    if (ownerId !== undefined) base = base.where('t.user_id', '=', ownerId);
    if (kind !== undefined) base = base.where('u.kind', '=', kind);
    if (status === 'revoked') base = base.where('t.revoked_at', 'is not', null);
    if (status === 'active') {
      base = base.where('t.revoked_at', 'is', null).where('t.expires_at', '>', now);
    }
    if (status === 'expired') {
      base = base.where('t.revoked_at', 'is', null).where('t.expires_at', '<=', now);
    }
    const [rows, total, owners] = await Promise.all([
      base
        .select([...TOKEN_VIEW_COLUMNS])
        .orderBy('t.created_at', 'desc')
        .orderBy('t.id', 'desc')
        .limit(limit)
        .offset(offset)
        .execute(),
      base.select((eb) => eb.fn.countAll<string>().as('n')).executeTakeFirstOrThrow(),
      // Everyone who holds a token, for the bulk revocation's owner choice.
      tokenRows(request.workspaceId)
        .select((eb) => [
          'u.id',
          'u.name',
          'u.email',
          'u.kind',
          eb.fn
            .count<string>('t.id')
            .filterWhere((f) => f.and([f('t.revoked_at', 'is', null), f('t.expires_at', '>', now)]))
            .as('active'),
        ])
        .groupBy(['u.id', 'u.name', 'u.email', 'u.kind'])
        .orderBy(sql`lower(u.name)`)
        .orderBy('u.id')
        .execute(),
    ]);
    return {
      tokens: rows.map((row) => toTokenView(row, now)),
      total: Number(total.n),
      owners: owners.map((o) => ({
        id: o.id,
        name: o.name,
        email: o.email,
        kind: o.kind,
        activeTokens: Number(o.active),
      })),
    };
  });

  // Rotation reminders: live tokens that expire within the window, soonest first. Email
  // delivery of the reminder arrives with M1-057; this list is what it will send.
  app.get('/api/v1/admin/tokens/expiring', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = expiringQuery.safeParse(request.query);
    if (!parsed.success) return invalid(reply);
    const withinDays =
      parsed.data.withinDays ?? (await tokenPolicy(db, request.workspaceId)).reminderDays;
    const now = new Date();
    const rows = await tokenRows(request.workspaceId)
      .select([...TOKEN_VIEW_COLUMNS])
      .where('t.revoked_at', 'is', null)
      .where('t.expires_at', '>', now)
      .where('t.expires_at', '<=', new Date(now.getTime() + withinDays * 86_400_000))
      // A token already replaced by rotation needs no reminder.
      .where('t.replaced_by', 'is', null)
      .where('u.deactivated_at', 'is', null)
      .orderBy('t.expires_at')
      .orderBy('t.id')
      .execute();
    return { withinDays, tokens: rows.map((row) => toTokenView(row, now)) };
  });

  app.delete('/api/v1/admin/tokens/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = idParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const outcome = await revokeOne(request, admin.id, params.data.id, null);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Bulk revocation (IAM-007 criterion 1): every live token of an owner, every one created
  // before a date (both together narrow), or all of them. Reports how many it revoked.
  app.post('/api/v1/admin/tokens/revoke', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = bulkBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const { ownerId, createdBefore, all, dryRun } = parsed.data;
    const narrowed = ownerId !== undefined || createdBefore !== undefined;
    if (all && narrowed) return invalid(reply, 'conflicting_criteria');
    if (!all && !narrowed) return invalid(reply, 'criteria_required');
    const now = new Date();
    const count = await db.transaction().execute(async (trx) => {
      let query = trx
        .updateTable('api_token')
        .set({ revoked_at: now, revoked_by: admin.id })
        .where('workspace_id', '=', request.workspaceId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now);
      let counting = trx
        .selectFrom('api_token')
        .select((eb) => eb.fn.countAll<string>().as('n'))
        .where('workspace_id', '=', request.workspaceId)
        .where('revoked_at', 'is', null)
        .where('expires_at', '>', now);
      if (ownerId !== undefined) {
        query = query.where('user_id', '=', ownerId);
        counting = counting.where('user_id', '=', ownerId);
      }
      if (createdBefore !== undefined) {
        query = query.where('created_at', '<', new Date(createdBefore));
        counting = counting.where('created_at', '<', new Date(createdBefore));
      }
      if (dryRun) return Number((await counting.executeTakeFirstOrThrow()).n);
      const result = await query.executeTakeFirst();
      const revoked = Number(result.numUpdatedRows);
      if (revoked > 0) {
        await emit(trx, by(request, admin.id), {
          type: 'token.bulk_revoked',
          subjectId: request.workspaceId,
          payload: {
            count: revoked,
            ownerId: ownerId ?? null,
            createdBefore: createdBefore ? new Date(createdBefore).toISOString() : null,
            all: all === true,
          },
        });
      }
      return revoked;
    });
    return dryRun ? { matched: count } : { revoked: count };
  });

  app.get('/api/v1/admin/token-policy', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { policy: await tokenPolicy(db, request.workspaceId), limits: POLICY_LIMITS };
  });

  app.put('/api/v1/admin/token-policy', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = policyBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const asked: Partial<TokenPolicy> = {
      ...(parsed.data.maxLifetimeDays !== undefined
        ? { maxLifetimeDays: parsed.data.maxLifetimeDays }
        : {}),
      ...(parsed.data.reminderDays !== undefined ? { reminderDays: parsed.data.reminderDays } : {}),
    };
    const policy = await db.transaction().execute(async (trx) => {
      const before = await tokenPolicy(trx, request.workspaceId);
      const next: TokenPolicy = { ...before, ...asked };
      await trx
        .insertInto('token_policy')
        .values({
          workspace_id: request.workspaceId,
          max_lifetime_days: next.maxLifetimeDays,
          reminder_days: next.reminderDays,
          updated_at: new Date(),
        })
        .onConflict((oc) =>
          oc.column('workspace_id').doUpdateSet({
            max_lifetime_days: next.maxLifetimeDays,
            reminder_days: next.reminderDays,
            updated_at: new Date(),
          }),
        )
        .execute();
      const changes = diff({ ...before }, asked);
      if (Object.keys(changes).length > 0) {
        await emit(trx, by(request, admin.id), {
          type: 'token_policy.updated',
          subjectId: request.workspaceId,
          payload: { changes },
        });
      }
      return next;
    });
    return { policy, limits: POLICY_LIMITS };
  });

  /**
   * Revokes one token: the owner's own (`ownerId`) or any in the workspace (null, admins).
   * Revoking a revoked token changes nothing and tells nobody.
   */
  async function revokeOne(
    request: FastifyRequest,
    actorId: number,
    tokenId: number,
    ownerId: number | null,
  ): Promise<'revoked' | 'unchanged' | 'not_found'> {
    return db.transaction().execute(async (trx) => {
      let find = trx
        .selectFrom('api_token')
        .select(['id', 'user_id', 'revoked_at'])
        .where('id', '=', tokenId)
        .where('workspace_id', '=', request.workspaceId);
      if (ownerId !== null) find = find.where('user_id', '=', ownerId);
      const row = await find.forUpdate().executeTakeFirst();
      if (!row) return 'not_found';
      if (row.revoked_at) return 'unchanged';
      await trx
        .updateTable('api_token')
        .set({ revoked_at: new Date(), revoked_by: actorId })
        .where('id', '=', row.id)
        .execute();
      await emit(trx, by(request, actorId), {
        type: 'token.revoked',
        subjectId: row.id,
        payload: { ownerId: row.user_id, by: ownerId === null ? 'admin' : 'self' },
      });
      return 'revoked';
    });
  }
}

/** Rotation for people (their own tokens) and administrators (service-account tokens). */
export async function rotateAndReply(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  options: {
    tokenId: number;
    ownerId: number;
    actorId: number;
    by: 'self' | 'admin';
    body: z.infer<typeof rotateBody>;
  },
) {
  const { body } = options;
  const now = new Date();
  const policy = await tokenPolicy(db, request.workspaceId);
  let expiresAt: Date | null = null;
  if (body.expiresInDays !== undefined || body.expiresAt !== undefined) {
    const chosen = expiryFrom(body, policy, now);
    if (isExpiryProblem(chosen)) return expiryRefused(reply, chosen);
    expiresAt = chosen;
  }
  const outcome = await db.transaction().execute(async (trx) => {
    const rotated = await rotateApiToken(trx, {
      workspaceId: request.workspaceId,
      tokenId: options.tokenId,
      ownerId: options.ownerId,
      overlapHours: body.overlapHours,
      expiresAt,
      policy,
      actorId: options.actorId,
      now,
    });
    if (!rotated.ok) return rotated;
    const view = await findTokenView(trx, request.workspaceId, rotated.id);
    await emit(
      trx,
      { workspaceId: request.workspaceId, actorId: options.actorId },
      {
        type: 'token.rotated',
        subjectId: rotated.id,
        payload: {
          ownerId: rotated.previous.userId,
          replaces: rotated.previous.id,
          overlapHours: body.overlapHours,
          expiresAt: view?.expiresAt ?? '',
          by: options.by,
        },
      },
    );
    return rotated;
  });
  if (!outcome.ok) {
    return reply
      .code(outcome.error === 'not_found' ? 404 : 409)
      .send({ error: outcome.error === 'not_found' ? 'not_found' : 'not_active' });
  }
  const [view, previous] = await Promise.all([
    findTokenView(db, request.workspaceId, outcome.id),
    findTokenView(db, request.workspaceId, outcome.previous.id),
  ]);
  return reply.code(201).send({ token: outcome.token, apiToken: view, previous });
}
