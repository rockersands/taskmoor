import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.73.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

const PEOPLE = ['admin', 'alice', 'bob', 'carol'] as const;
type Person = (typeof PEOPLE)[number];

interface TeamJson {
  id: number;
  name: string;
  description: string;
  lead: { id: number; name: string } | null;
  memberCount: number;
}

/**
 * Teams (M1-123; CORE-027): site administrators keep them, everyone reads them; boards, areas
 * and Team fields name them by id, so a rename shows everywhere; `membersOf("id:<teamId>")`
 * finds their members and the Team field is searched like any other.
 */
describe('teams (M1-123)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  let trackId = 0;

  const as = (who: Person, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: users[who].cookie },
    });
  const get = (who: Person, url: string) => as(who, { method: 'GET', url });
  const post = (who: Person, url: string, payload: Record<string, unknown> = {}) =>
    as(who, { method: 'POST', url, payload });
  const patch = (who: Person, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url, payload });
  const put = (who: Person, url: string) => as(who, { method: 'PUT', url });
  const del = (who: Person, url: string) => as(who, { method: 'DELETE', url });

  async function team(name: string, extra: Record<string, unknown> = {}): Promise<TeamJson> {
    const res = await post('admin', '/api/v1/teams', { name, ...extra });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().team as TeamJson;
  }
  async function ticket(summary: string, body: Record<string, unknown> = {}) {
    const res = await post('alice', '/api/v1/tickets', { track: 'TM', summary, ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().ticket as { id: number; key: string; fields: Record<string, unknown> };
  }
  const search = async (q: string) => {
    const res = await get('alice', `/api/v1/search?q=${encodeURIComponent(q)}&limit=100`);
    return { status: res.statusCode, body: res.json() };
  };
  const found = async (q: string) => {
    const { status, body } = await search(q);
    expect(status, `${q}: ${JSON.stringify(body)}`).toBe(200);
    return (body.tickets as { key: string }[]).map((t) => t.key).sort();
  };
  const events = async (type: string) =>
    (
      await database.db
        .selectFrom('domain_event')
        .select(['subject_id', 'payload'])
        .where('type', '=', type)
        .orderBy('id')
        .execute()
    ).map((e) => ({ subjectId: Number(e.subject_id), payload: e.payload }));

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword(PASSWORD);
    for (const name of PEOPLE) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
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
    const res = await post('admin', '/api/v1/tracks', {
      key: 'TM',
      name: 'Teamwork',
      mode: 'shared',
    });
    expect(res.statusCode, res.body).toBe(201);
    trackId = res.json().track.id;
    const members = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Members')
      .executeTakeFirstOrThrow();
    for (const who of ['alice', 'bob', 'carol'] as const) {
      await database.db
        .insertInto('track_role_actor')
        .values({ workspace_id: 1, track_id: trackId, role_id: members.id, user_id: users[who].id })
        .execute();
    }
  });
  afterAll(async () => {
    await app.close();
  });

  it('[CORE-027] lets everyone read teams and only site administrators change them', async () => {
    const made = await team('Readers');
    expect((await get('bob', '/api/v1/teams')).statusCode).toBe(200);
    expect((await get('bob', `/api/v1/teams/${made.id}`)).statusCode).toBe(200);
    for (const res of [
      await post('bob', '/api/v1/teams', { name: 'Mine' }),
      await patch('bob', `/api/v1/teams/${made.id}`, { name: 'Ours' }),
      await put('bob', `/api/v1/teams/${made.id}/members/${users.bob.id}`),
      await del('bob', `/api/v1/teams/${made.id}/members/${users.bob.id}`),
      await del('bob', `/api/v1/teams/${made.id}`),
    ]) {
      expect(res.statusCode, res.body).toBe(403);
    }
    const anonymous = await app.inject({ method: 'GET', url: '/api/v1/teams' });
    expect(anonymous.statusCode).toBe(401);
  });

  it('[CORE-027] gives a picker at most `limit` teams, by name (T-282)', async () => {
    for (const name of ['Pick C', 'pick a', 'Pick B']) await team(name);
    const names = async (query: string) => {
      const res = await get('bob', `/api/v1/teams?${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return (res.json().teams as TeamJson[]).map((t) => t.name);
    };
    expect(await names('query=pick&limit=2')).toEqual(['pick a', 'Pick B']);
    expect(await names('query=pick')).toEqual(['pick a', 'Pick B', 'Pick C']);
    expect((await names('limit=1')).length).toBe(1);
    for (const bad of ['limit=0', 'limit=501', 'limit=two', 'after=%3D%3D', 'cursor=bm9wZQ']) {
      expect((await get('bob', `/api/v1/teams?${bad}`)).statusCode, bad).toBe(400);
    }
  });

  it('[CORE-027] pages the list by name, 100 at first, each team once and in order (T-286)', async () => {
    // More than one page of them, in mixed case, written straight in for speed.
    const made = Array.from(
      { length: 104 },
      (_, i) => `${i % 2 ? 'Page' : 'page'} ${String(103 - i).padStart(3, '0')}`,
    );
    await database.db
      .insertInto('team')
      .values(made.map((name) => ({ workspace_id: 1, name })))
      .execute();
    const page = async (query: string) => {
      const res = await get('bob', `/api/v1/teams?${query}`);
      expect(res.statusCode, res.body).toBe(200);
      return res.json() as { teams: TeamJson[]; next: string | null };
    };
    const first = await page('query=page');
    expect(first.teams).toHaveLength(100);
    expect(first.next).toEqual(expect.any(String));
    const second = await page(`query=page&after=${first.next}`);
    expect(second.next).toBeNull();
    const all = [...first.teams, ...second.teams].map((t) => t.name);
    const expected = await database.db
      .selectFrom('team')
      .select('name')
      .where(sql<boolean>`lower(name) LIKE 'page%'`)
      .orderBy(sql`lower(name)`)
      .orderBy('id')
      .execute();
    expect(all).toEqual(expected.map((t) => t.name));
    expect(all).toHaveLength(104);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([...made].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase())));
    // `cursor` is another name for `after`; small pages cover the same list.
    const viaCursor = await page(`query=page&limit=100&cursor=${first.next}`);
    expect(viaCursor.teams.map((t) => t.name)).toEqual(second.teams.map((t) => t.name));
    const small: string[] = [];
    let after: string | null = null;
    do {
      const next: { teams: TeamJson[]; next: string | null } = await page(
        `query=page&limit=7${after ? `&after=${after}` : ''}`,
      );
      small.push(...next.teams.map((t) => t.name));
      after = next.next;
    } while (after);
    expect(small).toEqual(all);
    // The largest page holds them all, and says it is the last.
    const big = await page('query=page&limit=500');
    expect(big.teams.map((t) => t.name)).toEqual(all);
    expect(big.next).toBeNull();
  });

  it('[CORE-027] keeps a team with a lead, a description and members, and tells about it', async () => {
    const made = await team('Platform', {
      description: 'Runs the servers',
      leadId: users.alice.id,
    });
    expect(made).toEqual({
      id: made.id,
      name: 'Platform',
      description: 'Runs the servers',
      lead: { id: users.alice.id, name: 'alice' },
      memberCount: 0,
    });
    // Names are unique, ignoring case; a lead must be an active person.
    expect((await post('admin', '/api/v1/teams', { name: 'platform' })).statusCode).toBe(409);
    const unknown = await post('admin', '/api/v1/teams', { name: 'Ghosts', leadId: 999_999 });
    expect([unknown.statusCode, unknown.json().error]).toEqual([400, 'unknown_lead']);

    for (const who of ['bob', 'carol'] as const) {
      const res = await put('admin', `/api/v1/teams/${made.id}/members/${users[who].id}`);
      expect(res.statusCode, res.body).toBe(204);
    }
    // Adding a member twice changes nothing and tells nobody.
    expect(
      (await put('admin', `/api/v1/teams/${made.id}/members/${users.bob.id}`)).statusCode,
    ).toBe(204);
    expect((await put('admin', `/api/v1/teams/${made.id}/members/999999`)).statusCode).toBe(404);
    const detail = (await get('carol', `/api/v1/teams/${made.id}`)).json();
    expect(detail.team.memberCount).toBe(2);
    expect(detail.members).toEqual([
      { id: users.bob.id, name: 'bob', active: true },
      { id: users.carol.id, name: 'carol', active: true },
    ]);
    expect(
      (await del('admin', `/api/v1/teams/${made.id}/members/${users.carol.id}`)).statusCode,
    ).toBe(204);
    expect(
      (await del('admin', `/api/v1/teams/${made.id}/members/${users.carol.id}`)).statusCode,
    ).toBe(404);

    const changed = await patch('admin', `/api/v1/teams/${made.id}`, {
      description: 'Runs everything',
      leadId: null,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json().team).toMatchObject({ description: 'Runs everything', lead: null });
    const listed = (await get('bob', '/api/v1/teams?query=plat')).json().teams as TeamJson[];
    expect(listed.map((t) => [t.name, t.memberCount])).toEqual([['Platform', 1]]);

    expect((await events('team.created')).filter((e) => e.subjectId === made.id)).toEqual([
      { subjectId: made.id, payload: { name: 'Platform' } },
    ]);
    expect((await events('team.member_added')).filter((e) => e.subjectId === made.id)).toEqual([
      { subjectId: made.id, payload: { userId: users.bob.id } },
      { subjectId: made.id, payload: { userId: users.carol.id } },
    ]);
    expect((await events('team.member_removed')).filter((e) => e.subjectId === made.id)).toEqual([
      { subjectId: made.id, payload: { userId: users.carol.id } },
    ]);
    expect((await events('team.updated')).filter((e) => e.subjectId === made.id)).toEqual([
      {
        subjectId: made.id,
        payload: {
          changes: {
            description: { from: 'Runs the servers', to: 'Runs everything' },
            leadId: { from: users.alice.id, to: null },
          },
        },
      },
    ]);
  });

  it('[CORE-027] membersOf("id:<teamId>") returns the team\'s members', async () => {
    const crew = await team('Crew');
    for (const who of ['bob', 'carol'] as const) {
      await put('admin', `/api/v1/teams/${crew.id}/members/${users[who].id}`);
    }
    const mine = await ticket('Alice works', { assigneeId: users.alice.id });
    const bobs = await ticket('Bob works', { assigneeId: users.bob.id });
    const carols = await ticket('Carol works', { assigneeId: users.carol.id });
    expect(await found(`assignee IN membersOf("id:${crew.id}")`)).toEqual(
      [bobs.key, carols.key].sort(),
    );
    expect(await found(`assignee NOT IN membersOf("id:${crew.id}") AND summary ~ works`)).toEqual([
      mine.key,
    ]);
    // A team with nobody in it matches nothing; an id no team has is refused.
    const empty = await team('Nobody yet');
    expect(await found(`assignee IN membersOf("id:${empty.id}")`)).toEqual([]);
    const missing = await search('assignee IN membersOf("id:999999")');
    expect([missing.status, missing.body.message]).toEqual([400, 'No team "999999"']);
  });

  it('[CORE-027] renaming a team updates every reference: Team field, boards and areas', async () => {
    const field = (await post('admin', '/api/v1/fields', { name: 'Team', type: 'team' })).json()
      .field as { id: number };
    const owners = await team('Owners');
    const made = await ticket('Owned work', { fields: { [field.id]: owners.id } });
    expect(made.fields[field.id]).toEqual({ id: owners.id, name: 'Owners' });

    const board = await post('alice', '/api/v1/boards', {
      name: 'Owners board',
      kind: 'kanban',
      trackId,
      source: { query: 'track = TM' },
      teamId: owners.id,
    });
    expect(board.statusCode, board.body).toBe(201);
    const boardId = board.json().board.id as number;
    expect(board.json().board.team).toEqual({ id: owners.id, name: 'Owners' });
    const area = await post('admin', `/api/v1/tracks/${trackId}/areas`, {
      name: 'Billing',
      ownerTeamId: owners.id,
    });
    expect(area.statusCode, area.body).toBe(201);
    const areaId = area.json().area.id as number;

    const renamed = await patch('admin', `/api/v1/teams/${owners.id}`, { name: 'Stewards' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    const shown = (await get('bob', `/api/v1/tickets/${made.key}`)).json().ticket;
    expect(shown.fields[field.id]).toEqual({ id: owners.id, name: 'Stewards' });
    expect((await get('alice', `/api/v1/boards/${boardId}`)).json().board.team).toEqual({
      id: owners.id,
      name: 'Stewards',
    });
    const boards = (await get('alice', `/api/v1/boards?teamId=${owners.id}`)).json().boards;
    expect(boards.map((b: { id: number; team: unknown }) => [b.id, b.team])).toEqual([
      [boardId, { id: owners.id, name: 'Stewards' }],
    ]);
    const areas = (await get('alice', `/api/v1/tracks/${trackId}/areas`)).json().areas;
    expect(areas.find((a: { id: number }) => a.id === areaId).ownerTeam).toEqual({
      id: owners.id,
      name: 'Stewards',
    });
    // Queries name it by its new name; the old one names nothing any more.
    expect(await found('Team = Stewards')).toEqual([made.key]);
    const old = await search('Team = Owners');
    expect([old.status, old.body.message]).toEqual([
      400,
      `"Team" (cf[${field.id}]) has no value "Owners"`,
    ]);

    // A board or an area leaves its team, and only a team that exists can be named.
    const unknown = await patch('alice', `/api/v1/boards/${boardId}`, { teamId: 999_999 });
    expect([unknown.statusCode, unknown.json().fields]).toEqual([400, { teamId: 'not_found' }]);
    const left = await patch('alice', `/api/v1/boards/${boardId}`, { teamId: null });
    expect(left.json().board.team).toBeNull();
    const areaLeft = await patch('admin', `/api/v1/areas/${areaId}`, { ownerTeamId: null });
    expect(areaLeft.json().area.ownerTeam).toBeNull();
  });

  it('[CORE-027] searches the Team field by name or id, empty, in lists and in order', async () => {
    const field = (await post('admin', '/api/v1/fields', { name: 'Squad', type: 'team' })).json()
      .field as { id: number };
    // A Team field holds one team.
    const many = await post('admin', '/api/v1/fields', {
      name: 'Squads',
      type: 'team',
      multiple: true,
    });
    expect(many.statusCode).toBe(400);
    const alpha = await team('Alpha squad');
    const beta = await team('Beta squad');
    const a = await ticket('Squad one', { fields: { [field.id]: alpha.id } });
    const b = await ticket('Squad two', { fields: { [field.id]: beta.id } });
    const none = await ticket('Squad none');
    const bad = await post('alice', '/api/v1/tickets', {
      track: 'TM',
      summary: 'Squad nobody',
      fields: { [field.id]: 999_999 },
    });
    expect(bad.statusCode).toBe(400);

    expect(await found('Squad = "alpha squad"')).toEqual([a.key]);
    expect(await found(`cf[${field.id}] = ${beta.id}`)).toEqual([b.key]);
    expect(await found('Squad IN ("Alpha squad", "Beta squad")')).toEqual([a.key, b.key].sort());
    expect(await found('Squad != "Alpha squad"')).toEqual([b.key]);
    expect(await found('Squad IS EMPTY AND summary ~ squad')).toEqual([none.key]);
    const ordered = await search('summary ~ squad ORDER BY Squad DESC');
    expect(ordered.body.tickets.map((t: { key: string }) => t.key)).toEqual([
      b.key,
      a.key,
      none.key,
    ]);
    // History: the change is recorded and searched by name.
    await patch('alice', `/api/v1/tickets/${a.id}`, { fields: { [field.id]: beta.id } });
    expect(await found('Squad WAS "Alpha squad"')).toEqual([a.key]);
    expect(await found('Squad CHANGED FROM "Alpha squad" TO "Beta squad"')).toEqual([a.key]);
  });

  it('[CORE-027] deleting a team lets go of its boards, areas and Team values', async () => {
    const field = (await post('admin', '/api/v1/fields', { name: 'Unit', type: 'team' })).json()
      .field as { id: number };
    const gone = await team('Gone soon');
    await put('admin', `/api/v1/teams/${gone.id}/members/${users.bob.id}`);
    const made = await ticket('Unit work', { fields: { [field.id]: gone.id } });
    const area = await post('admin', `/api/v1/tracks/${trackId}/areas`, {
      name: 'Leftovers',
      ownerTeamId: gone.id,
    });
    expect((await del('admin', `/api/v1/teams/${gone.id}`)).statusCode).toBe(204);
    expect((await del('admin', `/api/v1/teams/${gone.id}`)).statusCode).toBe(404);
    expect((await get('alice', `/api/v1/teams/${gone.id}`)).statusCode).toBe(404);
    const shown = (await get('alice', `/api/v1/tickets/${made.key}`)).json().ticket;
    expect(shown.fields[field.id]).toBeUndefined();
    const areas = (await get('alice', `/api/v1/tracks/${trackId}/areas`)).json().areas;
    expect(areas.find((x: { id: number }) => x.id === area.json().area.id).ownerTeam).toBeNull();
    expect(await events('team.deleted')).toContainEqual({
      subjectId: gone.id,
      payload: { name: 'Gone soon' },
    });
  });
});
