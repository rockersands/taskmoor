import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `program-board-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.88.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Cell {
  count: number;
  cards: number[];
}
interface Board {
  board: { id: number; name: string; version: number; teamField: { id: number } | null };
  query: string | null;
  clause: string;
  periods: { start: string; end: string; clause: string }[];
  unscheduledClause: string;
  rows: {
    team: { id: number; name: string } | null;
    clause: string | null;
    unscheduled: Cell;
    cells: Cell[];
  }[];
  cards: { id: number; key: string; summary: string; version: number }[];
  links: { from: number; to: number; linkTypeId: number; sameSprint?: boolean }[];
  linkTypes: { id: number; outward: string }[];
  sameSprint: boolean;
  blockersElsewhere: { id: number; outside: number; unlisted: number }[];
}

/**
 * Program boards (T-089d; PLN-008; ADR-122 stage 5). A plan over PBA and PBB with one-week periods
 * from Monday 1 March 2027, planning with the teams Red and Blue. Ana is a member of PBA only, so
 * PBB's "Hidden sentinel work" is never hers to see; Cy sees the plan and none of its tracks.
 */
describe('program boards (PLN-008)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const teams: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let planId = 0;
  let fieldId = 0;
  let boardId = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body.slice(0, 400)}`).toBe(
      code,
    );
    return res.statusCode === 204 ? null : res.json();
  };
  const base = () => `/api/v1/plans/${planId}/program-boards`;
  const read = async (who: string, id = boardId, query = '') => {
    const res = await as(who, { method: 'GET', url: `${base()}/${id}${query}` });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    return { body: res.body, board: res.json() as Board };
  };
  const searchCount = async (who: string, q: string): Promise<number> =>
    (await call(who, { method: 'POST', url: '/api/v1/search', payload: { q, count: true } })).total
      .count;
  const typeId = async (name: string) =>
    (
      await database.db
        .selectFrom('ticket_type')
        .select('id')
        .where('name', '=', name)
        .where('owner_track_id', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
  const ticket = async (track: string, summary: string, data: Record<string, unknown> = {}) =>
    (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/tickets', payload: { track, summary, ...data } },
        201,
      )
    ).ticket as { id: number; key: string };
  const team = (name: string) => ({ fields: { [String(fieldId)]: teams[name] } });
  const blocks = async (blocker: { key: string }, blocked: { key: string }) => {
    const type = await database.db
      .selectFrom('link_type')
      .select('id')
      .where('outward', '=', 'blocks')
      .executeTakeFirstOrThrow();
    await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/tickets/${blocker.key}/links`,
        payload: { linkTypeId: type.id, ticket: blocked.key },
      },
      201,
    );
  };
  /** Each card's summary by row (team name, or "other") and column ("none" or the period's start). */
  const layout = (b: Board) => {
    const names = new Map(b.cards.map((c) => [c.id, c.summary]));
    const out: Record<string, string[]> = {};
    for (const row of b.rows) {
      const name = row.team?.name ?? 'other';
      const put = (column: string, cell: Cell) => {
        if (cell.cards.length > 0) {
          out[`${name} ${column}`] = cell.cards.map((id) => names.get(id) ?? `?${id}`);
        }
      };
      put('none', row.unscheduled);
      for (const [i, cell] of row.cells.entries()) put(b.periods[i]?.start ?? '?', cell);
    }
    return out;
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
      ['cy', false],
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
    for (const [key, name] of [
      ['PBA', 'Apps'],
      ['PBB', 'Billing'],
    ] as const) {
      const made = await call(
        'admin',
        { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
        201,
      );
      tracks[key] = made.track.id;
    }
    const members = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks.PBA as number,
        role_id: members,
        user_id: users.ana?.id as number,
      })
      .execute();
    for (const name of ['Red', 'Blue', 'Green']) {
      teams[name] = (
        await call('admin', { method: 'POST', url: '/api/v1/teams', payload: { name } }, 201)
      ).team.id;
    }
    fieldId = (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/fields', payload: { name: 'Team', type: 'team' } },
        201,
      )
    ).field.id;
    const outcome = await typeId('Outcome');
    const feature = await typeId('Feature');
    t.launch = await ticket('PBA', 'Launch', {
      ticketTypeId: outcome,
      dueDate: '2027-03-05',
      ...team('Red'),
    });
    t.login = await ticket('PBA', 'Login', {
      ticketTypeId: feature,
      startDate: '2027-03-02',
      dueDate: '2027-03-03',
      ...team('Red'),
    });
    t.search = await ticket('PBA', 'Search', {
      ticketTypeId: feature,
      dueDate: '2027-03-10',
      ...team('Blue'),
    });
    t.export = await ticket('PBA', 'Export', {
      ticketTypeId: feature,
      dueDate: '2027-03-17',
      ...team('Green'),
    });
    t.later = await ticket('PBA', 'Someday', { ticketTypeId: feature });
    t.far = await ticket('PBA', 'Far off', {
      ticketTypeId: feature,
      dueDate: '2027-04-20',
      ...team('Red'),
    });
    t.sub = await ticket('PBA', 'A subticket', {
      ticketTypeId: await typeId('Subticket'),
      parent: t.login.key,
      dueDate: '2027-03-03',
    });
    t.hidden = await ticket('PBB', 'Hidden sentinel work', {
      ticketTypeId: feature,
      dueDate: '2027-03-04',
      ...team('Red'),
    });
    // Search waits for nothing; Login waits for Search (late), the hidden ticket and Far off.
    await blocks(t.search, t.login);
    await blocks(t.hidden, t.login);
    await blocks(t.far, t.search);
    planId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: {
            name: 'Program',
            sources: [
              { kind: 'track', trackId: tracks.PBA },
              { kind: 'track', trackId: tracks.PBB },
            ],
            shares: [{ scope: 'any_user' }],
          },
        },
        201,
      )
    ).plan.id;
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: {
        teams: [teams.Red, teams.Blue],
        period: { kind: 'weeks', weeks: 1, anchor: '2027-03-01' },
      },
    });
    boardId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: base(),
          payload: { name: 'Spring', from: '2027-03-03', periods: 4 },
        },
        201,
      )
    ).board.id;
  }, 180_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-008] lays out levels 1 and 0 by team and period, other and no team last, unscheduled first', async () => {
    const { board } = await read('admin');
    expect(board.board).toMatchObject({ name: 'Spring', teamField: { id: fieldId } });
    expect(board.periods.map((p) => [p.start, p.end])).toEqual([
      ['2027-03-01', '2027-03-07'],
      ['2027-03-08', '2027-03-14'],
      ['2027-03-15', '2027-03-21'],
      ['2027-03-22', '2027-03-28'],
    ]);
    expect(board.rows.map((r) => r.team?.name ?? null)).toEqual(['Red', 'Blue', null]);
    // The outcome first in its cell; the subticket and the work past the board's periods left out.
    expect(layout(board)).toEqual({
      'Red 2027-03-01': ['Launch', 'Login', 'Hidden sentinel work'],
      'Blue 2027-03-08': ['Search'],
      'other none': ['Someday'],
      'other 2027-03-15': ['Export'],
    });
    expect(board.clause).toBe('hierarchyLevel IN (0, 1)');
    expect(board.rows.map((r) => r.clause)).toEqual([
      `cf[${fieldId}] = ${teams.Red}`,
      `cf[${fieldId}] = ${teams.Blue}`,
      `(cf[${fieldId}] IS EMPTY OR cf[${fieldId}] NOT IN (${teams.Red}, ${teams.Blue}))`,
    ]);
  });

  it('[PLN-008] [QRY-008] makes every cell’s count the count of its search, for each viewer', async () => {
    for (const who of ['admin', 'ana', 'cy']) {
      const { board } = await read(who);
      if (board.query === null) {
        expect(who).toBe('cy');
        continue;
      }
      let checked = 0;
      for (const row of board.rows) {
        const parts = (column: string) =>
          [`(${board.query})`, board.clause, row.clause, column].filter(Boolean).join(' AND ');
        const cells: [string, Cell][] = [
          [board.unscheduledClause, row.unscheduled],
          ...row.cells.map((c, i): [string, Cell] => [board.periods[i]?.clause as string, c]),
        ];
        for (const [column, cell] of cells) {
          expect(await searchCount(who, parts(column)), `${who}: ${parts(column)}`).toBe(
            cell.count,
          );
          checked++;
        }
      }
      expect(checked).toBe(15);
    }
  });

  it('[PLN-008] never shows, counts or names a ticket the viewer may not see, and counts its dependencies only', async () => {
    const admin = await read('admin');
    expect(admin.board.links).toContainEqual(
      expect.objectContaining({ from: t.hidden?.id, to: t.login?.id }),
    );
    const { board, body } = await read('ana');
    expect(layout(board)['Red 2027-03-01']).toEqual(['Launch', 'Login']);
    expect(board.rows[0]?.cells[0]?.count).toBe(2);
    expect(body).not.toContain('Hidden sentinel work');
    expect(body).not.toContain(t.hidden?.key);
    expect(body).not.toContain('PBB');
    // Search blocks Login (drawn); the hidden ticket is outside for her, counted, never named;
    // Far off is the plan's own, past the board's periods.
    expect(board.links).toEqual([expect.objectContaining({ from: t.search?.id, to: t.login?.id })]);
    expect(board.blockersElsewhere).toEqual(
      [
        { id: t.login?.id, outside: 1, unlisted: 0 },
        { id: t.search?.id, outside: 0, unlisted: 1 },
      ].sort((a, b) => (a.id ?? 0) - (b.id ?? 0)),
    );
    // Cy sees the plan and none of its work: an empty board, nothing named.
    const cy = await read('cy');
    expect(cy.board.cards).toEqual([]);
    expect(cy.board.rows.every((r) => r.cells.every((c) => c.count === 0))).toBe(true);
    expect(cy.body).not.toContain('Hidden sentinel work');
    expect(cy.body).not.toContain('Launch');
  });

  it('[PLN-008] narrows the board with the views’ filters', async () => {
    const { board } = await read('admin', boardId, '?track=PBB');
    expect(layout(board)).toEqual({ 'Red 2027-03-01': ['Hidden sentinel work'] });
  });

  it('[PLN-008] lists a cell’s first 20 cards and counts the rest', async () => {
    const feature = await typeId('Feature');
    const made: { id: number }[] = [];
    for (let i = 0; i < 22; i++) {
      made.push(
        await ticket('PBA', `Bulk ${String(i).padStart(2, '0')}`, {
          ticketTypeId: feature,
          dueDate: '2027-03-24',
          ...team('Blue'),
        }),
      );
    }
    try {
      const { board } = await read('admin');
      const cell = board.rows[1]?.cells[3] as Cell;
      expect(cell.count).toBe(22);
      expect(cell.cards).toHaveLength(20);
    } finally {
      await database.db
        .deleteFrom('ticket')
        .where(
          'id',
          'in',
          made.map((m) => m.id),
        )
        .execute();
    }
  });

  it('[PLN-008] holds three or more active boards, and archived ones after them', async () => {
    const extra: number[] = [];
    for (const name of ['Summer', 'Autumn', 'Winter']) {
      extra.push(
        (await call('admin', { method: 'POST', url: base(), payload: { name } }, 201)).board.id,
      );
    }
    try {
      const winter = extra[2] as number;
      const archived = await call('admin', {
        method: 'PATCH',
        url: `${base()}/${winter}`,
        payload: { archived: true, version: 1 },
      });
      expect(archived.board).toMatchObject({ archived: true, version: 2 });
      const list = await call('ana', { method: 'GET', url: base() });
      expect(list.editable).toBe(false);
      expect(
        list.boards.map((b: { name: string; archived: boolean }) => [b.name, b.archived]),
      ).toEqual([
        ['Autumn', false],
        ['Spring', false],
        ['Summer', false],
        ['Winter', true],
      ]);
      expect(list.teamFields).toEqual([{ id: fieldId, name: 'Team' }]);
      // Every active one reads.
      for (const id of [boardId, ...extra]) await read('ana', id);
    } finally {
      for (const id of extra) {
        await call('admin', { method: 'DELETE', url: `${base()}/${id}` }, 204);
      }
    }
  });

  it('[PLN-008] lets only the plan’s editors change boards, with a version, and records each change', async () => {
    expect(
      (await as('ana', { method: 'POST', url: base(), payload: { name: 'Mine' } })).json(),
    ).toEqual({ error: 'forbidden', permission: 'edit_plan' });
    expect(
      (
        await as('ana', {
          method: 'PATCH',
          url: `${base()}/${boardId}`,
          payload: { name: 'Taken' },
        })
      ).statusCode,
    ).toBe(403);
    expect((await as('ana', { method: 'DELETE', url: `${base()}/${boardId}` })).statusCode).toBe(
      403,
    );
    const { board } = await read('admin');
    const renamed = await call('admin', {
      method: 'PATCH',
      url: `${base()}/${boardId}`,
      payload: { name: 'Spring PI', version: board.board.version },
    });
    expect(renamed.board.name).toBe('Spring PI');
    const stale = await as('admin', {
      method: 'PATCH',
      url: `${base()}/${boardId}`,
      payload: { name: 'Stale', version: board.board.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'version_conflict', version: board.board.version + 1 });
    // Without the version read, nothing changes: a change made meanwhile is never overwritten.
    const unversioned = await as('admin', {
      method: 'PATCH',
      url: `${base()}/${boardId}`,
      payload: { periods: 2 },
    });
    expect(unversioned.statusCode).toBe(400);
    expect(unversioned.json()).toMatchObject({ error: 'invalid_fields' });
    expect(Object.keys(unversioned.json().fields)).toEqual(['version']);
    expect((await read('admin')).board.periods).toHaveLength(4);
    const refused = await as('admin', {
      method: 'PATCH',
      url: `${base()}/${boardId}`,
      payload: { teamFieldId: 999_999, version: renamed.board.version },
    });
    expect(refused.json()).toEqual({
      error: 'invalid_fields',
      fields: { teamFieldId: 'not_found' },
    });
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('subject_type', '=', 'plan')
      .where('subject_id', '=', String(planId))
      .where('type', 'like', 'plan.program_board_%')
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.type)).toContain('plan.program_board_created');
    expect(events.at(-1)).toMatchObject({
      type: 'plan.program_board_updated',
      payload: { boardId, changes: { name: { from: 'Spring', to: 'Spring PI' } } },
    });
    await call('admin', {
      method: 'PATCH',
      url: `${base()}/${boardId}`,
      payload: { name: 'Spring', version: renamed.board.version },
    });
  });

  it('[PLN-008] answers a hidden plan and another plan’s board exactly as a missing id', async () => {
    const own = (
      await call(
        'ana',
        { method: 'POST', url: '/api/v1/plans', payload: { name: 'Ana’s own' } },
        201,
      )
    ).plan.id;
    const missing = await as('cy', { method: 'GET', url: '/api/v1/plans/999999/program-boards' });
    const hidden = await as('cy', { method: 'GET', url: `/api/v1/plans/${own}/program-boards` });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    const hiddenBoard = await as('cy', {
      method: 'GET',
      url: `/api/v1/plans/${own}/program-boards/${boardId}`,
    });
    expect(hiddenBoard.body).toBe(missing.body);
    // Ana's own plan does not hold this board: not found, as an id that does not exist.
    const elsewhere = await as('ana', {
      method: 'GET',
      url: `/api/v1/plans/${own}/program-boards/${boardId}`,
    });
    const none = await as('ana', {
      method: 'GET',
      url: `/api/v1/plans/${own}/program-boards/999999`,
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.body).toBe(none.body);
    expect(
      (await as('ana', { method: 'DELETE', url: `/api/v1/plans/${own}/program-boards/${boardId}` }))
        .statusCode,
    ).toBe(404);
  });

  it('[PLN-008] moves a card through the ticket’s own route, and refuses a stale move without changing anything', async () => {
    const before = await read('ana');
    const card = before.board.cards.find((c) => c.id === t.search?.id);
    expect(card).toBeDefined();
    // Moved to Red, a week later: the Team value and the due day, with the version read.
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.search?.key}`,
      payload: { version: card?.version, dueDate: '2027-03-17', ...team('Red') },
    });
    // Ana moves it from what she read before: refused, nothing changed.
    const stale = await as('ana', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.search?.key}`,
      payload: { version: card?.version, dueDate: '2027-03-24', ...team('Blue') },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'version_conflict' });
    const after = await read('ana');
    expect(layout(after.board)['Red 2027-03-15']).toEqual(['Search']);
    expect(layout(after.board)['Blue 2027-03-08']).toBeUndefined();
  });

  it('[PLN-013] [PLN-008] counts the plan’s chosen link types and marks a dependency within one sprint on the board', async () => {
    const relates = (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('outward', '=', 'relates to')
        .executeTakeFirstOrThrow()
    ).id;
    const options = (linkTypeIds: number[], sameSprint: boolean) =>
      call('admin', {
        method: 'PATCH',
        url: `/api/v1/plans/${planId}`,
        payload: { dependencies: { linkTypeIds, sameSprint } },
      });
    // Launch relates to Login: Login waits for Launch once the plan counts "relates to".
    await call(
      'admin',
      {
        method: 'POST',
        url: `/api/v1/tickets/${t.launch?.key}/links`,
        payload: { linkTypeId: relates, ticket: t.login?.key },
      },
      201,
    );
    const scrum = await database.db
      .insertInto('board')
      .values({
        workspace_id: 1,
        name: 'PBA board',
        kind: 'scrum',
        location_track_id: tracks.PBA as number,
        location_user_id: null,
        filter_query: 'track = PBA',
        sub_filter_query: null,
        columns: JSON.stringify([]),
        swimlanes: JSON.stringify({ kind: 'none' }),
        card_rules: JSON.stringify([]),
        created_by: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    const sprint = await database.db
      .insertInto('sprint')
      .values({
        workspace_id: 1,
        board_id: scrum.id,
        name: 'PBA 1',
        sequence: 1,
        state: 'active',
        started_at: new Date(),
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('sprint_ticket')
      .values([
        { workspace_id: 1, sprint_id: sprint.id, ticket_id: t.launch?.id as number },
        { workspace_id: 1, sprint_id: sprint.id, ticket_id: t.login?.id as number },
      ])
      .execute();
    const chosen = (b: Board) => b.links.filter((l) => l.linkTypeId === relates);
    try {
      // Not chosen: only blocking links, and nothing marked.
      let { board } = await read('admin');
      expect(chosen(board)).toEqual([]);
      expect(board.sameSprint).toBe(false);
      expect(board.links.some((l) => l.sameSprint)).toBe(false);

      await options([relates], true);
      ({ board } = await read('admin'));
      expect(board.sameSprint).toBe(true);
      expect(chosen(board)).toEqual([
        { from: t.launch?.id, to: t.login?.id, linkTypeId: relates, sameSprint: true },
      ]);
      expect(board.linkTypes.map((l) => l.outward).sort()).toEqual(['blocks', 'relates to']);
      // Search blocks Login, but Search is in no sprint: not marked.
      expect(board.links.find((l) => l.from === t.search?.id)?.sameSprint).toBeUndefined();

      // The type alone, without the flag: drawn, never marked.
      await options([relates], false);
      ({ board } = await read('admin'));
      expect(board.sameSprint).toBe(false);
      expect(chosen(board)).toEqual([{ from: t.launch?.id, to: t.login?.id, linkTypeId: relates }]);
    } finally {
      await options([], false);
      await database.db.deleteFrom('sprint_ticket').where('sprint_id', '=', sprint.id).execute();
      await database.db.deleteFrom('sprint').where('id', '=', sprint.id).execute();
      await database.db.deleteFrom('board').where('id', '=', scrum.id).execute();
      await database.db
        .deleteFrom('ticket_link')
        .where('link_type_id', '=', relates)
        .where('source_id', '=', t.launch?.id as number)
        .execute();
    }
  });

  it('[PLN-008] puts every card in one row once its Team field is gone', async () => {
    // The routes refuse to delete a field in use; one deleted all the same leaves the board.
    await database.db.deleteFrom('field_context').where('field_id', '=', fieldId).execute();
    await database.db.deleteFrom('field').where('id', '=', fieldId).execute();
    const { board } = await read('admin');
    expect(board.board.teamField).toBeNull();
    expect(board.rows.map((r) => [r.team, r.clause])).toEqual([[null, null]]);
    expect(board.cards.length).toBeGreaterThan(3);
  });
});
