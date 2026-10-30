import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `tl-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.91.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Item {
  id: number;
  key: string;
  parentId: number | null;
  start: string | null;
  due: string | null;
  dated: 'own' | 'sprint' | null;
  rollup: { start: string | null; due: string | null; total: number; closed: number } | null;
}

/**
 * A track's timeline (M1-048; AGL-015): own, sprint and rolled-up dates, progress, blocking
 * links and markers, rescheduling through the ticket route, and visibility.
 */
describe('timeline (M1-048)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let trackId = 0;
  let sprintEnd = '';

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };
  const timeline = (who = 'alice') =>
    call(who, { method: 'GET', url: '/api/v1/tracks/TL/timeline' });
  const item = (items: Item[], name: string) => items.find((i) => i.id === t[name]?.id) as Item;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['carol', false],
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
    trackId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'TL', name: 'Launch', mode: 'shared' },
        },
        201,
      )
    ).track.id;
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: members,
        user_id: users.alice?.id as number,
      })
      .execute();
    const types = Object.fromEntries(
      (
        await database.db
          .selectFrom('ticket_type')
          .select(['id', 'name'])
          .where('owner_track_id', 'is', null)
          .execute()
      ).map((y) => [y.name, y.id]),
    );
    const make = async (name: string, summary: string, payload: Record<string, unknown>) => {
      t[name] = (
        await call(
          'alice',
          { method: 'POST', url: '/api/v1/tickets', payload: { track: 'TL', summary, ...payload } },
          201,
        )
      ).ticket;
    };
    await make('goal', 'Launch day', { ticketTypeId: types.Outcome });
    await make('site', 'Build the site', {
      ticketTypeId: types.Feature,
      parent: 'TL-1',
      startDate: '2026-11-02',
      dueDate: '2026-11-10',
    });
    await make('press', 'Press kit', {
      ticketTypeId: types.Feature,
      parent: 'TL-1',
      dueDate: '2026-11-20',
    });
    await make('copy', 'Write the copy', {
      ticketTypeId: types.Subticket,
      parent: 'TL-2',
      startDate: '2026-10-28',
      dueDate: '2026-11-05',
    });
    await make('loose', 'Order the cake', { ticketTypeId: types.Feature });
    // The copy is written: closed.
    await database.db
      .updateTable('ticket')
      .set({ closed_at: new Date('2026-11-01T10:00:00Z') })
      .where('id', '=', t.copy?.id as number)
      .execute();
    // A Scrum board's active sprint dates the cake.
    const board = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: { name: 'Launch', kind: 'scrum', trackId, source: { query: 'track = TL' } },
        },
        201,
      )
    ).board.id;
    const sprint = (
      await call(
        'admin',
        { method: 'POST', url: `/api/v1/boards/${board}/sprints`, payload: {} },
        201,
      )
    ).sprint.id;
    await call('admin', {
      method: 'POST',
      url: `/api/v1/sprints/${sprint}/tickets`,
      payload: { tickets: [t.loose?.id] },
    });
    sprintEnd = '2030-01-15';
    await call('admin', {
      method: 'POST',
      url: `/api/v1/sprints/${sprint}/start`,
      payload: { endAt: `${sprintEnd}T09:00:00Z` },
    });
    await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/tracks/${trackId}/releases`,
        payload: { name: 'Launch', releaseDate: '2026-11-21' },
      },
      201,
    );
    const blocks = await database.db
      .selectFrom('link_type')
      .select('id')
      .where('name', '=', 'Blocks')
      .executeTakeFirstOrThrow();
    await call(
      'alice',
      {
        method: 'POST',
        url: `/api/v1/tickets/${t.site?.key}/links`,
        payload: { linkTypeId: blocks.id, ticket: t.press?.key },
      },
      201,
    );
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-015] rolls a parent’s bar up from its earliest child start to its latest child due', async () => {
    const { items } = await timeline();
    expect(items.map((i: Item) => i.key)).toEqual(['TL-1', 'TL-2', 'TL-3', 'TL-4', 'TL-5']);
    expect(item(items, 'goal')).toMatchObject({
      start: null,
      due: null,
      dated: null,
      rollup: { start: '2026-10-28', due: '2026-11-20', total: 3, closed: 1 },
    });
    expect(item(items, 'site')).toMatchObject({
      parentId: t.goal?.id,
      start: '2026-11-02',
      due: '2026-11-10',
      dated: 'own',
      rollup: { start: '2026-10-28', due: '2026-11-05', total: 1, closed: 1 },
    });
    expect(item(items, 'press')).toMatchObject({
      start: null,
      due: '2026-11-20',
      dated: 'own',
      rollup: null,
    });
  });

  it('[AGL-015] dates a Scrum child by its sprint, and shows sprints, releases and blocking links', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const view = await timeline();
    expect(item(view.items, 'loose')).toMatchObject({
      start: today,
      due: sprintEnd,
      dated: 'sprint',
    });
    expect(view.markers.sprints).toEqual([
      expect.objectContaining({
        name: 'Launch Sprint 1',
        state: 'active',
        start: today,
        end: sprintEnd,
      }),
    ]);
    expect(view.markers.releases).toEqual([
      expect.objectContaining({ name: 'Launch', date: '2026-11-21', shipped: false }),
    ]);
    expect(view.links).toEqual([{ from: t.site?.id, to: t.press?.id }]);
  });

  it('[AGL-015] reschedules through the ticket route, and the roll-up follows', async () => {
    await call('alice', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.press?.key}`,
      payload: { startDate: '2026-11-15', dueDate: '2026-11-25' },
    });
    const { items } = await timeline();
    expect(item(items, 'press')).toMatchObject({ start: '2026-11-15', due: '2026-11-25' });
    expect(item(items, 'goal').rollup).toMatchObject({ start: '2026-10-28', due: '2026-11-25' });
  });

  it('[AGL-015] shows nothing to those who may not browse the track', async () => {
    await call('carol', { method: 'GET', url: '/api/v1/tracks/TL/timeline' }, 404);
    await call('alice', { method: 'GET', url: '/api/v1/tracks/NOPE/timeline' }, 404);
    expect(
      (await call('alice', { method: 'GET', url: `/api/v1/tracks/${trackId}/timeline` })).track.key,
    ).toBe('TL');
  });
});
