import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql, type Transaction } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { refusalOf } from '../plans/drafts';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-scenario-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.89.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Change {
  ticketId: number;
  key: string;
  summary: string;
  state: 'ready' | 'changed' | 'already' | 'refused';
  fields: {
    field: string;
    was: string | number | null;
    now: string | number | null;
    draft: string | number | null;
    state: string;
  }[];
  mayApply: boolean;
  needs: string | null;
  refusal: { reason: string; permission?: string } | null;
  updatedBy: { id: number; name: string };
}
interface ChangeList {
  changes: Change[];
  counts: Record<string, number>;
  drafts: number;
  notShown: number;
  next: number | null;
}
interface Scenario {
  id: number;
  name: string;
  main: boolean;
  drafts: number;
  notShown: number;
  version: number;
}
interface Cell {
  count: number;
  cards?: number[];
  drafts?: number;
  clause?: null;
}

const SENTINEL_DAYS = ['2027-06-17', '2027-06-18'];
const SENTINEL_WORDS = ['Hidden sentinel work', 'Requested sentinel'];

/**
 * Scenarios and draft changes (T-089e; PLN-002, PLN-003; ADR-122 stage 6). A plan over SCA, SCB
 * and SCG, owned by the site administrator and shared with everyone, planning with Red and Blue
 * by one-week periods from Monday 1 March 2027. Ana is a member of SCA only, so SCB's "Hidden
 * sentinel work" is never hers to see; Cy sees the plan and none of its tracks; Gil sees one SCG
 * ticket only because he asked for it (a ticket-level grant), never the track. Ed owns a plan of
 * his own over SCA (Members) and SCB (Viewers: no "Schedule tickets").
 */
