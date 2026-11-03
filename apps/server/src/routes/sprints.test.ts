import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `sprints-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface BacklogTicket {
  id: number;
  key: string;
  estimate: number | null;
  done: boolean;
}
interface Section {
  id: number;
  name: string;
  state: string;
  tickets: BacklogTicket[];
  totals: { tickets: number; estimate: number; remaining?: number };
}
interface Backlog {
  sprints: Section[];
  backlog: { tickets: BacklogTicket[]; totals: { tickets: number; estimate: number } };
}
interface ReportItem {
  key: string;
  addedAfterStart: boolean;
  estimateAtEntry: number | null;
  estimate: number | null;
  estimateChanged: boolean;
  carriedTo?: number | null;
}
interface Report {
  completed: ReportItem[];
  notCompleted: ReportItem[];
  removed: ReportItem[];
  totals: Record<string, number>;
}

/**
 * Sprints (M1-044): the lifecycle on a Scrum board, parallel sprints, carry-over at
 * completion, scope change recorded for the sprint report, and the estimation statistic.
 */
describe('sprints (M1-044)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: unknown = {}) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const patch = (who: string, url: string, payload: unknown) =>
    as(who, { method: 'PATCH', url, payload: payload as Record<string, unknown> });
  const S = (name: string) => status[name] as number;
  const T = (name: string) => tickets[name] as { id: number; key: string };
  const HOUR = 3600;

  async function ticket(name: string, track: string, hours: number | null = null) {
    // Grouped by a word per test: `summary ~ grpl` finds l1, l2 and so on.
    const res = await post('alice', '/api/v1/tickets', { track, summary: `grp${name[0]} ${name}` });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json().ticket as { id: number; key: string };
    tickets[name] = t;
    if (hours !== null) await estimate(name, hours);
    return t;
  }
  async function estimate(name: string, hours: number) {
    await database.db
      .updateTable('ticket')
      .set({ original_estimate: hours * HOUR, remaining_estimate: hours * HOUR })
      .where('id', '=', T(name).id)
      .execute();
  }
  async function setStatus(name: string, statusName: string) {
    await database.db
      .updateTable('ticket')
      .set({ status_id: S(statusName) })
      .where('id', '=', T(name).id)
      .execute();
  }
  // A track has one board (ADR-116): each test starts the track's board afresh.
  const dropBoard = (trackId: number) =>
    database.db.deleteFrom('board').where('location_track_id', '=', trackId).execute();
  async function scrumBoard(name: string, query: string, extra: Record<string, unknown> = {}) {
    await dropBoard(tracks.SP as number);
    const res = await post('alice', '/api/v1/boards', {
      name,
      kind: 'scrum',
      trackId: tracks.SP,
      source: { query },
      columns: [
        { id: 'todo', name: 'To do', statusIds: [S('New')] },
        { id: 'doing', name: 'Doing', statusIds: [S('Active'), S('In Review')] },
        { id: 'done', name: 'Done', statusIds: [S('Closed')] },
      ],
      ...extra,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().board as { id: number };
  }
  async function sprint(boardId: number, body: Record<string, unknown> = {}) {
    const res = await post('alice', `/api/v1/boards/${boardId}/sprints`, body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().sprint as { id: number; name: string; state: string; version: number };
  }
  async function add(sprintId: number, names: string[], who = 'alice') {
    const res = await post(who, `/api/v1/sprints/${sprintId}/tickets`, {
      tickets: names.map((n) => T(n).key),
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as { added: number; afterStart: boolean };
  }
  async function start(sprintId: number, body: Record<string, unknown> = {}) {
    return post('alice', `/api/v1/sprints/${sprintId}/start`, {
      endAt: '2026-11-12T09:00:00Z',
      ...body,
    });
  }
  async function backlog(boardId: number, who = 'alice') {
    const res = await get(who, `/api/v1/boards/${boardId}/backlog`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Backlog;
  }
  async function report(sprintId: number) {
    const res = await get('alice', `/api/v1/sprints/${sprintId}/report`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Report;
  }
  const keys = (list: { key: string }[]) => list.map((t) => t.key).sort();
  const K = (...names: string[]) => names.map((n) => T(n).key).sort();

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['dave', false],
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
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const members = roles.find((r) => r.name === 'Members')?.id as number;
    for (const key of ['SP', 'SQ']) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const who of ['alice', 'bob']) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-010] creates, reorders, starts and completes sprints, carrying unfinished tickets over', async () => {
    for (const [n, h] of [
      ['l1', 3],
      ['l2', 5],
      ['l3', 2],
      ['l4', 1],
    ] as const) {
      await ticket(n, 'SP', h);
    }
    const board = await scrumBoard('Life board', 'track = SP AND summary ~ grpl');
    const one = await sprint(board.id);
    const two = await sprint(board.id, { name: 'Second', goal: 'Ship it' });
    expect(one.name).toBe('Life board Sprint 1');
    expect(one.state).toBe('future');
    // Reorder: the second before the first, and back.
    let res = await post('alice', `/api/v1/sprints/${two.id}/rank`, { before: one.id });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().order).toEqual([two.id, one.id]);
    res = await post('alice', `/api/v1/sprints/${one.id}/rank`, { before: two.id });
    expect(res.json().order).toEqual([one.id, two.id]);

    await add(one.id, ['l1', 'l2', 'l3']);
    let view = await backlog(board.id);
    expect(view.sprints.map((s) => s.id)).toEqual([one.id, two.id]);
    expect(keys(view.sprints[0]?.tickets ?? [])).toEqual(K('l1', 'l2', 'l3'));
    expect(view.sprints[0]?.totals).toMatchObject({ tickets: 3, estimate: 10 * HOUR });
    expect(keys(view.backlog.tickets)).toEqual(K('l4'));

    // Starting needs an end date; a second active sprint needs parallel sprints.
    res = await post('alice', `/api/v1/sprints/${one.id}/start`, {});
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({ endAt: 'required' });
    res = await start(one.id, { goal: 'First goal' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sprint).toMatchObject({ state: 'active', goal: 'First goal' });
    res = await start(two.id);
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'sprint_active', sprintId: one.id });
    // An active sprint cannot be deleted; its dates stay set.
    expect(
      (await as('alice', { method: 'DELETE', url: `/api/v1/sprints/${one.id}` })).statusCode,
    ).toBe(409);
    res = await patch('alice', `/api/v1/sprints/${one.id}`, { endAt: null });
    expect(res.statusCode).toBe(400);
    res = await patch('alice', `/api/v1/sprints/${one.id}`, { name: 'First' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().sprint.name).toBe('First');

    // The board shows the active sprint's tickets only.
    res = await get('alice', `/api/v1/boards/${board.id}/data?sprints=active`);
    expect(res.statusCode, res.body).toBe(200);
    expect(keys(res.json().cards)).toEqual(K('l1', 'l2', 'l3'));

    await setStatus('l1', 'Closed');
    res = await post('alice', `/api/v1/sprints/${one.id}/complete`, {
      moveTo: { type: 'sprint', sprintId: two.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ completed: 1, carriedOver: 2, toBacklog: 0 });
    expect(res.json().sprint.state).toBe('closed');
    view = await backlog(board.id);
    expect(view.sprints.map((s) => s.id)).toEqual([two.id]);
    expect(keys(view.sprints[0]?.tickets ?? [])).toEqual(K('l2', 'l3'));
    // The closed sprint's report: done in it, and carried to the next one.
    const r = await report(one.id);
    expect(keys(r.completed)).toEqual(K('l1'));
    expect(keys(r.notCompleted)).toEqual(K('l2', 'l3'));
    expect(r.notCompleted.every((t) => t.carriedTo === two.id)).toBe(true);
    expect(r.totals).toMatchObject({ committed: 10 * HOUR, completed: 3 * HOUR });
    // A closed sprint takes no more tickets and cannot be completed again.
    res = await post('alice', `/api/v1/sprints/${one.id}/tickets`, { tickets: [T('l4').key] });
    expect(res.statusCode).toBe(409);
  });

  it('[AGL-010] records tickets added after start, removed and re-estimated as scope change', async () => {
    for (const [n, h] of [
      ['s1', 2],
      ['s2', 4],
      ['s3', 1],
      ['s4', 3],
      ['s5', 8],
    ] as const) {
      await ticket(n, 'SP', h);
    }
    const board = await scrumBoard('Scope board', 'track = SP AND summary ~ grps');
    const one = await sprint(board.id);
    expect((await add(one.id, ['s1', 's2', 's3', 's5'])).afterStart).toBe(false);
    // Before the start: s5 taken out again (no scope change), s2 re-estimated (counts as committed).
    const early = await post('alice', `/api/v1/sprints/${one.id}/tickets/remove`, {
      tickets: [T('s5').key],
    });
    expect(early.json()).toEqual({ removed: 1, afterStart: false });
    await estimate('s2', 5);
    expect((await start(one.id)).statusCode).toBe(200);
    // After the start: one added, one removed, one re-estimated.
    expect(await add(one.id, ['s4'])).toEqual({ added: 1, afterStart: true });
    const res = await post('alice', `/api/v1/sprints/${one.id}/tickets/remove`, {
      tickets: [T('s3').key],
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ removed: 1, afterStart: true });
    await estimate('s2', 6);
    await setStatus('s1', 'Closed');
    const r = await report(one.id);
    expect(keys(r.completed)).toEqual(K('s1'));
    expect(keys(r.notCompleted)).toEqual(K('s2', 's4'));
    expect(keys(r.removed)).toEqual(K('s3'));
    const s4 = r.notCompleted.find((t) => t.key === T('s4').key);
    expect(s4?.addedAfterStart).toBe(true);
    const s2 = r.notCompleted.find((t) => t.key === T('s2').key);
    expect(s2).toMatchObject({
      estimateAtEntry: 5 * HOUR,
      estimate: 6 * HOUR,
      estimateChanged: true,
    });
    expect(r.totals).toMatchObject({
      committed: 8 * HOUR,
      added: 3 * HOUR,
      removed: 1 * HOUR,
      completed: 2 * HOUR,
      notCompleted: 9 * HOUR,
      estimateChange: 1 * HOUR,
    });
    // The rows behind it: one per change, with its time and author.
    const rows = await database.db
      .selectFrom('sprint_change')
      .select(['kind', 'after_start', 'actor_id'])
      .where('sprint_id', '=', one.id)
      .orderBy('id')
      .execute();
    expect(rows.map((x) => `${x.kind}:${x.after_start}`)).toEqual([
      'added:false',
      'added:false',
      'added:false',
      'added:false',
      'removed:false',
      'committed:false',
      'committed:false',
      'committed:false',
      'added:true',
      'removed:true',
    ]);
    expect(rows.every((x) => x.actor_id === users.alice?.id)).toBe(true);
  });

  it('[AGL-010] completing offers the backlog, a future sprint or a new sprint; deleting a completed sprint keeps history', async () => {
    for (const n of ['c1', 'c2', 'c3']) await ticket(n, 'SP', 1);
    const board = await scrumBoard('Close board', 'track = SP AND summary ~ grpc');
    const one = await sprint(board.id);
    await add(one.id, ['c1', 'c2']);
    expect((await start(one.id)).statusCode).toBe(200);
    let res = await post('alice', `/api/v1/sprints/${one.id}/complete`, {
      moveTo: { type: 'new', name: 'Follow-up' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const next = res.json().toSprintId as number;
    let view = await backlog(board.id);
    expect(view.sprints.map((s) => [s.name, s.state])).toEqual([['Follow-up', 'future']]);
    expect(keys(view.sprints[0]?.tickets ?? [])).toEqual(K('c1', 'c2'));

    await add(next, ['c3']);
    expect((await start(next)).statusCode).toBe(200);
    res = await post('alice', `/api/v1/sprints/${next}/complete`, { moveTo: { type: 'backlog' } });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ completed: 0, carriedOver: 0, toBacklog: 3 });
    view = await backlog(board.id);
    expect(view.sprints).toEqual([]);
    expect(keys(view.backlog.tickets)).toEqual(K('c1', 'c2', 'c3'));

    // A deleted completed sprint leaves the list and reports; its rows stay as history.
    res = await as('alice', { method: 'DELETE', url: `/api/v1/sprints/${one.id}` });
    expect(res.statusCode).toBe(204);
    expect((await get('alice', `/api/v1/sprints/${one.id}/report`)).statusCode).toBe(404);
    res = await get('alice', `/api/v1/boards/${board.id}/sprints?state=closed`);
    expect(res.json().sprints.map((s: { id: number }) => s.id)).toEqual([next]);
    const kept = await database.db
      .selectFrom('sprint_change')
      .select('ticket_id')
      .where('sprint_id', '=', one.id)
      .execute();
    expect(kept.length).toBeGreaterThan(0);
    // A future sprint is deleted outright; its tickets return to the backlog.
    const later = await sprint(board.id);
    await add(later.id, ['c1']);
    expect(
      (await as('alice', { method: 'DELETE', url: `/api/v1/sprints/${later.id}` })).statusCode,
    ).toBe(204);
    view = await backlog(board.id);
    expect(keys(view.backlog.tickets)).toEqual(K('c1', 'c2', 'c3'));
  });

  it('[AGL-011] runs two active sprints on one board, each with its own section', async () => {
    for (const n of ['p1', 'p2', 'p3']) await ticket(n, 'SP', 1);
    const board = await scrumBoard('Parallel board', 'track = SP AND summary ~ grpp', {
      sprintSettings: {
        estimation: { statistic: 'originalEstimate' },
        timeTracking: 'remainingEstimate',
        parallelSprints: true,
      },
    });
    const a = await sprint(board.id, { name: 'Team A' });
    const b = await sprint(board.id, { name: 'Team B' });
    await add(a.id, ['p1']);
    await add(b.id, ['p2']);
    expect((await start(a.id)).statusCode).toBe(200);
    expect((await start(b.id)).statusCode).toBe(200);
    const view = await backlog(board.id);
    expect(view.sprints.map((s) => [s.name, s.state, keys(s.tickets)])).toEqual([
      ['Team A', 'active', K('p1')],
      ['Team B', 'active', K('p2')],
    ]);
    // Moving a ticket from one active sprint to the other is scope change in both.
    await add(b.id, ['p1']);
    const ra = await report(a.id);
    expect(keys(ra.removed)).toEqual(K('p1'));
    const res = await get('alice', `/api/v1/boards/${board.id}/data?sprints=active`);
    expect(keys(res.json().cards)).toEqual(K('p1', 'p2'));
  });

  it("[AGL-011] completing a shared sprint carries over only the completing board's tickets", async () => {
    await ticket('x1', 'SP', 1);
    await ticket('x2', 'SP', 1);
    const board = await scrumBoard('Shared board', 'track = SP AND summary ~ grpx');
    const one = await sprint(board.id);
    const two = await sprint(board.id);
    await add(one.id, ['x1', 'x2']);
    expect((await start(one.id)).statusCode).toBe(200);
    // The board narrows: x2 is no longer one of the completing board's tickets.
    const res0 = await patch('alice', `/api/v1/boards/${board.id}`, {
      source: { query: 'track = SP AND summary ~ x1' },
    });
    expect(res0.statusCode, res0.body).toBe(200);
    const res = await post('alice', `/api/v1/sprints/${one.id}/complete`, {
      moveTo: { type: 'sprint', sprintId: two.id },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ carriedOver: 1, toBacklog: 1 });
    const open = await database.db
      .selectFrom('sprint_ticket')
      .select(['sprint_id', 'ticket_id'])
      .where('open', '=', true)
      .where('ticket_id', 'in', [T('x1').id, T('x2').id])
      .execute();
    expect(open).toEqual([{ sprint_id: two.id, ticket_id: T('x1').id }]);
  });

  it('[AGL-007] the estimation statistic sets card estimates and sprint totals; logged time lowers the remaining total', async () => {
    await ticket('e1', 'SP', 2);
    await ticket('e2', 'SP', 3);
    const field = await post('admin', '/api/v1/fields', { name: 'Story points', type: 'number' });
    expect(field.statusCode, field.body).toBe(201);
    const fieldId = field.json().field.id as number;
    for (const [n, points] of [
      ['e1', 5],
      ['e2', 8],
    ] as const) {
      await database.db
        .updateTable('ticket')
        .set({ fields: JSON.stringify({ [String(fieldId)]: points }) })
        .where('id', '=', T(n).id)
        .execute();
    }
    const board = await scrumBoard('Estimate board', 'track = SP AND summary ~ grpe');
    const one = await sprint(board.id);
    await add(one.id, ['e1', 'e2']);
    let view = await backlog(board.id);
    expect(view.sprints[0]?.totals).toEqual({
      tickets: 2,
      estimate: 5 * HOUR,
      remaining: 5 * HOUR,
    });

    // Points instead of time: badges and totals change; no time tracking, no remaining.
    let res = await patch('alice', `/api/v1/boards/${board.id}`, {
      sprintSettings: {
        estimation: { statistic: 'field', fieldId },
        timeTracking: 'none',
        parallelSprints: false,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    view = await backlog(board.id);
    expect(view.sprints[0]?.tickets.map((t) => t.estimate).sort()).toEqual([5, 8]);
    expect(view.sprints[0]?.totals).toEqual({ tickets: 2, estimate: 13 });
    res = await patch('alice', `/api/v1/boards/${board.id}`, {
      sprintSettings: {
        estimation: { statistic: 'field', fieldId: 999_999 },
        timeTracking: 'none',
        parallelSprints: false,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().fields).toEqual({
      'sprintSettings.estimation.fieldId': 'not_a_number_field',
    });

    // Back to time with remaining-estimate tracking: logging an hour lowers the remaining total.
    res = await patch('alice', `/api/v1/boards/${board.id}`, {
      sprintSettings: {
        estimation: { statistic: 'originalEstimate' },
        timeTracking: 'remainingEstimate',
        parallelSprints: false,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect((await start(one.id)).statusCode).toBe(200);
    res = await post('alice', `/api/v1/tickets/${T('e1').key}/time-entries`, { duration: '1h' });
    expect(res.statusCode, res.body).toBe(201);
    view = await backlog(board.id);
    expect(view.sprints[0]?.totals).toEqual({
      tickets: 2,
      estimate: 5 * HOUR,
      remaining: 4 * HOUR,
    });
    expect((await report(one.id)).totals.remaining).toBe(4 * HOUR);
  });

  it('[AGL-010] sprints need a Scrum board the caller sees', async () => {
    await dropBoard(tracks.SP as number);
    const res = await post('alice', '/api/v1/boards', {
      name: 'Flow',
      kind: 'kanban',
      trackId: tracks.SP,
      source: { query: 'track = SP' },
    });
    const kanban = res.json().board.id as number;
    expect((await post('alice', `/api/v1/boards/${kanban}/sprints`, {})).statusCode).toBe(409);
    const board = await scrumBoard('Private board', 'track = SP');
    // Dave browses no track: the board and its sprints do not exist for him.
    expect((await post('dave', `/api/v1/boards/${board.id}/sprints`, {})).statusCode).toBe(404);
    const one = await sprint(board.id);
    expect((await get('dave', `/api/v1/sprints/${one.id}/report`)).statusCode).toBe(404);
    expect((await get('dave', `/api/v1/boards/${board.id}/backlog`)).statusCode).toBe(404);
    // A future sprint has no report yet.
    expect((await get('alice', `/api/v1/sprints/${one.id}/report`)).statusCode).toBe(409);
  });
});
