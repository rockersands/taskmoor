import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { QUERY_CASES, QueryError } from '@taskmoor/query';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { FieldCatalogs } from '../fields/catalog';
import { SearchError } from './bind';
import { queryCatalogue } from './catalogue';
import { prepareSearch } from './run';

// Made for this run: no password is written in the repository.
const PASSWORD = `history-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.78.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/**
 * WAS and CHANGED through `/api/v1/search` (M1-039; QRY-005): history written by the API's own
 * mutations (moved back in time where a query names dates), the three acceptance criteria of
 * QRY-005, and every history case of the conformance suite run on the server.
 */
describe('history operators through the search API (M1-039)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const status: Record<string, number> = {};
  const fields: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });
  const T = (name: string) => tickets[name] as { id: number; key: string };
  const K = (...names: string[]) => names.map((n) => T(n).key).sort();

  async function ticket(name: string, track: string, summary: string, who = 'alice') {
    const res = await as(who, {
      method: 'POST',
      url: '/api/v1/tickets',
      payload: { track, summary },
    });
    expect(res.statusCode, res.body).toBe(201);
    tickets[name] = res.json().ticket as { id: number; key: string };
  }
  async function edit(who: string, name: string, payload: Record<string, unknown>) {
    const res = await as(who, { method: 'PATCH', url: `/api/v1/tickets/${T(name).id}`, payload });
    expect(res.statusCode, res.body).toBe(200);
  }
  async function points(who: string, name: string, value: number) {
    await edit(who, name, { fields: { [String(fields.Points)]: value } });
  }
  async function transition(name: string, transitionId: number) {
    const res = await as('alice', {
      method: 'POST',
      url: `/api/v1/tickets/${T(name).id}/transitions`,
      payload: { transitionId },
    });
    expect(res.statusCode, res.body).toBe(200);
  }
  /**
   * Moves a ticket's history back in time, as if it had happened then: its change sets in the
   * order they were written take these times, the first (its creation) the ticket's too.
   */
  async function backdate(name: string, times: string[]) {
    const db = database.db;
    const { rows } = await sql<{ change_set: string }>`
      SELECT change_set FROM ticket_change WHERE ticket_id = ${T(name).id}
       GROUP BY change_set ORDER BY min(id)`.execute(db);
    expect(rows.map((r) => r.change_set)).toHaveLength(times.length);
    for (const [i, r] of rows.entries()) {
      await sql`UPDATE ticket_change SET at = ${times[i]}::timestamptz
                 WHERE ticket_id = ${T(name).id} AND change_set = ${r.change_set}`.execute(db);
    }
    await sql`UPDATE ticket SET created_at = ${times[0]}::timestamptz WHERE id = ${T(name).id}`.execute(
      db,
    );
  }
  const search = async (q: string, who = 'alice') => {
    const res = await as(who, {
      method: 'GET',
      url: `/api/v1/search?q=${encodeURIComponent(q)}&limit=200`,
    });
    return { status: res.statusCode, body: res.json() };
  };
  /** The keys a query finds, sorted. */
  const found = async (q: string, who = 'alice') => {
    const { status: code, body } = await search(q, who);
    expect(code, `${q}: ${JSON.stringify(body)}`).toBe(200);
    return (body.tickets as { key: string }[]).map((t) => t.key).sort();
  };

  beforeAll(async () => {
    const db = database.db;
    app = await buildApp({ db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
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
    const developers = await db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'developers' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: developers.id, user_id: users.alice?.id as number })
      .execute();
    const members = (
      await db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Members')
        .executeTakeFirstOrThrow()
    ).id;
    for (const key of ['HS', 'HB', 'ABC', 'WEB']) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const who of ['alice', 'bob']) {
        await db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: members,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    for (const s of await db.selectFrom('status').select(['id', 'name']).execute()) {
      status[s.name] = s.id;
    }
    // The conformance suite's custom fields, under its ids (cf[10016] and on), and Points.
    const field = async (id: number | null, payload: Record<string, unknown>) => {
      if (id !== null) await sql`SELECT setval('field_id_seq', ${id - 1})`.execute(db);
      const res = await as('admin', { method: 'POST', url: '/api/v1/fields', payload });
      expect(res.statusCode, res.body).toBe(201);
      const created = res.json().field.id as number;
      if (id !== null) expect(created).toBe(id);
      fields[payload.name as string] = created;
    };
    const options = (values: string[]) => ({ options: values.map((value) => ({ value })) });
    await field(10016, { name: 'Story Points', type: 'number' });
    await field(10020, { name: 'Team', type: 'select', context: options(['Platform', 'Mobile']) });
    await field(10021, {
      name: 'Platforms',
      type: 'select',
      multiple: true,
      context: options(['ios', 'android']),
    });
    await field(10022, { name: 'Target date', type: 'date' });
    await field(10023, { name: 'Approver', type: 'user' });
    await field(10024, { name: 'Notes', type: 'text' });
    await field(10025, { name: 'Tags', type: 'labels' });
    await field(null, { name: 'Points', type: 'number' });
    for (const release of ['1.0', '2.0']) {
      const res = await as('admin', {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.ABC}/releases`,
        payload: { name: release },
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const area = await as('admin', {
      method: 'POST',
      url: `/api/v1/tracks/${tracks.ABC}/areas`,
      payload: { name: 'API' },
    });
    expect(area.statusCode, area.body).toBe(201);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-005] points CHANGED FROM 3 TO 5 BY alice DURING ("2026-01-01", "2026-02-01") returns the right tickets', async () => {
    for (const n of ['p1', 'p2', 'p3', 'p4', 'p5']) await ticket(n, 'HS', `pointsgrp ${n}`);
    // p1: alice 3 then 5 in January. p2: bob makes it 5. p3: 5 only in March. p4: 3, 4, 5.
    // p5: 5 then 3.
    await points('alice', 'p1', 3);
    await points('alice', 'p1', 5);
    await backdate('p1', ['2025-12-01', '2026-01-05', '2026-01-20']);
    await points('alice', 'p2', 3);
    await points('bob', 'p2', 5);
    await backdate('p2', ['2025-12-01', '2026-01-05', '2026-01-20']);
    await points('alice', 'p3', 3);
    await points('alice', 'p3', 5);
    await backdate('p3', ['2025-12-01', '2026-01-05', '2026-03-03']);
    await points('alice', 'p4', 3);
    await points('alice', 'p4', 4);
    await points('alice', 'p4', 5);
    await backdate('p4', ['2025-12-01', '2026-01-05', '2026-01-08', '2026-01-25']);
    await points('alice', 'p5', 5);
    await points('alice', 'p5', 3);
    await backdate('p5', ['2025-12-01', '2026-01-05', '2026-01-09']);

    const scoped = (q: string) => found(`summary ~ pointsgrp AND (${q})`);
    expect(
      await found('points CHANGED FROM 3 TO 5 BY alice DURING ("2026-01-01", "2026-02-01")'),
    ).toEqual(K('p1'));
    expect(await scoped('points WAS 4')).toEqual(K('p4'));
    expect(await scoped('points WAS 5 BY bob')).toEqual(K('p2'));
    expect(await scoped('points CHANGED TO 5 AFTER 2026-02-01')).toEqual(K('p3'));
    expect(await scoped('points WAS 3 DURING (2026-01-10, 2026-01-12)')).toEqual(
      K('p1', 'p2', 'p3', 'p5'),
    );
    expect(await scoped('points WAS EMPTY ON 2025-12-15')).toEqual(K('p1', 'p2', 'p3', 'p4', 'p5'));
    expect(await scoped('points WAS NOT IN (4, EMPTY) AFTER 2026-01-01')).toEqual([]);
    expect(await scoped('points CHANGED FROM EMPTY TO 5')).toEqual(K('p5'));
    expect(await scoped('NOT points CHANGED BY bob')).toEqual(K('p1', 'p3', 'p4', 'p5'));
    // The same field by its id, in the Jira-compatible form.
    expect(await scoped(`cf[${fields.Points}] CHANGED FROM 3 TO 5`)).toEqual(K('p1', 'p2', 'p3'));
  });

  it('[QRY-005] status WAS "In Review" still matches after the status is renamed', async () => {
    await ticket('r1', 'HS', 'renamegrp one');
    await ticket('r2', 'HS', 'renamegrp two');
    // Start, Send to review, Back to active; the other ticket only starts.
    await transition('r1', 1);
    await transition('r1', 2);
    await transition('r1', 3);
    await transition('r2', 1);
    const scoped = (q: string) => found(`summary ~ renamegrp AND (${q})`);
    expect(await scoped('status WAS "In Review"')).toEqual(K('r1'));
    const rename = async (name: string) => {
      const res = await as('admin', {
        method: 'PATCH',
        url: `/api/v1/statuses/${status['In Review']}`,
        payload: { name },
      });
      expect(res.statusCode, res.body).toBe(200);
    };
    await rename('Reviewing');
    try {
      // By the name it had when the changes were written, and by its id under its new name.
      expect(await scoped('status WAS "In Review"')).toEqual(K('r1'));
      expect(await scoped('status WAS "in review"')).toEqual(K('r1'));
      expect(await scoped('status WAS Reviewing')).toEqual(K('r1'));
      expect(await scoped('status WAS NOT "In Review"')).toEqual(K('r2'));
      expect(await scoped('status CHANGED FROM "In Review" TO Active BY alice')).toEqual(K('r1'));
      expect(await scoped('stage WAS active')).toEqual(K('r1', 'r2'));
      // A name nothing ever had matches nothing; it is not refused (it may be an old name).
      expect(await scoped('status WAS "Never there"')).toEqual([]);
    } finally {
      await rename('In Review');
    }
  });

  it('[QRY-005] finds changes older than a ticket’s latest 10,000', async () => {
    const db = database.db;
    await ticket('b1', 'HB', 'manychanges');
    await ticket('b2', 'HB', 'fewchanges');
    await backdate('b1', ['2024-12-01']);
    await backdate('b2', ['2024-12-01']);
    // b1: closed on 2025-01-01 by alice, then 12,000 changes between Active and New by bob,
    // a minute apart.
    const ticketId = T('b1').id;
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value, from_display, to_display)
      VALUES (1, ${ticketId}, nextval('ticket_change_set_seq'), '2025-01-01T00:00:00Z',
              ${users.alice?.id}, 'status', ${String(status.New)}, ${String(status.Closed)},
              'New', 'Closed')`.execute(db);
    await sql`
      INSERT INTO ticket_change (workspace_id, ticket_id, change_set, at, actor_id, field,
                                 from_value, to_value)
      SELECT 1, ${ticketId}, nextval('ticket_change_set_seq'),
             timestamptz '2025-01-01T00:00:00Z' + g * interval '1 minute', ${users.bob?.id},
             'status',
             CASE WHEN g = 1 THEN ${String(status.Closed)} WHEN g % 2 = 0 THEN ${String(status.Active)} ELSE ${String(status.New)} END,
             CASE WHEN g % 2 = 1 THEN ${String(status.Active)} ELSE ${String(status.New)} END
        FROM generate_series(1, 12000) AS g`.execute(db);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM ticket_change WHERE ticket_id = ${ticketId}`.execute(db);
    expect(rows[0]?.n).toBeGreaterThan(12_000);
    const scoped = (q: string) => found(`track = HB AND (${q})`);
    const started = performance.now();
    expect(await scoped('status WAS Closed')).toEqual(K('b1'));
    expect(await scoped('status CHANGED TO Closed BY alice BEFORE 2025-01-02')).toEqual(K('b1'));
    expect(await scoped('status CHANGED FROM Closed')).toEqual(K('b1'));
    expect(
      await scoped('status WAS Closed DURING ("2025-01-01 00:00", "2025-01-01 00:00")'),
    ).toEqual(K('b1'));
    // Closed lasted one minute: not after it, and never on a later day.
    expect(await scoped('status WAS Closed AFTER "2025-01-01 00:01"')).toEqual([]);
    expect(await scoped('status WAS Closed ON 2025-01-03')).toEqual([]);
    expect(await scoped('status WAS NOT Closed')).toEqual(K('b2'));
    // Seven queries on a ticket with 12,001 status changes; each walks the ticket's own index.
    expectWithinBudget(
      performance.now() - started,
      10_000,
      'seven history queries on 12,001 changes (ms)',
    );
  });

  it('[QRY-005] reads history on every kind of field, under both vocabularies', async () => {
    await ticket('f1', 'HS', 'fieldsgrp one');
    await ticket('f2', 'HS', 'fieldsgrp two');
    const user = (name: string) => users[name]?.id as number;
    const option = async (field: string, value: string) =>
      (
        await database.db
          .selectFrom('field_option')
          .select('id')
          .where('field_id', '=', fields[field] as number)
          .where('value', '=', value)
          .executeTakeFirstOrThrow()
      ).id;
    await edit('alice', 'f1', {
      summary: 'fieldsgrp one renamed',
      assigneeId: user('bob'),
      labels: ['backend'],
      dueDate: '2026-01-31',
      fields: {
        [String(fields.Team)]: await option('Team', 'Platform'),
        [String(fields.Platforms)]: [await option('Platforms', 'ios')],
        [String(fields.Tags)]: ['alpha', 'beta'],
        [String(fields.Approver)]: user('alice'),
        [String(fields.Notes)]: 'first draft',
      },
    });
    await edit('bob', 'f1', {
      assigneeId: null,
      labels: ['frontend'],
      fields: {
        [String(fields.Team)]: await option('Team', 'Mobile'),
        [String(fields.Platforms)]: [
          await option('Platforms', 'ios'),
          await option('Platforms', 'android'),
        ],
        [String(fields.Tags)]: ['beta'],
        [String(fields.Notes)]: 'second draft',
      },
    });
    const scoped = (q: string) => found(`summary ~ fieldsgrp AND (${q})`);
    // Text is matched by its words, as ~ matches it.
    expect(await scoped('summary WAS "fieldsgrp one"')).toEqual(K('f1'));
    expect(await scoped('summary WAS fieldsgrp')).toEqual(K('f1', 'f2'));
    expect(await scoped('summary WAS renamed')).toEqual(K('f1'));
    expect(await scoped('summary CHANGED')).toEqual(K('f1'));
    expect(await scoped('assignee WAS bob')).toEqual(K('f1'));
    expect(await scoped('assignee CHANGED FROM bob TO EMPTY BY bob')).toEqual(K('f1'));
    expect(await scoped('assignee WAS NOT EMPTY')).toEqual([]);
    expect(await scoped('labels WAS backend')).toEqual(K('f1'));
    expect(await scoped('labels CHANGED TO frontend')).toEqual(K('f1'));
    expect(await scoped('labels CHANGED FROM frontend')).toEqual([]);
    expect(await scoped('dueDate WAS 2026-01-31')).toEqual(K('f1'));
    expect(await scoped('due CHANGED FROM EMPTY')).toEqual(K('f1'));
    expect(await scoped('Team WAS Platform')).toEqual(K('f1'));
    expect(await scoped('Team CHANGED FROM Platform TO Mobile BY bob')).toEqual(K('f1'));
    expect(await scoped('Platforms WAS android')).toEqual(K('f1'));
    expect(await scoped('Platforms CHANGED TO android')).toEqual(K('f1'));
    expect(await scoped('Platforms CHANGED FROM ios')).toEqual([]);
    expect(await scoped('Tags CHANGED FROM alpha')).toEqual(K('f1'));
    expect(await scoped('Approver WAS alice')).toEqual(K('f1'));
    expect(await scoped('Notes WAS "first draft"')).toEqual(K('f1'));
    expect(await scoped('Notes CHANGED TO second')).toEqual(K('f1'));
    expect(await scoped('creator WAS alice')).toEqual(K('f1', 'f2'));
    expect(await scoped('reporter WAS alice BY alice')).toEqual(K('f1', 'f2'));
    expect(await scoped('issuetype WAS Bug OR type WAS NOT Bug')).toEqual(K('f1', 'f2'));
    expect(await scoped('project WAS HS AND track CHANGED')).toEqual([]);
    expect(await scoped('status CHANGED')).toEqual([]);
  });

  it('[QRY-005] refuses, saying why, what history cannot answer', async () => {
    for (const [q, message] of [
      ['sprint WAS 42', 'sprint changes'],
      ['ticketLink WAS EMPTY', 'not available for links'],
      ['parent WAS IN watchedIssues()', 'cannot be used in WAS or CHANGED'],
      ['status WAS Done FROM New', 'goes with CHANGED'],
      ['updated CHANGED', 'keeps no change history'],
    ] as const) {
      const { status: code, body } = await search(q);
      expect(code, q).toBe(400);
      expect(JSON.stringify(body), q).toContain(message);
    }
  });

  it('[QRY-005] runs every history case of the conformance suite on the server', async () => {
    const db = database.db;
    const catalog = await new FieldCatalogs(db).get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, 'all');
    const history = QUERY_CASES.filter(
      (c) =>
        c.kind === 'resolve' &&
        c.expect.ok &&
        (c.section === 'history' || / (WAS|CHANGED)\b/.test(c.text)),
    );
    expect(history.length).toBeGreaterThan(150);
    const refused: string[] = [];
    for (const c of history) {
      if (c.kind !== 'resolve') continue;
      try {
        const { compiled } = await prepareSearch({
          db,
          workspaceId: 1,
          catalog,
          catalogue,
          filter: { sql: sql<boolean>`true`, tracks: 'all' },
          q: c.text,
          currentUserId: users.alice?.id as number,
        });
        await compiled.page(51).execute(db);
        await compiled.count(1_001).execute(db);
      } catch (error) {
        if (!(error instanceof SearchError || error instanceof QueryError)) throw error;
        refused.push(`${c.text}: ${error.message}`);
      }
    }
    // Not built: sprint history (sprint changes are kept apart, M1-044) and saved searches,
    // which have no history of their own.
    expect(refused.sort()).toEqual([
      expect.stringMatching(/^savedSearch CHANGED: /),
      expect.stringMatching(/^savedSearch WAS 10001: /),
      expect.stringMatching(/^savedSearch WAS IN \(10001\): /),
      expect.stringMatching(/^savedSearch WAS NOT 10001: /),
      expect.stringMatching(/^savedSearch WAS NOT IN \(10001\): /),
      expect.stringMatching(/^sprint CHANGED: /),
      expect.stringMatching(/^sprint WAS 42: /),
      expect.stringMatching(/^sprint WAS IN \(42\): /),
      expect.stringMatching(/^sprint WAS NOT 42: /),
      expect.stringMatching(/^sprint WAS NOT IN \(42\): /),
    ]);
  });
});