describe('plan scenarios and draft changes (PLN-002, PLN-003)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const teams: Record<string, number> = {};
  const roles: Record<string, number> = {};
  type Ticket = { id: number; key: string };
  const t = {} as Record<
    'alpha' | 'beta' | 'gamma' | 'hidden' | 'billing' | 'requested' | 'elsewhere',
    Ticket
  > &
    Record<string, Ticket | undefined>;
  let planId = 0;
  let edPlanId = 0;
  let fieldId = 0;
  let squadId = 0;
  let boardId = 0;
  let feature = 0;

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
  const plan = (id = planId) => `/api/v1/plans/${id}`;
  const scen = (sid: number, rest = '', id = planId) => `${plan(id)}/scenarios/${sid}${rest}`;
  const makeScenario = async (who: string, name: string, extra = {}, id = planId) =>
    (await call(
      who,
      { method: 'POST', url: `${plan(id)}/scenarios`, payload: { name, ...extra } },
      201,
    )) as { scenario: Scenario; left: { notShown: number } };
  const draft = (who: string, sid: number, changes: unknown[], code = 200, id = planId) =>
    call(who, { method: 'PUT', url: scen(sid, '/drafts', id), payload: { changes } }, code);
  const changes = async (who: string, sid: number, query = '', id = planId) =>
    (await call(who, { method: 'GET', url: `${scen(sid, '/changes', id)}${query}` })) as ChangeList;
  const apply = (
    who: string,
    sid: number,
    payload: Record<string, unknown>,
    code = 200,
    id = planId,
  ) => call(who, { method: 'POST', url: scen(sid, '/apply', id), payload }, code);
  const live = async (id: number) =>
    database.db
      .selectFrom('ticket')
      .select([
        sql<string | null>`start_date::text`.as('start'),
        sql<string | null>`due_date::text`.as('due'),
        'fields',
        'version',
      ])
      .where('id', '=', id)
      .executeTakeFirstOrThrow();
  const patchTicket = async (who: string, key: string, payload: Record<string, unknown>) =>
    call(who, { method: 'PATCH', url: `/api/v1/tickets/${key}`, payload });
  const searchCount = async (who: string, q: string): Promise<number> =>
    (await call(who, { method: 'POST', url: '/api/v1/search', payload: { q, count: true } })).total
      .count;
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
    ).ticket as { id: number; key: string };
  const team = (name: string) => ({ fields: { [String(fieldId)]: teams[name] } });
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
  const role = (name: string) => roles[name] as number;
  /** The worker's part: events to the audit log. */
  async function relay(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'plan-scenarios-test');
    bus.attach(runner);
    for (let i = 0; i < 50; i++) {
      const relayed = await bus.relayOnce();
      const ran = await runner.runOnce();
      if (relayed === 0 && ran === 0) break;
    }
  }
  const member = (who: string, track: string, roleName: string) =>
    database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[track] as number,
        role_id: role(roleName),
        user_id: users[who]?.id as number,
      })
      .execute();
  /**
   * Holds a lock on a ticket's row while `during` runs: a ticket change waiting on it is blocked
   * in its transaction, after the apply has read the ticket, until the lock is let go.
   */
  async function whileTicketLocked(
    ticketId: number,
    during: (trx: Transaction<Database>) => Promise<void>,
    start: () => Promise<unknown>,
  ) {
    let started: Promise<unknown> = Promise.resolve();
    await database.db.transaction().execute(async (trx) => {
      await trx.selectFrom('ticket').select('id').where('id', '=', ticketId).forUpdate().execute();
      const holder = (await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(trx))
        .rows[0]?.pid;
      started = start();
      // Wait until a backend waits on this transaction's lock: the apply's ticket change. Only
      // this one: every other test file shares the cluster, and its backends wait on their own.
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
      ['ana', false],
      ['cy', false],
      ['gil', false],
      ['ed', false],
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
    for (const r of await database.db.selectFrom('role').select(['id', 'name']).execute()) {
      roles[r.name] = r.id;
    }
    feature = (
      await database.db
        .selectFrom('ticket_type')
        .select('id')
        .where('name', '=', 'Feature')
        .where('owner_track_id', 'is', null)
        .executeTakeFirstOrThrow()
    ).id;
    for (const [key, name] of [
      ['SCA', 'Apps'],
      ['SCB', 'Billing'],
      ['SCG', 'Desk'],
      ['SCE', 'Elsewhere'],
    ] as const) {
      tracks[key] = (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
          201,
        )
      ).track.id;
    }
    await member('ana', 'SCA', 'Members');
    await member('ed', 'SCA', 'Members');
    await member('ed', 'SCB', 'Viewers');
    // SCG lets its members, and requesters for their own tickets, see its work (a desk's).
    const policy = await database.db
      .insertInto('access_policy')
      .values({ workspace_id: 1, name: 'Requesters see their own' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('access_grant')
      .values([
        ...(['browse_track', 'schedule_tickets', 'edit_tickets', 'create_tickets'] as const).map(
          (permission) => ({
            workspace_id: 1,
            policy_id: policy.id,
            permission,
            grantee: 'role' as const,
            role_id: role('Administrators'),
          }),
        ),
        { workspace_id: 1, policy_id: policy.id, permission: 'browse_track', grantee: 'requester' },
      ])
      .execute();
    await database.db
      .updateTable('track')
      .set({ access_policy_id: policy.id })
      .where('id', '=', tracks.SCG as number)
      .execute();
    for (const name of ['Red', 'Blue']) {
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
    // A second Team field that applies only to SCA's tickets.
    squadId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/fields',
          payload: {
            name: 'Squad',
            type: 'team',
            context: { name: 'Apps only', trackIds: [tracks.SCA] },
          },
        },
        201,
      )
    ).field.id;
    t.alpha = await ticket('SCA', 'Alpha', {
      startDate: '2027-03-01',
      dueDate: '2027-03-05',
      ...team('Red'),
    });
    t.beta = await ticket('SCA', 'Beta', { dueDate: '2027-03-10', ...team('Blue') });
    t.gamma = await ticket('SCA', 'Gamma');
    for (let i = 1; i <= 10; i++) {
      t[`batch${i}`] = await ticket('SCA', `Batch ${i}`, { dueDate: '2027-05-03' });
    }
    t.hidden = await ticket('SCB', 'Hidden sentinel work', {
      dueDate: '2027-03-04',
      ...team('Red'),
    });
    t.billing = await ticket('SCB', 'Billing work', { dueDate: '2027-03-04' });
    t.requested = await ticket('SCG', 'Requested sentinel', { dueDate: '2027-03-04' });
    await database.db
      .updateTable('ticket')
      .set({ requester_id: users.gil?.id as number })
      .where('id', '=', t.requested.id)
      .execute();
    t.elsewhere = await ticket('SCE', 'Elsewhere work', { dueDate: '2027-03-04' });
    planId = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: {
            name: 'Spring',
            sources: ['SCA', 'SCB', 'SCG'].map((k) => ({ kind: 'track', trackId: tracks[k] })),
            shares: [{ scope: 'any_user' }],
          },
        },
        201,
      )
    ).plan.id;
    await call('admin', {
      method: 'PATCH',
      url: plan(),
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
          url: `${plan()}/program-boards`,
          payload: { name: 'Spring board', teamFieldId: fieldId, from: '2027-03-01', periods: 4 },
        },
        201,
      )
    ).board.id;
    edPlanId = (
      await call(
        'ed',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: {
            name: 'Ed’s',
            sources: ['SCA', 'SCB'].map((k) => ({ kind: 'track', trackId: tracks[k] })),
          },
        },
        201,
      )
    ).plan.id;
    // A track Ed may not see joins his plan through an administrator: its drafts are hidden from him.
    await call('admin', {
      method: 'PATCH',
      url: plan(edPlanId),
      payload: {
        sources: ['SCA', 'SCB', 'SCE'].map((k) => ({ kind: 'track', trackId: tracks[k] })),
      },
    });
  }, 240_000);
  afterAll(async () => {
    await app.close();
  });

  let faster: Scenario;

  it('[PLN-002] drafts days and Team values without changing the ticket: no history, event or change log', async () => {
    const made = await makeScenario('admin', 'Faster');
    faster = made.scenario;
    // The first scenario of a plan is its main one.
    expect(faster).toMatchObject({ name: 'Faster', main: true, drafts: 0, notShown: 0 });
    const before = await live(t.alpha.id);
    const since = await lastEventId();
    const changesBefore = await database.db
      .selectFrom('ticket_change')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('ticket_id', '=', t.alpha.id)
      .executeTakeFirstOrThrow();
    const logBefore = await database.db
      .selectFrom('change_log')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('entity', '=', 'ticket')
      .where('entity_id', '=', t.alpha.id)
      .executeTakeFirstOrThrow();
    const written = (await draft('admin', faster.id, [
      { ticketId: t.alpha.id, dueDate: '2027-03-12', fields: { [String(fieldId)]: teams.Blue } },
      { ticketId: t.hidden.id, dueDate: SENTINEL_DAYS[0] },
      { ticketId: t.requested.id, dueDate: SENTINEL_DAYS[1] },
    ])) as ChangeList;
    expect(written.changes.map((c) => c.key)).toEqual([t.alpha.key, t.hidden.key, t.requested.key]);
    const alpha = written.changes[0] as Change;
    expect(alpha.state).toBe('ready');
    expect(alpha.fields).toEqual([
      {
        field: `cf:${fieldId}`,
        teamFieldId: fieldId,
        was: teams.Red,
        now: teams.Red,
        draft: teams.Blue,
        state: 'ready',
      },
      {
        field: 'dueDate',
        teamFieldId: null,
        was: '2027-03-05',
        now: '2027-03-05',
        draft: '2027-03-12',
        state: 'ready',
      },
    ]);
    expect(alpha.updatedBy.id).toBe(users.admin?.id);
    // The ticket is untouched: same values and version, no history, no event, no change log.
    expect(await live(t.alpha.id)).toEqual(before);
    const ticketView = (
      await call('admin', { method: 'GET', url: `/api/v1/tickets/${t.alpha.key}` })
    ).ticket;
    expect(ticketView).toMatchObject({ dueDate: '2027-03-05', version: before.version });
    expect(
      (
        await database.db
          .selectFrom('ticket_change')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('ticket_id', '=', t.alpha.id)
          .executeTakeFirstOrThrow()
      ).n,
    ).toBe(changesBefore.n);
    expect(
      (
        await database.db
          .selectFrom('change_log')
          .select((eb) => eb.fn.countAll<string>().as('n'))
          .where('entity', '=', 'ticket')
          .where('entity_id', '=', t.alpha.id)
          .executeTakeFirstOrThrow()
      ).n,
    ).toBe(logBefore.n);
    expect((await eventsOf('ticket.updated', since)).length).toBe(0);
    const set = await eventsOf('plan.drafts_set', since);
    expect(set).toHaveLength(1);
    expect(set[0]?.payload).toMatchObject({
      scenarioId: faster.id,
      origin: 'person',
      removed: [],
      changes: expect.arrayContaining([
        { ticketId: t.alpha.id, field: 'dueDate', from: '2027-03-05', to: '2027-03-12' },
        { ticketId: t.alpha.id, field: `cf:${fieldId}`, from: teams.Red, to: teams.Blue },
      ]),
    });
    // Audited, as the plan's content others see.
    await relay();
    const audited = await database.db
      .selectFrom('audit_event')
      .select('action')
      .where('action', '=', 'plan.drafts_set')
      .execute();
    expect(audited.length).toBeGreaterThan(0);
  });

  it('[PLN-002] shows drafted values on the Timeline, the Calendar, Capacity and a board with the scenario, and live ones without it', async () => {
    const s = `scenario=${faster.id}`;
    const item = (body: { items: { id: number; due: string | null; draft?: unknown }[] }) =>
      body.items.find((i) => i.id === t.alpha.id);
    const liveTimeline = await call('admin', { method: 'GET', url: `${plan()}/timeline` });
    expect(item(liveTimeline)).toMatchObject({ due: '2027-03-05' });
    expect(item(liveTimeline)?.draft).toBeUndefined();
    expect(liveTimeline.scenario).toBeUndefined();
    const drafted = await call('admin', { method: 'GET', url: `${plan()}/timeline?${s}` });
    expect(item(drafted)).toMatchObject({
      due: '2027-03-12',
      start: '2027-03-01',
      draft: {
        dueDate: { now: '2027-03-05' },
        fields: { [String(fieldId)]: { now: teams.Red } },
        stale: false,
      },
    });
    expect(drafted.scenario).toEqual({
      id: faster.id,
      name: 'Faster',
      main: true,
      drafts: 3,
      notShown: 0,
    });

    const calendar = (q: string) =>
      call('admin', { method: 'GET', url: `${plan()}/calendar?from=2027-03-08&to=2027-03-14${q}` });
    const ids = (body: { tickets: { id: number }[] }) => body.tickets.map((x) => x.id);
    expect(ids(await calendar(''))).not.toContain(t.alpha.id);
    const inScenario = await calendar(`&${s}`);
    expect(ids(inScenario)).toContain(t.alpha.id);
    expect(inScenario.tickets.find((x: { id: number }) => x.id === t.alpha.id)).toMatchObject({
      due: '2027-03-12',
      draft: { dueDate: { now: '2027-03-05' } },
    });

    const capacity = (q: string) =>
      call('admin', { method: 'GET', url: `${plan()}/capacity?from=2027-03-01&periods=4${q}` });
    const liveCapacity = await capacity('');
    const draftedCapacity = await capacity(`&${s}`);
    const cells = (body: { unassigned: { cells: Cell[] } }) => body.unassigned.cells;
    // Alpha moves from the first week to the second; the hidden tickets' drafts move what is
    // shown only to those who see them, and leave the window here.
    expect(cells(draftedCapacity)[1]?.count).toBe((cells(liveCapacity)[1]?.count ?? 0) + 1);
    expect(cells(draftedCapacity)[1]).toMatchObject({ drafts: 1, clause: null });
    expect(cells(draftedCapacity)[0]?.drafts).toBeGreaterThanOrEqual(1);
    for (const cell of cells(liveCapacity)) expect(cell.drafts).toBeUndefined();
    expect(cells(draftedCapacity)[3]).not.toHaveProperty('drafts');

    const board = async (q: string) =>
      (await call('admin', { method: 'GET', url: `${plan()}/program-boards/${boardId}?${q}` })) as {
        rows: {
          team: { id: number } | null;
          clause: string | null;
          unscheduled: Cell;
          cells: Cell[];
        }[];
        cards: { id: number; due: string | null; team: { id: number } | null; draft?: unknown }[];
        query: string;
        clause: string;
        periods: { clause: string }[];
      };
    const rowOf = (b: Awaited<ReturnType<typeof board>>, teamId: number | undefined) =>
      b.rows.find((r) => r.team?.id === teamId);
    const liveBoard = await board('');
    expect(rowOf(liveBoard, teams.Red)?.cells[0]?.cards).toContain(t.alpha.id);
    const draftedBoard = await board(s);
    expect(rowOf(draftedBoard, teams.Red)?.cells[0]?.cards).not.toContain(t.alpha.id);
    expect(rowOf(draftedBoard, teams.Blue)?.cells[1]?.cards).toContain(t.alpha.id);
    expect(rowOf(draftedBoard, teams.Blue)?.cells[1]).toMatchObject({ drafts: 1, clause: null });
    expect(rowOf(draftedBoard, teams.Red)?.cells[0]).toMatchObject({ clause: null });
    expect(draftedBoard.cards.find((c) => c.id === t.alpha.id)).toMatchObject({
      due: '2027-03-12',
      team: { id: teams.Blue },
      draft: { stale: false },
    });
    // Every cell a draft does not touch still equals its search.
    for (const row of draftedBoard.rows) {
      for (const [i, cell] of row.cells.entries()) {
        if (cell.clause === null) continue;
        const q = [
          `(${draftedBoard.query})`,
          draftedBoard.clause,
          row.clause,
          draftedBoard.periods[i]?.clause,
        ]
          .filter(Boolean)
          .join(' AND ');
        expect(await searchCount('admin', q), q).toBe(cell.count);
      }
    }
    // A scenario missing or of another plan is refused, and the page shows the plan live.
    const other = (await makeScenario('ed', 'Ed’s main', {}, edPlanId)).scenario;
    for (const id of [999_999, other.id]) {
      const res = await as('admin', { method: 'GET', url: `${plan()}/timeline?scenario=${id}` });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: 'invalid_fields', fields: { scenario: 'not_found' } });
    }
  });

  it('[PLN-002] removes a draft set back to live; marks changed since drafted, already so and Keep my draft', async () => {
    // Back to Red, its live value: the Team draft goes, the due day stays.
    const back = (await draft('admin', faster.id, [
      { ticketId: t.alpha.id, fields: { [String(fieldId)]: teams.Red } },
    ])) as ChangeList;
    expect(back.changes[0]?.fields.map((f) => f.field)).toEqual(['dueDate']);
    // Someone changes Alpha's due day meanwhile.
    await patchTicket('admin', t.alpha.key, { dueDate: '2027-03-06' });
    let list = await changes('admin', faster.id);
    const alpha = () => list.changes.find((c) => c.ticketId === t.alpha.id) as Change;
    expect(alpha().state).toBe('changed');
    expect(alpha().fields[0]).toMatchObject({
      was: '2027-03-05',
      now: '2027-03-06',
      draft: '2027-03-12',
      state: 'changed',
    });
    expect(
      (await changes('admin', faster.id, '?only=changed')).changes.map((c) => c.ticketId),
    ).toEqual([t.alpha.id]);
    const timeline = await call('admin', {
      method: 'GET',
      url: `${plan()}/timeline?scenario=${faster.id}`,
    });
    expect(timeline.items.find((i: { id: number }) => i.id === t.alpha.id).draft.stale).toBe(true);
    // The same value again leaves the draft as it was, still changed since drafted.
    await draft('admin', faster.id, [{ ticketId: t.alpha.id, dueDate: '2027-03-12' }]);
    list = await changes('admin', faster.id);
    expect(alpha().state).toBe('changed');
    // Keep my draft: the same value again takes the live value as the value when drafted.
    await call('admin', {
      method: 'PUT',
      url: scen(faster.id, '/drafts'),
      payload: { keep: true, changes: [{ ticketId: t.alpha.id, dueDate: '2027-03-12' }] },
    });
    list = await changes('admin', faster.id);
    expect(alpha().state).toBe('ready');
    expect(alpha().fields[0]).toMatchObject({
      was: '2027-03-06',
      now: '2027-03-06',
      draft: '2027-03-12',
    });
    // Already so: Beta is drafted, then changed live to the drafted day.
    await draft('admin', faster.id, [{ ticketId: t.beta.id, dueDate: '2027-03-11' }]);
    await patchTicket('admin', t.beta.key, { dueDate: '2027-03-11' });
    list = await changes('admin', faster.id);
    expect(list.changes.find((c) => c.ticketId === t.beta.id)?.state).toBe('already');
    expect(list.counts).toMatchObject({ ready: 3, already: 1, changed: 0, refused: 0 });
    // Ready lists those that would apply, already so included.
    expect((await changes('admin', faster.id, '?only=ready')).changes).toHaveLength(4);
  });

  it('[PLN-002] checks drafts: the plan’s tickets only, days in order, Team fields and teams, 200 a request', async () => {
    const res = await as('admin', {
      method: 'PUT',
      url: scen(faster.id, '/drafts'),
      payload: {
        changes: [
          { ticketId: t.elsewhere.id, dueDate: '2027-03-01' },
          { ticketId: 999_999, dueDate: '2027-03-01' },
          { ticketId: t.gamma.id, fields: { [String(fieldId)]: 999_999 } },
          { ticketId: t.beta.id, fields: { '999999': teams.Red } },
        ],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'invalid_fields',
      fields: {
        // A ticket outside the plan answers word for word as one that does not exist.
        'changes.0.ticketId': 'not_found',
        'changes.1.ticketId': 'not_found',
        [`changes.2.fields.${fieldId}`]: 'not_found',
        'changes.3.fields.999999': 'not_a_team_field',
      },
    });
    // Alpha starts on 1 March live: a due day before it is out of order, as is a later start.
    const order = await as('admin', {
      method: 'PUT',
      url: scen(faster.id, '/drafts'),
      payload: { changes: [{ ticketId: t.alpha.id, dueDate: '2027-02-20' }] },
    });
    expect(order.json()).toEqual({
      error: 'invalid_fields',
      fields: { 'changes.0.startDate': 'start_after_due' },
    });
    const many = await as('admin', {
      method: 'PUT',
      url: scen(faster.id, '/drafts'),
      payload: {
        changes: Array.from({ length: 201 }, (_, i) => ({
          ticketId: i + 1,
          dueDate: '2027-03-01',
        })),
      },
    });
    expect(many.statusCode).toBe(400);
    expect(Object.keys(many.json().fields)).toEqual(['changes']);
    // Nothing of a refused request was written.
    expect((await changes('admin', faster.id)).changes.map((c) => c.ticketId)).not.toContain(
      t.gamma.id,
    );
  });

  it('[PLN-002] applies 3 of 10 tickets’ drafts: exactly those change, as the applier, and the rest stay', async () => {
    const batch = Array.from(
      { length: 10 },
      (_, i) => t[`batch${i + 1}`] as { id: number; key: string },
    );
    await draft(
      'admin',
      faster.id,
      batch.map((b, i) => ({
        ticketId: b.id,
        dueDate: `2027-05-${String(10 + i).padStart(2, '0')}`,
      })),
    );
    const since = await lastEventId();
    const chosen = batch.slice(0, 3);
    const result = await apply('admin', faster.id, { tickets: chosen.map((b) => b.id) });
    expect(result).toEqual({
      applied: chosen.map((b) => ({ ticketId: b.id, key: b.key })),
      refused: [],
      next: null,
      notShown: 0,
    });
    for (const [i, b] of batch.entries()) {
      expect((await live(b.id)).due).toBe(i < 3 ? `2027-05-${10 + i}` : '2027-05-03');
    }
    const history = await database.db
      .selectFrom('ticket_change')
      .select(['ticket_id', 'actor_id', 'field'])
      .where(
        'ticket_id',
        'in',
        chosen.map((b) => b.id),
      )
      .where('field', '=', 'dueDate')
      .where('from_value', '=', '2027-05-03')
      .execute();
    expect(history).toHaveLength(3);
    expect(new Set(history.map((h) => h.actor_id))).toEqual(new Set([users.admin?.id]));
    const updated = await eventsOf('ticket.updated', since);
    expect(updated.map((e) => Number(e.subject_id)).sort((a, b) => a - b)).toEqual(
      chosen.map((b) => b.id),
    );
    const committed = await eventsOf('plan.drafts_committed', since);
    expect(committed).toHaveLength(1);
    expect(committed[0]?.payload).toEqual({
      scenarioId: faster.id,
      applied: chosen.map((b) => ({ ticketId: b.id, key: b.key })),
      refused: [],
      notShown: 0,
    });
    // The applier follows each ticket changed, as any edit does.
    const follows = await database.db
      .selectFrom('ticket_follower')
      .select('ticket_id')
      .where('user_id', '=', users.admin?.id as number)
      .where(
        'ticket_id',
        'in',
        chosen.map((b) => b.id),
      )
      .execute();
    expect(follows).toHaveLength(3);
    const left = (await changes('admin', faster.id)).changes.map((c) => c.ticketId);
    for (const b of batch.slice(3)) expect(left).toContain(b.id);
    for (const b of chosen) expect(left).not.toContain(b.id);
  });

  it('[PLN-002] applies all, a page at a time with a cursor', async () => {
    // Enough drafted tickets for two pages of 100.
    const extra: { id: number }[] = [];
    for (let i = 0; i < 95; i++)
      extra.push(await ticket('SCA', `Paged ${i}`, { dueDate: '2027-07-01' }));
    for (let i = 0; i < extra.length; i += 50) {
      await draft(
        'admin',
        faster.id,
        extra.slice(i, i + 50).map((x) => ({ ticketId: x.id, dueDate: '2027-07-02' })),
      );
    }
    const pending = (await changes('admin', faster.id)).drafts;
    expect(pending).toBeGreaterThan(100);
    // Alpha is set aside first: it must not apply in this test.
    await call('admin', {
      method: 'POST',
      url: scen(faster.id, '/discard'),
      payload: { tickets: [t.alpha.id, t.beta.id, t.hidden.id, t.requested.id] },
    });
    const first = await apply('admin', faster.id, { all: true });
    expect(first.applied.length + first.refused.length).toBe(100);
    expect(first.next).toEqual(expect.any(Number));
    const second = await apply('admin', faster.id, { all: true, after: first.next });
    expect(second.next).toBeNull();
    expect(first.applied.length + second.applied.length).toBe(pending - 4);
    expect((await changes('admin', faster.id)).drafts).toBe(0);
    expect((await live(extra[0]?.id as number)).due).toBe('2027-07-02');
  });

  it('[PLN-002] refuses a ticket with its reason and goes on with the rest: permission, field lock, gone, changed meanwhile and not valid', async () => {
    const edMain = (await call('ed', { method: 'GET', url: `${plan(edPlanId)}/scenarios` }))
      .scenarios[0] as Scenario;
    // Ed may schedule in SCA, not in SCB.
    await draft(
      'ed',
      edMain.id,
      [
        { ticketId: t.gamma.id, dueDate: '2027-04-01' },
        { ticketId: t.billing.id, dueDate: '2027-04-02' },
      ],
      200,
      edPlanId,
    );
    const listed = await changes('ed', edMain.id, '', edPlanId);
    expect(listed.changes.find((c) => c.ticketId === t.billing.id)).toMatchObject({
      mayApply: false,
      needs: 'schedule_tickets',
    });
    expect(listed.changes.find((c) => c.ticketId === t.gamma.id)?.mayApply).toBe(true);
    // An administrator drafts a ticket of SCE in Ed's plan, a track Ed may not see.
    await draft(
      'admin',
      edMain.id,
      [{ ticketId: t.elsewhere.id, dueDate: '2027-04-03' }],
      200,
      edPlanId,
    );
    // A ticket drafted, then put in the trash.
    const trashed = await ticket('SCA', 'Trashed later', { dueDate: '2027-03-02' });
    await draft('ed', edMain.id, [{ ticketId: trashed.id, dueDate: '2027-04-04' }], 200, edPlanId);
    await call('admin', { method: 'DELETE', url: `/api/v1/tickets/${trashed.key}` }, 204);
    // Hidden, trashed and never drafted answer alike, without a key.
    const result = await apply(
      'ed',
      edMain.id,
      {
        tickets: [t.gamma.id, t.billing.id, t.elsewhere.id, trashed.id, t.beta.id],
      },
      200,
      edPlanId,
    );
    expect(result.applied).toEqual([{ ticketId: t.gamma.id, key: t.gamma.key }]);
    expect(result.refused).toEqual(
      [
        {
          ticketId: t.billing.id,
          key: t.billing.key,
          reason: 'no_permission',
          permission: 'schedule_tickets',
        },
        { ticketId: t.elsewhere.id, key: null, reason: 'gone' },
        { ticketId: trashed.id, key: null, reason: 'gone' },
        { ticketId: t.beta.id, key: null, reason: 'gone' },
      ].sort((a, b) => a.ticketId - b.ticketId),
    );
    expect(result.notShown).toBe(2);
    // The refusal is kept and listed later; the draft stays pending.
    const after = await changes('ed', edMain.id, '?only=refused', edPlanId);
    expect(after.changes.map((c) => c.ticketId)).toEqual([t.billing.id]);
    expect(after.changes[0]?.refusal).toMatchObject({
      reason: 'no_permission',
      permission: 'schedule_tickets',
    });
    expect(after.notShown).toBe(2);

    // Not valid: Squad applies only to SCA's tickets.
    await draft('admin', faster.id, [
      { ticketId: t.hidden.id, fields: { [String(squadId)]: teams.Red } },
    ]);
    // Changed meanwhile: Alpha drafted, then changed live.
    await draft('admin', faster.id, [{ ticketId: t.alpha.id, dueDate: '2027-03-15' }]);
    await patchTicket('admin', t.alpha.key, { dueDate: '2027-03-07' });
    const refused = await apply('admin', faster.id, { tickets: [t.alpha.id, t.hidden.id] });
    expect(refused.applied).toEqual([]);
    expect(refused.refused).toEqual([
      {
        ticketId: t.alpha.id,
        key: t.alpha.key,
        reason: 'changed_meanwhile',
        now: { dueDate: '2027-03-07' },
      },
      expect.objectContaining({
        ticketId: t.hidden.id,
        key: t.hidden.key,
        reason: 'invalid',
        fields: expect.any(Object),
      }),
    ]);
    expect((await live(t.hidden.id)).due).toBe('2027-03-04');
    await call('admin', {
      method: 'POST',
      url: scen(faster.id, '/discard'),
      payload: { all: true },
    });
  });

  it('[PLN-002] [WF-007] refuses a ticket whose field only some may set (a field lock)', async () => {
    const group = await call(
      'admin',
      { method: 'POST', url: '/api/v1/groups', payload: { name: 'Planners' } },
      201,
    );
    const rules = await call(
      'admin',
      {
        method: 'POST',
        url: '/api/v1/field-rule-sets',
        payload: {
          name: 'Planners date SCA',
          rules: [{ field: 'dueDate', editableBy: [{ groupId: group.group.id }] }],
        },
      },
      201,
    );
    await call('admin', {
      method: 'PATCH',
      url: `/api/v1/tracks/${tracks.SCA}`,
      payload: { fieldRuleSetId: rules.fieldRuleSet.id },
    });
    try {
      await draft('admin', faster.id, [{ ticketId: t.gamma.id, dueDate: '2027-04-20' }]);
      const result = await apply('admin', faster.id, { tickets: [t.gamma.id] });
      expect(result.refused).toEqual([
        expect.objectContaining({
          ticketId: t.gamma.id,
          reason: 'locked',
          locks: [expect.objectContaining({ by: 'field', field: 'dueDate' })],
        }),
      ]);
      const listed = (await changes('admin', faster.id)).changes;
      expect(listed.find((c) => c.ticketId === t.gamma.id)?.refusal).toMatchObject({
        reason: 'locked',
      });
    } finally {
      await call('admin', {
        method: 'PATCH',
        url: `/api/v1/tracks/${tracks.SCA}`,
        payload: { fieldRuleSetId: null },
      });
      await call('admin', {
        method: 'POST',
        url: scen(faster.id, '/discard'),
        payload: { all: true },
      });
    }
  });

  it('[PLN-002] gives each ticket route answer its reason', () => {
    expect(refusalOf(403, { error: 'forbidden', permission: 'schedule_tickets' })).toEqual({
      reason: 'no_permission',
      permission: 'schedule_tickets',
    });
    expect(
      refusalOf(403, { error: 'forbidden', permission: 'edit', locks: [{ by: 'status' }] }),
    ).toEqual({ reason: 'locked', permission: 'edit', locks: [{ by: 'status' }] });
    expect(refusalOf(409, { error: 'track_archived' })).toEqual({ reason: 'track_archived' });
    expect(refusalOf(404, { error: 'not_found' })).toEqual({ reason: 'gone' });
    expect(refusalOf(409, { error: 'in_trash' })).toEqual({ reason: 'gone' });
    expect(refusalOf(409, { error: 'version_conflict' })).toEqual({ reason: 'changed_meanwhile' });
    expect(refusalOf(409, { error: 'moved_meanwhile' })).toEqual({ reason: 'changed_meanwhile' });
    expect(
      refusalOf(400, { error: 'invalid_fields', fields: { 'fields.3': 'not_applicable' } }),
    ).toEqual({ reason: 'invalid', fields: { 'fields.3': 'not_applicable' } });
    expect(refusalOf(500, null)).toEqual({ reason: 'failed' });
  });

  it('[PLN-002] a version raced during the apply is changed meanwhile; a draft changed during an apply stays', async () => {
    await draft('admin', faster.id, [{ ticketId: t.gamma.id, dueDate: '2027-04-21' }]);
    const gammaDue = (await live(t.gamma.id)).due;
    let raced: { refused: { reason: string; now?: unknown }[] } | undefined;
    await whileTicketLocked(
      t.gamma.id,
      async (trx) => {
        // Someone renames Gamma: a new version, the drafted day untouched.
        await sql`UPDATE ticket SET version = version + 1, summary = 'Gamma, renamed' WHERE id = ${t.gamma.id}`.execute(
          trx,
        );
      },
      async () => {
        raced = await apply('admin', faster.id, { tickets: [t.gamma.id] });
      },
    ).then((p) => p);
    expect(raced?.refused).toEqual([
      {
        ticketId: t.gamma.id,
        key: t.gamma.key,
        reason: 'changed_meanwhile',
        now: { dueDate: gammaDue },
      },
    ]);
    // The next apply uses the live version: an unrelated change never blocks a plan.
    expect((await apply('admin', faster.id, { tickets: [t.gamma.id] })).applied).toHaveLength(1);
    expect((await live(t.gamma.id)).due).toBe('2027-04-21');

    // During an apply someone drafts the same field again: the new draft stays.
    await draft('admin', faster.id, [{ ticketId: t.gamma.id, dueDate: '2027-04-22' }]);
    let applied: { applied: unknown[] } | undefined;
    await whileTicketLocked(
      t.gamma.id,
      async (trx) => {
        await sql`UPDATE plan_draft SET new_value = '"2027-04-23"'::jsonb
                   WHERE scenario_id = ${faster.id} AND ticket_id = ${t.gamma.id}`.execute(trx);
      },
      async () => {
        applied = await apply('admin', faster.id, { tickets: [t.gamma.id] });
      },
    ).then((p) => p);
    expect(applied?.applied).toHaveLength(1);
    expect((await live(t.gamma.id)).due).toBe('2027-04-22');
    const left = await changes('admin', faster.id);
    expect(left.changes.find((c) => c.ticketId === t.gamma.id)?.fields[0]?.draft).toBe(
      '2027-04-23',
    );
    await call('admin', {
      method: 'POST',
      url: scen(faster.id, '/discard'),
      payload: { all: true },
    });
  });

  it('[PLN-002] holds one apply at a time; a stale hold and an apply stopped halfway are finished by the next', async () => {
    await draft('admin', faster.id, [{ ticketId: t.gamma.id, dueDate: '2027-04-24' }]);
    await database.db
      .updateTable('plan_scenario')
      .set({ applying_since: new Date() })
      .where('id', '=', faster.id)
      .execute();
    const busy = await as('admin', {
      method: 'POST',
      url: scen(faster.id, '/apply'),
      payload: { all: true },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toEqual({ error: 'apply_in_progress' });
    expect((await changes('admin', faster.id)).changes).toHaveLength(1);
    // Ten minutes on, the hold is stale. A server stopped after changing the ticket left the draft:
    // its value is live now, so the next apply takes it as already so, without a new change.
    await database.db
      .updateTable('plan_scenario')
      .set({ applying_since: new Date(Date.now() - 11 * 60_000) })
      .where('id', '=', faster.id)
      .execute();
    await patchTicket('admin', t.gamma.key, { dueDate: '2027-04-24' });
    const since = await lastEventId();
    const done = await apply('admin', faster.id, { all: true });
    expect(done.applied).toEqual([{ ticketId: t.gamma.id, key: t.gamma.key }]);
    expect(await eventsOf('ticket.updated', since)).toHaveLength(0);
    expect((await changes('admin', faster.id)).changes).toHaveLength(0);
    const row = await database.db
      .selectFrom('plan_scenario')
      .select('applying_since')
      .where('id', '=', faster.id)
      .executeTakeFirstOrThrow();
    expect(row.applying_since).toBeNull();
  });

  it('[PLN-002] [QRY-008] shows drafts only on tickets the plan shows each viewer, and counts the rest', async () => {
    await draft('admin', faster.id, [
      { ticketId: t.alpha.id, dueDate: '2027-03-19' },
      { ticketId: t.hidden.id, dueDate: SENTINEL_DAYS[0] },
      { ticketId: t.requested.id, dueDate: SENTINEL_DAYS[1] },
    ]);
    const s = `scenario=${faster.id}`;
    const reads = (who: string) =>
      Promise.all([
        as(who, { method: 'GET', url: `${plan()}/scenarios` }),
        as(who, { method: 'GET', url: scen(faster.id, '/changes') }),
        as(who, { method: 'GET', url: `${plan()}/timeline?${s}` }),
        as(who, { method: 'GET', url: `${plan()}/calendar?from=2027-06-01&to=2027-06-30&${s}` }),
        as(who, { method: 'GET', url: `${plan()}/capacity?from=2027-06-07&periods=4&${s}` }),
        as(who, { method: 'GET', url: `${plan()}/program-boards/${boardId}?${s}` }),
        as(who, { method: 'GET', url: `${plan()}/compare?a=live&b=${faster.id}` }),
      ]);
    const expected: Record<string, { drafts: number; notShown: number }> = {
      admin: { drafts: 3, notShown: 0 },
      ana: { drafts: 1, notShown: 2 },
      cy: { drafts: 0, notShown: 3 },
      gil: { drafts: 0, notShown: 3 },
    };
    for (const [who, counts] of Object.entries(expected)) {
      const answers = await reads(who);
      for (const res of answers)
        expect(res.statusCode, `${who} ${res.body.slice(0, 300)}`).toBe(200);
      const [list, changeList, timeline] = answers.map((r) => r.json());
      expect(list.scenarios.find((x: Scenario) => x.id === faster.id)).toMatchObject(counts);
      expect(changeList).toMatchObject({ drafts: counts.drafts, notShown: counts.notShown });
      expect(timeline.scenario).toMatchObject(counts);
      if (who === 'admin') {
        expect(answers.map((r) => r.body).join('\n')).toContain(SENTINEL_DAYS[0]);
        continue;
      }
      for (const res of answers) {
        for (const sentinel of [...SENTINEL_DAYS, ...SENTINEL_WORDS]) {
          expect(res.body, `${who} ${res.raw.req.url}`).not.toContain(sentinel);
        }
        expect(res.body).not.toContain(t.hidden.key);
        expect(res.body).not.toContain(t.requested.key);
      }
    }
    // Writes are for the plan's editors: everyone else gets `edit_plan`, whatever they see.
    const writes: InjectOptions[] = [
      { method: 'POST', url: `${plan()}/scenarios`, payload: { name: 'Mine' } },
      { method: 'PATCH', url: scen(faster.id), payload: { name: 'Mine', version: 1 } },
      { method: 'DELETE', url: `${scen(faster.id)}?version=1` },
      { method: 'POST', url: scen(faster.id, '/promote'), payload: { version: 1 } },
      {
        method: 'PUT',
        url: scen(faster.id, '/drafts'),
        payload: { changes: [{ ticketId: t.alpha.id, dueDate: '2027-03-01' }] },
      },
      { method: 'POST', url: scen(faster.id, '/discard'), payload: { all: true } },
      { method: 'POST', url: scen(faster.id, '/apply'), payload: { all: true } },
    ];
    for (const who of ['ana', 'cy', 'gil']) {
      for (const w of writes) {
        const res = await as(who, w);
        expect(res.statusCode, `${who} ${w.method} ${w.url}`).toBe(403);
        expect(res.json()).toEqual({ error: 'forbidden', permission: 'edit_plan' });
      }
    }
    // A plan the person may not see, and another plan's scenario, answer as a missing id.
    const missing = await as('ana', { method: 'GET', url: '/api/v1/plans/999999/scenarios' });
    const hidden = await as('ana', { method: 'GET', url: `${plan(edPlanId)}/scenarios` });
    expect(hidden.statusCode).toBe(404);
    expect(hidden.body).toBe(missing.body);
    const edMain = (await call('ed', { method: 'GET', url: `${plan(edPlanId)}/scenarios` }))
      .scenarios[0] as Scenario;
    const elsewhere = await as('admin', { method: 'GET', url: scen(edMain.id, '/changes') });
    const none = await as('admin', { method: 'GET', url: scen(999_999, '/changes') });
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.body).toBe(none.body);
    // An editor discards everything they are shown: drafts on tickets hidden from them stay,
    // counted (in Ed's plan, one on a track he may not see and one on a ticket in the trash).
    const edHidden = await changes('ed', edMain.id, '', edPlanId);
    const discarded = await call('ed', {
      method: 'POST',
      url: scen(edMain.id, '/discard', edPlanId),
      payload: { all: true },
    });
    expect(discarded).toEqual({ discarded: edHidden.drafts, notShown: edHidden.notShown });
    const kept = await changes('admin', edMain.id, '', edPlanId);
    expect(kept.drafts + kept.notShown).toBe(edHidden.notShown);
    expect(kept.drafts).toBe(1);
  });

  it('[PLN-002] [QRY-008] counts with no search are only those a draft touches; every other equals its search, for each viewer', async () => {
    for (const who of ['admin', 'ana']) {
      const b = await call(who, {
        method: 'GET',
        url: `${plan()}/program-boards/${boardId}?scenario=${faster.id}`,
      });
      let linked = 0;
      for (const row of b.rows as { clause: string | null; unscheduled: Cell; cells: Cell[] }[]) {
        const all: [string, Cell][] = [
          [b.unscheduledClause, row.unscheduled],
          ...row.cells.map((c, i): [string, Cell] => [b.periods[i]?.clause, c]),
        ];
        for (const [column, cell] of all) {
          if (cell.clause === null) {
            expect(cell.drafts, who).toBeGreaterThan(0);
            continue;
          }
          const q = [`(${b.query})`, b.clause, row.clause, column].filter(Boolean).join(' AND ');
          expect(await searchCount(who, q), `${who}: ${q}`).toBe(cell.count);
          linked++;
        }
      }
      expect(linked).toBeGreaterThan(0);
    }
  });

  it('[PLN-003] compares two scenarios by the plan’s end and each team’s end, and lists the tickets that differ', async () => {
    await call('admin', {
      method: 'POST',
      url: scen(faster.id, '/discard'),
      payload: { all: true },
    });
    const slower = (await makeScenario('admin', 'Slower')).scenario;
    expect(slower.main).toBe(false);
    // Faster gives Beta to Red and ends it early; Slower keeps Beta with Blue and ends it late.
    await draft('admin', faster.id, [
      { ticketId: t.beta.id, dueDate: '2027-03-09', fields: { [String(fieldId)]: teams.Red } },
    ]);
    await draft('admin', slower.id, [{ ticketId: t.beta.id, dueDate: '2027-09-30' }]);
    const compared = await call('admin', {
      method: 'GET',
      url: `${plan()}/compare?a=${faster.id}&b=${slower.id}&track=SCA`,
    });
    expect(compared.teamField).toEqual({ id: fieldId, name: 'Team' });
    expect(compared.a.scenario).toMatchObject({ id: faster.id, name: 'Faster', drafts: 1 });
    expect(compared.b.end).toMatchObject({
      due: '2027-09-30',
      ticket: { id: t.beta.id, key: t.beta.key },
    });
    expect(compared.a.end.due).not.toBe(compared.b.end.due);
    expect(compared.a.end.undated).toBe(compared.b.end.undated);
    const blue = (side: { teams: { team: { id: number } | null; due: string | null }[] }) =>
      side.teams.find((x) => x.team?.id === teams.Blue)?.due ?? null;
    expect(blue(compared.b)).toBe('2027-09-30');
    expect(blue(compared.a)).not.toBe('2027-09-30');
    expect(compared.later).toBe(1);
    expect(compared.earlier).toBe(0);
    expect(compared.differing).toEqual({
      count: 1,
      tickets: [
        {
          id: t.beta.id,
          key: t.beta.key,
          summary: 'Beta',
          a: { start: null, due: '2027-03-09', team: teams.Red },
          b: { start: null, due: '2027-09-30', team: teams.Blue },
        },
      ],
    });
    // Against the tickets as they are.
    const live_ = await call('admin', {
      method: 'GET',
      url: `${plan()}/compare?a=live&b=${slower.id}`,
    });
    expect(live_.a.scenario).toBeNull();
    expect(live_.later).toBe(1);
    const bad = await as('admin', { method: 'GET', url: `${plan()}/compare?a=live&b=999999` });
    expect(bad.json()).toEqual({ error: 'invalid_fields', fields: { b: 'not_found' } });
  });

  it('[PLN-003] makes another scenario main: its drafts apply, and the former main keeps its own', async () => {
    const list = (await call('admin', { method: 'GET', url: `${plan()}/scenarios` }))
      .scenarios as Scenario[];
    const slower = list.find((x) => x.name === 'Slower') as Scenario;
    const since = await lastEventId();
    const promoted = await call('admin', {
      method: 'POST',
      url: scen(slower.id, '/promote'),
      payload: { version: slower.version },
    });
    expect(promoted.scenarios.map((x: Scenario) => [x.name, x.main])).toEqual([
      ['Slower', true],
      ['Faster', false],
    ]);
    expect((await eventsOf('plan.scenario_promoted', since))[0]?.payload).toEqual({
      scenarioId: slower.id,
      formerMain: faster.id,
    });
    // The former main keeps its drafts, and may no longer be applied from.
    expect((await changes('admin', faster.id)).drafts).toBe(1);
    const notMain = await as('admin', {
      method: 'POST',
      url: scen(faster.id, '/apply'),
      payload: { all: true },
    });
    expect(notMain.statusCode).toBe(409);
    expect(notMain.json()).toEqual({ error: 'not_main' });
    const done = await apply('admin', slower.id, { all: true });
    expect(done.applied).toEqual([{ ticketId: t.beta.id, key: t.beta.key }]);
    expect((await live(t.beta.id)).due).toBe('2027-09-30');
    // Faster's draft on Beta now reads as changed since drafted.
    expect((await changes('admin', faster.id)).changes[0]?.state).toBe('changed');
  });

  it('[PLN-003] copies a scenario’s drafts its maker is shown and counts the rest; renames, deletes, limits', async () => {
    const edMain = (await call('ed', { method: 'GET', url: `${plan(edPlanId)}/scenarios` }))
      .scenarios[0] as Scenario;
    await draft('ed', edMain.id, [{ ticketId: t.gamma.id, dueDate: '2027-04-30' }], 200, edPlanId);
    const copy = await makeScenario('ed', 'Copy', { from: edMain.id }, edPlanId);
    expect(copy.scenario).toMatchObject({ main: false, drafts: 1 });
    expect(copy.left.notShown).toBe((await changes('ed', edMain.id, '', edPlanId)).notShown);
    expect(copy.left.notShown).toBeGreaterThan(0);
    // Rename with the version read; a stale one is refused.
    const renamed = await call('ed', {
      method: 'PATCH',
      url: scen(copy.scenario.id, '', edPlanId),
      payload: { name: 'Copied', version: copy.scenario.version },
    });
    expect(renamed.scenario).toMatchObject({ name: 'Copied', version: copy.scenario.version + 1 });
    const stale = await as('ed', {
      method: 'PATCH',
      url: scen(copy.scenario.id, '', edPlanId),
      payload: { name: 'Again', version: copy.scenario.version },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'version_conflict', version: copy.scenario.version + 1 });
    const staleDelete = await as('ed', {
      method: 'DELETE',
      url: `${scen(copy.scenario.id, '', edPlanId)}?version=${copy.scenario.version}`,
    });
    expect(staleDelete.statusCode).toBe(409);
    // Main goes last.
    const mainGone = await as('ed', {
      method: 'DELETE',
      url: `${scen(edMain.id, '', edPlanId)}?version=${edMain.version}`,
    });
    expect(mainGone.json()).toEqual({ error: 'main_scenario' });
    const since = await lastEventId();
    await call(
      'ed',
      {
        method: 'DELETE',
        url: `${scen(copy.scenario.id, '', edPlanId)}?version=${copy.scenario.version + 1}`,
      },
      204,
    );
    expect((await eventsOf('plan.scenario_deleted', since))[0]?.payload).toEqual({
      scenarioId: copy.scenario.id,
      name: 'Copied',
      drafts: 1,
    });
    // At most 20 scenarios a plan.
    const count = (await call('ed', { method: 'GET', url: `${plan(edPlanId)}/scenarios` }))
      .scenarios.length as number;
    for (let i = count; i < 20; i++) await makeScenario('ed', `Idea ${i}`, {}, edPlanId);
    const full = await as('ed', {
      method: 'POST',
      url: `${plan(edPlanId)}/scenarios`,
      payload: { name: 'One more' },
    });
    expect(full.statusCode).toBe(409);
    expect(full.json()).toEqual({ error: 'too_many_scenarios', limit: 20 });
    // At most 100 tickets an apply.
    const tooMany = await as('ed', {
      method: 'POST',
      url: scen(edMain.id, '/apply', edPlanId),
      payload: { tickets: Array.from({ length: 101 }, (_, i) => i + 1) },
    });
    expect(tooMany.statusCode).toBe(400);
    expect(Object.keys(tooMany.json().fields)).toEqual(['tickets']);
  });

  it('[PLN-002] holds at most 10,000 drafted tickets a scenario', async () => {
    const big = (await makeScenario('admin', 'Big')).scenario;
    // 10,000 drafts written straight to the table, on as many copies of Gamma.
    const columns = (
      await sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
         WHERE table_name = 'ticket' AND table_schema = 'public'
           AND column_name NOT IN ('id', 'number', 'rank', 'search_vector')
           AND is_generated = 'NEVER'`.execute(database.db)
    ).rows.map((r) => r.column_name);
    const list = sql.join(columns.map((c) => sql.ref(c)));
    const top = await sql<{
      n: number;
    }>`SELECT max(number)::int AS n FROM ticket WHERE track_id = ${tracks.SCA}`.execute(
      database.db,
    );
    const made = await sql<{ id: number }>`
      INSERT INTO ticket (number, rank, ${list})
      SELECT ${top.rows[0]?.n ?? 0} + g, rank || 'z' || lpad(g::text, 6, '0'), ${list}
        FROM ticket, generate_series(1, 10000) g
       WHERE id = ${t.gamma.id}
      RETURNING id`.execute(database.db);
    await sql`
      INSERT INTO plan_draft (workspace_id, plan_id, scenario_id, ticket_id, field, new_value, updated_by)
      SELECT 1, ${planId}, ${big.id}, x, 'dueDate', '"2027-08-01"'::jsonb, ${users.admin?.id}
        FROM unnest(${made.rows.map((r) => r.id)}::int[]) AS x`.execute(database.db);
    const res = await as('admin', {
      method: 'PUT',
      url: scen(big.id, '/drafts'),
      payload: { changes: [{ ticketId: t.alpha.id, dueDate: '2027-03-20' }] },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: 'too_many_drafts', limit: 10_000 });
    expect(
      await sql`SELECT 1 FROM plan_draft WHERE scenario_id = ${big.id} AND ticket_id = ${t.alpha.id}`
        .execute(database.db)
        .then((r) => r.rows),
    ).toEqual([]);
    // Deleting a scenario takes all its drafts.
    await call('admin', { method: 'DELETE', url: `${scen(big.id)}?version=${big.version}` }, 204);
    expect(
      (
        await sql<{
          n: number;
        }>`SELECT count(*)::int AS n FROM plan_draft WHERE scenario_id = ${big.id}`.execute(
          database.db,
        )
      ).rows[0]?.n,
    ).toBe(0);
    // 10,000 tickets take a while to write while every other test file runs beside this one.
  }, 180_000);

  it('[PLN-002] audits every scenario and draft event, with the plan as its subject', async () => {
    await relay();
    const actions = (
      await database.db
        .selectFrom('audit_event')
        .select('action')
        .where('action', 'like', 'plan.%')
        .execute()
    ).map((r) => r.action);
    for (const type of [
      'plan.scenario_created',
      'plan.scenario_updated',
      'plan.scenario_deleted',
      'plan.scenario_promoted',
      'plan.drafts_set',
      'plan.drafts_discarded',
      'plan.drafts_committed',
    ]) {
      expect(actions, type).toContain(type);
    }
  });

  it('[PLN-002] [PLN-003] answers an id beyond an int4 as a bad field, never as a database error', async () => {
    const compare = await as('admin', {
      method: 'GET',
      url: `${plan()}/compare?a=live&b=9999999999`,
    });
    expect(compare.statusCode, compare.body).toBe(400);
    expect(compare.json()).toEqual({ error: 'invalid_fields', fields: { b: 'too_large' } });
    const drafted = await as('admin', {
      method: 'PUT',
      url: scen(faster.id, '/drafts'),
      payload: { changes: [{ ticketId: t.alpha.id, fields: { '9999999999': teams.Red } }] },
    });
    expect(drafted.statusCode, drafted.body).toBe(400);
    expect(drafted.json().error).toBe('invalid_fields');
  });

  /** The plan's main scenario now. */
  const mainScenario = async () =>
    (
      (await call('admin', { method: 'GET', url: `${plan()}/scenarios` })).scenarios as Scenario[]
    ).find((x) => x.main) as Scenario;

  it('[PLN-002] keeps a drafted day sent again beside another change: still changed since drafted, never applied over that change', async () => {
    const main = await mainScenario();
    const ops = await ticket('SCB', 'Ops four', { startDate: '2027-11-01', dueDate: '2027-11-05' });
    await draft('admin', main.id, [
      { ticketId: ops.id, startDate: '2027-12-01', dueDate: '2027-12-10' },
    ]);
    // Someone else moves the start live.
    await patchTicket('admin', ops.key, { startDate: '2027-11-20' });
    // Only the bar's end moves in the scenario: the Timeline sends both days, the start as drafted.
    const since = await lastEventId();
    await draft('admin', main.id, [
      { ticketId: ops.id, startDate: '2027-12-01', dueDate: '2027-12-12' },
    ]);
    expect((await eventsOf('plan.drafts_set', since))[0]?.payload).toMatchObject({
      changes: [{ ticketId: ops.id, field: 'dueDate', from: '2027-12-10', to: '2027-12-12' }],
      removed: [],
    });
    const row = async () =>
      (await changes('admin', main.id)).changes.find((c) => c.ticketId === ops.id) as Change;
    const moved = await row();
    expect(moved.state).toBe('changed');
    expect(moved.fields).toEqual([
      expect.objectContaining({
        field: 'dueDate',
        was: '2027-11-05',
        draft: '2027-12-12',
        state: 'ready',
      }),
      expect.objectContaining({
        field: 'startDate',
        was: '2027-11-01',
        now: '2027-11-20',
        draft: '2027-12-01',
        state: 'changed',
      }),
    ]);
    // An apply refuses it, and the start stays as the other person set it.
    const refused = await apply('admin', main.id, { tickets: [ops.id] });
    expect(refused.refused).toEqual([
      {
        ticketId: ops.id,
        key: ops.key,
        reason: 'changed_meanwhile',
        now: { startDate: '2027-11-20', dueDate: '2027-11-05' },
      },
    ]);
    expect((await live(ops.id)).start).toBe('2027-11-20');
    // Keep my draft takes the start as it is now, and clears the refusal: then it applies.
    await call('admin', {
      method: 'PUT',
      url: scen(main.id, '/drafts'),
      payload: {
        keep: true,
        changes: [{ ticketId: ops.id, startDate: '2027-12-01', dueDate: '2027-12-12' }],
      },
    });
    expect(await row()).toMatchObject({ state: 'ready', refusal: null });
    const applied = await apply('admin', main.id, { tickets: [ops.id] });
    expect(applied.applied).toEqual([{ ticketId: ops.id, key: ops.key }]);
    expect(await live(ops.id)).toMatchObject({ start: '2027-12-01', due: '2027-12-12' });
  });

  /** Backends of this test's database waiting on a lock. */
  const waitingOnLocks = async () =>
    (
      await sql<{ n: number }>`
        SELECT count(*)::int AS n FROM pg_stat_activity
         WHERE wait_event_type = 'Lock' AND datname = current_database()`.execute(database.db)
    ).rows[0]?.n ?? 0;
  /**
   * Holds what `lock` takes in a transaction while `start` runs, until `waiters` backends wait on a
   * lock or what started has answered; then lets go and gives what started.
   */
  async function whileHolding<T>(
    lock: (trx: Transaction<Database>) => Promise<unknown>,
    start: () => Promise<T>,
    waiters: number,
  ): Promise<T> {
    let started: Promise<T> | undefined;
    await database.db.transaction().execute(async (trx) => {
      await lock(trx);
      let answered = false;
      started = start().finally(() => {
        answered = true;
      });
      for (let i = 0; i < 400 && !answered; i++) {
        if ((await waitingOnLocks()) >= waiters) break;
        await new Promise((r) => setTimeout(r, 25));
      }
    });
    return started as Promise<T>;
  }
  const newPlan = async (name: string) =>
    (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: { name, sources: [{ kind: 'track', trackId: tracks.SCB }] },
        },
        201,
      )
    ).plan.id as number;
  const scenariosOf = async (id: number) =>
    (await call('admin', { method: 'GET', url: `${plan(id)}/scenarios` })).scenarios as Scenario[];

  it('[PLN-003] makes one scenario main when two editors make different ones main at once', async () => {
    const race = await newPlan('Race');
    const first = (await makeScenario('admin', 'First', {}, race)).scenario;
    const b = (await makeScenario('admin', 'B', {}, race)).scenario;
    const c = (await makeScenario('admin', 'C', {}, race)).scenario;
    const promote = (s: Scenario) =>
      as('admin', {
        method: 'POST',
        url: scen(s.id, '/promote', race),
        payload: { version: s.version },
      });
    // Both wait on the main scenario's row; the second reads the main one the first committed.
    const answers = await whileHolding(
      (trx) =>
        trx
          .selectFrom('plan_scenario')
          .select('id')
          .where('id', '=', first.id)
          .forUpdate()
          .execute(),
      () => Promise.all([promote(b), promote(c)]),
      2,
    );
    expect(
      answers.map((r) => r.statusCode),
      answers.map((r) => r.body).join('\n'),
    ).toEqual([200, 200]);
    const mains = (await scenariosOf(race)).filter((x) => x.main);
    expect(mains).toHaveLength(1);
    expect([b.id, c.id]).toContain(mains[0]?.id);
  });

  it('[PLN-003] never leaves a plan without its main scenario when one is made as the main one goes', async () => {
    const lonely = await newPlan('Lonely');
    const only = (await makeScenario('admin', 'Only', {}, lonely)).scenario;
    expect(only.main).toBe(true);
    // A scenario being made: the plan's row taken and the new one written, not yet committed.
    const res = await whileHolding(
      async (trx) => {
        await trx
          .selectFrom('plan')
          .select('id')
          .where('id', '=', lonely)
          .forNoKeyUpdate()
          .execute();
        await trx
          .insertInto('plan_scenario')
          .values({
            workspace_id: 1,
            plan_id: lonely,
            name: 'Made meanwhile',
            main: false,
            created_by: users.admin?.id as number,
          })
          .execute();
      },
      () =>
        as('admin', {
          method: 'DELETE',
          url: `${scen(only.id, '', lonely)}?version=${only.version}`,
        }),
      1,
    );
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json()).toEqual({ error: 'main_scenario' });
    expect((await scenariosOf(lonely)).map((x) => [x.name, x.main])).toEqual([
      ['Only', true],
      ['Made meanwhile', false],
    ]);
  });

  it('[PLN-003] refuses deleting the main scenario, or making another main, while an apply holds it', async () => {
    const held = await newPlan('Held');
    const main = (await makeScenario('admin', 'Held main', {}, held)).scenario;
    const hold = (since: Date | null) =>
      database.db
        .updateTable('plan_scenario')
        .set({ applying_since: since })
        .where('id', '=', main.id)
        .execute();
    await hold(new Date());
    // The only scenario, held: deleting it would otherwise go.
    const gone = await as('admin', {
      method: 'DELETE',
      url: `${scen(main.id, '', held)}?version=${main.version}`,
    });
    expect(gone.statusCode).toBe(409);
    expect(gone.json()).toEqual({ error: 'apply_in_progress' });
    const other = (await makeScenario('admin', 'Other', {}, held)).scenario;
    const promoted = await as('admin', {
      method: 'POST',
      url: scen(other.id, '/promote', held),
      payload: { version: other.version },
    });
    expect(promoted.statusCode).toBe(409);
    expect(promoted.json()).toEqual({ error: 'apply_in_progress' });
    expect((await scenariosOf(held)).map((x) => [x.name, x.main])).toEqual([
      ['Held main', true],
      ['Other', false],
    ]);
    // Once the hold is stale, both go ahead.
    await hold(new Date(Date.now() - 11 * 60_000));
    await call('admin', {
      method: 'POST',
      url: scen(other.id, '/promote', held),
      payload: { version: other.version },
    });
  });

  it('[PLN-002] lets go only of its own hold: a hold taken after it, from a stale one, stays', async () => {
    const main = await mainScenario();
    const work = await ticket('SCB', 'Held work', { dueDate: '2027-10-01' });
    await draft('admin', main.id, [{ ticketId: work.id, dueDate: '2027-10-02' }]);
    // While this apply runs, another takes its hold, as one may once ten minutes have gone by.
    const other = new Date('2030-01-01T00:00:00Z');
    const result = (await whileTicketLocked(
      work.id,
      async (trx) => {
        await trx
          .updateTable('plan_scenario')
          .set({ applying_since: other })
          .where('id', '=', main.id)
          .execute();
      },
      () => apply('admin', main.id, { tickets: [work.id] }),
    )) as { applied: unknown[] };
    expect(result.applied).toEqual([{ ticketId: work.id, key: work.key }]);
    const row = await database.db
      .selectFrom('plan_scenario')
      .select('applying_since')
      .where('id', '=', main.id)
      .executeTakeFirstOrThrow();
    expect(row.applying_since).toEqual(other);
    // The other apply still holds it.
    const busy = await as('admin', {
      method: 'POST',
      url: scen(main.id, '/apply'),
      payload: { all: true },
    });
    expect(busy.json()).toEqual({ error: 'apply_in_progress' });
    await database.db
      .updateTable('plan_scenario')
      .set({ applying_since: null })
      .where('id', '=', main.id)
      .execute();
  });
  it('[PLN-002] moves no roll-up by a draft on a descendant the plan does not hold', async () => {
    const rollups = await newPlan('Roll-ups');
    const main = (await makeScenario('admin', 'Roll-up main', {}, rollups)).scenario;
    const typeOf = async (name: string) =>
      (
        await database.db
          .selectFrom('ticket_type')
          .select('id')
          .where('name', '=', name)
          .where('owner_track_id', 'is', null)
          .executeTakeFirstOrThrow()
      ).id;
    const goal = await ticket('SCB', 'Rolled-up goal', { ticketTypeId: await typeOf('Outcome') });
    // A child in SCE, a track the plan does not hold, which the administrator sees.
    const child = await ticket('SCE', 'Child elsewhere', {
      ticketTypeId: await typeOf('Feature'),
      parent: goal.key,
      dueDate: '2027-10-05',
    });
    // A draft left on it, as one is on a ticket that has since moved out of the plan's tracks.
    await sql`
      INSERT INTO plan_draft (workspace_id, plan_id, scenario_id, ticket_id, field, new_value, updated_by)
      VALUES (1, ${rollups}, ${main.id}, ${child.id}, 'dueDate', '"2027-12-31"'::jsonb, ${users.admin?.id})`.execute(
      database.db,
    );
    try {
      const rollup = async (q: string) =>
        (
          (await call('admin', { method: 'GET', url: `${plan(rollups)}/timeline${q}` })).items as {
            id: number;
            rollup: { due: string | null } | null;
          }[]
        ).find((i) => i.id === goal.id)?.rollup;
      expect(await rollup('')).toMatchObject({ due: '2027-10-05', total: 1 });
      expect(await rollup(`?scenario=${main.id}`)).toMatchObject({ due: '2027-10-05', total: 1 });
    } finally {
      await sql`DELETE FROM plan_draft WHERE ticket_id = ${child.id}`.execute(database.db);
    }
  });

  it('[PLN-002] writes nothing of a request with one bad change among good ones', async () => {
    const main = await mainScenario();
    const good = await ticket('SCB', 'Good change', {
      startDate: '2027-04-05',
      dueDate: '2027-04-09',
    });
    const late = await ticket('SCB', 'Out of order', {
      startDate: '2027-04-12',
      dueDate: '2027-04-16',
    });
    const drafted = async () =>
      (
        await database.db
          .selectFrom('plan_draft')
          .select('ticket_id')
          .where('scenario_id', '=', main.id)
          .where('ticket_id', 'in', [good.id, late.id])
          .execute()
      ).length;
    // A ticket that does not exist, checked before anything is written.
    const missing = await as('admin', {
      method: 'PUT',
      url: scen(main.id, '/drafts'),
      payload: {
        changes: [
          { ticketId: good.id, dueDate: '2027-04-20' },
          { ticketId: 999_999, dueDate: '2027-04-20' },
        ],
      },
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toEqual({
      error: 'invalid_fields',
      fields: { 'changes.1.ticketId': 'not_found' },
    });
    // Days out of order, checked as the drafts are written.
    const order = await as('admin', {
      method: 'PUT',
      url: scen(main.id, '/drafts'),
      payload: {
        changes: [
          { ticketId: good.id, dueDate: '2027-04-20' },
          { ticketId: late.id, dueDate: '2027-04-10' },
        ],
      },
    });
    expect(order.json()).toEqual({
      error: 'invalid_fields',
      fields: { 'changes.1.startDate': 'start_after_due' },
    });
    expect(await drafted()).toBe(0);
  });

  it('[PLN-002] checks a day’s order against the scenario’s draft of the other day, before the live one', async () => {
    const main = await mainScenario();
    const ordered = await ticket('SCB', 'Ordered', {
      startDate: '2027-03-01',
      dueDate: '2027-03-20',
    });
    await draft('admin', main.id, [{ ticketId: ordered.id, startDate: '2027-03-10' }]);
    // 5 March comes after the live start (1 March) but before the drafted one (10 March).
    const res = await as('admin', {
      method: 'PUT',
      url: scen(main.id, '/drafts'),
      payload: { changes: [{ ticketId: ordered.id, dueDate: '2027-03-05' }] },
    });
    expect(res.json()).toEqual({
      error: 'invalid_fields',
      fields: { 'changes.0.startDate': 'start_after_due' },
    });
    const row = (await changes('admin', main.id)).changes.find((c) => c.ticketId === ordered.id);
    expect(row?.fields.map((f) => [f.field, f.draft])).toEqual([['startDate', '2027-03-10']]);
  });

  it('[PLN-002] [PLN-005] keeps every Capacity number with a search equal to it in a scenario, for each viewer', async () => {
    const main = await mainScenario();
    const moved = await ticket('SCB', 'Moved in capacity', { dueDate: '2027-03-03' });
    await draft('admin', main.id, [{ ticketId: moved.id, dueDate: '2027-03-16' }]);
    let touched = 0;
    for (const who of ['admin', 'ana']) {
      const answer = await call(who, {
        method: 'GET',
        url: `${plan()}/capacity?from=2027-03-01&periods=4&scenario=${main.id}`,
      });
      type Row = { clause: string; cells: Cell[]; unscheduled: Cell };
      const rows: Row[] = [
        ...answer.teams.flatMap((team: Row & { members: Row[] }) => [team, ...team.members]),
        answer.unassigned,
        answer.others,
      ];
      let linked = 0;
      for (const row of rows) {
        const all: [string, Cell][] = [
          [answer.unscheduledClause, row.unscheduled],
          ...row.cells.map((c, i): [string, Cell] => [answer.periods[i]?.clause, c]),
        ];
        for (const [column, cell] of all) {
          if (cell.clause === null) {
            expect(cell.drafts, who).toBeGreaterThan(0);
            if (who === 'admin') touched++;
            continue;
          }
          expect(cell).not.toHaveProperty('drafts');
          const q = `(${answer.query}) AND ${row.clause} AND ${column}`;
          expect(await searchCount(who, q), `${who}: ${q}`).toBe(cell.count);
          linked++;
        }
      }
      expect(linked, who).toBeGreaterThan(0);
    }
    // The draft leaves the first week and joins the third: those two cells have no search.
    expect(touched).toBe(2);
  });

  it('[PLN-002] refuses a drafted ticket whose track is archived as gone, without its key', async () => {
    const track = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key: 'SCR', name: 'Retired', mode: 'shared' },
        },
        201,
      )
    ).track.id as number;
    const retired = await ticket('SCR', 'Retired work', { dueDate: '2027-05-03' });
    const archive = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/plans',
          payload: { name: 'Archive', sources: [{ kind: 'track', trackId: track }] },
        },
        201,
      )
    ).plan.id as number;
    const main = (await makeScenario('admin', 'Archive main', {}, archive)).scenario;
    await draft('admin', main.id, [{ ticketId: retired.id, dueDate: '2027-05-10' }], 200, archive);
    await call('admin', { method: 'POST', url: `/api/v1/tracks/${track}/archive` });
    const result = await apply('admin', main.id, { tickets: [retired.id] }, 200, archive);
    expect(result).toEqual({
      applied: [],
      refused: [{ ticketId: retired.id, key: null, reason: 'gone' }],
      next: null,
      notShown: 1,
    });
    expect((await live(retired.id)).due).toBe('2027-05-03');
  });
});
