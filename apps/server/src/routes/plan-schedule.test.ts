import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import type { DaySnapshot } from '../plans/scheduleInputs';
import { diffProposals } from './plan-schedule';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-schedule-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.91.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Entry {
  id: number;
  key: string;
  outcome: 'placed' | 'kept' | 'not_placed';
  reason: string;
  args: Record<string, unknown>;
  warnings: { kind: string; args: Record<string, unknown> }[];
  changedMeanwhile?: true;
}
interface Run {
  scenario: { id: number; name: string; main: boolean; version: number };
  created: boolean;
  from: string;
  periods: { start: string; end: string }[];
  counts: {
    placed: number;
    unchanged: number;
    withdrawn: number;
    changedMeanwhile: number;
    notShown: number;
    kept: Record<string, number>;
    notPlaced: Record<string, number>;
    leftOut: Record<string, number>;
    warnings: Record<string, number>;
  };
  tickets: Entry[];
  more: number;
}
interface Readiness {
  unit: string;
  pointsField: { id: number; name: string } | null;
  periods: { start: string; end: string }[];
  teams: { id: number; name: string; withCapacity: boolean }[];
  people: { withCapacity: number; without: number };
  tickets: { open: number; unestimated: number; unassigned: number; noTeam: number };
  editable: boolean;
  scenario?: { id: number; proposals: number; drafts: number; notShown: number; applying: boolean };
  limits: Record<string, number>;
}

const SENTINEL_DAYS = ['2027-06-16', '2027-06-17'];
const SENTINEL_WORDS = ['Hidden sentinel work', 'Hidden sentinel two'];
const FROM = '2027-03-01';

/**
 * The auto-scheduler's routes (T-089f; PLN-004; ADR-122 stage 7). Every plan is the owner's
 * (a member of its tracks, not a site administrator) and plans by one-week periods from Monday
 * 1 March 2027, with the Points field. Each plan's work belongs to its own people, so no plan's
 * tickets count as another's work elsewhere:
 * - Accept (SKA): Atlas (u1) at 20 points a period and six 10-point tickets, a1 to a6.
 * - Fill (SKC): Cirrus (u2) at 20; a closed ticket and work elsewhere (SKX) already there; c4,
 *   ranked last, blocks c1.
 * - Private (SKD, SKV, and SKH, which only administrators see): Delta (u3) at 100 and Empty,
 *   with no capacity; a ticket of every kind a run keeps, leaves out or cannot place, and two
 *   blocked by tickets the owner may not see. Ana sees SKD only; Cy sees none of its tracks.
 * - Bulk (SKF, not shared): Fox (u6) and 2,500 tickets; Huge (SKG): over the limits.
 */
