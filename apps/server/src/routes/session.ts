import type { Database } from '@taskmoor/db';
import { type PasswordHasher, throttleKeys } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import {
  clearSessionCookies,
  endSession,
  requireUser,
  revokeUserSessions,
  startSession,
} from '../auth';
import { withEvent } from '../events/bus';
import { clearFailures, lockedUntil, recordFailure, secondsUntil } from '../throttle';

const signInBody = z.object({
  email: z.string().trim().min(1).max(320),
  // Long enough for any policy's maximum; the hash never sees more.
  password: z.string().min(1).max(1024),
});

const sessionId = z.object({ id: z.coerce.number().int().positive() });

/**
 * Who am I, sign in, sign out (ADR-032), and the signed-in person's own sessions (IAM-004).
 *
 * Sign-in answers the same way for an unknown email, a deactivated account and a wrong
 * password, and takes as long (a dummy hash is checked), so it cannot be used to find accounts.
 * Every attempt counts against the submitted email and the client address (IAM-001 lockout);
 * while either is locked the password is not even checked.
 */
export function registerSessionRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { secureCookies: boolean; passwords: PasswordHasher },
): void {
  app.get('/api/v1/session', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'not_signed_in' });
    const user = { ...request.user, isSiteAdmin: await request.authz.isSiteAdmin() };
    // A program holding a token can ask what it is and what it may do (IAM-007).
    if (request.apiToken) {
      return { user, apiToken: { id: request.apiToken.id, scopes: request.apiToken.scopes } };
    }
    return { user };
  });

  app.post('/api/v1/session', async (request, reply) => {
    const parsed = signInBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { email, password } = parsed.data;
    const workspaceId = request.workspaceId;
    const keys = throttleKeys(email, request.ip);
    const now = new Date();

    const locked = await lockedUntil(db, workspaceId, [keys.account, keys.address], now);
    if (locked) {
      const retryAfter = secondsUntil(locked, now);
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'too_many_attempts', retryAfterSeconds: retryAfter });
    }

    const user = await db
      .selectFrom('app_user')
      .select(['id', 'email', 'name', 'password_hash', 'is_site_admin', 'time_zone', 'locale'])
      .where('workspace_id', '=', workspaceId)
      .where(sql<string>`lower(email)`, '=', email.toLowerCase())
      .where('deactivated_at', 'is', null)
      // Service accounts have no password and never sign in (IAM-007).
      .where('kind', '=', 'person')
      .executeTakeFirst();
    const { passwords } = options;
    const ok = user?.password_hash
      ? await passwords.verify(password, user.password_hash)
      : await passwords.verifyDummy(password);
    if (!user || !ok) {
      await recordFailure(db, workspaceId, keys, now);
      return reply.code(401).send({ error: 'invalid_credentials' });
    }

    await clearFailures(db, workspaceId, keys.account);
    // Older schemes (M0's scrypt, no pepper, a lower cost) are replaced at the first sign-in.
    const rehash = user.password_hash && passwords.needsRehash(user.password_hash);
    const newHash = rehash ? await passwords.hash(password) : undefined;
    await withEvent(db, { workspaceId, actorId: user.id }, async (trx) => {
      await trx
        .updateTable('app_user')
        .set({ last_sign_in_at: now, ...(newHash ? { password_hash: newHash } : {}) })
        .where('id', '=', user.id)
        .execute();
      const sessionId = await startSession(trx, request, reply, {
        userId: user.id,
        secure: options.secureCookies,
      });
      return {
        result: sessionId,
        event: {
          type: 'session.started',
          subjectId: user.id,
          payload: { sessionId, method: 'password' },
        },
      };
    });
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

  app.delete('/api/v1/session', async (request, reply) => {
    const userId = request.user?.id ?? null;
    await withEvent(db, { workspaceId: request.workspaceId, actorId: userId }, async (trx) => {
      const ended = await endSession(trx, request, reply);
      // Only a live session's end is an event; a stale cookie just gets cleared.
      return {
        result: ended,
        event:
          ended !== null && userId !== null
            ? { type: 'session.ended', subjectId: userId, payload: { sessionId: ended } }
            : null,
      };
    });
    return reply.code(204).send();
  });

  // The signed-in person's sessions, newest activity first, with the current one marked.
  app.get('/api/v1/sessions', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const rows = await db
      .selectFrom('user_session')
      .select(['id', 'created_at', 'last_seen_at', 'expires_at', 'ip', 'user_agent'])
      .where('workspace_id', '=', request.workspaceId)
      .where('user_id', '=', user.id)
      .where('expires_at', '>', new Date())
      .orderBy('last_seen_at', 'desc')
      .orderBy('id', 'desc')
      .execute();
    return {
      sessions: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at.toISOString(),
        lastSeenAt: r.last_seen_at.toISOString(),
        expiresAt: r.expires_at.toISOString(),
        ip: r.ip,
        userAgent: r.user_agent,
        current: r.id === request.authSession?.id,
      })),
    };
  });

  // Sign out every other browser.
  app.delete('/api/v1/sessions/others', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const revoked = await withEvent(
      db,
      { workspaceId: request.workspaceId, actorId: user.id },
      async (trx) => {
        const count = await revokeUserSessions(
          trx,
          request.workspaceId,
          user.id,
          request.authSession?.id,
        );
        return {
          result: count,
          event:
            count > 0
              ? { type: 'session.revoked', subjectId: user.id, payload: { count, by: 'self' } }
              : null,
        };
      },
    );
    return { revoked };
  });

  app.delete('/api/v1/sessions/:id', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = sessionId.safeParse(request.params);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const deleted = await withEvent(
      db,
      { workspaceId: request.workspaceId, actorId: user.id },
      async (trx) => {
        const result = await trx
          .deleteFrom('user_session')
          .where('id', '=', parsed.data.id)
          .where('workspace_id', '=', request.workspaceId)
          .where('user_id', '=', user.id)
          .executeTakeFirst();
        const count = Number(result.numDeletedRows);
        return {
          result: count,
          event:
            count > 0
              ? { type: 'session.revoked', subjectId: user.id, payload: { count, by: 'self' } }
              : null,
        };
      },
    );
    if (deleted === 0) return reply.code(404).send({ error: 'not_found' });
    if (parsed.data.id === request.authSession?.id) clearSessionCookies(reply);
    return reply.code(204).send();
  });
}
