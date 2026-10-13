import { useMigratedDatabase } from '@taskmoor/db/testing';
import { API_TOKEN_PATTERN, hashPassword, LOCKOUT, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
const DAY_MS = 86_400_000;
let address = 0;
/** Each request comes from its own address unless a test says otherwise (throttling). */
const nextAddress = () => `203.0.113.${(++address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

describe('API tokens (M1-004)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let passwordHash: string;
  let adminCookie: string;
  let adminId: number;

  async function createUser(email: string, options: { admin?: boolean } = {}): Promise<number> {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: passwordHash,
        is_site_admin: options.admin ?? false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function signIn(email: string): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(200);
    return sessionCookie(res.headers['set-cookie']);
  }

  const withCookie = (cookie: string, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), cookie },
    });

  const withToken = (token: string, options: InjectOptions, remoteAddress = nextAddress()) =>
    app.inject({
      remoteAddress,
      ...options,
      headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
    });

  async function createToken(
    cookie: string,
    body: Record<string, unknown> = {},
  ): Promise<{ token: string; id: number }> {
    const res = await withCookie(cookie, {
      method: 'POST',
      url: '/api/v1/account/tokens',
      payload: { name: 'Script', scopes: ['read'], expiresInDays: 30, ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { token: res.json().token, id: res.json().apiToken.id };
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    passwordHash = await hashPassword(PASSWORD);
    adminId = await createUser('ada@example.com', { admin: true });
    adminCookie = await signIn('ada@example.com');
  });
  afterAll(async () => {
    await app.close();
  });

  describe('personal tokens', () => {
    it('[IAM-007] shows a new token once, keeps only its SHA-256 and answers as its owner', async () => {
      const id = await createUser('pat@example.com');
      const cookie = await signIn('pat@example.com');
      const res = await withCookie(cookie, {
        method: 'POST',
        url: '/api/v1/account/tokens',
        payload: { name: 'Nightly export', scopes: ['write', 'read', 'read'], expiresInDays: 30 },
      });
      expect(res.statusCode).toBe(201);
      const { token, apiToken } = res.json();
      expect(token).toMatch(API_TOKEN_PATTERN);
      expect(apiToken).toMatchObject({
        name: 'Nightly export',
        scopes: ['read', 'write'],
        status: 'active',
        lastUsedAt: null,
        revokedAt: null,
        owner: { id, kind: 'person', active: true },
      });
      const days = (Date.parse(apiToken.expiresAt) - Date.now()) / DAY_MS;
      expect(days).toBeGreaterThan(29.9);
      expect(days).toBeLessThanOrEqual(30);

      const row = await database.db
        .selectFrom('api_token')
        .selectAll()
        .where('id', '=', apiToken.id)
        .executeTakeFirstOrThrow();
      expect(row.token_hash).toBe(tokenHash(token));
      expect(JSON.stringify(row)).not.toContain(token);
      // The list never shows the token again.
      const list = await withCookie(cookie, { method: 'GET', url: '/api/v1/account/tokens' });
      expect(list.json().tokens).toHaveLength(1);
      expect(list.body).not.toContain(token);
      expect(list.json().policy).toEqual({ maxLifetimeDays: 365, reminderDays: 14 });

      const me = await withToken(token, { method: 'GET', url: '/api/v1/session' });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        user: { id, email: 'pat@example.com', isSiteAdmin: false },
        apiToken: { id: apiToken.id, scopes: ['read', 'write'] },
      });
      expect(me.headers['set-cookie']).toBeUndefined();
    });

    it('[IAM-007] requires a name, scopes and an expiry, and refuses unknown scopes', async () => {
      const bad = [
        { scopes: ['read'], expiresInDays: 30 },
        { name: 'x', scopes: [], expiresInDays: 30 },
        { name: 'x', scopes: ['delete'], expiresInDays: 30 },
        { name: 'x', scopes: ['read'] },
        { name: 'x', scopes: ['read'], expiresInDays: 30, expiresAt: '2030-01-01T00:00:00Z' },
        { name: 'x', scopes: ['read'], expiresAt: '2020-01-01T00:00:00Z' },
      ];
      const answers = [];
      for (const payload of bad) {
        answers.push(
          (
            await withCookie(adminCookie, {
              method: 'POST',
              url: '/api/v1/account/tokens',
              payload,
            })
          ).json().error,
        );
      }
      expect(answers).toEqual([
        'invalid_request',
        'invalid_request',
        'invalid_request',
        'expiry_required',
        'expiry_required',
        'expiry_in_past',
      ]);
    });

    it('[IAM-007] caps the expiry at the policy maximum, which an administrator may raise past a year', async () => {
      const tooLong = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/account/tokens',
        payload: { name: 'Long', scopes: ['read'], expiresInDays: 366 },
      });
      expect(tooLong.statusCode).toBe(400);
      expect(tooLong.json()).toEqual({ error: 'expiry_too_long', maxLifetimeDays: 365 });
      const atDate = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/account/tokens',
        payload: {
          name: 'Long',
          scopes: ['read'],
          expiresAt: new Date(Date.now() + 400 * DAY_MS).toISOString(),
        },
      });
      expect(atDate.json().error).toBe('expiry_too_long');

      const policy = await withCookie(adminCookie, {
        method: 'PUT',
        url: '/api/v1/admin/token-policy',
        payload: { maxLifetimeDays: 1095 },
      });
      expect(policy.json().policy).toEqual({ maxLifetimeDays: 1095, reminderDays: 14 });
      try {
        const threeYears = await createToken(adminCookie, { expiresInDays: 1095 });
        expect(threeYears.id).toBeGreaterThan(0);
        expect(
          (
            await withCookie(adminCookie, {
              method: 'PUT',
              url: '/api/v1/admin/token-policy',
              payload: { maxLifetimeDays: 3651 },
            })
          ).statusCode,
        ).toBe(400);
      } finally {
        await withCookie(adminCookie, {
          method: 'PUT',
          url: '/api/v1/admin/token-policy',
          payload: { maxLifetimeDays: 365 },
        });
      }
    });

    it('[IAM-007] offers the admin scope only to administrators', async () => {
      await createUser('plain@example.com');
      const cookie = await signIn('plain@example.com');
      const res = await withCookie(cookie, {
        method: 'POST',
        url: '/api/v1/account/tokens',
        payload: { name: 'Admin?', scopes: ['admin'], expiresInDays: 7 },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'scope_not_allowed' });
    });

    it('[IAM-007] lets people revoke and rotate only their own tokens', async () => {
      await createUser('own@example.com');
      const cookie = await signIn('own@example.com');
      const theirs = await createToken(adminCookie);
      expect(
        (await withCookie(cookie, { method: 'DELETE', url: `/api/v1/account/tokens/${theirs.id}` }))
          .statusCode,
      ).toBe(404);
      expect(
        (
          await withCookie(cookie, {
            method: 'POST',
            url: `/api/v1/account/tokens/${theirs.id}/rotate`,
          })
        ).statusCode,
      ).toBe(404);
      expect(
        (await withToken(theirs.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(200);
    });
  });

  describe('scopes', () => {
    it('[IAM-007] [API-002] denies a read token every write and a write token every read', async () => {
      const id = await createUser('scoped@example.com');
      const cookie = await signIn('scoped@example.com');
      const read = await createToken(cookie, { scopes: ['read'] });
      const write = await createToken(cookie, { scopes: ['write'] });

      expect(
        (await withToken(read.token, { method: 'GET', url: '/api/v1/me/permissions' })).statusCode,
      ).toBe(200);
      const denied = await withToken(read.token, {
        method: 'PATCH',
        url: '/api/v1/account',
        payload: { name: 'Changed' },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.json()).toEqual({ error: 'insufficient_scope', requiredScope: 'write' });
      expect(denied.headers['www-authenticate']).toBe(
        'Bearer realm="taskmoor", error="insufficient_scope", scope="write"',
      );
      const name = await database.db
        .selectFrom('app_user')
        .select('name')
        .where('id', '=', id)
        .executeTakeFirstOrThrow();
      expect(name.name).toBe('scoped');

      const allowed = await withToken(write.token, {
        method: 'PATCH',
        url: '/api/v1/account',
        payload: { name: 'Changed' },
      });
      expect(allowed.statusCode).toBe(200);
      const noRead = await withToken(write.token, { method: 'GET', url: '/api/v1/session' });
      expect(noRead.statusCode).toBe(403);
      expect(noRead.json()).toEqual({ error: 'insufficient_scope', requiredScope: 'read' });
    });

    it('[IAM-007] needs the admin scope for administration, whatever the method', async () => {
      const readWrite = await createToken(adminCookie, { scopes: ['read', 'write'] });
      for (const [method, url] of [
        ['GET', '/api/v1/users'],
        ['GET', '/api/v1/admin/system'],
        ['GET', '/api/v1/admin/tokens'],
        ['POST', '/api/v1/groups'],
        ['GET', '/api/v1/service-accounts'],
        ['GET', '/api/v1/permissions/explain'],
      ] as const) {
        const res = await withToken(readWrite.token, { method, url, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json(), `${method} ${url}`).toEqual({
          error: 'insufficient_scope',
          requiredScope: 'admin',
        });
      }
      const admin = await createToken(adminCookie, { scopes: ['read', 'admin'] });
      const users = await withToken(admin.token, { method: 'GET', url: '/api/v1/users' });
      expect(users.statusCode).toBe(200);
      const group = await withToken(admin.token, {
        method: 'POST',
        url: '/api/v1/groups',
        payload: { name: 'Made by a script' },
      });
      expect(group.statusCode).toBe(201);
    });

    it('[IAM-007] acts without administrator rights unless the token has the admin scope', async () => {
      const readOnly = await createToken(adminCookie, { scopes: ['read'] });
      const me = await withToken(readOnly.token, { method: 'GET', url: '/api/v1/session' });
      expect(me.json().user.isSiteAdmin).toBe(false);
      const permissions = await withToken(readOnly.token, {
        method: 'GET',
        url: '/api/v1/me/permissions',
      });
      expect(permissions.json().global).not.toContain('site_admin');
      const admin = await createToken(adminCookie, { scopes: ['read', 'admin'] });
      const full = await withToken(admin.token, { method: 'GET', url: '/api/v1/me/permissions' });
      expect(full.json().global).toContain('site_admin');
    });

    it('[IAM-007] never grants more than the owner holds: an admin token of a demoted person is refused', async () => {
      const id = await createUser('former@example.com', { admin: true });
      const cookie = await signIn('former@example.com');
      const admin = await createToken(cookie, { scopes: ['read', 'admin'] });
      expect(
        (await withToken(admin.token, { method: 'GET', url: '/api/v1/users' })).statusCode,
      ).toBe(200);
      const demoted = await withCookie(adminCookie, {
        method: 'PATCH',
        url: `/api/v1/users/${id}`,
        payload: { isSiteAdmin: false },
      });
      expect(demoted.statusCode).toBe(200);
      const res = await withToken(admin.token, { method: 'GET', url: '/api/v1/users' });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden' });
    });

    it('[IAM-007] keeps tokens, passwords and browser sessions out of reach of any token', async () => {
      const all = await createToken(adminCookie, { scopes: ['read', 'write', 'admin'] });
      for (const [method, url] of [
        ['GET', '/api/v1/account/tokens'],
        ['POST', '/api/v1/account/tokens'],
        ['POST', `/api/v1/account/tokens/${all.id}/rotate`],
        ['DELETE', `/api/v1/account/tokens/${all.id}`],
        ['PUT', '/api/v1/account/password'],
        ['GET', '/api/v1/sessions'],
        ['DELETE', '/api/v1/sessions/others'],
        ['DELETE', '/api/v1/session'],
      ] as const) {
        const res = await withToken(all.token, { method, url, payload: {} });
        expect(res.statusCode, `${method} ${url}`).toBe(403);
        expect(res.json()).toEqual({ error: 'session_required' });
      }
      expect(
        (await withToken(all.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(200);
    });

    it('[IAM-007] uses the token and ignores a session cookie sent along with it', async () => {
      const id = await createUser('both@example.com');
      const cookie = await signIn('both@example.com');
      const read = await createToken(cookie, { scopes: ['read'] });
      const res = await app.inject({
        method: 'PATCH',
        url: '/api/v1/account',
        payload: { name: 'Via cookie?' },
        remoteAddress: nextAddress(),
        headers: { cookie: adminCookie, authorization: `Bearer ${read.token}` },
      });
      expect(res.statusCode).toBe(403);
      const me = await app.inject({
        method: 'GET',
        url: '/api/v1/session',
        remoteAddress: nextAddress(),
        headers: { cookie: adminCookie, authorization: `Bearer ${read.token}` },
      });
      expect(me.json().user.id).toBe(id);
    });
  });

  describe('expiry, revocation and owners', () => {
    it('[IAM-007] [API-002] refuses an expired token with its own error code', async () => {
      const t = await createToken(adminCookie);
      await database.db
        .updateTable('api_token')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('id', '=', t.id)
        .execute();
      const res = await withToken(t.token, { method: 'GET', url: '/api/v1/session' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token', reason: 'expired' });
      expect(res.headers['www-authenticate']).toMatch(
        /^Bearer realm="taskmoor", error="invalid_token", error_description="The token has expired"$/,
      );
      const list = await withCookie(adminCookie, { method: 'GET', url: '/api/v1/account/tokens' });
      expect(list.json().tokens.find((x: { id: number }) => x.id === t.id)).toMatchObject({
        status: 'expired',
      });
    });

    it('[IAM-007] refuses a revoked token at once and keeps it listed as revoked', async () => {
      const t = await createToken(adminCookie);
      expect((await withToken(t.token, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(
        200,
      );
      const revoked = await withCookie(adminCookie, {
        method: 'DELETE',
        url: `/api/v1/account/tokens/${t.id}`,
      });
      expect(revoked.statusCode).toBe(204);
      const res = await withToken(t.token, { method: 'GET', url: '/api/v1/session' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token', reason: 'revoked' });
      const list = await withCookie(adminCookie, { method: 'GET', url: '/api/v1/account/tokens' });
      const row = list.json().tokens.find((x: { id: number }) => x.id === t.id);
      expect(row.status).toBe('revoked');
      expect(row.revokedAt).not.toBeNull();
      // Revoking again is harmless.
      expect(
        (await withCookie(adminCookie, { method: 'DELETE', url: `/api/v1/account/tokens/${t.id}` }))
          .statusCode,
      ).toBe(204);
    });

    it('[IAM-007] refuses unknown and malformed tokens alike', async () => {
      for (const token of ['tmk_nonsense', `tmk_${'A'.repeat(46)}`, 'abc.def.ghi']) {
        const res = await withToken(token, { method: 'GET', url: '/api/v1/session' });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: 'invalid_token', reason: 'unknown' });
      }
    });

    it('[IAM-007] stops the tokens of a deactivated owner and restores them on reactivation', async () => {
      const id = await createUser('leaver@example.com');
      const cookie = await signIn('leaver@example.com');
      const t = await createToken(cookie);
      await withCookie(adminCookie, { method: 'POST', url: `/api/v1/users/${id}/deactivate` });
      const res = await withToken(t.token, { method: 'GET', url: '/api/v1/session' });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_token', reason: 'owner_deactivated' });
      await withCookie(adminCookie, { method: 'POST', url: `/api/v1/users/${id}/reactivate` });
      expect((await withToken(t.token, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(
        200,
      );
    });

    it('[IAM-007] records the last use at most once a minute', async () => {
      const t = await createToken(adminCookie);
      const lastUsed = async () =>
        database.db
          .selectFrom('api_token')
          .select(['last_used_at', 'last_used_ip'])
          .where('id', '=', t.id)
          .executeTakeFirstOrThrow();
      expect((await lastUsed()).last_used_at).toBeNull();
      await withToken(t.token, { method: 'GET', url: '/api/v1/session' }, '192.0.2.10');
      const first = await lastUsed();
      expect(first.last_used_at).not.toBeNull();
      expect(first.last_used_ip).toBe('192.0.2.10');
      await withToken(t.token, { method: 'GET', url: '/api/v1/session' }, '192.0.2.11');
      expect(await lastUsed()).toEqual(first);
      // A minute later the next use is written.
      const earlier = new Date(Date.now() - 2 * 60_000);
      await database.db
        .updateTable('api_token')
        .set({ last_used_at: earlier })
        .where('id', '=', t.id)
        .execute();
      await withToken(t.token, { method: 'GET', url: '/api/v1/session' }, '192.0.2.12');
      const next = await lastUsed();
      expect(next.last_used_at?.getTime()).toBeGreaterThan(earlier.getTime());
      expect(next.last_used_ip).toBe('192.0.2.12');
    });

    it('[IAM-007] locks an address after repeated bad tokens, good ones included, and no other address', async () => {
      const good = await createToken(adminCookie);
      const from = '192.0.2.99';
      for (let i = 0; i < LOCKOUT.addressFailures; i++) {
        const res = await withToken(
          `tmk_guess${i}`,
          { method: 'GET', url: '/api/v1/session' },
          from,
        );
        expect(res.statusCode).toBe(401);
      }
      const locked = await withToken(good.token, { method: 'GET', url: '/api/v1/session' }, from);
      expect(locked.statusCode).toBe(429);
      expect(locked.json()).toMatchObject({ error: 'too_many_attempts' });
      expect(Number(locked.headers['retry-after'])).toBeGreaterThan(0);
      expect(
        (await withToken(good.token, { method: 'GET', url: '/api/v1/session' }, '192.0.2.98'))
          .statusCode,
      ).toBe(200);
      // Sign-in from that address is counted apart and still works.
      const signIn = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'ada@example.com', password: PASSWORD },
        remoteAddress: from,
      });
      expect(signIn.statusCode).toBe(200);
    });
  });

  describe('rotation', () => {
    it('[IAM-007] rotates a token with an overlap window during which both work', async () => {
      const old = await createToken(adminCookie, { name: 'Deploy', scopes: ['read', 'write'] });
      const res = await withCookie(adminCookie, {
        method: 'POST',
        url: `/api/v1/account/tokens/${old.id}/rotate`,
        payload: { overlapHours: 2 },
      });
      expect(res.statusCode).toBe(201);
      const { token, apiToken, previous } = res.json();
      expect(token).toMatch(API_TOKEN_PATTERN);
      expect(apiToken).toMatchObject({
        name: 'Deploy',
        scopes: ['read', 'write'],
        status: 'active',
      });
      expect(previous).toMatchObject({ id: old.id, status: 'active', replacedBy: apiToken.id });
      const overlap = Date.parse(previous.expiresAt) - Date.now();
      expect(overlap).toBeGreaterThan(1.9 * 3_600_000);
      expect(overlap).toBeLessThanOrEqual(2 * 3_600_000);
      // The new token lives as long as the old one did (30 days).
      expect((Date.parse(apiToken.expiresAt) - Date.now()) / DAY_MS).toBeGreaterThan(29.9);
      for (const t of [old.token, token]) {
        expect((await withToken(t, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(
          200,
        );
      }
      // Rotating the replaced token again is allowed while it lives; a revoked one is not.
      await withCookie(adminCookie, { method: 'DELETE', url: `/api/v1/account/tokens/${old.id}` });
      const again = await withCookie(adminCookie, {
        method: 'POST',
        url: `/api/v1/account/tokens/${old.id}/rotate`,
      });
      expect(again.statusCode).toBe(409);
      expect(again.json()).toEqual({ error: 'not_active' });
    });

    it('[IAM-007] ends the old token at once with an overlap of zero', async () => {
      const old = await createToken(adminCookie);
      const res = await withCookie(adminCookie, {
        method: 'POST',
        url: `/api/v1/account/tokens/${old.id}/rotate`,
        payload: { overlapHours: 0, expiresInDays: 7 },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json().previous.status).toBe('revoked');
      expect((Date.parse(res.json().apiToken.expiresAt) - Date.now()) / DAY_MS).toBeLessThanOrEqual(
        7,
      );
      expect(
        (await withToken(old.token, { method: 'GET', url: '/api/v1/session' })).json(),
      ).toEqual({
        error: 'invalid_token',
        reason: 'revoked',
      });
      expect(
        (await withToken(res.json().token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(200);
    });
  });

  describe('administration', () => {
    it('[IAM-007] lists every token with owner, scopes, dates and status, filtered by status and owner', async () => {
      const id = await createUser('inventory@example.com');
      const cookie = await signIn('inventory@example.com');
      const a = await createToken(cookie, { name: 'A' });
      const b = await createToken(cookie, { name: 'B', scopes: ['read', 'write'] });
      await withCookie(cookie, { method: 'DELETE', url: `/api/v1/account/tokens/${b.id}` });
      await withToken(a.token, { method: 'GET', url: '/api/v1/session' });

      const res = await withCookie(adminCookie, {
        method: 'GET',
        url: `/api/v1/admin/tokens?ownerId=${id}`,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.total).toBe(2);
      expect(body.tokens.map((t: { name: string }) => t.name)).toEqual(['B', 'A']);
      expect(body.tokens[1]).toMatchObject({
        name: 'A',
        scopes: ['read'],
        status: 'active',
        owner: { id, email: 'inventory@example.com', kind: 'person', active: true },
      });
      expect(body.tokens[1].lastUsedAt).not.toBeNull();
      expect(body.tokens[0]).toMatchObject({ name: 'B', status: 'revoked' });
      expect(body.owners).toContainEqual({
        id,
        name: 'inventory',
        email: 'inventory@example.com',
        kind: 'person',
        activeTokens: 1,
      });
      expect(res.body).not.toContain(a.token);

      const active = await withCookie(adminCookie, {
        method: 'GET',
        url: `/api/v1/admin/tokens?ownerId=${id}&status=revoked`,
      });
      expect(active.json().tokens.map((t: { name: string }) => t.name)).toEqual(['B']);

      // People cannot see the inventory.
      expect(
        (await withCookie(cookie, { method: 'GET', url: '/api/v1/admin/tokens' })).statusCode,
      ).toBe(403);
    });

    it.todo('[IAM-007] emails each owner 14 days before a token expires (email, M1-057)');

    it('[IAM-007] lists tokens due for rotation within the reminder window, soonest first', async () => {
      const id = await createUser('reminder@example.com');
      const cookie = await signIn('reminder@example.com');
      const soon = await createToken(cookie, { name: 'Soon', expiresInDays: 10 });
      const sooner = await createToken(cookie, { name: 'Sooner', expiresInDays: 3 });
      await createToken(cookie, { name: 'Later', expiresInDays: 60 });
      const replaced = await createToken(cookie, { name: 'Replaced', expiresInDays: 5 });
      await withCookie(cookie, {
        method: 'POST',
        url: `/api/v1/account/tokens/${replaced.id}/rotate`,
        payload: { expiresInDays: 90 },
      });
      const res = await withCookie(adminCookie, {
        method: 'GET',
        url: '/api/v1/admin/tokens/expiring',
      });
      expect(res.json().withinDays).toBe(14);
      const mine = res
        .json()
        .tokens.filter((t: { owner: { id: number } }) => t.owner.id === id)
        .map((t: { id: number }) => t.id);
      expect(mine).toEqual([sooner.id, soon.id]);
      const narrower = await withCookie(adminCookie, {
        method: 'GET',
        url: '/api/v1/admin/tokens/expiring?withinDays=5',
      });
      expect(
        narrower
          .json()
          .tokens.filter((t: { owner: { id: number } }) => t.owner.id === id)
          .map((t: { id: number }) => t.id),
      ).toEqual([sooner.id]);
    });

    it('[IAM-007] revokes one token of anyone', async () => {
      await createUser('single@example.com');
      const cookie = await signIn('single@example.com');
      const t = await createToken(cookie);
      const res = await withCookie(adminCookie, {
        method: 'DELETE',
        url: `/api/v1/admin/tokens/${t.id}`,
      });
      expect(res.statusCode).toBe(204);
      expect((await withToken(t.token, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(
        401,
      );
      expect(
        (await withCookie(adminCookie, { method: 'DELETE', url: '/api/v1/admin/tokens/999999' }))
          .statusCode,
      ).toBe(404);
    });

    it('[IAM-007] revokes every token of a user in one action and reports the count', async () => {
      const id = await createUser('bulk@example.com');
      const cookie = await signIn('bulk@example.com');
      const tokens = [
        await createToken(cookie),
        await createToken(cookie),
        await createToken(cookie),
      ];
      const other = await createToken(adminCookie);
      const preview = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/admin/tokens/revoke',
        payload: { ownerId: id, dryRun: true },
      });
      expect(preview.json()).toEqual({ matched: 3 });
      expect(
        (await withToken(tokens[0]?.token ?? '', { method: 'GET', url: '/api/v1/session' }))
          .statusCode,
      ).toBe(200);

      const res = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/admin/tokens/revoke',
        payload: { ownerId: id },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ revoked: 3 });
      for (const t of tokens) {
        expect(
          (await withToken(t.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
        ).toBe(401);
      }
      expect(
        (await withToken(other.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(200);
      const again = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/admin/tokens/revoke',
        payload: { ownerId: id },
      });
      expect(again.json()).toEqual({ revoked: 0 });
    });

    it('[IAM-007] revokes tokens created before a date, or all of them, and insists on criteria', async () => {
      const old = await createToken(adminCookie, { name: 'Old' });
      await database.db
        .updateTable('api_token')
        .set({ created_at: new Date(Date.now() - 40 * DAY_MS) })
        .where('id', '=', old.id)
        .execute();
      const recent = await createToken(adminCookie, { name: 'Recent' });
      const before = new Date(Date.now() - 20 * DAY_MS).toISOString();
      const res = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/admin/tokens/revoke',
        payload: { createdBefore: before },
      });
      expect(res.json().revoked).toBeGreaterThanOrEqual(1);
      expect(
        (await withToken(old.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(401);
      expect(
        (await withToken(recent.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(200);

      for (const [payload, error] of [
        [{}, 'criteria_required'],
        [{ all: true, ownerId: adminId }, 'conflicting_criteria'],
        [{ all: false }, 'invalid_request'],
      ] as const) {
        const refused = await withCookie(adminCookie, {
          method: 'POST',
          url: '/api/v1/admin/tokens/revoke',
          payload,
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json()).toEqual({ error });
      }

      const all = await withCookie(adminCookie, {
        method: 'POST',
        url: '/api/v1/admin/tokens/revoke',
        payload: { all: true },
      });
      expect(all.json().revoked).toBeGreaterThanOrEqual(1);
      expect(
        (await withToken(recent.token, { method: 'GET', url: '/api/v1/session' })).statusCode,
      ).toBe(401);
      const left = await withCookie(adminCookie, {
        method: 'GET',
        url: '/api/v1/admin/tokens?status=active',
      });
      expect(left.json().total).toBe(0);
    });

    it('[IAM-007] reads and validates the token policy', async () => {
      const read = await withCookie(adminCookie, {
        method: 'GET',
        url: '/api/v1/admin/token-policy',
      });
      expect(read.json()).toEqual({
        policy: { maxLifetimeDays: 365, reminderDays: 14 },
        limits: { maxLifetimeDays: { min: 1, max: 3650 }, reminderDays: { min: 1, max: 90 } },
      });
      for (const payload of [{ maxLifetimeDays: 0 }, { reminderDays: 91 }, { other: 1 }]) {
        expect(
          (
            await withCookie(adminCookie, {
              method: 'PUT',
              url: '/api/v1/admin/token-policy',
              payload,
            })
          ).statusCode,
        ).toBe(400);
      }
    });
  });
});
