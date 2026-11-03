import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.71.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

describe('subticket progress (CORE-032)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: cookies[who] ?? '' },
    });

  const typeAt = async (track: string, rank: number) => {
    const types = (
      await as('admin', { method: 'GET', url: `/api/v1/tracks/${track}/ticket-types` })
    ).json().ticketTypes as { id: number; level: { rank: number } }[];
    return types.find((t) => t.level.rank === rank)?.id as number;
  };
  const create = async (body: Record<string, unknown>) => {
    const res = await as('admin', { method: 'POST', url: '/api/v1/tickets', payload: body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as {
      id: number;
      key: string;
      ticketType: { level: { rank: number } };
    };
  };
  const close = async (id: number) => {
    const offered = (
      await as('admin', { method: 'GET', url: `/api/v1/tickets/${id}/transitions` })
    ).json().transitions as { id: number; to: { stage: string } }[];
    const res = await as('admin', {
      method: 'POST',
      url: `/api/v1/tickets/${id}/transitions`,
      payload: { transitionId: offered.find((o) => o.to.stage === 'closed')?.id },
    });
    expect(res.statusCode, res.body).toBe(200);
  };
  const progress = async (who: string, list: number[]) => {
    const res = await as(who, {
      method: 'POST',
      url: '/api/v1/tickets/subticket-progress',
      payload: { ids: list },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().progress as Record<string, { total: number; closed: number }>;
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['nobody', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[name] = row.id;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      const header = res.headers['set-cookie'];
      const list = Array.isArray(header) ? header : header ? [header] : [];
      cookies[name] =
        (list.find((c) => c.startsWith(`${SESSION_COOKIE}=`)) ?? '').split(';')[0] ?? '';
    }
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'SUB', name: 'Sub', mode: 'shared' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const role = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: res.json().track.id,
        role_id: role.id,
        user_id: ids.alice as number,
      })
      .execute();
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-032] counts the tickets under a ticket and those in a closed stage', async () => {
    const parent = await create({ track: 'SUB', summary: 'Parent' });
    const sub = await typeAt('SUB', -1);
    const one = await create({
      track: 'SUB',
      summary: 'One',
      ticketTypeId: sub,
      parent: parent.key,
    });
    await create({ track: 'SUB', summary: 'Two', ticketTypeId: sub, parent: parent.key });
    expect(await progress('alice', [parent.id])).toEqual({
      [parent.id]: { total: 2, closed: 0 },
    });
    await close(one.id);
    expect(await progress('alice', [parent.id])).toEqual({
      [parent.id]: { total: 2, closed: 1 },
    });
    // A ticket with none is left out, and a subticket has none of its own.
    const lone = await create({ track: 'SUB', summary: 'Lone' });
    expect(await progress('alice', [lone.id, one.id])).toEqual({});
  });

  it('[CORE-032] the page lists them through search, in key order, as far as the person sees', async () => {
    const parent = await create({ track: 'SUB', summary: 'Listed parent' });
    const sub = await typeAt('SUB', -1);
    const one = await create({ track: 'SUB', summary: 'A', ticketTypeId: sub, parent: parent.key });
    const two = await create({ track: 'SUB', summary: 'B', ticketTypeId: sub, parent: parent.key });
    const list = (who: string) =>
      as(who, {
        method: 'POST',
        url: '/api/v1/search',
        payload: {
          q: `parent = "${parent.key}" ORDER BY key ASC`,
          limit: 50,
          fields: 'summary,status',
          count: false,
        },
      });
    const seen = await list('alice');
    expect(seen.statusCode, seen.body).toBe(200);
    expect(seen.json().tickets).toMatchObject([
      { key: one.key, summary: 'A', status: { stage: 'new' } },
      { key: two.key, summary: 'B', status: { stage: 'new' } },
    ]);
    expect((await list('nobody')).json().tickets).toEqual([]);
  });

  it('[CORE-032] counts nothing for someone who may not see the tickets', async () => {
    const parent = await create({ track: 'SUB', summary: 'Hidden parent' });
    const sub = await typeAt('SUB', -1);
    await create({ track: 'SUB', summary: 'Hidden', ticketTypeId: sub, parent: parent.key });
    expect(await progress('nobody', [parent.id])).toEqual({});
    expect(Object.keys(await progress('alice', [parent.id]))).toEqual([String(parent.id)]);
  });

  it('[CORE-032] leaves the trash out', async () => {
    const parent = await create({ track: 'SUB', summary: 'With trash' });
    const sub = await typeAt('SUB', -1);
    const gone = await create({
      track: 'SUB',
      summary: 'Gone',
      ticketTypeId: sub,
      parent: parent.key,
    });
    await create({ track: 'SUB', summary: 'Kept', ticketTypeId: sub, parent: parent.key });
    const res = await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${gone.id}` });
    expect(res.statusCode, res.body).toBe(204);
    expect(await progress('alice', [parent.id])).toEqual({
      [parent.id]: { total: 1, closed: 0 },
    });
  });

  it('[CORE-032] answers for every card of the largest board, and refuses a longer list', async () => {
    const parent = await create({ track: 'SUB', summary: 'On a large board' });
    const sub = await typeAt('SUB', -1);
    await create({ track: 'SUB', summary: 'Under it', ticketTypeId: sub, parent: parent.key });
    // A board's data holds 50,000 cards at most (`limit` of GET /boards/:id/data).
    const board = [parent.id, ...Array.from({ length: 49_999 }, (_, i) => 1_000_000 + i)];
    expect(board).toHaveLength(50_000);
    expect(await progress('alice', board)).toEqual({ [parent.id]: { total: 1, closed: 0 } });
    const long = await as('alice', {
      method: 'POST',
      url: '/api/v1/tickets/subticket-progress',
      payload: { ids: [...board, 2_000_000] },
    });
    expect(long.statusCode).toBe(400);
  });

  it('[CORE-032] refuses anyone not signed in', async () => {
    const stranger = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets/subticket-progress',
      payload: { ids: [1] },
      remoteAddress: nextAddress(),
    });
    expect(stranger.statusCode).toBe(401);
  });
});
