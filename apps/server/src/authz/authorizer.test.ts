import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { fc } from '@taskmoor/testkit/property';
import { type Kysely, sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { Authorizer } from './authorizer';
import {
  CONFIGURATION_PERMISSIONS,
  GLOBAL_PERMISSIONS,
  TICKET_LEVEL_GRANTEES,
  TRACK_LEVEL_GRANTEES,
  TRACK_PERMISSIONS,
  type TrackPermission,
} from './permissions';

/**
 * The authorization service against a reference model (M1-002 done-when: 10k random grants
 * agree with the reference; check p95 under 10 ms). Each world lives in its own workspace, so
 * worlds never see each other and nothing needs cleaning up.
 */

interface World {
  ws: number;
  users: { id: number; active: boolean; siteAdmin: boolean }[];
  groups: number[];
  /** child group id to parent group ids */
  parents: Map<number, number[]>;
  /** group id to direct member user ids */
  members: Map<number, Set<number>>;
  tracks: { id: number; policy: number; owner: number | null }[];
  roles: number[];
  actors: { track: number; role: number; user: number | null; group: number | null }[];
  grants: {
    policy: number;
    permission: string;
    grantee: string;
    role: number | null;
    group: number | null;
    user: number | null;
  }[];
  globals: { permission: string; grantee: string; group: number | null; user: number | null }[];
}

type Rng = () => number;
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: Rng, list: readonly T[]): T => list[Math.floor(rng() * list.length)] as T;

async function ids(db: Kysely<Database>, query: ReturnType<typeof sql<{ id: number }>>) {
  return (await query.execute(db)).rows.map((r) => r.id);
}

