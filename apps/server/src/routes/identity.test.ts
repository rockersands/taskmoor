import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword, hashPasswordScryptForTests, LOCKOUT, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE, SESSION_IDLE_MS } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
/** Each test signs in from its own address, so per-address limits never leak between tests. */
const nextAddress = () => `198.51.100.${++address}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

describe('sign-in, lockout, sessions and the account (M1-001)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;

  async function createUser(
    email: string,
    options: { password?: string; scrypt?: boolean; admin?: boolean; workspaceId?: number } = {},
  ): Promise<number> {
    const password = options.password ?? PASSWORD;
    const hash = options.scrypt
      ? await hashPasswordScryptForTests(password)
      : await hashPassword(password);
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: options.workspaceId ?? 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: hash,
        is_site_admin: options.admin ?? false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  function signIn(email: string, password: string, remoteAddress = nextAddress()) {
    return app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress,
    });
  }

  async function signedIn(email: string, password = PASSWORD): Promise<string> {
    const res = await signIn(email, password);
    expect(res.statusCode).toBe(200);
    return sessionCookie(res.headers['set-cookie']);
  }

  const me = (cookie: string) =>
    app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
  });
  afterAll(async () => {
    await app.close();
  });

  describe('sign-in', () => {
    it('[IAM-001] signs in and replaces an M0 scrypt hash with Argon2id on the way', async () => {
      await createUser('legacy@example.com', { scrypt: true });
      const res = await signIn('Legacy@Example.com', PASSWORD);
      expect(res.statusCode).toBe(200);
      expect(res.json().user).toMatchObject({ email: 'legacy@example.com', isSiteAdmin: false });
      const row = await database.db
        .selectFrom('app_user')
        .select(['password_hash', 'last_sign_in_at'])
        .where('email', '=', 'legacy@example.com')
        .executeTakeFirstOrThrow();
      expect(row.password_hash).toMatch(/^\$argon2id\$/);
      expect(row.last_sign_in_at).not.toBeNull();
      // The new hash works too.
      expect((await signIn('legacy@example.com', PASSWORD)).statusCode).toBe(200);
    });

    it('[IAM-001] answers the same for an unknown email, a wrong password and a deactivated account', async () => {
      const id = await createUser('gone@example.com');
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', id)
        .execute();
      await createUser('here@example.com');
      const answers = await Promise.all([
        signIn('nobody@example.com', PASSWORD),
        signIn('here@example.com', 'not the password at all'),
        signIn('gone@example.com', PASSWORD),
      ]);
      for (const res of answers) {
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'invalid_credentials' });
      }
    });

    it('[IAM-001] locks an email after five failures and refuses even the right password while locked', async () => {
      await createUser('target@example.com');
      for (let i = 0; i < LOCKOUT.freeFailures; i++) {
        expect((await signIn('target@example.com', `wrong guess ${i}`)).statusCode).toBe(401);
      }
      const locked = await signIn('target@example.com', PASSWORD);
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toMatchObject({ error: 'too_many_attempts' });
      const wait = Number(locked.headers['retry-after']);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(LOCKOUT.baseSeconds);

      // When the lock has run out, the right password works and clears the counter.
      await database.db
        .updateTable('sign_in_throttle')
        .set({ locked_until: new Date(Date.now() - 1000) })
        .where('key', '=', 'email:target@example.com')
        .execute();
      expect((await signIn('target@example.com', PASSWORD)).statusCode).toBe(200);
      const left = await database.db
        .selectFrom('sign_in_throttle')
        .select('failures')
        .where('key', '=', 'email:target@example.com')
        .executeTakeFirst();
      expect(left).toBeUndefined();
    });

    it('[IAM-001] doubles the lock with every further failure', async () => {
      await createUser('stubborn@example.com');
      const waits: number[] = [];
      for (let i = 0; i < LOCKOUT.freeFailures + 3; i++) {
        const res = await signIn('stubborn@example.com', `wrong guess ${i}`);
        if (res.statusCode === 429) {
          // Expire the lock so the next guess is counted, like an attacker who waits.
          await database.db
            .updateTable('sign_in_throttle')
            .set({ locked_until: new Date(Date.now() - 1000) })
            .where('key', '=', 'email:stubborn@example.com')
            .execute();
          continue;
        }
        const row = await database.db
          .selectFrom('sign_in_throttle')
          .select(['locked_until', 'updated_at'])
          .where('key', '=', 'email:stubborn@example.com')
          .executeTakeFirstOrThrow();
        if (row.locked_until) {
          waits.push(Math.round((row.locked_until.getTime() - row.updated_at.getTime()) / 1000));
        }
      }
      expect(waits.slice(0, 2)).toEqual([30, 60]);
    });

    it('[IAM-001] throttles an email that has no account exactly like one that has', async () => {
      for (let i = 0; i < LOCKOUT.freeFailures; i++) {
        expect((await signIn('ghost@example.com', `guess ${i}`)).statusCode).toBe(401);
      }
      expect((await signIn('ghost@example.com', PASSWORD)).statusCode).toBe(429);
    });

    it('[IAM-001] limits one address to 50 failures in 15 minutes, across emails', async () => {
      await createUser('innocent@example.com');
      const from = nextAddress();
      for (let i = 0; i < LOCKOUT.addressFailures; i++) {
        expect((await signIn(`walker${i}@example.com`, 'guessing', from)).statusCode).toBe(401);
      }
      expect((await signIn('innocent@example.com', PASSWORD, from)).statusCode).toBe(429);
      // Another address is not affected.
      expect((await signIn('innocent@example.com', PASSWORD)).statusCode).toBe(200);
    });

    it('[IAM-001] forgets old failures after a day', async () => {
      await createUser('forgetful@example.com');
      for (let i = 0; i < 4; i++) await signIn('forgetful@example.com', `guess ${i}`);
      await database.db
        .updateTable('sign_in_throttle')
        .set({ updated_at: new Date(Date.now() - 25 * 60 * 60 * 1000) })
        .where('key', '=', 'email:forgetful@example.com')
        .execute();
      await signIn('forgetful@example.com', 'one more guess');
      const row = await database.db
        .selectFrom('sign_in_throttle')
        .select('failures')
        .where('key', '=', 'email:forgetful@example.com')
        .executeTakeFirstOrThrow();
      expect(row.failures).toBe(1);
    });
  });

  describe('sessions', () => {
    it('[IAM-004] keeps only a hash of the session token', async () => {
      await createUser('hashed@example.com');
      const cookie = await signedIn('hashed@example.com');
      const token = cookie.split('=')[1] ?? '';
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const { rows } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM user_session WHERE token_hash = ${tokenHash(token)}`.execute(
        database.db,
      );
      expect(Number(rows[0]?.n)).toBe(1);
      const { rows: raw } = await sql<{ n: string }>`
        SELECT count(*) AS n FROM user_session WHERE token_hash = ${token}`.execute(database.db);
      expect(Number(raw[0]?.n)).toBe(0);
    });

    it('[IAM-004] lists the sessions with the current one marked and signs out the others', async () => {
      await createUser('many@example.com');
      const laptop = await signedIn('many@example.com');
      const phone = await signedIn('many@example.com');
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions',
        headers: { cookie: laptop },
      });
      expect(list.statusCode).toBe(200);
      const sessions = list.json().sessions as { current: boolean; ip: string }[];
      expect(sessions).toHaveLength(2);
      expect(sessions.filter((s) => s.current)).toHaveLength(1);
      expect(sessions.every((s) => s.ip.startsWith('198.51.100.'))).toBe(true);

      const others = await app.inject({
        method: 'DELETE',
        url: '/api/v1/sessions/others',
        headers: { cookie: laptop },
      });
      expect(others.json()).toEqual({ revoked: 1 });
      expect((await me(phone)).statusCode).toBe(401);
      expect((await me(laptop)).statusCode).toBe(200);
    });

    it('[IAM-004] signs a revoked browser out at its next request', async () => {
      await createUser('revoker@example.com');
      const first = await signedIn('revoker@example.com');
      const second = await signedIn('revoker@example.com');
      const list = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions',
        headers: { cookie: first },
      });
      const other = (list.json().sessions as { id: number; current: boolean }[]).find(
        (s) => !s.current,
      );
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${other?.id}`,
        headers: { cookie: first },
      });
      expect(res.statusCode).toBe(204);
      expect((await me(second)).statusCode).toBe(401);

      // Someone else's session is not found, rather than revoked.
      await createUser('bystander@example.com');
      const bystander = await signedIn('bystander@example.com');
      const theirs = await app.inject({
        method: 'GET',
        url: '/api/v1/sessions',
        headers: { cookie: bystander },
      });
      const theirId = (theirs.json().sessions as { id: number }[])[0]?.id;
      const denied = await app.inject({
        method: 'DELETE',
        url: `/api/v1/sessions/${theirId}`,
        headers: { cookie: first },
      });
      expect(denied.statusCode).toBe(404);
      expect((await me(bystander)).statusCode).toBe(200);
    });

    it('[IAM-004] ends a session after the idle timeout and after its lifetime', async () => {
      await createUser('idle@example.com');
      const idle = await signedIn('idle@example.com');
      const old = await signedIn('idle@example.com');
      const hashOf = (cookie: string) => tokenHash(cookie.split('=')[1] ?? '');
      await database.db
        .updateTable('user_session')
        .set({ last_seen_at: new Date(Date.now() - SESSION_IDLE_MS - 1000) })
        .where('token_hash', '=', hashOf(idle))
        .execute();
      await database.db
        .updateTable('user_session')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('token_hash', '=', hashOf(old))
        .execute();
      expect((await me(idle)).statusCode).toBe(401);
      expect((await me(old)).statusCode).toBe(401);
    });

    it('[IAM-008] stops the sessions of a deactivated person', async () => {
      const id = await createUser('leaver@example.com');
      const cookie = await signedIn('leaver@example.com');
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', id)
        .execute();
      expect((await me(cookie)).statusCode).toBe(401);
    });

    it('[IAM-004] deletes the session on sign-out, so the old cookie no longer works', async () => {
      await createUser('leaving@example.com');
      const cookie = await signedIn('leaving@example.com');
      const out = await app.inject({
        method: 'DELETE',
        url: '/api/v1/session',
        headers: { cookie },
      });
      expect(out.statusCode).toBe(204);
      expect((await me(cookie)).statusCode).toBe(401);
    });
  });

  describe('own account', () => {
    it('[IAM-001] changes the password with the current one and signs the other browsers out', async () => {
      await createUser('changer@example.com');
      const here = await signedIn('changer@example.com');
      const elsewhere = await signedIn('changer@example.com');
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/account/password',
        headers: { cookie: here },
        payload: { currentPassword: PASSWORD, newPassword: 'quiet otter lantern' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ signedOutSessions: 1 });
      expect((await me(here)).statusCode).toBe(200);
      expect((await me(elsewhere)).statusCode).toBe(401);
      expect((await signIn('changer@example.com', PASSWORD)).statusCode).toBe(401);
      expect((await signIn('changer@example.com', 'quiet otter lantern')).statusCode).toBe(200);
    });

    it('[IAM-001] refuses a wrong current password, counts it, and refuses weak new ones', async () => {
      await createUser('careful@example.com');
      const cookie = await signedIn('careful@example.com');
      const change = (currentPassword: string, newPassword: string) =>
        app.inject({
          method: 'PUT',
          url: '/api/v1/account/password',
          headers: { cookie },
          payload: { currentPassword, newPassword },
          remoteAddress: nextAddress(),
        });
      const weak = await change(PASSWORD, 'careful@example.com is me');
      expect(weak.statusCode).toBe(400);
      expect(weak.json().codes).toEqual(['contains_identity']);
      const common = await change(PASSWORD, 'qwerty123456');
      expect(common.json().codes).toEqual(['common']);

      for (let i = 0; i < LOCKOUT.freeFailures; i++) {
        expect((await change(`wrong ${i}`, 'quiet otter lantern')).statusCode).toBe(403);
      }
      expect((await change(PASSWORD, 'quiet otter lantern')).statusCode).toBe(429);
    });

    it('[IAM-008] updates the name, time zone and locale and refuses invalid ones', async () => {
      await createUser('profile@example.com');
      const cookie = await signedIn('profile@example.com');
      const patch = (payload: object) =>
        app.inject({ method: 'PATCH', url: '/api/v1/account', headers: { cookie }, payload });
      const ok = await patch({
        name: 'Pro File',
        timeZone: 'America/Mexico_City',
        locale: 'es-mx',
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json().user).toMatchObject({
        name: 'Pro File',
        timeZone: 'America/Mexico_City',
        locale: 'es-MX',
      });
      expect((await me(cookie)).json().user).toMatchObject({ timeZone: 'America/Mexico_City' });
      expect((await patch({ timeZone: 'Mars/Olympus_Mons' })).json()).toEqual({
        error: 'invalid_time_zone',
      });
      expect((await patch({ locale: 'not a locale!' })).json()).toEqual({
        error: 'invalid_locale',
      });
      expect((await patch({ isSiteAdmin: true })).statusCode).toBe(400);
      // Any letter case is accepted and stored as Intl spells it.
      const lower = await patch({ timeZone: 'europe/madrid' });
      expect(lower.json().user.timeZone).toBe('Europe/Madrid');
      const cleared = await patch({ timeZone: null, locale: null });
      expect(cleared.json().user).toMatchObject({ timeZone: null, locale: null });
    });

    it('[IAM-008] needs a session for every account route', async () => {
      const calls = [
        app.inject({ method: 'GET', url: '/api/v1/sessions' }),
        app.inject({ method: 'DELETE', url: '/api/v1/sessions/others' }),
        app.inject({ method: 'DELETE', url: '/api/v1/sessions/1' }),
        app.inject({ method: 'PATCH', url: '/api/v1/account', payload: { name: 'x' } }),
        app.inject({
          method: 'PUT',
          url: '/api/v1/account/password',
          payload: { currentPassword: 'a', newPassword: 'b' },
        }),
      ];
      for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
    });
  });

  describe('workspace scoping', () => {
    it('keeps the people of another workspace out of this one', async () => {
      const other = await database.db
        .insertInto('workspace')
        .values({ key: 'other', name: 'Other' })
        .returning('id')
        .executeTakeFirstOrThrow();
      await createUser('shared@example.com');
      // The same email may exist in another workspace, with its own password.
      await createUser('shared@example.com', {
        workspaceId: other.id,
        password: 'another workspace pass',
      });
      expect((await signIn('shared@example.com', 'another workspace pass')).statusCode).toBe(401);
      expect((await signIn('shared@example.com', PASSWORD)).statusCode).toBe(200);

      // A session row of the other workspace does not sign anyone in here.
      const cookie = await signedIn('shared@example.com');
      await database.db
        .updateTable('user_session')
        .set({ workspace_id: other.id })
        .where('token_hash', '=', tokenHash(cookie.split('=')[1] ?? ''))
        .execute();
      expect((await me(cookie)).statusCode).toBe(401);
    });
  });
});
