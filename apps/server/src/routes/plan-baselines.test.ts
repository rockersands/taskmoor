import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';

// Made for this run: no password is written in the repository.
const PASSWORD = `plan-baseline-${randomBytes(18).toString('base64url')}`;
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

interface Baseline {
  id: number;
  name: string;
  source: 'live' | 'scenario';
  scenarioName: string | null;
  tickets: number;
  createdBy: { id: number; name: string };
  version: number;
}
interface Side {
  start: string | null;
  due: string | null;
  dated: 'own' | 'sprint' | null;
}
interface Compared {
  id: number;
  key: string;
  summary: string;
  closed: boolean;
  was: Side | null;
  now: Side;
  delay: number | null;
  startShift: number | null;
}
interface Comparison {
  baseline: { id: number; name: string; source: string; scenarioName: string | null };
  against: 'live' | { scenario: { id: number; name: string } };
  counts: Record<string, number>;
  mostLater: number | null;
  planEnd: { was: string | null; now: string | null; delay: number | null };
  tickets: Compared[];
  next: string | null;
}

const SENTINEL_DAYS = ['2027-06-17', '2027-06-18'];
const SENTINEL_WORDS = ['Hidden sentinel work', 'Requested sentinel'];

/**
 * Baselines of a plan (T-089a; PLN-011; ADR-122 stage 9). A plan over BLA, BLB and BLG, owned by
 * the site administrator and shared with everyone. Ana is a member of BLA only, so BLB's "Hidden
 * sentinel work" is never hers to see; Cy sees the plan and none of its tracks; Gil sees one BLG
 * ticket only because he asked for it (a ticket-level grant), never the track. BLA has a Scrum
 * board whose sprint, 1 to 14 March 2027, dates a ticket without days of its own.
 */
