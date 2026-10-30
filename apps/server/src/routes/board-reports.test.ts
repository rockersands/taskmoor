import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `flow-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.82.${Math.floor(++address / 250)}.${(address % 250) + 1}`;
const H = 3600;

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

interface Flow {
  timeZone: string;
  from: string;
  to: string;
  dates: string[];
  columns: { id: string; counts: number[] }[];
  unmapped: number[];
}

/**
 * Flow reports through the API (M1-061; RPT-001 (3)): a Kanban board over two tracks, with a
 * week of status history written at known moments. Every number was worked out by hand; a
 * viewer who sees one track, or a board filter, counts only its tickets.
 */
describe('board flow reports (M1-061)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let board = 0;
  const WEEK = '?from=2026-10-05&to=2026-10-09&timeZone=UTC';

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
  const get = (who: string, path: string, code = 200) =>
    call(who, { method: 'GET', url: `/api/v1/boards/${board}/reports/${path}` }, code);
  const columns = (flow: Flow) => Object.fromEntries(flow.columns.map((c) => [c.id, c.counts]));

  /** A ticket's status history at known moments, written as the ticket routes write it. */
  async function history(name: string, steps: [string, string][]) {
    const id = t[name]?.id as number;
    const [first, ...rest] = steps as [[string, string], ...[string, string][]];
    await sql`UPDATE ticket_change SET at = ${first[0]}::timestamptz
               WHERE ticket_id = ${id}::int AND field = 'status'`.execute(database.db);
    let was = first[1];
    for (const [at, to] of rest) {
      await database.db
        .insertInto('ticket_change')
        .values({
          workspace_id: 1,
          ticket_id: id,
          change_set: '999999',
          field: 'status',
          from_value: String(status[was]),
          to_value: String(status[to]),
          from_display: was,
          to_display: to,
          at: new Date(at),
        })
        .execute();
      was = to;
    }
    await database.db
      .updateTable('ticket')
      .set({ status_id: status[was] as number })
      .where('id', '=', id)
      .execute();
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
          time_zone: name === 'bob' ? 'America/New_York' : null,
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    // Bob sees FA only; alice sees both.
    for (const [key, who] of [
      ['FA', ['alice', 'bob']],
      ['FB', ['alice']],
    ] as const) {
      const res = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name: `Flow ${key}`, mode: 'shared' },
        },
        201,
      );
      tracks[key] = res.track.id;
      for (const w of who) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[w]?.id as number,
          })
          .execute();
      }
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
    board = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'Flow',
            kind: 'kanban',
            trackId: tracks.FA,
            source: { query: 'track IN (FA, FB) AND summary ~ flow' },
            columns: [
              { id: 'todo', name: 'To do', statusIds: [status.New] },
              { id: 'doing', name: 'Doing', statusIds: [status.Active] },
              { id: 'review', name: 'Review', statusIds: [status['In Review']] },
              { id: 'done', name: 'Done', statusIds: [status.Closed] },
            ],
            boardFilters: [{ id: 'fa', name: 'FA only', query: 'track = FA' }],
          },
        },
        201,
      )
    ).board.id;
    for (const [name, track, summary] of [
      ['a', 'FA', 'flow a'],
      ['b', 'FA', 'flow b'],
      ['c', 'FB', 'flow c'],
      ['d', 'FA', 'flow d'],
      ['other', 'FA', 'unrelated'],
    ] as const) {
      t[name] = (
        await call(
          'alice',
          { method: 'POST', url: '/api/v1/tickets', payload: { track, summary } },
          201,
        )
      ).ticket;
    }
    await history('a', [
      ['2026-10-01T10:00Z', 'New'],
      ['2026-10-05T09:00Z', 'Active'],
      ['2026-10-06T09:00Z', 'In Review'],
      ['2026-10-06T21:00Z', 'Closed'],
    ]);
    await history('b', [
      ['2026-10-02T10:00Z', 'New'],
      ['2026-10-05T12:00Z', 'Active'],
      ['2026-10-07T12:00Z', 'Closed'],
    ]);
    await history('c', [
      ['2026-10-03T10:00Z', 'New'],
      ['2026-10-07T12:00Z', 'Active'],
      ['2026-10-08T00:00Z', 'Closed'],
    ]);
    await history('d', [
      ['2026-10-04T10:00Z', 'New'],
      ['2026-10-08T10:00Z', 'Active'],
    ]);
    // Not on the board: counts nowhere.
    await history('other', [
      ['2026-10-01T10:00Z', 'New'],
      ['2026-10-05T10:00Z', 'Closed'],
    ]);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-001] counts the board’s tickets per column at the end of each day', async () => {
    const flow = (await get('alice', `cumulative-flow${WEEK}`)) as Flow;
    expect(flow.dates).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
    ]);
    expect(columns(flow)).toEqual({
      todo: [2, 2, 1, 0, 0],
      doing: [2, 1, 1, 1, 1],
      review: [0, 0, 0, 0, 0],
      // c's move at midnight is Thursday's.
      done: [0, 1, 2, 3, 3],
    });
    expect(flow.unmapped).toEqual([0, 0, 0, 0, 0]);
    // Bob does not see FB: c is not his to count. A board filter narrows the same way.
    const bob = columns((await get('bob', `cumulative-flow${WEEK}`)) as Flow);
    expect(bob).toEqual({
      todo: [1, 1, 1, 0, 0],
      doing: [2, 1, 0, 1, 1],
      review: [0, 0, 0, 0, 0],
      done: [0, 1, 2, 2, 2],
    });
    expect(columns((await get('alice', `cumulative-flow${WEEK}&filters=fa`)) as Flow)).toEqual(bob);
  });

  it('[RPT-001] uses the viewer’s days: 30 up to today by default, on their time zone', async () => {
    const flow = (await get('bob', 'cumulative-flow')) as Flow;
    expect(flow.timeZone).toBe('America/New_York');
    expect(flow.dates).toHaveLength(30);
    expect(flow.to).toBe(flow.dates[29]);
    const week = (await get('bob', 'cumulative-flow?days=7&to=2026-10-09&timeZone=UTC')) as Flow;
    expect([week.from, week.to, week.dates.length]).toEqual(['2026-10-03', '2026-10-09', 7]);
    // A window that runs past today stops at today.
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
    const ahead = (await get('alice', `cumulative-flow?from=${day(-5)}&to=${day(10)}`)) as Flow;
    expect(ahead.to).toBe(day(10));
    expect(ahead.dates).toHaveLength(6);
    expect(ahead.dates.at(-1)).toBe(day(0));
  });

  it('[RPT-001] the control chart counts the chosen columns, with two rolling averages', async () => {
    const chart = await get('alice', `cycle-time${WEEK}&window=3`);
    expect(chart.columns).toEqual([
      { id: 'todo', name: 'To do', chosen: false },
      { id: 'doing', name: 'Doing', chosen: true },
      { id: 'review', name: 'Review', chosen: true },
      { id: 'done', name: 'Done', chosen: false },
    ]);
    expect(
      chart.points.map(
        (p: { ticket: { key: string }; at: string; cycle: number; average: number }) => [
          p.ticket.key,
          p.at,
          p.cycle / H,
          p.average / H,
        ],
      ),
    ).toEqual([
      [t.a?.key, '2026-10-06T21:00:00.000Z', 36, 32],
      [t.b?.key, '2026-10-07T12:00:00.000Z', 48, 32],
      [t.c?.key, '2026-10-08T00:00:00.000Z', 12, 32],
    ]);
    expect(chart.averaging).toEqual({ method: 'tickets', size: 3 });
    expect([chart.start, chart.end]).toEqual([
      '2026-10-05T00:00:00.000Z',
      '2026-10-10T00:00:00.000Z',
    ]);
    expect(chart.statistics).toMatchObject({
      count: 3,
      average: 32 * H,
      median: 36 * H,
      p85: 48 * H,
      min: 12 * H,
      max: 48 * H,
    });
    // 48 h fits 20 bins of 4 h.
    expect(chart.histogram.width).toBe(4 * H);
    expect(chart.histogram.counts).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 1]);

    // Half a day either side of each point.
    const days = await get('alice', `cycle-time${WEEK}&average=days&window=1`);
    expect(days.points.map((p: { average: number }) => p.average / H)).toEqual([36, 30, 30]);
    // Leaving review out of the work.
    const doing = await get('alice', `cycle-time${WEEK}&columns=doing`);
    expect(doing.points.map((p: { cycle: number }) => p.cycle / H)).toEqual([24, 48, 12]);
    // The newest points, with every point in the numbers.
    const two = await get('alice', `cycle-time${WEEK}&window=3&limit=2`);
    expect(two.total).toBe(3);
    expect(two.points.map((p: { ticket: { key: string } }) => p.ticket.key)).toEqual([
      t.b?.key,
      t.c?.key,
    ]);
    expect(two.statistics.count).toBe(3);
    // Bob never sees c.
    const bob = await get('bob', `cycle-time${WEEK}`);
    expect(bob.points.map((p: { ticket: { key: string } }) => p.ticket.key)).toEqual([
      t.a?.key,
      t.b?.key,
    ]);
  });

  it('[RPT-001] adds up the time in each status inside the window', async () => {
    const report = await get('alice', `time-in-status${WEEK}`);
    expect(
      report.statuses.map(
        (s: {
          status: { name: string };
          columnId: string | null;
          tickets: number;
          total: number;
          average: number;
          entries: number;
        }) => [s.status.name, s.columnId, s.total / H, s.tickets, s.average / H, s.entries],
      ),
    ).toEqual([
      ['New', 'todo', 163, 4, 40.75, 0],
      ['Active', 'doing', 122, 4, 30.5, 4],
      ['In Review', 'review', 12, 1, 12, 1],
      ['Closed', 'done', 183, 3, 61, 3],
    ]);
  });

  it('[RPT-001] refuses a window, a filter or columns it cannot use', async () => {
    const fields = async (path: string) => (await get('alice', path, 400)).fields;
    expect(await fields('cumulative-flow?from=2026-10-09&to=2026-10-05')).toEqual({
      from: 'after_to',
    });
    expect(await fields('cumulative-flow?from=2020-01-01&to=2026-10-05')).toEqual({
      from: 'too_long',
    });
    expect(await fields('time-in-status?from=2026-02-30')).toEqual({ from: 'invalid' });
    expect(await fields('cumulative-flow?filters=nope')).toEqual({ filters: 'not_found' });
    expect(await fields('cycle-time?columns=nope')).toEqual({ columns: 'not_found' });
    expect(await fields('cycle-time?columns=,')).toEqual({ columns: 'empty' });
    expect(Object.keys(await fields('cycle-time?days=0'))).toEqual(['days']);
    expect((await get('alice', 'cycle-time?average=median', 400)).error).toBe('invalid_fields');
    const anonymous = await app.inject({
      method: 'GET',
      url: `/api/v1/boards/${board}/reports/cumulative-flow`,
      remoteAddress: nextAddress(),
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
