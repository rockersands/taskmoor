import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

// Made for this run: no password is written in the repository.
const PASSWORD = `general-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.83.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const names = (values: AxisValue[]) => values.map((v) => v.name ?? v.kind);

interface AxisValue {
  id: string | null;
  name: string | null;
  kind: string;
  total: number;
}

/**
 * General reports through the API (M1-062; RPT-002 (1), RPT-005 (2)): created vs closed over a
 * week of creations, closings and a reopening written at known moments, per day, week and
 * month, on two clocks; two-dimensional statistics over system and custom fields. Every number
 * was worked out by hand; a viewer who sees one track counts only its tickets.
 */
describe('general reports (M1-062)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const t: Record<string, { id: number; key: string }> = {};
  let tags = 0;
  let points = 0;
  let closeReason = 0;
  const QUERY = encodeURIComponent('summary ~ cvc');

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
  const get = (who: string, path: string, code = 200) =>
    call(who, { method: 'GET', url: `/api/v1/reports/${path}` }, code);

  /** A closing (or a reopening, with `reopen`) at a known moment, as the ticket routes write it. */
  async function closing(name: string, at: string, reopen = false) {
    await database.db
      .insertInto('ticket_change')
      .values({
        workspace_id: 1,
        ticket_id: t[name]?.id as number,
        change_set: '999999',
        field: 'closeReason',
        from_value: reopen ? String(closeReason) : null,
        to_value: reopen ? null : String(closeReason),
        from_display: reopen ? 'Done' : null,
        to_display: reopen ? null : 'Done',
        at: new Date(at),
      })
      .execute();
  }
  async function createdAt(name: string, at: string) {
    const id = t[name]?.id as number;
    await sql`UPDATE ticket SET created_at = ${at}::timestamptz WHERE id = ${id}::int`.execute(
      database.db,
    );
    await sql`UPDATE ticket_change SET at = ${at}::timestamptz WHERE ticket_id = ${id}::int`.execute(
      database.db,
    );
  }

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
    // Bob sees GA only; alice sees both.
    for (const [key, who] of [
      ['GA', ['alice', 'bob']],
      ['GB', ['alice']],
    ] as const) {
      const res = await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/tracks',
          payload: { key, name: `General ${key}`, mode: 'shared' },
        },
        201,
      );
      tracks[key] = res.track.id;
      for (const w of who) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[w]?.id as number,
          })
          .execute();
      }
    }
    closeReason = (
      await database.db
        .selectFrom('close_reason')
        .select('id')
        .orderBy('sort_order')
        .executeTakeFirstOrThrow()
    ).id;
    tags = (
      await call(
        'admin',
        {
          method: 'POST',
          url: '/api/v1/fields',
          payload: {
            name: 'Tags',
            type: 'select',
            multiple: true,
            context: { options: [{ value: 'A' }, { value: 'B' }, { value: 'C' }] },
          },
        },
        201,
      )
    ).field.id;
    points = (
      await call(
        'admin',
        { method: 'POST', url: '/api/v1/fields', payload: { name: 'Pts', type: 'number' } },
        201,
      )
    ).field.id;
    const options = await database.db
      .selectFrom('field_option')
      .select(['id', 'value'])
      .where('field_id', '=', tags)
      .execute();
    const tag = (value: string) => options.find((o) => o.value === value)?.id as number;
    const priorities = await database.db.selectFrom('priority').select(['id', 'name']).execute();
    const priority = (name: string) => priorities.find((p) => p.name === name)?.id ?? null;
    for (const [name, track, prio, labels, tagged, assignee] of [
      ['a', 'GA', 'High', ['x', 'y'], ['A', 'B'], 'alice'],
      ['b', 'GA', 'Low', ['x'], ['C'], 'bob'],
      ['c', 'GB', 'High', [], [], null],
      ['d', 'GA', null, ['y'], ['A'], 'alice'],
      ['e', 'GA', 'Low', [], [], 'alice'],
    ] as const) {
      t[name] = (
        await call(
          'alice',
          {
            method: 'POST',
            url: '/api/v1/tickets',
            payload: {
              track,
              summary: `cvc ${name}`,
              priorityId: prio === null ? null : priority(prio),
              labels: [...labels],
              assigneeId: assignee === null ? null : (users[assignee]?.id ?? null),
              fields: tagged.length > 0 ? { [tags]: tagged.map(tag) } : {},
            },
          },
          201,
        )
      ).ticket;
      // Only an import can leave a ticket with no priority (CORE-014).
      if (prio === null) {
        await database.db
          .updateTable('ticket')
          .set({ priority_id: null })
          .where('summary', '=', `cvc ${name}`)
          .execute();
      }
    }
    t.other = (
      await call(
        'alice',
        { method: 'POST', url: '/api/v1/tickets', payload: { track: 'GA', summary: 'unrelated' } },
        201,
      )
    ).ticket;
    await createdAt('a', '2026-10-05T10:00:00Z');
    await createdAt('b', '2026-10-05T23:30:00Z');
    await createdAt('c', '2026-10-06T09:00:00Z');
    await createdAt('d', '2026-10-01T10:00:00Z');
    await createdAt('e', '2026-10-12T10:00:00Z');
    await createdAt('other', '2026-10-06T10:00:00Z');
    await closing('a', '2026-10-06T12:00:00Z');
    await closing('b', '2026-10-07T09:00:00Z');
    await closing('b', '2026-10-08T10:00:00Z', true);
    await closing('b', '2026-10-09T15:00:00Z');
    await closing('d', '2026-10-08T11:00:00Z');
    await closing('c', '2026-10-11T18:00:00Z');
    await closing('other', '2026-10-07T10:00:00Z');
  });
  afterAll(async () => {
    await app.close();
  });

  it('[RPT-002] counts created and closed per day, closings as events', async () => {
    const week = `created-vs-closed?query=${QUERY}&from=2026-10-05&to=2026-10-11&timeZone=UTC`;
    const daily = await get('alice', week);
    expect(daily.periods).toEqual([
      '2026-10-05',
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
    ]);
    expect(daily.created).toEqual([2, 1, 0, 0, 0, 0, 0]);
    // b closes twice around its reopening; d was created before the week.
    expect(daily.closed).toEqual([0, 1, 1, 1, 1, 0, 1]);
    // Bob does not see GB: c is not his to count.
    const bob = await get('bob', week);
    expect([bob.created, bob.closed]).toEqual([
      [2, 0, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 1, 0, 0],
    ]);
  });

  it('[RPT-002] groups by week and month, on the viewer’s calendar', async () => {
    const weekly = await get(
      'alice',
      `created-vs-closed?query=${QUERY}&from=2026-10-05&to=2026-10-11&timeZone=UTC&period=week`,
    );
    expect([weekly.periods, weekly.created, weekly.closed]).toEqual([['2026-10-05'], [3], [5]]);
    const monthly = await get(
      'alice',
      `created-vs-closed?query=${QUERY}&from=2026-09-28&to=2026-10-11&timeZone=UTC&period=month`,
    );
    expect([monthly.periods, monthly.created, monthly.closed]).toEqual([
      ['2026-09-01', '2026-10-01'],
      [0, 4],
      [0, 5],
    ]);
    // In Tokyo b is created on the 6th, its second closing falls on the 10th and c's after the
    // week.
    const tokyo = await get(
      'alice',
      `created-vs-closed?query=${QUERY}&from=2026-10-05&to=2026-10-11&timeZone=Asia/Tokyo`,
    );
    expect([tokyo.created, tokyo.closed]).toEqual([
      [1, 2, 0, 0, 0, 0, 0],
      [0, 1, 1, 1, 0, 1, 0],
    ]);
  });

  it('[RPT-005] counts tickets by two fields, several values each and none apart', async () => {
    const table = await get('alice', `two-dimensional?query=${QUERY}&x=priority&y=labels`);
    expect(names(table.x)).toEqual(['High', 'Low', 'none']);
    expect(names(table.y)).toEqual(['x', 'y', 'none']);
    expect(table.cells).toEqual([
      [1, 1, 1],
      [1, 0, 1],
      [0, 1, 0],
    ]);
    // Totals count tickets: a has two labels and counts once in its row.
    expect(table.x.map((v: AxisValue) => v.total)).toEqual([2, 2, 1]);
    expect(table.y.map((v: AxisValue) => v.total)).toEqual([2, 2, 2]);
    expect(table.total).toBe(5);

    const custom = await get('alice', `two-dimensional?query=${QUERY}&x=cf[${tags}]&y=assignee`);
    expect(names(custom.x)).toEqual(['A', 'B', 'C', 'none']);
    expect(names(custom.y)).toEqual(['alice', 'bob', 'none']);
    expect(custom.cells).toEqual([
      [2, 0, 0],
      [1, 0, 0],
      [0, 1, 0],
      [1, 0, 1],
    ]);
    // Bob does not see c.
    const bob = await get('bob', `two-dimensional?query=${QUERY}&x=cf[${tags}]&y=assignee`);
    expect(bob.total).toBe(4);
    expect(names(bob.y)).toEqual(['alice', 'bob']);
  });

  it('[RPT-005] gathers the least frequent values as other past fifty', async () => {
    const many = Array.from({ length: 55 }, (_, i) => `l${String(i).padStart(2, '0')}`);
    await sql`UPDATE ticket SET labels = ${['x', 'y', ...many]}::text[] WHERE id = ${t.a?.id}::int`.execute(
      database.db,
    );
    const table = await get('alice', `two-dimensional?query=${QUERY}&x=labels&y=status`);
    expect(table.x).toHaveLength(52);
    expect(names(table.x)).toEqual([...many.slice(0, 48), 'x', 'y', 'other', 'none']);
    const other = table.x.find((v: AxisValue) => v.kind === 'other');
    expect(other).toMatchObject({ id: '*', total: 1 });
    // Seven gathered labels of one ticket: seven in the cell, one ticket in the total.
    expect(table.cells[50]).toEqual([7]);
  });

  it('[RPT-002] [RPT-005] refuses what it cannot read', async () => {
    const fields = async (path: string) => (await get('alice', path, 400)).fields;
    expect(await fields('two-dimensional?x=nope&y=status')).toEqual({ x: 'not_found' });
    expect(await fields(`two-dimensional?x=status&y=cf[${points}]`)).toEqual({
      y: 'not_groupable',
    });
    expect(await fields('two-dimensional?x=cf[999999]&y=cf[999998]')).toEqual({
      x: 'not_found',
      y: 'not_found',
    });
    expect(await fields('created-vs-closed?from=2026-10-09&to=2026-10-05')).toEqual({
      from: 'after_to',
    });
    expect(await fields('created-vs-closed?period=year')).toHaveProperty('period');
    expect(
      (
        await get(
          'alice',
          `two-dimensional?x=status&y=type&query=${encodeURIComponent('summary ~')}`,
          400,
        )
      ).error,
    ).toBe('invalid_query');
  });
});
