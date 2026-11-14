import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb, type Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { type Kysely, sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { storesOf } from '../attachments/stores';
import { exportAudit, searchAudit } from '../audit/query';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { folderSink } from '../export/sinks';
import { registerEraseJobs } from '../privacy/erase';
import { writePersonalData } from '../privacy/export';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-capacity-${randomBytes(18).toString('base64url')}`;
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

interface Work {
  count: number;
  amount: number;
  unestimated: number;
}
interface Cell extends Work {
  elsewhere: { count: number; amount: number };
  load: number;
  over: boolean;
}
interface CapacityOf {
  default: { amount: number; note: string } | null;
  periods: { amount: number | null; note: string; from: string | null }[];
}
interface Person {
  id: number;
  name: string;
  clause: string;
  capacity: CapacityOf;
  cells: Cell[];
  unscheduled: Work;
}
interface Answer {
  query: string | null;
  editable: boolean;
  unit: 'points' | 'hours';
  pointsField: { id: number; name: string } | null;
  periods: { start: string; end: string; clause: string }[];
  previous: string;
  next: string;
  unscheduledClause: string;
  teams: (Person & { members: Person[] })[];
  unassigned: { clause: string; cells: Work[]; unscheduled: Work };
  others: { clause: string; cells: Work[]; unscheduled: Work };
}

/**
 * Teams and capacity in a Multi-track plan (T-089b; PLN-005, PLN-009; ADR-122 stage 3). A plan
 * over CPA and CPB plans with Web (Ana and Bo) and Ops (Cy), in two-week periods from Monday
 * 2027-03-01, in points. Ana works in CPA, CPB and CPC (not in the plan); Bo sees CPA only. The
 * admin, in no team, has a CPA ticket too, and one is unassigned. Web may take 20 points a
 * period, Ana 10, and none in the second period (leave).
 */
describe('teams and capacity in a plan (PLN-005, PLN-009)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const teams: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let planId = 0;
  let points = 0;

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
  const capacity = async (who: string, query = '?from=2027-03-01&periods=2') => {
    const res = await as(who, { method: 'GET', url: `/api/v1/plans/${planId}/capacity${query}` });
    expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
    return { body: res.body, answer: res.json() as Answer };
  };
  const setCapacity = (who: string, entries: Record<string, unknown>[], code = 200) =>
    call(
      who,
      { method: 'PUT', url: `/api/v1/plans/${planId}/capacity`, payload: { entries } },
      code,
    );
  /** The tickets a search finds as that person: how many, and the sum of their points. */
  const searched = async (who: string, q: string) => {
    const found = await call(who, {
      method: 'POST',
      url: '/api/v1/search',
      payload: { q, count: true, limit: 200 },
    });
    const ids = (found.tickets as { id: number }[]).map((x) => x.id);
    const rows =
      ids.length === 0
        ? []
        : await database.db.selectFrom('ticket').select('fields').where('id', 'in', ids).execute();
    const sum = rows.reduce((s, r) => {
      const v = (r.fields as Record<string, unknown>)[String(points)];
      return s + (typeof v === 'number' ? v : 0);
    }, 0);
    return { count: found.total.count as number, amount: sum };
  };
  const ticket = async (track: string, summary: string, data: Record<string, unknown> = {}) =>
    (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/tickets', payload: { track, summary, ...data } },
        201,
      )
    ).ticket as { id: number; key: string };
  const pts = (n: number) => ({ fields: { [String(points)]: n } });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
      ['bo', false],
      ['cy', false],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name[0]?.toUpperCase() + name.slice(1),
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
      ['CPA', 'Apps'],
      ['CPB', 'Billing'],
      ['CPC', 'Core'],
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
    for (const [who, keys] of [
      ['ana', ['CPA', 'CPB', 'CPC']],
      ['bo', ['CPA']],
      ['cy', ['CPA']],
    ] as const) {
      for (const key of keys) {
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
    points = (
      await database.db
        .selectFrom('field')
        .select('id')
        .where('name', '=', 'Points')
        .where('track_id', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
    for (const [name, people] of [
      ['Web', ['ana', 'bo']],
      ['Ops', ['cy']],
    ] as const) {
      teams[name] = (
        await call('admin', { method: 'POST', url: '/api/v1/teams', payload: { name } }, 201)
      ).team.id;
      for (const who of people) {
        await call(
          'admin',
          { method: 'PUT', url: `/api/v1/teams/${teams[name]}/members/${users[who]?.id}` },
          204,
        );
      }
    }
    const ana = users.ana?.id;
    const bo = users.bo?.id;
    t.a1 = await ticket('CPA', 'Shop page', { assigneeId: ana, dueDate: '2027-03-05', ...pts(5) });
    t.a2 = await ticket('CPA', 'Cart', { assigneeId: ana, dueDate: '2027-03-12', ...pts(3) });
    t.a3 = await ticket('CPA', 'Unestimated', { assigneeId: ana, dueDate: '2027-03-16' });
    t.b1 = await ticket('CPB', 'Invoice run', {
      assigneeId: ana,
      dueDate: '2027-03-10',
      ...pts(8),
    });
    t.c1 = await ticket('CPC', 'Secret core work', {
      assigneeId: ana,
      dueDate: '2027-03-11',
      ...pts(13),
    });
    t.o1 = await ticket('CPA', 'Bo’s fix', { assigneeId: bo, dueDate: '2027-03-03', ...pts(2) });
    t.u1 = await ticket('CPA', 'Nobody’s', { dueDate: '2027-03-04', ...pts(1) });
    t.x1 = await ticket('CPA', 'Admin’s', {
      assigneeId: users.admin?.id,
      dueDate: '2027-03-06',
      ...pts(4),
    });
    t.n1 = await ticket('CPA', 'Someday', { assigneeId: ana, ...pts(2) });
    t.later = await ticket('CPA', 'Far away', {
      assigneeId: ana,
      dueDate: '2027-06-01',
      ...pts(7),
    });
    t.binned = await ticket('CPA', 'Binned', {
      assigneeId: ana,
      dueDate: '2027-03-05',
      ...pts(50),
    });
    await database.db
      .updateTable('ticket')
      .set({ deleted_at: new Date() })
      .where('id', '=', t.binned.id)
      .execute();
    planId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: {
            name: 'Delivery',
            sources: [
              { kind: 'track', trackId: tracks.CPA },
              { kind: 'track', trackId: tracks.CPB },
            ],
            shares: [{ scope: 'any_user' }],
          },
        },
        201,
      )
    ).plan.id;
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-005] plans with site teams in periods and units its editors choose, each change one event', async () => {
    const changed = await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: {
        teams: [teams.Web, teams.Ops],
        capacityUnit: 'points',
        period: { kind: 'weeks', weeks: 2, anchor: '2027-03-01' },
      },
    });
    expect(changed.plan).toMatchObject({
      capacityUnit: 'points',
      period: { kind: 'weeks', weeks: 2, anchor: '2027-03-01' },
      teams: [
        { id: teams.Web, name: 'Web' },
        { id: teams.Ops, name: 'Ops' },
      ],
    });
    const event = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', '=', 'plan.updated')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect((event.payload as { changes: Record<string, unknown> }).changes).toEqual({
      teams: { from: [], to: [teams.Web, teams.Ops] },
      period: {
        from: { kind: 'weeks', weeks: 2, anchor: '2024-01-01' },
        to: { kind: 'weeks', weeks: 2, anchor: '2027-03-01' },
      },
    });
    // Others read the settings, never change them; a team the site does not have is refused.
    expect(
      (await call('bo', { method: 'GET', url: `/api/v1/plans/${planId}` })).plan.teams,
    ).toHaveLength(2);
    await call(
      'bo',
      { method: 'PATCH', url: `/api/v1/plans/${planId}`, payload: { teams: [] } },
      403,
    );
    const refused = await call(
      'admin',
      { method: 'PATCH', url: `/api/v1/plans/${planId}`, payload: { teams: [999_999] } },
      400,
    );
    expect(refused.fields).toEqual({ 'teams.0': 'not_found' });
    await call(
      'admin',
      {
        method: 'PATCH',
        url: `/api/v1/plans/${planId}`,
        payload: { period: { kind: 'weeks', weeks: 7, anchor: '2027-03-01' } },
      },
      400,
    );
  });

  it('[PLN-009] sets capacity per team and per person, for every period or one, with notes', async () => {
    await setCapacity('admin', [
      { teamId: teams.Web, period: null, amount: 20 },
      { userId: users.ana?.id, period: null, amount: 10 },
      { userId: users.ana?.id, period: '2027-03-15', amount: 0, note: 'Leave' },
    ]);
    const event = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload', 'subject_type'])
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.type).toBe('plan.capacity_set');
    expect(event.payload).toEqual({
      changes: [
        { subject: `team:${teams.Web}`, period: null, from: null, to: { amount: 20, note: '' } },
        {
          subject: `user:${users.ana?.id}`,
          period: null,
          from: null,
          to: { amount: 10, note: '' },
        },
        {
          subject: `user:${users.ana?.id}`,
          period: '2027-03-15',
          from: null,
          to: { amount: 0, note: 'Leave' },
        },
      ],
    });
    // Setting the same again changes nothing and records nothing.
    const before = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.max('id').as('max'))
      .executeTakeFirstOrThrow();
    expect(await setCapacity('admin', [{ teamId: teams.Web, period: null, amount: 20 }])).toEqual({
      changed: 0,
    });
    const after = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.max('id').as('max'))
      .executeTakeFirstOrThrow();
    expect(after.max).toBe(before.max);
    // Only the plan's editors; only its teams and their members; only first days of periods.
    await setCapacity('bo', [{ userId: users.bo?.id, period: null, amount: 5 }], 403);
    const shape = await setCapacity(
      'admin',
      [{ teamId: teams.Web, period: null, amount: 1.234 }],
      400,
    );
    expect(shape.fields).toEqual({ 'entries.0.amount': 'at most two decimals' });
    const refused = await setCapacity(
      'admin',
      [
        { userId: users.admin?.id, period: null, amount: 5 },
        { teamId: teams.Web, period: '2027-03-02', amount: 5 },
        { teamId: teams.Web, period: '2027-03-15', amount: 5 },
        { teamId: teams.Web, period: '2027-03-15', amount: 6 },
      ],
      400,
    );
    expect(refused.fields).toEqual({
      'entries.0.userId': 'not_in_plan',
      'entries.1.period': 'not_a_period_start',
      entries: 'duplicate',
    });
  });

  it('[PLN-005] counts each person’s and team’s work per period against capacity, over capacity flagged', async () => {
    const { answer } = await capacity('ana');
    expect(answer.unit).toBe('points');
    expect(answer.pointsField?.id).toBe(points);
    expect(answer.periods.map((p) => [p.start, p.end])).toEqual([
      ['2027-03-01', '2027-03-14'],
      ['2027-03-15', '2027-03-28'],
    ]);
    expect(answer.previous).toBe('2027-02-01');
    expect(answer.next).toBe('2027-03-29');
    const [web, ops] = answer.teams;
    const ana = web?.members.find((m) => m.id === users.ana?.id);
    const bo = web?.members.find((m) => m.id === users.bo?.id);
    // Ana: the shop page, the cart and the invoice run (16 points) in the plan, and 13 points of
    // core work elsewhere, against 10: over. On leave in the second period, with nothing due but
    // an unestimated ticket: not over.
    expect(ana?.cells[0]).toEqual({
      count: 3,
      amount: 16,
      unestimated: 0,
      elsewhere: { count: 1, amount: 13 },
      load: 29,
      over: true,
    });
    expect(ana?.capacity.periods).toEqual([
      { amount: 10, note: '', from: 'default' },
      { amount: 0, note: 'Leave', from: 'period' },
    ]);
    expect(ana?.cells[1]).toMatchObject({ count: 1, amount: 0, unestimated: 1, over: false });
    expect(ana?.unscheduled).toEqual({ count: 1, amount: 2, unestimated: 0 });
    // Bo has no capacity of his own, so nothing is over for him.
    expect(bo?.cells[0]).toMatchObject({ count: 1, amount: 2, over: false });
    expect(bo?.capacity.periods[0]).toEqual({ amount: null, note: '', from: null });
    // Web: its members' work (18 points here, 13 elsewhere) against its own 20.
    expect(web?.cells[0]).toMatchObject({ count: 4, amount: 18, load: 31, over: true });
    expect(web?.capacity.periods[0]).toEqual({ amount: 20, note: '', from: 'default' });
    // Ops has no capacity and its member none either.
    expect(ops?.capacity.periods[0]?.amount).toBeNull();
    expect(ops?.cells[0]).toMatchObject({ count: 0, over: false });
    // Unassigned work, and the admin's, who is in none of the teams.
    expect(answer.unassigned.cells[0]).toEqual({ count: 1, amount: 1, unestimated: 0 });
    expect(answer.others.cells[0]).toEqual({ count: 1, amount: 4, unestimated: 0 });
    // Neither the trash (50 points) nor work due after the periods (7) counts: 16 above.
  });

  it('[PLN-005] makes every number equal the search it links to, for each viewer', async () => {
    for (const who of ['ana', 'bo', 'admin']) {
      const { answer } = await capacity(who);
      const rows = [
        ...answer.teams.flatMap((team) => [team, ...team.members]),
        answer.unassigned,
        answer.others,
      ];
      for (const row of rows) {
        for (const [i, period] of answer.periods.entries()) {
          const q = `(${answer.query}) AND ${row.clause} AND ${period.clause}`;
          const cell = row.cells[i] as Work;
          expect(await searched(who, q), `${who}: ${q}`).toEqual({
            count: cell.count,
            amount: cell.amount,
          });
        }
        const q = `(${answer.query}) AND ${row.clause} AND ${answer.unscheduledClause}`;
        expect(await searched(who, q), `${who}: ${q}`).toEqual({
          count: row.unscheduled.count,
          amount: row.unscheduled.amount,
        });
      }
    }
  });

  it('[PLN-009] counts work hidden from the viewer in a total, never naming it', async () => {
    const { body, answer } = await capacity('bo');
    const ana = answer.teams[0]?.members.find((m) => m.id === users.ana?.id);
    // Bo sees only CPA: the invoice run (CPB, hidden from him) joins the core work elsewhere.
    expect(ana?.cells[0]).toEqual({
      count: 2,
      amount: 8,
      unestimated: 0,
      elsewhere: { count: 2, amount: 21 },
      load: 29,
      over: true,
    });
    // The same load as Ana sees: hidden work still counts against her capacity.
    expect(ana?.cells[0]?.load).toBe(
      (await capacity('ana')).answer.teams[0]?.members[0]?.cells[0]?.load,
    );
    for (const hidden of [t.b1, t.c1]) {
      expect(body).not.toContain(hidden?.key);
    }
    expect(body).not.toContain('Invoice run');
    expect(body).not.toContain('Secret core work');
    expect(body).not.toContain('CPB');
    expect(answer.editable).toBe(false);
  });

  it('[PLN-005] narrows the plan’s work with the filters; what they leave out counts elsewhere', async () => {
    const { answer } = await capacity('ana', `?from=2027-03-01&periods=2&track=CPA`);
    const ana = answer.teams[0]?.members.find((m) => m.id === users.ana?.id);
    expect(ana?.cells[0]).toMatchObject({
      count: 2,
      amount: 8,
      elsewhere: { count: 2, amount: 21 },
      load: 29,
    });
    expect(answer.query).toContain('track = "CPA"');
    // A window anywhere: the period holding the day comes first, at most 12 periods.
    const later = (await capacity('ana', '?from=2027-03-20&periods=1')).answer;
    expect(later.periods).toEqual([
      {
        start: '2027-03-15',
        end: '2027-03-28',
        clause: 'due >= "2027-03-15" AND due <= "2027-03-28"',
      },
    ]);
    const res = await as('ana', {
      method: 'GET',
      url: `/api/v1/plans/${planId}/capacity?periods=13`,
    });
    expect(res.statusCode).toBe(400);
  });

  it('[PLN-005] gives a team its members’ capacity when it has none, and months as periods', async () => {
    await setCapacity('admin', [{ userId: users.cy?.id, period: null, amount: 6 }]);
    const ops = (await capacity('admin')).answer.teams[1];
    expect(ops?.capacity.periods[0]).toEqual({ amount: 6, note: '', from: 'members' });
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { period: { kind: 'month' } },
    });
    const months = (await capacity('admin', '?from=2027-02-14&periods=2')).answer;
    expect(months.periods.map((p) => [p.start, p.end])).toEqual([
      ['2027-02-01', '2027-02-28'],
      ['2027-03-01', '2027-03-31'],
    ]);
    // A period's own capacity belonged to the old periods: cleared, and the event says so.
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'plan.updated')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect((event.payload as { changes: Record<string, unknown> }).changes).toMatchObject({
      period: { to: { kind: 'month' } },
      capacityCleared: { from: 1, to: 0 },
    });
    const ana = months.teams[0]?.members.find((m) => m.id === users.ana?.id);
    expect(ana?.capacity.periods.map((p) => p.from)).toEqual(['default', 'default']);
    expect(ana?.cells[1]).toMatchObject({ count: 4, amount: 16, unestimated: 1 });
  });

  it('[PLN-005] counts hours from the original estimate; a new unit clears every capacity', async () => {
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.a1?.key}`,
      payload: { originalEstimate: '6h' },
    });
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { capacityUnit: 'hours' },
    });
    const { answer } = await capacity('admin', '?from=2027-03-01&periods=1');
    expect(answer.unit).toBe('hours');
    const ana = answer.teams[0]?.members.find((m) => m.id === users.ana?.id);
    expect(ana?.cells[0]).toMatchObject({ count: 4, amount: 6, unestimated: 3 });
    expect(ana?.capacity.default).toBeNull();
    expect(answer.teams[0]?.capacity.default).toBeNull();
  });

  it('[PLN-005] takes capacity away with a team that leaves the plan', async () => {
    await setCapacity('admin', [
      { teamId: teams.Ops, period: null, amount: 9 },
      { userId: users.cy?.id, period: null, amount: 3 },
    ]);
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { teams: [teams.Web] },
    });
    const left = await database.db
      .selectFrom('plan_capacity')
      .select(['team_id', 'user_id'])
      .where('plan_id', '=', planId)
      .execute();
    expect(left).toEqual([]);
    const { answer } = await capacity('admin');
    expect(answer.teams.map((x) => x.name)).toEqual(['Web']);
    expect(answer.others.clause).toBe(`assignee NOT IN membersOf("id:${teams.Web}")`);
  });

  it('[PLN-005] keeps single periods when the anchor moves by whole periods; an empty team counts nothing', async () => {
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { period: { kind: 'weeks', weeks: 2, anchor: '2027-03-01' } },
    });
    await setCapacity('admin', [
      { userId: users.ana?.id, period: '2027-03-15', amount: 1, note: 'Half' },
    ]);
    // Four weeks later: the same periods, so the period's own capacity stays.
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { period: { kind: 'weeks', weeks: 2, anchor: '2027-03-29' } },
    });
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'plan.updated')
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect((event.payload as { changes: Record<string, unknown> }).changes).toEqual({
      period: {
        from: { kind: 'weeks', weeks: 2, anchor: '2027-03-01' },
        to: { kind: 'weeks', weeks: 2, anchor: '2027-03-29' },
      },
    });
    const kept = (await capacity('admin')).answer.teams[0]?.members.find(
      (m) => m.id === users.ana?.id,
    );
    expect(kept?.capacity.periods[1]).toEqual({ amount: 1, note: 'Half', from: 'period' });

    // A team with nobody in it has no work, and its search finds none; nor does anyone's
    // work move out of "everyone else" for it.
    const empty = (
      await call('admin', { method: 'POST', url: '/api/v1/teams', payload: { name: 'Empty' } }, 201)
    ).team.id as number;
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${planId}`,
      payload: { teams: [teams.Web, empty] },
    });
    const { answer } = await capacity('admin');
    const none = answer.teams.find((x) => x.id === empty);
    expect(none?.members).toEqual([]);
    expect(none?.cells.map((c) => c.count)).toEqual([0, 0]);
    for (const row of [none, answer.others]) {
      for (const [i, period] of answer.periods.entries()) {
        const q = `(${answer.query}) AND ${row?.clause} AND ${period.clause}`;
        expect((await searched('admin', q)).count, q).toBe(row?.cells[i]?.count);
      }
    }
  });

  it('[PLN-009] never narrows hidden work below a week, however the periods are set', async () => {
    // Bo sees only CPA. His own plan over it plans with Web (Ana is in it), so Ana's invoice run
    // (CPB, 8 points, Wednesday 2027-03-10) and core work (CPC, 13, Thursday 2027-03-11) are
    // work elsewhere he may not see. Moving one-week periods a day at a time must not tell them
    // apart: the week of 2027-03-08 counts whole, in the period that holds its Thursday.
    const own = (
      await call(
        'bo',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: { name: 'Bo’s', sources: [{ kind: 'track', trackId: tracks.CPA }] },
        },
        201,
      )
    ).plan.id as number;
    await call('bo', {
      method: 'PATCH',
      url: `/api/v1/plans/${own}`,
      payload: { teams: [teams.Web], period: { kind: 'weeks', weeks: 1, anchor: '2027-03-08' } },
    });
    const elsewhereOf = async (from: string, periods: number) => {
      const res = await as('bo', {
        method: 'GET',
        url: `/api/v1/plans/${own}/capacity?from=${from}&periods=${periods}`,
      });
      expect(res.statusCode, res.body.slice(0, 400)).toBe(200);
      const answer = res.json() as Answer;
      const ana = answer.teams[0]?.members.find((m) => m.id === users.ana?.id);
      return {
        periods: answer.periods.map((p) => p.start),
        elsewhere: ana?.cells.map((c) => c.elsewhere) ?? [],
      };
    };
    expect((await elsewhereOf('2027-03-08', 1)).elsewhere).toEqual([{ count: 2, amount: 21 }]);
    for (let day = 4; day <= 17; day++) {
      const anchor = `2027-03-${String(day).padStart(2, '0')}`;
      for (const weeks of [1, 2]) {
        await call('bo', {
          method: 'PATCH',
          url: `/api/v1/plans/${own}`,
          payload: { period: { kind: 'weeks', weeks, anchor } },
        });
        const seen = await elsewhereOf('2027-02-22', 6);
        const holding = seen.elsewhere.filter((e) => e.count > 0);
        expect(holding, `${weeks} weeks from ${anchor}`).toEqual([{ count: 2, amount: 21 }]);
      }
    }
    // A week across two months counts whole in the month that holds most of it: Ana's work due
    // Monday 2027-05-31 and Tuesday 2027-06-01, hidden from Bo, both in June (Thursday June 3).
    await ticket('CPC', 'Month end', {
      assigneeId: users.ana?.id,
      dueDate: '2027-05-31',
      ...pts(1),
    });
    await ticket('CPC', 'Month start', {
      assigneeId: users.ana?.id,
      dueDate: '2027-06-01',
      ...pts(2),
    });
    await call('bo', {
      method: 'PATCH',
      url: `/api/v1/plans/${own}`,
      payload: { period: { kind: 'month' } },
    });
    const months = await elsewhereOf('2027-05-01', 2);
    expect(months).toEqual({
      periods: ['2027-05-01', '2027-06-01'],
      elsewhere: [
        { count: 0, amount: 0 },
        { count: 2, amount: 3 },
      ],
    });
  });

  it('[PLN-009] refuses amounts typed for a unit or periods the plan no longer has', async () => {
    const plan = (await call('admin', { method: 'GET', url: `/api/v1/plans/${planId}` })).plan;
    expect(plan).toMatchObject({
      capacityUnit: 'hours',
      period: { kind: 'weeks', weeks: 2, anchor: '2027-03-29' },
    });
    const put = (body: Record<string, unknown>, code: number) =>
      call(
        'admin',
        {
          method: 'PUT',
          url: `/api/v1/plans/${planId}/capacity`,
          payload: { entries: [{ userId: users.ana?.id, period: null, amount: 30 }], ...body },
        },
        code,
      );
    // 30 typed as points while the plan counts hours: nothing set, the settings it has now.
    expect(await put({ unit: 'points' }, 409)).toEqual({
      error: 'settings_changed',
      unit: 'hours',
      period: { kind: 'weeks', weeks: 2, anchor: '2027-03-29' },
    });
    expect(
      await put({ unit: 'hours', period: { kind: 'weeks', weeks: 1, anchor: '2027-03-29' } }, 409),
    ).toMatchObject({ error: 'settings_changed' });
    const rows = () =>
      database.db
        .selectFrom('plan_capacity')
        .select(['amount'])
        .where('plan_id', '=', planId)
        .where('user_id', '=', users.ana?.id as number)
        .where('period_start', 'is', null)
        .execute();
    expect(await rows()).toEqual([]);
    // An anchor whole periods away makes the same periods.
    expect(
      await put({ unit: 'hours', period: { kind: 'weeks', weeks: 2, anchor: '2027-03-01' } }, 200),
    ).toEqual({ changed: 1 });
    expect((await rows()).map((r) => Number(r.amount))).toEqual([30]);
  });

  describe('while the plan’s settings change (PLN-005, PLN-009)', () => {
    let side: Kysely<Database>;
    beforeAll(() => {
      side = createDb({ connectionString: database.url, maxConnections: 2 });
    });
    afterAll(async () => {
      await side.destroy();
    });

    /** Until a session of the database waits on a row's lock. */
    async function untilWaiting() {
      for (let tries = 0; tries < 200; tries++) {
        const { rows } = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE datname = current_database() AND wait_event_type = 'Lock'
             AND wait_event IN ('transactionid', 'tuple')`.execute(side);
        if ((rows[0]?.n ?? 0) >= 1) return;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error('nobody waits on the plan’s row');
    }

    /**
     * A change of capacity sent while a change of the plan holds its row (as `PATCH` does), the
     * change of the plan made and committed only once the capacity waits for it.
     */
    async function racing(
      entries: Record<string, unknown>[],
      extra: Record<string, unknown>,
      change: (trx: Transaction<Database>) => Promise<unknown>,
    ) {
      let putting: Promise<{ statusCode: number; body: string }> | undefined;
      await side.transaction().execute(async (trx) => {
        await trx.selectFrom('plan').select('id').where('id', '=', planId).forUpdate().execute();
        putting = as('admin', {
          method: 'PUT',
          url: `/api/v1/plans/${planId}/capacity`,
          payload: { entries, ...extra },
        }).then((res) => res);
        await untilWaiting();
        await change(trx);
      });
      return (await putting) as { statusCode: number; body: string };
    }
    const rowsOf = (userId: number) =>
      database.db
        .selectFrom('plan_capacity')
        .select(['team_id', 'amount'])
        .where('plan_id', '=', planId)
        .where('user_id', '=', userId)
        .execute();

    it('[PLN-005] sets no capacity for someone whose team left the plan meanwhile', async () => {
      await call('admin', {
        method: 'PATCH',
        url: `/api/v1/plans/${planId}`,
        payload: { teams: [teams.Web, teams.Ops] },
      });
      const cy = users.cy?.id as number;
      // Cy is in Ops; a site administrator takes Ops out of the plan while the owner saves.
      const res = await racing([{ userId: cy, period: null, amount: 3 }], {}, (trx) =>
        trx
          .deleteFrom('plan_team')
          .where('plan_id', '=', planId)
          .where('team_id', '=', teams.Ops as number)
          .execute(),
      );
      expect(res.statusCode, res.body).toBe(400);
      expect(JSON.parse(res.body)).toEqual({
        error: 'invalid_fields',
        fields: { 'entries.0.userId': 'not_in_plan' },
      });
      expect(await rowsOf(cy)).toEqual([]);
    });

    it('[PLN-005] sets no amount in a unit the plan changed from meanwhile', async () => {
      const ana = users.ana?.id as number;
      const before = await rowsOf(ana);
      // Typed as 12 hours; the unit becomes points (clearing every capacity) while it waits.
      const res = await racing(
        [{ userId: ana, period: null, amount: 12 }],
        { unit: 'hours', period: { kind: 'weeks', weeks: 2, anchor: '2027-03-29' } },
        async (trx) => {
          await trx
            .updateTable('plan')
            .set({ capacity_unit: 'points' })
            .where('id', '=', planId)
            .execute();
          await trx.deleteFrom('plan_capacity').where('plan_id', '=', planId).execute();
        },
      );
      // Her 30 hours for every period, and 1 for the period from 2027-03-15.
      expect(before.map((r) => Number(r.amount)).sort((a, b) => a - b)).toEqual([1, 30]);
      expect(res.statusCode, res.body).toBe(409);
      expect(JSON.parse(res.body)).toMatchObject({ error: 'settings_changed', unit: 'points' });
      expect(await rowsOf(ana)).toEqual([]);
    });
  });

  /**
   * T-089j, the user's decision of 2026-11-13: an erased person's capacity notes leave the event
   * history too, not only `plan_capacity` (IAM-008; ADR-111, ADR-122). Last, as it erases Ana.
   */
  describe('an erased person’s capacity notes (IAM-008, T-089j)', () => {
    /** The worker's part: events to the audit log, and the erasure's scrub job. */
    async function work(): Promise<void> {
      const bus = new EventBus(database.db);
      registerSubscribers(bus, { db: database.db });
      const runner = new JobRunner(database.db, 'plan-capacity-erasure-test');
      bus.attach(runner);
      registerEraseJobs(runner, database.db);
      for (let i = 0; i < 20; i++) {
        const relayed = await bus.relayOnce();
        const ran = await runner.runOnce();
        if (relayed === 0 && ran === 0) break;
      }
    }

    const notesIn = (changes: unknown, subject: string) =>
      (changes as { subject: string; from: { note: string } | null; to: { note: string } | null }[])
        .filter((c) => c.subject === subject)
        .flatMap((c) => [c.from?.note, c.to?.note])
        .filter((n): n is string => n !== undefined);

    it('[PLN-005] [IAM-008] erasing a person empties their capacity notes in the plans’ events and in the audit log', async () => {
      const ana = `user:${users.ana?.id}`;
      const web = `team:${teams.Web}`;
      await setCapacity('admin', [
        { teamId: teams.Web, period: null, amount: 21, note: 'Web keeps this' },
        { userId: users.ana?.id, period: null, amount: 9, note: 'Part time after surgery' },
      ]);
      await work();
      const capacityEvents = () =>
        database.db
          .selectFrom('domain_event')
          .select('payload')
          .where('type', '=', 'plan.capacity_set')
          .orderBy('id')
          .execute();
      const said = (await capacityEvents()).flatMap((e) =>
        notesIn((e.payload as { changes: unknown }).changes, ana),
      );
      expect(said).toEqual(expect.arrayContaining(['Leave', 'Part time after surgery']));

      const erased = await as('admin', {
        method: 'POST',
        url: `/api/v1/users/${users.ana?.id}/erase`,
        payload: { confirmEmail: 'ana@example.com' },
      });
      expect(erased.statusCode, erased.body).toBe(200);
      await work();

      // Every note about Ana's capacity is empty in the event history; the amounts stay, and
      // so do the notes of anyone else's capacity.
      const events = await capacityEvents();
      const after = events.flatMap((e) =>
        notesIn((e.payload as { changes: unknown }).changes, ana),
      );
      expect(after.length).toBeGreaterThan(0);
      expect(after.every((n) => n === '')).toBe(true);
      expect(
        events.flatMap((e) => notesIn((e.payload as { changes: unknown }).changes, web)),
      ).toContain('Web keeps this');
      const last = events[events.length - 1]?.payload as { changes: unknown[] };
      expect(last.changes).toContainEqual({
        subject: ana,
        period: null,
        from: null,
        to: { amount: 9, note: '' },
      });

      // The audit log is never rewritten: its records keep the words, and it shows them empty.
      const stored = await database.db
        .selectFrom('audit_event')
        .select('details')
        .where('action', '=', 'plan.capacity_set')
        .execute();
      expect(JSON.stringify(stored)).toContain('Part time after surgery');
      const { records } = await searchAudit(
        database.db,
        1,
        { action: 'plan.capacity_set' },
        { limit: 200 },
      );
      const shown = JSON.stringify(records.map((r) => r.details));
      expect(shown).not.toContain('Part time after surgery');
      expect(shown).not.toContain('"Leave"');
      expect(shown).toContain('Web keeps this');
      const masked = records.filter(
        (r) => notesIn((r.details as { changes: unknown }).changes, ana).length > 0,
      );
      expect(masked.length).toBeGreaterThan(0);
      expect(masked.every((r) => r.masked === true)).toBe(true);
      const exported: unknown[] = [];
      for await (const record of exportAudit(database.db, 1, { action: 'plan.capacity_set' })) {
        exported.push(record.details);
      }
      expect(JSON.stringify(exported)).not.toContain('Part time after surgery');

      // So does the personal data download of whoever set them: its audit records are theirs.
      const files = mkdtempSync(join(tmpdir(), 'taskmoor-capacity-erasure-'));
      try {
        const dir = join(files, 'download');
        await writePersonalData(database.db, folderSink(dir), {
          workspaceId: 1,
          userId: users.admin?.id as number,
          self: true,
          stores: storesOf(await LocalStore.open(join(files, 'store'))),
          authorizer: new Authorizer(database.db),
        });
        const lines = readFileSync(join(dir, 'audit.ndjson'), 'utf8')
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => JSON.parse(line) as { action: string; details: { changes: unknown } });
        const theirs = lines.filter((r) => r.action === 'plan.capacity_set');
        expect(theirs.length).toBeGreaterThan(0);
        const notes = theirs.flatMap((r) => notesIn(r.details.changes, ana));
        expect(notes.length).toBeGreaterThan(0);
        expect(notes.every((n) => n === '')).toBe(true);
        expect(theirs.flatMap((r) => notesIn(r.details.changes, web))).toContain('Web keeps this');
      } finally {
        rmSync(files, { recursive: true, force: true });
      }
    });
  });
});
