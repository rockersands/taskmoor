import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { stableJson } from '@taskmoor/testkit';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `widget-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.86.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const DAY = 86_400_000;
const H = 3600;
/** A UTC date `n` days before today, at noon: always in the past, never on a day's edge. */
const ago = (n: number) => `${new Date(Date.now() - n * DAY).toISOString().slice(0, 10)}T12:00:00Z`;
/** Dates as days before today, so the golden file does not age. */
const relative = (value: unknown): unknown => {
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  return JSON.parse(JSON.stringify(value), (_key, v) =>
    typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
      ? `d-${Math.round((today - Date.parse(`${v}T00:00:00Z`)) / DAY)}`
      : v,
  );
};

/**
 * Every dashboard widget's data through the API (M1-064; RPT-004 (1), RPT-005 (1)): four tickets
 * made over the last ten days, two closed, read through one shared dashboard by two people who
 * see different tracks. The numbers were worked out by hand from the moments below; the whole
 * set is kept as a golden file.
 */
describe('dashboard widgets (M1-064)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let dashboard = 0;
  let team = 0;
  let closeReason = 0;

  const as = (who: string | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? (users[who]?.cookie ?? '') : '' },
    });
  const call = async (who: string | null, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.statusCode === 204 ? null : res.json();
  };
  const data = async (who: string | null, widget: string, code = 200) => {
    const body = await call(
      who,
      { method: 'GET', url: `/api/v1/dashboards/${dashboard}/widgets/${widget}` },
      code,
    );
    return code === 200 ? body.data : body;
  };
  /** A ticket's history moved to `at`, as if it had been made then. */
  async function madeAt(name: string, at: string) {
    const id = t[name]?.id as number;
    await sql`UPDATE ticket SET created_at = ${at}::timestamptz WHERE id = ${id}::int`.execute(
      database.db,
    );
    await sql`UPDATE ticket_change SET at = ${at}::timestamptz WHERE ticket_id = ${id}::int`.execute(
      database.db,
    );
  }
  /** Closed at `at`: its status and close reason, and the history rows saying so. */
  async function closedAt(name: string, at: string) {
    const id = t[name]?.id as number;
    await database.db
      .updateTable('ticket')
      .set({ status_id: status.Closed as number, close_reason_id: closeReason })
      .where('id', '=', id)
      .execute();
    for (const [field, from, to] of [
      ['status', String(status.New), String(status.Closed)],
      ['closeReason', null, String(closeReason)],
    ] as const) {
      await database.db
        .insertInto('ticket_change')
        .values({
          workspace_id: 1,
          ticket_id: id,
          change_set: '999999',
          field,
          from_value: from,
          to_value: to,
          from_display: null,
          to_display: null,
          at: new Date(at),
        })
        .execute();
    }
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    // Bob sees WA only; alice sees both.
    for (const [key, who] of [
      ['WA', ['alice', 'bob']],
      ['WB', ['alice']],
    ] as const) {
      const res = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name: `Widgets ${key}`, mode: 'shared' },
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
    closeReason = (
      await database.db
        .selectFrom('close_reason')
        .select('id')
        .orderBy('sort_order')
        .executeTakeFirstOrThrow()
    ).id;
    team = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/fields',
          payload: {
            name: 'Team',
            type: 'select',
            context: { options: [{ value: 'Red' }, { value: 'Blue' }] },
          },
        },
        201,
      )
    ).field.id;
    const options = await database.db
      .selectFrom('field_option')
      .select(['id', 'value'])
      .where('field_id', '=', team)
      .execute();
    const option = (value: string) => options.find((o) => o.value === value)?.id as number;
    const priorities = await database.db.selectFrom('priority').select(['id', 'name']).execute();
    const priority = (n: string) => priorities.find((p) => p.name === n)?.id ?? null;
    for (const [name, track, prio, labels, colour, assignee, summary] of [
      ['a', 'WA', 'High', ['x'], 'Red', 'alice', 'wid a'],
      ['b', 'WA', 'Low', [], null, 'alice', 'wid b'],
      ['c', 'WB', 'High', ['x', 'y'], 'Blue', 'alice', 'wid c'],
      ['d', 'WA', null, ['y'], null, 'bob', 'wid d'],
      ['other', 'WA', 'High', [], null, 'alice', 'unrelated'],
    ] as const) {
      t[name] = (
        await call(
          'alice',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: {
              track,
              summary,
              priorityId: prio === null ? null : priority(prio),
              labels: [...labels],
              assigneeId: users[assignee]?.id,
              fields: colour ? { [team]: option(colour) } : {},
            },
          },
          201,
        )
      ).ticket;
    }
    await madeAt('a', ago(5));
    await madeAt('b', ago(4));
    await madeAt('c', ago(2));
    await madeAt('d', ago(10));
    await madeAt('other', ago(3));
    await closedAt('a', ago(3));
    await closedAt('c', ago(1));
    await call(
      'bob',
      {
        method: 'PUT',
        url: `/api/v1/tickets/${t.b?.id}/followers/${users.bob?.id}`,
      },
      204,
    );
    // A Scrum board in WA counting tickets, with b and d in a sprint ending in five days.
    const scrum = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'Widgets scrum',
            kind: 'scrum',
            trackId: tracks.WA,
            source: { query: 'track = WA AND summary ~ wid' },
            columns: [
              { id: 'todo', name: 'To do', statusIds: [status.New] },
              { id: 'done', name: 'Done', statusIds: [status.Closed] },
            ],
            sprintSettings: {
              estimation: { statistic: 'ticketCount' },
              timeTracking: 'none',
              parallelSprints: false,
            },
          },
        },
        201,
      )
    ).board.id;
    const kanban = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'Widgets flow',
            kind: 'kanban',
            trackId: tracks.WA,
            source: { query: 'track = WA' },
          },
        },
        201,
      )
    ).board.id;
    const sprint = (
      await call(
        'alice',
        { method: 'POST', url: `/api/v1/boards/${scrum}/sprints`, payload: { name: 'S1' } },
        201,
      )
    ).sprint.id;
    await call('alice', {
      method: 'POST',
      url: `/api/v1/sprints/${sprint}/tickets`,
      payload: { tickets: [t.b?.key, t.d?.key] },
    });
    const end = `${new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10)}T23:00:00Z`;
    await call('alice', {
      method: 'POST',
      url: `/api/v1/sprints/${sprint}/start`,
      payload: { endAt: end },
    });
    // b is done after the start.
    await database.db
      .updateTable('ticket')
      .set({ status_id: status.Closed as number })
      .where('id', '=', t.b?.id as number)
      .execute();
    await database.db
      .insertInto('ticket_change')
      .values({
        workspace_id: 1,
        ticket_id: t.b?.id as number,
        change_set: '999998',
        field: 'status',
        from_value: String(status.New),
        to_value: String(status.Closed),
        from_display: null,
        to_display: null,
      })
      .execute();
    const query = 'summary ~ wid';
    dashboard = (
      await call(
        'alice',
        {
          method: 'POST',
          url: '/api/v1/dashboards',
          payload: {
            name: 'Everything',
            layout: 'three',
            shares: [{ scope: 'user', userId: users.bob?.id }],
            widgets: [
              { id: 'intro', kind: 'introduction', config: { text: 'Welcome' } },
              {
                id: 'links',
                kind: 'quick-links',
                config: { links: [{ label: 'Home', url: '#/' }] },
              },
              {
                id: 'results',
                kind: 'search-results',
                config: { query: `${query} ORDER BY created ASC`, limit: 2 },
              },
              { id: 'assigned', kind: 'assigned-to-me' },
              { id: 'followed', kind: 'followed-tickets' },
              { id: 'cvc', kind: 'created-vs-closed', config: { query, days: 7 } },
              {
                id: 'cvc-total',
                kind: 'created-vs-closed',
                config: { query, days: 7, cumulative: true },
              },
              { id: 'recent', kind: 'recently-created', config: { query, days: 7 } },
              { id: 'age', kind: 'average-age', config: { query, days: 7 } },
              { id: 'close', kind: 'time-to-close', config: { query, days: 7 } },
              { id: 'pie', kind: 'pie', config: { query, field: 'priority' } },
              {
                id: 'stats',
                kind: 'ticket-statistics',
                config: { query, field: 'labels', sort: 'total' },
              },
              {
                id: 'grid',
                kind: 'two-dimensional',
                config: { query, x: 'priority', y: `cf[${team}]` },
              },
              { id: 'burndown', kind: 'sprint-burndown', config: { boardId: scrum } },
              { id: 'health', kind: 'sprint-health', config: { boardId: scrum } },
              { id: 'days', kind: 'days-remaining', config: { boardId: scrum } },
              { id: 'flow', kind: 'days-remaining', config: { boardId: kanban } },
              { id: 'status', kind: 'average-time-in-status', config: { query, days: 7 } },
              { id: 'broken', kind: 'search-results', config: { query: 'nosuchfield = 1' } },
            ],
          },
        },
        201,
      )
    ).dashboard.id;
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-005] lists tickets: a query, the person’s open tickets, those they follow', async () => {
    const results = await data('alice', 'results');
    expect(results.tickets.map((x: { key: string }) => x.key)).toEqual([t.d?.key, t.a?.key]);
    expect(results.total).toEqual({ count: 4, exact: true });
    expect(results.tickets[1]).toMatchObject({
      summary: 'wid a',
      status: 'Closed',
      priority: 'High',
      assignee: 'alice',
    });
    // a and c have a close reason; b is in a done status without one, so it is still open. The
    // widget has no query of its own: "other" counts too. Highest priority first.
    expect((await data('alice', 'assigned')).tickets.map((x: { key: string }) => x.key)).toEqual([
      t.other?.key,
      t.b?.key,
    ]);
    expect((await data('bob', 'assigned')).tickets.map((x: { key: string }) => x.key)).toEqual([
      t.d?.key,
    ]);
    // People follow what they create: alice follows all five; bob follows b.
    expect((await data('alice', 'followed')).total).toEqual({ count: 5, exact: true });
    expect((await data('bob', 'followed')).tickets.map((x: { key: string }) => x.key)).toEqual([
      t.b?.key,
    ]);
    expect(await data('alice', 'intro')).toBeNull();
  });

  it('[RPT-002] counts created and closed by day, and their running totals', async () => {
    const cvc = relative(await data('alice', 'cvc')) as Record<string, unknown>;
    expect(cvc.periods).toEqual(['d-6', 'd-5', 'd-4', 'd-3', 'd-2', 'd-1', 'd-0']);
    expect([cvc.created, cvc.closed]).toEqual([
      [0, 1, 1, 0, 1, 0, 0],
      [0, 0, 0, 1, 0, 1, 0],
    ]);
    const total = await data('alice', 'cvc-total');
    expect([total.created, total.closed]).toEqual([
      [0, 1, 2, 2, 3, 3, 3],
      [0, 0, 0, 1, 1, 2, 2],
    ]);
    expect((await data('alice', 'recent')).created).toEqual([0, 1, 1, 0, 1, 0, 0]);
    // Bob does not see c in WB.
    const bob = await data('bob', 'cvc');
    expect([bob.created, bob.closed]).toEqual([
      [0, 1, 1, 0, 0, 0, 0],
      [0, 0, 0, 1, 0, 0, 0],
    ]);
  });

  it('[RPT-005] average age and time to close, from the history', async () => {
    const age = await data('alice', 'age');
    // At the end of each day: d alone (4.5 days), d and a, then b too, a closed, c too, c closed.
    expect(age.age.slice(0, 6).map((s: number) => Math.round((s / H) * 100) / 100)).toEqual([
      108, 72, 68, 108, 92, 156,
    ]);
    expect(age.open).toEqual([1, 2, 3, 2, 3, 2, 2]);
    const close = await data('alice', 'close');
    expect(close.closed).toEqual([0, 0, 0, 1, 0, 1, 0]);
    expect(close.average).toEqual([0, 0, 0, 48 * H, 0, 24 * H, 0]);
  });

  it('[RPT-005] counts by one field and by two, as the viewer sees the tickets', async () => {
    const pie = await data('alice', 'pie');
    const named = (values: { name: string | null; kind: string; total: number }[]) =>
      values.map((v) => [v.name ?? v.kind, v.total]);
    expect([named(pie.values), pie.total]).toEqual([
      [
        ['High', 2],
        ['Low', 1],
        ['none', 1],
      ],
      4,
    ]);
    // RPT-004 (1): on the dashboard alice shared, bob counts only what he may see.
    const bobPie = await data('bob', 'pie');
    expect([named(bobPie.values), bobPie.total]).toEqual([
      [
        ['High', 1],
        ['Low', 1],
        ['none', 1],
      ],
      3,
    ]);
    const stats = await data('alice', 'stats');
    expect(named(stats.values)).toEqual([
      ['x', 2],
      ['y', 2],
      ['none', 1],
    ]);
    const grid = await data('alice', 'grid');
    expect(named(grid.x)).toEqual([
      ['High', 2],
      ['Low', 1],
      ['none', 1],
    ]);
    expect(named(grid.y)).toEqual([
      ['Red', 1],
      ['Blue', 1],
      ['none', 2],
    ]);
    expect(grid.cells).toEqual([
      [1, 1, 0],
      [0, 0, 1],
      [0, 0, 1],
    ]);
  });

  it('[RPT-005] follows the board’s active sprint, and says when it cannot', async () => {
    const burndown = await data('alice', 'burndown');
    expect(burndown.sprint.name).toBe('S1');
    expect(burndown.end).toMatchObject({ remaining: 1, scope: 2, completed: 1 });
    const health = await data('alice', 'health');
    expect([health.completed, health.scopeChange, health.remaining, health.scope]).toEqual([
      0.5, 0, 1, 2,
    ]);
    expect(health.elapsed).toBeGreaterThanOrEqual(0);
    expect(health.elapsed).toBeLessThan(0.2);
    expect((await data('alice', 'days')).daysRemaining).toBe(5);
    expect(await data('alice', 'flow')).toEqual({ unavailable: 'not_scrum' });
  });

  it('[RPT-005] time in each status over the window', async () => {
    const statuses = (await data('alice', 'status')).statuses as {
      status: { name: string };
      tickets: number;
      entries: number;
    }[];
    // New: a, b, c made in the window and d before it; a and c closed in it.
    expect(statuses.map((s) => [s.status.name, s.tickets, s.entries])).toEqual([
      ['New', 4, 3],
      ['Closed', 3, 3],
    ]);
  });

  it('[RPT-004] refuses a widget it cannot read, and keeps the golden set', async () => {
    expect((await data('alice', 'broken', 400)).error).toBe('invalid_query');
    await data('alice', 'nope', 404);
    await call(null, { method: 'GET', url: `/api/v1/dashboards/${dashboard}/widgets/intro` }, 404);
    const all: Record<string, unknown> = {};
    for (const id of [
      'intro',
      'links',
      'pie',
      'stats',
      'grid',
      'cvc',
      'cvc-total',
      'recent',
      'close',
      'flow',
    ]) {
      all[id] = relative(await data('alice', id));
    }
    const strip = (list: { id: number; key: string; updatedAt: string }[]) =>
      list.map((x) => ({ ...x, id: 0, key: x.key.replace(/\d+$/, 'n'), updatedAt: '' }));
    all.results = { ...(await data('alice', 'results')) };
    (all.results as { tickets: unknown }).tickets = strip((all.results as { tickets: [] }).tickets);
    const age = await data('alice', 'age');
    all.age = { ...(relative(age) as object), age: age.age.slice(0, 6) };
    const health = await data('alice', 'health');
    all.health = {
      completed: health.completed,
      scopeChange: health.scopeChange,
      remaining: health.remaining,
    };
    expect(stableJson(all)).toMatchFileSnapshot('./__golden__/dashboard-widgets.json');
  });
});
