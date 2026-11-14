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
const PASSWORD = `plans-large-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.89.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

/**
 * A plan at size (PLN-012 (1)): 20 tracks of outcomes, each with nine dated features spread over
 * a year, each feature blocking the next under its outcome and the last one blocking the first of
 * the next track's, the very last blocking the very first (left out by the first 10,000, so
 * only counted) and a ticket outside the plan blocking the second (PLN-006), read by a member
 * of every track, whose team the plan plans with (PLN-005). Every gate reads 10,000 tickets;
 * the M1 bar of 100,000 runs with
 *   TASKMOOR_LARGE_PLANS=1 npx vitest run --project=server apps/server/src/routes/plans.large.test.ts
 * Each view, and the List's search and groups, is read five times; the median must stay under a
 * second. A release in each track, half the tickets as its targets, all linked as one release
 * across tracks (PLN-007), holds its page, the list and the plan's Releases tab to the same bar, and
 * so does a move of 100 linked releases, with its 101 events.
 */
const LARGE = Boolean(process.env.TASKMOOR_LARGE_PLANS);
const TRACKS = 20;
const PER_TRACK = LARGE ? 5000 : 500;
const OUTCOMES = PER_TRACK / 10;
const TICKETS = (TRACKS * PER_TRACK).toLocaleString('en');
const RUNS = 5;
const median = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)] as number;

describe(`a plan of ${TRACKS} tracks and ${TICKETS} tickets (PLN-012)`, () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';
  let plan = 0;
  /** Listed tickets blocked by one the first 10,000 leave out, and by one outside the plan. */
  let cutBlocks = 0;
  let outsideBlocks = 0;
  /** The release across tracks over every track, and one of 100 releases to move. */
  let crossAll = 0;
  let crossHundred = 0;
  let adminCookie = '';
  /** The plan's team, which the program board's rows read (PLN-008). */
  let bigTeam = 0;

  const read = async (options: InjectOptions) => {
    const res = await app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { cookie },
    });
    expect(res.statusCode, `${options.url}: ${res.body.slice(0, 300)}`).toBe(200);
    return res.json();
  };
  const timed = async (what: string, options: InjectOptions) => {
    const times: number[] = [];
    let body: unknown;
    for (let i = 0; i < RUNS; i++) {
      const started = performance.now();
      body = await read(options);
      times.push(performance.now() - started);
    }
    const m = median(times);
    process.stdout.write(`PLN-012 ${what}, ${TICKETS} tickets: median ${Math.round(m)} ms\n`);
    expectWithinBudget(
      m,
      1000,
      `plan ${what}, ${TRACKS} tracks and ${TICKETS} tickets, median (ms)`,
    );
    return body as Record<string, unknown>;
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    const ids: Record<string, number> = {};
    for (const [name, admin] of [
      ['admin', true],
      ['member', false],
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
      ids[name] = row.id;
    }
    const signIn = async (email: string) => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email, password: PASSWORD },
        remoteAddress: nextAddress(),
      });
      return (
        [res.headers['set-cookie'] ?? []]
          .flat()
          .find((c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`))
          ?.split(';')[0] ?? ''
      );
    };
    const admin = await signIn('admin@example.com');
    cookie = await signIn('member@example.com');
    const as = (options: InjectOptions) =>
      app.inject({ ...options, remoteAddress: nextAddress(), headers: { cookie: admin } });
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    const type = async (name: string) =>
      (
        await database.db
          .selectFrom('ticket_type')
          .select('id')
          .where('name', '=', name)
          .where('owner_track_id', 'is', null)
          .executeTakeFirstOrThrow()
      ).id;
    const outcome = await type('Outcome');
    const feature = await type('Feature');
    const trackIds: number[] = [];
    for (let t = 1; t <= TRACKS; t++) {
      const key = `BIG${t}`;
      const made = await as({
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Team ${t}`, mode: 'shared' },
      });
      expect(made.statusCode, made.body).toBe(201);
      const trackId = made.json().track.id as number;
      trackIds.push(trackId);
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: trackId,
          role_id: members.id,
          user_id: ids.member as number,
        })
        .execute();
      const first = await as({
        method: 'POST',
        url: '/api/v1/tickets',
        payload: { track: key, summary: 'Template' },
      });
      expect(first.statusCode, first.body).toBe(201);
      const template = first.json().ticket.id as number;
      // Outcomes rank first in each track; feature c of outcome o runs a week from a day of 2027.
      await sql`
        INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                            creator_id, rank, fields, labels)
        SELECT k.workspace_id, k.track_id, k.number + g, ${outcome}::int, k.status_id,
               'Outcome ' || g, k.creator_id, k.rank || '1' || lpad(g::text, 5, '0'), k.fields,
               k.labels
          FROM ticket k, generate_series(1, ${OUTCOMES}) AS g
         WHERE k.id = ${template}`.execute(database.db);
      await sql`
        INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                            creator_id, rank, fields, labels, parent_id, start_date, due_date,
                            assignee_id)
        SELECT k.workspace_id, k.track_id, k.number + ${OUTCOMES} + (o - 1) * 9 + c,
               ${feature}::int, k.status_id, 'Feature ' || o || '.' || c, k.creator_id,
               k.rank || '2' || lpad(o::text, 5, '0') || c, k.fields, k.labels, p.id,
               date '2027-01-01' + ((o * 7 + c) % 360), date '2027-01-08' + ((o * 7 + c) % 360),
               CASE WHEN c % 3 = 0 THEN ${ids.member}::int END
          FROM ticket k, generate_series(1, ${OUTCOMES}) AS o, generate_series(1, 9) AS c,
               LATERAL (SELECT id FROM ticket WHERE track_id = k.track_id AND number = k.number + o) p
         WHERE k.id = ${template}`.execute(database.db);
    }
    // Dependencies: a chain of eight under each outcome, and one into each next track.
    const blocks = (
      await database.db
        .selectFrom('link_type')
        .select('id')
        .where('outward', '=', 'blocks')
        .executeTakeFirstOrThrow()
    ).id;
    await sql`
      INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id)
      SELECT a.workspace_id, ${blocks}::int, a.id, b.id
        FROM ticket a JOIN ticket b ON b.parent_id = a.parent_id AND b.number = a.number + 1
       WHERE a.track_id = ANY(${trackIds}::int[])`.execute(database.db);
    await sql`
      INSERT INTO ticket_link (workspace_id, link_type_id, source_id, target_id)
      SELECT a.workspace_id, ${blocks}::int, a.id, b.id
        FROM ticket a
        JOIN ticket b ON b.track_id = (${trackIds}::int[])[array_position(${trackIds}::int[], a.track_id) + 1]
             AND b.summary = 'Feature 1.1'
       WHERE a.summary = ${`Feature ${OUTCOMES}.9`}`.execute(database.db);
    // Blockers the Timeline does not list. Tickets rank track by track, so the first 10,000 end
    // before the last track's last feature at either size: it blocks the first track's first
    // feature, counted as the plan's own. A ticket of a track outside the plan blocks the second.
    const featureOf = async (trackId: number, summary: string) =>
      (
        await database.db
          .selectFrom('ticket')
          .select('id')
          .where('track_id', '=', trackId)
          .where('summary', '=', summary)
          .executeTakeFirstOrThrow()
      ).id;
    cutBlocks = await featureOf(trackIds[0] as number, 'Feature 1.1');
    outsideBlocks = await featureOf(trackIds[0] as number, 'Feature 1.2');
    const out = await as({
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'OUT', name: 'Elsewhere', mode: 'shared' },
    });
    expect(out.statusCode, out.body).toBe(201);
    const outside = await as({
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'OUT', summary: 'Outside blocker' },
    });
    expect(outside.statusCode, outside.body).toBe(201);
    await database.db
      .insertInto('ticket_link')
      .values([
        {
          workspace_id: 1,
          link_type_id: blocks,
          source_id: await featureOf(trackIds[TRACKS - 1] as number, `Feature ${OUTCOMES}.9`),
          target_id: cutBlocks,
        },
        {
          workspace_id: 1,
          link_type_id: blocks,
          source_id: outside.json().ticket.id as number,
          target_id: outsideBlocks,
        },
      ])
      .execute();
    await sql`ANALYZE`.execute(database.db);
    const made = await as({
      method: 'POST',
      url: '/api/v1/plans',
      payload: {
        name: 'Everything',
        sources: trackIds.map((trackId) => ({ kind: 'track', trackId })),
        shares: [{ scope: 'any_user' }],
      },
    });
    expect(made.statusCode, made.body).toBe(201);
    plan = made.json().plan.id;
    // Teams and capacity (PLN-005): the plan plans with the member's team, 30 points a period.
    const team = await as({ method: 'POST', url: '/api/v1/teams', payload: { name: 'Big team' } });
    expect(team.statusCode, team.body).toBe(201);
    const teamId = team.json().team.id as number;
    bigTeam = teamId;
    const joined = await as({
      method: 'PUT',
      url: `/api/v1/teams/${teamId}/members/${ids.member}`,
    });
    expect(joined.statusCode, joined.body).toBe(204);
    const planned = await as({
      method: 'PATCH',
      url: `/api/v1/plans/${plan}`,
      payload: { teams: [teamId], period: { kind: 'weeks', weeks: 2, anchor: '2027-01-04' } },
    });
    expect(planned.statusCode, planned.body).toBe(200);
    const set = await as({
      method: 'PUT',
      url: `/api/v1/plans/${plan}/capacity`,
      payload: { entries: [{ teamId, period: null, amount: 30 }] },
    });
    expect(set.statusCode, set.body).toBe(200);
    // Releases across tracks (PLN-007): a release in each track, half the tickets as its targets,
    // all linked as one, for the member, who sees them all.
    adminCookie = admin;
    const linked: number[] = [];
    for (const trackId of trackIds) {
      const release = await as({
        method: 'POST',
        url: `/api/v1/tracks/${trackId}/releases`,
        payload: { name: 'Big 1.0', releaseDate: '2027-06-01' },
      });
      expect(release.statusCode, release.body).toBe(201);
      const releaseId = release.json().release.id as number;
      linked.push(releaseId);
      await sql`
        INSERT INTO ticket_release (workspace_id, ticket_id, release_id, role)
        SELECT workspace_id, id, ${releaseId}::int, 'target' FROM ticket
         WHERE track_id = ${trackId}::int AND number % 2 = 0`.execute(database.db);
    }
    const cross = await as({
      method: 'POST',
      url: '/api/v1/cross-track-releases',
      payload: {
        name: 'Big launch',
        endRule: 'fixed_date',
        date: '2027-06-01',
        releaseIds: linked,
      },
    });
    expect(cross.statusCode, cross.body).toBe(201);
    crossAll = cross.json().id;
    // A hundred tracks' releases, for the largest move the limit allows.
    const hundred: number[] = [];
    for (let t = 1; t <= 100; t++) {
      const track = await as({
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: `MV${t}`, name: `Move ${t}`, mode: 'shared' },
      });
      expect(track.statusCode, track.body).toBe(201);
      const release = await as({
        method: 'POST',
        url: `/api/v1/tracks/${track.json().track.id}/releases`,
        payload: { name: 'Move 1.0', releaseDate: '2027-06-01' },
      });
      expect(release.statusCode, release.body).toBe(201);
      hundred.push(release.json().release.id as number);
    }
    const many = await as({
      method: 'POST',
      url: '/api/v1/cross-track-releases',
      payload: {
        name: 'Hundred',
        endRule: 'fixed_date',
        date: '2027-06-01',
        releaseIds: hundred,
      },
    });
    expect(many.statusCode, many.body).toBe(201);
    crossHundred = many.json().id;
    await sql`ANALYZE`.execute(database.db);
  }, 900_000);
  afterAll(async () => {
    await app.close();
  });

  it(`[PLN-012] answers each view of ${TICKETS} tickets in under a second`, async () => {
    const opened = await timed('page', { method: 'GET', url: `/api/v1/plans/${plan}` });
    const query = (opened.plan as { query: string }).query;
    const summary = await timed('summary', { method: 'GET', url: `/api/v1/plans/${plan}/summary` });
    // Each track's template, outcomes and features.
    expect((summary.total as { count: number }).count).toBe(TRACKS * (PER_TRACK + 1));
    const timeline = await timed('timeline', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/timeline`,
    });
    expect((timeline.items as unknown[]).length).toBe(Math.min(10_000, TRACKS * (PER_TRACK + 1)));
    expect(timeline.truncated).toBe(TRACKS * (PER_TRACK + 1) > 10_000);
    const outcomes = (
      timeline.items as { summary: string; rollup: { total: number } | null }[]
    ).filter((i) => i.summary.startsWith('Outcome '));
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.every((o) => o.rollup?.total === 9)).toBe(true);
    // Lines between listed features. The blocker the first 10,000 leave out is counted as the
    // plan's own, the one outside the plan as outside; both only counted.
    expect((timeline.links as unknown[]).length).toBeGreaterThan(0);
    expect(timeline.blockersElsewhere).toEqual(
      [
        { id: cutBlocks, outside: 0, unlisted: 1 },
        { id: outsideBlocks, outside: 1, unlisted: 0 },
      ].sort((a, b) => a.id - b.id),
    );
    await timed('calendar', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/calendar?from=2027-02-22&to=2027-04-04`,
    });
    await timed('timeline filtered', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/timeline?assignee=me&track=BIG3`,
    });
    await timed('choices', { method: 'GET', url: `/api/v1/plans/${plan}/choices` });
    // Capacity over six periods: the team's first period is the count of its search.
    const capacity = await timed('capacity', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/capacity?from=2027-03-01&periods=6`,
    });
    const team = (capacity.teams as { clause: string; cells: { count: number }[] }[])[0];
    const period = (capacity.periods as { clause: string }[])[0];
    const found = await read({
      method: 'POST',
      url: '/api/v1/search',
      payload: { q: `(${query}) AND ${team?.clause} AND ${period?.clause}`, count: true, limit: 1 },
    });
    expect(team?.cells[0]?.count).toBeGreaterThan(0);
    expect(team?.cells[0]?.count).toBe(found.total.count);
    // The List is the search with the plan's query, and its groups the two-dimensional report.
    await timed('list', {
      method: 'POST',
      url: '/api/v1/search',
      payload: { q: `${query} ORDER BY created DESC`, limit: 50 },
    });
    await timed('list groups', {
      method: 'GET',
      url: `/api/v1/reports/two-dimensional?${new URLSearchParams({ query, x: 'track', y: 'track' })}`,
    });
  }, 900_000);

  it(`[PLN-008] [PLN-012] answers a program board over ${TICKETS} tickets in under a second`, async () => {
    // Half the tickets in the plan's team, by a Team field; six two-week periods from March.
    const admin = (options: InjectOptions) =>
      app.inject({ ...options, remoteAddress: nextAddress(), headers: { cookie: adminCookie } });
    const field = await admin({
      method: 'POST',
      url: '/api/v1/fields',
      payload: { name: 'Big Team field', type: 'team' },
    });
    expect(field.statusCode, field.body).toBe(201);
    const fieldId = field.json().field.id as number;
    await sql`
      UPDATE ticket SET fields = fields || jsonb_build_object(${String(fieldId)}::text, ${bigTeam}::int)
       WHERE number % 2 = 0`.execute(database.db);
    // The value as the ticket route writes it, in the side table searches read (ADR-008).
    await sql`
      INSERT INTO v_option (workspace_id, ticket_id, track_id, field_id, value, created_at)
      SELECT workspace_id, id, track_id, ${fieldId}::int, ${bigTeam}::int, created_at FROM ticket
       WHERE number % 2 = 0`.execute(database.db);
    await sql`ANALYZE ticket`.execute(database.db);
    const made = await admin({
      method: 'POST',
      url: `/api/v1/plans/${plan}/program-boards`,
      payload: { name: 'Big board', teamFieldId: fieldId, from: '2027-03-01', periods: 6 },
    });
    expect(made.statusCode, made.body).toBe(201);
    const board = await timed('program board', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/program-boards/${made.json().board.id}`,
    });
    const rows = board.rows as { clause: string; cells: { count: number; cards: number[] }[] }[];
    const first = rows[0]?.cells[0];
    expect(first?.count).toBeGreaterThan(20);
    expect(first?.cards).toHaveLength(20);
    // The cell's count is its search's.
    const found = await read({
      method: 'POST',
      url: '/api/v1/search',
      payload: {
        q: `(${board.query}) AND ${board.clause} AND ${rows[0]?.clause} AND ${
          (board.periods as { clause: string }[])[0]?.clause
        }`,
        count: true,
        limit: 1,
      },
    });
    expect(first?.count).toBe(found.total.count);
  }, 900_000);

  it(`[PLN-014] [PLN-012] a file of all ${TICKETS} tickets starts within a second and holds them all`, async () => {
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const started = performance.now();
    const res = await fetch(`${address}/api/v1/plans/${plan}/export?columns=summary,status`, {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    let firstByte = 0;
    let lines = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte === 0) firstByte = performance.now() - started;
      for (const b of value) if (b === 10) lines += 1;
    }
    const total = performance.now() - started;
    process.stdout.write(
      `PLN-014 export, ${TICKETS} tickets: first byte ${Math.round(firstByte)} ms, all ${Math.round(total)} ms\n`,
    );
    // A header and a line per ticket, past the 10,000 a view lists at this size or at any other.
    expect(lines).toBe(TRACKS * (PER_TRACK + 1) + 1);
    expectWithinBudget(firstByte, 1000, `plan export, ${TICKETS} tickets, first byte (ms)`);
  }, 900_000);

  it(`[PLN-014] copies a plan of ${TRACKS} tracks in under a second`, async () => {
    const started = performance.now();
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/plans/${plan}/duplicate`,
      payload: { name: 'A copy at size' },
      remoteAddress: nextAddress(),
      headers: { cookie },
    });
    const ms = performance.now() - started;
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json().plan.sources).toHaveLength(TRACKS);
    process.stdout.write(`PLN-014 duplicate, ${TRACKS} tracks: ${Math.round(ms)} ms\n`);
    expectWithinBudget(ms, 1000, `plan duplicate, ${TRACKS} tracks (ms)`);
  }, 60_000);

  it(`[PLN-007] [PLN-012] answers a release across ${TRACKS} tracks and ${TICKETS} tickets in under a second`, async () => {
    const page = await timed('release across tracks', {
      method: 'GET',
      url: `/api/v1/cross-track-releases/${crossAll}`,
    });
    expect((page.open as { count: number }).count).toBeGreaterThan(0);
    expect((page.members as unknown[]).length).toBe(TRACKS);
    await timed('releases across tracks', { method: 'GET', url: '/api/v1/cross-track-releases' });
    const tab = await timed('releases tab', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/releases`,
    });
    expect((tab.crossTrack as { id: number }[]).map((c) => c.id)).toContain(crossAll);
    await timed('timeline, with its markers', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/timeline`,
    });
    await timed('calendar, with its markers', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/calendar?from=2027-05-22&to=2027-07-04`,
    });
    // A move of 100 releases, as a site administrator, five times.
    const times: number[] = [];
    let version = 1;
    for (let i = 1; i <= RUNS; i++) {
      const started = performance.now();
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/cross-track-releases/${crossHundred}/move`,
        payload: { date: `2027-07-0${i}`, version },
        remoteAddress: nextAddress(),
        headers: { cookie: adminCookie },
      });
      times.push(performance.now() - started);
      expect(res.statusCode, res.body).toBe(200);
      const moved = res.json() as { version: number; lines: { outcome: string }[] };
      expect(moved.lines.filter((l) => l.outcome === 'moves')).toHaveLength(100);
      version = moved.version;
    }
    const m = median(times);
    process.stdout.write(`PLN-007 a move of 100 releases: median ${Math.round(m)} ms\n`);
    expectWithinBudget(m, 1000, 'a move of 100 linked releases, with its 101 events, median (ms)');
  }, 900_000);
});
