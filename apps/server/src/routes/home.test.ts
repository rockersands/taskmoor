import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { RECENT_KEPT } from './home';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.72.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

interface TicketJson {
  id: number;
  key: string;
}

describe('the home page lists (M1-052)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  let trackId = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const keys = async (who: string, list: 'followed' | 'recent', query = '') => {
    const res = await as(who, { method: 'GET', url: `/api/v1/me/${list}-tickets${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().tickets as TicketJson[]).map((t) => t.key);
  };
  const visit = (who: string, ticket: TicketJson) =>
    as(who, { method: 'PUT', url: `/api/v1/me/recent-tickets/${ticket.id}` });
  async function create(who: string, summary = 'Work'): Promise<TicketJson> {
    const res = await as(who, {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'HOME', summary },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as TicketJson;
  }
  async function member(who: string, on: boolean) {
    const role = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    const res = await as('admin', {
      method: on ? 'PUT' : 'DELETE',
      url: `/api/v1/tracks/${trackId}/roles/${role.id}/users/${users[who]?.id}`,
    });
    expect(res.statusCode, res.body).toBe(204);
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      users[name] = { id: row.id, cookie: sessionCookie(res.headers['set-cookie']) };
    }
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'HOME', name: 'Home', mode: 'shared' },
    });
    trackId = res.json().track.id;
    await member('alice', true);
    await member('bob', true);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-019] lists the tickets a person follows, newest change first, while they may see them', async () => {
    const first = await create('alice', 'First');
    const second = await create('alice', 'Second');
    // Creating a ticket follows it; Bob follows the first one himself.
    expect(await keys('alice', 'followed')).toEqual([second.key, first.key]);
    const follow = await as('bob', {
      method: 'PUT',
      url: `/api/v1/tickets/${first.id}/followers/me`,
    });
    expect(follow.statusCode, follow.body).toBeLessThan(300);
    expect(await keys('bob', 'followed')).toEqual([first.key]);
    // An edit moves the first ahead.
    const edit = await as('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${first.id}`,
      payload: { summary: 'First, changed' },
    });
    expect(edit.statusCode, edit.body).toBe(200);
    expect(await keys('alice', 'followed', '?limit=1')).toEqual([first.key]);
    // Following gives no access of its own.
    await member('bob', false);
    expect(await keys('bob', 'followed')).toEqual([]);
    await member('bob', true);
  });

  it('[AGL-018] records the tickets a person opens, newest first, and keeps the last 50', async () => {
    const a = await create('alice', 'Opened');
    const b = await create('alice', 'Opened too');
    expect((await visit('bob', a)).statusCode).toBe(204);
    expect((await visit('bob', b)).statusCode).toBe(204);
    expect((await visit('bob', a)).statusCode).toBe(204);
    expect(await keys('bob', 'recent')).toEqual([a.key, b.key]);
    expect(await keys('alice', 'recent')).toEqual([]);

    for (let i = 0; i < RECENT_KEPT + 3; i++) {
      const ticket = await create('alice', `Bulk ${i}`);
      expect((await visit('alice', ticket)).statusCode).toBe(204);
    }
    const kept = await database.db
      .selectFrom('ticket_visit')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', users.alice?.id as number)
      .executeTakeFirstOrThrow();
    expect(Number(kept.n)).toBe(RECENT_KEPT);
    const recent = await keys('alice', 'recent', '?limit=50');
    expect(recent).toHaveLength(RECENT_KEPT);
    expect(recent[0]).toMatch(/^HOME-\d+$/);
  });

  it('[AGL-019] leaves out tickets in the trash and tickets the person may no longer see', async () => {
    const kept = await create('alice', 'Stays');
    const trashed = await create('alice', 'Goes to the trash');
    await visit('bob', kept);
    await visit('bob', trashed);
    const del = await as('admin', { method: 'DELETE', url: `/api/v1/tickets/${trashed.id}` });
    expect(del.statusCode, del.body).toBeLessThan(300);
    const recent = await keys('bob', 'recent');
    expect(recent[0]).toBe(kept.key);
    expect(recent).not.toContain(trashed.key);
    await member('bob', false);
    expect(await keys('bob', 'recent')).toEqual([]);
    // Nor is a visit to a ticket out of sight recorded.
    expect((await visit('bob', kept)).statusCode).toBe(404);
    await member('bob', true);
  });

  it('needs a signed-in person', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/me/recent-tickets',
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(401);
  });
});
