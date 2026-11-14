import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import {
  type CapacityRow,
  capacityOf,
  capacityRows,
  elsewhereWork,
  estimateSql,
  membersOf,
  periodIndex,
  pointsField,
  round,
  teamCapacity,
} from './capacity';
import type { Period } from './periods';

/**
 * The capacity pieces the Capacity tab and the auto-scheduler share (ADR-122 stages 3 and 7),
 * tested where the Capacity route's tests do not reach: each rule on its own, the edges of the
 * weeks rule, and work elsewhere without a plan's condition.
 */

const row = (r: Partial<CapacityRow> & { amount: string }): CapacityRow => ({
  team_id: null,
  user_id: null,
  period_start: null,
  note: '',
  ...r,
});

// Two-week periods from a Wednesday, so weeks and periods do not line up.
const PERIODS: Period[] = [
  { start: '2027-03-03', end: '2027-03-16' },
  { start: '2027-03-17', end: '2027-03-30' },
];

describe('capacity set for a person or team (PLN-009)', () => {
  it('[PLN-009] a period’s own capacity wins over every period’s, which fills the rest', () => {
    const rows = [
      row({ user_id: 7, amount: '10.00', note: 'usual' }),
      row({ user_id: 7, period_start: '2027-03-17', amount: '0.00', note: 'leave' }),
      row({ user_id: 8, amount: '99.00' }),
      row({ team_id: 7, amount: '55.00' }),
    ];
    expect(capacityOf(rows, PERIODS, { userId: 7 })).toEqual({
      default: { amount: 10, note: 'usual' },
      periods: [
        { amount: 10, note: 'usual', from: 'default' },
        // A capacity of 0 is set, and holds nothing.
        { amount: 0, note: 'leave', from: 'period' },
      ],
    });
    // A team and a person with the same id are never confused.
    expect(capacityOf(rows, PERIODS, { teamId: 7 }).periods.map((p) => p.amount)).toEqual([55, 55]);
  });

  it('[PLN-009] without any row a subject has no capacity, in no period', () => {
    expect(capacityOf([row({ user_id: 8, amount: '5' })], PERIODS, { userId: 9 })).toEqual({
      default: null,
      periods: [
        { amount: null, note: '', from: null },
        { amount: null, note: '', from: null },
      ],
    });
  });

  it('[PLN-009] a team without its own capacity has the sum of its members’ who have one', () => {
    const rows = [
      row({ user_id: 1, amount: '0.10' }),
      row({ user_id: 2, amount: '0.20' }),
      row({ user_id: 2, period_start: '2027-03-17', amount: '0' }),
      row({ team_id: 5, period_start: '2027-03-17', amount: '3.00', note: 'own' }),
    ];
    const members = [1, 2, 3].map((userId) => capacityOf(rows, PERIODS, { userId }));
    const team = teamCapacity(capacityOf(rows, PERIODS, { teamId: 5 }), members);
    expect(team).toEqual({
      default: null,
      periods: [
        // 0.1 + 0.2 in hundredths, never 0.30000000000000004; person 3 has none and adds none.
        { amount: 0.3, note: '', from: 'members' },
        // The team's own wins over its members'.
        { amount: 3, note: 'own', from: 'period' },
      ],
    });
  });

  it('[PLN-009] a team’s own capacity of 0 holds, and members with none leave the team none', () => {
    const rows = [
      row({ team_id: 5, amount: '0' }),
      row({ team_id: 6, period_start: '2027-03-03', amount: '4' }),
      row({ user_id: 1, amount: '8' }),
    ];
    const member = capacityOf(rows, PERIODS, { userId: 1 });
    expect(
      teamCapacity(capacityOf(rows, PERIODS, { teamId: 5 }), [member]).periods.map((p) => [
        p.amount,
        p.from,
      ]),
    ).toEqual([
      [0, 'default'],
      [0, 'default'],
    ]);
    const nobody = capacityOf(rows, PERIODS, { userId: 2 });
    expect(
      teamCapacity(capacityOf(rows, PERIODS, { teamId: 6 }), [nobody]).periods.map((p) => [
        p.amount,
        p.from,
      ]),
    ).toEqual([
      [4, 'period'],
      [null, null],
    ]);
    expect(teamCapacity(capacityOf(rows, PERIODS, { teamId: 9 }), []).periods).toEqual([
      { amount: null, note: '', from: null },
      { amount: null, note: '', from: null },
    ]);
  });

  it('[PLN-009] amounts round to hundredths; days fall in the period that holds them', () => {
    expect(round(0.1 + 0.2)).toBe(0.3);
    expect(round(1.004)).toBe(1);
    expect(periodIndex(PERIODS, '2027-03-03')).toBe(0);
    expect(periodIndex(PERIODS, '2027-03-16')).toBe(0);
    expect(periodIndex(PERIODS, '2027-03-17')).toBe(1);
    expect(periodIndex(PERIODS, '2027-03-30')).toBe(1);
    expect(periodIndex(PERIODS, '2027-03-02')).toBe(-1);
    expect(periodIndex(PERIODS, '2027-03-31')).toBe(-1);
  });
});

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-capacity-lib-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.89.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

