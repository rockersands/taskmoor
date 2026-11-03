import { randomBytes } from 'node:crypto';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import type { OutgoingEmail } from '../email/transport';
import { FieldCatalogs } from '../fields/catalog';
import { MAX_REFERENCE_DEPTH } from '../search/saved';
import { deliverSubscriptions } from '../search/subscriptions';

// Made for this run: no password is written in the repository.
const PASSWORD = `saved-${randomBytes(18).toString('base64url')}`;
let address = 0;
const nextAddress = () => `100.76.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

interface Saved {
  id: number;
  name: string;
  query: string;
  owner: { id: number; name: string };
  shares: { scope: string }[];
  starred: boolean;
  editable: boolean;
  version: number;
}

/**
 * Saved searches (M1-063): sharing scopes and who sees, runs, edits and shares; references in
 * queries with cycle detection; subscriptions emailed as each recipient; boards on a saved
 * search.
 */
describe('saved searches (M1-063)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users: Record<string, { id: number; cookie: string }> = {};
  const tracks: Record<string, number> = {};
  const keys: Record<string, string> = {};
  let roles: Record<string, number> = {};
  let developers = 0;
  let outer = 0;

  const as = (who: string | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? (users[who]?.cookie ?? '') : '' },
    });
  const get = (who: string | null, url: string) => as(who, { method: 'GET', url });
  const post = (who: string, url: string, payload: unknown) =>
    as(who, { method: 'POST', url, payload: payload as Record<string, unknown> });
  const patch = (who: string, url: string, payload: unknown) =>
    as(who, { method: 'PATCH', url, payload: payload as Record<string, unknown> });
  const del = (who: string, url: string) => as(who, { method: 'DELETE', url });

  async function save(who: string, body: Record<string, unknown>): Promise<Saved> {
    const res = await post(who, '/api/v1/saved-searches', body);
    expect(res.statusCode, res.body).toBe(201);
    return res.json().savedSearch as Saved;
  }
  async function search(who: string, q: string) {
    const res = await post(who, '/api/v1/search', { q });
    return res;
  }
  async function found(who: string, q: string): Promise<string[]> {
    const res = await search(who, q);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json().tickets as { key: string }[]).map((t) => t.key).sort();
  }
  const sees = async (who: string, id: number) =>
    (await get(who, `/api/v1/saved-searches/${id}`)).statusCode === 200;

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
      ['bob', false],
      ['carol', false],
      ['dave', false],
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
    roles = Object.fromEntries(
      (await database.db.selectFrom('role').select(['id', 'name']).execute()).map((r) => [
        r.name,
        r.id,
      ]),
    );
    // A role named as in QRY-011 (1).
    developers = (
      await database.db
        .insertInto('role')
        .values({ workspace_id: 1, name: 'Developers' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    roles.Developers = developers;
    // SA: alice and bob members, carol a developer. SB: alice only.
    for (const [key, members] of [
      [
        'SA',
        [
          ['alice', 'Members'],
          ['bob', 'Members'],
          ['carol', 'Developers'],
        ],
      ],
      ['SB', [['alice', 'Members']]],
    ] as const) {
      const res = await as('admin', {
        method: 'POST',
        url: '/api/v1/tracks',
        payload: { key, name: `Track ${key}`, mode: 'shared' },
      });
      expect(res.statusCode, res.body).toBe(201);
      tracks[key] = res.json().track.id;
      for (const [who, roleName] of members) {
        await database.db
          .insertInto('track_role_actor')
          .values({
            workspace_id: 1,
            track_id: tracks[key] as number,
            role_id: roles[roleName] as number,
            user_id: users[who]?.id as number,
          })
          .execute();
      }
    }
    // Developers browse SA like members do.
    const policy = await database.db
      .selectFrom('track')
      .select('access_policy_id')
      .where('id', '=', tracks.SA as number)
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('access_grant')
      .values({
        workspace_id: 1,
        policy_id: policy.access_policy_id as number,
        permission: 'browse_track',
        grantee: 'role',
        role_id: developers,
      })
      .execute();
    for (const [name, track] of [
      ['a1', 'SA'],
      ['a2', 'SA'],
      ['b1', 'SB'],
    ] as const) {
      const res = await post('alice', '/api/v1/tickets', { track, summary: `ticket ${name}` });
      expect(res.statusCode, res.body).toBe(201);
      keys[name] = res.json().ticket.key;
    }
    // A group inside another: dave is in the inner one.
    const group = async (name: string) =>
      (
        await database.db
          .insertInto('user_group')
          .values({ workspace_id: 1, name })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    outer = await group('Readers');
    const inner = await group('Night readers');
    await database.db
      .insertInto('group_nesting')
      .values({ workspace_id: 1, parent_id: outer, child_id: inner })
      .execute();
    await database.db
      .insertInto('group_member')
      .values([
        { workspace_id: 1, group_id: inner, user_id: users.dave?.id as number },
        { workspace_id: 1, group_id: outer, user_id: users.alice?.id as number },
        { workspace_id: 1, group_id: outer, user_id: users.bob?.id as number },
      ])
      .execute();
  });
  afterAll(async () => {
    await app.close();
  });

  it('[QRY-011] keeps a saved search private to its owner until it is shared', async () => {
    const mine = await save('alice', {
      name: 'Alice private',
      description: 'just mine',
      query: 'track = SA ORDER BY created',
      columns: ['summary', 'status'],
    });
    expect(mine).toMatchObject({ owner: { id: users.alice?.id }, shares: [], editable: true });
    expect(await sees('alice', mine.id)).toBe(true);
    expect(await sees('bob', mine.id)).toBe(false);
    expect(await sees('admin', mine.id)).toBe(true);
    const list = (await get('bob', '/api/v1/saved-searches')).json().savedSearches as Saved[];
    expect(list.map((s) => s.id)).not.toContain(mine.id);
    // Names are unique per owner, ignoring case; another person may use the same name.
    const again = await post('alice', '/api/v1/saved-searches', {
      name: 'alice PRIVATE',
      query: 'track = SA',
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().fields).toEqual({ name: 'taken' });
    await save('bob', { name: 'Alice private', query: 'track = SA' });
  });

  it('[QRY-011] (1) a saved search shared with role Developers in track SA is visible only to them', async () => {
    const shared = await save('alice', {
      name: 'For developers',
      query: 'track = SA',
      shares: [{ scope: 'track', trackId: tracks.SA, roleId: developers }],
    });
    expect(await sees('carol', shared.id)).toBe(true);
    expect(await sees('bob', shared.id)).toBe(false);
    expect(await sees('dave', shared.id)).toBe(false);
    // Every member of the track, whatever the role.
    const track = await save('alice', {
      name: 'For SA',
      query: 'track = SA',
      shares: [{ scope: 'track', trackId: tracks.SA }],
    });
    expect(await sees('bob', track.id)).toBe(true);
    expect(await sees('carol', track.id)).toBe(true);
    expect(await sees('dave', track.id)).toBe(false);
    // A track the person cannot browse is not theirs to share with.
    const hidden = await post('bob', '/api/v1/saved-searches', {
      name: 'Into SB',
      query: 'track = SA',
      shares: [{ scope: 'track', trackId: tracks.SB }],
    });
    expect(hidden.statusCode).toBe(400);
    expect(hidden.json().fields).toEqual({ 'shares.0.trackId': 'not_found' });
  });

  it('[QRY-011] shares with a person, a group (nested ones too) and everyone signed in', async () => {
    const person = await save('alice', {
      name: 'For bob',
      query: 'track = SA',
      shares: [{ scope: 'user', userId: users.bob?.id }],
    });
    expect(await sees('bob', person.id)).toBe(true);
    expect(await sees('carol', person.id)).toBe(false);
    const group = await save('alice', {
      name: 'For readers',
      query: 'track = SA',
      shares: [{ scope: 'group', groupId: outer }],
    });
    expect(await sees('dave', group.id)).toBe(true);
    expect(await sees('carol', group.id)).toBe(false);
    const everyone = await save('alice', {
      name: 'For everyone',
      query: 'track = SA',
      shares: [{ scope: 'any_user' }],
    });
    for (const who of ['bob', 'carol', 'dave']) expect(await sees(who, everyone.id)).toBe(true);
    expect((await get(null, `/api/v1/saved-searches/${everyone.id}`)).statusCode).toBe(404);
  });

  it('[QRY-011] (3) public saved searches are the only ones anonymous visitors reach', async () => {
    const open = await save('alice', {
      name: 'Public one',
      query: 'summary ~ ticket',
      shares: [{ scope: 'public' }],
    });
    const anonymous = await get(null, `/api/v1/saved-searches/${open.id}`);
    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json().savedSearch).toMatchObject({ name: 'Public one', editable: false });
    // Running it anonymously shows only what anonymous access grants: here, nothing.
    const run = await as(null, {
      method: 'POST',
      url: '/api/v1/search',
      payload: { q: `savedSearch = ${open.id}` },
    });
    expect(run.statusCode, run.body).toBe(200);
    expect(run.json().tickets).toEqual([]);
    expect((await get(null, '/api/v1/saved-searches')).statusCode).toBe(401);
  });

  it('[QRY-011] sharing needs "Share dashboards and saved searches"; editing is the owner\'s', async () => {
    const own = await save('bob', { name: 'Bob only', query: 'track = SA' });
    await database.db
      .deleteFrom('global_grant')
      .where('permission', '=', 'share_saved_searches')
      .execute();
    try {
      const refused = await post('bob', '/api/v1/saved-searches', {
        name: 'Bob shares',
        query: 'track = SA',
        shares: [{ scope: 'any_user' }],
      });
      expect(refused.statusCode, refused.body).toBe(403);
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'share_saved_searches' });
      const share = await patch('bob', `/api/v1/saved-searches/${own.id}`, {
        shares: [{ scope: 'any_user' }],
      });
      expect(share.statusCode).toBe(403);
      // A private one needs no permission.
      await save('bob', { name: 'Still private', query: 'track = SA' });
    } finally {
      await database.db
        .insertInto('global_grant')
        .values({ workspace_id: 1, permission: 'share_saved_searches', grantee: 'any_user' })
        .execute();
    }
    const shared = await patch('bob', `/api/v1/saved-searches/${own.id}`, {
      shares: [{ scope: 'any_user' }],
    });
    expect(shared.statusCode, shared.body).toBe(200);
    // Seen but not editable by others; the owner and site administrators edit.
    expect(
      (await get('carol', `/api/v1/saved-searches/${own.id}`)).json().savedSearch.editable,
    ).toBe(false);
    const edit = await patch('carol', `/api/v1/saved-searches/${own.id}`, { name: 'Carol now' });
    expect(edit.statusCode).toBe(403);
    expect((await del('carol', `/api/v1/saved-searches/${own.id}`)).statusCode).toBe(403);
    // Only site administrators change the owner.
    const take = await patch('bob', `/api/v1/saved-searches/${own.id}`, {
      ownerId: users.carol?.id,
    });
    expect(take.statusCode).toBe(403);
    const given = await patch('admin', `/api/v1/saved-searches/${own.id}`, {
      ownerId: users.carol?.id,
    });
    expect(given.statusCode, given.body).toBe(200);
    expect(given.json().savedSearch.owner.id).toBe(users.carol?.id);
    const events = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('subject_type', '=', 'saved_search')
      .where('subject_id', '=', String(own.id))
      .orderBy('id')
      .execute();
    expect(events.map((e) => e.type)).toEqual([
      'saved_search.created',
      'saved_search.updated',
      'saved_search.updated',
    ]);
    expect(events[2]?.payload).toMatchObject({
      changes: { ownerId: { from: users.bob?.id, to: users.carol?.id } },
    });
    expect((await del('admin', `/api/v1/saved-searches/${own.id}`)).statusCode).toBe(204);
  });

  it('[QRY-008] a saved search never shows a ticket its runner could not find themselves', async () => {
    const wide = await save('alice', {
      name: 'Both tracks',
      query: 'summary ~ ticket',
      shares: [{ scope: 'user', userId: users.bob?.id }],
    });
    expect(await found('alice', `savedSearch = ${wide.id}`)).toEqual(
      [keys.a1, keys.a2, keys.b1].sort(),
    );
    // Bob does not browse SB: the same saved search shows him only SA's tickets.
    const bobs = await search('bob', `savedSearch = ${wide.id}`);
    expect(bobs.statusCode, bobs.body).toBe(200);
    expect((bobs.json().tickets as { key: string }[]).map((t) => t.key).sort()).toEqual(
      [keys.a1, keys.a2].sort(),
    );
  });

  it("[QRY-011] references run the saved search's condition by name, id, IN and negation", async () => {
    const one = await save('alice', { name: 'Ticket a1', query: `key = ${keys.a1}` });
    const two = await save('alice', { name: 'Ticket b1', query: `key = ${keys.b1} ORDER BY key` });
    const all = await save('alice', { name: 'Everything', query: '' });
    expect(await found('alice', 'filter = "Ticket a1"')).toEqual([keys.a1]);
    expect(await found('alice', `savedSearch = ${one.id}`)).toEqual([keys.a1]);
    expect(await found('alice', `request IN ("Ticket a1", ${two.id})`)).toEqual(
      [keys.a1, keys.b1].sort(),
    );
    expect(await found('alice', 'track = SA AND savedFilter != "Ticket a1"')).toEqual([keys.a2]);
    expect(await found('alice', `filter = ${all.id} AND track = SB`)).toEqual([keys.b1]);
    // Nested: a saved search of saved searches.
    await save('alice', { name: 'Both tickets', query: `filter IN (${one.id}, ${two.id})` });
    expect(await found('alice', 'searchRequest = "Both tickets"')).toEqual(
      [keys.a1, keys.b1].sort(),
    );
    const op = await search('alice', 'filter ~ "Ticket a1"');
    expect(op.statusCode).toBe(400);
  });

  it('[QRY-011] a hidden saved search reads exactly like one that does not exist', async () => {
    const hidden = await save('alice', { name: 'Hidden one', query: 'track = SA' });
    const byName = await search('bob', 'filter = "Hidden one"');
    const missing = await search('bob', 'filter = "Hidden two"');
    expect(byName.statusCode).toBe(400);
    expect(missing.statusCode).toBe(400);
    const strip = (body: Record<string, unknown>, name: string) =>
      JSON.stringify(body).replaceAll(name, 'X');
    expect(strip(byName.json(), 'Hidden one')).toBe(strip(missing.json(), 'Hidden two'));
    const unused = '9'.repeat(String(hidden.id).length);
    const byId = await search('bob', `filter = ${hidden.id}`);
    const noId = await search('bob', `filter = ${unused}`);
    expect(strip(byId.json(), String(hidden.id))).toBe(strip(noId.json(), unused));
    expect(byId.json().message).toBe(`Saved search "${hidden.id}" does not exist`);
    // The query editor's check says the same as the query is typed.
    const check = await get(
      'bob',
      `/api/v1/search/check?q=${encodeURIComponent('filter = "Hidden one"')}`,
    );
    expect(check.json()).toMatchObject({
      ok: false,
      error: { message: 'Saved search "Hidden one" does not exist', position: 9 },
    });
    const fine = await get(
      'alice',
      `/api/v1/search/check?q=${encodeURIComponent('filter = "Hidden one"')}`,
    );
    expect(fine.json()).toMatchObject({ ok: true, fields: [{ name: 'track', custom: null }] });
  });

  it('[QRY-011] (2) a saved search that refers back to itself through another is refused on save', async () => {
    const a = await save('alice', { name: 'Loop A', query: 'track = SA' });
    const b = await save('alice', { name: 'Loop B', query: 'filter = "Loop A"' });
    const loop = await patch('alice', `/api/v1/saved-searches/${a.id}`, {
      query: 'filter = "Loop B" AND track = SA',
    });
    expect(loop.statusCode, loop.body).toBe(400);
    expect(loop.json()).toMatchObject({
      error: 'invalid_query',
      message: 'Saved searches refer to each other in a cycle: "Loop A" → "Loop B" → "Loop A"',
      position: 9,
    });
    const self = await patch('alice', `/api/v1/saved-searches/${b.id}`, {
      query: `savedSearch = ${b.id}`,
    });
    expect(self.statusCode).toBe(400);
    expect(self.json().message).toBe(
      'Saved searches refer to each other in a cycle: "Loop B" → "Loop B"',
    );
    // Unchanged: the refused query was not kept.
    expect((await get('alice', `/api/v1/saved-searches/${a.id}`)).json().savedSearch.query).toBe(
      'track = SA',
    );
  });

  it(`[QRY-011] refuses references nested more than ${MAX_REFERENCE_DEPTH} deep`, async () => {
    let previous = (await save('alice', { name: 'Depth 0', query: 'track = SA' })).id;
    for (let i = 1; i <= MAX_REFERENCE_DEPTH; i++) {
      previous = (await save('alice', { name: `Depth ${i}`, query: `filter = ${previous}` })).id;
    }
    expect(await found('alice', `filter = "Depth ${MAX_REFERENCE_DEPTH - 1}"`)).toEqual(
      [keys.a1, keys.a2].sort(),
    );
    const deep = await search('alice', `filter = ${previous}`);
    expect(deep.statusCode).toBe(400);
    expect(deep.json().message).toMatch(/nest more than 10 deep/);
  });

  it('[QRY-011] stars a saved search for the person and lists the starred ones', async () => {
    const s = await save('alice', { name: 'Starred', query: 'track = SA' });
    expect(
      (await as('alice', { method: 'PUT', url: `/api/v1/saved-searches/${s.id}/star` })).statusCode,
    ).toBe(204);
    const starred = (await get('alice', '/api/v1/saved-searches?filter=starred')).json()
      .savedSearches as Saved[];
    expect(starred.map((x) => x.name)).toEqual(['Starred']);
    expect(starred[0]?.starred).toBe(true);
    // Somebody else's hidden one cannot be starred.
    expect(
      (await as('bob', { method: 'PUT', url: `/api/v1/saved-searches/${s.id}/star` })).statusCode,
    ).toBe(404);
    await del('alice', `/api/v1/saved-searches/${s.id}/star`);
    expect(
      (await get('alice', '/api/v1/saved-searches?filter=starred')).json().savedSearches,
    ).toEqual([]);
  });

  it('[QRY-012] emails the results on schedule, to each group member only what they may browse', async () => {
    const both = await save('alice', {
      name: 'Morning list',
      query: 'summary ~ ticket',
      shares: [{ scope: 'group', groupId: outer }],
    });
    // A group subscription needs "Manage group search subscriptions".
    const refused = await post('alice', `/api/v1/saved-searches/${both.id}/subscriptions`, {
      groupId: outer,
      schedule: 'daily',
    });
    expect(refused.statusCode).toBe(403);
    const group = await post('admin', `/api/v1/saved-searches/${both.id}/subscriptions`, {
      groupId: outer,
      schedule: 'weekly',
      weekday: 1,
      hour: 7,
      timeZone: 'Europe/Berlin',
    });
    expect(group.statusCode, group.body).toBe(201);
    const self = await post('alice', `/api/v1/saved-searches/${both.id}/subscriptions`, {
      schedule: 'cron',
      cron: '30 6 * * 1-5',
      onlyIfResults: true,
    });
    expect(self.statusCode, self.body).toBe(201);
    const bad = await post('alice', `/api/v1/saved-searches/${both.id}/subscriptions`, {
      schedule: 'cron',
      cron: '61 * * * *',
    });
    expect(bad.statusCode).toBe(400);
    const nextRunAt = new Date(group.json().subscription.nextRunAt);
    expect(nextRunAt.getUTCHours()).toBeGreaterThanOrEqual(5);

    const sent: OutgoingEmail[] = [];
    const transport = {
      send: async (email: OutgoingEmail) => {
        sent.push(email);
        return { messageId: null };
      },
    };
    const options = {
      transport,
      from: 'taskmoor@example.com',
      publicUrl: 'https://taskmoor.example.com',
    };
    const authorizer = new Authorizer(database.db);
    const catalogs = new FieldCatalogs(database.db);
    // Nothing is due yet.
    expect(
      await deliverSubscriptions(database.db, authorizer, catalogs, {
        ...options,
        now: new Date(Date.now() - 60_000),
      }),
    ).toMatchObject({ due: 0, sent: 0 });
    const later = new Date(Date.now() + 8 * 24 * 3600 * 1000);
    const run = await deliverSubscriptions(database.db, authorizer, catalogs, {
      ...options,
      now: later,
    });
    expect(run).toMatchObject({ due: 2, failed: 0 });
    const to = (who: string) =>
      sent.filter((e) => e.to === `${who}@example.com`).map((e) => e.text);
    // The group: alice and bob directly, dave through the nested group.
    expect(to('dave')).toHaveLength(1);
    expect(to('dave')[0]).toContain('Morning list: 0 matching tickets');
    const bobs = to('bob')[0] ?? '';
    expect(bobs).toContain('Morning list: 2 matching tickets');
    expect(bobs).toContain(keys.a1);
    expect(bobs).not.toContain(keys.b1);
    // Alice twice: through the group and her own subscription; she sees all three.
    expect(to('alice')).toHaveLength(2);
    for (const text of to('alice')) expect(text).toContain(keys.b1);
    expect(sent[0]?.subject).toMatch(/^\[Taskmoor\] Morning list: \d+ tickets?$/);
    // Claimed and moved on: running again at the same time sends nothing more.
    const again = await deliverSubscriptions(database.db, authorizer, catalogs, {
      ...options,
      now: later,
    });
    expect(again.due).toBe(0);
    const row = await database.db
      .selectFrom('saved_search_subscription')
      .select(['next_run_at', 'last_sent'])
      .where('id', '=', group.json().subscription.id)
      .executeTakeFirstOrThrow();
    expect(row.next_run_at.getTime()).toBeGreaterThan(later.getTime());
    expect(row.last_sent).toBe(3);
  });

  it('[QRY-012] (2) "only if results" suppresses an empty email', async () => {
    const empty = await save('carol', {
      name: 'Nothing here',
      query: 'track = SA AND summary ~ zebra',
    });
    for (const onlyIfResults of [true, false]) {
      const res = await post('carol', `/api/v1/saved-searches/${empty.id}/subscriptions`, {
        schedule: 'daily',
        onlyIfResults,
      });
      expect(res.statusCode, res.body).toBe(201);
    }
    const sent: OutgoingEmail[] = [];
    const run = await deliverSubscriptions(
      database.db,
      new Authorizer(database.db),
      new FieldCatalogs(database.db),
      {
        transport: {
          send: async (email) => {
            sent.push(email);
            return { messageId: null };
          },
        },
        from: 'taskmoor@example.com',
        publicUrl: 'https://taskmoor.example.com',
        now: new Date(Date.now() + 2 * 24 * 3600 * 1000),
      },
    );
    const carols = sent.filter((e) => e.to === 'carol@example.com');
    expect(carols).toHaveLength(1);
    expect(run.skipped).toBeGreaterThanOrEqual(1);
    // Only the subscriber, the owner or an administrator removes a subscription.
    const list = (await get('carol', `/api/v1/saved-searches/${empty.id}/subscriptions`)).json()
      .subscriptions as { id: number }[];
    expect(list).toHaveLength(2);
    expect(
      (await del('carol', `/api/v1/saved-searches/${empty.id}/subscriptions/${list[0]?.id}`))
        .statusCode,
    ).toBe(204);
  });

  it('[AGL-001] a board on a saved search shows its tickets and keeps it from deletion', async () => {
    // Checked as the editor could run it: one they cannot see reads as missing.
    const hidden = await save('alice', { name: 'Not for boards', query: 'track = SA' });
    const refused = await post('bob', '/api/v1/boards', {
      name: 'Bob tries',
      kind: 'kanban',
      trackId: tracks.SA,
      source: { savedSearchId: hidden.id },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().fields).toEqual({ 'source.savedSearchId': 'not_found' });
    // A saved search across tracks cannot carry a board (ADR-116).
    const across = await save('alice', { name: 'Across', query: 'track IN (SA, SB)' });
    const outside = await post('alice', '/api/v1/boards', {
      name: 'Across',
      kind: 'kanban',
      trackId: tracks.SA,
      source: { savedSearchId: across.id },
    });
    expect(outside.statusCode).toBe(400);
    expect(outside.json().fields).toEqual({ source: 'outside_track' });
    const source = await save('alice', {
      name: 'Board source',
      query: 'track = SA',
      shares: [{ scope: 'track', trackId: tracks.SA }],
    });
    const created = await post('alice', '/api/v1/boards', {
      name: 'On a saved search',
      kind: 'kanban',
      trackId: tracks.SA,
      source: { savedSearchId: source.id },
    });
    expect(created.statusCode, created.body).toBe(201);
    const board = created.json().board as { id: number; source: unknown };
    expect(board.source).toEqual({ savedSearchId: source.id });
    const data = await get('alice', `/api/v1/boards/${board.id}/data`);
    expect(data.statusCode, data.body).toBe(200);
    expect((data.json().cards as { key: string }[]).map((c) => c.key).sort()).toEqual(
      [keys.a1, keys.a2].sort(),
    );
    const inUse = await del('alice', `/api/v1/saved-searches/${source.id}`);
    expect(inUse.statusCode).toBe(409);
    expect(inUse.json()).toEqual({ error: 'in_use', boards: [board.id] });
    // The board's query changes with the saved search.
    const narrowed = await patch('alice', `/api/v1/saved-searches/${source.id}`, {
      query: `track = SA AND key = ${keys.a2}`,
    });
    expect(narrowed.statusCode, narrowed.body).toBe(200);
    const after = await get('alice', `/api/v1/boards/${board.id}/data`);
    expect((after.json().cards as { key: string }[]).map((c) => c.key)).toEqual([keys.a2]);
    // A board stays inside its track (ADR-116): its saved search cannot take it elsewhere.
    for (const query of [
      'track = SB',
      'track IN (SA, SB)',
      'track = SA OR track = SB',
      'assignee IS EMPTY',
    ]) {
      const away = await patch('alice', `/api/v1/saved-searches/${source.id}`, { query });
      expect(away.statusCode, query).toBe(409);
      expect(away.json()).toEqual({
        error: 'board_outside_track',
        boards: [{ id: board.id, name: 'On a saved search', trackKey: 'SA' }],
      });
    }
    const stayed = await get('alice', `/api/v1/saved-searches/${source.id}`);
    expect(stayed.json().savedSearch.query).toBe(`track = SA AND key = ${keys.a2}`);
    // Its other settings still change, and a saved search no board stands on goes anywhere.
    const renamed = await patch('alice', `/api/v1/saved-searches/${source.id}`, {
      name: 'Board source, renamed',
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const free = await patch('alice', `/api/v1/saved-searches/${hidden.id}`, {
      query: 'track IN (SA, SB)',
    });
    expect(free.statusCode, free.body).toBe(200);
    // Back to a query of its own, then the saved search may go.
    const own = await patch('alice', `/api/v1/boards/${board.id}`, {
      source: { query: 'track = SA' },
    });
    expect(own.statusCode, own.body).toBe(200);
    expect((await del('alice', `/api/v1/saved-searches/${source.id}`)).statusCode).toBe(204);
  });
});