/** Builds a random world in a fresh workspace with bulk inserts. */
async function buildWorld(
  db: Kysely<Database>,
  rng: Rng,
  size: { users: number; groups: number; tracks: number; policies: number; grants: number },
): Promise<World> {
  const key = `w${Math.floor(rng() * 1e12)}`;
  const ws = (
    await db
      .insertInto('workspace')
      .values({ key, name: key })
      .returning('id')
      .executeTakeFirstOrThrow()
  ).id;
  const users = await ids(
    db,
    sql<{ id: number }>`
      INSERT INTO app_user (workspace_id, email, name, is_site_admin, deactivated_at)
      SELECT ${ws}, 'u' || n || '@' || ${key}, 'u' || n, n = 1, CASE WHEN n % 17 = 0 THEN now() END
        FROM generate_series(1, ${size.users}) n RETURNING id`,
  );
  const userRows = users.map((id, i) => ({ id, active: (i + 1) % 17 !== 0, siteAdmin: i === 0 }));
  const groups = await ids(
    db,
    sql<{ id: number }>`INSERT INTO user_group (workspace_id, name)
      SELECT ${ws}, 'g' || n FROM generate_series(1, ${size.groups}) n RETURNING id`,
  );
  // Nesting only from a lower index to a higher one, so there are no cycles.
  const parents = new Map<number, number[]>();
  const nest: [number, number][] = [];
  for (let i = 1; i < groups.length; i++) {
    if (rng() < 0.6) {
      const parent = groups[Math.floor(rng() * i)] as number;
      const child = groups[i] as number;
      nest.push([parent, child]);
      parents.set(child, [...(parents.get(child) ?? []), parent]);
    }
  }
  if (nest.length) {
    await sql`INSERT INTO group_nesting (workspace_id, parent_id, child_id)
      SELECT ${ws}, p, c FROM unnest(${nest.map((e) => e[0])}::int[], ${nest.map((e) => e[1])}::int[]) AS x(p, c)`.execute(
      db,
    );
  }
  const members = new Map<number, Set<number>>();
  const memberPairs: [number, number][] = [];
  for (const user of users) {
    for (const group of groups) {
      if (rng() < 2 / groups.length) {
        memberPairs.push([group, user]);
        members.set(group, (members.get(group) ?? new Set()).add(user));
      }
    }
  }
  if (memberPairs.length) {
    await sql`INSERT INTO group_member (workspace_id, group_id, user_id)
      SELECT ${ws}, g, u FROM unnest(${memberPairs.map((m) => m[0])}::int[], ${memberPairs.map((m) => m[1])}::int[]) AS x(g, u)`.execute(
      db,
    );
  }
  const roles = await ids(
    db,
    sql<{ id: number }>`INSERT INTO role (workspace_id, name)
      SELECT ${ws}, 'r' || n FROM generate_series(1, 4) n RETURNING id`,
  );
  const policies = await ids(
    db,
    sql<{ id: number }>`INSERT INTO access_policy (workspace_id, name)
      SELECT ${ws}, 'p' || n FROM generate_series(1, ${size.policies}) n RETURNING id`,
  );
  const trackSpecs = Array.from({ length: size.tracks }, () => ({
    policy: pick(rng, policies),
    owner: rng() < 0.7 ? pick(rng, users) : null,
  }));
  const trackIds = await ids(
    db,
    sql<{ id: number }>`INSERT INTO track (workspace_id, key, name, access_policy_id, owner_id)
      SELECT ${ws}, 'T' || n, 'Track ' || n, p, o
        FROM unnest(${trackSpecs.map((t) => t.policy)}::int[], ${trackSpecs.map((t) => t.owner)}::int[])
             WITH ORDINALITY AS x(p, o, n)
      RETURNING id`,
  );
  const tracks = trackIds.map((id, i) => ({
    id,
    ...(trackSpecs[i] as (typeof trackSpecs)[number]),
  }));

  const actors: World['actors'] = [];
  for (const track of tracks) {
    for (let k = 0; k < 6; k++) {
      const byGroup = rng() < 0.4;
      actors.push({
        track: track.id,
        role: pick(rng, roles),
        user: byGroup ? null : pick(rng, users),
        group: byGroup ? pick(rng, groups) : null,
      });
    }
  }
  await sql`INSERT INTO track_role_actor (workspace_id, track_id, role_id, user_id, group_id)
    SELECT ${ws}, t, r, u, g FROM unnest(${actors.map((a) => a.track)}::int[], ${actors.map((a) => a.role)}::int[],
      ${actors.map((a) => a.user)}::int[], ${actors.map((a) => a.group)}::int[]) AS x(t, r, u, g)
    ON CONFLICT DO NOTHING`.execute(db);

  const kinds = [...TRACK_LEVEL_GRANTEES, ...TICKET_LEVEL_GRANTEES];
  const grants: World['grants'] = [];
  for (let i = 0; i < size.grants; i++) {
    const grantee = pick(rng, kinds);
    grants.push({
      policy: pick(rng, policies),
      permission: pick(rng, TRACK_PERMISSIONS),
      grantee,
      role: grantee === 'role' ? pick(rng, roles) : null,
      group: grantee === 'group' ? pick(rng, groups) : null,
      user: grantee === 'user' ? pick(rng, users) : null,
    });
  }
  for (let i = 0; i < grants.length; i += 5_000) {
    const chunk = grants.slice(i, i + 5_000);
    await sql`INSERT INTO access_grant (workspace_id, policy_id, permission, grantee, role_id, group_id, user_id, field_key)
      SELECT ${ws}, p, perm, k, r, g, u, CASE WHEN k IN ('user_field', 'group_field') THEN 'customfield_1' END
        FROM unnest(${chunk.map((g) => g.policy)}::int[], ${chunk.map((g) => g.permission)}::text[],
          ${chunk.map((g) => g.grantee)}::text[], ${chunk.map((g) => g.role)}::int[],
          ${chunk.map((g) => g.group)}::int[], ${chunk.map((g) => g.user)}::int[]) AS x(p, perm, k, r, g, u)
      ON CONFLICT DO NOTHING`.execute(db);
  }
  const globals: World['globals'] = [
    { permission: 'configuration_admin', grantee: 'group', group: pick(rng, groups), user: null },
    { permission: 'site_admin', grantee: 'group', group: pick(rng, groups), user: null },
    { permission: 'browse_users', grantee: 'any_user', group: null, user: null },
  ];
  for (const g of globals) {
    await db
      .insertInto('global_grant')
      .values({
        workspace_id: ws,
        permission: g.permission,
        grantee: g.grantee as 'group' | 'any_user',
        group_id: g.group,
        user_id: g.user,
      })
      .execute();
  }
  return { ws, users: userRows, groups, parents, members, tracks, roles, actors, grants, globals };
}

