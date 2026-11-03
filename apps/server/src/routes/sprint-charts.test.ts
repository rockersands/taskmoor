import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `charts-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.81.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Chart {
  start: { remaining: number; scope: number };
  steps: { ticketId: number; cause: string; remaining: number; scope: number; completed: number }[];
  days: { date: string; remaining: number; scope: number; completed: number }[];
  end: { remaining: number; scope: number; completed: number };
  tickets: { id: number; key: string }[];
  timeZone: string;
}

/**
 * Burndown, burnup and velocity through the API (M1-060; RPT-001): the chart follows a sprint
 * started, completed into, re-estimated and grown after the start; only tickets the viewer may
 * see count; velocity sums what was committed and completed per closed sprint.
 */
describe('sprint charts (M1-060)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let points = 0;
  let board = 0;
  const sprints: Record<string, number> = {};

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
  const post = (url: string, payload: unknown = {}, code = 200) =>
    call('alice', { method: 'POST', url, payload: payload as Record<string, unknown> }, code);
  const patch = (url: string, payload: unknown) =>
    call('alice', { method: 'PATCH', url, payload: payload as Record<string, unknown> });
  const burndown = (who: string, sprint: number, extra = '') =>
    call(who, {
      method: 'GET',
      url: `/api/v1/sprints/${sprint}/burndown${extra}`,
    }) as Promise<Chart>;
  async function ticket(name: string, track: string, pts: number) {
    t[name] = (
      await post(
        '/api/v1/tickets',
        { track, summary: `chart ${name}`, fields: { [points]: pts } },
        201,
      )
    ).ticket;
  }
  async function close(name: string) {
    await database.db
      .updateTable('ticket')
      .set({ status_id: status.Closed as number })
      .where('id', '=', t[name]?.id as number)
      .execute();
    // Through the history too, as every write does: the chart reads the events.
    await database.db
      .insertInto('ticket_change')
      .values({
        workspace_id: 1,
        ticket_id: t[name]?.id as number,
        change_set: '999999',
        field: 'status',
        from_value: String(status.New),
        to_value: String(status.Closed),
        from_display: 'New',
        to_display: 'Closed',
      })
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
    for (const [key, who] of [['CA', ['alice', 'bob']]] as const) {
      const res = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name: `Charts ${key}`, mode: 'shared' },
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
    points = (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/fields', payload: { name: 'Points', type: 'number' } },
        201,
      )
    ).field.id;
    board = (
      await post(
        '/api/v1/boards',
        {
          name: 'Charts',
          kind: 'scrum',
          trackId: tracks.CA,
          source: { query: 'track = CA AND summary ~ chart' },
          columns: [
            { id: 'todo', name: 'To do', statusIds: [status.New] },
            { id: 'doing', name: 'Doing', statusIds: [status.Active, status['In Review']] },
            { id: 'done', name: 'Done', statusIds: [status.Closed] },
          ],
          sprintSettings: {
            estimation: { statistic: 'field', fieldId: points },
            timeTracking: 'none',
            parallelSprints: false,
          },
        },
        201,
      )
    ).board.id;
    await ticket('a', 'CA', 5);
    await ticket('b', 'CA', 3);
    await ticket('c', 'CA', 8);
    await ticket('d', 'CA', 2);
    // A visibility level only alice is on: bob browses the track, but not c.
    const policy = await database.db
      .insertInto('visibility_policy')
      .values({ workspace_id: 1, name: 'Private' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const level = await database.db
      .insertInto('visibility_level')
      .values({ workspace_id: 1, policy_id: policy.id, name: 'Alice only', position: 0 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('visibility_member')
      .values({
        workspace_id: 1,
        level_id: level.id,
        grantee: 'user',
        user_id: users.alice?.id as number,
      })
      .execute();
    await database.db
      .updateTable('ticket')
      .set({ visibility_level_id: level.id })
      .where('id', '=', t.c?.id as number)
      .execute();
    sprints.one = (await post(`/api/v1/boards/${board}/sprints`, { name: 'One' }, 201)).sprint.id;
    await post(`/api/v1/sprints/${sprints.one}/tickets`, {
      tickets: [t.a?.key, t.b?.key, t.c?.key],
    });
    await post(`/api/v1/sprints/${sprints.one}/start`, { endAt: '2030-01-15T09:00:00Z' });
    await close('a');
    await post(`/api/v1/sprints/${sprints.one}/tickets`, { tickets: [t.d?.key] });
    await patch(`/api/v1/tickets/${t.b?.id}`, { fields: { [points]: 1 } });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-001] follows completion, scope added after the start and a changed estimate', async () => {
    const chart = await burndown('alice', sprints.one as number);
    expect(chart.start).toEqual(expect.objectContaining({ remaining: 16, scope: 16 }));
    expect(
      chart.steps.map((s) => [s.ticketId, s.cause, s.remaining, s.scope, s.completed]),
    ).toEqual([
      [t.a?.id, 'completed', 11, 16, 5],
      [t.d?.id, 'added', 13, 18, 5],
      [t.b?.id, 'estimate', 11, 16, 5],
    ]);
    expect(chart.end).toEqual(expect.objectContaining({ remaining: 11, scope: 16, completed: 5 }));
    expect(chart.days).toHaveLength(1);
    expect(chart.days[0]).toMatchObject({ remaining: 11, scope: 16, completed: 5 });
    expect(chart.timeZone).toBe('UTC');
    expect(chart.tickets.map((x) => x.key).sort()).toEqual([t.a?.key, t.b?.key, t.d?.key].sort());
  });

  it('[RPT-001] counts only the tickets the viewer may see, on their time zone', async () => {
    // Bob is not on c's visibility level, so its 8 points are not his to count.
    const chart = await burndown('bob', sprints.one as number);
    expect(chart.start).toEqual(expect.objectContaining({ remaining: 8, scope: 8 }));
    expect(chart.end).toEqual(expect.objectContaining({ remaining: 3, scope: 8, completed: 5 }));
    expect(chart.timeZone).toBe('America/New_York');
    expect((await burndown('bob', sprints.one as number, '?timeZone=Asia/Tokyo')).timeZone).toBe(
      'Asia/Tokyo',
    );
    const bad = await as('bob', {
      method: 'GET',
      url: `/api/v1/sprints/${sprints.one}/burndown?timeZone=Mars/Olympus`,
    });
    expect(bad.statusCode).toBe(400);
  });

  it('[RPT-001] velocity shows committed and completed per closed sprint', async () => {
    sprints.two = (await post(`/api/v1/boards/${board}/sprints`, { name: 'Two' }, 201)).sprint.id;
    await post(`/api/v1/sprints/${sprints.one}/complete`, {
      moveTo: { type: 'sprint', sprintId: sprints.two },
    });
    await post(`/api/v1/sprints/${sprints.two}/start`, { endAt: '2030-02-15T09:00:00Z' });
    await close('d');
    await post(`/api/v1/sprints/${sprints.two}/complete`, { moveTo: { type: 'backlog' } });
    const v = await call('alice', { method: 'GET', url: `/api/v1/boards/${board}/velocity` });
    // One: committed a, b, c (5 + 3 + 8), completed a (5). Two: committed b, c, d (1 + 8 + 2),
    // completed d (2).
    expect(
      v.sprints.map((s: { name: string; committed: number; completed: number }) => [
        s.name,
        s.committed,
        s.completed,
      ]),
    ).toEqual([
      ['One', 16, 5],
      ['Two', 11, 2],
    ]);
    expect(v.average).toBe(3.5);
    // Bob does not see c.
    const vb = await call('bob', { method: 'GET', url: `/api/v1/boards/${board}/velocity` });
    expect(
      vb.sprints.map((s: { committed: number; completed: number }) => [s.committed, s.completed]),
    ).toEqual([
      [8, 5],
      [3, 2],
    ]);
    // By ticket count instead.
    await patch(`/api/v1/boards/${board}`, {
      sprintSettings: {
        estimation: { statistic: 'ticketCount' },
        timeTracking: 'none',
        parallelSprints: false,
      },
    });
    const vc = await call('alice', {
      method: 'GET',
      url: `/api/v1/boards/${board}/velocity?sprints=1`,
    });
    expect(
      vc.sprints.map((s: { name: string; committed: number; completed: number }) => [
        s.name,
        s.committed,
        s.completed,
      ]),
    ).toEqual([['Two', 3, 1]]);
  });

  it('[RPT-001] a future sprint has no chart yet', async () => {
    const three = (await post(`/api/v1/boards/${board}/sprints`, { name: 'Three' }, 201)).sprint.id;
    const res = await as('alice', { method: 'GET', url: `/api/v1/sprints/${three}/burndown` });
    expect(res.statusCode).toBe(409);
  });
});