describe('the auto-scheduler (PLN-004)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const teams: Record<string, number> = {};
  const plans: Record<string, number> = {};
  type Ticket = { id: number; key: string };
  const t: Record<string, Ticket> = {};
  let points = 0;
  let feature = 0;
  let bug = 0;
  let outcome = 0;
  let blocks = 0;
  let release = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body.slice(0, 600)}`).toBe(
      code,
    );
    return res.statusCode === 204 ? null : res.json();
  };
  const user = (who: string) => users[who]?.id as number;
  const pts = (n: number) => ({ fields: { [String(points)]: n } });
  const ticket = async (track: string, summary: string, data: Record<string, unknown> = {}) =>
    (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tickets',
          payload: { track, summary, ticketTypeId: feature, ...data },
        },
        201,
      )
    ).ticket as Ticket;
  const assign = (ids: number[], who: string | null) =>
    database.db
      .updateTable('ticket')
      .set({ assignee_id: who === null ? null : user(who) })
      .where('id', 'in', ids)
      .execute();
  const link = (from: Ticket, to: Ticket) =>
    database.db
      .insertInto('ticket_link')
      .values({ workspace_id: 1, link_type_id: blocks, source_id: from.id, target_id: to.id })
      .execute();
  const stageStatus = async (stage: 'active' | 'closed') =>
    (
      await database.db
        .selectFrom('status')
        .select('id')
        .where('stage', '=', stage)
        .orderBy('id')
        .executeTakeFirstOrThrow()
    ).id;
  const schedule = (who: string, plan: string, payload: Record<string, unknown>, code = 200) =>
    call(
      who,
      { method: 'POST', url: `/api/v1/plans/${plans[plan]}/schedule`, payload },
      code,
    ) as Promise<Run>;
  const readiness = (who: string, plan: string, query = `?from=${FROM}&periods=6`) =>
    call(who, {
      method: 'GET',
      url: `/api/v1/plans/${plans[plan]}/schedule${query}`,
    }) as Promise<Readiness>;
  const drafts = async (scenarioId: number) => {
    const rows = await database.db
      .selectFrom('plan_draft')
      .select(['ticket_id', 'field', 'old_value', 'new_value', 'origin', 'updated_at'])
      .where('scenario_id', '=', scenarioId)
      .orderBy('ticket_id')
      .orderBy('field')
      .execute();
    const out = new Map<
      number,
      Record<string, { to: unknown; was: unknown; origin: string; at: Date }>
    >();
    for (const r of rows) {
      const entry = out.get(r.ticket_id) ?? {};
      entry[r.field] = { to: r.new_value, was: r.old_value, origin: r.origin, at: r.updated_at };
      out.set(r.ticket_id, entry);
    }
    return out;
  };
  const days = async (scenarioId: number, x: Ticket) => {
    const d = (await drafts(scenarioId)).get(x.id);
    return d ? [d.startDate?.to ?? null, d.dueDate?.to ?? null] : null;
  };
  const eventsOf = async (type: string, since = 0) =>
    database.db
      .selectFrom('domain_event')
      .select(['id', 'type', 'subject_id', 'actor_id', 'payload'])
      .where('type', '=', type)
      .where('id', '>', String(since) as never)
      .orderBy('id')
      .execute();
  const lastEventId = async () =>
    Number(
      (
        await database.db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.max('id').as('id'))
          .executeTakeFirstOrThrow()
      ).id ?? 0,
    );
  const entry = (run: Run, x: Ticket) => run.tickets.find((e) => e.id === x.id);
  /** Copies of a ticket written straight to the table, `n` of them in its track. */
  async function copies(template: Ticket, n: number, tag = 'z'): Promise<number[]> {
    const columns = (
      await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'ticket' AND table_schema = 'public'
           AND column_name NOT IN ('id', 'number', 'rank', 'search_vector')
           AND is_generated = 'NEVER'`.execute(database.db)
    ).rows.map((r) => r.column_name);
    const list = sql.join(columns.map((c) => sql.ref(c)));
    const row = await database.db
      .selectFrom('ticket')
      .select('track_id')
      .where('id', '=', template.id)
      .executeTakeFirstOrThrow();
    const top = await sql<{ n: number }>`
      SELECT max(number)::int AS n FROM ticket WHERE track_id = ${row.track_id}`.execute(
      database.db,
    );
    const made = await sql<{ id: number }>`
      INSERT INTO ticket (number, rank, ${list})
      SELECT ${top.rows[0]?.n ?? 0} + g, rank || ${tag}::text || lpad(g::text, 6, '0'), ${list}
        FROM ticket, generate_series(1, ${n}::int) g
       WHERE id = ${template.id}
      RETURNING id`.execute(database.db);
    return made.rows.map((r) => r.id);
  }
  /**
   * Holds the scenario's row lock while `during` runs: a run waiting on it has read the plan and
   * is blocked in its transaction, before it reads again under the lock.
   */
  async function whileScenarioLocked(
    scenarioId: number,
    start: () => Promise<unknown>,
    during: (trx: Transaction<Database>) => Promise<void>,
  ) {
    let started: Promise<unknown> = Promise.resolve();
    await database.db.transaction().execute(async (trx) => {
      await trx
        .selectFrom('plan_scenario')
        .select('id')
        .where('id', '=', scenarioId)
        .forUpdate()
        .execute();
      const holder = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx))
        .rows[0]?.pid;
      started = start();
      for (let i = 0; i < 400; i++) {
        const waiting = await sql<{ n: number }>`
          SELECT count(*)::int AS n FROM pg_stat_activity
           WHERE ${holder}::int = ANY(pg_blocking_pids(pid))`.execute(database.db);
        if ((waiting.rows[0]?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      await during(trx);
    });
    return started;
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['owner', false],
      ['ana', false],
      ['cy', false],
      ['u1', false],
      ['u2', false],
      ['u3', false],
      ['u6', false],
      ['u9', false],
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
    const type = async (name: string) =>
      (
        await database.db
          .selectFrom('ticket_type')
          .select('id')
          .where('name', '=', name)
          .where('owner_track_id', 'is', null)
          .executeTakeFirstOrThrow()
      ).id;
    feature = await type('Feature');
    bug = await type('Bug');
    outcome = await type('Outcome');
    points = (
      await database.db
        .selectFrom('field')
        .select('id')
        .where('name', '=', 'Points')
        .where('track_id', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
    blocks = (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('outward', '=', 'blocks')
        .executeTakeFirstOrThrow()
    ).id;
    const roles = new Map(
      (await database.db.selectFrom('role').select(['id', 'name']).execute()).map((r) => [
        r.name,
        r.id,
      ]),
    );
    for (const key of ['SKA', 'SKC', 'SKX', 'SKD', 'SKH', 'SKV', 'SKF', 'SKW', 'SKG']) {
      tracks[key] = (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name: key, mode: 'shared' } },
          201,
        )
      ).track.id;
    }
    const member = (who: string, key: string, role: string) =>
      database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: tracks[key] as number,
          role_id: roles.get(role) as number,
          user_id: user(who),
        })
        .execute();
    for (const key of ['SKA', 'SKC', 'SKX', 'SKD', 'SKF', 'SKW', 'SKG'])
      await member('owner', key, 'Members');
    await member('owner', 'SKV', 'Viewers');
    await member('ana', 'SKD', 'Members');
    for (const [name, people] of [
      ['Atlas', ['u1']],
      ['Cirrus', ['u2']],
      ['Delta', ['u3']],
      ['Empty', []],
      ['Fox', ['u6']],
    ] as const) {
      teams[name] = (
        await call('admin', { method: 'POST', url: '/api/v1/teams', payload: { name } }, 201)
      ).team.id;
      for (const who of people) {
        await call(
          'admin',
          { method: 'PUT', url: `/api/v1/teams/${teams[name]}/members/${user(who)}` },
          204,
        );
      }
    }
    const makePlan = async (
      name: string,
      keys: string[],
      teamNames: string[],
      capacity: Record<string, number>,
      shared = true,
    ) => {
      plans[name] = (
        await call(
          'owner',
          {
            method: 'POST',
            url: '/api/v1/plans',
            payload: {
              name,
              sources: keys.map((k) => ({ kind: 'track', trackId: tracks[k] })),
              ...(shared ? { shares: [{ scope: 'any_user' }] } : {}),
            },
          },
          201,
        )
      ).plan.id;
      await call('owner', {
        method: 'PATCH',
        url: `/api/v1/plans/${plans[name]}`,
        payload: {
          teams: teamNames.map((n) => teams[n]),
          period: { kind: 'weeks', weeks: 1, anchor: FROM },
        },
      });
      const entries = Object.entries(capacity).map(([team, amount]) => ({
        teamId: teams[team],
        period: null,
        amount,
      }));
      if (entries.length > 0)
        await call('owner', {
          method: 'PUT',
          url: `/api/v1/plans/${plans[name]}/capacity`,
          payload: { entries },
        });
    };

    // Accept: six 10-point tickets in rank order.
    for (let i = 1; i <= 6; i++) t[`a${i}`] = await ticket('SKA', `Accept ${i}`, pts(10));
    await assign(
      [1, 2, 3, 4, 5, 6].map((i) => t[`a${i}`]?.id as number),
      'u1',
    );
    await makePlan('Accept', ['SKA'], ['Atlas'], { Atlas: 20 });

    // Fill: a closed ticket due in the first period, work elsewhere in the second.
    for (let i = 1; i <= 4; i++) t[`c${i}`] = await ticket('SKC', `Fill ${i}`, pts(10));
    t.cz = await ticket('SKC', 'Fill closed', { ...pts(5), dueDate: '2027-03-03' });
    t.x1 = await ticket('SKX', 'Elsewhere work', { ...pts(5), dueDate: '2027-03-10' });
    await database.db
      .updateTable('ticket')
      .set({ status_id: await stageStatus('closed') })
      .where('id', '=', t.cz.id)
      .execute();
    await assign(
      ['c1', 'c2', 'c3', 'c4', 'cz', 'x1'].map((k) => t[k]?.id as number),
      'u2',
    );
    await link(t.c4 as Ticket, t.c1 as Ticket);
    await makePlan('Fill', ['SKC'], ['Cirrus'], { Cirrus: 20 });

    // Private: every kind of ticket a run keeps, leaves out or cannot place.
    t.h1 = await ticket('SKH', SENTINEL_WORDS[0] as string, {
      ...pts(5),
      startDate: SENTINEL_DAYS[0],
      dueDate: SENTINEL_DAYS[1],
    });
    t.h2 = await ticket('SKH', SENTINEL_WORDS[1] as string, pts(5));
    t.o1 = await ticket('SKX', 'Outside blocker', pts(5));
    for (const [k, summary] of [
      ['d1', 'Waits on hidden'],
      ['d2', 'Waits outside'],
      ['d3', 'In progress'],
      ['d4', 'In a sprint'],
      ['d5', 'Kept by query'],
      ['d6', 'Drafted by a person'],
      ['d8', 'Released'],
      ['d9', 'Left by query'],
      ['p1', 'Plain'],
      ['p2', 'After the drafted one'],
      ['p3', 'After the hidden-blocked one'],
      ['e2', 'Nobody on it'],
      ['e3', 'Outside the teams'],
      ['e4', 'Circle one'],
      ['e5', 'Circle two'],
    ] as const) {
      t[k] = await ticket('SKD', summary, pts(5));
    }
    t.d7 = await ticket('SKD', 'A bug', { ...pts(5), ticketTypeId: bug });
    t.e1 = await ticket('SKD', 'No estimate');
    t.top = await ticket('SKD', 'An outcome', { ...pts(5), ticketTypeId: outcome });
    t.v1 = await ticket('SKV', 'Viewer only', pts(5));
    await assign(
      [
        'h1',
        'h2',
        'o1',
        'd1',
        'd2',
        'd3',
        'd4',
        'd5',
        'd6',
        'd7',
        'd8',
        'd9',
        'p1',
        'p2',
        'p3',
        'e1',
        'e4',
        'e5',
        'top',
        'v1',
      ].map((k) => t[k]?.id as number),
      'u3',
    );
    await assign([t.e3?.id as number], 'u9');
    await link(t.h1 as Ticket, t.d1 as Ticket);
    await link(t.o1 as Ticket, t.d2 as Ticket);
    await link(t.d6 as Ticket, t.p2 as Ticket);
    await link(t.d1 as Ticket, t.p3 as Ticket);
    await link(t.e4 as Ticket, t.e5 as Ticket);
    await link(t.e5 as Ticket, t.e4 as Ticket);
    await database.db
      .updateTable('ticket')
      .set({ status_id: await stageStatus('active') })
      .where('id', '=', t.d3?.id as number)
      .execute();
    const board = await database.db
      .insertInto('board')
      .values({
        workspace_id: 1,
        name: 'SKD scrum',
        kind: 'scrum',
        location_track_id: null,
        location_user_id: user('admin'),
        filter_query: 'track = SKD',
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
        board_id: board.id,
        name: 'Sprint 1',
        sequence: 1,
        state: 'active',
        start_at: new Date('2027-03-01T00:00:00Z'),
        end_at: new Date('2027-03-14T00:00:00Z'),
        started_at: new Date(),
        completed_at: null,
        deleted_at: null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('sprint_ticket')
      .values({ workspace_id: 1, sprint_id: sprint.id, ticket_id: t.d4?.id as number, open: true })
      .execute();
    release = (
      await call(
        'admin',
        {
          method: 'POST',
          url: `/api/v1/tracks/${tracks.SKD}/releases`,
          payload: { name: 'Private 1.0', releaseDate: '2027-03-05' },
        },
        201,
      )
    ).release.id;
    await database.db
      .insertInto('ticket_release')
      .values([
        { workspace_id: 1, ticket_id: t.d8?.id as number, release_id: release, role: 'target' },
        { workspace_id: 1, ticket_id: t.p1?.id as number, release_id: release, role: 'target' },
      ])
      .execute();
    await makePlan('Private', ['SKD', 'SKV'], ['Delta', 'Empty'], { Delta: 100 });
    // A track the owner may not see joins the plan through an administrator.
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/plans/${plans.Private}`,
      payload: {
        sources: ['SKD', 'SKV', 'SKH'].map((k) => ({ kind: 'track', trackId: tracks[k] })),
      },
    });

    // Bulk: 2,500 one-point tickets of Fox's, not shared.
    t.f0 = await ticket('SKF', 'Bulk', pts(1));
    await assign([t.f0.id], 'u6');
    await copies(t.f0, 2_499);
    await makePlan('Bulk', ['SKF'], ['Fox'], { Fox: 10_000 }, false);
  }, 240_000);
  afterAll(async () => {
    await app.close();
  });

  let auto = 0;

  it('[PLN-004] says before a run whether the plan is ready, in counts over the reader’s tickets', async () => {
    const ready = await readiness('owner', 'Accept');
    expect(ready).toMatchObject({
      unit: 'points',
      pointsField: { id: points, name: 'Points' },
      teams: [{ id: teams.Atlas, name: 'Atlas', withCapacity: true }],
      people: { withCapacity: 0, without: 1 },
      tickets: { open: 6, unestimated: 0, unassigned: 0, noTeam: 0 },
      editable: true,
    });
    expect(ready.periods).toHaveLength(6);
    expect(ready.periods[0]).toEqual({ start: '2027-03-01', end: '2027-03-07' });
    expect(ready.limits).toMatchObject({ toSchedule: 10_000, periods: 12, defaultPeriods: 6 });
    // A team without capacity says so; tickets the reader may not see are not counted.
    const priv = await readiness('owner', 'Private');
    expect(priv.teams).toEqual([
      { id: teams.Delta, name: 'Delta', withCapacity: true },
      { id: teams.Empty, name: 'Empty', withCapacity: false },
    ]);
    const all = await readiness('admin', 'Private');
    expect(all.tickets.open - priv.tickets.open).toBe(2);
    expect(priv.tickets).toMatchObject({ unestimated: 1, unassigned: 1, noTeam: 1 });
    // Ana sees SKD only, Cy none of the tracks; neither may run it.
    const ana = await readiness('ana', 'Private');
    expect(ana.tickets.open).toBe(priv.tickets.open - 1);
    expect(ana.editable).toBe(false);
    const cy = await readiness('cy', 'Private');
    expect(cy.tickets).toEqual({ open: 0, unestimated: 0, unassigned: 0, noTeam: 0 });
    for (const answer of [priv, ana, cy]) {
      const body = JSON.stringify(answer);
      for (const word of [...SENTINEL_WORDS, ...SENTINEL_DAYS, t.h1?.key, t.h2?.key])
        expect(body).not.toContain(word);
    }
    // A scenario that is not the plan's.
    const res = await as('owner', {
      method: 'GET',
      url: `/api/v1/plans/${plans.Accept}/schedule?scenario=999999`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'invalid_fields', fields: { scenario: 'not_found' } });
  });

  it('[PLN-004] [PLN-002] (1) fills three periods with 60 points of ranked work, into a new scenario made main', async () => {
    const since = await lastEventId();
    const run = await schedule(
      'owner',
      'Accept',
      { into: { newScenario: { name: 'Auto' } }, from: FROM, periods: 6 },
      201,
    );
    auto = run.scenario.id;
    expect(run).toMatchObject({
      created: true,
      from: FROM,
      scenario: { name: 'Auto', main: true },
      counts: { placed: 6, unchanged: 0, withdrawn: 0, changedMeanwhile: 0, notShown: 0 },
      more: 0,
    });
    expect(run.periods).toHaveLength(6);
    expect(Object.values(run.counts.notPlaced).every((n) => n === 0)).toBe(true);
    const placed = [1, 2, 3, 4, 5, 6].map((i) => days(auto, t[`a${i}`] as Ticket));
    expect(await Promise.all(placed)).toEqual([
      ['2027-03-01', '2027-03-07'],
      ['2027-03-01', '2027-03-07'],
      ['2027-03-08', '2027-03-14'],
      ['2027-03-08', '2027-03-14'],
      ['2027-03-15', '2027-03-21'],
      ['2027-03-15', '2027-03-21'],
    ]);
    const all = await drafts(auto);
    expect(
      [...all.values()].every((d) => Object.values(d).every((f) => f.origin === 'scheduler')),
    ).toBe(true);
    expect(entry(run, t.a1 as Ticket)).toMatchObject({
      key: t.a1?.key,
      outcome: 'placed',
      reason: 'fits',
      args: { teamId: teams.Atlas, periodStart: FROM, free: 20, capacity: 20, before: 0 },
    });
    // Its events: the scenario, its drafts with origin scheduler, then the run.
    const types = (
      await database.db
        .selectFrom('domain_event')
        .select('type')
        .where('id', '>', String(since) as never)
        .where('type', 'like', 'plan.%')
        .orderBy('id')
        .execute()
    ).map((e) => e.type);
    expect(types).toEqual(['plan.scenario_created', 'plan.drafts_set', 'plan.schedule_ran']);
    const set = (await eventsOf('plan.drafts_set', since))[0]?.payload as {
      origin: string;
      changes: unknown[];
    };
    expect(set.origin).toBe('scheduler');
    expect(set.changes).toHaveLength(12);
    const ran = (await eventsOf('plan.schedule_ran', since))[0];
    expect(ran?.actor_id).toBe(user('owner'));
    expect(ran?.payload).toMatchObject({
      scenarioId: auto,
      created: true,
      from: FROM,
      periods: 6,
      leftOut: { typeIds: [], releaseIds: [], query: false },
      keep: { inProgress: true, inActiveSprint: true, query: false },
      counts: { placed: 6 },
    });
  });

  it('[PLN-004] (4) a second run on unchanged tickets changes no draft and emits no plan.drafts_set', async () => {
    const before = await drafts(auto);
    const since = await lastEventId();
    const run = await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    expect(run.created).toBe(false);
    expect(run.counts).toMatchObject({ placed: 6, unchanged: 6, withdrawn: 0 });
    expect(await drafts(auto)).toEqual(before);
    expect(await eventsOf('plan.drafts_set', since)).toHaveLength(0);
    expect(await eventsOf('plan.schedule_ran', since)).toHaveLength(1);
    // Readiness in the scenario counts its proposals.
    const ready = await readiness('owner', 'Accept', `?scenario=${auto}`);
    expect(ready.scenario).toMatchObject({ id: auto, proposals: 6, drafts: 0, notShown: 0 });
  });

  it('[PLN-004] [PLN-002] keeps a person’s draft and plans around it; a re-run replaces and withdraws only its own drafts', async () => {
    await call('owner', {
      method: 'PUT',
      url: `/api/v1/plans/${plans.Accept}/scenarios/${auto}/drafts`,
      payload: {
        changes: [{ ticketId: t.a1?.id, startDate: '2027-03-15', dueDate: '2027-03-21' }],
      },
    });
    let run = await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    expect(run.counts.kept.person_draft).toBe(1);
    expect(entry(run, t.a1 as Ticket)).toMatchObject({ outcome: 'kept', reason: 'person_draft' });
    const at = async () =>
      Promise.all([1, 2, 3, 4, 5, 6].map((i) => days(auto, t[`a${i}`] as Ticket)));
    expect(await at()).toEqual([
      ['2027-03-15', '2027-03-21'],
      ['2027-03-01', '2027-03-07'],
      ['2027-03-01', '2027-03-07'],
      ['2027-03-08', '2027-03-14'],
      ['2027-03-08', '2027-03-14'],
      ['2027-03-15', '2027-03-21'],
    ]);
    expect((await drafts(auto)).get(t.a1?.id as number)?.dueDate?.origin).toBe('person');
    // More capacity: three a period now. The person's draft stays where it was.
    await call('owner', {
      method: 'PUT',
      url: `/api/v1/plans/${plans.Accept}/capacity`,
      payload: { entries: [{ teamId: teams.Atlas, period: null, amount: 30 }] },
    });
    const since = await lastEventId();
    run = await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    expect(await at()).toEqual([
      ['2027-03-15', '2027-03-21'],
      ['2027-03-01', '2027-03-07'],
      ['2027-03-01', '2027-03-07'],
      ['2027-03-01', '2027-03-07'],
      ['2027-03-08', '2027-03-14'],
      ['2027-03-08', '2027-03-14'],
    ]);
    const set = (await eventsOf('plan.drafts_set', since)).map(
      (e) => e.payload as { origin: string; changes: { ticketId: number }[] },
    );
    expect(set.every((e) => e.origin === 'scheduler')).toBe(true);
    expect(set.flatMap((e) => e.changes).some((c) => c.ticketId === t.a1?.id)).toBe(false);
    // Kept by the run's own condition: its earlier proposal goes.
    run = await schedule('owner', 'Accept', {
      into: { scenarioId: auto },
      from: FROM,
      keep: { query: `key = "${t.a6?.key}"` },
    });
    expect(entry(run, t.a6 as Ticket)).toMatchObject({ outcome: 'kept', reason: 'kept_by_query' });
    expect(run.counts.withdrawn).toBe(1);
    expect(await days(auto, t.a6 as Ticket)).toBeNull();
    expect((await drafts(auto)).get(t.a1?.id as number)?.startDate?.origin).toBe('person');
    const ran = (await eventsOf('plan.schedule_ran', since)).at(-1)?.payload as {
      keep: { query: unknown };
    };
    // The payload says a condition was used, never its text.
    expect(ran.keep.query).toBe(true);
    expect(JSON.stringify(ran)).not.toContain(t.a6?.key);
  });

  it('[PLN-004] [PLN-002] a proposal over an earlier one takes the live value as its value when drafted', async () => {
    await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    await call('owner', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.a2?.key}`,
      payload: { dueDate: '2027-04-30' },
    });
    const run = await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    const a2 = (await drafts(auto)).get(t.a2?.id as number);
    expect(a2?.dueDate).toMatchObject({ to: '2027-03-07', was: '2027-04-30', origin: 'scheduler' });
    expect(run.counts.unchanged).toBe(run.counts.placed - 1);
  });

  it('[PLN-004] leaves out of the write a ticket changed while the run worked', async () => {
    const before = (await drafts(auto)).get(t.a3?.id as number);
    let res: Awaited<ReturnType<typeof as>> | undefined;
    await await whileScenarioLocked(
      auto,
      async () => {
        res = await as('owner', {
          method: 'POST',
          url: `/api/v1/plans/${plans.Accept}/schedule`,
          payload: { into: { scenarioId: auto }, from: FROM, periods: 2 },
        });
      },
      async () => {
        await call('owner', {
          method: 'PATCH',
          url: `/api/v1/tickets/${t.a3?.key}`,
          payload: { dueDate: '2027-05-05' },
        });
      },
    );
    expect(res?.statusCode, res?.body).toBe(200);
    const run = res?.json() as Run;
    expect(run.counts.changedMeanwhile).toBe(1);
    expect(entry(run, t.a3 as Ticket)?.changedMeanwhile).toBe(true);
    expect((await drafts(auto)).get(t.a3?.id as number)).toEqual(before);
  });

  it('[PLN-004] [PLN-002] a run into a new scenario copied from another keeps the copied drafts’ origins', async () => {
    const run = await schedule(
      'owner',
      'Accept',
      { into: { newScenario: { name: 'Copy', from: auto } }, from: FROM },
      201,
    );
    expect(run.scenario.main).toBe(false);
    const copy = await drafts(run.scenario.id);
    expect(copy.get(t.a1?.id as number)?.startDate?.origin).toBe('person');
    expect(entry(run, t.a1 as Ticket)?.reason).toBe('person_draft');
    expect(run.counts.unchanged).toBeGreaterThan(0);
  });

  it('[PLN-004] [PLN-002] its drafts apply through stage 6 like anyone’s; then they are already so', async () => {
    await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    const proposed = await days(auto, t.a2 as Ticket);
    const applied = await call('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Accept}/scenarios/${auto}/apply`,
      payload: { all: true },
    });
    expect(applied.applied.map((a: { ticketId: number }) => a.ticketId)).toContain(t.a2?.id);
    const live = await database.db
      .selectFrom('ticket')
      .select([sql<string>`start_date::text`.as('start'), sql<string>`due_date::text`.as('due')])
      .where('id', '=', t.a2?.id as number)
      .executeTakeFirstOrThrow();
    expect([live.start, live.due]).toEqual(proposed);
    const run = await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
    expect(entry(run, t.a2 as Ticket)).toMatchObject({ outcome: 'placed', reason: 'already' });
    expect(await days(auto, t.a2 as Ticket)).toBeNull();
  });

  it('[PLN-004] [PLN-005] [PLN-006] fills no cell over capacity and makes no late link, counting closed work and work elsewhere', async () => {
    const run = await schedule(
      'owner',
      'Fill',
      { into: { newScenario: { name: 'Fill' } }, from: FROM, periods: 6 },
      201,
    );
    const sid = run.scenario.id;
    // c4, ranked last, goes first: it blocks c1. c1 starts the day after c4 ends.
    expect(entry(run, t.c4 as Ticket)).toMatchObject({
      reason: 'first_for_blocked',
      args: { ticketId: t.c1?.id },
    });
    expect(entry(run, t.c1 as Ticket)).toMatchObject({
      reason: 'after_blocker',
      args: { blockerId: t.c4?.id, blockerEnd: '2027-03-07' },
    });
    expect(await days(sid, t.c4 as Ticket)).toEqual(['2027-03-01', '2027-03-07']);
    expect(await days(sid, t.c1 as Ticket)).toEqual(['2027-03-08', '2027-03-14']);
    expect(await days(sid, t.c2 as Ticket)).toEqual(['2027-03-15', '2027-03-21']);
    expect(await days(sid, t.c3 as Ticket)).toEqual(['2027-03-15', '2027-03-21']);
    const capacity = await call('owner', {
      method: 'GET',
      url: `/api/v1/plans/${plans.Fill}/capacity?scenario=${sid}&from=${FROM}&periods=6`,
    });
    const team = (
      capacity.teams as {
        cells: { load: number; over: boolean; elsewhere: { amount: number } }[];
        members: { cells: { over: boolean }[] }[];
      }[]
    )[0];
    expect(team?.cells.map((c) => c.load).slice(0, 3)).toEqual([15, 15, 20]);
    expect(team?.cells[1]?.elsewhere.amount).toBe(5);
    expect(team?.cells.some((c) => c.over)).toBe(false);
    expect(team?.members.flatMap((m) => m.cells).some((c) => c.over)).toBe(false);
    const timeline = await call('owner', {
      method: 'GET',
      url: `/api/v1/plans/${plans.Fill}/timeline?scenario=${sid}`,
    });
    const items = new Map(
      (
        timeline.items as {
          id: number;
          start: string | null;
          due: string | null;
          draft?: { origin: string };
        }[]
      ).map((i) => [i.id, i]),
    );
    expect(items.get(t.c1?.id as number)?.draft?.origin).toBe('scheduler');
    for (const l of timeline.links as { from: number; to: number }[]) {
      const blocker = items.get(l.from);
      const blocked = items.get(l.to);
      expect((blocked?.start ?? '') > (blocker?.due ?? '')).toBe(true);
    }
    expect(timeline.links).toHaveLength(1);
  });

  it('[PLN-004] [PLN-002] [PLN-006] a person who moves one end of a proposed bar takes over both its days, and a re-run plans after both', async () => {
    const run = await schedule(
      'owner',
      'Fill',
      { into: { newScenario: { name: 'Fill moved' } }, from: FROM, periods: 6 },
      201,
    );
    const sid = run.scenario.id;
    expect(await days(sid, t.c4 as Ticket)).toEqual(['2027-03-01', '2027-03-07']);
    // Only c4's left edge moves: its due day is not sent, as the Calendar's start chip sends it.
    await call('owner', {
      method: 'PUT',
      url: `/api/v1/plans/${plans.Fill}/scenarios/${sid}/drafts`,
      payload: { changes: [{ ticketId: t.c4?.id, startDate: '2027-02-26' }] },
    });
    const c4 = (await drafts(sid)).get(t.c4?.id as number);
    expect(c4?.startDate).toMatchObject({ to: '2027-02-26', origin: 'person' });
    expect(c4?.dueDate).toMatchObject({ to: '2027-03-07', origin: 'person' });
    const changes = await call('owner', {
      method: 'GET',
      url: `/api/v1/plans/${plans.Fill}/scenarios/${sid}/changes`,
    });
    expect(
      (changes.changes as { ticketId: number; origin: string }[]).find(
        (c) => c.ticketId === t.c4?.id,
      )?.origin,
    ).toBe('person');
    // A Timeline resize resends the other day unchanged: that one becomes the person's too.
    await call('owner', {
      method: 'PUT',
      url: `/api/v1/plans/${plans.Fill}/scenarios/${sid}/drafts`,
      payload: {
        changes: [{ ticketId: t.c2?.id, startDate: '2027-03-16', dueDate: '2027-03-21' }],
      },
    });
    expect((await drafts(sid)).get(t.c2?.id as number)?.dueDate).toMatchObject({
      to: '2027-03-21',
      origin: 'person',
    });
    // The re-run keeps c4 from 26 Feb to 7 Mar, so c1, which it blocks, starts after 7 Mar.
    const again = await schedule('owner', 'Fill', { into: { scenarioId: sid }, from: FROM });
    expect(entry(again, t.c4 as Ticket)).toMatchObject({ outcome: 'kept', reason: 'person_draft' });
    expect(entry(again, t.c1 as Ticket)?.outcome).toBe('placed');
    const timeline = await call('owner', {
      method: 'GET',
      url: `/api/v1/plans/${plans.Fill}/timeline?scenario=${sid}`,
    });
    const items = new Map(
      (
        timeline.items as {
          id: number;
          start: string | null;
          due: string | null;
          draft?: { origin: string };
        }[]
      ).map((i) => [i.id, i]),
    );
    expect(items.get(t.c4?.id as number)).toMatchObject({
      start: '2027-02-26',
      due: '2027-03-07',
      draft: { origin: 'person' },
    });
    expect(timeline.links).toHaveLength(1);
    for (const l of timeline.links as { from: number; to: number }[]) {
      const blocker = items.get(l.from);
      const blocked = items.get(l.to);
      expect((blocked?.start ?? '') > (blocker?.due ?? '')).toBe(true);
    }
  });

  let priv = 0;

  it('[PLN-004] [PLN-006] (2) (3) (4) keeps, leaves out and does not place by rule, and never names a hidden blocker', async () => {
    const base = (
      await call(
        'owner',
        {
          method: 'POST',
          url: `/api/v1/plans/${plans.Private}/scenarios`,
          payload: { name: 'Base' },
        },
        201,
      )
    ).scenario.id as number;
    await call('owner', {
      method: 'PUT',
      url: `/api/v1/plans/${plans.Private}/scenarios/${base}/drafts`,
      payload: {
        changes: [{ ticketId: t.d6?.id, startDate: '2027-03-01', dueDate: '2027-03-10' }],
      },
    });
    const res = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Private}/schedule`,
      payload: {
        into: { newScenario: { name: 'Private run', from: base } },
        from: FROM,
        keep: { query: `key = "${t.d5?.key}"` },
        leaveOut: {
          typeIds: [bug],
          releaseIds: [],
          query: `key = "${t.d9?.key}"`,
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const run = res.json() as Run;
    priv = run.scenario.id;
    const of = (k: string) => entry(run, t[k] as Ticket);
    expect(of('d1')).toMatchObject({ outcome: 'not_placed', reason: 'hidden_blocker', args: {} });
    expect(of('d2')).toMatchObject({ outcome: 'not_placed', reason: 'hidden_blocker', args: {} });
    expect(of('d3')).toMatchObject({ outcome: 'kept', reason: 'in_progress' });
    expect(of('d4')).toMatchObject({ outcome: 'kept', reason: 'in_sprint' });
    expect(of('d5')).toMatchObject({ outcome: 'kept', reason: 'kept_by_query' });
    expect(of('d6')).toMatchObject({ outcome: 'kept', reason: 'person_draft' });
    expect(of('v1')).toMatchObject({ outcome: 'kept', reason: 'may_not_schedule' });
    expect(of('e1')).toMatchObject({ outcome: 'not_placed', reason: 'no_estimate' });
    expect(of('e2')).toMatchObject({ outcome: 'not_placed', reason: 'no_assignee' });
    expect(of('e3')).toMatchObject({
      outcome: 'not_placed',
      reason: 'no_team',
      args: { userId: user('u9') },
    });
    expect(of('e4')).toMatchObject({
      reason: 'cycle',
      args: { ticketIds: [t.e5?.id], size: 2 },
    });
    expect(of('e5')?.reason).toBe('cycle');
    expect(of('p3')).toMatchObject({ reason: 'blocker_not_placed', args: { blockerId: t.d1?.id } });
    expect(of('p1')?.outcome).toBe('placed');
    // Placed after the drafted ticket ends; a warning for its release, two days before its due.
    expect(of('p1')?.warnings).toEqual([
      {
        kind: 'after_release',
        args: { releaseId: release, releaseDate: '2027-03-05', days: 2 },
      },
    ]);
    expect(of('p2')).toMatchObject({
      outcome: 'placed',
      reason: 'after_blocker',
      args: { blockerId: t.d6?.id, blockerEnd: '2027-03-10' },
    });
    expect(await days(priv, t.p2 as Ticket)).toEqual(['2027-03-11', '2027-03-14']);
    // Left out: counted, never listed.
    for (const k of ['d7', 'd9', 'top']) expect(of(k)).toBeUndefined();
    expect(run.counts.leftOut).toMatchObject({ type: 1, query: 1, level: 1 });
    // Not placed tickets come first, then placed with a warning, kept, placed.
    const order = run.tickets.map((e) =>
      e.outcome === 'not_placed' ? 0 : e.outcome === 'placed' ? (e.warnings.length ? 1 : 3) : 2,
    );
    expect(order).toEqual([...order].sort());
    // Only placed tickets have drafts from the run; d6 keeps the person's.
    const written = await drafts(priv);
    const scheduled = [...written.entries()]
      .filter(([, d]) => Object.values(d).some((f) => f.origin === 'scheduler'))
      .map(([id]) => id)
      .sort((a, b) => a - b);
    expect(scheduled).toEqual([t.d8?.id, t.p1?.id, t.p2?.id].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(written.get(t.d6?.id as number)?.dueDate?.origin).toBe('person');
    // Nothing of the hidden ticket: its key, words, days or id.
    const body = res.body;
    for (const word of [...SENTINEL_WORDS, ...SENTINEL_DAYS, t.h1?.key, t.h2?.key])
      expect(body).not.toContain(word);
    const hidden = [t.h1?.id, t.h2?.id, t.o1?.id];
    for (const e of run.tickets) {
      expect(hidden).not.toContain(e.id);
      const named = [e.args.blockerId, e.args.ticketId, ...((e.args.ticketIds as number[]) ?? [])];
      for (const id of named) expect(hidden).not.toContain(id);
    }
    // A release left out by the run: its ticket is not listed either.
    const again = await schedule('owner', 'Private', {
      into: { scenarioId: priv },
      from: FROM,
      leaveOut: { releaseIds: [release] },
    });
    expect(again.counts.leftOut.release).toBe(2);
    expect(entry(again, t.p1 as Ticket)).toBeUndefined();
    expect(await days(priv, t.p1 as Ticket)).toBeNull();
  });

  it('[PLN-004] [QRY-008] a second editor who sees less replaces only the proposals on tickets they are shown', async () => {
    // A site administrator sees every track: the hidden tickets are placed, d1 after h1.
    const all = await schedule('admin', 'Private', { into: { scenarioId: priv }, from: FROM });
    expect(entry(all, t.h2 as Ticket)?.outcome).toBe('placed');
    expect(entry(all, t.d1 as Ticket)?.outcome).toBe('placed');
    expect(await days(priv, t.d1 as Ticket)).not.toBeNull();
    // The owner's run leaves the two hidden proposals, counted, and withdraws d1's.
    const res = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Private}/schedule`,
      payload: { into: { scenarioId: priv }, from: FROM },
    });
    expect(res.statusCode, res.body).toBe(200);
    const run = res.json() as Run;
    expect(run.counts.notShown).toBe(2);
    expect(entry(run, t.d1 as Ticket)?.reason).toBe('hidden_blocker');
    expect(await days(priv, t.d1 as Ticket)).toBeNull();
    expect(await days(priv, t.h1 as Ticket)).not.toBeNull();
    expect(await days(priv, t.h2 as Ticket)).not.toBeNull();
    for (const word of [...SENTINEL_WORDS, ...SENTINEL_DAYS, t.h1?.key, t.h2?.key])
      expect(res.body).not.toContain(word);
    const ready = await readiness('owner', 'Private', `?scenario=${priv}`);
    expect(ready.scenario?.notShown).toBe(2);
    // Anyone else who sees the plan may read readiness, never run it.
    const refused = await as('ana', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Private}/schedule`,
      payload: { into: { scenarioId: priv } },
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'forbidden', permission: 'edit_plan' });
  });

  it('[PLN-004] answers a plan or scenario it may not see as a missing id, word for word', async () => {
    const missing = await as('ana', {
      method: 'POST',
      url: '/api/v1/plans/999999/schedule',
      payload: { into: { scenarioId: 1 } },
    });
    expect(missing.statusCode).toBe(404);
    for (const res of [
      await as('ana', {
        method: 'POST',
        url: `/api/v1/plans/${plans.Bulk}/schedule`,
        payload: { into: { scenarioId: 1 } },
      }),
      await as('ana', { method: 'GET', url: `/api/v1/plans/${plans.Bulk}/schedule` }),
      await as('owner', {
        method: 'POST',
        url: `/api/v1/plans/${plans.Bulk}/schedule`,
        payload: { into: { scenarioId: priv } },
      }),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.body).toBe(missing.body);
    }
  });

  it('[PLN-004] refuses bad choices, conditions that do not compile, and a scenario being applied', async () => {
    const bad = async (payload: Record<string, unknown>) => {
      const res = await as('owner', {
        method: 'POST',
        url: `/api/v1/plans/${plans.Accept}/schedule`,
        payload,
      });
      expect(res.statusCode, res.body).toBe(400);
      return res.json();
    };
    expect(Object.keys((await bad({ into: { scenarioId: auto }, periods: 13 })).fields)).toEqual([
      'periods',
    ]);
    expect(
      Object.keys(
        (
          await bad({
            into: { scenarioId: auto },
            leaveOut: { typeIds: Array.from({ length: 21 }, (_, i) => i + 1) },
          })
        ).fields,
      ),
    ).toEqual(['leaveOut.typeIds']);
    expect(Object.keys((await bad({ into: { newScenario: { name: '' } } })).fields)).toEqual([
      'into.newScenario.name',
    ]);
    const query = await bad({
      into: { scenarioId: auto },
      keep: { query: 'summary ~~ (' },
      leaveOut: { query: 'nosuchfield = 3' },
    });
    expect(query).toMatchObject({
      error: 'invalid_fields',
      fields: { 'keep.query': 'invalid_query', 'leaveOut.query': 'invalid_query' },
    });
    expect(Object.keys(query.messages)).toEqual(['leaveOut.query', 'keep.query']);
    expect((await bad({ into: { newScenario: { name: 'X', from: priv } } })).fields).toEqual({
      'into.newScenario.from': 'not_found',
    });
    await database.db
      .updateTable('plan_scenario')
      .set({ applying_since: new Date() })
      .where('id', '=', auto)
      .execute();
    const busy = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Accept}/schedule`,
      payload: { into: { scenarioId: auto } },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'apply_in_progress' });
    // A hold ten minutes old is stale.
    await database.db
      .updateTable('plan_scenario')
      .set({ applying_since: new Date(Date.now() - 11 * 60_000) })
      .where('id', '=', auto)
      .execute();
    await schedule('owner', 'Accept', { into: { scenarioId: auto }, from: FROM });
  });

  it('[PLN-004] writes 2,500 placed tickets in chunks, and rolls back a run past 10,000 drafted tickets', async () => {
    const since = await lastEventId();
    const run = await schedule(
      'owner',
      'Bulk',
      { into: { newScenario: { name: 'Bulk' } }, from: FROM, periods: 1 },
      201,
    );
    expect(run.counts.placed).toBe(2_500);
    expect(run.tickets).toHaveLength(2_000);
    expect(run.more).toBe(500);
    const rows = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM plan_draft
       WHERE scenario_id = ${run.scenario.id} AND origin = 'scheduler'`.execute(database.db);
    expect(rows.rows[0]?.n).toBe(5_000);
    const set = await eventsOf('plan.drafts_set', since);
    expect(set).toHaveLength(5);
    for (const e of set) {
      const p = e.payload as { changes: unknown[]; removed: unknown[] };
      expect(p.changes.length + p.removed.length).toBeLessThanOrEqual(1_000);
    }
    // A scenario already holding 7,600 drafted tickets (outside the plan) cannot take 2,500 more.
    t.w0 = await ticket('SKW', 'Drafted elsewhere');
    const others = [t.w0.id, ...(await copies(t.w0, 7_599))];
    const full = (
      await call(
        'owner',
        { method: 'POST', url: `/api/v1/plans/${plans.Bulk}/scenarios`, payload: { name: 'Full' } },
        201,
      )
    ).scenario.id as number;
    await sql`
      INSERT INTO plan_draft (workspace_id, plan_id, scenario_id, ticket_id, field, new_value, updated_by)
      SELECT 1, ${plans.Bulk}, ${full}, x, 'dueDate', '"2027-08-01"'::jsonb, ${user('owner')}
        FROM unnest(${others}::int[]) AS x`.execute(database.db);
    const before = await lastEventId();
    const res = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Bulk}/schedule`,
      payload: { into: { scenarioId: full }, from: FROM, periods: 1 },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: 'too_many_drafts', limit: 10_000 });
    const left = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM plan_draft WHERE scenario_id = ${full}`.execute(database.db);
    expect(left.rows[0]?.n).toBe(7_600);
    expect(await eventsOf('plan.schedule_ran', before)).toHaveLength(0);
    // At 20 scenarios a run cannot make another.
    await database.db
      .insertInto('plan_scenario')
      .values(
        Array.from({ length: 18 }, (_, i) => ({
          workspace_id: 1,
          plan_id: plans.Bulk as number,
          name: `Spare ${i}`,
          main: false,
          created_by: user('owner'),
        })),
      )
      .execute();
    const many = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Bulk}/schedule`,
      payload: { into: { newScenario: { name: 'One more' } }, from: FROM, periods: 1 },
    });
    expect(many.statusCode).toBe(409);
    expect(many.json()).toEqual({ error: 'too_many_scenarios', limit: 20 });
  }, 120_000);

  it('[PLN-004] refuses more than 10,000 tickets to move and a plan of more than 50,000 open tickets', async () => {
    t.g0 = await ticket('SKG', 'Huge');
    await copies(t.g0, 10_000);
    plans.Huge = (
      await call(
        'owner',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: { name: 'Huge', sources: [{ kind: 'track', trackId: tracks.SKG }] },
        },
        201,
      )
    ).plan.id;
    const scenarios = async () =>
      Number(
        (
          await database.db
            .selectFrom('plan_scenario')
            .select((eb) => eb.fn.countAll<number>().as('n'))
            .where('plan_id', '=', plans.Huge as number)
            .executeTakeFirstOrThrow()
        ).n,
      );
    const tooMany = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Huge}/schedule`,
      payload: { into: { newScenario: { name: 'Huge run' } } },
    });
    expect(tooMany.statusCode, tooMany.body).toBe(409);
    expect(tooMany.json()).toEqual({ error: 'too_many_to_schedule', limit: 10_000, count: 10_001 });
    expect(await scenarios()).toBe(0);
    // 40,000 more, 10,000 a statement: one statement of 40,000 takes minutes.
    for (const tag of ['y', 'x', 'w', 'v']) await copies(t.g0, 10_000, tag);
    const large = await as('owner', {
      method: 'POST',
      url: `/api/v1/plans/${plans.Huge}/schedule`,
      payload: { into: { newScenario: { name: 'Huge run' } } },
    });
    expect(large.statusCode, large.body).toBe(409);
    expect(large.json()).toEqual({ error: 'plan_too_large', limit: 50_000 });
    expect(await scenarios()).toBe(0);
  }, 240_000);

  it('[PLN-004] diffs proposals against earlier ones: unchanged, rewritten, withdrawn, changed meanwhile', () => {
    const snap = (start: string | null, due: string | null, more: Partial<DaySnapshot> = {}) => ({
      start,
      due,
      ...more,
    });
    const read = new Map<number, DaySnapshot>([
      [1, snap(null, null)],
      [2, snap(null, '2027-04-30')],
      [3, snap(null, null)],
      [4, snap('2027-03-01', '2027-03-07')],
      [5, snap(null, null, { personDue: '2027-03-21' })],
      [6, snap(null, null)],
    ]);
    const locked = new Map(read);
    locked.set(6, snap(null, '2027-05-05'));
    type Was = { was: string | null; to: string };
    const earlier = new Map<number, Map<string, Was>>([
      [
        1,
        new Map([
          ['startDate', { was: null, to: '2027-03-01' }],
          ['dueDate', { was: null, to: '2027-03-07' }],
        ]),
      ],
      [2, new Map([['dueDate', { was: null, to: '2027-03-07' }]])],
      [3, new Map([['dueDate', { was: null, to: '2027-03-14' }]])],
      [4, new Map([['dueDate', { was: '2027-03-07', to: '2027-03-21' }]])],
      [5, new Map([['startDate', { was: null, to: '2027-03-15' }]])],
      [7, new Map([['dueDate', { was: null, to: '2027-03-14' }]])],
    ]);
    const out = diffProposals({
      proposals: [
        { id: 1, start: '2027-03-01', due: '2027-03-07' },
        { id: 2, start: '2027-03-01', due: '2027-03-07' },
        { id: 4, start: '2027-03-01', due: '2027-03-07' },
        { id: 6, start: '2027-03-01', due: '2027-03-07' },
      ],
      read,
      locked,
      earlier,
    });
    // 1 is unchanged; 2 is rewritten from the live day; 4 is already so, its earlier proposal
    // removed; 3 and 7 were not placed: theirs go; 5 keeps its own beside a person's draft.
    expect([...out.unchanged]).toEqual([1]);
    expect(out.writes).toEqual([
      { ticketId: 2, field: 'startDate', value: '2027-03-01', live: null },
      { ticketId: 2, field: 'dueDate', value: '2027-03-07', live: '2027-04-30' },
    ]);
    expect(out.clears).toEqual([
      { ticketId: 4, field: 'dueDate' },
      { ticketId: 3, field: 'dueDate' },
      { ticketId: 7, field: 'dueDate' },
    ]);
    expect([...out.meanwhile]).toEqual([6]);
    expect([...out.placed].sort()).toEqual([1, 2, 4]);
  });
});
