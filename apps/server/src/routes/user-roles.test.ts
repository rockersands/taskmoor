import { createDb } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { ADMIN_GLOBAL_PERMISSIONS } from '../authz/permissions';
import { ADMIN_ROLES } from '../authz/person-roles';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `192.0.2.${(++address % 250) + 1}`;

function sessionCookie(header: string | string[] | undefined): string {
  const list = Array.isArray(header) ? header : header ? [header] : [];
  const found = list.find(
    (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
  );
  return (found ?? '').split(';')[0] ?? '';
}

interface Listed {
  users: { id: number; name: string; roles: string[]; tracksRun: number }[];
  total: number;
}

/**
 * Every person's roles on Administration > People (T-331; IAM-008, IAM-009, IAM-028): the
 * administrator roles each holds and from where, how many tracks they run, a filter by role
 * that pages on the server, and a page of thousands of people read in a constant number of
 * statements.
 */
describe('people and their roles (T-331)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let admin: string;
  const ids: Record<string, number> = {};
  const groups: Record<string, number> = {};
  let policy: number;
  let runsRole: number;
  let otherRole: number;
  let tracks = 0;

  const as = (options: InjectOptions) =>
    app.inject({ ...options, headers: { ...(options.headers ?? {}), cookie: admin } });

  async function person(name: string, extra: { is_site_admin?: boolean } = {}) {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: `${name}@roles.test`,
        name,
        password_hash: await hashPassword(PASSWORD),
        ...extra,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[name] = row.id;
    return row.id;
  }

  async function group(name: string, members: string[], inside?: string) {
    const row = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name })
      .returning('id')
      .executeTakeFirstOrThrow();
    groups[name] = row.id;
    for (const m of members) {
      await database.db
        .insertInto('group_member')
        .values({ workspace_id: 1, group_id: row.id, user_id: ids[m] as number })
        .execute();
    }
    if (inside) {
      await database.db
        .insertInto('group_nesting')
        .values({ workspace_id: 1, parent_id: groups[inside] as number, child_id: row.id })
        .execute();
    }
  }

  const grant = (permission: string, to: { user?: string; group?: string }) =>
    database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission,
        grantee: to.user ? 'user' : to.group ? 'group' : 'any_user',
        user_id: to.user ? (ids[to.user] as number) : null,
        group_id: to.group ? (groups[to.group] as number) : null,
      })
      .execute();

  async function track(owner?: string) {
    tracks += 1;
    const row = await database.db
      .insertInto('track')
      .values({
        workspace_id: 1,
        key: `RUN${tracks}`,
        name: `Run ${tracks}`,
        access_policy_id: policy,
        owner_id: owner ? (ids[owner] as number) : null,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const actor = (trackId: number, role: number, to: { user?: string; group?: string }) =>
    database.db
      .insertInto('track_role_actor')
      .values({
        workspace_id: 1,
        track_id: trackId,
        role_id: role,
        user_id: to.user ? (ids[to.user] as number) : null,
        group_id: to.group ? (groups[to.group] as number) : null,
      })
      .execute();

  const list = async (query = '') => {
    const res = await as({ method: 'GET', url: `/api/v1/users?status=all&limit=200${query}` });
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as Listed;
  };
  const rowOf = (listed: Listed, name: string) => listed.users.find((u) => u.name === name);

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      publicUrl: 'https://tracker.example.com/',
    });
    await person('ada', { is_site_admin: true });
    for (const name of ['cora', 'ali', 'dee', 'otto', 'gus', 'ron', 'plain']) await person(name);
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'ada@roles.test', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(signedIn.statusCode).toBe(200);
    admin = sessionCookie(signedIn.headers['set-cookie']);

    // Roles: Cora is a configuration administrator herself; Ali is in Ops, inside Staff, which
    // holds the AI role; Dee is in a directory's group that holds extensions.
    await grant('configuration_admin', { user: 'cora' });
    await group('Staff', []);
    await group('Ops', ['ali'], 'Staff');
    await grant('ai_admin', { group: 'Staff' });
    await group('Directory people', ['dee']);
    await grant('extension_admin', { group: 'Directory people' });
    // Not an administrator role: it never shows.
    await grant('bulk_change', { user: 'plain' });

    // Tracks: a policy whose Leads role runs the track, as does the owner; Viewers does not.
    policy = (
      await database.db
        .insertInto('access_policy')
        .values({ workspace_id: 1, name: 'Roles test policy' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    runsRole = (
      await database.db
        .insertInto('role')
        .values({ workspace_id: 1, name: 'Leads' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    otherRole = (
      await database.db
        .insertInto('role')
        .values({ workspace_id: 1, name: 'Watchers' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await database.db
      .insertInto('access_grant')
      .values([
        {
          workspace_id: 1,
          policy_id: policy,
          permission: 'administer_track',
          grantee: 'role',
          role_id: runsRole,
        },
        {
          workspace_id: 1,
          policy_id: policy,
          permission: 'browse_track',
          grantee: 'role',
          role_id: otherRole,
        },
        {
          workspace_id: 1,
          policy_id: policy,
          permission: 'administer_track',
          grantee: 'track_owner',
        },
      ])
      .execute();
    // Otto owns three tracks, one of them in the trash; Gus leads one himself and one through a
    // group of his; Ron only watches.
    const first = await track('otto');
    const trashed = await track('otto');
    await track('otto');
    await database.db
      .updateTable('track')
      .set({ deleted_at: new Date() })
      .where('id', '=', trashed)
      .execute();
    await group('Leads group', ['gus']);
    await actor(first, runsRole, { user: 'gus' });
    await actor(await track(), runsRole, { group: 'Leads group' });
    // The same track twice counts once.
    await actor(first, runsRole, { group: 'Leads group' });
    await actor(first, otherRole, { user: 'ron' });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-009] names the same administrator roles as the authorizer', () => {
    expect([...ADMIN_ROLES]).toEqual([...ADMIN_GLOBAL_PERMISSIONS]);
  });

  it('[IAM-009] lists the administrator roles each person holds: directly, through nested and directory groups, or as everyone', async () => {
    let listed = await list();
    expect(rowOf(listed, 'ada')?.roles).toEqual(['site_admin']);
    expect(rowOf(listed, 'cora')?.roles).toEqual(['configuration_admin']);
    expect(rowOf(listed, 'ali')?.roles).toEqual(['ai_admin']);
    expect(rowOf(listed, 'dee')?.roles).toEqual(['extension_admin']);
    // A permission that is not an administrator role is no role here.
    expect(rowOf(listed, 'plain')?.roles).toEqual([]);

    // Given to everyone signed in, a role is everyone's, deactivated people's too.
    await grant('automation_admin', {});
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', ids.plain as number)
      .execute();
    try {
      listed = await list();
      expect(rowOf(listed, 'plain')?.roles).toEqual(['automation_admin']);
      expect(rowOf(listed, 'ada')?.roles).toEqual(['site_admin', 'automation_admin']);
    } finally {
      await database.db
        .deleteFrom('global_grant')
        .where('permission', '=', 'automation_admin')
        .where('grantee', '=', 'any_user')
        .execute();
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: null })
        .where('id', '=', ids.plain as number)
        .execute();
    }
  });

  it('[IAM-028] counts the live tracks each person runs: by role, through a group, as owner', async () => {
    const listed = await list();
    // Otto owns three, one of them in the trash.
    expect(rowOf(listed, 'otto')?.tracksRun).toBe(2);
    // Gus leads one himself and, through his group, that one again and another.
    expect(rowOf(listed, 'gus')?.tracksRun).toBe(2);
    // Ron's role does not run the track.
    expect(rowOf(listed, 'ron')?.tracksRun).toBe(0);
    expect(rowOf(listed, 'ada')?.tracksRun).toBe(0);
  });

  it('[IAM-008] filters by role on the server, with the right total and pages', async () => {
    const names = (l: Listed) => l.users.map((u) => u.name);
    expect(names(await list('&role=site_admin'))).toEqual(['ada']);
    expect(names(await list('&role=configuration_admin'))).toEqual(['cora']);
    expect(names(await list('&role=ai_admin'))).toEqual(['ali']);
    expect(names(await list('&role=extension_admin'))).toEqual(['dee']);
    expect(names(await list('&role=automation_admin'))).toEqual([]);
    expect(names(await list('&role=runs_tracks'))).toEqual(['gus', 'otto']);
    const members = await list('&role=member');
    expect(names(members)).toEqual(['plain', 'ron']);
    expect(members.total).toBe(2);
    // Paged: one at a time, the total stays.
    const first = await as({ method: 'GET', url: '/api/v1/users?role=member&limit=1' });
    const second = await as({ method: 'GET', url: '/api/v1/users?role=member&limit=1&offset=1' });
    expect((first.json() as Listed).users.map((u) => u.name)).toEqual(['plain']);
    expect((second.json() as Listed).users.map((u) => u.name)).toEqual(['ron']);
    expect((second.json() as Listed).total).toBe(2);
    // With a search too.
    expect(names(await list('&role=runs_tracks&query=gu'))).toEqual(['gus']);
    expect((await as({ method: 'GET', url: '/api/v1/users?role=owner' })).statusCode).toBe(400);
  });

  it('[IAM-008] a person’s page says where each role comes from, the tracks they run and whether they have a second factor', async () => {
    // Ali also holds the AI role himself.
    await grant('ai_admin', { user: 'ali' });
    const res = await as({ method: 'GET', url: `/api/v1/users/${ids.ali}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().roles).toEqual([
      {
        role: 'ai_admin',
        sources: [{ kind: 'user' }, { kind: 'group', group: { id: groups.Staff, name: 'Staff' } }],
      },
    ]);
    expect(res.json().user).toMatchObject({ roles: ['ai_admin'], tracksRun: 0 });
    expect(res.json().hasSecondFactor).toBe(false);

    const ada = (await as({ method: 'GET', url: `/api/v1/users/${ids.ada}` })).json();
    expect(ada.roles).toEqual([{ role: 'site_admin', sources: [{ kind: 'account' }] }]);

    await database.db
      .insertInto('totp_credential')
      .values({ user_id: ids.gus as number, workspace_id: 1, secret_sealed: 'sealed' })
      .execute();
    const gus = (await as({ method: 'GET', url: `/api/v1/users/${ids.gus}` })).json();
    expect(gus.tracks.map((t: { key: string }) => t.key)).toEqual(['RUN1', 'RUN4']);
    expect(gus.user.tracksRun).toBe(2);
    expect(gus.hasSecondFactor).toBe(true);
    // Resetting it (an existing route, now on the person's page) leaves none.
    const reset = await as({ method: 'POST', url: `/api/v1/users/${ids.gus}/two-factor/reset` });
    expect(reset.statusCode).toBe(204);
    expect(
      (await as({ method: 'GET', url: `/api/v1/users/${ids.gus}` })).json().hasSecondFactor,
    ).toBe(false);
  });

  it('[IAM-008] edits a person’s name, email, time zone, language and break-glass mark, each change audited', async () => {
    const res = await as({
      method: 'PATCH',
      url: `/api/v1/users/${ids.ron}`,
      payload: {
        name: 'Ron Weiss',
        email: 'ron.weiss@roles.test',
        timeZone: 'Europe/Madrid',
        locale: 'es-ES',
        breakGlass: true,
      },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().user).toMatchObject({
      name: 'Ron Weiss',
      email: 'ron.weiss@roles.test',
      timeZone: 'Europe/Madrid',
      locale: 'es-ES',
      breakGlass: true,
    });
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'user.updated')
      .where('subject_id', '=', String(ids.ron))
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(Object.keys((event.payload as { changes: object }).changes).sort()).toEqual([
      'breakGlass',
      'email',
      'locale',
      'name',
      'timeZone',
    ]);
  });
});

/**
 * The list reads roles and tracks for a whole page in the same number of statements however many
 * people the page holds (no query per person), measured with a few thousand people who hold roles
 * through groups and run tracks.
 */
describe('people and their roles at scale (T-331)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let admin: string;
  let counting = false;
  let statements = 0;
  let counted: ReturnType<typeof createDb> | undefined;

  beforeAll(async () => {
    counted = createDb({
      connectionString: database.url,
      maxConnections: 5,
      onQuery: () => {
        if (counting) statements += 1;
      },
    });
    app = await buildApp({
      db: counted,
      version: 'test',
      roles: ['api'],
      publicUrl: 'https://tracker.example.com/',
    });
    const db = database.db;
    const hash = await hashPassword(PASSWORD);
    await db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@scale.test',
        name: 'Admin',
        password_hash: hash,
        is_site_admin: true,
      })
      .execute();
    const PEOPLE = 3000;
    const people = await db
      .insertInto('app_user')
      .values(
        Array.from({ length: PEOPLE }, (_, i) => ({
          workspace_id: 1,
          email: `p${i}@scale.test`,
          name: `Person ${String(i).padStart(4, '0')}`,
        })),
      )
      .returning('id')
      .execute();
    const policy = (
      await db
        .insertInto('access_policy')
        .values({ workspace_id: 1, name: 'Scale policy' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const role = (
      await db
        .insertInto('role')
        .values({ workspace_id: 1, name: 'Scale leads' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    await db
      .insertInto('access_grant')
      .values({
        workspace_id: 1,
        policy_id: policy,
        permission: 'administer_track',
        grantee: 'role',
        role_id: role,
      })
      .execute();
    // Twenty groups of 150, every other one a configuration administrator; 200 tracks, each led
    // by a person and a group.
    for (let g = 0; g < 20; g++) {
      const group = (
        await db
          .insertInto('user_group')
          .values({ workspace_id: 1, name: `Scale group ${g}` })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      await db
        .insertInto('group_member')
        .values(
          people
            .slice(g * 150, (g + 1) * 150)
            .map((p) => ({ workspace_id: 1, group_id: group, user_id: p.id })),
        )
        .execute();
      if (g % 2 === 0) {
        await db
          .insertInto('global_grant')
          .values({
            workspace_id: 1,
            permission: 'configuration_admin',
            grantee: 'group',
            group_id: group,
          })
          .execute();
      }
      const made = await db
        .insertInto('track')
        .values(
          Array.from({ length: 10 }, (_, t) => ({
            workspace_id: 1,
            key: `S${g}T${t}`,
            name: `Scale ${g}.${t}`,
            access_policy_id: policy,
          })),
        )
        .returning('id')
        .execute();
      await db
        .insertInto('track_role_actor')
        .values(
          made.flatMap((t, i) => [
            {
              workspace_id: 1,
              track_id: t.id,
              role_id: role,
              user_id: people[g * 150 + i]?.id ?? null,
              group_id: null,
            },
            { workspace_id: 1, track_id: t.id, role_id: role, user_id: null, group_id: group },
          ]),
        )
        .execute();
    }
    const signedIn = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@scale.test', password: PASSWORD },
      remoteAddress: nextAddress(),
    });
    expect(signedIn.statusCode).toBe(200);
    admin = sessionCookie(signedIn.headers['set-cookie']);
  });
  afterAll(async () => {
    await app.close();
    await counted?.destroy();
  });

  const statementsFor = async (url: string) => {
    // Warm: the session and permission caches are not what is measured.
    await app.inject({ method: 'GET', url, headers: { cookie: admin } });
    statements = 0;
    counting = true;
    const res = await app.inject({ method: 'GET', url, headers: { cookie: admin } });
    counting = false;
    expect(res.statusCode).toBe(200);
    return { statements, body: res.json() as Listed };
  };

  it('[IAM-008] reads a page of 200 people in as many statements as a page of 5', async () => {
    const small = await statementsFor('/api/v1/users?limit=5');
    const large = await statementsFor('/api/v1/users?limit=200&offset=100');
    expect(large.body.users).toHaveLength(200);
    expect(large.statements).toBe(small.statements);
    // Two of them are this task's: the roles and the tracks, for the whole page.
    expect(large.statements).toBeLessThanOrEqual(8);
    // What they read is right: Person 0100 is in group 0 (configuration) and leads a track.
    const p100 = large.body.users.find((u) => u.name === 'Person 0100');
    expect(p100).toMatchObject({ roles: ['configuration_admin'], tracksRun: 10 });
    const filtered = await statementsFor('/api/v1/users?limit=200&role=runs_tracks');
    expect(filtered.body.total).toBe(3000);
    const members = await statementsFor('/api/v1/users?limit=200&role=configuration_admin');
    expect(members.body.total).toBe(1500);
    expect(members.statements).toBe(small.statements);
  });
});
