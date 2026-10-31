import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/** Generated per run: no credential is kept in the repository. */
const PASSWORD = randomBytes(18).toString('base64url');
let address = 0;
const nextAddress = () => `100.97.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const PEOPLE = ['admin', 'alice', 'bob', 'erin'] as const;
type Person = (typeof PEOPLE)[number];

/**
 * Entity properties (M1-129; API-013): JSON under a key on tickets, tracks, people, boards and
 * sprints, with who may read and write them, the limits, the events, and the declared indexes
 * that make a ticket property's values searchable.
 */
describe('entity properties (M1-129)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const tracks: Record<string, number> = {};
  const tickets: Record<string, { id: number; key: string }> = {};

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const get = (who: Person, url: string) => as(who, { method: 'GET', url });
  const post = (who: Person, url: string, payload: unknown = {}) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const put = (who: Person, url: string, value: unknown) =>
    as(who, { method: 'PUT', url, payload: { value } as Record<string, unknown> });
  const del = (who: Person, url: string) => as(who, { method: 'DELETE', url });
  const T = (name: string) => tickets[name] as { id: number; key: string };
  const prop = (name: string, key: string) =>
    `/api/v1/tickets/${T(name).key}/properties/${encodeURIComponent(key)}`;

  async function ticket(name: string, track: string) {
    const res = await post('alice', '/api/v1/tickets', { track, summary: `Ticket ${name}` });
    expect(res.statusCode, res.body).toBe(201);
    tickets[name] = res.json().ticket;
    return T(name);
  }
  /** The names of the tickets a query finds, sorted. */
  async function found(q: string, who: Person = 'alice') {
    const res = await get(who, `/api/v1/search?q=${encodeURIComponent(q)}&limit=200`);
    expect(res.statusCode, `${q}: ${res.body}`).toBe(200);
    const byId = new Map(Object.entries(tickets).map(([name, t]) => [t.id, name]));
    return (res.json().tickets as { id: number }[]).map((t) => byId.get(t.id) ?? `#${t.id}`).sort();
  }
  async function index(body: Record<string, unknown>) {
    const res = await post('admin', '/api/v1/admin/property-indexes', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().propertyIndex as { id: number };
  }
  const events = async (type: string) =>
    (
      await database.db
        .selectFrom('domain_event')
        .select(['subject_id', 'payload', 'actor_id'])
        .where('type', '=', type)
        .orderBy('id')
        .execute()
    ).map((e) => ({ subject: e.subject_id, payload: e.payload, actor: e.actor_id }));

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name: name[0]?.toUpperCase() + name.slice(1),
          password_hash: hash,
          is_site_admin: name === 'admin',
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
    const roles = await database.db.selectFrom('role').select(['id', 'name']).execute();
    const role = (name: string) => roles.find((r) => r.name === name)?.id as number;
    // Alice works in ABC and ARC; Bob only views ABC; Erin is in no track.
    for (const [key, actors] of [
      ['ABC', [['alice', 'Members'] as const, ['bob', 'Viewers'] as const]],
      ['ARC', [['alice', 'Members'] as const]],
    ] as const) {
      const res = await post('admin', '/api/v1/tracks', {
        key,
        name: `Track ${key}`,
        mode: 'shared',
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const [who, name] of actors) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: role(name),
            user_id: users[who].id,
          })
          .execute();
      }
    }
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[API-013] sets, replaces, reads, lists and deletes a ticket property', async () => {
    const t = await ticket('crud', 'ABC');
    const url = prop('crud', 'com.acme.review');
    const first = await put('alice', url, { state: 'pending', reviewers: [1, 2] });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().property).toMatchObject({
      key: 'com.acme.review',
      value: { state: 'pending', reviewers: [1, 2] },
    });
    const second = await put('alice', url, { state: 'approved' });
    expect(second.statusCode).toBe(200);
    // By key and by id alike; every JSON value is a value, null and scalars included.
    expect(
      (await get('bob', `/api/v1/tickets/${t.id}/properties/com.acme.review`)).json(),
    ).toMatchObject({ property: { value: { state: 'approved' } } });
    expect((await put('alice', prop('crud', 'flag'), false)).statusCode).toBe(201);
    expect((await put('alice', prop('crud', 'nothing'), null)).statusCode).toBe(201);
    expect((await get('alice', prop('crud', 'nothing'))).json().property.value).toBeNull();
    const list = (await get('alice', `/api/v1/tickets/${t.key}/properties`)).json().properties;
    expect(list.map((p: { key: string }) => p.key)).toEqual(['com.acme.review', 'flag', 'nothing']);

    expect((await del('alice', url)).statusCode).toBe(204);
    expect((await get('alice', url)).statusCode).toBe(404);
    expect((await del('alice', url)).statusCode).toBe(404);

    expect(await events('ticket.property_set')).toEqual([
      {
        subject: String(t.id),
        payload: { key: t.key, propertyKey: 'com.acme.review', created: true },
        actor: users.alice.id,
      },
      {
        subject: String(t.id),
        payload: { key: t.key, propertyKey: 'com.acme.review', created: false },
        actor: users.alice.id,
      },
      expect.objectContaining({ payload: expect.objectContaining({ propertyKey: 'flag' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ propertyKey: 'nothing' }) }),
    ]);
    expect(await events('ticket.property_deleted')).toEqual([
      {
        subject: String(t.id),
        payload: { key: t.key, propertyKey: 'com.acme.review' },
        actor: users.alice.id,
      },
    ]);
  });

  it('[API-013] reads with the right to see a ticket and writes with the right to edit it', async () => {
    await ticket('perm', 'ABC');
    const url = prop('perm', 'k');
    expect((await put('alice', url, 1)).statusCode).toBe(201);
    // Bob views the track: he reads but does not write.
    expect((await get('bob', url)).statusCode).toBe(200);
    expect((await put('bob', url, 2)).json()).toEqual({ error: 'forbidden' });
    expect((await del('bob', url)).statusCode).toBe(403);
    // Erin does not see the ticket: it answers as if there were none.
    expect((await get('erin', url)).json()).toEqual({ error: 'not_found' });
    expect((await put('erin', url, 2)).statusCode).toBe(404);
    expect((await get('erin', `/api/v1/tickets/${T('perm').key}/properties`)).statusCode).toBe(404);
    expect((await get('alice', '/api/v1/tickets/NOPE-1/properties')).statusCode).toBe(404);
  });

  it('[API-013] keeps the properties of an archived track readable and unchangeable', async () => {
    await ticket('arch', 'ARC');
    const url = prop('arch', 'k');
    expect((await put('alice', url, 'before')).statusCode).toBe(201);
    expect((await put('admin', '/api/v1/tracks/ARC/properties/k', 'track')).statusCode).toBe(201);
    expect((await post('admin', `/api/v1/tracks/${tracks.ARC}/archive`)).statusCode).toBe(200);
    expect((await get('alice', url)).json().property.value).toBe('before');
    expect((await put('alice', url, 'after')).json()).toEqual({ error: 'track_archived' });
    expect((await del('alice', url)).statusCode).toBe(409);
    expect((await del('admin', '/api/v1/tracks/ARC/properties/k')).statusCode).toBe(409);
  });

  it('[API-013] refuses an empty, long or control-character key and an oversized value', async () => {
    await ticket('limits', 'ABC');
    const long = 'k'.repeat(256);
    expect((await put('alice', prop('limits', long), 1)).json()).toEqual({
      error: 'invalid_fields',
      fields: { key: 'too_long' },
    });
    expect((await put('alice', prop('limits', 'k'.repeat(255)), 1)).statusCode).toBe(201);
    expect((await put('alice', prop('limits', 'a\u0001b'), 1)).json().fields).toEqual({
      key: 'control_character',
    });
    // 32,768 bytes of JSON text is the most a value may take.
    const fits = 'x'.repeat(32_768 - 2);
    expect((await put('alice', prop('limits', 'big'), fits)).statusCode).toBe(201);
    expect((await put('alice', prop('limits', 'big'), `${fits}x`)).json()).toEqual({
      error: 'invalid_fields',
      fields: { value: 'too_large' },
    });
    // Multi-byte characters count as their UTF-8 bytes.
    expect((await put('alice', prop('limits', 'big'), 'é'.repeat(16_384))).json().fields).toEqual({
      value: 'too_large',
    });
    const missing = await as('alice', { method: 'PUT', url: prop('limits', 'x'), payload: {} });
    expect(missing.json()).toEqual({ error: 'invalid_fields', fields: { value: 'required' } });
  });

  it('[API-013] keeps properties on tracks, people, boards and sprints with their own rights', async () => {
    // Tracks: those who browse it read; its administrators write.
    expect((await put('admin', '/api/v1/tracks/ABC/properties/team', { size: 4 })).statusCode).toBe(
      201,
    );
    expect((await get('bob', `/api/v1/tracks/${tracks.ABC}/properties/team`)).json()).toMatchObject(
      {
        property: { value: { size: 4 } },
      },
    );
    expect((await put('alice', '/api/v1/tracks/ABC/properties/team', 1)).statusCode).toBe(403);
    expect((await get('erin', '/api/v1/tracks/ABC/properties/team')).statusCode).toBe(404);

    // People: oneself and site administrators.
    expect((await put('bob', '/api/v1/users/me/properties/theme', 'dark')).statusCode).toBe(201);
    expect(
      (await get('admin', `/api/v1/users/${users.bob.id}/properties/theme`)).json().property.value,
    ).toBe('dark');
    expect((await get('alice', `/api/v1/users/${users.bob.id}/properties/theme`)).statusCode).toBe(
      404,
    );
    expect((await put('alice', `/api/v1/users/${users.bob.id}/properties/x`, 1)).statusCode).toBe(
      404,
    );

    // Boards: those who see it read; those who configure it write. Sprints: those who manage
    // the board's sprints write.
    const board = await post('admin', '/api/v1/boards', {
      name: 'Properties board',
      kind: 'scrum',
      trackId: tracks.ABC,
      source: { query: 'track = ABC' },
    });
    expect(board.statusCode, board.body).toBe(201);
    const boardId = board.json().board.id as number;
    const sprint = await post('admin', `/api/v1/boards/${boardId}/sprints`, {});
    expect(sprint.statusCode, sprint.body).toBe(201);
    const sprintId = sprint.json().sprint.id as number;
    for (const base of [`/api/v1/boards/${boardId}`, `/api/v1/sprints/${sprintId}`]) {
      expect((await put('admin', `${base}/properties/goal`, { points: 30 })).statusCode).toBe(201);
      expect((await get('alice', `${base}/properties/goal`)).json().property.value).toEqual({
        points: 30,
      });
      expect((await put('bob', `${base}/properties/goal`, 1)).statusCode).toBe(403);
      expect((await get('erin', `${base}/properties/goal`)).statusCode).toBe(404);
      expect((await del('admin', `${base}/properties/goal`)).statusCode).toBe(204);
    }
    expect((await get('alice', '/api/v1/boards/999999/properties')).statusCode).toBe(404);
    expect((await get('alice', '/api/v1/sprints/999999/properties')).statusCode).toBe(404);

    expect((await events('track.property_set')).at(-1)?.payload).toEqual({
      trackKey: 'ABC',
      propertyKey: 'team',
      created: true,
    });
    expect(await events('user.property_set')).toEqual([
      {
        subject: String(users.bob.id),
        payload: { propertyKey: 'theme', created: true },
        actor: users.bob.id,
      },
    ]);
    expect((await events('board.property_deleted')).map((e) => e.subject)).toEqual([
      String(boardId),
    ]);
    expect((await events('sprint.property_set')).map((e) => e.subject)).toEqual([String(sprintId)]);
  });

  it('[API-013] declares and drops indexes for configuration administrators only', async () => {
    expect(
      (await post('alice', '/api/v1/admin/property-indexes', { key: 'a', type: 'number' }))
        .statusCode,
    ).toBe(403);
    const made = await index({ key: 'idx.check', path: 'n', type: 'number', alias: 'checkN' });
    const list = (await get('admin', '/api/v1/admin/property-indexes')).json().propertyIndexes;
    expect(list).toContainEqual({
      id: made.id,
      key: 'idx.check',
      path: 'n',
      type: 'number',
      alias: 'checkN',
    });
    // The same key and path again, an alias in use, or one that hides a field, are refused.
    expect(
      (
        await post('admin', '/api/v1/admin/property-indexes', {
          key: 'idx.check',
          path: 'n',
          type: 'text',
        })
      ).json(),
    ).toEqual({ error: 'index_exists' });
    for (const alias of ['CHECKN', 'assignee', 'summary']) {
      expect(
        (
          await post('admin', '/api/v1/admin/property-indexes', {
            key: 'idx.other',
            type: 'number',
            alias,
          })
        ).json(),
      ).toEqual({ error: 'alias_taken' });
    }
    expect(
      (
        await post('admin', '/api/v1/admin/property-indexes', {
          key: 'idx.other',
          path: 'a..b',
          type: 'number',
        })
      ).json(),
    ).toEqual({ error: 'invalid_fields', fields: { path: 'empty_segment' } });
    expect(
      (await post('admin', '/api/v1/admin/property-indexes', { key: 'idx.other', type: 'float' }))
        .statusCode,
    ).toBe(400);
    expect((await del('admin', `/api/v1/admin/property-indexes/${made.id}`)).statusCode).toBe(204);
    expect((await del('admin', `/api/v1/admin/property-indexes/${made.id}`)).statusCode).toBe(404);
    expect((await events('property_index.created')).at(-1)?.payload).toEqual({
      key: 'idx.check',
      path: 'n',
      type: 'number',
      alias: 'checkN',
    });
    expect((await events('property_index.deleted')).at(-1)?.payload).toEqual({
      key: 'idx.check',
      path: 'n',
    });
  });

  describe('searching indexed values', () => {
    beforeAll(async () => {
      // Set before the indexes exist: declaring one fills it from what is there.
      await ticket('s1', 'ABC');
      await ticket('s2', 'ABC');
      await ticket('s3', 'ABC');
      await ticket('s4', 'ABC');
      await put('alice', prop('s1', 'support'), {
        level: 1,
        tier: 'Gold',
        note: 'Customer reports a broken printer',
        due: '2026-11-01',
        owner: 'Bob@Example.com',
        tags: ['vip', 'legal'],
      });
      await put('alice', prop('s2', 'support'), {
        level: 3,
        tier: 'Silver',
        note: 'Printer works again',
        due: '2026-12-15T09:30:00+01:00',
        owner: users.alice.id,
        tags: [{ name: 'vip' }],
      });
      await put('alice', prop('s3', 'support'), { level: 'high', tier: ['Gold', 'Bronze'] });
      await put('alice', prop('s4', 'other'), { level: 2 });
      await index({ key: 'support', path: 'level', type: 'number', alias: 'supportLevel' });
      await index({ key: 'support', path: 'tier', type: 'string' });
      await index({ key: 'support', path: 'note', type: 'text' });
      await index({ key: 'support', path: 'due', type: 'date' });
      await index({ key: 'support', path: 'owner', type: 'user' });
      await index({ key: 'support', path: 'tags', type: 'string' });
      await index({ key: 'support', path: 'tags.name', type: 'string', alias: 'tagName' });
    });

    it('[API-013] finds numbers, strings, words, dates and people at a path', async () => {
      expect(await found('ticket.property[support].level >= 2')).toEqual(['s2']);
      expect(await found('issue.property[support].level IN (1, 3)')).toEqual(['s1', 's2']);
      expect(await found('supportLevel < 2')).toEqual(['s1']);
      // A value of the wrong type is not indexed; s3's 'high' is no number.
      const some = ['s1', 's3', 's4'].map((n) => T(n).key).join(', ');
      expect(await found(`ticket.property[support].level IS EMPTY AND key IN (${some})`)).toEqual([
        's3',
        's4',
      ]);
      expect(await found('ticket.property[support].tier = Gold')).toEqual(['s1', 's3']);
      expect(await found('ticket.property[support].tier != Gold')).toEqual(['s2']);
      expect(await found('ticket.property[support].note ~ printer')).toEqual(['s1', 's2']);
      expect(await found('ticket.property[support].note ~ broken')).toEqual(['s1']);
      expect(await found('ticket.property[support].due < "2026-12-01"')).toEqual(['s1']);
      expect(await found('ticket.property[support].due >= "2026-12-15"')).toEqual(['s2']);
      expect(await found('ticket.property[support].owner = bob@example.com')).toEqual(['s1']);
      expect(await found('ticket.property[support].owner = currentUser()')).toEqual(['s2']);
    });

    it('[API-013] gives one value per array element along the path', async () => {
      expect(await found('ticket.property[support].tags = vip')).toEqual(['s1']);
      expect(await found('ticket.property[support].tags = legal')).toEqual(['s1']);
      expect(await found('tagName = vip')).toEqual(['s2']);
    });

    it('[API-013] orders by an indexed value', async () => {
      const res = await get(
        'alice',
        `/api/v1/search?q=${encodeURIComponent('supportLevel IS NOT EMPTY ORDER BY supportLevel DESC')}`,
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().tickets.map((t: { id: number }) => t.id)).toEqual([T('s2').id, T('s1').id]);
    });

    it('[API-013] refuses a path no index is declared for', async () => {
      const res = await get(
        'alice',
        `/api/v1/search?q=${encodeURIComponent('ticket.property[support].colour = red')}`,
      );
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('no property index is declared');
    });

    it('[API-013] follows property writes, the trash, restores and moves', async () => {
      await ticket('s5', 'ABC');
      expect((await put('alice', prop('s5', 'support'), { level: 9 })).statusCode).toBe(201);
      expect(await found('supportLevel = 9')).toEqual(['s5']);
      await put('alice', prop('s5', 'support'), { level: 8 });
      expect(await found('supportLevel = 9')).toEqual([]);
      expect(await found('supportLevel = 8')).toEqual(['s5']);
      expect((await del('admin', `/api/v1/tickets/${T('s5').key}`)).statusCode).toBe(204);
      expect(await found('supportLevel = 8', 'admin')).toEqual([]);
      expect((await post('admin', `/api/v1/tickets/${T('s5').id}/restore`)).statusCode).toBe(200);
      expect(await found('supportLevel = 8')).toEqual(['s5']);
      expect((await del('alice', prop('s5', 'support'))).statusCode).toBe(204);
      expect(await found('supportLevel = 8')).toEqual([]);
    });

    it('[API-013] takes concurrent first writes of a key as one set and the rest replaced', async () => {
      await ticket('s6', 'ABC');
      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          put('alice', prop('s6', 'support'), { level: 100 + i }),
        ),
      );
      expect(answers.map((a) => a.statusCode).sort()).toEqual([
        200, 200, 200, 200, 200, 200, 200, 201,
      ]);
      const last = (await get('alice', prop('s6', 'support'))).json().property.value.level;
      expect(await found(`supportLevel = ${last}`)).toEqual(['s6']);
      expect(await found('supportLevel >= 100')).toEqual(['s6']);
      expect((await del('alice', prop('s6', 'support'))).statusCode).toBe(204);
    });

    it('[API-013] shows only tickets the person sees', async () => {
      expect(await found('supportLevel IS NOT EMPTY', 'erin')).toEqual([]);
      expect(await found('supportLevel IS NOT EMPTY', 'bob')).toEqual(['s1', 's2']);
    });

    it('[API-013] keeps a dropped index out of the side tables', async () => {
      const made = await index({ key: 'other', path: 'level', type: 'string' });
      expect(await found('ticket.property[other].level = 2')).toEqual(['s4']);
      expect((await del('admin', `/api/v1/admin/property-indexes/${made.id}`)).statusCode).toBe(
        204,
      );
      const left = await database.db
        .selectFrom('p_text')
        .select('ticket_id')
        .where('field_id', '=', made.id)
        .execute();
      expect(left).toEqual([]);
    });
  });
});