/** The reference model: the rules of ADR-012 written plainly over the world's arrays. */
function reference(world: World) {
  const groupsOf = (user: number): Set<number> => {
    const out = new Set<number>();
    const queue = world.groups.filter((g) => world.members.get(g)?.has(user));
    while (queue.length) {
      const g = queue.pop() as number;
      if (out.has(g)) continue;
      out.add(g);
      queue.push(...(world.parents.get(g) ?? []));
    }
    return out;
  };
  const globalOf = (user: number): Set<string> => {
    const row = world.users.find((u) => u.id === user);
    if (!row?.active) return new Set();
    const groups = groupsOf(user);
    const granted = new Set(
      world.globals
        .filter(
          (g) =>
            g.grantee === 'any_user' ||
            (g.grantee === 'user' && g.user === user) ||
            (g.grantee === 'group' && g.group !== null && groups.has(g.group)),
        )
        .map((g) => g.permission),
    );
    // The migration's defaults for any signed-in person are not in this workspace.
    const admin = row.siteAdmin || granted.has('site_admin');
    return new Set(GLOBAL_PERMISSIONS.filter((p) => admin || granted.has(p)));
  };
  const trackOf = (user: number | null, trackId: number): Set<string> => {
    const track = world.tracks.find((t) => t.id === trackId);
    if (!track) return new Set();
    const grants = world.grants.filter((g) => g.policy === track.policy);
    if (user === null) {
      return new Set(grants.filter((g) => g.grantee === 'anyone').map((g) => g.permission));
    }
    const global = globalOf(user);
    if (global.has('site_admin')) return new Set(TRACK_PERMISSIONS);
    if (!world.users.find((u) => u.id === user)?.active) return new Set();
    const groups = groupsOf(user);
    const roles = new Set(
      world.actors
        .filter(
          (a) =>
            a.track === trackId && (a.user === user || (a.group !== null && groups.has(a.group))),
        )
        .map((a) => a.role),
    );
    const out = new Set(
      grants
        .filter(
          (g) =>
            g.grantee === 'anyone' ||
            g.grantee === 'any_user' ||
            (g.grantee === 'user' && g.user === user) ||
            (g.grantee === 'group' && g.group !== null && groups.has(g.group)) ||
            (g.grantee === 'track_owner' && track.owner === user) ||
            (g.grantee === 'role' && g.role !== null && roles.has(g.role)),
        )
        .map((g) => g.permission),
    );
    if (global.has('configuration_admin')) for (const p of CONFIGURATION_PERMISSIONS) out.add(p);
    return out;
  };
  return { globalOf, trackOf };
}

const sorted = (set: Iterable<string>) => [...set].sort();

