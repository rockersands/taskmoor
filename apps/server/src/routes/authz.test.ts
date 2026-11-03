import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.64.0.${++address}`;

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

describe('roles, access policies, global grants and track roles (M1-002)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let hash: string;
  const users: Record<string, { id: number; cookie: string }> = {};
  let defaultPolicy: number;
  let roles: Record<string, number>;
  let track: number;

  const as = (who: string, options: InjectOptions) =>
    app.inject({
      ...options,
      headers: { ...(options.headers ?? {}), cookie: users[who]?.cookie ?? '' },
    });

  async function addUser(name: string, admin = false) {
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

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    hash = await hashPassword(PASSWORD);
    for (const [name, admin] of [
      ['admin', true],
      ['config', false],
      ['owner', false],
      ['member', false],
      ['viewer', false],
      ['stranger', false],
    ] as const) {
      await addUser(name, admin);
    }
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('name', '=', 'Default access policy')
      .executeTakeFirstOrThrow();
    defaultPolicy = policy.id;
    const roleRows = await database.db.selectFrom('role').select(['id', 'name']).execute();
    roles = Object.fromEntries(roleRows.map((r) => [r.name, r.id]));
    track = (
      await database.db
        .insertInto('track')
        .values({
          workspace_id: 1,
          key: 'PAY',
          name: 'Payments',
          owner_id: users.owner?.id as number,
          access_policy_id: defaultPolicy,
        })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await app.close();
  });

  const myPermissions = async (who: string) =>
    (await as(who, { method: 'GET', url: `/api/v1/me/permissions?trackId=${track}` })).json() as {
      global: string[];
      track: string[];
    };

  it('[IAM-010] seeds Administrators, Members, Viewers, a default policy and defaults for everyone', async () => {
    expect(Object.keys(roles).sort()).toEqual(['Administrators', 'Members', 'Viewers']);
    const policy = await as('admin', {
      method: 'GET',
      url: `/api/v1/access-policies/${defaultPolicy}`,
    });
    const grants = policy.json().grants as {
      permission: string;
      grantee: string;
      roleName: string | null;
    }[];
    expect(grants.some((g) => g.permission === 'browse_track' && g.roleName === 'Viewers')).toBe(
      true,
    );
    expect(
      grants.some((g) => g.permission === 'administer_track' && g.grantee === 'track_owner'),
    ).toBe(true);
    expect(grants.some((g) => g.permission === 'delete_tickets' && g.roleName === 'Members')).toBe(
      false,
    );
    expect((await myPermissions('stranger')).global).toEqual([
      'browse_users',
      'bulk_change',
      'create_local_tracks',
      'share_saved_searches',
    ]);
  });

  it('[IAM-010] grants track permissions through roles, the owner, and nothing to strangers', async () => {
    expect((await myPermissions('stranger')).track).toEqual([]);
    expect((await myPermissions('owner')).track).toEqual(['administer_track', 'browse_track']);
    // The owner manages the track's roles.
    const add = (who: string, role: string, userName: string) =>
      as(who, {
        method: 'PUT',
        url: `/api/v1/tracks/${track}/roles/${roles[role]}/users/${users[userName]?.id}`,
      });
    expect((await add('owner', 'Members', 'member')).statusCode).toBe(204);
    expect((await add('owner', 'Viewers', 'viewer')).statusCode).toBe(204);
    expect((await add('member', 'Administrators', 'member')).statusCode).toBe(403);
    expect((await myPermissions('member')).track).toContain('edit_tickets');
    expect((await myPermissions('member')).track).not.toContain('administer_track');
    expect((await myPermissions('viewer')).track).toEqual([
      'add_comments',
      'browse_track',
      'delete_own_comments',
      'edit_own_comments',
      'view_aggregated_data',
      'view_readonly_workflow',
      'view_voters_followers',
    ]);
    const list = await as('owner', { method: 'GET', url: `/api/v1/tracks/${track}/role-actors` });
    expect(list.json().roles.map((r: { roleName: string }) => r.roleName)).toEqual([
      'Members',
      'Viewers',
    ]);
    const remove = await as('owner', {
      method: 'DELETE',
      url: `/api/v1/tracks/${track}/roles/${roles.Viewers}/users/${users.viewer?.id}`,
    });
    expect(remove.statusCode).toBe(204);
    expect((await myPermissions('viewer')).track).toEqual([]);
  });

  it('[IAM-008] [IAM-010] grants through a group, also a nested one', async () => {
    const parent = (
      await as('admin', {
        method: 'POST',
        url: '/api/v1/groups',
        payload: { name: 'Payments team' },
      })
    ).json().group.id;
    const child = (
      await as('admin', {
        method: 'POST',
        url: '/api/v1/groups',
        payload: { name: 'Payments contractors' },
      })
    ).json().group.id;
    await as('admin', { method: 'PUT', url: `/api/v1/groups/${parent}/children/${child}` });
    await as('admin', {
      method: 'PUT',
      url: `/api/v1/groups/${child}/members/${users.stranger?.id}`,
    });
    await as('owner', {
      method: 'PUT',
      url: `/api/v1/tracks/${track}/roles/${roles.Viewers}/groups/${parent}`,
    });
    expect((await myPermissions('stranger')).track).toContain('browse_track');
    await as('admin', {
      method: 'DELETE',
      url: `/api/v1/groups/${child}/members/${users.stranger?.id}`,
    });
    expect((await myPermissions('stranger')).track).toEqual([]);
  });

  it('[IAM-009] gives site administrators everything and configuration administrators configuration', async () => {
    expect((await myPermissions('admin')).track).toContain('delete_tickets');
    expect((await myPermissions('config')).track).toEqual([]);
    const grant = await as('admin', {
      method: 'POST',
      url: '/api/v1/global-grants',
      payload: { permission: 'configuration_admin', grantee: 'user', userId: users.config?.id },
    });
    expect(grant.statusCode).toBe(201);
    expect((await myPermissions('config')).track).toEqual([
      'administer_track',
      'edit_workflows',
      'manage_layouts',
      'view_readonly_workflow',
    ]);
    // Configuration administrators edit roles and policies, but not users or global grants.
    expect((await as('config', { method: 'GET', url: '/api/v1/roles' })).statusCode).toBe(200);
    expect((await as('config', { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(403);
    expect((await as('config', { method: 'GET', url: '/api/v1/global-grants' })).statusCode).toBe(
      403,
    );
    expect((await as('member', { method: 'GET', url: '/api/v1/roles' })).statusCode).toBe(403);
  });

  it('[IAM-009] lets a configuration administrator set up tracks and nothing about people', async () => {
    const session = await as('config', { method: 'GET', url: '/api/v1/session' });
    expect(session.json().user).toMatchObject({ isSiteAdmin: false, isConfigAdmin: true });
    const plain = await as('member', { method: 'GET', url: '/api/v1/session' });
    expect(plain.json().user).toMatchObject({ isSiteAdmin: false, isConfigAdmin: false });
    // Every read the setup pages make answers them (ADR-114).
    for (const url of [
      '/api/v1/tracks?archived=include&limit=200',
      '/api/v1/roles',
      '/api/v1/workflows',
      '/api/v1/statuses',
      '/api/v1/workflow-maps',
      '/api/v1/fields',
      '/api/v1/ticket-types',
      '/api/v1/type-sets',
      '/api/v1/field-rule-sets',
      '/api/v1/layout-sets',
      '/api/v1/priority-sets',
      '/api/v1/visibility-policies',
      '/api/v1/notification-policies',
    ]) {
      const res = await as('config', { method: 'GET', url });
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
    // To give a track's role: the groups, and a person's name and id only.
    expect((await as('config', { method: 'GET', url: '/api/v1/groups' })).statusCode).toBe(200);
    const found = await as('config', { method: 'GET', url: '/api/v1/people/lookup?q=member' });
    expect(found.statusCode, found.body).toBe(200);
    expect(found.json().people).toEqual([
      { id: users.member?.id, name: expect.stringContaining('member') },
    ]);
    for (const url of ['/api/v1/groups', '/api/v1/people/lookup?q=member']) {
      expect((await as('member', { method: 'GET', url })).statusCode, url).toBe(403);
    }
    // Reading is all: changing groups and people, and the full list of people, stay refused.
    expect((await as('config', { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(403);
    const group = await as('config', {
      method: 'POST',
      url: '/api/v1/groups',
      payload: { name: 'Not allowed' },
    });
    expect(group.statusCode).toBe(403);
  });

  it('[IAM-009] makes the members of a group site administrators through a global grant', async () => {
    const admins = (
      await as('admin', { method: 'POST', url: '/api/v1/groups', payload: { name: 'Admins' } })
    ).json().group.id;
    await as('admin', {
      method: 'PUT',
      url: `/api/v1/groups/${admins}/members/${users.viewer?.id}`,
    });
    expect((await as('viewer', { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(403);
    const grant = await as('admin', {
      method: 'POST',
      url: '/api/v1/global-grants',
      payload: { permission: 'site_admin', grantee: 'group', groupId: admins },
    });
    expect(grant.statusCode).toBe(201);
    expect((await as('viewer', { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(200);
    const session = await as('viewer', { method: 'GET', url: '/api/v1/session' });
    expect(session.json().user.isSiteAdmin).toBe(true);
    // Administration never goes to everyone.
    const everyone = await as('admin', {
      method: 'POST',
      url: '/api/v1/global-grants',
      payload: { permission: 'site_admin', grantee: 'any_user' },
    });
    expect(everyone.statusCode).toBe(400);
    await as('admin', { method: 'DELETE', url: `/api/v1/global-grants/${grant.json().grant.id}` });
    expect((await as('viewer', { method: 'GET', url: '/api/v1/users' })).statusCode).toBe(403);
  });

  it('[IAM-010] manages policies and grants with their safety rules', async () => {
    const created = await as('admin', {
      method: 'POST',
      url: '/api/v1/access-policies',
      payload: { name: 'Locked down', copyFrom: defaultPolicy },
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().policy.id;
    const detail = await as('admin', { method: 'GET', url: `/api/v1/access-policies/${id}` });
    const original = await as('admin', {
      method: 'GET',
      url: `/api/v1/access-policies/${defaultPolicy}`,
    });
    expect(detail.json().grants.length).toBe(original.json().grants.length);

    const add = (payload: object) =>
      as('admin', { method: 'POST', url: `/api/v1/access-policies/${id}/grants`, payload });
    expect((await add({ permission: 'fly', grantee: 'any_user' })).statusCode).toBe(400);
    expect((await add({ permission: 'browse_track', grantee: 'role' })).statusCode).toBe(400);
    expect(
      (await add({ permission: 'browse_track', grantee: 'any_user', userId: 3 })).statusCode,
    ).toBe(400);
    expect(
      (await add({ permission: 'browse_track', grantee: 'role', roleId: 999999 })).statusCode,
    ).toBe(404);
    const ok = await add({
      permission: 'browse_track',
      grantee: 'user_field',
      fieldKey: 'customfield_10',
    });
    expect(ok.statusCode).toBe(201);
    expect(
      (await add({ permission: 'browse_track', grantee: 'user_field', fieldKey: 'customfield_10' }))
        .statusCode,
    ).toBe(409);

    // A policy in use cannot go; neither can a role a policy grants.
    const inUse = await as('admin', {
      method: 'DELETE',
      url: `/api/v1/access-policies/${defaultPolicy}`,
    });
    expect(inUse.json()).toEqual({ error: 'policy_in_use' });
    const roleInUse = await as('admin', {
      method: 'DELETE',
      url: `/api/v1/roles/${roles.Members}`,
    });
    expect(roleInUse.json()).toEqual({ error: 'role_in_use' });
    expect(
      (await as('admin', { method: 'DELETE', url: `/api/v1/access-policies/${id}` })).statusCode,
    ).toBe(204);

    const role = await as('admin', {
      method: 'POST',
      url: '/api/v1/roles',
      payload: { name: 'Auditors' },
    });
    expect(role.statusCode).toBe(201);
    expect(
      (
        await as('admin', { method: 'POST', url: '/api/v1/roles', payload: { name: 'auditors' } })
      ).json(),
    ).toEqual({
      error: 'name_taken',
    });
    expect(
      (await as('admin', { method: 'DELETE', url: `/api/v1/roles/${role.json().role.id}` }))
        .statusCode,
    ).toBe(204);
  });

  it('[IAM-012] explains why someone can or cannot, naming the grant and role', async () => {
    await as('owner', {
      method: 'PUT',
      url: `/api/v1/tracks/${track}/roles/${roles.Members}/users/${users.member?.id}`,
    });
    const explain = (who: string, permission: string) =>
      as('admin', {
        method: 'GET',
        url: `/api/v1/permissions/explain?userId=${users[who]?.id}&trackId=${track}&permission=${permission}`,
      });
    const yes = (await explain('member', 'edit_tickets')).json();
    expect(yes.allowed).toBe(true);
    expect(yes.reasons).toEqual([
      expect.objectContaining({ kind: 'grant', grantee: 'role', roleName: 'Members' }),
    ]);
    const no = (await explain('member', 'delete_tickets')).json();
    expect(no).toMatchObject({ allowed: false, reasons: [] });
    const owner = (await explain('owner', 'administer_track')).json();
    expect(owner.reasons).toContainEqual(expect.objectContaining({ grantee: 'track_owner' }));
    expect(
      (
        await as('member', {
          method: 'GET',
          url: `/api/v1/permissions/explain?trackId=${track}&permission=edit_tickets`,
        })
      ).statusCode,
    ).toBe(403);
  });

  it('[IAM-008] gives anonymous visitors only what is granted to anyone', async () => {
    const anon = await app.inject({
      method: 'GET',
      url: `/api/v1/me/permissions?trackId=${track}`,
    });
    expect(anon.json()).toEqual({ global: [], track: [] });
    await as('admin', {
      method: 'POST',
      url: `/api/v1/access-policies/${defaultPolicy}/grants`,
      payload: { permission: 'browse_track', grantee: 'anyone' },
    });
    const after = await app.inject({
      method: 'GET',
      url: `/api/v1/me/permissions?trackId=${track}`,
    });
    expect(after.json()).toEqual({ global: [], track: ['browse_track'] });
  });
});
