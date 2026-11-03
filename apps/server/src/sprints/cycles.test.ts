import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { FieldCatalogs } from '../fields/catalog';
import { addDays, rollSprintCycles } from './cycles';

// Made for this run: no password is written in the repository.
const PASSWORD = `cycles-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.78.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const MADRID = 'Europe/Madrid';
const at = (iso: string) => new Date(iso);

/**
 * Auto-rolling cycles (M1-045; AGL-012): with a two-week cycle the next sprint is ready before
 * the active one ends, and at the end the unfinished tickets move into it and it starts. Days
 * are counted on the cycle's wall clock (Madrid leaves summer time on 2026-10-25), a worker
 * that was down catches up, and two workers never roll a board twice.
 */
describe('sprint cycles (M1-045)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let catalogs: FieldCatalogs;
  const users: Record<string, { id: number; cookie: string }> = {};
  const trackIds: Record<string, number> = {};
  const status: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (url: string) => as('alice', { method: 'GET', url });
  const post = (url: string, payload: unknown = {}) =>
    as('alice', { method: 'POST', url, payload: payload as Record<string, unknown> });
  const patch = (url: string, payload: unknown) =>
    as('alice', { method: 'PATCH', url, payload: payload as Record<string, unknown> });
  const S = (name: string) => status[name] as number;
  const T = (name: string) => tickets[name] as { id: number; key: string };
  const roll = (now: string) => rollSprintCycles(database.db, catalogs, at(now));

  async function ticket(name: string, group: string) {
    const res = await post('/api/v1/tickets', { track: 'CY', summary: `${group} ${name}` });
    expect(res.statusCode, res.body).toBe(201);
    tickets[name] = res.json().ticket as { id: number; key: string };
  }
  async function closeTicket(name: string) {
    await database.db
      .updateTable('ticket')
      .set({ status_id: S('Closed') })
      .where('id', '=', T(name).id)
      .execute();
  }
  const cycle = (extra: Record<string, unknown> = {}) => ({
    estimation: { statistic: 'ticketCount' },
    timeTracking: 'none',
    parallelSprints: false,
    cycle: { lengthDays: 14, timeZone: MADRID },
    ...extra,
  });
  async function board(name: string, group: string, sprintSettings: unknown = cycle(), key = 'CY') {
    // A track has one board (ADR-116): each test starts the track's board afresh.
    await database.db
      .deleteFrom('board')
      .where('location_track_id', '=', trackIds[key] as number)
      .execute();
    const res = await post('/api/v1/boards', {
      name,
      kind: 'scrum',
      trackId: trackIds[key],
      source: { query: `track = ${key} AND summary ~ ${group}` },
      columns: [
        { id: 'todo', name: 'To do', statusIds: [S('New')] },
        { id: 'doing', name: 'Doing', statusIds: [S('Active'), S('In Review')] },
        { id: 'done', name: 'Done', statusIds: [S('Closed')] },
      ],
      sprintSettings,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().board.id as number;
  }
  async function sprint(boardId: number, body: Record<string, unknown> = {}) {
    const res = await post(`/api/v1/boards/${boardId}/sprints`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().sprint.id as number;
  }
  async function add(sprintId: number, names: string[]) {
    const res = await post(`/api/v1/sprints/${sprintId}/tickets`, {
      tickets: names.map((n) => T(n).key),
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function start(sprintId: number, startAt: string, endAt: string) {
    const res = await post(`/api/v1/sprints/${sprintId}/start`, { startAt, endAt });
    expect(res.statusCode, res.body).toBe(200);
  }
  /** The board's sprints in order, with their dates as ISO text. */
  async function sprintsOf(boardId: number) {
    const rows = await database.db
      .selectFrom('sprint')
      .select(['id', 'name', 'state', 'start_at', 'end_at', 'started_at', 'completed_at'])
      .where('board_id', '=', boardId)
      .orderBy('sequence')
      .execute();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      state: r.state,
      startAt: r.start_at?.toISOString() ?? null,
      endAt: r.end_at?.toISOString() ?? null,
      startedAt: r.started_at?.toISOString() ?? null,
      completedAt: r.completed_at?.toISOString() ?? null,
    }));
  }
  /** The open sprint each ticket is in now, by sprint id. */
  async function openSprintOf(names: string[]) {
    const rows = await database.db
      .selectFrom('sprint_ticket')
      .select(['ticket_id', 'sprint_id'])
      .where('open', '=', true)
      .where(
        'ticket_id',
        'in',
        names.map((n) => T(n).id),
      )
      .execute();
    return Object.fromEntries(
      names.map((n) => [n, rows.find((r) => r.ticket_id === T(n).id)?.sprint_id ?? null]),
    );
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    catalogs = new FieldCatalogs(database.db);
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    for (const key of ['CY', 'CZ']) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Cycles ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      trackIds[key] = res.json().track.id;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: trackIds[key] as number,
          role_id: members,
          user_id: users.alice?.id as number,
        })
        .execute();
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-012] counts days on the wall clock of the cycle’s time zone', () => {
    // 09:00 in Madrid before the change to winter time, two weeks later 09:00 after it.
    expect(addDays(at('2026-10-19T07:00:00Z'), 14, MADRID).toISOString()).toBe(
      '2026-11-02T08:00:00.000Z',
    );
    expect(addDays(at('2026-03-23T08:00:00Z'), 14, MADRID).toISOString()).toBe(
      '2026-04-06T07:00:00.000Z',
    );
    expect(addDays(at('2026-10-19T07:00:00Z'), 14, 'UTC').toISOString()).toBe(
      '2026-11-02T07:00:00.000Z',
    );
  });

  it('[AGL-012] with a two-week cycle the next sprint is ready, and at the end the unfinished tickets move into it and it starts', async () => {
    for (const n of ['c1', 'c2', 'c3']) await ticket(n, 'grpc');
    const boardId = await board('Cycle', 'grpc');
    const one = await sprint(boardId);
    await add(one, ['c1', 'c2', 'c3']);
    await start(one, '2026-10-05T07:00:00Z', '2026-10-19T07:00:00Z');

    // Before the end: the next sprint is made ready once, from the end for two weeks.
    let run = await roll('2026-10-18T12:00:00Z');
    expect(run).toMatchObject({ prepared: 1, rolled: 0, failed: [] });
    expect((await roll('2026-10-18T12:01:00Z')).prepared).toBe(0);
    let list = await sprintsOf(boardId);
    expect(list.map((s) => [s.name, s.state, s.startAt, s.endAt])).toEqual([
      ['Cycle Sprint 1', 'active', '2026-10-05T07:00:00.000Z', '2026-10-19T07:00:00.000Z'],
      ['Cycle Sprint 2', 'future', '2026-10-19T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
    ]);
    const two = list[1]?.id as number;

    // At the end: c1 is done and stays; c2 and c3 move on; the next one after is ready.
    await closeTicket('c1');
    run = await roll('2026-10-19T07:00:30Z');
    expect(run).toMatchObject({ rolled: 1, prepared: 1, failed: [] });
    list = await sprintsOf(boardId);
    expect(list.map((s) => [s.name, s.state, s.startedAt, s.completedAt, s.endAt])).toEqual([
      // A person started it: when they did.
      [
        'Cycle Sprint 1',
        'closed',
        expect.any(String),
        '2026-10-19T07:00:00.000Z',
        '2026-10-19T07:00:00.000Z',
      ],
      ['Cycle Sprint 2', 'active', '2026-10-19T07:00:00.000Z', null, '2026-11-02T08:00:00.000Z'],
      ['Cycle Sprint 3', 'future', null, null, '2026-11-16T08:00:00.000Z'],
    ]);
    expect(await openSprintOf(['c1', 'c2', 'c3'])).toEqual({ c1: null, c2: two, c3: two });
    const report = (await get(`/api/v1/sprints/${one}/report`)).json();
    expect(report.completed.map((t: { key: string }) => t.key)).toEqual([T('c1').key]);
    expect(report.notCompleted.map((t: { key: string }) => t.key).sort()).toEqual(
      [T('c2').key, T('c3').key].sort(),
    );
    // Carried-over tickets are committed scope of the next sprint, not scope change.
    const next = (await get(`/api/v1/sprints/${two}/report`)).json();
    expect(next.notCompleted.map((t: { addedAfterStart: boolean }) => t.addedAfterStart)).toEqual([
      false,
      false,
    ]);
    // Nobody did it: the events have no actor.
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'actor_id'])
      .where('type', 'in', ['sprint.completed', 'sprint.started'])
      .where('subject_id', 'in', [String(one), String(two)])
      .orderBy('id')
      .execute();
    expect(events).toEqual([
      { type: 'sprint.started', actor_id: users.alice?.id },
      { type: 'sprint.completed', actor_id: null },
      { type: 'sprint.started', actor_id: null },
    ]);
  });

  it('[AGL-012] a worker that was down catches up one cycle at a time', async () => {
    const boardId = (
      await database.db
        .selectFrom('board')
        .select('id')
        .where('name', '=', 'Cycle')
        .executeTakeFirstOrThrow()
    ).id;
    // Sprint 2 ended on 2 November and Sprint 3 on 16 November; Sprint 4 ends on 30 November.
    const run = await roll('2026-12-01T12:00:00Z');
    expect(run).toMatchObject({ rolled: 3, failed: [] });
    const list = await sprintsOf(boardId);
    expect(list.map((s) => [s.name, s.state, s.startedAt, s.endAt])).toEqual([
      ['Cycle Sprint 1', 'closed', expect.any(String), '2026-10-19T07:00:00.000Z'],
      ['Cycle Sprint 2', 'closed', '2026-10-19T07:00:00.000Z', '2026-11-02T08:00:00.000Z'],
      ['Cycle Sprint 3', 'closed', '2026-11-02T08:00:00.000Z', '2026-11-16T08:00:00.000Z'],
      ['Cycle Sprint 4', 'closed', '2026-11-16T08:00:00.000Z', '2026-11-30T08:00:00.000Z'],
      ['Cycle Sprint 5', 'active', '2026-11-30T08:00:00.000Z', '2026-12-14T08:00:00.000Z'],
      ['Cycle Sprint 6', 'future', null, '2026-12-28T08:00:00.000Z'],
    ]);
    const five = list[4]?.id as number;
    expect(await openSprintOf(['c2', 'c3'])).toEqual({ c2: five, c3: five });
  });

  it('[AGL-012] keeps the dates the team gave the next sprint, and two workers roll a board once', async () => {
    for (const n of ['d1', 'd2']) await ticket(n, 'grpd');
    const boardId = await board('Twin', 'grpd');
    const one = await sprint(boardId);
    // Planned by the team: starts a day after the first ends, and runs three weeks.
    const two = await sprint(boardId, {
      name: 'Release push',
      startAt: '2026-10-20T07:00:00Z',
      endAt: '2026-11-10T08:00:00Z',
    });
    await add(one, ['d1', 'd2']);
    await start(one, '2026-10-05T07:00:00Z', '2026-10-19T07:00:00Z');
    const [a, b] = await Promise.all([roll('2026-10-19T09:00:00Z'), roll('2026-10-19T09:00:00Z')]);
    // Across both workers this board rolled once.
    const rolled = await database.db
      .selectFrom('domain_event')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .where('type', '=', 'sprint.completed')
      .where('subject_id', '=', String(one))
      .executeTakeFirstOrThrow();
    expect(Number(rolled.n)).toBe(1);
    expect((a?.failed.length ?? 0) + (b?.failed.length ?? 0)).toBe(0);
    const list = await sprintsOf(boardId);
    expect(list.map((s) => [s.name, s.state, s.startAt, s.endAt])).toEqual([
      ['Twin Sprint 1', 'closed', '2026-10-05T07:00:00.000Z', '2026-10-19T07:00:00.000Z'],
      ['Release push', 'active', '2026-10-20T07:00:00.000Z', '2026-11-10T08:00:00.000Z'],
      ['Twin Sprint 3', 'future', '2026-11-10T08:00:00.000Z', '2026-11-24T08:00:00.000Z'],
    ]);
    expect(await openSprintOf(['d1', 'd2'])).toEqual({ d1: two, d2: two });
  });

  it('[AGL-012] leaves boards alone without a cycle or an active sprint', async () => {
    await ticket('e1', 'grpe');
    const plain = await board('Plain', 'grpe', {
      estimation: { statistic: 'ticketCount' },
      timeTracking: 'none',
      parallelSprints: false,
    });
    const s1 = await sprint(plain);
    await add(s1, ['e1']);
    await start(s1, '2026-10-05T07:00:00Z', '2026-10-19T07:00:00Z');
    const idle = await board('Idle', 'grpe', cycle(), 'CZ');
    await sprint(idle);
    await roll('2027-01-01T00:00:00Z');
    expect((await sprintsOf(plain)).map((s) => s.state)).toEqual(['active']);
    expect((await sprintsOf(idle)).map((s) => s.state)).toEqual(['future']);
  });

  it('[AGL-012] checks the cycle setting', async () => {
    const boardId = await board('Checks', 'grpf');
    const refused = async (sprintSettings: unknown) => {
      const res = await patch(`/api/v1/boards/${boardId}`, { sprintSettings });
      expect(res.statusCode, res.body).toBe(400);
      return res.json().fields as Record<string, string>;
    };
    expect(await refused(cycle({ parallelSprints: true }))).toEqual({
      'sprintSettings.cycle': 'not_with_parallel_sprints',
    });
    expect(
      Object.keys(await refused(cycle({ cycle: { lengthDays: 14, timeZone: 'Mars/Olympus' } }))),
    ).toEqual(['sprintSettings.cycle.timeZone']);
    expect(Object.keys(await refused(cycle({ cycle: { lengthDays: 0 } })))).toEqual([
      'sprintSettings.cycle.lengthDays',
    ]);
    // The time zone defaults to UTC; null turns the cycle off.
    let res = await patch(`/api/v1/boards/${boardId}`, {
      sprintSettings: cycle({ cycle: { lengthDays: 7 } }),
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await get(`/api/v1/boards/${boardId}`)).json().board.sprintSettings.cycle).toEqual({
      lengthDays: 7,
      timeZone: 'UTC',
    });
    res = await patch(`/api/v1/boards/${boardId}`, { sprintSettings: cycle({ cycle: null }) });
    expect(res.statusCode, res.body).toBe(200);
    expect((await get(`/api/v1/boards/${boardId}`)).json().board.sprintSettings.cycle).toBeNull();
  });
});
