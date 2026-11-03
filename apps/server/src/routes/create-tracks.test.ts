import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { issueSetupToken } from '../setup';
import { loopbackOutbound } from '../testing/outbound';

const PASSWORD = 'ladder violet harbour';
const NEW_PASSWORD = 'another otter lantern';
const peppers = pepperRing(pepperFromSecret('a pepper for the create-tracks tests, long enough'));
let address = 0;
const nextAddress = () => `198.51.${100 + (address >> 8)}.${(address++ & 255) + 1}`;

function sessionOf(res: LightMyRequestResponse): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (
      list.find(
        (c) => c.startsWith(`${SESSION_COOKIE}=`) && !c.startsWith(`${SESSION_COOKIE}=;`),
      ) ?? ''
    ).split(';')[0] ?? ''
  );
}

const tokenOf = (link: string) =>
  new URL(link.replace('/#/', '/')).searchParams.get('token') as string;

/**
 * Who may create tracks (IAM-033; ADR-118): off for everyone but site administrators on a new
 * site, given by ticking a box when someone gets the role that runs a track, and only by someone
 * who could give it anyway.
 */
describe('who may create tracks (IAM-033)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  let roles: Record<string, number>;
  let track: number;
  let keys = 0;

  const as = (who: string | undefined, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: {
        ...(options.headers ?? {}),
        ...(who ? { cookie: cookies[who] ?? who } : {}),
      },
    });

  const signIn = async (email: string, password = PASSWORD) =>
    sessionOf(
      await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email, password },
        remoteAddress: nextAddress(),
      }),
    );

  async function addUser(name: string) {
    const email = `${name}@example.com`;
    const row = await database.db
      .insertInto('app_user')
      .values({ workspace_id: 1, email, name, password_hash: await passwords.hash(PASSWORD) })
      .returning('id')
      .executeTakeFirstOrThrow();
    ids[name] = row.id;
    cookies[name] = await signIn(email);
    return row.id;
  }

  const give = (role: string, user: string, createTracks?: boolean, who = 'admin') =>
    as(who, {
      method: 'PUT',
      url: `/api/v1/tracks/${track}/roles/${roles[role]}/users/${ids[user]}`,
      ...(createTracks === undefined ? {} : { payload: { createTracks } }),
    });

  const take = (role: string, user: string) =>
    as('admin', {
      method: 'DELETE',
      url: `/api/v1/tracks/${track}/roles/${roles[role]}/users/${ids[user]}`,
    });

  /** The person's own grants of the permission: what ticking the box writes. */
  const grantsOf = (user: string) =>
    database.db
      .selectFrom('global_grant')
      .select('id')
      .where('permission', '=', 'create_local_tracks')
      .where('grantee', '=', 'user')
      .where('user_id', '=', ids[user] as number)
      .execute();

  const mayCreate = async (who: string) =>
    (await as(who, { method: 'GET', url: '/api/v1/session' })).json().user.mayCreateLocalTracks;

  const createLocal = (who: string) =>
    as(who, {
      method: 'POST',
      url: '/api/v1/tracks',
      payload: { key: `LOC${++keys}`, name: `Local ${keys}`, mode: 'local' },
    });

  const lastEvent = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['id', 'payload'])
      .where('type', '=', type)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();

  const eventCount = async () =>
    Number(
      (
        await database.db
          .selectFrom('domain_event')
          .select((eb) => eb.fn.countAll().as('n'))
          .executeTakeFirstOrThrow()
      ).n,
    );

  const invite = (
    who: string,
    payload: { addresses?: string[]; userIds?: number[]; role?: string; createTracks?: boolean },
  ) =>
    as(who, {
      method: 'POST',
      url: `/api/v1/tracks/${track}/invitations`,
      payload: {
        addresses: payload.addresses ?? [],
        userIds: payload.userIds ?? [],
        roleId: roles[payload.role ?? 'Administrators'],
        delivery: 'link',
        ...(payload.createTracks === undefined ? {} : { createTracks: payload.createTracks }),
      },
    });

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      outbound: loopbackOutbound(),
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
      publicUrl: 'http://tracker.test',
      invitationMail: async () => null,
    });
    // A new site: first-run setup makes the site administrator.
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      remoteAddress: nextAddress(),
      payload: {
        token: await issueSetupToken(database.db),
        instanceName: 'Create tracks',
        admin: { name: 'Admin', email: 'admin@example.com', password: PASSWORD },
      },
    });
    expect(setup.statusCode, setup.body).toBe(201);
    // The tests sign in with passwords only.
    await database.db.updateTable('two_factor_policy').set({ required: 'none' }).execute();
    ids.admin = setup.json().user.id;
    cookies.admin = await signIn('admin@example.com');
    const rows = await database.db.selectFrom('role').select(['id', 'name']).execute();
    roles = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('name', '=', 'Default access policy')
      .executeTakeFirstOrThrow();
    track = (
      await database.db
        .insertInto('track')
        .values({ workspace_id: 1, key: 'MGR', name: 'Managed', access_policy_id: policy.id })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    for (const name of ['manager', 'holder', 'member', 'ana', 'ben', 'cy', 'dee', 'eve']) {
      await addUser(name);
    }
    // A manager who appoints but may not create tracks, and one who holds the permission.
    expect((await give('Administrators', 'manager')).statusCode).toBe(204);
    expect((await give('Administrators', 'holder')).statusCode).toBe(204);
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'create_local_tracks',
        grantee: 'user',
        user_id: ids.holder as number,
      })
      .execute();
    // Both may invite into the track.
    await database.db
      .insertInto('access_grant')
      .values({
        workspace_id: 1,
        policy_id: policy.id,
        permission: 'invite_people',
        grantee: 'role',
        role_id: roles.Administrators as number,
      })
      .execute();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('a new site', () => {
    it('[IAM-033] leaves creating tracks to site administrators until someone is given it', async () => {
      const everyone = await database.db
        .selectFrom('global_grant')
        .select('id')
        .where('permission', '=', 'create_local_tracks')
        .where('grantee', '=', 'any_user')
        .execute();
      expect(everyone).toEqual([]);
      expect(await mayCreate('member')).toBe(false);
      expect((await createLocal('member')).statusCode).toBe(403);
      // Running a track gives nothing global.
      expect(await mayCreate('manager')).toBe(false);
      expect((await createLocal('manager')).statusCode).toBe(403);
      expect(await mayCreate('admin')).toBe(true);
      expect((await createLocal('admin')).statusCode).toBe(201);
    });
  });

  describe('giving the role that runs the track', () => {
    it('[IAM-033] a ticked box gives the person a site-wide grant, in the role’s one event', async () => {
      const before = await eventCount();
      const res = await give('Administrators', 'ana', true);
      expect(res.statusCode, res.body).toBe(204);
      expect(await eventCount()).toBe(before + 1);
      const [grant] = await grantsOf('ana');
      expect(grant).toBeDefined();
      const event = await lastEvent('track_role.actor_added');
      expect(event.payload).toEqual({
        roleId: roles.Administrators,
        userId: ids.ana,
        groupId: null,
        createTracksGrantId: grant?.id,
      });
      expect(await mayCreate('ana')).toBe(true);
      expect((await createLocal('ana')).statusCode).toBe(201);
    });

    it('[IAM-033] an unticked box writes nothing', async () => {
      expect((await give('Administrators', 'ben', false)).statusCode).toBe(204);
      expect(await grantsOf('ben')).toEqual([]);
      expect((await lastEvent('track_role.actor_added')).payload).not.toHaveProperty(
        'createTracksGrantId',
      );
      expect(await mayCreate('ben')).toBe(false);
    });

    it('[IAM-033] a manager who may not create tracks cannot give it, even by asking the API', async () => {
      const refused = await give('Administrators', 'cy', true, 'manager');
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'create_local_tracks' });
      // Nothing happened: no role and no grant.
      const holders = await as('admin', {
        method: 'GET',
        url: `/api/v1/tracks/${track}/role-actors`,
      });
      const administrators = holders
        .json()
        .roles.find((r: { roleId: number }) => r.roleId === roles.Administrators);
      expect(administrators.users.map((u: { id: number }) => u.id)).not.toContain(ids.cy);
      expect(await grantsOf('cy')).toEqual([]);
      // Without the box the same manager still appoints (IAM-028).
      expect((await give('Administrators', 'cy', false, 'manager')).statusCode).toBe(204);
      expect(await grantsOf('cy')).toEqual([]);
    });

    it('[IAM-033] someone who holds the permission may give it', async () => {
      expect((await give('Administrators', 'dee', true, 'holder')).statusCode).toBe(204);
      expect(await grantsOf('dee')).toHaveLength(1);
    });

    it('[IAM-033] the box goes only with a role that runs the track, and only to a person', async () => {
      const members = await give('Members', 'eve', true);
      expect(members.statusCode).toBe(400);
      const group = await database.db
        .insertInto('user_group')
        .values({ workspace_id: 1, name: 'Leads' })
        .returning('id')
        .executeTakeFirstOrThrow();
      const toGroup = await as('admin', {
        method: 'PUT',
        url: `/api/v1/tracks/${track}/roles/${roles.Administrators}/groups/${group.id}`,
        payload: { createTracks: true },
      });
      expect(toGroup.statusCode).toBe(400);
      expect(await grantsOf('eve')).toEqual([]);
    });

    it('[IAM-033] a role already held brings no grant', async () => {
      const before = await eventCount();
      expect((await give('Administrators', 'ben', true)).statusCode).toBe(204);
      expect(await eventCount()).toBe(before);
      expect(await grantsOf('ben')).toEqual([]);
    });

    it('[IAM-033] removing the role leaves the grant, which a site administrator removes', async () => {
      expect((await take('Administrators', 'dee')).statusCode).toBe(204);
      const [grant] = await grantsOf('dee');
      expect(grant).toBeDefined();
      expect(await mayCreate('dee')).toBe(true);
      // The Permissions page lists it with the person's name, and removes it.
      const list = await as('admin', { method: 'GET', url: '/api/v1/global-grants' });
      expect(list.json().grants).toContainEqual(
        expect.objectContaining({
          id: grant?.id,
          permission: 'create_local_tracks',
          grantee: 'user',
          userId: ids.dee,
          userName: 'dee',
        }),
      );
      const removed = await as('admin', {
        method: 'DELETE',
        url: `/api/v1/global-grants/${grant?.id}`,
      });
      expect(removed.statusCode).toBe(204);
      expect(await mayCreate('dee')).toBe(false);
    });

    it('[IAM-033] the grant is audited with the role', async () => {
      const bus = new EventBus(database.db);
      registerSubscribers(bus, { db: database.db });
      const runner = new JobRunner(database.db, 'create-tracks-test');
      bus.attach(runner);
      while ((await bus.relayOnce()) > 0) {}
      while ((await runner.runOnce()) > 0) {}
      const [grant] = await grantsOf('ana');
      const record = await database.db
        .selectFrom('audit_event')
        .select(['actor_id', 'details'])
        .where('action', '=', 'track_role.actor_added')
        .where('subject_id', '=', String(track))
        .execute();
      expect(record).toContainEqual({
        actor_id: ids.admin,
        details: expect.objectContaining({ userId: ids.ana, createTracksGrantId: grant?.id }),
      });
    });
  });

  describe('API tokens', () => {
    async function tokenFor(who: string, scopes: string[]) {
      const res = await as(who, {
        method: 'POST',
        url: '/api/v1/account/tokens',
        payload: { name: `${who} ${scopes.join(' ')}`, scopes, expiresInDays: 30 },
      });
      expect(res.statusCode, res.body).toBe(201);
      return (res.json().secret ?? res.json().token) as string;
    }

    it('[IAM-033] ticking needs the admin scope, though the role alone needs only write', async () => {
      const person = await addUser('fay');
      const url = `/api/v1/tracks/${track}/roles/${roles.Administrators}/users/${person}`;
      // The holder runs the track and holds the permission, but the token is a write token.
      const write = await tokenFor('holder', ['read', 'write']);
      const refused = await app.inject({
        method: 'PUT',
        url,
        headers: { authorization: `Bearer ${write}` },
        payload: { createTracks: true },
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'insufficient_scope', requiredScope: 'admin' });
      expect(refused.headers['www-authenticate']).toContain('scope="admin"');
      expect(await grantsOf('fay')).toEqual([]);
      const admin = await tokenFor('admin', ['read', 'write', 'admin']);
      const allowed = await app.inject({
        method: 'PUT',
        url,
        headers: { authorization: `Bearer ${admin}` },
        payload: { createTracks: true },
      });
      expect(allowed.statusCode, allowed.body).toBe(204);
      expect(await grantsOf('fay')).toHaveLength(1);
    });
  });

  describe('invitations', () => {
    it('[IAM-033] a new address gets the grant when it takes up the invitation', async () => {
      const made = await invite('holder', { addresses: ['gil@example.net'], createTracks: true });
      expect(made.statusCode, made.body).toBe(201);
      const [result] = made.json().results;
      const row = await database.db
        .selectFrom('track_invitation')
        .select(['grants_create_tracks', 'granted_user_id'])
        .where('id', '=', result.invitationId)
        .executeTakeFirstOrThrow();
      expect(row).toEqual({ grants_create_tracks: true, granted_user_id: null });
      expect((await lastEvent('track_invitation.created')).payload).toMatchObject({
        createTracks: true,
      });
      const redeemed = await as(undefined, {
        method: 'POST',
        url: '/api/v1/invitations/redeem',
        payload: { token: tokenOf(result.link), name: 'Gil', password: NEW_PASSWORD },
      });
      expect(redeemed.statusCode, redeemed.body).toBe(200);
      const gil = await database.db
        .selectFrom('app_user')
        .select('id')
        .where('email', '=', 'gil@example.net')
        .executeTakeFirstOrThrow();
      ids.gil = gil.id;
      const [grant] = await grantsOf('gil');
      expect((await lastEvent('track_invitation.accepted')).payload).toMatchObject({
        userId: gil.id,
        accountCreated: true,
        createTracksGrantId: grant?.id,
      });
      cookies.gil = await signIn('gil@example.net', NEW_PASSWORD);
      expect(await mayCreate('gil')).toBe(true);
    });

    it('[IAM-033] an existing person gets the grant with the role, at once', async () => {
      const hal = await addUser('hal');
      const byAddress = await invite('admin', {
        addresses: ['hal@example.com'],
        createTracks: true,
      });
      expect(byAddress.statusCode).toBe(201);
      const [grant] = await grantsOf('hal');
      expect((await lastEvent('track_invitation.created')).payload).toMatchObject({
        grantedUserId: hal,
        createTracks: true,
        createTracksGrantId: grant?.id,
      });
      const ivy = await addUser('ivy');
      const byName = await invite('admin', { userIds: [ivy], createTracks: true });
      expect(byName.json().results).toEqual([{ userId: ivy, name: 'ivy', status: 'added' }]);
      const [ivyGrant] = await grantsOf('ivy');
      expect((await lastEvent('track_role.actor_added')).payload).toMatchObject({
        userId: ivy,
        createTracksGrantId: ivyGrant?.id,
      });
    });

    it('[IAM-033] an inviter who may not create tracks cannot ask for it, nor with another role', async () => {
      const refused = await invite('manager', {
        addresses: ['jo@example.net'],
        createTracks: true,
      });
      expect(refused.statusCode).toBe(403);
      expect(refused.json()).toEqual({ error: 'forbidden', permission: 'create_local_tracks' });
      const members = await invite('admin', {
        addresses: ['jo@example.net'],
        role: 'Members',
        createTracks: true,
      });
      expect(members.statusCode).toBe(400);
    });

    it('[IAM-033] an inviter who lost the permission gives the role but not the grant', async () => {
      const made = await invite('holder', { addresses: ['kim@example.net'], createTracks: true });
      const link = made.json().results[0].link as string;
      await database.db
        .deleteFrom('global_grant')
        .where('permission', '=', 'create_local_tracks')
        .where('user_id', '=', ids.holder as number)
        .execute();
      try {
        const redeemed = await as(undefined, {
          method: 'POST',
          url: '/api/v1/invitations/redeem',
          payload: { token: tokenOf(link), name: 'Kim', password: NEW_PASSWORD },
        });
        expect(redeemed.statusCode).toBe(200);
        const kim = await database.db
          .selectFrom('app_user')
          .select('id')
          .where('email', '=', 'kim@example.net')
          .executeTakeFirstOrThrow();
        ids.kim = kim.id;
        const accepted = await lastEvent('track_invitation.accepted');
        expect(accepted.payload).toMatchObject({ userId: kim.id, accountCreated: true });
        expect(accepted.payload).not.toHaveProperty('createTracksGrantId');
        expect(await grantsOf('kim')).toEqual([]);
      } finally {
        await database.db
          .insertInto('global_grant')
          .values({
            workspace_id: 1,
            permission: 'create_local_tracks',
            grantee: 'user',
            user_id: ids.holder as number,
          })
          .execute();
      }
    });
  });
});

describe('a site set up before (IAM-033)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      passwords: passwordHasher(peppers),
      peppers,
    });
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-033] keeps everyone’s permission: only a new site’s setup takes it back', async () => {
    // The migrations, upgrades included, leave the grant to everyone signed in as it was.
    const everyone = await database.db
      .selectFrom('global_grant')
      .select('id')
      .where('workspace_id', '=', 1)
      .where('permission', '=', 'create_local_tracks')
      .where('grantee', '=', 'any_user')
      .execute();
    expect(everyone).toHaveLength(1);
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'old@example.com',
        name: 'Old',
        password_hash: await passwordHasher(peppers).hash(PASSWORD),
      })
      .execute();
    const session = sessionOf(
      await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: 'old@example.com', password: PASSWORD },
        remoteAddress: nextAddress(),
      }),
    );
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/tracks',
      headers: { cookie: session },
      payload: { key: 'OLD', name: 'Old site', mode: 'local' },
    });
    expect(created.statusCode, created.body).toBe(201);
  });
});
