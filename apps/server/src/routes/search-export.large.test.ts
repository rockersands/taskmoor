import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * A large export (M1-042; QRY-015): 100,000 tickets of one track exported by a member (so the
 * permission filter is in every statement), as CSV and as JSON, read through a real socket the
 * way a browser downloads it. Done when the CSV streams in under 60 s. The test also samples
 * the live heap (after a collection) while the download runs: it grows by far less than the
 * size of the file, since rows go out a page at a time. Run with
 *   TASKMOOR_LARGE_EXPORT=1 pnpm verify --only=tests -- apps/server/src/routes/search-export.large.test.ts
 * Measured on 2026-10-29: see the progress row of M1-042 and ADR-052.
 */
const TICKETS = 100_000;

/** A collector to call, so the samples count live objects and not garbage awaiting one. */
function collector(): () => void {
  setFlagsFromString('--expose-gc');
  return runInNewContext('gc') as () => void;
}

describe.skipIf(!process.env.TASKMOOR_LARGE_EXPORT)('a large export (M1-042)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let base = '';
  let cookie = '';
  let pointsId = 0;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
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
      .values({ workspace_id: 1, track_id: trackId, role_id: members.id, user_id: ids.member })
      .execute();
    const points = await app.inject({
      method: 'POST',
      url: '/api/v1/fields',
      headers: { cookie: admin },
      payload: { name: 'Pts', type: 'number' },
    });
    expect(points.statusCode, points.body).toBe(201);
    pointsId = points.json().field.id as number;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/tickets',
      headers: { cookie: admin },
      payload: { track: 'BIG', summary: 'Template', fields: { [pointsId]: 5 } },
    });
    expect(first.statusCode, first.body).toBe(201);
    const template = first.json().ticket.id as number;
    // Copies of the first ticket over the four statuses, every 20th urgent, every 3rd assigned.
    await sql`
      WITH s AS (SELECT array_agg(id ORDER BY sort_order) AS a FROM status
                  WHERE name IN ('New', 'Active', 'In Review', 'Closed')),
           p AS (SELECT id FROM priority WHERE name = 'Urgent')
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, status_id, summary,
                          creator_id, assignee_id, priority_id, rank, fields, labels)
      SELECT k.workspace_id, k.track_id, k.number + g, k.ticket_type_id, s.a[1 + g % 4],
             'Ticket ' || g || ', "quoted"', k.creator_id,
             CASE WHEN g % 3 = 0 THEN ${ids.member}::int END,
             CASE WHEN g % 20 = 0 THEN p.id ELSE k.priority_id END,
             k.rank || lpad(g::text, 6, '0'), k.fields, ARRAY['big', 'l' || (g % 7)]
        FROM ticket k, s, p, generate_series(1, ${TICKETS - 1}) AS g
       WHERE k.id = ${template}`.execute(database.db);
    await sql`ANALYZE`.execute(database.db);
  }, 600_000);

  afterAll(async () => {
    await app.close();
  });

  /** Downloads an export, counting lines without keeping them; times and heap peak. */
  async function download(format: 'csv' | 'json') {
    const columns = `summary,status,assignee,priority,labels,updatedAt,cf[${pointsId}]`;
    const url = `${base}/api/v1/search/export?${new URLSearchParams({
      q: 'track = BIG ORDER BY key ASC',
      format,
      columns,
    })}`;
    const gc = collector();
    gc();
    const heapBefore = process.memoryUsage().heapUsed;
    let heapPeak = heapBefore;
    const sampler = setInterval(() => {
      gc();
      heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
    }, 250);
    const started = performance.now();
    const res = await fetch(url, { headers: { cookie } });
    expect(res.status).toBe(200);
    let firstByte = 0;
    let bytes = 0;
    let lines = 0;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByte === 0) firstByte = performance.now() - started;
      bytes += value.byteLength;
      for (const b of value) if (b === 10) lines += 1;
    }
    const ms = performance.now() - started;
    clearInterval(sampler);
    return { ms, firstByte, bytes, lines, heapGrowth: heapPeak - heapBefore };
  }

  it('[QRY-015] exports 100,000 tickets as CSV and JSON, streamed, within 60 s', async () => {
    const csv = await download('csv');
    const json = await download('json');
    const mb = (n: number) => (n / 1024 / 1024).toFixed(1);
    const line = `M1-042 export of ${TICKETS} tickets: CSV ${(csv.ms / 1000).toFixed(1)} s (${mb(csv.bytes)} MB, first byte ${Math.round(csv.firstByte)} ms, live heap growth ${mb(csv.heapGrowth)} MB); JSON ${(json.ms / 1000).toFixed(1)} s (${mb(json.bytes)} MB, first byte ${Math.round(json.firstByte)} ms, live heap growth ${mb(json.heapGrowth)} MB)`;
    process.stdout.write(`${line}\n`);
    if (process.env.TASKMOOR_LARGE_EXPORT_REPORT) {
      appendFileSync(process.env.TASKMOOR_LARGE_EXPORT_REPORT, `${line}\n`);
    }
    // A header and one line per ticket; the JSON array's brackets and one line per ticket.
    expect(csv.lines).toBe(TICKETS + 1);
    expect(json.lines).toBe(TICKETS + 2);
    // Streamed: the live heap never holds the file.
    expect(csv.heapGrowth).toBeLessThan(csv.bytes);
    expect(json.heapGrowth).toBeLessThan(json.bytes);
    expect(csv.ms).toBeLessThan(60_000);
    expect(json.ms).toBeLessThan(60_000);
  }, 600_000);
});
