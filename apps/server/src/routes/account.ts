import type { Database } from '@taskmoor/db';
import {
  checkPassword,
  describePasswordProblem,
  type PasswordHasher,
  throttleKeys,
} from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireUser, revokeUserSessions } from '../auth';
import { canonicalTimeZone, validLocale, validTimeZone } from '../directory';
import { diff, withEvent } from '../events/bus';
import { clearFailures, lockedUntil, recordFailure, secondsUntil } from '../throttle';

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timeZone: z.string().trim().min(1).max(64).nullable().optional(),
    locale: z.string().trim().min(2).max(35).nullable().optional(),
  })
  .strict();

const passwordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().max(1024),
});

/**
 * The signed-in person's own account (IAM-008 profile; IAM-001 password change). Changing the
 * password needs the current one (ASVS 2.1.5, 2.1.6), counts wrong answers like sign-in does,
 * and signs every other browser out (ASVS 3.3.3).
 */
export function registerAccountRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  { passwords }: { passwords: PasswordHasher },
): void {
  app.patch('/api/v1/account', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = profileBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { name, timeZone, locale } = parsed.data;
    if (timeZone && !validTimeZone(timeZone)) {
      return reply.code(400).send({ error: 'invalid_time_zone' });
    }
    if (locale && !validLocale(locale)) return reply.code(400).send({ error: 'invalid_locale' });
    const changes = {
      ...(name !== undefined ? { name } : {}),
      ...(timeZone !== undefined
        ? { time_zone: timeZone ? canonicalTimeZone(timeZone) : null }
        : {}),
      ...(locale !== undefined
        ? { locale: locale ? (Intl.getCanonicalLocales(locale)[0] ?? null) : null }
        : {}),
    };
    const row = await withEvent(
      db,
      { workspaceId: request.workspaceId, actorId: user.id },
      async (trx) => {
        const before = await trx
          .selectFrom('app_user')
          .select(['name', 'time_zone', 'locale'])
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow();
        const updated = await trx
          .updateTable('app_user')
          .set({ ...changes, updated_at: new Date() })
          .where('id', '=', user.id)
          .where('workspace_id', '=', request.workspaceId)
          .returning(['id', 'email', 'name', 'is_site_admin', 'time_zone', 'locale'])
          .executeTakeFirstOrThrow();
        const changed = diff(before, changes);
        return {
          result: updated,
          event:
            Object.keys(changed).length > 0
              ? { type: 'user.updated', subjectId: user.id, payload: { changes: changed } }
              : null,
        };
      },
    );
    return {
      user: {
        id: row.id,
        email: row.email,
        name: row.name,
        isSiteAdmin: row.is_site_admin,
        timeZone: row.time_zone,
        locale: row.locale,
      },
    };
  });

  app.put('/api/v1/account/password', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = passwordBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { currentPassword, newPassword } = parsed.data;
    const workspaceId = request.workspaceId;
    const keys = throttleKeys(user.email, request.ip);
    const now = new Date();

    const locked = await lockedUntil(db, workspaceId, [keys.account, keys.address], now);
    if (locked) {
      const retryAfter = secondsUntil(locked, now);
      return reply
        .code(429)
        .header('retry-after', String(retryAfter))
        .send({ error: 'too_many_attempts', retryAfterSeconds: retryAfter });
    }
    const row = await db
      .selectFrom('app_user')
      .select('password_hash')
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    if (!row.password_hash || !(await passwords.verify(currentPassword, row.password_hash))) {
      await recordFailure(db, workspaceId, keys, now);
      return reply.code(403).send({ error: 'wrong_password' });
    }
    await clearFailures(db, workspaceId, keys.account);

    const problems = checkPassword(newPassword, { identity: [user.email, user.name] });
    if (problems.length > 0) {
      return reply.code(400).send({
        error: 'weak_password',
        codes: problems,
        problems: problems.map((p) => `newPassword: ${describePasswordProblem(p)}`),
      });
    }
    const newHash = await passwords.hash(newPassword);
    const signedOut = await withEvent(db, { workspaceId, actorId: user.id }, async (trx) => {
      await trx
        .updateTable('app_user')
        .set({ password_hash: newHash, password_changed_at: now, updated_at: now })
        .where('id', '=', user.id)
        .execute();
      const ended = await revokeUserSessions(trx, workspaceId, user.id, request.authSession?.id);
      return {
        result: ended,
        event: {
          type: 'user.password_changed',
          subjectId: user.id,
          payload: { via: 'self', endedSessions: ended },
        },
      };
    });
    return { signedOutSessions: signedOut };
  });
}
