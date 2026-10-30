import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `lv-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.92.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/**
 * The list and calendar views' reads (M1-049; AGL-016, AGL-017): format rules matched as the
 * viewer against the tickets shown, and a track's dated tickets, sprints and releases for a
 * calendar range.
 */
describe('list and calendar views (M1-049)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let trackId = 0;

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
  const format = (who: string, payload: unknown, code = 200) =>
    call(
      who,
      {
        method: 'POST',
        url: '/api/v1/search/format-rules',
        payload: payload as Record<string, unknown>,
      },
      code,
    );
  const ids = () => Object.values(t).map((x) => x.id);

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
          payload: { key: 'LV', name: 'Views', mode: 'shared' },
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
    const high = (
      await database.db
        .selectFrom('priority')
        .select('id')
        .where('name', '=', 'High')
        .executeTakeFirstOrThrow()
    ).id;
    const make = async (name: string, summary: string, payload: Record<string, unknown>) => {
      t[name] = (
        await call(
          'alice',
          { method: 'POST', url: '/api/v1/tickets', payload: { track: 'LV', summary, ...payload } },
          201,
        )
      ).ticket;
    };
    await make('late', 'Late and open', { dueDate: '2026-01-10' });
    await make('done', 'Late but closed', { dueDate: '2026-01-12' });
    await make('ahead', 'Due later', { dueDate: '2099-03-01', priorityId: high });
    await make('loose', 'No dates', {});
    await make('starts', 'Starts in March', { startDate: '2099-03-05' });
    const closed = await database.db
      .selectFrom('status')
      .select('id')
      .where('stage', '=', 'closed')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('ticket')
      .set({ status_id: closed.id, closed_at: new Date('2026-01-13T10:00:00Z') })
      .where('id', '=', t.done?.id as number)
      .execute();
    const board = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: { name: 'Views', kind: 'scrum', trackId, source: { query: 'track = LV' } },
        },
        201,
      )
    ).board.id;
    await call(
      'admin',
      { method: 'POST', url: `/api/v1/boards/${board}/sprints`, payload: {} },
      201,
    );
    const sprint = (await call('admin', { method: 'GET', url: `/api/v1/boards/${board}/sprints` }))
      .sprints[0].id;
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/sprints/${sprint}`,
      payload: { startAt: '2099-02-25T09:00:00Z', endAt: '2099-03-10T09:00:00Z', version: 1 },
    });
    await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/tracks/${trackId}/releases`,
        payload: { name: 'March', releaseDate: '2099-03-15' },
      },
      201,
    );
    await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/tracks/${trackId}/releases`,
        payload: { name: 'May', releaseDate: '2099-05-01' },
      },
      201,
    );
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-016] colours overdue rows: a rule matches the open tickets due before now', async () => {
    const { matches, errors } = await format('alice', {
      ids: ids(),
      rules: [
        { id: 'overdue', query: 'due < now() AND stage != closed' },
        { id: 'urgent', query: 'priority = High' },
      ],
    });
    expect(errors).toEqual({});
    expect(matches).toEqual({ overdue: [t.late?.id], urgent: [t.ahead?.id] });
  });

  it('[AGL-016] tests only the tickets shown, reports a bad rule alone, and filters as the viewer', async () => {
    // Only the tickets asked about: the late one is left out here.
    const some = await format('alice', {
      ids: [t.done?.id, t.ahead?.id],
      rules: [{ id: 'overdue', query: 'due < now() AND stage != closed' }],
    });
    expect(some.matches).toEqual({ overdue: [] });
    const bad = await format('alice', {
      ids: ids(),
      rules: [
        { id: 'broken', query: 'nonsense ~~ =' },
        { id: 'urgent', query: 'priority = High' },
      ],
    });
    expect(Object.keys(bad.errors)).toEqual(['broken']);
    expect(bad.matches).toEqual({ broken: [], urgent: [t.ahead?.id] });
    // Someone who cannot see the track learns nothing about its tickets.
    const carol = await format('carol', {
      ids: ids(),
      rules: [{ id: 'any', query: 'priority = High' }],
    });
    expect(carol.matches).toEqual({ any: [] });
    await format(
      'alice',
      {
        ids: ids(),
        rules: Array.from({ length: 21 }, (_, i) => ({ id: `r${i}`, query: 'stage = new' })),
      },
      400,
    );
  });

  it('[AGL-017] gives a month’s dated tickets with the sprints and releases that overlap it', async () => {
    const march = await call('alice', {
      method: 'GET',
      url: '/api/v1/tracks/LV/calendar?from=2099-03-01&to=2099-03-31',
    });
    expect(march.tickets.map((k: { key: string }) => k.key)).toEqual([t.ahead?.key, t.starts?.key]);
    expect(march.tickets[1]).toMatchObject({ start: '2099-03-05', due: null, stage: 'new' });
    expect(march.sprints).toEqual([
      expect.objectContaining({ name: 'Views Sprint 1', start: '2099-02-25', end: '2099-03-10' }),
    ]);
    expect(march.releases.map((r: { name: string }) => r.name)).toEqual(['March']);
    await call(
      'alice',
      { method: 'GET', url: '/api/v1/tracks/LV/calendar?from=2099-03-01&to=2099-09-30' },
      400,
    );
    await call(
      'alice',
      { method: 'GET', url: '/api/v1/tracks/LV/calendar?from=2099-03-31&to=2099-03-01' },
      400,
    );
    await call(
      'carol',
      { method: 'GET', url: '/api/v1/tracks/LV/calendar?from=2099-03-01&to=2099-03-31' },
      404,
    );
  });
});
