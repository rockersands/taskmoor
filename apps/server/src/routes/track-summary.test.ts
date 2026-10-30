import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `summary-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.87.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const DAY = 86_400_000;

interface Item {
  id: string;
  name: string | null;
  query: string;
  count: number;
  exact: boolean;
}

/**
 * A track's summary through the API (M1-064: "summary counts equal query counts"): tickets of
 * several types, priorities, stages and assignees, some old, some closed, some due soon; each
 * number is checked against the search API running the item's query, and against hand counts.
 */
describe('track summary (M1-064)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const status: Record<string, number> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const call = async (who: string, options: InjectOptions, code = 200) => {
    const res = await as(who, options);
    expect(res.statusCode, `${options.method} ${options.url}: ${res.body}`).toBe(code);
    return res.json();
  };

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['carol', false],
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
    const members = (await database.db.selectFrom('role').select(['id', 'name']).execute()).find(
      (r) => r.name === 'Members',
    )?.id as number;
    // Alice and bob are members of SUM; carol is not.
    await call(
      'admin',
      {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key: 'SUM', name: 'Summary', mode: 'shared' },
      },
      201,
    );
    const track = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'SUM')
      .executeTakeFirstOrThrow();
    for (const w of ['alice', 'bob']) {
      await database.db
        .insertInto('track_role_actor')
        .values({
          workspace_id: 1,
          track_id: track.id,
          role_id: members,
          user_id: users[w]?.id as number,
        })
        .execute();
    }
    for (const s of await database.db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
    const types = await database.db
      .selectFrom('ticket_type')
      .select(['id', 'name'])
      .where('owner_track_id', 'is', null)
      .execute();
    const type = (n: string) => types.find((t) => t.name === n)?.id as number;
    const priorities = await database.db.selectFrom('priority').select(['id', 'name']).execute();
    const priority = (n: string | null) =>
      n === null ? null : (priorities.find((p) => p.name === n)?.id ?? null);
    const closeReason = (
      await database.db
        .selectFrom('close_reason')
        .select('id')
        .orderBy('sort_order')
        .executeTakeFirstOrThrow()
    ).id;
    const soon = new Date(Date.now() + 3 * DAY).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    // name, type, priority, assignee, stage, created days ago, closed days ago, due
    for (const [name, kind, prio, assignee, stage, age, closed, due] of [
      ['one', 'Bug', 'High', 'alice', 'New', 1, null, soon],
      ['two', 'Bug', 'High', 'bob', 'Active', 2, null, later],
      ['three', 'Feature', 'Low', 'alice', 'Active', 20, null, null],
      ['four', 'Feature', null, null, 'New', 30, null, soon],
      ['five', 'Bug', 'Low', 'alice', 'Closed', 10, 3, null],
      ['six', 'Chore', 'High', 'bob', 'Closed', 40, 30, null],
    ] as const) {
      const made = (
        await call(
          'alice',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: {
              track: 'SUM',
              summary: `summary ${name}`,
              ticketTypeId: type(kind),
              priorityId: priority(prio),
              assigneeId: assignee === null ? null : users[assignee]?.id,
              ...(due ? { dueDate: due } : {}),
            },
          },
          201,
        )
      ).ticket;
      const createdAt = new Date(Date.now() - age * DAY);
      await database.db
        .updateTable('ticket')
        .set({
          created_at: createdAt,
          updated_at: createdAt,
          status_id: status[stage] as number,
          ...(closed !== null
            ? { close_reason_id: closeReason, closed_at: new Date(Date.now() - closed * DAY) }
            : {}),
        })
        .where('id', '=', made.id)
        .execute();
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-006] every number equals the count of the search it links to', async () => {
    const summary = await call('alice', { method: 'GET', url: '/api/v1/tracks/SUM/summary' });
    expect(summary.track).toMatchObject({ key: 'SUM', name: 'Summary' });
    const all: Item[] = [
      ...summary.overview,
      ...summary.stages,
      ...summary.priorities,
      ...summary.types,
      ...summary.assignees,
    ];
    for (const item of all) {
      const search = await call('alice', {
        method: 'GET',
        url: `/api/v1/search?q=${encodeURIComponent(item.query)}&count=true&limit=1`,
      });
      expect(search.total.count, item.query).toBe(item.count);
    }
    const counts = (list: Item[]) => list.map((i) => [i.name ?? i.id, i.count]);
    // Four open; two made in the last week; one closed in it; two due within a week.
    expect(counts(summary.overview)).toEqual([
      ['open', 4],
      ['created', 2],
      ['closed', 1],
      ['updated', 2],
      ['due', 2],
    ]);
    expect(counts(summary.stages)).toEqual([
      ['new', 2],
      ['active', 2],
      ['closed', 2],
    ]);
    expect(counts(summary.priorities)).toEqual([
      ['High', 2],
      ['Low', 1],
      ['none', 1],
    ]);
    expect(counts(summary.types)).toEqual([
      ['Bug', 2],
      ['Feature', 2],
    ]);
    expect(counts(summary.assignees)).toEqual([
      ['alice', 2],
      ['bob', 1],
      ['unassigned', 1],
    ]);
  });

  it('[RPT-006] is found by key or id, and only by those who browse the track', async () => {
    const byKey = await call('bob', { method: 'GET', url: '/api/v1/tracks/sum/summary' });
    const byId = await call('bob', {
      method: 'GET',
      url: `/api/v1/tracks/${byKey.track.id}/summary`,
    });
    expect(byId.overview).toEqual(byKey.overview);
    await call('carol', { method: 'GET', url: '/api/v1/tracks/SUM/summary' }, 404);
    await call('alice', { method: 'GET', url: '/api/v1/tracks/NOPE/summary' }, 404);
  });
});
