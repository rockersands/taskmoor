import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { DEFAULT_RATE_LIMITS, RateLimiter } from './limiter';
import { trimApiUsage } from './usage';

// Made for this run: no password is written in the repository.
const PASSWORD = `limits-${randomBytes(18).toString('base64url')}`;

describe('token buckets (M1-066)', () => {
  it('[API-010] (1) lets a burst through, then refuses with the seconds until a request is back', () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => now });
    const limits = { rate: 2, burst: 3 };
    expect([1, 2, 3].map(() => limiter.take('a', limits).allowed)).toEqual([true, true, true]);
    const refused = limiter.take('a', limits);
    expect(refused).toMatchObject({ allowed: false, remaining: 0, retryAfterSeconds: 1 });
    // Another client has its own bucket.
    expect(limiter.take('b', limits).allowed).toBe(true);
    now += 500;
    expect(limiter.take('a', limits)).toMatchObject({ allowed: true, remaining: 0 });
    now += 10_000;
    expect(limiter.take('a', limits)).toMatchObject({ allowed: true, remaining: 2 });
  });

  it('[API-010] (3) never throttles one person at 20 requests a second under the defaults', () => {
    let now = 0;
    const limiter = new RateLimiter({ now: () => now });
    // Ten minutes at 20 a second, and a burst of 100 at once in the middle.
    for (let i = 0; i < 20 * 600; i++) {
      now += 50;
      expect(limiter.take('person', DEFAULT_RATE_LIMITS.user).allowed).toBe(true);
      if (i === 6000) {
        for (let j = 0; j < 100; j++) {
          expect(limiter.take('person', DEFAULT_RATE_LIMITS.user).allowed).toBe(true);
        }
      }
    }
  });

  it('[API-010] (1) allows at most the burst plus the rate times the time, whatever the pattern', () => {
    fc.assert(
      fc.property(
        fc.record({
          rate: fc.integer({ min: 1, max: 50 }),
          burst: fc.integer({ min: 1, max: 100 }),
        }),
        fc.array(fc.integer({ min: 0, max: 400 }), { minLength: 1, maxLength: 300 }),
        (limits, gaps) => {
          let now = 0;
          const limiter = new RateLimiter({ now: () => now });
          let allowed = 0;
          for (const gap of gaps) {
            now += gap;
            if (limiter.take('k', limits).allowed) allowed += 1;
          }
          expect(allowed).toBeLessThanOrEqual(
            limits.burst + Math.floor((now / 1000) * limits.rate),
          );
        },
      ),
    );
  });
});

/**
 * Rate limits through the API (M1-066; API-010): 429 with Retry-After and `RateLimit-*`
 * headers per token, person and address and per ticket for writes, the limits a site
 * administrator sets, and the usage dashboard's busiest clients.
 */
