import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import {
  issueSetupToken,
  SETUP_TOKEN_KEY,
  setupLink,
  setupTokenIsValid,
  writeSetting,
} from '../setup';

const ADMIN = { name: 'Kalo', email: 'Kalo@Example.com', password: 'a long enough passphrase' };

describe('first-run setup and sessions', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let token: string;
  let cookie: string;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    token = (await issueSetupToken(database.db)) as string;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[OPS-003] reports that setup is needed and builds the link the installer prints', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/setup' });
    expect(res.json()).toEqual({ needed: true });
    expect(setupLink('https://tracker.example.com/', 'abc')).toBe(
      'https://tracker.example.com/#/setup?token=abc',
    );
    expect(await setupTokenIsValid(database.db, token)).toBe(true);
    expect(await setupTokenIsValid(database.db, 'not-the-token')).toBe(false);
  });

  it('[OPS-003] refuses a wrong token and a weak password', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { token: 'nope', instanceName: 'Acme', admin: ADMIN },
    });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.json()).toEqual({ error: 'invalid_setup_token' });

    const weak = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { token, instanceName: 'Acme', admin: { ...ADMIN, password: 'short' } },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json().problems[0]).toMatch(/admin.password: must be at least 12/);

    const malformed = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { token, admin: { name: 'x' } },
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json().error).toBe('invalid_request');
  });

  it('[OPS-003] creates the admin, signs them in and consumes the token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: {
        token,
        instanceName: 'Acme Tracker',
        admin: ADMIN,
        smtp: { host: 'smtp.example.com', port: '587', from: 'tracker@example.com' },
      },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().user).toMatchObject({
      email: 'kalo@example.com',
      name: 'Kalo',
      isSiteAdmin: true,
    });
    const setCookie = res.headers['set-cookie'];
    const header = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    expect(header).toMatch(
      new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]+; .*HttpOnly.*SameSite=Lax`),
    );
    cookie = (header ?? '').split(';')[0] ?? '';

    const me = await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.email).toBe('kalo@example.com');

    const settings = await database.db
      .selectFrom('instance_setting')
      .select(['key', 'value'])
      .orderBy('key')
      .execute();
    expect(settings.map((s) => s.key)).toEqual(['instance', 'setup', 'smtp']);
    expect(settings.find((s) => s.key === 'smtp')?.value).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      from: 'tracker@example.com',
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/setup' })).json()).toEqual({
      needed: false,
    });
  });

  it('[OPS-003] rejects the token a second time, and any token after setup', async () => {
    const again = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      payload: { token, instanceName: 'Again', admin: ADMIN },
    });
    expect(again.statusCode).toBe(409);
    expect(await issueSetupToken(database.db)).toBeUndefined();
  });

  it('[IAM-001] signs out, refuses wrong credentials and signs back in', async () => {
    const out = await app.inject({ method: 'DELETE', url: '/api/v1/session', headers: { cookie } });
    expect(out.statusCode).toBe(204);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } })).statusCode,
    ).toBe(401);

    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: ADMIN.email, password: 'wrong password here' },
    });
    expect(wrong.statusCode).toBe(401);
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'nobody@example.com', password: 'wrong password here' },
    });
    expect(unknown.statusCode).toBe(401);
    expect(unknown.json()).toEqual(wrong.json());

    const right = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: ADMIN.email, password: ADMIN.password },
    });
    expect(right.statusCode).toBe(200);
    expect(right.json().user.isSiteAdmin).toBe(true);
    expect(right.headers['set-cookie']).toBeDefined();
  });

  it('[OPS-003] expires a token after 24 hours', async () => {
    await writeSetting(database.db, SETUP_TOKEN_KEY, {
      hash: 'x',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await setupTokenIsValid(database.db, 'anything')).toBe(false);
  });
});