describe('plan baselines (PLN-011)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const roles: Record<string, number> = {};
  type Ticket = { id: number; key: string };
  const t = {} as Record<
    | 'alpha'
    | 'beta'
    | 'gamma'
    | 'sprinted'
    | 'monthEnd'
    | 'yearEnd'
    | 'closed'
    | 'dropped'
    | 'hidden'
    | 'requested'
    | 'added',
    Ticket
  >;
  let planId = 0;
  let privateId = 0;
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
  const capture = async (who: string, payload: Record<string, unknown>, id = planId) =>
    (await call(who, { method: 'POST', url: `${plan(id)}/baselines`, payload }, 201))
      .baseline as Baseline;
  const compare = async (who: string, bid: number, query = '', id = planId) =>
    (await call(who, {
      method: 'GET',
      url: `${plan(id)}/baselines/${bid}/compare${query}`,
    })) as Comparison;
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
  const setDays = (id: number, start: string | null, due: string | null) =>
    database.db
      .updateTable('ticket')
      .set({ start_date: start, due_date: due })
      .where('id', '=', id)
      .execute();
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
  /** Copies of a ticket written in one statement, for plans at size. */
  async function copies(template: Ticket, n: number, tag: string): Promise<number[]> {
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
  /** The worker's part: events to the audit log. */
  async function relay(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'plan-baselines-test');
    bus.attach(runner);
    for (let i = 0; i < 50; i++) {
      const relayed = await bus.relayOnce();
      const ran = await runner.runOnce();
      if (relayed === 0 && ran === 0) break;
    }
  }
  const trackPlan = async (name: string, keys: string[], shared = true) =>
    (
      await call(
        'admin',
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
    ).plan.id as number;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['ana', false],
      ['cy', false],
      ['gil', false],
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
      ['BLA', 'Apps'],
      ['BLB', 'Billing'],
      ['BLG', 'Desk'],
      ['BLP', 'Paging'],
    ] as const) {
      tracks[key] = (
        await call(
          'admin',
          { method: 'POST', url: '/api/v1/tracks', payload: { key, name, mode: 'shared' } },
          201,
        )
      ).track.id;
    }
    await member('ana', 'BLA', 'Members');
    // BLG lets its members, and requesters for their own tickets, see its work (a desk's).
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
      .where('id', '=', tracks.BLG as number)
      .execute();
    t.alpha = await ticket('BLA', 'Alpha', { startDate: '2027-03-01', dueDate: '2027-03-05' });
    t.beta = await ticket('BLA', 'Beta', { dueDate: '2027-03-10' });
    t.gamma = await ticket('BLA', 'Gamma');
    t.sprinted = await ticket('BLA', 'Sprinted');
    t.monthEnd = await ticket('BLA', 'Month end', { dueDate: '2027-01-30' });
    t.yearEnd = await ticket('BLA', 'Year end', { dueDate: '2026-12-30' });
    t.closed = await ticket('BLA', 'Closed one', { dueDate: '2027-03-03' });
    t.dropped = await ticket('BLA', 'Dropped', { dueDate: '2027-03-07' });
    t.hidden = await ticket('BLB', SENTINEL_WORDS[0] as string, { dueDate: SENTINEL_DAYS[0] });
    t.requested = await ticket('BLG', SENTINEL_WORDS[1] as string, { dueDate: SENTINEL_DAYS[1] });
    await database.db
      .updateTable('ticket')
      .set({ requester_id: users.gil?.id as number })
      .where('id', '=', t.requested.id)
      .execute();
    const closedStatus = await database.db
      .selectFrom('status')
      .select('id')
      .where('stage', '=', 'closed')
      .orderBy('id')
      .executeTakeFirstOrThrow();
    await database.db
      .updateTable('ticket')
      .set({ status_id: closedStatus.id })
      .where('id', '=', t.closed.id)
      .execute();
    const board = await database.db
      .insertInto('board')
      .values({
        workspace_id: 1,
        name: 'BLA scrum',
        kind: 'scrum',
        location_track_id: null,
        location_user_id: users.admin?.id as number,
        filter_query: 'track = BLA',
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
      .values({ workspace_id: 1, sprint_id: sprint.id, ticket_id: t.sprinted.id, open: true })
      .execute();
    planId = await trackPlan('Spring', ['BLA', 'BLB', 'BLG']);
    privateId = await trackPlan('Private', ['BLA'], false);
  }, 240_000);
  afterAll(async () => {
    await app.close();
  });

  let kickOff: Baseline;

  it('[PLN-011] captures a baseline from Live: own days, else the sprint’s, and closed ones', async () => {
    const since = await lastEventId();
    kickOff = await capture('admin', { name: '  Kick-off  ' });
    expect(kickOff).toMatchObject({
      name: 'Kick-off',
      source: 'live',
      scenarioName: null,
      tickets: 10,
      createdBy: { id: users.admin?.id, name: 'admin' },
      version: 1,
    });
    const rows = await database.db
      .selectFrom('plan_baseline_day')
      .select([
        'ticket_id',
        sql<string | null>`start_date::text`.as('start'),
        sql<string | null>`due_date::text`.as('due'),
        'dated',
        'closed',
      ])
      .where('baseline_id', '=', kickOff.id)
      .execute();
    const row = (id: number) => rows.find((r) => r.ticket_id === id);
    expect(rows).toHaveLength(10);
    expect(row(t.alpha.id)).toMatchObject({
      start: '2027-03-01',
      due: '2027-03-05',
      dated: 'own',
      closed: false,
    });
    expect(row(t.gamma.id)).toMatchObject({ start: null, due: null, dated: null });
    expect(row(t.sprinted.id)).toMatchObject({
      start: '2027-03-01',
      due: '2027-03-14',
      dated: 'sprint',
    });
    expect(row(t.closed.id)).toMatchObject({ due: '2027-03-03', closed: true });
    // Ids and counts only: never a name, a day or a key.
    expect((await eventsOf('plan.baseline_captured', since)).map((e) => e.payload)).toEqual([
      { baselineId: kickOff.id, source: 'live', tickets: 10 },
    ]);
    // Everyone who sees the plan reads the list; only its editors may change it.
    const list = await call('ana', { method: 'GET', url: `${plan()}/baselines` });
    expect(list).toMatchObject({
      editable: false,
      limits: { baselines: 10, tickets: 50_000, page: 200 },
    });
    expect(list.baselines.map((b: Baseline) => b.name)).toEqual(['Kick-off']);
    expect((await call('admin', { method: 'GET', url: `${plan()}/baselines` })).editable).toBe(
      true,
    );
  });

  it('[PLN-011] compares with the days now: delays in calendar days across a month’s and a year’s end, and every count', async () => {
    await setDays(t.alpha.id, '2027-03-01', '2027-03-21');
    await setDays(t.beta.id, null, '2027-03-08');
    await setDays(t.monthEnd.id, null, '2027-02-02');
    await setDays(t.yearEnd.id, null, '2027-01-04');
    await setDays(t.gamma.id, null, '2027-03-20');
    await setDays(t.dropped.id, null, null);
    t.added = await ticket('BLA', 'Added', { dueDate: '2027-03-25' });
    const c = await compare('admin', kickOff.id);
    expect(c.against).toBe('live');
    expect(c.baseline).toMatchObject({ id: kickOff.id, name: 'Kick-off', source: 'live' });
    expect(c.counts).toEqual({
      compared: 8,
      slipped: 3,
      earlier: 1,
      same: 4,
      addedSince: 1,
      undatedThen: 1,
      undatedNow: 1,
      notShown: 0,
    });
    expect(c.mostLater).toBe(16);
    // Slipped by default, the largest delay first.
    expect(c.tickets.map((x) => [x.key, x.delay])).toEqual([
      [t.alpha.key, 16],
      [t.yearEnd.key, 5],
      [t.monthEnd.key, 3],
    ]);
    expect(c.tickets[0]).toMatchObject({
      summary: 'Alpha',
      closed: false,
      was: { start: '2027-03-01', due: '2027-03-05', dated: 'own' },
      now: { start: '2027-03-01', due: '2027-03-21', dated: 'own' },
      startShift: 0,
    });
    // Over the whole plan the administrator is shown, Gil's request ends it, unchanged.
    expect(c.planEnd).toEqual({ was: '2027-06-18', now: '2027-06-18', delay: 0 });
    const earlier = await compare('admin', kickOff.id, '?show=earlier');
    expect(earlier.tickets.map((x) => [x.key, x.delay])).toEqual([[t.beta.key, -2]]);
    const added = await compare('admin', kickOff.id, '?show=added');
    expect(added.tickets.map((x) => x.key)).toEqual([t.added.key]);
    expect(added.tickets[0]?.was).toBeNull();
    const all = await compare('admin', kickOff.id, '?show=all');
    expect(all.tickets).toHaveLength(11);
    expect(all.tickets.find((x) => x.id === t.sprinted.id)).toMatchObject({
      was: { dated: 'sprint', due: '2027-03-14' },
      now: { dated: 'sprint', due: '2027-03-14' },
      delay: 0,
    });
    // A closed ticket's delay counts as an open one's, and it is marked.
    expect(all.tickets.find((x) => x.id === t.closed.id)).toMatchObject({
      closed: true,
      delay: 0,
    });
    expect(all.tickets.find((x) => x.id === t.dropped.id)).toMatchObject({
      was: { due: '2027-03-07' },
      now: { start: null, due: null, dated: null },
      delay: null,
    });
    // The page's filters leave tickets out, never into notShown.
    const filtered = await compare('admin', kickOff.id, '?show=all&track=BLB');
    expect(filtered.tickets.map((x) => x.id)).toEqual([t.hidden.id]);
    expect(filtered.counts.notShown).toBe(0);
    // The plan's end is the reader's: Ana's plan ends with BLA's work, now 7 days later.
    const ana = await compare('ana', kickOff.id);
    expect(ana.planEnd).toEqual({ was: '2027-03-14', now: '2027-03-21', delay: 7 });
  });

  let faster = 0;
  it('[PLN-011] captures from a scenario and compares with a scenario’s days', async () => {
    faster = (
      await call(
        'admin',
        { method: 'POST', url: `${plan()}/scenarios`, payload: { name: 'Faster' } },
        201,
      )
    ).scenario.id;
    await call('admin', {
      method: 'PUT',
      url: `${plan()}/scenarios/${faster}/drafts`,
      payload: { changes: [{ ticketId: t.beta.id, dueDate: '2027-03-30' }] },
    });
    // The live baseline against the scenario: Beta ends 20 days later there.
    const there = await compare('admin', kickOff.id, `?scenario=${faster}`);
    expect(there.against).toEqual({ scenario: { id: faster, name: 'Faster' } });
    expect(there.tickets.find((x) => x.id === t.beta.id)?.delay).toBe(20);
    const since = await lastEventId();
    const drafted = await capture('admin', { name: 'Drafted', scenarioId: faster });
    expect(drafted).toMatchObject({ source: 'scenario', scenarioName: 'Faster', tickets: 11 });
    expect((await eventsOf('plan.baseline_captured', since))[0]?.payload).toEqual({
      baselineId: drafted.id,
      source: 'scenario',
      tickets: 11,
    });
    // Its days are the scenario's: against Live, Beta ends 22 days earlier than drafted.
    const live = await compare('admin', drafted.id, '?show=earlier');
    expect(live.tickets.map((x) => [x.key, x.delay])).toEqual([[t.beta.key, -22]]);
    // Renamed, the scenario's name at capture stays.
    await call('admin', {
      method: 'PATCH',
      url: `${plan()}/scenarios/${faster}`,
      payload: { name: 'Fastest', version: 1 },
    });
    const list = await call('admin', { method: 'GET', url: `${plan()}/baselines` });
    expect(list.baselines.map((b: Baseline) => [b.name, b.scenarioName])).toEqual([
      ['Drafted', 'Faster'],
      ['Kick-off', null],
    ]);
  });

  it('[PLN-011] [QRY-008] shows each reader a baseline’s days only on tickets the plan shows them now', async () => {
    const sentinels = (body: string) => {
      for (const word of [
        ...SENTINEL_WORDS,
        ...SENTINEL_DAYS,
        t.hidden.key,
        t.requested.key,
        `"id":${t.hidden.id},`,
      ]) {
        expect(body, word).not.toContain(word);
      }
    };
    // Ana: BLA only; the two sentinel tickets are one number.
    for (const show of ['slipped', 'earlier', 'added', 'all']) {
      const res = await as('ana', {
        method: 'GET',
        url: `${plan()}/baselines/${kickOff.id}/compare?show=${show}`,
      });
      expect(res.statusCode).toBe(200);
      sentinels(res.body);
      expect(res.json().counts.notShown).toBe(2);
    }
    const ana = await compare('ana', kickOff.id, '?show=all');
    expect(ana.tickets.map((x) => x.id).sort()).toEqual(
      [
        t.alpha.id,
        t.beta.id,
        t.gamma.id,
        t.sprinted.id,
        t.monthEnd.id,
        t.yearEnd.id,
        t.closed.id,
        t.dropped.id,
        t.added.id,
      ].sort(),
    );
    // Cy sees the plan and no track: every row is counted, none listed.
    const cy = await as('cy', {
      method: 'GET',
      url: `${plan()}/baselines/${kickOff.id}/compare?show=all`,
    });
    expect(cy.statusCode).toBe(200);
    sentinels(cy.body);
    expect(cy.json().counts).toMatchObject({ notShown: 10, compared: 0 });
    expect(cy.json().tickets).toEqual([]);
    // Gil may open the ticket he asked for, but the plan shows him no BLG work (a plan gives no
    // access): his own request is counted too, never listed.
    const gil = await as('gil', {
      method: 'GET',
      url: `${plan()}/baselines/${kickOff.id}/compare?show=all`,
    });
    expect(gil.statusCode).toBe(200);
    sentinels(gil.body);
    expect(gil.json().tickets).toEqual([]);
    expect(gil.json().counts.notShown).toBe(10);
    // The list holds no ticket's day or name for anyone.
    for (const who of ['ana', 'cy', 'gil']) {
      const res = await as(who, { method: 'GET', url: `${plan()}/baselines` });
      expect(res.statusCode).toBe(200);
      sentinels(res.body);
    }
    // The administrator's baseline does hold the hidden ticket's row: every read keeps it from others.
    const own = await database.db
      .selectFrom('plan_baseline_day')
      .select('ticket_id')
      .where('baseline_id', '=', kickOff.id)
      .where('ticket_id', '=', t.hidden.id)
      .execute();
    expect(own).toHaveLength(1);
  });

  it('[PLN-011] renames and deletes with a version; refusals answer as the record says', async () => {
    const since = await lastEventId();
    const temp = await capture('admin', { name: 'Temporary' });
    const url = `${plan()}/baselines/${temp.id}`;
    const renamed = (
      await call('admin', { method: 'PATCH', url, payload: { name: 'Renamed', version: 1 } })
    ).baseline as Baseline;
    expect(renamed).toMatchObject({ name: 'Renamed', version: 2 });
    const stale = await as('admin', { method: 'PATCH', url, payload: { name: 'X', version: 1 } });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'version_conflict', version: 2 });
    const staleDelete = await as('admin', { method: 'DELETE', url: `${url}?version=1` });
    expect(staleDelete.statusCode).toBe(409);
    // Others who see the plan may not change it.
    for (const options of [
      { method: 'POST' as const, url: `${plan()}/baselines`, payload: { name: 'Mine' } },
      { method: 'PATCH' as const, url, payload: { name: 'Mine', version: 2 } },
      { method: 'DELETE' as const, url: `${url}?version=2` },
    ]) {
      const res = await as('ana', options);
      expect(res.statusCode, options.method).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden', permission: 'edit_plan' });
    }
    await call('admin', { method: 'DELETE', url: `${url}?version=2` }, 204);
    expect(
      await database.db
        .selectFrom('plan_baseline_day')
        .select('ticket_id')
        .where('baseline_id', '=', temp.id)
        .execute(),
    ).toEqual([]);
    expect((await eventsOf('plan.baseline_renamed', since)).map((e) => e.payload)).toEqual([
      { baselineId: temp.id },
    ]);
    expect((await eventsOf('plan.baseline_deleted', since)).map((e) => e.payload)).toEqual([
      { baselineId: temp.id },
    ]);
    // Gone, a plan not seen, and a baseline of another plan: 404, word for word.
    const missing = await as('admin', { method: 'GET', url: `${url}/compare` });
    expect(missing.statusCode).toBe(404);
    const unseen = await as('ana', { method: 'GET', url: `${plan(privateId)}/baselines` });
    const nowhere = await as('ana', { method: 'GET', url: `${plan(2_000_000_000)}/baselines` });
    expect(unseen.statusCode).toBe(404);
    expect(unseen.body).toBe(nowhere.body);
    expect(missing.body).toBe(nowhere.body);
    const elsewhere = await as('admin', {
      method: 'GET',
      url: `${plan(privateId)}/baselines/${kickOff.id}/compare`,
    });
    expect(elsewhere.statusCode).toBe(404);
    expect(elsewhere.body).toBe(nowhere.body);
    // Bad fields.
    const bad = async (options: InjectOptions, fields: Record<string, string>) => {
      const res = await as('admin', options);
      expect(res.statusCode, res.body).toBe(400);
      expect(res.json()).toMatchObject({ error: 'invalid_fields', fields });
    };
    await bad({ method: 'POST', url: `${plan()}/baselines`, payload: { name: '   ' } }, {});
    await bad(
      { method: 'POST', url: `${plan()}/baselines`, payload: { name: 'x'.repeat(101) } },
      {},
    );
    const otherScenario = (
      await call(
        'admin',
        { method: 'POST', url: `${plan(privateId)}/scenarios`, payload: { name: 'Other' } },
        201,
      )
    ).scenario.id;
    await bad(
      {
        method: 'POST',
        url: `${plan()}/baselines`,
        payload: { name: 'X', scenarioId: otherScenario },
      },
      { scenarioId: 'not_found' },
    );
    const base = `${plan()}/baselines/${kickOff.id}/compare`;
    await bad({ method: 'GET', url: `${base}?show=later` }, {});
    await bad({ method: 'GET', url: `${base}?after=nonsense` }, { after: 'invalid' });
    await bad(
      { method: 'GET', url: `${base}?scenario=${otherScenario}` },
      { scenario: 'not_found' },
    );
  });

  it('[PLN-011] holds at most 10 baselines a plan', async () => {
    const small = await trackPlan('Small', ['BLA']);
    for (let i = 1; i <= 10; i++) await capture('admin', { name: `B${i}` }, small);
    const refused = await as('admin', {
      method: 'POST',
      url: `${plan(small)}/baselines`,
      payload: { name: 'B11' },
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'too_many_baselines', limit: 10 });
    const list = await call('admin', { method: 'GET', url: `${plan(small)}/baselines` });
    expect(list.baselines).toHaveLength(10);
    // Newest first.
    expect(list.baselines[0].name).toBe('B10');
  });

  it('[PLN-011] pages a comparison by delay, then rank and id, and refuses a plan over 50,000 tickets', async () => {
    const paging = await trackPlan('Paging', ['BLP']);
    const template = await ticket('BLP', 'Paged', { dueDate: '2027-04-01' });
    const ids = [template.id, ...(await copies(template, 204, 'p'))];
    const base = await capture('admin', { name: 'Paged' }, paging);
    expect(base.tickets).toBe(205);
    // Three delays, 0 to 2 days, by id.
    await sql`UPDATE ticket SET due_date = due_date + (id % 3)
               WHERE id = ANY(${ids}::int[])`.execute(database.db);
    const first = await compare('admin', base.id, '?show=all', paging);
    expect(first.tickets).toHaveLength(200);
    expect(first.next).not.toBeNull();
    const second = await compare(
      'admin',
      base.id,
      `?show=all&after=${encodeURIComponent(first.next as string)}`,
      paging,
    );
    expect(second.tickets).toHaveLength(5);
    expect(second.next).toBeNull();
    const delays = [...first.tickets, ...second.tickets].map((x) => x.delay as number);
    expect(delays).toEqual([...delays].sort((a, b) => b - a));
    expect(new Set([...first.tickets, ...second.tickets].map((x) => x.id)).size).toBe(205);
    // Past 50,000 tickets nothing is captured: they are counted first. 10,000 a statement.
    for (const tag of ['a', 'b', 'c', 'd', 'e']) await copies(template, 10_000, tag);
    const large = await as('admin', {
      method: 'POST',
      url: `${plan(paging)}/baselines`,
      payload: { name: 'Too large' },
    });
    expect(large.statusCode, large.body).toBe(409);
    expect(large.json()).toEqual({ error: 'plan_too_large', limit: 50_000 });
    const list = await call('admin', { method: 'GET', url: `${plan(paging)}/baselines` });
    expect(list.baselines).toHaveLength(1);
  }, 600_000); // 50,000 tickets written; three such tests can share the machine in a gate

  it('[PLN-011] audits every baseline event, with the plan as its subject', async () => {
    await relay();
    const rows = await database.db
      .selectFrom('audit_event')
      .select(['action', 'subject_id'])
      .where('action', 'like', 'plan.baseline_%')
      .execute();
    for (const type of [
      'plan.baseline_captured',
      'plan.baseline_renamed',
      'plan.baseline_deleted',
    ]) {
      expect(
        rows.map((r) => r.action),
        type,
      ).toContain(type);
    }
  });

  it('[PLN-011] a deleted plan takes its baselines, and a copy of a plan takes none', async () => {
    const copy = await call(
      'admin',
      { method: 'POST', url: `${plan()}/duplicate`, payload: { name: 'Spring copy' } },
      201,
    );
    const copied = await call('admin', { method: 'GET', url: `${plan(copy.plan.id)}/baselines` });
    expect(copied.baselines).toEqual([]);
    const doomed = await trackPlan('Doomed', ['BLA']);
    const b = await capture('admin', { name: 'Doomed' }, doomed);
    await call('admin', { method: 'DELETE', url: plan(doomed) }, 204);
    expect(
      await database.db.selectFrom('plan_baseline').select('id').where('id', '=', b.id).execute(),
    ).toEqual([]);
  });
});