describe('rate limits and usage through the API (M1-066)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let now = Date.parse('2026-10-30T12:00:00Z');
  const limiter = new RateLimiter({ now: () => now });
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let address = 0;

  const as = (who: string | null, options: InjectOptions, from = '100.80.0.1') =>
    app.inject({
      ...options,
      remoteAddress: from,
      headers: { ...(options.headers ?? {}), ...(who ? { cookie: cookies[who] ?? '' } : {}) },
    });

  async function person(name: string, admin = false) {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: `${name}@example.com`,
        name,
        password_hash: await hashPassword(PASSWORD),
        is_site_admin: admin,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[name] = row.id;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: `${name}@example.com`, password: PASSWORD },
      remoteAddress: `100.81.0.${++address}`,
    });
    const cookie = [res.headers['set-cookie']]
      .flat()
      .find((c) => c?.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`));
    cookies[name] = (cookie ?? '').split(';')[0] ?? '';
  }
  const setLimits = async (body: Record<string, unknown>) => {
    const res = await as('admin', {
      method: 'PUT',
      url: '/api/v1/admin/rate-limits',
      payload: body,
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      rateLimits: { limiter, now: () => now },
    });
    await person('admin', true);
    await person('pat');
    await person('sam');
  });
  afterAll(async () => {
    await app?.close();
  });

  it('[API-010] (1) answers 429 with Retry-After once a person, a token or an address is over its limit', async () => {
    await setLimits({
      user: { rate: 1, burst: 3 },
      token: { rate: 1, burst: 2 },
      address: { rate: 1, burst: 2 },
    });
    now += 60_000;
    const first = await as('pat', { method: 'GET', url: '/api/v1/session' });
    expect(first.statusCode, first.body).toBe(200);
    expect(first.headers).toMatchObject({
      'ratelimit-limit': '3',
      'ratelimit-remaining': '2',
      'ratelimit-reset': '1',
    });
    await as('pat', { method: 'GET', url: '/api/v1/session' });
    await as('pat', { method: 'GET', url: '/api/v1/session' });
    const refused = await as('pat', { method: 'GET', url: '/api/v1/session' });
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(refused.json()).toEqual({ error: 'rate_limited', scope: 'user', retryAfterSeconds: 1 });
    // Sam is not slowed down by Pat.
    expect((await as('sam', { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);

    // Pat's token has a bucket of its own, apart from Pat's sessions.
    now += 60_000;
    const made = await as('pat', {
      method: 'POST',
      url: '/api/v1/account/tokens',
      payload: { name: 'Script', scopes: ['read'], expiresInDays: 30 },
    });
    expect(made.statusCode, made.body).toBe(201);
    const bearer = { authorization: `Bearer ${made.json().token}` };
    const viaToken = async () =>
      (await as(null, { method: 'GET', url: '/api/v1/session', headers: bearer })).statusCode;
    expect([await viaToken(), await viaToken(), await viaToken()]).toEqual([200, 200, 429]);
    expect((await as('pat', { method: 'GET', url: '/api/v1/session' })).statusCode).toBe(200);
    // A second later the token may go on.
    now += 1000;
    expect(await viaToken()).toBe(200);

    // Without a session or a token, the address is the client.
    const anonymous = async () =>
      (await as(null, { method: 'GET', url: '/api/v1/session' }, '100.82.0.9')).statusCode;
    expect([await anonymous(), await anonymous(), await anonymous()]).toEqual([401, 401, 429]);
    // The meta endpoint answers anyone, always.
    expect((await as(null, { method: 'GET', url: '/api/meta' }, '100.82.0.9')).statusCode).toBe(
      200,
    );
  });

  it('[API-010] limits writes to one ticket, whoever sends them', async () => {
    await setLimits({
      user: { rate: 1000, burst: 1000 },
      ticketWrite: { rate: 1, burst: 2 },
    });
    now += 60_000;
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'RL', name: 'Limits', mode: 'shared' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const ticket = await as('admin', {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'RL', summary: 'Edited in a loop' },
    });
    expect(ticket.statusCode, ticket.body).toBe(201);
    const key = ticket.json().ticket.key as string;
    const edit = async (summary: string) =>
      (
        await as('admin', {
          method: 'PATCH',
          url: `/api/v1/tickets/${key}`,
          payload: { summary },
        })
      ).statusCode;
    expect([await edit('One'), await edit('Two'), await edit('Three')]).toEqual([200, 200, 429]);
    // Reading it is not a write.
    expect((await as('admin', { method: 'GET', url: `/api/v1/tickets/${key}` })).statusCode).toBe(
      200,
    );
  });

  it('[API-010] keeps the limits a site administrator sets, within bounds, and audits the change', async () => {
    await setLimits({ user: { rate: 1000, burst: 1000 } });
    now += 60_000;
    expect(
      (await as('pat', { method: 'PUT', url: '/api/v1/admin/rate-limits', payload: {} }))
        .statusCode,
    ).toBe(403);
    const invalid = await as('admin', {
      method: 'PUT',
      url: '/api/v1/admin/rate-limits',
      payload: { token: { rate: 0, burst: 10 } },
    });
    expect(invalid.statusCode).toBe(400);
    const read = await as('admin', { method: 'GET', url: '/api/v1/admin/rate-limits' });
    expect(read.json().limits.user).toEqual({ rate: 1000, burst: 1000 });
    // The change is a domain event, which the audit log records (ADR-034).
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type'])
      .where('type', '=', 'rate_limits.updated')
      .execute();
    expect(events.length).toBeGreaterThan(0);
  });

  it('[API-010] (2) shows the 20 busiest clients of the last hour and of the day', async () => {
    await setLimits({
      user: { rate: 10_000, burst: 10_000 },
      address: { rate: 10_000, burst: 10_000 },
    });
    await database.db.deleteFrom('api_usage').execute();
    // Two hours ago: Sam, many times. Now: 24 addresses, the first the busiest, and Pat.
    now += 60_000;
    const twoHoursAgo = now;
    for (let i = 0; i < 30; i++) await as('sam', { method: 'GET', url: '/api/v1/session' });
    now += 2 * 60 * 60_000;
    for (let a = 1; a <= 24; a++) {
      for (let i = 0; i < 25 - a; i++) {
        await as(null, { method: 'GET', url: '/api/v1/session' }, `100.83.0.${a}`);
      }
    }
    await as('pat', { method: 'GET', url: '/api/v1/nothing-here' });
    expect(now - twoHoursAgo).toBe(2 * 60 * 60_000);

    const hour = await as('admin', { method: 'GET', url: '/api/v1/admin/api-usage?window=hour' });
    expect(hour.statusCode, hour.body).toBe(200);
    const clients = hour.json().clients as {
      client: { kind: string; name: string };
      requests: number;
      errors: number;
    }[];
    expect(clients).toHaveLength(20);
    expect(clients[0]).toMatchObject({
      client: { kind: 'address', name: '100.83.0.1' },
      requests: 24,
      errors: 24,
    });
    expect(clients.map((c) => c.client.name)).not.toContain('sam');

    const day = await as('admin', { method: 'GET', url: '/api/v1/admin/api-usage?window=day' });
    expect((day.json().clients as { client: { name: string } }[])[0]?.client).toMatchObject({
      kind: 'user',
      name: 'sam',
    });
    expect((await as('pat', { method: 'GET', url: '/api/v1/admin/api-usage' })).statusCode).toBe(
      403,
    );
  });

  it('[API-010] keeps usage for eight days', async () => {
    const old = new Date(now - 9 * 24 * 60 * 60_000);
    await database.db
      .insertInto('api_usage')
      .values({
        workspace_id: 1,
        client_kind: 'address',
        client: '100.84.0.1',
        minute: old,
        requests: 5,
      })
      .execute();
    expect(await trimApiUsage(database.db, new Date(now))).toBeGreaterThanOrEqual(1);
    const left = await database.db
      .selectFrom('api_usage')
      .select('client')
      .where('minute', '<', new Date(now - 8 * 24 * 60 * 60_000))
      .execute();
    expect(left).toEqual([]);
  });
});