describe('capacity read from the database (PLN-005, PLN-009, PLN-004)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  const users: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  const teams: Record<string, number> = {};
  let points = 0;

  const call = async (options: InjectOptions, code = 200) => {
    const res = await app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie },
    });
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body.slice(0, 400)}`).toBe(
      code,
    );
    return res.statusCode === 204 ? null : res.json();
  };
  const ticket = async (track: string, due: string, who: string, data = {}) =>
    (
      await call(
        {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track, summary: `Due ${due}`, assigneeId: users[who], dueDate: due, ...data },
        },
        201,
      )
    ).ticket as { id: number; key: string };
  const pts = (n: number) => ({ fields: { [String(points)]: n } });

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [key, name, admin] of [
      ['admin', 'Admin', true],
      ['zoe', 'zoe', false],
      ['ana', 'Ana', false],
      ['bea', 'Bea', false],
    ] as const) {
      users[key] = (
        await database.db
          .insertInto('app_user')
          .values({
            workspace_id: 1,
            email: `${key}@example.com`,
            name,
            password_hash: hash,
            is_site_admin: admin,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    const header = res.headers['set-cookie'];
    const list = Array.isArray(header) ? header : header ? [header] : [];
    cookie =
      (
        list.find(
          (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
        ) ?? ''
      ).split(';')[0] ?? '';
    for (const key of ['CLA', 'CLB', 'CLC'] as const) {
      tracks[key] = (
        await call(
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name: key, mode: 'shared' } },
          201,
        )
      ).track.id;
    }
    // Everyone works in every track, so tickets can be assigned to them.
    const members = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    for (const who of ['zoe', 'ana', 'bea'] as const) {
      for (const track of Object.values(tracks)) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: track,
            role_id: members,
            user_id: users[who] as number,
          })
          .execute();
      }
    }
    for (const [name, people] of [
      ['Web', ['zoe', 'ana', 'bea']],
      ['Ops', ['bea']],
      ['Empty', []],
    ] as const) {
      teams[name] = (
        await call({ method: 'POST', url: '/api/v1/teams', payload: { name } }, 201)
      ).team.id;
      for (const who of people) {
        await call(
          { method: 'PUT', url: `/api/v1/teams/${teams[name]}/members/${users[who]}` },
          204,
        );
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
  }, 120_000);
  afterAll(async () => {
    await app.close();
  });

  it('[PLN-005] members come in name order whatever the case, with whether they are active', async () => {
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', users.bea as number)
      .execute();
    const members = await membersOf(database.db, 1, [
      teams.Web as number,
      teams.Ops as number,
      teams.Empty as number,
    ]);
    expect(members.get(teams.Web as number)).toEqual([
      { id: users.ana, name: 'Ana', active: true },
      { id: users.bea, name: 'Bea', active: false },
      { id: users.zoe, name: 'zoe', active: true },
    ]);
    expect(members.get(teams.Ops as number)?.map((m) => m.id)).toEqual([users.bea]);
    // A team without members has no entry; no team, no read.
    expect(members.has(teams.Empty as number)).toBe(false);
    expect((await membersOf(database.db, 1, [])).size).toBe(0);
    // Another workspace's rows are never read.
    expect((await membersOf(database.db, 2, [teams.Web as number])).size).toBe(0);
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: null })
      .where('id', '=', users.bea as number)
      .execute();
  });

  it('[PLN-009] reads the Points field and every capacity of one plan only', async () => {
    expect(await pointsField(database.db, 1)).toEqual({ id: points, name: 'Points' });
    const plan = async (name: string) =>
      (
        await call(
          {
            method: 'POST',
            url: '/api/v1/plans',
            payload: { name, sources: [{ kind: 'track', trackId: tracks.CLA }] },
          },
          201,
        )
      ).plan.id as number;
    const one = await plan('One');
    const two = await plan('Two');
    await database.db
      .insertInto('plan_capacity')
      .values([
        {
          workspace_id: 1,
          plan_id: one,
          team_id: teams.Web as number,
          period_start: null,
          amount: 20,
        },
        {
          workspace_id: 1,
          plan_id: one,
          user_id: users.ana as number,
          period_start: '2027-03-17',
          amount: '7.5',
          note: 'half',
        },
        {
          workspace_id: 1,
          plan_id: two,
          user_id: users.ana as number,
          period_start: null,
          amount: 99,
        },
      ])
      .execute();
    const rows = await capacityRows(database.db, one);
    expect(
      rows
        .map((r) => ({ ...r, amount: Number(r.amount) }))
        .sort((a, b) => (a.team_id ?? 0) - (b.team_id ?? 0)),
    ).toEqual([
      { team_id: null, user_id: users.ana, period_start: '2027-03-17', amount: 7.5, note: 'half' },
      { team_id: teams.Web, user_id: null, period_start: null, amount: 20, note: '' },
    ]);
    expect(capacityOf(rows, PERIODS, { userId: users.ana as number }).periods).toEqual([
      { amount: null, note: '', from: null },
      { amount: 7.5, note: 'half', from: 'period' },
    ]);
  });

  it('[PLN-005] [PLN-004] work elsewhere goes by whole weeks, in the period holding each Thursday', async () => {
    const zoe = users.zoe as number;
    const ana = users.ana as number;
    // Monday 2027-03-01: its week's Thursday, 03-04, is in the first period, before its first day.
    await ticket('CLB', '2027-03-01', 'zoe', pts(1));
    // Sunday 2027-02-28: its week's Thursday, 02-25, is before the periods; read, never counted.
    await ticket('CLB', '2027-02-28', 'zoe', pts(100));
    // Monday 2027-03-15 is in the first period by day, but its week's Thursday is in the second.
    await ticket('CLB', '2027-03-15', 'zoe', pts(2));
    // Tuesday 2027-03-30, the last day, belongs to a week whose Thursday is after the periods.
    await ticket('CLB', '2027-03-30', 'zoe', pts(200));
    // Friday 2027-04-02 is the last day read; its Thursday is after the periods too.
    await ticket('CLB', '2027-04-02', 'zoe', pts(300));
    await ticket('CLB', '2027-04-03', 'zoe', pts(400));
    // Unestimated work counts, with nothing in the amount; a non-number estimate is none.
    await ticket('CLB', '2027-03-18', 'zoe');
    const text = await ticket('CLB', '2027-03-19', 'zoe');
    await database.db
      .updateTable('ticket')
      .set({ fields: JSON.stringify({ [String(points)]: '8' }) })
      .where('id', '=', text.id)
      .execute();
    // Hundredths add up without rounding here.
    await ticket('CLB', '2027-03-10', 'ana', pts(0.1));
    await ticket('CLB', '2027-03-11', 'ana', pts(0.2));
    // The plan's own work (track CLA here) is not elsewhere.
    await ticket('CLA', '2027-03-10', 'ana', pts(50));
    // The trash and archived tracks hold none.
    const binned = await ticket('CLB', '2027-03-10', 'ana', pts(60));
    await database.db
      .updateTable('ticket')
      .set({ deleted_at: new Date() })
      .where('id', '=', binned.id)
      .execute();
    await ticket('CLC', '2027-03-10', 'ana', pts(70));
    await database.db
      .updateTable('track')
      .set({ archived_at: new Date() })
      .where('id', '=', tracks.CLC as number)
      .execute();
    // Somebody not asked for is not read.
    await ticket('CLB', '2027-03-10', 'admin', pts(80));

    const value = estimateSql('points', points);
    const where = sql<boolean>`k.track_id = ${tracks.CLA}::int`;
    const read = (w: typeof where | null, people = [zoe, ana]) =>
      elsewhereWork(database.db, { ws: 1, people, where: w, value, periods: PERIODS });

    const away = await read(where);
    expect(away.get(zoe)).toEqual([
      { count: 1, amount: 1 },
      { count: 3, amount: 2 },
    ]);
    const anas = away.get(ana) ?? [];
    expect(anas.map((c) => c.count)).toEqual([2, 0]);
    expect(round(anas[0]?.amount ?? 0)).toBe(0.3);
    expect(away.has(users.admin as number)).toBe(false);

    // Without a plan's condition everything a person has counts, the plan's own work too.
    expect((await read(null)).get(ana)?.map((c) => c.count)).toEqual([3, 0]);
    // Nobody to count, nothing read.
    expect((await read(where, [])).size).toBe(0);
  });

  it('[PLN-009] in hours the estimate is the original estimate; with no Points field, none', async () => {
    const t = await ticket('CLB', '2027-03-22', 'bea');
    await database.db
      .updateTable('ticket')
      .set({ original_estimate: 5400 })
      .where('id', '=', t.id)
      .execute();
    const periods = [{ start: '2027-03-22', end: '2027-03-28' }];
    const bea = users.bea as number;
    const hours = await elsewhereWork(database.db, {
      ws: 1,
      people: [bea],
      where: null,
      value: estimateSql('hours', null),
      periods,
    });
    expect(hours.get(bea)).toEqual([{ count: 1, amount: 1.5 }]);
    const unset = await elsewhereWork(database.db, {
      ws: 1,
      people: [bea],
      where: null,
      value: estimateSql('points', null),
      periods,
    });
    expect(unset.get(bea)).toEqual([{ count: 1, amount: 0 }]);
  });
});
