import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `boards-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.75.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Card {
  id: number;
  key: string;
  columnId: string;
  laneId: string;
  colour: string | null;
  status: { id: number; name: string };
  fields: Record<string, unknown>;
  daysInColumn: number | null;
}
interface Data {
  columns: { id: string; name: string; count: number; shown: number; wip: string | null }[];
  lanes: { id: string; name: string; catchAll: boolean }[];
  cards: Card[];
  unmapped: { count: number; statuses: { id: number; name: string; count: number }[] };
  truncated: boolean;
  warnings: string[];
}

/**
 * Boards (M1-043): configuration, the board data through the search compiler (permission
 * filter, query lanes, board filters, WIP counts, card rules) and card moves through the ticket
 * routes.
 */
describe('boards (M1-043)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const priority: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: unknown) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const patch = (who: string, url: string, payload: unknown) =>
    as(who, { method: 'PATCH', url, payload: payload as Record<string, unknown> });
  const S = (name: string) => status[name] as number;
  const T = (name: string) => tickets[name] as { id: number; key: string };

  async function createBoard(who: string, body: Record<string, unknown>) {
    // A track has one board (ADR-116): each test starts its track's board afresh.
    await database.db
      .deleteFrom('board')
      .where('location_track_id', '=', body.trackId as number)
      .execute();
    const res = await post(who, '/api/v1/boards', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().board as { id: number; columns: { id: string }[]; version: number };
  }
  async function data(who: string, boardId: number, filters?: string[]) {
    const res = await get(
      who,
      `/api/v1/boards/${boardId}/data${filters ? `?filters=${filters.join(',')}` : ''}`,
    );
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Data;
  }
  const keysIn = (d: Data, columnId: string) =>
    d.cards.filter((c) => c.columnId === columnId).map((c) => c.key);
  async function ticket(name: string, track: string, extra: Record<string, unknown> = {}) {
    const res = await post('alice', '/api/v1/tickets', { track, summary: name, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json().ticket as { id: number; key: string };
    tickets[name] = t;
    return t;
  }
  /** Puts a ticket in a status directly, as a workflow migration would. */
  async function setStatus(name: string, statusName: string) {
    await database.db
      .updateTable('ticket')
      .set({ status_id: S(statusName) })
      .where('id', '=', T(name).id)
      .execute();
  }

  const COLUMNS = () => [
    { id: 'todo', name: 'To do', statusIds: [S('New')] },
    { id: 'doing', name: 'Doing', statusIds: [S('Active'), S('In Review')], max: 3 },
    { id: 'done', name: 'Done', statusIds: [S('Closed')], min: 2 },
  ];

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const role = (name: string) => roles.find((r) => r.name === name)?.id as number;
    for (const [key, members] of [
      [
        'BA',
        [
          ['alice', 'Members'],
          ['bob', 'Members'],
          ['carol', 'Administrators'],
        ],
      ],
      [
        'BB',
        [
          ['alice', 'Members'],
          ['bob', 'Members'],
        ],
      ],
      ['BC', [['alice', 'Members']]],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const [who, roleName] of members) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: role(roleName),
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
    for (const p of await database.db.selectFrom('priority').select(['id', 'name']).execute()) {
      priority[p.name] = p.id;
    }
    await ticket('a1', 'BA', { priorityId: priority.Urgent, assigneeId: users.alice?.id });
    await ticket('a2', 'BA', { assigneeId: users.bob?.id });
    await ticket('b1', 'BA', { labels: ['blue'] });
    await ticket('b2', 'BA', { labels: ['blue'], assigneeId: users.alice?.id });
    await ticket('c1', 'BA', { priorityId: priority.Urgent, labels: ['far'] });
    await ticket('c2', 'BA', { labels: ['far'] });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-001] shows the tickets of its track, in rank order', async () => {
    const board = await createBoard('alice', {
      name: 'Three tracks',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
    });
    // Default columns: one per status of the board's workflows, from new to closed.
    expect(board.columns.map((c) => c.id)).toEqual(['c1', 'c2', 'c3', 'c4']);
    const d = await data('alice', board.id);
    expect(d.cards.map((c) => c.key)).toEqual(
      ['a1', 'a2', 'b1', 'b2', 'c1', 'c2'].map((n) => T(n).key),
    );
    expect(d.columns.map((c) => [c.name, c.count])).toEqual([
      ['New', 6],
      ['Active', 0],
      ['In Review', 0],
      ['Closed', 0],
    ]);
    // The board's statuses: those of the default workflow, each in a column.
    const read = (await get('alice', `/api/v1/boards/${board.id}`)).json();
    expect(read.board.mayConfigure).toBe(true);
    expect(read.statuses.map((s: { name: string }) => s.name)).toEqual([
      'New',
      'Active',
      'In Review',
      'Closed',
    ]);
    expect(read.statuses.every((s: { columnId: string | null }) => s.columnId !== null)).toBe(true);
    const created = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'board.created')
      .where('subject_id', '=', String(board.id))
      .executeTakeFirstOrThrow();
    expect(created.payload).toMatchObject({ name: 'Three tracks', kind: 'kanban' });
  });

  it('[QRY-008] [AGL-001] never shows a board or a ticket of a track the viewer may not see', async () => {
    const board = await createBoard('alice', {
      name: 'Hidden',
      kind: 'kanban',
      trackId: tracks.BC,
    });
    // Bob does not browse BC: neither the board nor its read answers him.
    expect((await get('bob', `/api/v1/boards/${board.id}`)).statusCode).toBe(404);
    expect((await get('bob', `/api/v1/tracks/${tracks.BC}/board`)).statusCode).toBe(404);
    expect((await get('alice', `/api/v1/boards/${board.id}`)).statusCode).toBe(200);
  });

  it('[AGL-001] keeps one board per track, inside the track (ADR-116)', async () => {
    const first = await createBoard('alice', { name: 'One', kind: 'kanban', trackId: tracks.BB });
    expect(first.columns.length).toBeGreaterThan(0);
    const second = await post('alice', '/api/v1/boards', {
      name: 'Two',
      kind: 'scrum',
      trackId: tracks.BB,
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toEqual({ error: 'track_has_board', boardId: first.id });
    // No track, and a query that names none, is refused.
    const nowhere = await post('alice', '/api/v1/boards', {
      name: 'Mine',
      kind: 'kanban',
      source: { query: 'assignee = currentUser()' },
    });
    expect(nowhere.statusCode).toBe(400);
    expect(nowhere.json().fields).toEqual({ trackId: 'required' });
    // Across tracks is refused, at creation and when changed afterwards.
    await database.db
      .deleteFrom('board')
      .where('location_track_id', '=', tracks.BC as number)
      .execute();
    const across = await post('alice', '/api/v1/boards', {
      name: 'Both',
      kind: 'kanban',
      trackId: tracks.BC,
      source: { query: 'track IN (BB, BC)' },
    });
    expect(across.json().fields).toEqual({ source: 'outside_track' });
    const widened = await patch('alice', `/api/v1/boards/${first.id}`, {
      source: { query: 'track = BC' },
    });
    expect(widened.json().fields).toEqual({ source: 'outside_track' });
    // A query confined to the track names the track by itself.
    await database.db
      .deleteFrom('board')
      .where('location_track_id', '=', tracks.BB as number)
      .execute();
    const named = await post('alice', '/api/v1/boards', {
      name: 'Named',
      kind: 'kanban',
      source: { query: 'track = BB AND labels = blue' },
    });
    expect(named.statusCode, named.body).toBe(201);
    expect(named.json().board.location).toMatchObject({ type: 'track' });
  });

  it('[AGL-002] says when a column cannot be reached, and lets an administrator fix it', async () => {
    const board = await createBoard('admin', { name: 'Reach', kind: 'kanban', trackId: tracks.BC });
    const current = (await get('admin', `/api/v1/boards/${board.id}`)).json();
    expect(Object.values(current.reach.columns)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(current.reach.otherTracks).toContain('Track BA');
    const added = await patch('admin', `/api/v1/boards/${board.id}`, {
      columns: [...current.board.columns, { id: 'extra', name: 'Parked', statusIds: [] }],
    });
    expect(added.statusCode, added.body).toBe(200);
    // A shared workflow never changes by itself; the read says so at once.
    const read = (await get('alice', `/api/v1/boards/${board.id}`)).json();
    expect(read.reach.columns.extra).toBe('no_status');
    expect(read.board.managesWorkflow).toBe(false);
    expect(read.reach.mayFix).toBe(false);
    const refused = await post('alice', `/api/v1/boards/${board.id}/columns/extra/path`, {});
    expect(refused.statusCode, refused.body).toBe(403);
    // An administrator adds the path: a status, a new version, and any card can go there.
    const fixed = await post('admin', `/api/v1/boards/${board.id}/columns/extra/path`, {});
    expect(fixed.statusCode, fixed.body).toBe(200);
    const after = (await get('admin', `/api/v1/boards/${board.id}`)).json();
    expect(after.reach.columns.extra).toBe('ok');
    const column = after.board.columns.find((c: { id: string }) => c.id === 'extra');
    expect(column.statusIds).toHaveLength(1);
    const ticket = await post('admin', '/api/v1/tickets', { track: 'BC', summary: 'To park' });
    const moved = await post('admin', `/api/v1/boards/${board.id}/moves`, {
      ticket: ticket.json().ticket.id,
      columnId: 'extra',
    });
    expect(moved.statusCode, moved.body).toBe(200);
    const back = await post('admin', `/api/v1/boards/${board.id}/moves`, {
      ticket: ticket.json().ticket.id,
      columnId: after.board.columns[0].id,
    });
    expect(back.statusCode, back.body).toBe(200);
  });

  it("[CORE-001] lists a track's files and links, only on tickets the viewer may see", async () => {
    const made = await post('alice', '/api/v1/tickets', { track: 'BC', summary: 'With a link' });
    const id = made.json().ticket.id as number;
    await database.db
      .insertInto('ticket_web_link')
      .values({ workspace_id: 1, ticket_id: id, url: 'https://example.com/a', title: 'A link' })
      .execute();
    const read = await get('alice', `/api/v1/tracks/${tracks.BC}/files`);
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json().links).toMatchObject([
      { url: 'https://example.com/a', title: 'A link', ticket: { key: made.json().ticket.key } },
    ]);
    expect(read.json().attachments).toEqual([]);
    // Bob does not browse this track.
    expect((await get('bob', `/api/v1/tracks/${tracks.BC}/files`)).statusCode).toBe(404);
  });

  it('[AGL-001] gives a track its board the first time it is opened, once', async () => {
    await database.db
      .deleteFrom('board')
      .where('location_track_id', '=', tracks.BB as number)
      .execute();
    const opened = await get('bob', `/api/v1/tracks/${tracks.BB}/board`);
    expect(opened.statusCode, opened.body).toBe(200);
    const board = opened.json().board;
    expect(board.name).toBe('Track BB');
    // A person who only opened it gains nothing over it.
    expect(board.mayConfigure).toBe(false);
    expect(board.admins).toEqual([]);
    const byKey = await get('alice', '/api/v1/tracks/bb/board');
    expect(byKey.json().board.id).toBe(board.id);
    const data = await get('bob', `/api/v1/boards/${board.id}/data`);
    expect(data.statusCode, data.body).toBe(200);
  });

  it('[AGL-001] only board admins, track admins of the location and administrators configure', async () => {
    const board = await createBoard('alice', {
      name: 'Configured',
      kind: 'scrum',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
    });
    const refused = await patch('bob', `/api/v1/boards/${board.id}`, { name: 'Taken over' });
    expect(refused.statusCode).toBe(403);
    expect((await get('bob', `/api/v1/boards/${board.id}`)).json().board.mayConfigure).toBe(false);
    const byTrackAdmin = await patch('carol', `/api/v1/boards/${board.id}`, { name: 'By carol' });
    expect(byTrackAdmin.statusCode, byTrackAdmin.body).toBe(200);
    const byBoardAdmin = await patch('alice', `/api/v1/boards/${board.id}`, {
      name: 'By alice',
      adminIds: [users.alice?.id, users.bob?.id],
      version: byTrackAdmin.json().board.version,
    });
    expect(byBoardAdmin.statusCode, byBoardAdmin.body).toBe(200);
    expect(byBoardAdmin.json().board.admins.map((a: { name: string }) => a.name)).toEqual([
      'alice',
      'bob',
    ]);
    expect((await patch('bob', `/api/v1/boards/${board.id}`, { name: 'Now bob' })).statusCode).toBe(
      200,
    );
    // The same configuration again is no change: no new version, no event.
    const current = (await get('alice', `/api/v1/boards/${board.id}`)).json().board;
    const same = await patch('alice', `/api/v1/boards/${board.id}`, {
      columns: current.columns,
      swimlanes: current.swimlanes,
      boardFilters: current.boardFilters,
      cardRules: current.cardRules,
    });
    expect(same.json().board.version).toBe(current.version);
    // A stale version is refused.
    const stale = await patch('alice', `/api/v1/boards/${board.id}`, { name: 'Old', version: 1 });
    expect(stale.statusCode).toBe(409);
    const removed = await as('carol', { method: 'DELETE', url: `/api/v1/boards/${board.id}` });
    expect(removed.statusCode).toBe(204);
  });

  it('[AGL-002] shows statuses mapped to one column together and counts unmapped ones', async () => {
    const board = await createBoard('alice', {
      name: 'Mapping',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA AND labels = blue' },
      columns: [
        { id: 'todo', name: 'To do', statusIds: [] },
        { id: 'doing', name: 'Doing', statusIds: [S('Active'), S('In Review')] },
      ],
    });
    await setStatus('b1', 'Active');
    await setStatus('b2', 'In Review');
    let d = await data('alice', board.id);
    expect(keysIn(d, 'doing')).toEqual([T('b1').key, T('b2').key]);
    // New is in no column: its tickets are counted in the unmapped panel and not shown.
    await setStatus('b2', 'New');
    d = await data('alice', board.id);
    expect(keysIn(d, 'doing')).toEqual([T('b1').key]);
    expect(d.unmapped).toEqual({
      count: 1,
      statuses: [{ id: S('New'), name: 'New', count: 1 }],
    });
    await setStatus('b1', 'New');
    // A status in two columns, an unknown status and a bad query are refused.
    const twice = await patch('alice', `/api/v1/boards/${board.id}`, {
      columns: [
        { name: 'One', statusIds: [S('New')] },
        { name: 'Two', statusIds: [S('New')] },
      ],
    });
    expect(twice.json()).toEqual({
      error: 'invalid_fields',
      fields: { columns: 'status_in_two_columns' },
    });
    const unknown = await patch('alice', `/api/v1/boards/${board.id}`, {
      columns: [{ name: 'One', statusIds: [999_999] }],
    });
    expect(unknown.json().fields).toEqual({ columns: 'unknown_status' });
    const bad = await patch('alice', `/api/v1/boards/${board.id}`, {
      source: { query: 'status = ' },
    });
    expect(bad.json().fields).toEqual({ 'source.query': 'invalid_query' });
  });

  it('[AGL-003] signals WIP breaches with cards hidden by a board filter still counted', async () => {
    const board = await createBoard('alice', {
      name: 'WIP',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      columns: COLUMNS(),
      boardFilters: [{ id: 'mine', name: 'Mine', query: 'assignee = currentUser()' }],
    });
    for (const name of ['a1', 'a2', 'b1', 'b2']) await setStatus(name, 'Active');
    await setStatus('c1', 'Closed');
    let d = await data('alice', board.id);
    const doing = d.columns.find((c) => c.id === 'doing');
    const done = d.columns.find((c) => c.id === 'done');
    expect([doing?.count, doing?.wip]).toEqual([4, 'over']);
    expect([done?.count, done?.wip]).toEqual([1, 'under']);
    // A board filter hides cards, never counts.
    d = await data('alice', board.id, ['mine']);
    const mine = d.columns.find((c) => c.id === 'doing');
    expect([mine?.count, mine?.shown, mine?.wip]).toEqual([4, 2, 'over']);
    for (const name of ['a1', 'a2', 'b1', 'b2', 'c1']) await setStatus(name, 'New');
  });

  it('[AGL-005] combines active board filters with AND', async () => {
    const board = await createBoard('alice', {
      name: 'Filters',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      boardFilters: [
        { id: 'mine', name: 'Only my tickets', query: 'assignee = currentUser()' },
        { id: 'blue', name: 'Blue', query: 'labels = blue' },
      ],
    });
    expect((await data('alice', board.id, ['mine'])).cards.map((c) => c.key)).toEqual([
      T('a1').key,
      T('b2').key,
    ]);
    expect((await data('alice', board.id, ['blue'])).cards.map((c) => c.key)).toEqual([
      T('b1').key,
      T('b2').key,
    ]);
    expect((await data('alice', board.id, ['mine', 'blue'])).cards.map((c) => c.key)).toEqual([
      T('b2').key,
    ]);
    const unknown = await get('alice', `/api/v1/boards/${board.id}/data?filters=nope`);
    expect(unknown.json()).toEqual({ error: 'invalid_fields', fields: { filters: 'not_found' } });
    // A new board comes with the default board filter, and no longer "Only my tickets": the
    // person filter's "Me" finds the same cards.
    const plain = await createBoard('alice', {
      name: 'Defaults',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
    });
    const read = (await get('alice', `/api/v1/boards/${plain.id}`)).json();
    expect(read.board.boardFilters.map((f: { name: string }) => f.name)).toEqual([
      'Recently updated',
    ]);
    const refused = await get('alice', `/api/v1/boards/${plain.id}/data?filters=mine`);
    expect(refused.json()).toEqual({ error: 'invalid_fields', fields: { filters: 'not_found' } });
  });

  it('[AGL-005] filters by person as a board filter, for a plain member, with counts whole', async () => {
    const board = await createBoard('alice', {
      name: 'People',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      boardFilters: [{ id: 'blue', name: 'Blue', query: 'labels = blue' }],
    });
    const shown = async (who: string, query: string) => {
      const res = await get(who, `/api/v1/boards/${board.id}/data?${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json() as Data).cards.map((c) => c.key).sort();
    };
    const keys = (...names: string[]) => names.map((n) => T(n).key).sort();
    const alice = users.alice?.id as number;
    const bob = users.bob?.id as number;
    // Bob is an ordinary member and may not configure this board; he filters it all the same.
    expect((await get('bob', `/api/v1/boards/${board.id}`)).json().board.mayConfigure).toBe(false);
    expect(await shown('bob', 'people=me')).toEqual(keys('a2'));
    expect(await shown('alice', 'people=me')).toEqual(keys('a1', 'b2'));
    expect(await shown('bob', `people=${alice}`)).toEqual(keys('a1', 'b2'));
    expect(await shown('bob', 'people=none')).toEqual(keys('b1', 'c1', 'c2'));
    // Choosing several shows any of them.
    expect(await shown('bob', `people=${alice},${bob}`)).toEqual(keys('a1', 'a2', 'b2'));
    expect(await shown('bob', 'people=me,none')).toEqual(keys('a2', 'b1', 'c1', 'c2'));
    // Together with a board filter both must hold: "any of them" stays inside its parentheses.
    expect(await shown('bob', 'people=me,none&filters=blue')).toEqual(keys('b1'));
    // Someone with no tickets here finds nothing, and no error says who exists.
    expect(await shown('bob', 'people=2147483647')).toEqual([]);

    const res = await get('bob', `/api/v1/boards/${board.id}/data?people=me`);
    const narrowed = res.json() as Data & {
      people: {
        viewerId: number;
        assignees: { id: number; name: string }[];
        unassigned: boolean;
        more: boolean;
      };
    };
    // The list stays whole while the cards narrow, and the column counts stay whole too.
    expect(narrowed.people).toEqual({
      viewerId: bob,
      assignees: [
        { id: alice, name: 'alice' },
        { id: bob, name: 'bob' },
      ],
      unassigned: true,
      more: false,
    });
    expect(narrowed.columns.reduce((sum, c) => sum + c.count, 0)).toBe(6);
    expect(narrowed.columns.reduce((sum, c) => sum + c.shown, 0)).toBe(1);

    for (const bad of ['robert', 'me,,none', '12;drop', '99999999999', '3000000000']) {
      const refused = await get('bob', `/api/v1/boards/${board.id}/data?people=${bad}`);
      expect(refused.statusCode, bad).toBe(400);
    }
  });

  it('[QRY-008] [AGL-005] never widens: no ticket or name from a track the viewer cannot see', async () => {
    const hidden = await ticket('hidden1', 'BC', { assigneeId: users.alice?.id });
    await database.db
      .updateTable('ticket')
      .set({ assignee_id: users.carol?.id as number })
      .where('id', '=', hidden.id)
      .execute();
    const board = await createBoard('alice', {
      name: 'Two tracks',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
    });
    // A board imported from before the one-board rule can still span tracks.
    await database.db
      .updateTable('board')
      .set({ filter_query: 'track IN (BA, BC)' })
      .where('id', '=', board.id)
      .execute();
    const carol = users.carol?.id as number;
    const read = async (who: string) => {
      const res = await get(who, `/api/v1/boards/${board.id}/data?people=${carol}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as Data & { people: { assignees: { id: number }[] } };
    };
    // Alice browses both tracks, so she sees Carol's ticket and Carol in the list.
    const seen = await read('alice');
    expect(seen.cards.map((c) => c.key)).toEqual([hidden.key]);
    expect(seen.people.assignees.map((p) => p.id)).toContain(carol);
    // Bob does not browse BC: asking for Carol by id shows nothing, and she is not listed.
    const refused = await read('bob');
    expect(refused.cards).toEqual([]);
    expect(refused.people.assignees.map((p) => p.id)).not.toContain(carol);
    await database.db
      .updateTable('ticket')
      .set({ deleted_at: new Date() })
      .where('id', '=', hidden.id)
      .execute();
  });

  it('[AGL-004] puts a ticket in the first query lane it matches, before the catch-all', async () => {
    const board = await createBoard('alice', {
      name: 'Lanes',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      swimlanes: {
        mode: 'queries',
        lanes: [
          { id: 'expedite', name: 'Expedite', query: 'priority = Urgent ORDER BY created DESC' },
          { id: 'blue', name: 'Blue', query: 'labels = blue OR priority = Urgent' },
        ],
      },
    });
    const d = await data('alice', board.id);
    expect(d.lanes.map((l) => [l.id, l.catchAll])).toEqual([
      ['expedite', false],
      ['blue', false],
      ['other', true],
    ]);
    const lane = (name: string) => d.cards.find((c) => c.id === T(name).id)?.laneId;
    expect(['a1', 'c1', 'b1', 'b2', 'a2', 'c2'].map(lane)).toEqual([
      'expedite',
      'expedite',
      'blue',
      'blue',
      'other',
      'other',
    ]);
    // The catch-all lane cannot be removed: it is not a configured lane, and its id is taken.
    const clash = await patch('alice', `/api/v1/boards/${board.id}`, {
      swimlanes: { mode: 'queries', lanes: [{ id: 'other', name: 'Mine', query: 'type = Task' }] },
    });
    expect(clash.json().fields).toEqual({ 'swimlanes.lanes': 'duplicate_id' });
    // A lane query someone cannot read matches nothing for them, with a warning.
    const broken = await patch('alice', `/api/v1/boards/${board.id}`, {
      swimlanes: { mode: 'queries', lanes: [{ name: 'Broken', query: 'labels = ' }] },
    });
    expect(broken.json().fields).toEqual({ 'swimlanes.lanes.0.query': 'invalid_query' });
  });

  it('[AGL-004] groups by assignee, unassigned first or last, and by parent', async () => {
    const board = await createBoard('alice', {
      name: 'People',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      swimlanes: { mode: 'assignees', unassigned: 'first' },
    });
    let d = await data('alice', board.id);
    expect(d.lanes.map((l) => l.name)).toEqual(['Unassigned', 'alice', 'bob']);
    expect(d.cards.find((c) => c.id === T('b1').id)?.laneId).toBe('unassigned');
    expect(d.cards.find((c) => c.id === T('a2').id)?.laneId).toBe(`user-${users.bob?.id}`);
    // By parent: b1 and b2 under a1, which bob sees; c2 under c1, which he does not.
    await database.db
      .updateTable('ticket')
      .set({ parent_id: T('a1').id })
      .where('id', 'in', [T('b1').id, T('b2').id])
      .execute();
    await patch('alice', `/api/v1/boards/${board.id}`, {
      source: { query: 'track = BA' },
      swimlanes: { mode: 'parents' },
    });
    await database.db
      .updateTable('ticket')
      .set({ parent_id: T('c1').id })
      .where('id', '=', T('a2').id)
      .execute();
    d = await data('bob', board.id);
    expect(d.lanes.map((l) => [l.id, l.catchAll])).toEqual([
      [`parent-${T('a1').id}`, false],
      [`parent-${T('c1').id}`, false],
      ['other', true],
    ]);
    const lane = (name: string) => d.cards.find((c) => c.id === T(name).id)?.laneId;
    expect(['a1', 'a2', 'b1', 'b2'].map(lane)).toEqual([
      'other',
      `parent-${T('c1').id}`,
      `parent-${T('a1').id}`,
      `parent-${T('a1').id}`,
    ]);
    await database.db.updateTable('ticket').set({ parent_id: null }).execute();
  });

  it('[AGL-006] colours a card by the first matching rule and shows the chosen fields', async () => {
    const board = await createBoard('alice', {
      name: 'Cards',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      cardRules: {
        colourBy: 'queries',
        colours: [
          { query: 'priority = Urgent', colour: '#c4314b' },
          { query: 'labels IS EMPTY', colour: '#2f6fdb' },
        ],
        fields: ['assignee', 'labels'],
      },
    });
    const d = await data('alice', board.id);
    const card = (name: string) => d.cards.find((c) => c.id === T(name).id) as Card;
    expect([card('a1').colour, card('a2').colour, card('b1').colour]).toEqual([
      '#c4314b',
      '#2f6fdb',
      null,
    ]);
    expect(card('b2').fields).toEqual({
      assignee: { id: users.alice?.id, name: 'alice' },
      labels: ['blue'],
    });
    const many = await patch('alice', `/api/v1/boards/${board.id}`, {
      cardRules: {
        colourBy: 'none',
        fields: Array.from({ length: 11 }, (_, i) => `cf[${i + 1}]`),
      },
    });
    expect(many.statusCode).toBe(400);
  });

  it('[AGL-006] starts a new board on the default cards, with points only where there is one', async () => {
    const field = (await post('admin', '/api/v1/fields', { name: 'Points', type: 'number' })).json()
      .field.id as number;
    const other = (await post('admin', '/api/v1/fields', { name: 'Value', type: 'number' })).json()
      .field.id as number;
    const pointed = await ticket('pointed', 'BA', { fields: { [field]: 5, [other]: 8 } });
    const made = await createBoard('alice', {
      name: 'Plain',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      columns: COLUMNS(),
    });
    const read = await get('alice', `/api/v1/boards/${made.id}`);
    expect(read.json().board.cardRules).toEqual({
      colourBy: 'none',
      colours: [],
      fields: ['priority', 'assignee', 'points'],
      daysInColumn: false,
    });
    const pointsOf = async (id: number) =>
      (await data('alice', id)).cards.find((c) => c.id === pointed.id)?.fields.points;
    const d = await data('alice', made.id);
    const card = d.cards.find((c) => c.id === pointed.id) as Card;
    // Cards read the number field named Points, a priority's level, and no days marker.
    expect(card.fields).toMatchObject({
      points: 5,
      priority: { name: 'Normal', level: 4 },
    });
    expect(card.daysInColumn).toBeNull();
    expect(card.colour).toBeNull();
    expect(d.cards.find((c) => c.id === T('a1').id)?.fields.points).toBeNull();

    // A board estimating with a number field shows that one.
    const estimating = await createBoard('alice', {
      name: 'Estimating',
      kind: 'scrum',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      columns: COLUMNS(),
      sprintSettings: {
        estimation: { statistic: 'field', fieldId: other },
        timeTracking: 'none',
        parallelSprints: false,
      },
    });
    expect(await pointsOf(estimating.id)).toBe(8);

    // The full view reads it too, when another field on the card needs that view.
    const full = await createBoard('alice', {
      name: 'Full',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      columns: COLUMNS(),
      cardRules: { colourBy: 'none', fields: ['points', 'areas'] },
    });
    expect(await pointsOf(full.id)).toBe(5);
  });

  it('[AGL-006] resets days in column only when the card changes column', async () => {
    const board = await createBoard('alice', {
      name: 'Days',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA' },
      columns: COLUMNS(),
      cardRules: { colourBy: 'none', fields: [], daysInColumn: true },
    });
    const day = 86_400_000;
    const now = Date.now();
    await database.db
      .updateTable('ticket')
      .set({ created_at: new Date(now - 10 * day) })
      .where('id', '=', T('a2').id)
      .execute();
    await database.db
      .updateTable('ticket_change')
      .set({ at: new Date(now - 10 * day) })
      .where('ticket_id', '=', T('a2').id)
      .execute();
    expect(
      (await data('alice', board.id)).cards.find((c) => c.id === T('a2').id)?.daysInColumn,
    ).toBe(10);
    // Into Doing four days ago, then within Doing two days ago: four days in the column.
    const changes = [
      ['New', 'Active', 4],
      ['Active', 'In Review', 2],
    ] as const;
    for (const [from, to, ago] of changes) {
      await database.db
        .insertInto('ticket_change')
        .values({
          workspace_id: 1,
          ticket_id: T('a2').id,
          change_set: '1',
          at: new Date(now - ago * day),
          field: 'status',
          from_value: String(S(from)),
          to_value: String(S(to)),
        })
        .execute();
    }
    await setStatus('a2', 'In Review');
    const d = await data('alice', board.id);
    const a2 = d.cards.find((c) => c.id === T('a2').id);
    expect([a2?.columnId, a2?.daysInColumn]).toEqual(['doing', 4]);
    await setStatus('a2', 'New');
  });

  it('[AGL-014] hides what the sub-filter leaves out', async () => {
    const board = await createBoard('alice', {
      name: 'Sub-filter',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA AND labels = blue' },
      subFilter: { query: 'labels IS EMPTY OR assignee IS NOT EMPTY' },
    });
    const d = await data('alice', board.id);
    expect(d.cards.map((c) => c.key)).toEqual([T('b2').key]);
    expect(d.columns[0]?.count).toBe(1);
  });

  it('[AGL-002] moves a card along the matching transition, asking which when several', async () => {
    const board = await createBoard('alice', {
      name: 'Moves',
      kind: 'kanban',
      trackId: tracks.BA,
      source: { query: 'track = BA AND (labels IS EMPTY OR labels = blue)' },
      columns: [
        { id: 'todo', name: 'To do', statusIds: [S('New')] },
        { id: 'doing', name: 'Doing', statusIds: [S('Active')] },
        { id: 'review', name: 'Review or done', statusIds: [S('In Review'), S('Closed')] },
      ],
    });
    const move = (who: string, body: Record<string, unknown>) =>
      post(who, `/api/v1/boards/${board.id}/moves`, body);
    // One transition leads into Doing: it runs, with its event and history.
    const started = await move('alice', { ticket: T('a2').id, columnId: 'doing' });
    expect(started.statusCode, started.body).toBe(200);
    expect(started.json()).toMatchObject({
      transitioned: true,
      ranked: false,
      ticket: { status: { name: 'Active' } },
    });
    const history = (await get('alice', `/api/v1/tickets/${T('a2').id}/history`)).json();
    expect(JSON.stringify(history)).toContain('Active');
    // From Active, "In Review" and "Closed" both lead into the last column.
    const ask = await move('alice', { ticket: T('a2').id, columnId: 'review' });
    expect(ask.statusCode).toBe(409);
    expect(ask.json().error).toBe('transition_choice');
    expect(
      ask
        .json()
        .transitions.map((t: { name: string }) => t.name)
        .sort(),
    ).toEqual(['Closed', 'In Review']);
    const chosen = ask.json().transitions.find((t: { name: string }) => t.name === 'In Review');
    const reviewed = await move('alice', {
      ticket: T('a2').id,
      columnId: 'review',
      transitionId: chosen.id,
      before: T('a1').id,
    });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json()).toMatchObject({ transitioned: true, ranked: true });
    // Ranked before a1: it now leads the board.
    expect((await data('alice', board.id)).cards[0]?.key).toBe(T('a2').key);
    // Within a column, only the rank changes.
    const rankOnly = await move('alice', {
      ticket: T('a2').id,
      columnId: 'review',
      after: T('b2').id,
    });
    expect(rankOnly.json()).toMatchObject({ transitioned: false, ranked: true });
    // A ticket off the board, or one the mover may not see, is refused.
    const off = await move('alice', { ticket: T('c1').id, columnId: 'doing' });
    expect(off.json()).toEqual({ error: 'invalid_fields', fields: { ticket: 'not_on_board' } });
    const unseen = await move('bob', { ticket: T('c1').id, columnId: 'doing' });
    expect(unseen.json().fields).toEqual({ ticket: 'not_on_board' });
    await setStatus('a2', 'New');
  });

  it('[AGL-002] refuses a move that no transition of the workflow leads to', async () => {
    // The default workflow reaches every status from every status; this one goes one way.
    const workflow = await post('admin', '/api/v1/workflows', {
      name: 'One way',
      definition: {
        initialStatusId: S('New'),
        statuses: [{ statusId: S('New') }, { statusId: S('Active') }],
        transitions: [{ id: 1, name: 'Start', from: [S('New')], to: S('Active') }],
      },
    });
    expect(workflow.statusCode, workflow.body).toBe(201);
    const map = await post('admin', '/api/v1/workflow-maps', {
      name: 'One way',
      defaultWorkflowId: workflow.json().workflow.id,
    });
    expect(map.statusCode, map.body).toBe(201);
    const track = await post('admin', '/api/v1/tracks', {
      key: 'BW',
      name: 'Track BW',
      mode: 'shared',
    });
    expect(track.statusCode, track.body).toBe(201);
    const trackId = track.json().track.id as number;
    const set = await patch('admin', `/api/v1/tracks/${trackId}`, {
      workflowMapId: map.json().workflowMap.id,
    });
    expect(set.statusCode, set.body).toBe(200);
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: members.id,
        user_id: users.alice?.id as number,
      })
      .execute();
    const card = await ticket('w1', 'BW');
    const board = await createBoard('alice', {
      name: 'One way',
      kind: 'kanban',
      trackId,
      source: { query: 'track = BW' },
      columns: [
        { id: 'todo', name: 'To do', statusIds: [S('New')] },
        { id: 'doing', name: 'Doing', statusIds: [S('Active')] },
      ],
    });
    const move = (columnId: string) =>
      post('alice', `/api/v1/boards/${board.id}/moves`, { ticket: card.id, columnId });
    expect((await move('doing')).json()).toMatchObject({ transitioned: true });
    expect((await move('todo')).json()).toEqual({ error: 'no_transition', columnId: 'todo' });
  });
});
