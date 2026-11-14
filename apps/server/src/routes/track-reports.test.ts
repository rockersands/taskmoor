import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `reports-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

const DAY = 86_400_000;
const H = 3600;
const PEOPLE = ['admin', 'member', 'manager', 'outsider'] as const;
type Person = (typeof PEOPLE)[number];

interface Value {
  id: string | null;
  name: string | null;
  kind: 'value' | 'none' | 'other';
  total: number;
}

const sum = (list: readonly number[]) => list.reduce((s, v) => s + v, 0);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const next = (date: string) => iso(Date.parse(`${date}T00:00:00Z`) + DAY);
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * Every report of a track's Statistics, and the widgets of its Summary, against search (ADR-116;
 * RPT-001, RPT-002, RPT-005, RPT-006): each number a report shows is the count of a search the
 * viewer could run, or a sum over that search's tickets, so a report and its search never
 * disagree. Two people see the track: one on a visibility level that hides a ticket from the
 * other, so every count is checked as each of them. A Kanban track reads every report that does
 * not follow sprints. The speed of each is measured over a track of 10,000 tickets in every run
 * and 100,000 with TASKMOOR_LARGE_TRACK_REPORTS=1.
 */
describe('a track’s reports equal their searches', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const tracks: Record<string, number> = {};
  let scrumBoard = 0;
  let outcomeKey = '';
  let release = { id: 0, name: '' };
  let hiddenId = 0;

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const call = async (who: Person, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return code === 204 ? null : res.json();
  };
  const statistic = async (who: Person, track: string, kind: string, params = '') =>
    (
      await call(who, {
        method: 'GET',
        url: `/api/v1/tracks/${track}/statistics/${kind}${params ? `?${params}` : ''}`,
      })
    ).data;
  /** The ids a search finds as the person, every one of them. */
  const found = async (who: Person, q: string) => {
    const res = await call(who, {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=200&count=true`,
    });
    expect(res.total.exact, q).toBe(true);
    expect(res.tickets.length, q).toBe(res.total.count);
    return (res.tickets as { id: number }[]).map((t) => t.id);
  };
  const count = async (who: Person, q: string) => (await found(who, q)).length;
  /** A column added up over the tickets a search finds. */
  const sumOf = async (
    who: Person,
    q: string,
    column: 'original_estimate' | 'remaining_estimate' | 'time_spent',
  ) => {
    const ids = await found(who, q);
    if (ids.length === 0) return { seconds: 0, empty: 0 };
    const row = await sql<{ s: number; e: number }>`
      SELECT coalesce(sum(${sql.ref(column)}), 0)::float8 AS s,
             count(*) FILTER (WHERE ${sql.ref(column)} IS NULL)::int AS e
        FROM ticket WHERE id = ANY(${ids}::int[])`.execute(database.db);
    return { seconds: row.rows[0]?.s ?? 0, empty: row.rows[0]?.e ?? 0 };
  };
  /** The search for one value of an axis, inside `base`. */
  const valueQuery = (base: string, field: string, v: Value) => {
    if (v.kind === 'none') return `${base} AND ${field} IS EMPTY`;
    if (field === 'assignee') return `${base} AND assignee = ${v.id}`;
    return `${base} AND ${field} = ${quoted(v.name ?? v.id ?? '')}`;
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: name === 'admin',
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      const header = res.headers['set-cookie'];
      const list = Array.isArray(header) ? header : header ? [header] : [];
      users[name] = {
        id: row.id,
        cookie:
          (
            list.find(
              (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
            ) ?? ''
          ).split(';')[0] ?? '',
      };
    }
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const role = (name: string) => roles.find((r) => r.name === name)?.id as number;
    for (const key of ['RPS', 'RPK']) {
      tracks[key] = (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name: key, mode: 'shared' } },
          201,
        )
      ).track.id;
      for (const who of ['member', 'manager'] as const) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: role('Members'),
            user_id: users[who].id,
          })
          .execute();
      }
    }
    // RPS runs sprints; RPK's board is made Kanban, as a new track's first board is.
    scrumBoard = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/boards',
          payload: {
            name: 'RPS',
            kind: 'scrum',
            trackId: tracks.RPS,
            source: { query: 'track = RPS' },
          },
        },
        201,
      )
    ).board.id;
    expect(
      (await call('member', { method: 'GET', url: '/api/v1/tracks/RPK/board' })).board.kind,
    ).toBe('kanban');

    // A level only the manager is on hides one ticket from the member.
    const policy = await call(
      'admin',
      {
        method: 'POST',
        url: '/api/v1/visibility-policies',
        payload: {
          name: 'Managers only',
          levels: [{ name: 'Managers', members: [{ grantee: 'user', userId: users.manager.id }] }],
        },
      },
      201,
    );
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${tracks.RPS}`,
      payload: { visibilityPolicyId: policy.visibilityPolicy.id },
    });
    release = (
      await call(
        'admin',
        {
          method: 'POST',
          url: `/api/v1/tracks/${tracks.RPS}/releases`,
          payload: { name: 'Spring' },
        },
        201,
      )
    ).release;
    const types = (await call('admin', { method: 'GET', url: '/api/v1/tracks/RPS/ticket-types' }))
      .ticketTypes as { id: number; name: string; level: { rank: number } }[];
    const standard = types.filter((t) => t.level.rank === 0);
    const outcomeType = types.find((t) => t.level.rank === 1)?.id as number;
    const priorities = await database.db
      .selectFrom('priority')
      .select(['id', 'name'])
      .orderBy('sort_order')
      .execute();
    const today = Date.now();

    const create = async (track: string, body: Record<string, unknown>) =>
      (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tickets', payload: { track, ...body } },
          201,
        )
      ).ticket as { id: number; key: string };
    const close = async (id: number) => {
      const offered = (
        await call('admin', { method: 'GET', url: `/api/v1/tickets/${id}/transitions` })
      ).transitions as { id: number; to: { stage: string } }[];
      await call('admin', {
        method: 'POST',
        url: `/api/v1/tickets/${id}/transitions`,
        payload: { transitionId: offered.find((o) => o.to.stage === 'closed')?.id },
      });
    };

    const outcome = await create('RPS', { summary: 'Checkout', ticketTypeId: outcomeType });
    outcomeKey = outcome.key;
    // Twelve tickets over twelve days: assignees, types, priorities, labels, dates, estimates,
    // time logged, a release and the outcome vary; four are closed.
    const made: { id: number; age: number; closed: boolean }[] = [];
    for (let i = 0; i < 12; i++) {
      const ticket = await create('RPS', {
        summary: `Work ${i}`,
        ticketTypeId: (standard[i % standard.length] as { id: number }).id,
        assigneeId: [users.member.id, users.manager.id, null][i % 3],
        priorityId: i % 4 === 3 ? null : (priorities[i % priorities.length] as { id: number }).id,
        labels: [['web'], ['web', 'api'], []][i % 3],
        dueDate: iso(today - (i % 5) * DAY),
        startDate: iso(today - (i % 7) * DAY),
        ...(i % 4 === 2 ? {} : { originalEstimate: (i + 1) * H }),
        ...(i % 5 === 4 ? {} : { remainingEstimate: (i % 3) * H }),
        ...(i % 2 === 0 ? { targetReleaseIds: [release.id] } : {}),
        ...(i < 6 ? { parent: outcome.key } : {}),
      });
      if (i % 3 !== 2) {
        await call(
          'admin',
          {
            method: 'POST',
            url: `/api/v1/tickets/${ticket.id}/time-entries`,
            payload: { duration: (i + 1) * 900, remainingEstimate: { mode: 'leave' } },
          },
          201,
        );
      }
      if (i % 3 === 0) await close(ticket.id);
      made.push({ id: ticket.id, age: i, closed: i % 3 === 0 });
    }
    hiddenId = made[1]?.id as number;
    await call('manager', {
      method: 'PATCH',
      url: `/api/v1/tickets/${hiddenId}`,
      payload: { visibilityLevelId: policy.visibilityPolicy.levels[0].id },
    });
    for (let i = 0; i < 3; i++) {
      const ticket = await create('RPK', {
        summary: `Flow ${i}`,
        assigneeId: users.member.id,
        originalEstimate: 2 * H,
        remainingEstimate: H,
      });
      if (i === 0) await close(ticket.id);
    }
    // Spread the tickets over the past days: made `age` days ago, changed an hour later, closed
    // a day after being made. A closing moves with its history, so both reports stay one.
    for (const t of made) {
      const createdAt = new Date(today - t.age * DAY - 2 * H * 1000);
      const at = (ms: number) => new Date(Math.min(ms, today - 60_000));
      await sql`
        UPDATE ticket SET created_at = ${createdAt}, updated_at = ${at(createdAt.getTime() + H * 1000)},
                          closed_at = CASE WHEN closed_at IS NULL THEN NULL
                                           ELSE ${at(createdAt.getTime() + DAY)}::timestamptz END
         WHERE id = ${t.id}`.execute(database.db);
      if (t.closed) {
        await sql`
          UPDATE ticket_change SET at = ${at(createdAt.getTime() + DAY)}
           WHERE ticket_id = ${t.id} AND field = 'closeReason'`.execute(database.db);
      }
    }
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  const BASE = 'track = RPS';
  const viewers = ['member', 'manager'] as const;

  it('[RPT-002] the hidden ticket counts for the manager only, as in search', async () => {
    const all = async (who: Person) =>
      (await statistic(who, 'RPS', 'ticket-statistics', 'field=status')).total;
    expect(await all('member')).toBe(await count('member', BASE));
    expect(await all('manager')).toBe(await count('manager', BASE));
    expect((await all('manager')) - (await all('member'))).toBe(1);
    const listed = await statistic('manager', 'RPS', 'group-by', 'field=assignee&limit=50');
    const keys = listed.values.flatMap((v: { tickets: { id: number }[] }) =>
      v.tickets.map((t) => t.id),
    );
    expect(keys).toContain(hiddenId);
    const forMember = await statistic('member', 'RPS', 'group-by', 'field=assignee&limit=50');
    expect(
      forMember.values.flatMap((v: { tickets: { id: number }[] }) => v.tickets.map((t) => t.id)),
    ).not.toContain(hiddenId);
  });

  it('[RPT-002] tickets by date: each period is the search for that period, for each date', async () => {
    for (const who of viewers) {
      for (const field of ['created', 'updated', 'closed', 'due', 'start']) {
        const data = await statistic(who, 'RPS', 'time-since', `field=${field}&days=14&period=day`);
        expect(data.periods).toHaveLength(14);
        // Every date has tickets in the window, so nothing passes by being empty.
        expect(sum(data.counts), `${who} ${field}`).toBeGreaterThan(0);
        for (const [i, day] of (data.periods as string[]).entries()) {
          const q = `${BASE} AND ${field} >= "${day}" AND ${field} < "${next(day)}"`;
          expect(data.counts[i], `${who}: ${q}`).toBe(await count(who, q));
        }
        const running = await statistic(
          who,
          'RPS',
          'time-since',
          `field=${field}&days=14&period=week&cumulative=true`,
        );
        // The window starts 13 days back, inside the first week shown.
        const from = iso(Date.now() - 13 * DAY);
        const to = next(iso(Date.now()));
        expect(running.counts.at(-1), `${who} ${field} running`).toBe(
          await count(who, `${BASE} AND ${field} >= "${from}" AND ${field} < "${to}"`),
        );
      }
    }
  });

  it('[RPT-002] created vs closed, recently created, time to close and average age: each count is a search', async () => {
    for (const who of viewers) {
      const cvc = await statistic(who, 'RPS', 'created-vs-closed', 'days=14&period=day');
      const recent = await statistic(who, 'RPS', 'recently-created', 'days=14&period=day');
      const toClose = await statistic(who, 'RPS', 'time-to-close', 'days=14&period=day');
      expect(sum(cvc.created)).toBeGreaterThan(0);
      expect(sum(cvc.closed)).toBeGreaterThan(0);
      for (const [i, day] of (cvc.periods as string[]).entries()) {
        const created = await count(
          who,
          `${BASE} AND created >= "${day}" AND created < "${next(day)}"`,
        );
        // No ticket here was reopened, so the closings are the tickets closed that day.
        const closed = await count(
          who,
          `${BASE} AND closed >= "${day}" AND closed < "${next(day)}"`,
        );
        expect(cvc.created[i], `${who} created ${day}`).toBe(created);
        expect(recent.created[i], `${who} recent ${day}`).toBe(created);
        expect(cvc.closed[i], `${who} closed ${day}`).toBe(closed);
        expect(toClose.closed[i], `${who} time to close ${day}`).toBe(closed);
      }
      const age = await statistic(who, 'RPS', 'average-age', 'days=7&period=day');
      expect(age.open.at(-1), `${who} open now`).toBe(
        await count(who, `${BASE} AND closeReason IS EMPTY`),
      );
    }
  });

  it('[RPT-002] the reports over time end on the browser’s today, not UTC’s (T-272)', async () => {
    // Fourteen hours east and eleven west of UTC: their calendars never show the same day.
    const local = (zone: string) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date()).slice(0, 10);
    for (const zone of ['Pacific/Kiritimati', 'Pacific/Pago_Pago']) {
      for (const kind of ['recently-created', 'time-to-close', 'created-vs-closed']) {
        const { data } = await call('member', {
          method: 'GET',
          url: `/api/v1/tracks/RPS/statistics/${kind}?days=7&period=day`,
          headers: { 'taskmoor-time-zone': zone },
        });
        expect(data.timeZone, `${kind} ${zone}`).toBe(zone);
        expect((data.periods as string[]).at(-1), `${kind} ${zone}`).toBe(local(zone));
      }
    }
  });

  it('[RPT-002] average age counts a reopened ticket as open again, from its history', async () => {
    const id = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'RPA', name: 'RPA', mode: 'shared' },
        },
        201,
      )
    ).track.id as number;
    const made = [];
    for (const summary of ['Reopened', 'Open', 'Closed at once']) {
      made.push(
        (
          await call(
            'admin',
            { method: 'POST', url: '/api/v1/tickets', payload: { track: 'RPA', summary } },
            201,
          )
        ).ticket.id as number,
      );
    }
    const [reopened, open, closedAtOnce] = made as [number, number, number];
    const now = new Date();
    const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const at = (daysAgo: number, hours: number) =>
      new Date(midnight - daysAgo * DAY + hours * H * 1000);
    const reason = await database.db
      .selectFrom('close_reason')
      .select('id')
      .executeTakeFirstOrThrow();
    for (const [ticket, created] of [
      [reopened, at(5, 1)],
      [open, at(4, 1)],
      [closedAtOnce, at(2, 1)],
    ] as const) {
      await sql`UPDATE ticket SET created_at = ${created} WHERE id = ${ticket}`.execute(
        database.db,
      );
    }
    const change = (ticket: number, when: Date, to: string | null) =>
      sql`INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                     from_value, to_value)
          VALUES (1, ${ticket}, nextval('ticket_change_set_seq'), ${when}, ${users.admin.id},
                  'closeReason', ${to === null ? String(reason.id) : null}, ${to})`.execute(
        database.db,
      );
    await change(reopened, at(3, 1), String(reason.id));
    await change(reopened, at(1, 1), null);
    await change(closedAtOnce, at(2, 2), String(reason.id));
    const age = await statistic('admin', String(id), 'average-age', 'days=6&period=day');
    // Day by day: the reopened one alone, then the open one too; the reopened one closed (twice
    // over, as the third closes the day it is made); then both open again.
    expect(age.open).toEqual([1, 2, 1, 1, 2, 2]);
  });

  it('[RPT-005] pie, ticket statistics and two-dimensional: each value and cell is a search', async () => {
    for (const who of viewers) {
      for (const field of ['status', 'priority', 'assignee', 'labels']) {
        for (const kind of ['pie', 'ticket-statistics']) {
          const data = await statistic(who, 'RPS', kind, `field=${field}`);
          expect(data.total).toBe(await count(who, BASE));
          for (const v of data.values as Value[]) {
            expect(v.total, `${who} ${kind} ${field} ${v.name}`).toBe(
              await count(who, valueQuery(BASE, field, v)),
            );
          }
        }
      }
      const grid = await statistic(who, 'RPS', 'two-dimensional', 'x=status&y=assignee');
      for (const [i, row] of (grid.x as Value[]).entries()) {
        for (const [j, col] of (grid.y as Value[]).entries()) {
          expect(grid.cells[i][j], `${who} ${row.name} × ${col.name}`).toBe(
            await count(who, valueQuery(valueQuery(BASE, 'status', row), 'assignee', col)),
          );
        }
      }
    }
  });

  it('[RPT-002] grouped tickets: each group, its done count and its tickets are a search', async () => {
    for (const who of viewers) {
      for (const field of ['assignee', 'labels', 'priority']) {
        const data = await statistic(who, 'RPS', 'group-by', `field=${field}&limit=3`);
        expect(data.values.length, `${who} ${field}`).toBeGreaterThan(1);
        expect(data.total).toBe(await count(who, BASE));
        expect(data.closed).toBe(await count(who, `${BASE} AND stage = closed`));
        for (const v of data.values as (Value & { closed: number; tickets: { id: number }[] })[]) {
          const q = valueQuery(BASE, field, v);
          const ids = await found(who, q);
          expect(v.total, `${who} ${q}`).toBe(ids.length);
          expect(v.closed, `${who} ${q} done`).toBe(await count(who, `${q} AND stage = closed`));
          expect(v.tickets.length).toBe(Math.min(3, ids.length));
          for (const t of v.tickets) expect(ids).toContain(t.id);
        }
      }
    }
  });

  it('[RPT-002] grouped tickets: each group names the search that finds all of it (S3-ST-2)', async () => {
    for (const who of viewers) {
      for (const field of ['status', 'priority', 'type', 'assignee', 'labels', 'targetRelease']) {
        const data = await statistic(who, 'RPS', 'group-by', `field=${field}&limit=1`);
        const values = data.values as (Value & { query: string | null; tickets: unknown[] })[];
        // Some group lists fewer tickets than it has, so its search is the way to the rest.
        expect(
          values.some((v) => v.tickets.length < v.total),
          `${who} ${field}`,
        ).toBe(true);
        for (const v of values) {
          expect(v.query, `${who} ${field} ${v.name}`).toMatch(/^track = "RPS" AND /);
          const ids = await found(who, v.query as string);
          expect(ids.length, `${who} ${v.query}`).toBe(v.total);
          if (v.kind === 'none') expect(v.query).toContain(`${field} IS EMPTY`);
        }
      }
    }
    // A name only where the catalogue's names are unique; a person by id, as names may repeat.
    const byStatus = await statistic('member', 'RPS', 'group-by', 'field=status');
    expect(byStatus.values[0].query).toBe(
      `track = "RPS" AND status = "${byStatus.values[0].name}"`,
    );
    const byPerson = await statistic('member', 'RPS', 'group-by', 'field=assignee');
    const member = (byPerson.values as (Value & { query: string })[]).find(
      (v) => v.id === String(users.member.id),
    );
    expect(member?.query).toBe(`track = "RPS" AND assignee = ${users.member.id}`);
  });

  it('[RPT-002] workload by person, of a release and as a pie: each sum is over a search', async () => {
    const open = `${BASE} AND stage != closed`;
    for (const who of viewers) {
      for (const [params, base] of [
        ['field=assignee', open],
        [
          `field=assignee&release=${release.id}`,
          `${open} AND targetRelease = ${quoted(release.name)}`,
        ],
        ['field=labels&statistic=timeSpent&open=false&view=pie', BASE],
        ['field=priority&statistic=originalEstimate&open=false', BASE],
      ] as const) {
        const data = await statistic(who, 'RPS', 'workload', params);
        const column =
          data.statistic === 'timeSpent'
            ? 'time_spent'
            : data.statistic === 'originalEstimate'
              ? 'original_estimate'
              : 'remaining_estimate';
        const all = await sumOf(who, base, column);
        expect(all.seconds, `${who} ${params}`).toBeGreaterThan(0);
        expect(data.total, `${who} ${params}`).toBe(await count(who, base));
        expect(data.seconds, `${who} ${params} seconds`).toBe(all.seconds);
        expect(data.unestimated, `${who} ${params} unestimated`).toBe(
          column === 'time_spent' ? 0 : all.empty,
        );
        const field = /field=(\w+)/.exec(params)?.[1] as string;
        for (const v of data.values as (Value & { seconds: number; unestimated: number })[]) {
          const q = valueQuery(base, field, v);
          const one = await sumOf(who, q, column);
          expect(v.total, `${who} ${q}`).toBe(await count(who, q));
          expect(v.seconds, `${who} ${q} seconds`).toBe(one.seconds);
        }
      }
    }
  });

  it('[RPT-002] time tracking: the totals are the searches’ and time spent is the sum of the time entries', async () => {
    for (const who of viewers) {
      for (const [params, q] of [
        ['', BASE],
        [`release=${release.id}`, `${BASE} AND targetRelease = ${quoted(release.name)}`],
      ] as const) {
        const data = await statistic(who, 'RPS', 'time-tracking', params);
        const ids = await found(who, q);
        expect(data.tickets, `${who} ${q}`).toBe(ids.length);
        expect(data.original).toBe((await sumOf(who, q, 'original_estimate')).seconds);
        expect(data.remaining).toBe((await sumOf(who, q, 'remaining_estimate')).seconds);
        const entries = await sql<{ s: number }>`
          SELECT coalesce(sum(duration), 0)::float8 AS s FROM time_entry
           WHERE ticket_id = ANY(${ids}::int[])`.execute(database.db);
        expect(data.spent, `${who} ${q} spent`).toBe(entries.rows[0]?.s);
        expect(data.estimated).toBe(ids.length - (await sumOf(who, q, 'original_estimate')).empty);
        for (const row of data.rows as { id: number }[]) expect(ids).toContain(row.id);
      }
    }
    await sql`UPDATE time_tracking_setting SET enabled = false`.execute(database.db);
    try {
      expect(await statistic('member', 'RPS', 'time-tracking')).toEqual({
        unavailable: 'time_tracking_off',
      });
    } finally {
      await sql`UPDATE time_tracking_setting SET enabled = true`.execute(database.db);
    }
  });

  it('[RPT-001] the outcome report counts the tickets under it as searches do, day by day', async () => {
    for (const who of viewers) {
      const report = await call(who, {
        method: 'GET',
        url: `/api/v1/boards/${scrumBoard}/reports/outcome-report?outcome=${outcomeKey}`,
      });
      const under = `parent = ${outcomeKey}`;
      expect(report.outcome.key).toBe(outcomeKey);
      expect(report.counts.done + report.counts.open, who).toBe(await count(who, under));
      expect(report.counts.done, who).toBe(await count(who, `${under} AND stage = closed`));
      expect(report.tickets.map((t: { id: number }) => t.id).sort()).toEqual(
        (await found(who, under)).sort(),
      );
      const last = report.days.at(-1);
      const value = report.tickets.reduce((s: number, t: { value: number }) => s + t.value, 0);
      expect(last.scope).toBe(value);
    }
    // Kanban boards have no outcome report, as no other report that follows sprints.
    const kanban = (await call('member', { method: 'GET', url: '/api/v1/tracks/RPK/board' })).board
      .id;
    await call(
      'member',
      {
        method: 'GET',
        url: `/api/v1/boards/${kanban}/reports/outcome-report?outcome=${outcomeKey}`,
      },
      409,
    );
    await call(
      'member',
      { method: 'GET', url: `/api/v1/boards/${scrumBoard}/reports/outcome-report?outcome=RPS-999` },
      404,
    );
  });

  it('[CORE-002] [RPT-002] a Kanban track reads every report that needs no sprint', async () => {
    const base = 'track = RPK';
    for (const [kind, params] of [
      ['created-vs-closed', 'days=7'],
      ['time-since', 'field=created&days=7'],
      ['pie', 'field=assignee'],
      ['group-by', 'field=assignee'],
      ['workload', 'field=assignee'],
      ['time-tracking', ''],
    ] as const) {
      const data = await statistic('member', 'RPK', kind, params);
      expect(data, kind).not.toHaveProperty('unavailable');
    }
    expect((await statistic('member', 'RPK', 'group-by', 'field=assignee')).total).toBe(
      await count('member', base),
    );
    const work = await statistic('member', 'RPK', 'workload', 'field=assignee');
    expect(work.total).toBe(await count('member', `${base} AND stage != closed`));
    expect(work.seconds).toBe(2 * H);
  });

  it('[RPT-006] a Summary widget with no query reads exactly what the report of its kind reads', async () => {
    const widgets = [
      { kind: 'time-since', config: { field: 'due', days: 14 } },
      { kind: 'group-by', config: { field: 'assignee' } },
      { kind: 'workload', config: { field: 'assignee' } },
      { kind: 'time-tracking', config: {} },
      { kind: 'pie', config: { field: 'priority' } },
    ];
    const saved = await call('admin', {
      method: 'PUT',
      url: '/api/v1/tracks/RPS/summary-layout',
      payload: {
        layout: 'two',
        widgets: widgets.map((w) => ({ ...w, config: { query: '', ...w.config } })),
      },
    });
    for (const who of viewers) {
      for (const [i, w] of (saved.custom.widgets as { id: string; kind: string }[]).entries()) {
        const read = (
          await call(who, {
            method: 'GET',
            url: `/api/v1/tracks/RPS/summary-layout/widgets/${w.id}`,
          })
        ).data;
        const config = widgets[i]?.config as Record<string, string | number>;
        const params = new URLSearchParams(
          Object.entries(config).map(([k, v]) => [k, String(v)]),
        ).toString();
        expect(read, `${who} ${w.kind}`).toEqual(await statistic(who, 'RPS', w.kind, params));
      }
    }
  });

  // Every gate reads a track of 10,000 tickets; TASKMOOR_LARGE_TRACK_REPORTS=1 reads 100,000.
  const LARGE = Boolean(process.env.TASKMOOR_LARGE_TRACK_REPORTS);
  const TICKETS = LARGE ? 100_000 : 10_000;
  const SIZE = TICKETS.toLocaleString('en');

  it(`[RPT-002] [RPT-006] reads each report and the Summary within budget on a track of ${SIZE} tickets`, async () => {
    const id = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'BIG', name: 'Big', mode: 'shared' },
        },
        201,
      )
    ).track.id as number;
    const role = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({ workspace_id: 1, track_id: id, role_id: role.id, user_id: users.member.id })
      .execute();
    const statuses = await database.db
      .selectFrom('status')
      .select(['id', 'stage'])
      .orderBy('id')
      .execute();
    const status = (stage: string) => statuses.find((s) => s.stage === stage)?.id as number;
    const type = (
      (await call('admin', { method: 'GET', url: '/api/v1/tracks/BIG/ticket-types' }))
        .ticketTypes as {
        id: number;
        level: { rank: number };
      }[]
    ).find((t) => t.level.rank === 0)?.id as number;
    const priorities = await database.db.selectFrom('priority').select('id').execute();
    const reason = await database.db
      .selectFrom('close_reason')
      .select('id')
      .executeTakeFirstOrThrow();
    // Over the last 180 days: every fourth ticket closed (with its history), three assignees and
    // none, the priorities in turn, labels, due dates, estimates and time spent.
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, assignee_id, priority_id, labels, due_date,
                          original_estimate, remaining_estimate, time_spent, close_reason_id,
                          created_at, updated_at, closed_at)
      SELECT 1, ${id}::int, g, ${type}::int,
             CASE WHEN g % 4 = 0 THEN ${status('closed')}::int
                  WHEN g % 4 = 1 THEN ${status('active')}::int ELSE ${status('new')}::int END,
             'Big ' || g, ${users.admin.id}::int, 'zbig' || lpad(g::text, 7, '0'),
             (ARRAY[${users.member.id}::int, ${users.manager.id}::int, ${users.admin.id}::int, NULL])[1 + g % 4],
             (${priorities.map((p) => p.id)}::int[])[1 + g % ${priorities.length}::int],
             CASE g % 3 WHEN 0 THEN ARRAY['web'] WHEN 1 THEN ARRAY['web', 'api']
                        ELSE ARRAY[]::text[] END,
             (now() - (g % 60) * interval '1 day')::date,
             CASE WHEN g % 5 = 0 THEN NULL ELSE 3600 * (1 + g % 8) END,
             CASE WHEN g % 4 = 0 THEN 0 ELSE 1800 * (g % 6) END,
             900 * (g % 7),
             CASE WHEN g % 4 = 0 THEN ${reason.id}::int END,
             now() - (g % 180) * interval '1 day' - interval '3 hours',
             now() - (g % 90) * interval '1 day' - interval '2 hours',
             CASE WHEN g % 4 = 0 THEN now() - (g % 90) * interval '1 day' - interval '2 hours' END
        FROM generate_series(1, ${TICKETS}::int) g`.execute(database.db);
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value)
      SELECT 1, k.id, nextval('ticket_change_set_seq'), k.closed_at, ${users.admin.id}::int, 'closeReason',
             NULL, ${String(reason.id)}
        FROM ticket k WHERE k.track_id = ${id}::int AND k.closed_at IS NOT NULL`.execute(
      database.db,
    );
    await sql`UPDATE ticket_counter SET last_number = ${TICKETS}::int WHERE track_id = ${id}::int`.execute(
      database.db,
    );
    await sql`ANALYZE`.execute(database.db);

    const reads: [string, string][] = [
      ['/summary', ''],
      ['/statistics/created-vs-closed', 'days=90&period=week'],
      ['/statistics/recently-created', 'days=90'],
      ['/statistics/average-age', 'days=90&period=week'],
      ['/statistics/time-to-close', 'days=90&period=week'],
      ['/statistics/time-since', 'field=due&days=90'],
      ['/statistics/pie', 'field=assignee'],
      ['/statistics/ticket-statistics', 'field=priority'],
      ['/statistics/two-dimensional', 'x=status&y=labels'],
      ['/statistics/group-by', 'field=assignee'],
      ['/statistics/workload', 'field=assignee'],
      ['/statistics/workload', 'field=labels&statistic=timeSpent&open=false&view=pie'],
      ['/statistics/time-tracking', ''],
    ];
    for (const [path, params] of reads) {
      const times: number[] = [];
      for (let i = 0; i < 4; i++) {
        const started = performance.now();
        const res = await as('member', {
          method: 'GET',
          url: `/api/v1/tracks/BIG${path}${params ? `?${params}` : ''}`,
        });
        // The first read warms the caches; the next three are measured.
        if (i > 0) times.push(performance.now() - started);
        expect(res.statusCode, `${path}: ${res.body}`).toBe(200);
      }
      times.sort((a, b) => a - b);
      expectWithinBudget(
        times[1] as number,
        1000,
        `track ${path}${params ? `?${params}` : ''}, ${SIZE} tickets, median (ms)`,
      );
    }
    const grouped = await statistic('member', 'BIG', 'group-by', 'field=assignee');
    expect(grouped.total).toBe(TICKETS);
  }, 600_000);
});
