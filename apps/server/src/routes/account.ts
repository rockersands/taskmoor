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
import { AUDIT_ACTIONS, recordRefusedAttempt } from '../audit/record';
import { requireUser, revokeUserSessions } from '../auth';
import { canonicalTimeZone, validLocale, validTimeZone } from '../directory';
import { diff, withEvent } from '../events/bus';
import {
  type DirectoryGateway,
  directoryFailure,
  directoryManaged,
  readOnly,
} from '../ldap/gateway';
import { clearFailures, lockedUntil, recordFailure, secondsUntil } from '../throttle';

const profileBody = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    timeZone: z.string().trim().min(1).max(64).nullable().optional(),
    locale: z.string().trim().min(2).max(35).nullable().optional(),
    /**
     * `system` or a skin name (M1-122, ADR-036). Only the shape is checked: the frontend owns
     * the list of skins and treats a name it does not know as `system`.
     */
    appearance: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/)
      .optional(),
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
  { passwords, directories }: { passwords: PasswordHasher; directories: DirectoryGateway },
): void {
  app.patch('/api/v1/account', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = profileBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { name, timeZone, locale, appearance } = parsed.data;
    if (timeZone && !validTimeZone(timeZone)) {
      return reply.code(400).send({ error: 'invalid_time_zone' });
    }
    if (locale && !validLocale(locale)) return reply.code(400).send({ error: 'invalid_locale' });
    // M1-082: a directory owns the name of the accounts it manages; a read-write one takes the
    // change. Time zone, locale and appearance are Taskmoor's.
    if (name !== undefined && name !== user.name) {
      const managed = await directories.account(request.workspaceId, user.id);
      if (managed) {
        if (readOnly(managed.directory.mode)) return directoryManaged(reply, managed.directory);
        const failure = await directories.writeProfile(managed, { name });
        if (failure) return directoryFailure(reply, failure);
      }
    }
    const changes = {
      ...(name !== undefined ? { name } : {}),
      ...(timeZone !== undefined
        ? { time_zone: timeZone ? canonicalTimeZone(timeZone) : null }
        : {}),
      ...(locale !== undefined
        ? { locale: locale ? (Intl.getCanonicalLocales(locale)[0] ?? null) : null }
        : {}),
      ...(appearance !== undefined ? { appearance } : {}),
    };
    const row = await withEvent(
      db,
      { workspaceId: request.workspaceId, actorId: user.id },
      async (trx) => {
        const before = await trx
          .selectFrom('app_user')
          .select(['name', 'time_zone', 'locale', 'appearance'])
          .where('id', '=', user.id)
          .executeTakeFirstOrThrow();
        const updated = await trx
          .updateTable('app_user')
          .set({ ...changes, updated_at: new Date() })
          .where('id', '=', user.id)
          .where('workspace_id', '=', request.workspaceId)
          .returning(['id', 'email', 'name', 'is_site_admin', 'time_zone', 'locale', 'appearance'])
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
        appearance: row.appearance,
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
      .select(['password_hash', 'break_glass'])
      .where('id', '=', user.id)
      .executeTakeFirstOrThrow();
    // M1-082: a directory holds the password of the accounts it manages. A read-only one is
    // changed there; a read-write one takes the change from here, as the person.
    const managed = row.break_glass ? null : await directories.account(workspaceId, user.id);
    if (managed && readOnly(managed.directory.mode)) {
      return directoryManaged(reply, managed.directory);
    }
    const verdict = managed
      ? await directories.verifyPassword(managed, currentPassword)
      : row.password_hash && (await passwords.verify(currentPassword, row.password_hash))
        ? 'ok'
        : 'invalid';
    if (verdict === 'unavailable') return directoryFailure(reply, 'directory_unavailable');
    if (verdict !== 'ok') {
      const lock = await recordFailure(db, workspaceId, keys, now);
      await recordRefusedAttempt(db, AUDIT_ACTIONS.passwordCheckFailed, {
        workspaceId,
        ip: request.ip,
        actorId: user.id,
        userId: user.id,
        lockedUntil: lock,
      });
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
    if (managed) {
      const changed = await directories.changePassword(managed, currentPassword, newPassword);
      if (changed === 'unavailable') return directoryFailure(reply, 'directory_unavailable');
      // The directory's own password policy or history refused it.
      if (changed !== 'ok') return directoryFailure(reply, 'directory_refused');
    }
    const newHash = managed ? null : await passwords.hash(newPassword);
    const signedOut = await withEvent(db, { workspaceId, actorId: user.id }, async (trx) => {
      await trx
        .updateTable('app_user')
        .set({
          ...(newHash ? { password_hash: newHash } : {}),
          password_changed_at: now,
          updated_at: now,
        })
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
