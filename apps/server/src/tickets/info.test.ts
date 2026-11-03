import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { fc } from '@taskmoor/testkit/property';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { timeInStatus } from './info';

// Made for this run: no password is written in the repository.
const PASSWORD = `info-${randomBytes(18).toString('base64url')}`;
const DAY = 24 * 60 * 60 * 1000;
let address = 0;
const nextAddress = () => `100.79.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const paragraph = (text: string) => ({
  type: 'doc',
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

describe('time in status (M1-125)', () => {
  it('[CORE-012] (1) is the sum of each status interval, from creation to now', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            gap: fc.integer({ min: 0, max: 10 * DAY }),
            to: fc.integer({ min: 1, max: 4 }),
          }),
          { maxLength: 12 },
        ),
        fc.integer({ min: 0, max: 5 * DAY }),
        // Whether the history starts with creation (a change from nothing), as Taskmoor
        // records it, or with the first move, as an imported history may.
        fc.boolean(),
        (steps, tail, withCreation) => {
          const created = new Date('2026-01-01T00:00:00Z');
          const changes: { at: Date; from: number | null; to: number }[] = withCreation
            ? [{ at: created, from: null, to: 1 }]
            : [];
          let at = created.getTime();
          let status = 1;
          const expected = new Map<number, { ms: number; visits: number }>();
          const visit = (s: number, ms: number) => {
            const e = expected.get(s) ?? { ms: 0, visits: 0 };
            expected.set(s, { ms: e.ms + ms, visits: e.visits + 1 });
          };
          for (const step of steps) {
            visit(status, step.gap);
            at += step.gap;
            changes.push({ at: new Date(at), from: status, to: step.to });
            status = step.to;
          }
          visit(status, tail);
          const now = new Date(at + tail);
          const spent = timeInStatus(created, status, changes, now);
          expect(Object.fromEntries(spent)).toEqual(Object.fromEntries(expected));
          const total = [...spent.values()].reduce((sum, s) => sum + s.ms, 0);
          expect(total).toBe(now.getTime() - created.getTime());
        },
      ),
    );
  });

  it('[CORE-012] (1) counts the current status from creation when it never changed', () => {
    const created = new Date('2026-01-01T00:00:00Z');
    const now = new Date(created.getTime() + 3 * DAY);
    expect(Object.fromEntries(timeInStatus(created, 7, [], now))).toEqual({
      7: { ms: 3 * DAY, visits: 1 },
    });
  });
});

/**
 * The info fields through the API (M1-125; CORE-012): the ticket's info, and the query fields
 * `firstResponse`, `daysSinceLastComment` and `participants` filtering and ordering.
 */
describe('read-only info fields through the API (M1-125)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  let members = 0;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const id = (who: string) => users[who]?.id as number;

  async function ticket(summary: string, who = 'alice') {
    const res = await as(who, {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track: 'IF', summary },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string };
  }
  async function comment(who: string, t: { id: number }, text: string, restricted = false) {
    const res = await as(who, {
      method: 'POST',
      url: `/api/v1/tickets/${t.id}/comments`,
      payload: {
        body: paragraph(text),
        ...(restricted ? { visibility: { roleId: members } } : {}),
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().comment as { id: number; createdAt: string };
  }
  async function info(t: { id: number }, who = 'alice') {
    const res = await as(who, { method: 'GET', url: `/api/v1/tickets/${t.id}/info` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().info;
  }
  /** Moves a ticket's comments back in time and recomputes its info times, as a migration would. */
  async function commentedDaysAgo(t: { id: number }, days: number) {
    await sql`UPDATE ticket_comment SET created_at = now() - make_interval(days => ${days})
               WHERE ticket_id = ${t.id}`.execute(database.db);
    await sql`SELECT ticket_info_times(${t.id})`.execute(database.db);
  }
  const keys = async (q: string, who = 'alice') => {
    const res = await as(who, {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=200`,
    });
    expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
    return (res.json().tickets as { key: string }[]).map((t) => t.key);
  };

  beforeAll(async () => {
    const db = database.db;
    app = await buildApp({ db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['carol', false],
    ] as const) {
      const row = await db
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
    members = (
      await db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    const res = await as('admin', {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: 'IF', name: 'Info fields', mode: 'shared' },
    });
    expect(res.statusCode, res.body).toBe(201);
    for (const who of ['alice', 'bob', 'carol']) {
      await db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: res.json().track.id,
          role_id: members,
          user_id: id(who),
        })
        .execute();
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[CORE-012] (1) answers the time in each status from the change history', async () => {
    const t = await ticket('Moves through the workflow');
    // To Active, to In Review and back to Active (transitions of the default workflow).
    for (const transitionId of [1, 2, 1]) {
      const res = await as('alice', {
        method: 'POST',
        url: `/api/v1/tickets/${t.id}/transitions`,
        payload: { transitionId },
      });
      expect(res.statusCode, res.body).toBe(200);
    }
    // Creation ten days ago, then the three moves one, three and six days after it.
    const created = Date.now() - 10 * DAY;
    const sets = await sql<{ change_set: string }>`
      SELECT change_set FROM ticket_change WHERE ticket_id = ${t.id}
       GROUP BY change_set ORDER BY min(id)`.execute(database.db);
    const times = [0, 1, 3, 6].map((d) => new Date(created + d * DAY).toISOString());
    expect(sets.rows).toHaveLength(times.length);
    for (const [i, r] of sets.rows.entries()) {
      await sql`UPDATE ticket_change SET at = ${times[i]}::timestamptz
                 WHERE ticket_id = ${t.id} AND change_set = ${r.change_set}`.execute(database.db);
    }
    await sql`UPDATE ticket SET created_at = ${times[0]}::timestamptz WHERE id = ${t.id}`.execute(
      database.db,
    );

    const spent = (await info(t)).timeInStatus as {
      status: { name: string };
      seconds: number;
      visits: number;
    }[];
    const byName = Object.fromEntries(spent.map((s) => [s.status.name, s]));
    const first = spent.find((s) => s.visits === 1 && s.seconds === DAY / 1000);
    expect(first, JSON.stringify(spent)).toBeDefined();
    expect(spent, JSON.stringify(spent)).toHaveLength(3);
    expect(spent.filter((s) => s.visits === 2)).toHaveLength(1);
    const review = spent.find((s) => s.seconds === (3 * DAY) / 1000);
    expect(review?.visits).toBe(1);
    // Back in the second status for the last four days: two plus four, to the second.
    const twice = spent.find((s) => s.visits === 2);
    expect(Math.abs((twice?.seconds ?? 0) - (6 * DAY) / 1000)).toBeLessThan(60);
    const total = spent.reduce((sum, s) => sum + s.seconds, 0);
    expect(Math.abs(total - (10 * DAY) / 1000)).toBeLessThan(60);
    expect(Object.keys(byName)).toHaveLength(3);
  });

  it('[CORE-012] keeps the first response and the last comment from readable comments', async () => {
    const t = await ticket('Asks a question');
    expect(await info(t)).toMatchObject({
      firstResponse: null,
      lastComment: null,
      daysSinceLastComment: null,
      participants: [{ name: 'alice' }],
    });
    // The requester's own comment is not a response.
    const own = await comment('alice', t, 'Any news?');
    expect(await info(t)).toMatchObject({
      firstResponse: null,
      lastComment: own.createdAt,
      daysSinceLastComment: 0,
    });
    const answer = await comment('bob', t, 'Looking into it');
    expect(await info(t)).toMatchObject({
      firstResponse: answer.createdAt,
      lastComment: answer.createdAt,
      participants: [{ name: 'alice' }, { name: 'bob' }],
    });
    // A comment restricted to a role counts for neither, nor makes its author a participant.
    await comment('carol', t, 'Members only', true);
    expect(await info(t)).toMatchObject({
      lastComment: answer.createdAt,
      participants: [{ name: 'alice' }, { name: 'bob' }],
    });
    // Without the answer there is no response again.
    const removed = await as('bob', {
      method: 'DELETE',
      url: `/api/v1/tickets/${t.id}/comments/${answer.id}`,
    });
    expect(removed.statusCode, removed.body).toBe(204);
    expect(await info(t)).toMatchObject({ firstResponse: null, lastComment: own.createdAt });
    // Another requester: alice's comment is now a response.
    const moved = await as('admin', {
      method: 'PATCH',
      url: `/api/v1/tickets/${t.id}`,
      payload: { requesterId: id('carol') },
    });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(await info(t)).toMatchObject({ firstResponse: own.createdAt });
  });

  it('[CORE-012] (2) days since last comment and date of first response are searchable and sortable', async () => {
    const old = await ticket('Quiet for ten days');
    await comment('bob', old, 'Answered long ago');
    await commentedDaysAgo(old, 10);
    const recent = await ticket('Answered three days ago');
    await comment('bob', recent, 'Answered lately');
    await commentedDaysAgo(recent, 3);
    const today = await ticket('Answered today');
    await comment('carol', today, 'Answered now');
    const silent = await ticket('Never answered');
    const scope = 'summary ~ "answered OR quiet" AND track = IF';
    const scoped = `track = IF AND key in (${[old, recent, today, silent].map((t) => t.key).join(', ')})`;

    expect((await keys(`${scoped} AND daysSinceLastComment >= 5`)).sort()).toEqual([old.key]);
    expect((await keys(`${scoped} AND daysSinceLastComment < 5`)).sort()).toEqual(
      [recent.key, today.key].sort(),
    );
    expect(await keys(`${scoped} AND "Days since last comment" = 3`)).toEqual([recent.key]);
    expect(await keys(`${scoped} AND daysSinceLastComment is EMPTY`)).toEqual([silent.key]);
    expect(await keys(`${scoped} ORDER BY daysSinceLastComment DESC`)).toEqual([
      old.key,
      recent.key,
      today.key,
      silent.key,
    ]);
    expect(await keys(`${scoped} ORDER BY daysSinceLastComment`)).toEqual([
      today.key,
      recent.key,
      old.key,
      silent.key,
    ]);

    expect((await keys(`${scoped} AND firstResponse >= -5d`)).sort()).toEqual(
      [recent.key, today.key].sort(),
    );
    expect(await keys(`${scoped} AND "Date of first response" is EMPTY`)).toEqual([silent.key]);
    expect(await keys(`${scoped} ORDER BY firstResponse DESC`)).toEqual([
      today.key,
      recent.key,
      old.key,
      silent.key,
    ]);

    // Participants: the requester, the assignee and who wrote a readable comment.
    expect((await keys(`${scoped} AND participants = carol`)).sort()).toEqual([today.key]);
    expect((await keys(`${scoped} AND participants = currentUser()`, 'bob')).sort()).toEqual(
      [old.key, recent.key].sort(),
    );
    expect((await keys(`${scoped} AND participants != bob`)).sort()).toEqual(
      [today.key, silent.key].sort(),
    );
    expect(await keys(`${scope} AND participants is EMPTY`)).toEqual([]);
  });
});
