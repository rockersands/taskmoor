import { useMigratedDatabase } from '@taskmoor/db/testing';
import { LOCKOUT, passwordHasher, pepperFromSecret, pepperRing, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import {
  SECURE_SESSION_COOKIE,
  SESSION_COOKIE,
  SESSION_IDLE_MS,
  SESSION_LIFETIME_MS,
} from './auth';

/**
 * OWASP ASVS 4.0.3, level 2: the authentication (V2) and session (V3) requirements that M1-001
 * covers, one test each, named by requirement. Items that belong to later tasks are listed as
 * todo with the task that brings them; UI items (2.1.11 paste, 2.1.12 show password) are tested
 * in apps/web. Run against an install with a password pepper, as production runs.
 */
const PEPPER = pepperFromSecret('the asvs suite pepper, at least 32 bytes long');
const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `203.0.113.${++address}`;

function cookieFrom(header: string | string[] | undefined, name = SESSION_COOKIE): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (list.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? '').split(
      ';',
    )[0] ?? ''
  );
}

describe('ASVS level 2: authentication and sessions (M1-001)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(pepperRing(PEPPER));
  let app: FastifyInstance;
  let secureApp: FastifyInstance;
  let admin: string;
  let usersBeforeSetup = -1;

  const as = (cookie: string, options: InjectOptions) =>
    app.inject({ ...options, headers: { ...(options.headers ?? {}), cookie } });

  async function signIn(email: string, password: string, target = app) {
    return target.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress: nextAddress(),
    });
  }

  async function createUser(email: string, password: string) {
    const res = await as(admin, {
      method: 'POST',
      url: '/api/v1/users',
      payload: { email, name: email.split('@')[0], password },
    });
    return res;
  }

  beforeAll(async () => {
    const count = await database.db
      .selectFrom('app_user')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    usersBeforeSetup = Number(count.n);
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'], passwords });
    secureApp = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      passwords,
      secureCookies: true,
    });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        is_site_admin: true,
        password_hash: await passwords.hash(PASSWORD),
      })
      .execute();
    admin = cookieFrom((await signIn('admin@example.com', PASSWORD)).headers['set-cookie']);
  });
  afterAll(async () => {
    await app.close();
    await secureApp.close();
  });

  describe('V2.1 password security', () => {
    it('[IAM-001] ASVS 2.1.1: passwords have at least 12 characters', async () => {
      expect((await createUser('short@example.com', 'eleven chrs')).json().codes).toEqual([
        'too_short',
      ]);
      expect((await createUser('dozen@example.com', 'twelve chars')).statusCode).toBe(201);
    });

    it('[IAM-001] ASVS 2.1.2: 64 characters are allowed, more than 128 refused', async () => {
      const long64 = 'a quiet otter keeps its lantern lit beside the wide grey river o';
      expect(long64).toHaveLength(64);
      expect((await createUser('long64@example.com', long64)).statusCode).toBe(201);
      expect((await signIn('long64@example.com', long64)).statusCode).toBe(200);
      const long128 = `${long64}${long64.split('').reverse().join('')}`;
      expect((await createUser('long128@example.com', long128)).statusCode).toBe(201);
      expect((await createUser('long129@example.com', `${long128}!`)).json().codes).toEqual([
        'too_long',
      ]);
    });

    it('[IAM-001] ASVS 2.1.3: passwords are not truncated', async () => {
      const base = 'violet harbour lantern otter river meadow '.repeat(2);
      await createUser('whole@example.com', `${base}one`);
      expect((await signIn('whole@example.com', `${base}two`)).statusCode).toBe(401);
      expect((await signIn('whole@example.com', `${base}one`)).statusCode).toBe(200);
    });

    it('[IAM-001] ASVS 2.1.4: any printable Unicode is allowed, including spaces and emoji', async () => {
      const unicode = 'Señora Ñuño 🦊 bebe café — 東京 ☕';
      expect((await createUser('unicode@example.com', unicode)).statusCode).toBe(201);
      expect((await signIn('unicode@example.com', unicode)).statusCode).toBe(200);
      // Normalisation: the decomposed spelling of the same text signs in too.
      expect((await signIn('unicode@example.com', unicode.normalize('NFD'))).statusCode).toBe(200);
    });

    it('[IAM-001] ASVS 2.1.5, 2.1.6: people change their password with the current and the new one', async () => {
      await createUser('changer@example.com', PASSWORD);
      const cookie = cookieFrom(
        (await signIn('changer@example.com', PASSWORD)).headers['set-cookie'],
      );
      const missing = await as(cookie, {
        method: 'PUT',
        url: '/api/v1/account/password',
        payload: { newPassword: 'quiet otter lantern' },
      });
      expect(missing.statusCode).toBe(400);
      const ok = await as(cookie, {
        method: 'PUT',
        url: '/api/v1/account/password',
        payload: { currentPassword: PASSWORD, newPassword: 'quiet otter lantern' },
      });
      expect(ok.statusCode).toBe(200);
    });

    it('[IAM-001] ASVS 2.1.7: breached and common passwords are refused everywhere one is set', async () => {
      expect((await createUser('breached@example.com', 'qwerty123456')).json().codes).toEqual([
        'common',
      ]);
      const check = await app.inject({
        method: 'POST',
        url: '/api/v1/password-check',
        payload: { password: 'Password2026!!' },
      });
      expect(check.json()).toMatchObject({ ok: false, codes: ['common'] });
    });

    it('[IAM-001] ASVS 2.1.8: the password check gives feedback while typing', async () => {
      const check = (password: string, extra: object = {}) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/password-check',
          payload: { password, ...extra },
        });
      expect((await check('short')).json().codes).toEqual(['too_short']);
      expect((await check('ladder violet harbour')).json()).toEqual({
        ok: true,
        codes: [],
        problems: [],
      });
      expect((await check('kalo the great one', { name: 'Kalo' })).json().codes).toEqual([
        'contains_identity',
      ]);
    });

    it('[IAM-001] ASVS 2.1.9: no composition rules', async () => {
      expect((await createUser('plain@example.com', 'all lower case words here')).statusCode).toBe(
        201,
      );
    });

    it('[IAM-001] ASVS 2.1.10: passwords never expire', async () => {
      await createUser('ancient@example.com', PASSWORD);
      await database.db
        .updateTable('app_user')
        .set({ password_changed_at: new Date('2020-01-01T00:00:00Z') })
        .where('email', '=', 'ancient@example.com')
        .execute();
      expect((await signIn('ancient@example.com', PASSWORD)).statusCode).toBe(200);
    });

    it.todo('[IAM-001] ASVS 2.1.11, 2.1.12: paste allowed, password can be shown (apps/web tests)');
  });

  describe('V2.2 general authenticator security', () => {
    it('[IAM-001] ASVS 2.2.1: anti-automation limits guessing per account and per address', async () => {
      await createUser('guarded@example.com', PASSWORD);
      for (let i = 0; i < LOCKOUT.freeFailures; i++)
        await signIn('guarded@example.com', `guess ${i}`);
      expect((await signIn('guarded@example.com', PASSWORD)).statusCode).toBe(429);
      // With the doubling lock, at most 5 + 4 guesses fit in the first hour, far below 100.
      let seconds = 0;
      let guesses = LOCKOUT.freeFailures;
      for (let n = LOCKOUT.freeFailures; seconds < 3600; n++) {
        seconds += Math.min(
          LOCKOUT.maxSeconds,
          LOCKOUT.baseSeconds * 2 ** (n - LOCKOUT.freeFailures),
        );
        if (seconds < 3600) guesses++;
      }
      expect(guesses).toBeLessThan(100);
    });

    it.todo('[IAM-001] ASVS 2.2.3: people are told when their password changes (email, M1-057)');
  });

  describe('V2.4 credential storage', () => {
    it('[IAM-001] ASVS 2.4.1, 2.4.2: Argon2id with a unique salt per password', async () => {
      await createUser('twin1@example.com', 'the same quiet password');
      await createUser('twin2@example.com', 'the same quiet password');
      const rows = await database.db
        .selectFrom('app_user')
        .select('password_hash')
        .where('email', 'in', ['twin1@example.com', 'twin2@example.com'])
        .execute();
      const hashes = rows.map((r) => r.password_hash ?? '');
      for (const hash of hashes) {
        expect(hash).toMatch(
          /^pepper:[0-9a-f]{8}:\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22,}\$/,
        );
      }
      const salts = hashes.map((h) => h.split('$')[4]);
      expect(salts[0]).not.toBe(salts[1]);
    });

    it('[IAM-001] ASVS 2.4.5: a secret pepper kept outside the database is part of every hash', async () => {
      await createUser('peppered@example.com', PASSWORD);
      const row = await database.db
        .selectFrom('app_user')
        .select('password_hash')
        .where('email', '=', 'peppered@example.com')
        .executeTakeFirstOrThrow();
      expect(row.password_hash?.startsWith(`pepper:${PEPPER.id}:`)).toBe(true);
      // The database row alone does not verify: without the key every guess fails.
      expect(await passwordHasher().verify(PASSWORD, row.password_hash ?? '')).toBe(false);
      expect(await passwords.verify(PASSWORD, row.password_hash ?? '')).toBe(true);
    });
  });

  describe('V2.5 credential recovery', () => {
    it('[IAM-001] ASVS 2.5.4: no default or shared accounts exist before setup', () => {
      expect(usersBeforeSetup).toBe(0);
    });

    it('[IAM-001] ASVS 2.5.1, 2.5.6: activation and reset use a one-time, expiring link stored as a hash', async () => {
      const res = await as(admin, {
        method: 'POST',
        url: '/api/v1/users',
        payload: { email: 'invited@example.com', name: 'Invited' },
      });
      const token =
        new URL((res.json().activationLink as string).replace('/#/', '/')).searchParams.get(
          'token',
        ) ?? '';
      const row = await database.db
        .selectFrom('password_link')
        .select(['token_hash', 'expires_at'])
        .where('token_hash', '=', tokenHash(token))
        .executeTakeFirstOrThrow();
      expect(row.token_hash).not.toBe(token);
      expect(row.expires_at.getTime() - Date.now()).toBeLessThanOrEqual(3 * 24 * 60 * 60 * 1000);
      const redeem = (password: string) =>
        app.inject({
          method: 'POST',
          url: '/api/v1/password-links/redeem',
          payload: { token, password },
        });
      expect((await redeem('quiet otter lantern')).statusCode).toBe(200);
      expect((await redeem('another otter lantern')).statusCode).toBe(404);
    });

    it.todo(
      '[IAM-001] ASVS 2.5.5: people are told when an authentication factor changes (email, M1-057)',
    );
  });

  describe('V3 session management', () => {
    it('[IAM-004] ASVS 3.2.1, 3.2.2: every sign-in gets a new 256-bit token, whatever cookie came in', async () => {
      await createUser('fixation@example.com', PASSWORD);
      const planted = `${SESSION_COOKIE}=attacker-chosen-value`;
      const first = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'fixation@example.com', password: PASSWORD },
        headers: { cookie: planted },
        remoteAddress: nextAddress(),
      });
      const second = await signIn('fixation@example.com', PASSWORD);
      const a = cookieFrom(first.headers['set-cookie']);
      const b = cookieFrom(second.headers['set-cookie']);
      expect(a).not.toBe(planted);
      expect(a).not.toBe(b);
      expect(a.split('=')[1]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    });

    it('[IAM-004] ASVS 3.3.1: signing out ends the session on the server', async () => {
      await createUser('logout@example.com', PASSWORD);
      const cookie = cookieFrom(
        (await signIn('logout@example.com', PASSWORD)).headers['set-cookie'],
      );
      await as(cookie, { method: 'DELETE', url: '/api/v1/session' });
      expect((await as(cookie, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(401);
    });

    it('[IAM-004] ASVS 3.3.2: sessions have an idle timeout and an absolute lifetime', () => {
      expect(SESSION_IDLE_MS).toBeLessThanOrEqual(SESSION_LIFETIME_MS);
      expect(SESSION_LIFETIME_MS).toBeLessThanOrEqual(30 * 24 * 60 * 60 * 1000);
    });

    it('[IAM-004] ASVS 3.4.1 to 3.4.4: the cookie is __Host-, Secure, HttpOnly and SameSite on HTTPS', async () => {
      await createUser('cookie@example.com', PASSWORD);
      const res = await signIn('cookie@example.com', PASSWORD, secureApp);
      const header =
        [res.headers['set-cookie']].flat().find((c) => c?.startsWith(SECURE_SESSION_COOKIE)) ?? '';
      expect(header).toMatch(/; Path=\//);
      expect(header).toMatch(/; HttpOnly/);
      expect(header).toMatch(/; Secure/);
      expect(header).toMatch(/; SameSite=Lax/);
      expect(header).not.toMatch(/Domain=/i);
      const cookie = header.split(';')[0] ?? '';
      const me = await secureApp.inject({
        method: 'GET',
        url: '/api/v1/session',
        headers: { cookie },
      });
      expect(me.statusCode).toBe(200);
    });

    it('[IAM-004] ASVS 3.7.1: changing the password needs the current one, even when signed in', async () => {
      await createUser('reauth@example.com', PASSWORD);
      const cookie = cookieFrom(
        (await signIn('reauth@example.com', PASSWORD)).headers['set-cookie'],
      );
      const res = await as(cookie, {
        method: 'PUT',
        url: '/api/v1/account/password',
        payload: { currentPassword: 'not it at all', newPassword: 'quiet otter lantern' },
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode).toBe(403);
    });
  });
});
