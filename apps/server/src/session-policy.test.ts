import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app';
import { SESSION_COOKIE } from './auth';
import { DEFAULT_SESSION_POLICY } from './session-policy';

// Made for this run: no password is written in the repository.
const PASSWORD = `session ${randomBytes(12).toString('base64url')} policy`;
let address = 0;
const nextAddress = () => `198.51.100.${++address}`;

/**
 * How long a sign-in lasts, per workspace (the user's decision of 2026-11-01; ASVS 3.3.2): a
 * site administrator sets the lifetime and the idle timeout, the defaults keep 14 days and 3
 * days idle, and a shorter policy ends the sessions that began under a longer one.
 */
describe('the session policy', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;

  const signIn = async (email: string) => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode, res.body).toBe(200);
    const header = [res.headers['set-cookie']].flat().find((c) => c?.startsWith(SESSION_COOKIE));
    return (header ?? '').split(';')[0] ?? '';
  };
  const as = (cookie: string, method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { cookie },
      remoteAddress: nextAddress(),
      ...(payload ? { payload: payload as Record<string, unknown> } : {}),
    });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['ada', true],
      ['ben', false],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .execute();
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-001] keeps 14 days and 3 days idle until an administrator changes them', async () => {
    const ada = await signIn('ada@example.com');
    const res = await as(ada, 'GET', '/api/v1/security/sessions');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      lifetimeMinutes: 14 * 24 * 60,
      idleMinutes: 3 * 24 * 60,
      defaults: DEFAULT_SESSION_POLICY,
    });
    const row = await database.db
      .selectFrom('user_session')
      .select(['created_at', 'expires_at'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const life = row.expires_at.getTime() - row.created_at.getTime();
    expect(Math.abs(life - 14 * 24 * 60 * 60 * 1000)).toBeLessThan(60_000);
  });

  it('[IAM-001] only a site administrator sets it, within its limits', async () => {
    const ben = await signIn('ben@example.com');
    expect((await as(ben, 'GET', '/api/v1/security/sessions')).statusCode).toBe(403);
    expect(
      (await as(ben, 'PUT', '/api/v1/security/sessions', { lifetimeMinutes: 720, idleMinutes: 30 }))
        .statusCode,
    ).toBe(403);
    const ada = await signIn('ada@example.com');
    for (const bad of [
      { lifetimeMinutes: 30, idleMinutes: 10 },
      { lifetimeMinutes: 720, idleMinutes: 2 },
      { lifetimeMinutes: 720, idleMinutes: 721 },
      { lifetimeMinutes: 200 * 24 * 60, idleMinutes: 30 },
      { lifetimeMinutes: 720.5, idleMinutes: 30 },
    ]) {
      expect(
        (await as(ada, 'PUT', '/api/v1/security/sessions', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    }
  });

  it('[IAM-001] a shorter idle timeout and lifetime end the sessions that began before', async () => {
    const ada = await signIn('ada@example.com');
    const ben = await signIn('ben@example.com');
    // Ben's session was last used 40 minutes ago and began 13 hours ago.
    await database.db
      .updateTable('user_session')
      .set({
        last_seen_at: new Date(Date.now() - 40 * 60 * 1000),
        created_at: new Date(Date.now() - 13 * 60 * 60 * 1000),
      })
      .where('user_id', '=', (await userId('ben@example.com')) as number)
      .execute();
    const session = (cookie: string) =>
      app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } });
    expect((await session(ben)).statusCode).toBe(200);

    // 12 hours, 30 minutes idle: the ASVS level-2 values.
    const set = await as(ada, 'PUT', '/api/v1/security/sessions', {
      lifetimeMinutes: 720,
      idleMinutes: 30,
    });
    expect(set.statusCode, set.body).toBe(200);
    expect(set.json()).toEqual({ lifetimeMinutes: 720, idleMinutes: 30 });
    expect((await session(ben)).statusCode).toBe(401);
    expect((await session(ada)).statusCode).toBe(200);

    // A new session is made for the policy's lifetime.
    await signIn('ben@example.com');
    const row = await database.db
      .selectFrom('user_session')
      .select(['created_at', 'expires_at'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    const life = row.expires_at.getTime() - row.created_at.getTime();
    expect(Math.abs(life - 720 * 60 * 1000)).toBeLessThan(60_000);

    // Only the idle timeout too: a session used 40 minutes ago ends, under 12 hours old.
    await database.db
      .updateTable('user_session')
      .set({ last_seen_at: new Date(Date.now() - 40 * 60 * 1000) })
      .where('user_id', '=', (await userId('ada@example.com')) as number)
      .execute();
    expect((await session(ada)).statusCode).toBe(401);

    // Back to the defaults.
    const again = await signIn('ada@example.com');
    const back = await as(again, 'PUT', '/api/v1/security/sessions', DEFAULT_SESSION_POLICY);
    expect(back.statusCode).toBe(200);
    expect((await as(again, 'GET', '/api/v1/security/sessions')).json()).toMatchObject(
      DEFAULT_SESSION_POLICY,
    );
  });

  async function userId(email: string) {
    return (
      await database.db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', email)
        .executeTakeFirst()
    )?.id;
  }
});
