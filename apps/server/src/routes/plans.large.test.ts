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
 * a year, read by a member of every track. Every gate reads 10,000 tickets; the M1 bar of 100,000
 * runs with
 *   TASKMOOR_LARGE_PLANS=1 npx vitest run --project=server apps/server/src/routes/plans.large.test.ts
 * Each view, and the List's search and groups, is read five times; the median must stay under a
 * second.
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
    await timed('calendar', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/calendar?from=2027-02-22&to=2027-04-04`,
    });
    await timed('timeline filtered', {
      method: 'GET',
      url: `/api/v1/plans/${plan}/timeline?assignee=me&track=BIG3`,
    });
    await timed('choices', { method: 'GET', url: `/api/v1/plans/${plan}/choices` });
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
});
