import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `sprint-fns-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.77.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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
 * Sprint and release functions and the relative sprint tokens (M1-045; QRY-004, QRY-013), run
 * through `/api/v1/search` and a Scrum board's quick filters: the sprint field by name and id,
 * the closed sprints a ticket passed through, `openSprints()`, `futureSprints()`,
 * `closedSprints()`, `@current`, `@next`, `@previous` on a board and across boards, the release
 * functions under both vocabularies in the manual release order, and ordering by sprint.
 */
describe('sprint and release functions (M1-045)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};
  const sprints: Record<string, number> = {};
  const boards: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const get = (who: string, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: unknown = {}) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const S = (name: string) => status[name] as number;
  const T = (name: string) => tickets[name] as { id: number; key: string };
  const K = (...names: string[]) => names.map((n) => T(n).key);

  async function ticket(name: string, track: string, group: string) {
    const res = await post('alice', '/api/v1/tickets', { track, summary: `${group} ${name}` });
    expect(res.statusCode, res.body).toBe(201);
    tickets[name] = res.json().ticket as { id: number; key: string };
  }
  async function scrumBoard(name: string, query: string) {
    const res = await post('alice', '/api/v1/boards', {
      name,
      kind: 'scrum',
      source: { query },
      columns: [
        { id: 'todo', name: 'To do', statusIds: [S('New')] },
        { id: 'doing', name: 'Doing', statusIds: [S('Active'), S('In Review')] },
        { id: 'done', name: 'Done', statusIds: [S('Closed')] },
      ],
      boardFilters: [
        { id: 'current', name: 'This sprint', query: 'sprint = @current' },
        { id: 'next', name: 'Next sprint', query: 'sprint = @next' },
        { id: 'previous', name: 'Last sprint', query: 'sprint = @previous' },
      ],
    });
    expect(res.statusCode, res.body).toBe(201);
    boards[name] = res.json().board.id as number;
  }
  async function sprint(board: string, name: string) {
    const res = await post('alice', `/api/v1/boards/${boards[board]}/sprints`, { name });
    expect(res.statusCode, res.body).toBe(201);
    sprints[name] = res.json().sprint.id as number;
  }
  async function add(sprintName: string, names: string[]) {
    const res = await post('alice', `/api/v1/sprints/${sprints[sprintName]}/tickets`, {
      tickets: names.map((n) => T(n).key),
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function start(sprintName: string) {
    const res = await post('alice', `/api/v1/sprints/${sprints[sprintName]}/start`, {
      endAt: '2026-12-31T09:00:00Z',
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function complete(sprintName: string, into: string) {
    const res = await post('alice', `/api/v1/sprints/${sprints[sprintName]}/complete`, {
      moveTo: { type: 'sprint', sprintId: sprints[into] },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function closeTicket(name: string) {
    await database.db
      .updateTable('ticket')
      .set({ status_id: S('Closed') })
      .where('id', '=', T(name).id)
      .execute();
  }
  const search = async (q: string, who = 'alice') => {
    const res = await get(who, `/api/v1/search?q=${encodeURIComponent(q)}&limit=200`);
    return { status: res.statusCode, body: res.json() };
  };
  /** The keys a query finds, in result order. */
  const found = async (q: string) => {
    const { status: code, body } = await search(q);
    expect(code, `${q}: ${JSON.stringify(body)}`).toBe(200);
    return (body.tickets as { key: string }[]).map((t) => t.key);
  };
  const sorted = (keys: string[]) => [...keys].sort();
  /** The keys a board shows with one of its quick filters. */
  const onBoard = async (board: string, filter: string) => {
    const res = await get('alice', `/api/v1/boards/${boards[board]}/data?filters=${filter}`);
    expect(res.statusCode, res.body).toBe(200);
    return sorted((res.json().cards as { key: string }[]).map((c) => c.key));
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
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
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const members = roles.find((r) => r.name === 'Members')?.id as number;
    for (const key of ['SP', 'SQ', 'SR']) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: members,
          user_id: users.alice?.id as number,
        })
        .execute();
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }

    // Alpha: Alpha 1 closed (t1 carried over, t2 done there), Alpha 2 active, 3 and 4 future.
    for (const n of ['t1', 't2', 't3', 't4', 't5', 't6']) await ticket(n, 'SP', 'grpq');
    await scrumBoard('Alpha', 'track = SP AND summary ~ grpq');
    for (const n of ['Alpha 1', 'Alpha 2', 'Alpha 3', 'Alpha 4']) await sprint('Alpha', n);
    await add('Alpha 1', ['t1', 't2']);
    await start('Alpha 1');
    await closeTicket('t2');
    await complete('Alpha 1', 'Alpha 2');
    await add('Alpha 2', ['t3']);
    await start('Alpha 2');
    await add('Alpha 3', ['t4']);
    await add('Alpha 4', ['t5']);
    // Beta, the board of another track: its own active and future sprint.
    for (const n of ['b1', 'b2', 'b3']) await ticket(n, 'SR', 'grpz');
    await scrumBoard('Beta', 'track = SR AND summary ~ grpz');
    await sprint('Beta', 'Beta 1');
    await sprint('Beta', 'Beta 2');
    await add('Beta 1', ['b1']);
    await start('Beta 1');
    await add('Beta 2', ['b2']);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-004] finds tickets by sprint name or id, including the closed sprints they passed through', async () => {
    expect(sorted(await found('sprint = "Alpha 2"'))).toEqual(sorted(K('t1', 't3')));
    expect(sorted(await found('sprint = "alpha 2"'))).toEqual(sorted(K('t1', 't3')));
    // t1 was carried over from Alpha 1; t2 was finished there.
    expect(sorted(await found(`sprint = ${sprints['Alpha 1']}`))).toEqual(sorted(K('t1', 't2')));
    expect(sorted(await found('sprint IN ("Alpha 3", "Alpha 4")'))).toEqual(sorted(K('t4', 't5')));
    expect(await found('sprint IS EMPTY AND summary ~ grpq')).toEqual(K('t6'));
    expect(sorted(await found('sprint IS NOT EMPTY AND summary ~ grpq'))).toEqual(
      sorted(K('t1', 't2', 't3', 't4', 't5')),
    );
    // Negated, a ticket in no sprint is not found, and one also in Alpha 2 is not either.
    expect(sorted(await found('sprint != "Alpha 2" AND summary ~ grpq'))).toEqual(
      sorted(K('t2', 't4', 't5')),
    );
    expect(sorted(await found('NOT sprint IN ("Alpha 2", "Alpha 1") AND summary ~ grpq'))).toEqual(
      sorted(K('t4', 't5')),
    );
    expect((await search('sprint = "Gamma 9"')).body).toEqual({
      error: 'invalid_query',
      message: '"sprint" has no value "Gamma 9"',
    });
  });

  it('[QRY-004] openSprints(), futureSprints() and closedSprints() follow the sprint states on every board', async () => {
    expect(sorted(await found('sprint IN openSprints()'))).toEqual(sorted(K('t1', 't3', 'b1')));
    expect(sorted(await found('sprint IN futureSprints()'))).toEqual(sorted(K('t4', 't5', 'b2')));
    expect(sorted(await found('sprint IN closedSprints()'))).toEqual(sorted(K('t1', 't2')));
    expect(sorted(await found('sprint NOT IN openSprints() AND summary ~ grpq'))).toEqual(
      sorted(K('t2', 't4', 't5')),
    );
    expect(sorted(await found('sprint IN (openSprints(), "Alpha 4")'))).toEqual(
      sorted(K('t1', 't3', 't5', 'b1')),
    );
  });

  it('[QRY-013] @current, @next and @previous are the board’s own sprints on a board, every board’s in a search', async () => {
    expect(await onBoard('Alpha', 'current')).toEqual(sorted(K('t1', 't3')));
    expect(await onBoard('Alpha', 'next')).toEqual(K('t4'));
    expect(await onBoard('Alpha', 'previous')).toEqual(sorted(K('t1', 't2')));
    expect(await onBoard('Beta', 'current')).toEqual(K('b1'));
    expect(await onBoard('Beta', 'next')).toEqual(K('b2'));
    expect(await onBoard('Beta', 'previous')).toEqual([]);
    // In a search, each board counts on its own.
    expect(sorted(await found('sprint = @current'))).toEqual(sorted(K('t1', 't3', 'b1')));
    expect(sorted(await found('sprint = @next'))).toEqual(sorted(K('t4', 'b2')));
    expect(sorted(await found('sprint IN (@previous, @next) AND summary ~ grpq'))).toEqual(
      sorted(K('t1', 't2', 't4')),
    );
    expect(sorted(await found('sprint != @current AND summary ~ grpq'))).toEqual(
      sorted(K('t2', 't4', 't5')),
    );
    // A token is a sprint; a quoted one is a plain name.
    expect((await search('status = @current')).body).toMatchObject({
      error: 'invalid_query',
      message: '@current is a sprint, which "status" does not take',
    });
    expect((await search('sprint = @later')).body.message).toBe(
      'Unknown sprint token "@later": use @current, @next or @previous',
    );
    expect((await search('sprint = "@current"')).body.message).toBe(
      '"sprint" has no value "@current"',
    );
  });

  it('[QRY-009] orders by the latest sprint in the board’s order, tickets in none last', async () => {
    expect(await found('summary ~ grpq ORDER BY sprint ASC')).toEqual(
      K('t2', 't1', 't3', 't4', 't5', 't6'),
    );
    expect(await found('summary ~ grpq ORDER BY sprint DESC')).toEqual(
      K('t5', 't4', 't3', 't1', 't2', 't6'),
    );
  });

  it('[QRY-004] answers the sprint functions in the statement, so 60,000 sprints cost no list of ids', async () => {
    // A board with 60,000 closed sprints, one of them holding gx.
    await ticket('gx', 'SQ', 'grpx');
    await scrumBoard('Gamma', 'track = SQ');
    const board = boards.Gamma as number;
    await sql`INSERT INTO sprint (workspace_id, board_id, name, state, sequence, started_at, completed_at)
      SELECT 1, ${board}::int, 'Old ' || g, 'closed', g, now() - interval '1 year', now() - interval '1 day'
        FROM generate_series(1, 60000) AS g`.execute(database.db);
    await sql`INSERT INTO sprint_ticket (workspace_id, sprint_id, ticket_id, open)
      SELECT 1, id, ${T('gx').id}::int, false FROM sprint WHERE board_id = ${board}::int AND name = 'Old 777'`.execute(
      database.db,
    );
    expect(await found('sprint IN closedSprints() AND summary ~ grpx')).toEqual(K('gx'));
    expect(await found('sprint = "Old 777"')).toEqual(K('gx'));
    expect(sorted(await found('sprint IN closedSprints()'))).toEqual(sorted(K('t1', 't2', 'gx')));
    const explained = await get(
      'admin',
      `/api/v1/admin/search/explain?q=${encodeURIComponent('sprint IN closedSprints()')}`,
    );
    expect(explained.statusCode, explained.body).toBe(200);
    expect(JSON.stringify(explained.json().parameters).length).toBeLessThan(500);
  });

  it('[QRY-013] @current follows the active sprint once a sprint is completed and the next started', async () => {
    await closeTicket('t3');
    await complete('Alpha 2', 'Alpha 3');
    // Between sprints nothing on Alpha is current; the last completed one is previous.
    expect(await onBoard('Alpha', 'current')).toEqual([]);
    expect(sorted(await onBoard('Alpha', 'previous'))).toEqual(sorted(K('t1', 't3')));
    expect(await onBoard('Alpha', 'next')).toEqual(sorted(K('t1', 't4')));
    await start('Alpha 3');
    expect(await onBoard('Alpha', 'current')).toEqual(sorted(K('t1', 't4')));
    expect(await onBoard('Alpha', 'next')).toEqual(K('t5'));
    expect(sorted(await found('sprint = @current AND summary ~ grpq'))).toEqual(
      sorted(K('t1', 't4')),
    );
  });

  describe('release functions', () => {
    const releases: Record<string, number> = {};
    async function release(
      name: string,
      track: string,
      order: number,
      state: { shipped?: string; archived?: boolean; date?: string } = {},
    ) {
      const row = await database.db
        .insertInto('release')
        .values({
          workspace_id: 1,
          track_id: tracks[track] as number,
          name,
          sort_order: order,
          shipped_at: state.shipped ? new Date(state.shipped) : null,
          archived_at: state.archived ? new Date('2026-06-01T00:00:00Z') : null,
          release_date: state.date ?? null,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      releases[name] = row.id;
    }
    async function target(
      ticketName: string,
      releaseName: string,
      role: 'target' | 'found' = 'target',
    ) {
      await database.db
        .insertInto('ticket_release')
        .values({
          workspace_id: 1,
          ticket_id: T(ticketName).id,
          release_id: releases[releaseName] as number,
          role,
        })
        .execute();
    }

    beforeAll(async () => {
      // SP in its manual order: R1 and R2 shipped (R2 earlier, and archived), R3 and R5 upcoming
      // (R5 due sooner), R4 upcoming but archived. SQ: Q1 upcoming.
      await release('R1', 'SP', 1, { shipped: '2026-05-01T00:00:00Z' });
      await release('R2', 'SP', 2, { shipped: '2026-03-01T00:00:00Z', archived: true });
      await release('R3', 'SP', 3, { date: '2026-12-01' });
      await release('R4', 'SP', 4, { archived: true });
      await release('R5', 'SP', 5, { date: '2026-11-01' });
      await release('Q1', 'SQ', 1, { date: '2026-11-15' });
      for (const n of ['r1', 'r2', 'r3', 'r4', 'r5', 'f1']) await ticket(n, 'SP', 'grpr');
      await ticket('q1', 'SQ', 'grpr');
      for (const [t, r] of [
        ['r1', 'R1'],
        ['r2', 'R2'],
        ['r3', 'R3'],
        ['r4', 'R4'],
        ['r5', 'R5'],
        ['q1', 'Q1'],
      ] as const) {
        await target(t, r);
      }
      await target('f1', 'R1', 'found');
    });

    it('[QRY-004] shippedReleases() and upcomingReleases(), under both vocabularies, with or without a track', async () => {
      for (const q of ['targetRelease IN shippedReleases()', 'fixVersion IN releasedVersions()']) {
        expect(sorted(await found(q))).toEqual(sorted(K('r1', 'r2')));
      }
      for (const q of [
        'targetRelease IN upcomingReleases()',
        'fixVersion IN unreleasedVersions()',
      ]) {
        // An archived release is upcoming no more.
        expect(sorted(await found(q))).toEqual(sorted(K('r3', 'r5', 'q1')));
      }
      expect(await found('targetRelease IN upcomingReleases(SQ)')).toEqual(K('q1'));
      expect(
        sorted(await found('targetRelease IN (shippedReleases(SP), shippedReleases(SQ))')),
      ).toEqual(sorted(K('r1', 'r2')));
      expect(await found('targetRelease IN shippedReleases(SQ)')).toEqual([]);
      for (const q of [
        'foundInRelease IN shippedReleases()',
        'affectedVersion IN releasedVersions()',
      ]) {
        expect(await found(q)).toEqual(K('f1'));
      }
      expect(
        sorted(await found('targetRelease NOT IN shippedReleases() AND summary ~ grpr')),
      ).toEqual(sorted(K('r3', 'r4', 'r5', 'q1')));
    });

    it('[QRY-004] latestShippedRelease() and earliestUpcomingRelease() follow the manual order, not dates', async () => {
      for (const q of [
        'targetRelease = latestShippedRelease(SP)',
        'fixVersion = latestReleasedVersion(SP)',
      ]) {
        // R2 shipped first, but comes later in the order.
        expect(await found(q)).toEqual(K('r2'));
      }
      for (const q of [
        'targetRelease = earliestUpcomingRelease(SP)',
        'fixVersion = earliestUnreleasedVersion(SP)',
      ]) {
        // R5 is due sooner, but R3 comes first; R4 is archived.
        expect(await found(q)).toEqual(K('r3'));
      }
      expect(await found('targetRelease = earliestUpcomingRelease(SQ)')).toEqual(K('q1'));
      expect(await found('targetRelease = latestShippedRelease(SQ)')).toEqual([]);
      expect((await search('targetRelease = latestShippedRelease()')).body.error).toBe(
        'invalid_query',
      );
    });
  });
});