describe('authorization service against the reference model (M1-002)', () => {
  const database = useMigratedDatabase();

  it('[IAM-010] [IAM-012] agrees with the reference on every user and track for 10,000 random grants', async () => {
    const db = database.db;
    const world = await buildWorld(db, mulberry32(20261012), {
      users: 60,
      groups: 20,
      tracks: 40,
      policies: 8,
      grants: 10_000,
    });
    const ref = reference(world);
    const authorizer = new Authorizer(db);
    let compared = 0;
    for (const user of [...world.users.map((u) => u.id), null]) {
      for (const track of world.tracks) {
        const actual = await authorizer.trackPermissions(world.ws, { userId: user }, track.id);
        expect(sorted(actual), `user ${user} track ${track.id}`).toEqual(
          sorted(ref.trackOf(user, track.id)),
        );
        compared++;
      }
      if (user !== null) {
        expect(sorted(await authorizer.globalPermissions(world.ws, user))).toEqual(
          sorted(ref.globalOf(user)),
        );
      }
    }
    expect(compared).toBe(61 * 40);

    // The search pre-filter agrees with the per-track answers.
    for (const user of world.users.slice(0, 25).map((u) => u.id)) {
      for (const permission of [
        'browse_track',
        'edit_tickets',
        'administer_track',
      ] as TrackPermission[]) {
        const allowed = await authorizer.allowedTracks(world.ws, { userId: user }, permission);
        const expected = world.tracks
          .filter((t) => ref.trackOf(user, t.id).has(permission))
          .map((t) => t.id)
          .sort((a, b) => a - b);
        if (allowed === 'all') expect(ref.globalOf(user).has('site_admin')).toBe(true);
        else expect(allowed, `user ${user} ${permission}`).toEqual(expected);
      }
    }
  });

  it('[IAM-010] agrees with the reference on small random worlds', async () => {
    const db = database.db;
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        const world = await buildWorld(db, mulberry32(seed), {
          users: 8,
          groups: 5,
          tracks: 5,
          policies: 2,
          grants: 120,
        });
        const ref = reference(world);
        const authorizer = new Authorizer(db);
        for (const user of [...world.users.map((u) => u.id), null]) {
          for (const track of world.tracks) {
            const actual = await authorizer.trackPermissions(world.ws, { userId: user }, track.id);
            expect(sorted(actual)).toEqual(sorted(ref.trackOf(user, track.id)));
          }
        }
      }),
      { numRuns: 8 },
    );
  });

  it('[IAM-012] checks a permission in under 10 ms at p95 without the cache', async () => {
    const db = database.db;
    const rng = mulberry32(7);
    const world = await buildWorld(db, rng, {
      users: 400,
      groups: 60,
      tracks: 300,
      policies: 20,
      grants: 10_000,
    });
    // No cache for track answers; a person's global permissions stay cached, as in a server.
    const authorizer = new Authorizer(db, { trackCacheSize: 0 });
    const epoch = await authorizer.epoch(world.ws);
    const users = world.users.filter((u) => u.active && !u.siteAdmin).map((u) => u.id);
    for (const user of users) await authorizer.globalPermissions(world.ws, user, epoch);
    // Warm the connection pool and the plan cache, then measure.
    for (let i = 0; i < 20; i++) {
      await authorizer.trackPermissions(
        world.ws,
        { userId: pick(rng, users) },
        pick(rng, world.tracks).id,
        epoch,
      );
    }
    const times: number[] = [];
    for (let i = 0; i < 400; i++) {
      const start = performance.now();
      await authorizer.trackPermissions(
        world.ws,
        { userId: pick(rng, users) },
        pick(rng, world.tracks).id,
        epoch,
      );
      times.push(performance.now() - start);
    }
    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(times.length * 0.95)] as number;
    expect(p95).toBeLessThan(10);
  });

  it('[IAM-012] serves repeated checks from the cache and drops them when the epoch moves', async () => {
    const db = database.db;
    const world = await buildWorld(db, mulberry32(99), {
      users: 12,
      groups: 8,
      tracks: 2,
      policies: 1,
      grants: 0,
    });
    const authorizer = new Authorizer(db);
    let user = 0;
    for (const u of world.users.filter((x) => x.active && !x.siteAdmin)) {
      const global = await authorizer.globalPermissions(world.ws, u.id);
      if (!global.has('site_admin') && !global.has('configuration_admin')) user = u.id;
    }
    expect(user).toBeGreaterThan(0);
    const track = world.tracks[0]?.id as number;
    expect([...(await authorizer.trackPermissions(world.ws, { userId: user }, track))]).toEqual([]);
    await db
      .insertInto('access_grant')
      .values({
        workspace_id: world.ws,
        policy_id: world.tracks[0]?.policy as number,
        permission: 'browse_track',
        grantee: 'user',
        user_id: user,
      })
      .execute();
    // The grant moved the epoch, so the cached empty answer is not used.
    expect([...(await authorizer.trackPermissions(world.ws, { userId: user }, track))]).toEqual([
      'browse_track',
    ]);
    const before = await authorizer.epoch(world.ws);
    await db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', user)
      .execute();
    expect(await authorizer.epoch(world.ws)).not.toBe(before);
    expect([...(await authorizer.trackPermissions(world.ws, { userId: user }, track))]).toEqual([]);
  });
});
