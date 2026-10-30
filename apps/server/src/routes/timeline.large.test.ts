import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * The timeline at size (M1-048; AGL-015 (3)): a track of 12,000 tickets, 200 outcomes ranked
 * first with 59 dated features each, read by a member ten times. Only 5,000 tickets are listed,
 * yet every outcome's roll-up spans and counts all 59 of its features. Run with
 *   TASKMOOR_LARGE_TIMELINE=1 pnpm verify --only=tests -- apps/server/src/routes/timeline.large.test.ts
 * Measured on 2026-10-30: see the progress row of M1-048.
 */
const OUTCOMES = 200;
const CHILDREN = 59;
const p95 = (samples: number[]) =>
  [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)] as number;

describe.skipIf(!process.env.TASKMOOR_LARGE_TIMELINE)('the timeline at size (M1-048)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let cookie = '';

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const password = `large-${randomBytes(18).toString('base64url')}`;
    const hash = await hashPassword(password);
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
        payload: { email, password },
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
    const track = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie: admin },
      payload: { key: 'BIG', name: 'Big', mode: 'shared' },
    });
    expect(track.statusCode, track.body).toBe(201);
    const trackId = track.json().track.id as number;
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: members.id,
        user_id: ids.member as number,
      })
      .execute();
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie: admin },
      payload: { track: 'BIG', summary: 'Template' },
    });
    expect(first.statusCode, first.body).toBe(201);
    const template = first.json().ticket.id as number;
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
    // Outcomes rank before every feature; feature g of outcome o runs for a week from a day of o.
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels)
      SELECT k.workspace_id, k.track_id, k.number + g, ${outcome}::int, k.status_id,
             'Outcome ' || g, k.creator_id, k.rank || '1' || lpad(g::text, 5, '0') || '1',
             k.fields, k.labels
        FROM ticket k, generate_series(1, ${OUTCOMES}) AS g
       WHERE k.id = ${template}`.execute(database.db);
    await sql`
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, rank, fields, labels, parent_id, start_date, due_date)
      SELECT k.workspace_id, k.track_id, k.number + ${OUTCOMES} + (o - 1) * ${CHILDREN} + c,
             ${feature}::int, k.status_id, 'Feature ' || o || '.' || c, k.creator_id,
             k.rank || '2' || lpad(o::text, 4, '0') || lpad(c::text, 3, '0') || '1', k.fields,
             k.labels, p.id, date '2027-01-01' + o + c, date '2027-01-08' + o + c
        FROM ticket k, generate_series(1, ${OUTCOMES}) AS o, generate_series(1, ${CHILDREN}) AS c,
             LATERAL (SELECT id FROM ticket WHERE track_id = k.track_id AND number = k.number + o) p
       WHERE k.id = ${template}`.execute(database.db);
    await sql`ANALYZE`.execute(database.db);
  }, 600_000);
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-015] keeps roll-ups on for a track of 12,000 tickets', async () => {
    const times: number[] = [];
    let body: {
      items: { summary: string; rollup: { start: string; due: string; total: number } | null }[];
      truncated: boolean;
    } = { items: [], truncated: false };
    for (let i = 0; i < 10; i++) {
      const started = performance.now();
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/tracks/BIG/timeline',
        headers: { cookie },
      });
      times.push(performance.now() - started);
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      body = res.json();
    }
    expect(body.items).toHaveLength(5000);
    expect(body.truncated).toBe(true);
    const outcomes = body.items.filter((i) => i.summary.startsWith('Outcome '));
    expect(outcomes).toHaveLength(OUTCOMES);
    // Every outcome counts all its features, listed or not; the last one's span is exact.
    expect(outcomes.every((o) => o.rollup?.total === CHILDREN)).toBe(true);
    expect(outcomes.at(-1)?.rollup).toMatchObject({ start: '2027-07-21', due: '2027-09-24' });
    process.stdout.write(
      `M1-048 timeline of ${OUTCOMES * (CHILDREN + 1) + 1} tickets: p95 ${Math.round(p95(times))} ms, max ${Math.round(Math.max(...times))} ms\n`,
    );
    expect(p95(times)).toBeLessThan(10_000);
  }, 900_000);
});
