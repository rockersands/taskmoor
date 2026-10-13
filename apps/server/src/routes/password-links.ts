import type { Database } from '@taskmoor/db';
import {
  checkPassword,
  describePasswordProblem,
  type PasswordHasher,
  tokenHash,
} from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { revokeUserSessions, startSession } from '../auth';
import { lockedUntil, recordFailure, secondsUntil } from '../throttle';

const inspectBody = z.object({ token: z.string().min(1).max(200) });
const redeemBody = z.object({ token: z.string().min(1).max(200), password: z.string().max(1024) });

/**
 * One-time password links (IAM-001): a person opens the link an administrator gave them and
 * chooses a password. The token travels in the request body, never in a URL the server logs.
 * Unknown or used tokens count against the client address like failed sign-ins do.
 */
export function registerPasswordLinkRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { secureCookies: boolean; passwords: PasswordHasher },
): void {
  async function findLink(request: FastifyRequest, token: string) {
    return db
      .selectFrom('password_link as l')
      .innerJoin('app_user as u', 'u.id', 'l.user_id')
      .select(['l.id', 'l.purpose', 'u.id as userId', 'u.email', 'u.name'])
      .where('l.token_hash', '=', tokenHash(token))
      .where('l.workspace_id', '=', request.workspaceId)
      .where('l.used_at', 'is', null)
      .where('l.expires_at', '>', new Date())
      .where('u.deactivated_at', 'is', null)
      .executeTakeFirst();
  }

  /** Answers 429 while the address is locked; returns false when the request may go on. */
  async function throttled(request: FastifyRequest, reply: FastifyReply): Promise<boolean> {
    const until = await lockedUntil(db, request.workspaceId, [`ip:${request.ip}`]);
    if (!until) return false;
    const retryAfter = secondsUntil(until);
    await reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send({ error: 'too_many_attempts', retryAfterSeconds: retryAfter });
    return true;
  }

  async function invalid(request: FastifyRequest, reply: FastifyReply) {
    await recordFailure(db, request.workspaceId, { address: `ip:${request.ip}` });
    return reply.code(404).send({ error: 'invalid_link' });
  }

  app.post('/api/v1/password-links/inspect', async (request, reply) => {
    const parsed = inspectBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (await throttled(request, reply)) return reply;
    const link = await findLink(request, parsed.data.token);
    if (!link) return invalid(request, reply);
    return { purpose: link.purpose, name: link.name, email: link.email };
  });

  app.post('/api/v1/password-links/redeem', async (request, reply) => {
    const parsed = redeemBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    if (await throttled(request, reply)) return reply;
    const link = await findLink(request, parsed.data.token);
    if (!link) return invalid(request, reply);
    const problems = checkPassword(parsed.data.password, { identity: [link.email, link.name] });
    if (problems.length > 0) {
      return reply.code(400).send({
        error: 'weak_password',
        codes: problems,
        problems: problems.map((p) => `password: ${describePasswordProblem(p)}`),
      });
    }
    const passwordHash = await options.passwords.hash(parsed.data.password);
    const now = new Date();
    const used = await db.transaction().execute(async (trx) => {
      // Marking the link used first makes a second, concurrent redemption find nothing.
      const marked = await trx
        .updateTable('password_link')
        .set({ used_at: now })
        .where('id', '=', link.id)
        .where('used_at', 'is', null)
        .executeTakeFirst();
      if (Number(marked.numUpdatedRows) === 0) return false;
      await trx
        .updateTable('app_user')
        .set({ password_hash: passwordHash, password_changed_at: now, updated_at: now })
        .where('id', '=', link.userId)
        .execute();
      return true;
    });
    if (!used) return invalid(request, reply);
    await revokeUserSessions(db, request.workspaceId, link.userId);
    await startSession(db, request, reply, { userId: link.userId, secure: options.secureCookies });
    const user = await db
      .selectFrom('app_user')
      .select(['id', 'email', 'name', 'is_site_admin', 'time_zone', 'locale'])
      .where('id', '=', link.userId)
      .executeTakeFirstOrThrow();
    return {
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        isSiteAdmin: user.is_site_admin,
        timeZone: user.time_zone,
        locale: user.locale,
      },
    };
  });
}

const checkBody = z.object({
  password: z.string().max(1024),
  email: z.string().max(320).optional(),
  name: z.string().max(200).optional(),
});

/**
 * Live feedback for password fields (ASVS 2.1.8): the same policy the server enforces, without
 * shipping the breached-password list to the browser. Nothing is stored or logged.
 */
export function registerPasswordCheckRoute(app: FastifyInstance): void {
  app.post('/api/v1/password-check', async (request, reply) => {
    const parsed = checkBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const identity = [
      parsed.data.email,
      parsed.data.name,
      request.user?.email,
      request.user?.name,
    ].filter((v): v is string => Boolean(v));
    const codes = checkPassword(parsed.data.password, { identity });
    return {
      ok: codes.length === 0,
      codes,
      problems: codes.map((p) => describePasswordProblem(p)),
    };
  });
}
