import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import { expectWithinBudget } from '@taskmoor/testkit/budget';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.94.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

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

/** `maker` creates every track, so its role there is its own; the others only see. */
const PEOPLE = ['maker', 'admin', 'config', 'mina', 'other'] as const;
type Person = (typeof PEOPLE)[number];

/**
 * "Your tracks" (T-194; AGL-019; ADR-046): `GET /api/v1/tracks?member=true` keeps the tracks
 * the caller belongs to, by a role (their own or a group's, nested groups included), by owning
 * the track, or through a team that one of its boards or areas names; never a track they only
 * see, whether it is open to everyone, granted by its access policy, or seen as an administrator.
 */
describe('the tracks a person belongs to (T-194)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  const users = {} as Record<Person, { id: number; cookie: string }>;
  const roles = {} as Record<'Members' | 'Viewers', number>;
  const tracks: Record<string, number> = {};
  let outer = 0;

  const as = (who: Person | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: who ? users[who].cookie : '' },
    });
  const post = (who: Person, url: string, payload: Record<string, unknown>) =>
    as(who, { method: 'POST', url, payload });
  const keys = async (who: Person | null, query = '') => {
    const res = await as(who, { method: 'GET', url: `/api/v1/tracks${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return ((res.json().tracks ?? []) as { key: string }[]).map((t) => t.key).sort();
  };
  const mine = (who: Person | null) => keys(who, '?member=true');

  /** A shared policy granting browse to one grantee, for tracks people see without a role. */
  async function policy(
    name: string,
    grant: {
      grantee: 'anyone' | 'any_user' | 'user' | 'group';
      user_id?: number;
      group_id?: number;
    },
  ) {
    const row = await database.db
      .insertInto('access_policy')
      .values({ workspace_id: 1, name, owner_track_id: null })
      .returning('id')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('access_grant')
      .values({
        workspace_id: 1,
        policy_id: row.id,
        permission: 'browse_track',
        grantee: grant.grantee,
        role_id: null,
        user_id: grant.user_id ?? null,
        group_id: grant.group_id ?? null,
        field_key: null,
      })
      .execute();
    return row.id;
  }

  async function track(key: string, extra: Record<string, unknown> = {}) {
    const res = await post('maker', '/api/v1/tracks', { key, name: key, mode: 'shared', ...extra });
    expect(res.statusCode, res.body).toBe(201);
    tracks[key] = res.json().track.id as number;
    return tracks[key] as number;
  }

  const giveRole = (
    trackKey: string,
    role: number,
    actor: { user_id?: number; group_id?: number },
  ) =>
    database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: tracks[trackKey] as number,
        role_id: role,
        user_id: actor.user_id ?? null,
        group_id: actor.group_id ?? null,
      })
      .execute();

  async function team(name: string, members: Person[]) {
    const res = await post('admin', '/api/v1/teams', { name });
    expect(res.statusCode, res.body).toBe(201);
    const id = res.json().team.id as number;
    await database.db
      .insertInto('team_member')
      .values(members.map((m) => ({ workspace_id: 1, team_id: id, user_id: users[m].id })))
      .execute();
    return id;
  }

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
          is_site_admin: name === 'maker' || name === 'admin',
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
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'configuration_admin',
        grantee: 'user',
        user_id: users.config.id,
      })
      .execute();
    for (const name of ['Members', 'Viewers'] as const) {
      roles[name] = (
        await database.db
          .selectFrom('role')
          .select('id')
          .where('name', '=', name)
          .executeTakeFirstOrThrow()
      ).id;
    }
    // Mina is in "inner", which is nested in "outer".
    const [innerRow, outerRow] = await Promise.all(
      ['inner', 'outer'].map((name) =>
        database.db
          .insertInto('user_group')
          .values({ workspace_id: 1, name })
          .returning('id')
          .executeTakeFirstOrThrow(),
      ),
    );
    const inner = innerRow?.id as number;
    outer = outerRow?.id as number;
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: inner, user_id: users.mina.id })
      .execute();
    await database.db
      .insertInto('group_nesting')
      .values({ workspace_id: 1, parent_id: outer, child_id: inner })
      .execute();

    // Ways to belong, on tracks of the default policy, which grants only to roles and owners.
    await track('ROLE');
    await giveRole('ROLE', roles.Members, { user_id: users.mina.id });
    await track('GROUP');
    await giveRole('GROUP', roles.Viewers, { group_id: outer });
    await track('OWNED', { ownerId: users.mina.id });

    // Ways only to see: open to anyone, to everyone signed in, a grant of the policy itself.
    await track('ANYONE', { accessPolicyId: await policy('Public', { grantee: 'anyone' }) });
    const open = await policy('Everyone signed in', { grantee: 'any_user' });
    await track('OPEN', { accessPolicyId: open });
    await track('PGRANT', {
      accessPolicyId: await policy('Mina by name', { grantee: 'user', user_id: users.mina.id }),
    });
    await track('GGRANT', {
      accessPolicyId: await policy('Outer group', { grantee: 'group', group_id: outer }),
    });

    // Through a team: seen because the track is open, belonged to through the team.
    const crew = await team('Crew', ['mina']);
    await track('BOARD', { accessPolicyId: open });
    const board = await post('maker', '/api/v1/boards', {
      name: 'Crew board',
      kind: 'kanban',
      trackId: tracks.BOARD,
      source: { query: 'track = BOARD' },
      teamId: crew,
    });
    expect(board.statusCode, board.body).toBe(201);
    await track('AREA', { accessPolicyId: open });
    const area = await post('admin', `/api/v1/tracks/${tracks.AREA}/areas`, {
      name: 'Billing',
      ownerTeamId: crew,
    });
    expect(area.statusCode, area.body).toBe(201);
    // An archived area no longer says who works on the track.
    await track('OLDAREA', { accessPolicyId: open });
    const old = await post('admin', `/api/v1/tracks/${tracks.OLDAREA}/areas`, {
      name: 'Retired',
      ownerTeamId: crew,
    });
    expect(old.statusCode, old.body).toBe(201);
    await database.db
      .updateTable('area')
      .set({ archived_at: new Date() })
      .where('id', '=', old.json().area.id as number)
      .execute();
    // A team names a track Mina cannot see: belonging never shows it.
    await track('HIDDEN');
    const hidden = await post('admin', `/api/v1/tracks/${tracks.HIDDEN}/areas`, {
      name: 'Secret',
      ownerTeamId: crew,
    });
    expect(hidden.statusCode, hidden.body).toBe(201);
    // Someone else's role and someone else's team.
    await track('ELSE');
    await giveRole('ELSE', roles.Members, { user_id: users.other.id });
    await team('Others', ['other']);
  });
  afterAll(async () => {
    await app.close();
  });

  it('[AGL-019] keeps a track where the person holds a role given to them', async () => {
    expect(await mine('mina')).toContain('ROLE');
  });

  it('[AGL-019] keeps a track where a group they are in holds a role, nested groups included', async () => {
    expect(await mine('mina')).toContain('GROUP');
  });

  it('[AGL-019] keeps a track the person owns', async () => {
    expect(await mine('mina')).toContain('OWNED');
  });

  it('[AGL-019] keeps a track whose board belongs to a team of theirs (ADR-076)', async () => {
    expect(await mine('mina')).toContain('BOARD');
  });

  it('[AGL-019] keeps a track with an area a team of theirs owns, not one only archived', async () => {
    const list = await mine('mina');
    expect(list).toContain('AREA');
    expect(list).not.toContain('OLDAREA');
  });

  it('[AGL-019] leaves out tracks open to anyone or to everyone signed in', async () => {
    const seen = await keys('mina');
    expect(seen).toEqual(expect.arrayContaining(['ANYONE', 'OPEN']));
    const list = await mine('mina');
    expect(list).not.toContain('ANYONE');
    expect(list).not.toContain('OPEN');
  });

  it('[AGL-019] leaves out tracks seen through a grant of their access policy to the person or a group', async () => {
    const seen = await keys('mina');
    expect(seen).toEqual(expect.arrayContaining(['PGRANT', 'GGRANT']));
    const list = await mine('mina');
    expect(list).not.toContain('PGRANT');
    expect(list).not.toContain('GGRANT');
  });

  it('[AGL-019] answers exactly the tracks the person belongs to and may see', async () => {
    expect(await mine('mina')).toEqual(['AREA', 'BOARD', 'GROUP', 'OWNED', 'ROLE']);
    // Belonging through a team never shows a track the person may not see.
    expect(await keys('mina')).not.toContain('HIDDEN');
    expect(await mine('other')).toEqual(['ELSE']);
  });

  it('[AGL-019] leaves out what a site administrator sees only as one', async () => {
    const all = Object.keys(tracks).sort();
    expect(await keys('admin')).toEqual(all);
    expect(await mine('admin')).toEqual([]);
    // The administrator who made them holds the role that runs each one, or owns it.
    expect(await mine('maker')).toEqual(all);
  });

  it('[AGL-019] leaves out what a configuration administrator sees only as one', async () => {
    expect((await keys('config')).length).toBeGreaterThan(0);
    expect(await mine('config')).toEqual([]);
    await giveRole('ELSE', roles.Viewers, { user_id: users.config.id });
    expect(await mine('config')).toEqual(['ELSE']);
  });

  it('[AGL-019] answers nothing for someone not signed in, and member=false is the whole list', async () => {
    expect(await keys(null)).toEqual(['ANYONE']);
    expect(await mine(null)).toEqual([]);
    expect(await keys('mina', '?member=false')).toEqual(await keys('mina'));
    const bad = await as('mina', { method: 'GET', url: '/api/v1/tracks?member=yes' });
    expect(bad.statusCode).toBe(400);
  });

  /**
   * A site of 2,000 more tracks, made once: her group holds a role on every fourth, so she
   * belongs to 505, and the rest she cannot see. The tests that use it come last: the exact
   * lists above do not expect them.
   */
  let bulkMade: Promise<void> | undefined;
  const bulk = () => {
    bulkMade ??= (async () => {
      const policyId = (
        await database.db
          .selectFrom('access_policy')
          .select('id')
          .where('is_default', '=', true)
          .executeTakeFirstOrThrow()
      ).id;
      await sql`
        INSERT INTO track (workspace_id, key, name, access_policy_id)
        SELECT 1, 'BULK' || n, 'Bulk ' || n, ${policyId} FROM generate_series(1, 2000) n`.execute(
        database.db,
      );
      await sql`
        INSERT INTO track_role_actor (workspace_id, track_id, role_id, group_id)
        SELECT 1, id, ${roles.Viewers}, ${outer} FROM track
         WHERE key LIKE 'BULK%' AND substr(key, 5)::int % 4 = 0`.execute(database.db);
    })();
    return bulkMade;
  };

  it('[AGL-019] answers Home quickly on a site of 2,000 tracks, a quarter of them hers', async () => {
    await bulk();
    const runs: number[] = [];
    let next = '';
    for (let i = 0; i < 5; i++) {
      const started = performance.now();
      const res = await as('mina', { method: 'GET', url: '/api/v1/tracks?member=true&limit=500' });
      runs.push(performance.now() - started);
      expect(res.statusCode).toBe(200);
      expect(res.json().tracks).toHaveLength(500);
      next = res.json().next as string;
    }
    // Hers are 505 (500 by her group, five from before): 500 on a page, five on the next.
    const rest = await keys('mina', `?member=true&limit=500&after=${next}`);
    expect(rest).toHaveLength(5);
    const median = [...runs].sort((a, b) => a - b)[2] as number;
    expectWithinBudget(median, 150, 'tracks a person belongs to, of 2,000 (ms)');
  });

  it('[AGL-019] finds a track she opened lately among more than 500 of hers, however late its key sorts', async () => {
    await bulk();
    // ROLE sorts after 500 of her tracks, so the first page leaves it out.
    const first = await keys('mina', '?member=true&limit=500');
    expect(first).toHaveLength(500);
    expect(first).not.toContain('ROLE');
    // Home sends the keys this browser opened lately: hers come back, ignoring case; one she only
    // sees, one she cannot see and one that does not exist do not.
    expect(await keys('mina', '?member=true&keys=role,BULK4,OPEN,HIDDEN,NOPE,ROLE')).toEqual([
      'BULK4',
      'ROLE',
    ]);
    // Without member=true the filter keeps what she may see.
    expect(await keys('mina', '?keys=ROLE,OPEN,HIDDEN')).toEqual(['OPEN', 'ROLE']);
  });

  it('[AGL-019] refuses keys that are not track keys, or more than 50 of them', async () => {
    const status = async (query: string) =>
      (await as('mina', { method: 'GET', url: `/api/v1/tracks${query}` })).statusCode;
    expect(
      await status(`?member=true&keys=${Array.from({ length: 50 }, (_, i) => `K${i}`).join(',')}`),
    ).toBe(200);
    expect(
      await status(`?member=true&keys=${Array.from({ length: 51 }, (_, i) => `K${i}`).join(',')}`),
    ).toBe(400);
    for (const bad of ['', 'ROLE,', ',ROLE', 'ROLE,,OPS', '9ROLE', 'RO-LE', 'ROLE%20OPS']) {
      expect(await status(`?member=true&keys=${bad}`), bad).toBe(400);
    }
  });
});
