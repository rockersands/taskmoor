import { useMigratedDatabase } from '@taskmoor/db/testing';
import { API_TOKEN_PATTERN, hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { SERVICE_ACCOUNT_DOMAIN } from './service-accounts';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `198.18.1.${(++address % 250) + 1}`;

describe('service accounts (M1-004)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let adminCookie: string;

  const admin = (options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), cookie: adminCookie },
    });
  const withToken = (token: string, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), authorization: `Bearer ${token}` },
    });

  async function createAccount(name: string, description = ''): Promise<number> {
    const res = await admin({
      method: 'POST',
      url: '/api/v1/service-accounts',
      payload: { name, description },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().serviceAccount.id;
  }

  async function issue(accountId: number, body: Record<string, unknown> = {}) {
    const res = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${accountId}/tokens`,
      payload: { name: 'Key', scopes: ['read'], expiresInDays: 30, ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return { token: res.json().token as string, id: res.json().apiToken.id as number };
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'ada@example.com',
        name: 'Ada',
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'ada@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const header = res.headers['set-cookie'];
    const list = Array.isArray(header) ? header : header ? [header] : [];
    adminCookie = (list.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-007] creates a service account with a reserved address and lists it apart from people', async () => {
    const res = await admin({
      method: 'POST',
      url: '/api/v1/service-accounts',
      payload: { name: 'CI Deploy', description: 'Deploys main' },
    });
    expect(res.statusCode).toBe(201);
    const account = res.json().serviceAccount;
    expect(account).toMatchObject({
      name: 'CI Deploy',
      email: `ci-deploy@${SERVICE_ACCOUNT_DOMAIN}`,
      description: 'Deploys main',
      active: true,
      activeTokens: 0,
    });
    const twin = await admin({
      method: 'POST',
      url: '/api/v1/service-accounts',
      payload: { name: 'CI deploy!' },
    });
    expect(twin.json().serviceAccount.email).toBe(`ci-deploy-2@${SERVICE_ACCOUNT_DOMAIN}`);

    const list = await admin({ method: 'GET', url: '/api/v1/service-accounts' });
    expect(list.json().serviceAccounts.map((a: { name: string }) => a.name)).toEqual([
      'CI Deploy',
      'CI deploy!',
    ]);
    // Not counted as users (IAM-007): the people list and its total leave them out.
    const users = await admin({ method: 'GET', url: '/api/v1/users?status=all' });
    expect(users.json().total).toBe(1);
    expect(users.json().users.map((u: { email: string }) => u.email)).toEqual(['ada@example.com']);
    expect((await admin({ method: 'GET', url: `/api/v1/users/${account.id}` })).statusCode).toBe(
      404,
    );
  });

  it('[IAM-007] never lets a service account sign in or get a password link', async () => {
    const id = await createAccount('Robot');
    const signIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: `robot@${SERVICE_ACCOUNT_DOMAIN}`, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(signIn.statusCode).toBe(401);
    expect(signIn.json()).toEqual({ error: 'invalid_credentials' });
    // Even with a password written into its row.
    await database.db
      .updateTable('app_user')
      .set({ password_hash: await hashPassword(PASSWORD) })
      .where('id', '=', id)
      .execute();
    const forced = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: `robot@${SERVICE_ACCOUNT_DOMAIN}`, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(forced.statusCode).toBe(401);
    const link = await admin({ method: 'POST', url: `/api/v1/users/${id}/password-link` });
    expect(link.statusCode).toBe(404);
    for (const [method, url] of [
      ['PATCH', `/api/v1/users/${id}`],
      ['POST', `/api/v1/users/${id}/deactivate`],
    ] as const) {
      expect((await admin({ method, url, payload: { name: 'x' } })).statusCode).toBe(404);
    }
  });

  it('[IAM-007] acts through its tokens with the permissions of its groups', async () => {
    const id = await createAccount('Reporter');
    const t = await issue(id, { scopes: ['read', 'admin'] });
    expect(t.token).toMatch(API_TOKEN_PATTERN);
    const me = await withToken(t.token, { method: 'GET', url: '/api/v1/session' });
    expect(me.json().user).toMatchObject({ id, name: 'Reporter', isSiteAdmin: false });
    // Holding no administrator rights yet, the admin scope opens nothing.
    expect((await withToken(t.token, { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(
      403,
    );

    const group = await admin({
      method: 'POST',
      url: '/api/v1/groups',
      payload: { name: 'Robots with admin' },
    });
    const groupId = group.json().group.id;
    expect(
      (await admin({ method: 'PUT', url: `/api/v1/groups/${groupId}/members/${id}` })).statusCode,
    ).toBe(204);
    const grant = await admin({
      method: 'POST',
      url: '/api/v1/global-grants',
      payload: { permission: 'site_admin', grantee: 'group', groupId },
    });
    expect(grant.statusCode).toBe(201);
    expect((await withToken(t.token, { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(
      200,
    );

    const detail = await admin({ method: 'GET', url: `/api/v1/service-accounts/${id}` });
    expect(detail.json()).toMatchObject({
      serviceAccount: { id, activeTokens: 1 },
      groups: [{ id: groupId, name: 'Robots with admin' }],
    });
    expect(detail.json().tokens[0]).toMatchObject({
      name: 'Key',
      scopes: ['read', 'admin'],
      owner: { id, kind: 'service' },
    });
    expect(detail.body).not.toContain(t.token);
  });

  it('[IAM-007] [IAM-008] a group read says which members are service accounts (T-320)', async () => {
    const id = await createAccount('Indexer');
    const ada = await database.db
      .selectFrom('app_user')
      .select('id')
      .where('email', '=', 'ada@example.com')
      .executeTakeFirstOrThrow();
    const group = await admin({
      method: 'POST',
      url: '/api/v1/groups',
      payload: { name: 'People and robots' },
    });
    const groupId = group.json().group.id;
    for (const member of [ada.id, id]) {
      const added = await admin({
        method: 'PUT',
        url: `/api/v1/groups/${groupId}/members/${member}`,
      });
      expect(added.statusCode).toBe(204);
    }
    const read = await admin({ method: 'GET', url: `/api/v1/groups/${groupId}` });
    expect(read.statusCode).toBe(200);
    expect(
      (read.json().members as { id: number; kind: string }[]).map((m) => [m.id, m.kind]),
    ).toEqual([
      [ada.id, 'person'],
      [id, 'service'],
    ]);
  });

  it('[IAM-007] rotates a service-account token with a configurable overlap and no downtime', async () => {
    const id = await createAccount('Exporter');
    const old = await issue(id, {
      name: 'Export key',
      scopes: ['read', 'write'],
      expiresInDays: 60,
    });
    const res = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${id}/tokens/${old.id}/rotate`,
      payload: { overlapHours: 6 },
    });
    expect(res.statusCode).toBe(201);
    const { token, apiToken, previous } = res.json();
    expect(apiToken).toMatchObject({ name: 'Export key', scopes: ['read', 'write'] });
    expect(apiToken.owner.id).toBe(id);
    expect(previous.replacedBy).toBe(apiToken.id);
    const overlap = (Date.parse(previous.expiresAt) - Date.now()) / 3_600_000;
    expect(overlap).toBeGreaterThan(5.9);
    expect(overlap).toBeLessThanOrEqual(6);
    // During the window both answer, so the program can switch at its own pace.
    for (const t of [old.token, token]) {
      expect((await withToken(t, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);
    }
    // After the window only the new one does.
    await database.db
      .updateTable('api_token')
      .set({ expires_at: new Date(Date.now() - 1000) })
      .where('id', '=', old.id)
      .execute();
    expect((await withToken(old.token, { method: 'GET', url: '/api/v1/session' })).json()).toEqual({
      error: 'invalid_token',
      reason: 'expired',
    });
    expect((await withToken(token, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(
      200,
    );

    // The default overlap is a day; more than 30 days is refused.
    const other = await issue(id);
    const daily = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${id}/tokens/${other.id}/rotate`,
    });
    const hours = (Date.parse(daily.json().previous.expiresAt) - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const tooLong = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${id}/tokens/${daily.json().apiToken.id}/rotate`,
      payload: { overlapHours: 721 },
    });
    expect(tooLong.statusCode).toBe(400);
  });

  it('[IAM-007] rotates only tokens of that service account, never a person’s', async () => {
    const id = await createAccount('Guarded');
    const personal = await admin({
      method: 'POST',
      url: '/api/v1/account/tokens',
      payload: { name: 'Mine', scopes: ['read'], expiresInDays: 5 },
    });
    const res = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${id}/tokens/${personal.json().apiToken.id}/rotate`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('[IAM-007] stops every token of a deactivated service account and refuses new ones', async () => {
    const id = await createAccount('Retired');
    const t = await issue(id);
    const off = await admin({ method: 'POST', url: `/api/v1/service-accounts/${id}/deactivate` });
    expect(off.json().serviceAccount).toMatchObject({ active: false });
    expect((await withToken(t.token, { method: 'GET', url: '/api/v1/session' })).json()).toEqual({
      error: 'invalid_token',
      reason: 'owner_deactivated',
    });
    const refused = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${id}/tokens`,
      payload: { name: 'Key', scopes: ['read'], expiresInDays: 30 },
    });
    expect(refused.statusCode).toBe(409);
    const listed = await admin({
      method: 'GET',
      url: '/api/v1/service-accounts?status=deactivated',
    });
    expect(listed.json().serviceAccounts.map((a: { id: number }) => a.id)).toContain(id);
    await admin({ method: 'POST', url: `/api/v1/service-accounts/${id}/reactivate` });
    expect((await withToken(t.token, { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(
      200,
    );
  });

  it('[IAM-007] renames a service account and keeps the expiry cap for its tokens', async () => {
    const id = await createAccount('Old name');
    const renamed = await admin({
      method: 'PATCH',
      url: `/api/v1/service-accounts/${id}`,
      payload: { name: 'New name' },
    });
    expect(renamed.json().serviceAccount).toMatchObject({ name: 'New name' });
    const tooLong = await admin({
      method: 'POST',
      url: `/api/v1/service-accounts/${id}/tokens`,
      payload: { name: 'Key', scopes: ['read'], expiresInDays: 400 },
    });
    expect(tooLong.json()).toEqual({ error: 'expiry_too_long', maxLifetimeDays: 365 });
    expect(
      (await admin({ method: 'GET', url: '/api/v1/service-accounts/999999' })).statusCode,
    ).toBe(404);
  });
});
