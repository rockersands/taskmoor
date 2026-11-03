import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `198.18.2.${(++address % 250) + 1}`;

describe('tutorial progress (ADR-115)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};

  async function person(email: string) {
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email,
        password_hash: await hashPassword(PASSWORD),
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const header = res.headers['set-cookie'];
    const list = Array.isArray(header) ? header : header ? [header] : [];
    cookies[email] =
      (list.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
  }

  const as = (email: string, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), cookie: cookies[email] ?? '' },
    });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await person('ada@example.com');
    await person('bo@example.com');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-008] starts with nothing, then keeps a section and the offer per person', async () => {
    const first = await as('ada@example.com', { url: '/api/v1/account/tutorial' });
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ offer: null, sections: [] });

    const started = await as('ada@example.com', {
      method: 'PUT',
      url: '/api/v1/account/tutorial/boards',
      payload: { state: 'active', step: 2 },
    });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toEqual({ section: 'boards', state: 'active', step: 2 });
    const offered = await as('ada@example.com', {
      method: 'PUT',
      url: '/api/v1/account/tutorial/offer',
      payload: { state: 'dismissed' },
    });
    expect(offered.statusCode, offered.body).toBe(200);

    const read = (await as('ada@example.com', { url: '/api/v1/account/tutorial' })).json();
    expect(read.offer).toBe('dismissed');
    expect(read.sections).toMatchObject([{ section: 'boards', state: 'active', step: 2 }]);

    // Moving on replaces the place; nobody else's progress is touched.
    await as('ada@example.com', {
      method: 'PUT',
      url: '/api/v1/account/tutorial/boards',
      payload: { state: 'done' },
    });
    const done = (await as('ada@example.com', { url: '/api/v1/account/tutorial' })).json();
    expect(done.sections).toMatchObject([{ section: 'boards', state: 'done', step: 0 }]);
    const other = (await as('bo@example.com', { url: '/api/v1/account/tutorial' })).json();
    expect(other).toEqual({ offer: null, sections: [] });
  });

  it('[IAM-008] refuses an unknown section, a wrong state and extra fields', async () => {
    const put = (url: string, payload: unknown) =>
      as('ada@example.com', { method: 'PUT', url, payload: payload as object });
    expect((await put('/api/v1/account/tutorial/nope', { state: 'done' })).statusCode).toBe(404);
    expect((await put('/api/v1/account/tutorial/boards', { state: 'shown' })).statusCode).toBe(400);
    expect((await put('/api/v1/account/tutorial/offer', { state: 'done' })).statusCode).toBe(400);
    expect(
      (await put('/api/v1/account/tutorial/boards', { state: 'done', userId: 2 })).statusCode,
    ).toBe(400);
    expect(
      (await put('/api/v1/account/tutorial/boards', { state: 'done', step: -1 })).statusCode,
    ).toBe(400);
  });

  it('[IAM-008] needs a signed-in person', async () => {
    const res = await app.inject({
      url: '/api/v1/account/tutorial',
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(401);
  });
});
