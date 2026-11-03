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
import type { GroupView } from './track-groups';

const PASSWORD = 'ladder violet harbour';
const peppers = pepperRing(pepperFromSecret('a pepper for the track group tests, long enough'));
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

/**
 * Personal track groups (CORE-034) and sharing them (IAM-034; ADR-121). Owen runs ALPHA and
 * BETA and only works in GAMMA; HIDDEN is a track he cannot see. What a share gives is checked
 * in the role rows themselves, as the authorizer reads them.
 */
describe('personal track groups (CORE-034, IAM-034)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};
  const ids: Record<string, number> = {};
  const tracks: Record<string, number> = {};
  let roles: Record<string, number>;

  const as = (who: string | undefined, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), ...(who ? { cookie: cookies[who] ?? who } : {}) },
    });

  const signIn = async (email: string) =>
    sessionOf(
      await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email, password: PASSWORD },
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
  }

  /** A role given on the track's People page, by the site administrator unless said. */
  const give = (track: string, role: string, user: string, who = 'admin') =>
    as(who, {
      method: 'PUT',
      url: `/api/v1/tracks/${tracks[track]}/roles/${roles[role]}/users/${ids[user]}`,
    });
  const take = (track: string, role: string, user: string, who = 'admin') =>
    as(who, {
      method: 'DELETE',
      url: `/api/v1/tracks/${tracks[track]}/roles/${roles[role]}/users/${ids[user]}`,
    });

  const layout = async (who: string): Promise<GroupView[]> => {
    const res = await as(who, { method: 'GET', url: '/api/v1/track-groups' });
    expect(res.statusCode, res.body).toBe(200);
    return res.json().groups;
  };
  const keysOf = (group: GroupView | undefined) => group?.tracks.map((t) => t.key);

  async function makeGroup(who: string, name: string, keys: string[]): Promise<number> {
    const res = await as(who, {
      method: 'POST',
      url: '/api/v1/track-groups',
      payload: { name, trackIds: keys.map((k) => tracks[k]) },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().groupId;
  }

  const share = (who: string, group: number, user: string, role: string | null) =>
    as(who, {
      method: 'POST',
      url: `/api/v1/track-groups/${group}/shares`,
      payload: { userId: ids[user], roleId: role === null ? null : roles[role] },
    });
  const unshare = (who: string, group: number, user: string) =>
    as(who, { method: 'DELETE', url: `/api/v1/track-groups/${group}/shares/${ids[user]}` });

  /** A person's roles in the test's tracks, as `KEY:Role`, from the rows themselves. */
  const rolesOf = async (user: string) =>
    (
      await database.db
        .selectFrom('track_role_actor as a')
        .innerJoin('track as t', 't.id', 'a.track_id')
        .innerJoin('role as r', 'r.id', 'a.role_id')
        .select(['t.key', 'r.name'])
        .where('a.user_id', '=', ids[user] as number)
        .execute()
    )
      .map((r) => `${r.key}:${r.name}`)
      .sort();

  const lastEvent = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['id', 'payload', 'actor_id', 'subject_id'])
      .where('type', '=', type)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      outbound: loopbackOutbound(),
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/setup',
      remoteAddress: nextAddress(),
      payload: {
        token: await issueSetupToken(database.db),
        instanceName: 'Track groups',
        admin: { name: 'Admin', email: 'admin@example.com', password: PASSWORD },
      },
    });
    expect(setup.statusCode, setup.body).toBe(201);
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
    for (const key of ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'HIDDEN']) {
      tracks[key] = (
        await database.db
          .insertInto('track')
          .values({
            workspace_id: 1,
            key,
            name: key[0] + key.slice(1).toLowerCase(),
            access_policy_id: policy.id,
          })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
    }
    for (const name of ['owen', 'ana', 'ben', 'cy', 'dee', 'eve', 'fay', 'gus'])
      await addUser(name);
    // Owen runs ALPHA, BETA and DELTA and works in GAMMA; Eve only works in ALPHA.
    for (const [track, role, user] of [
      ['ALPHA', 'Administrators', 'owen'],
      ['BETA', 'Administrators', 'owen'],
      ['DELTA', 'Administrators', 'owen'],
      ['GAMMA', 'Members', 'owen'],
      ['ALPHA', 'Members', 'eve'],
    ] as const) {
      expect((await give(track, role, user)).statusCode).toBe(204);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  describe('arranging the Tracks page (CORE-034)', () => {
    it('[CORE-034] makes a named group of tracks the person sees, private to them', async () => {
      const group = await makeGroup('owen', 'Launch', ['ALPHA', 'BETA']);
      const mine = await layout('owen');
      expect(mine).toEqual([
        expect.objectContaining({
          id: group,
          name: 'Launch',
          minimized: false,
          mine: true,
          sharedWith: 0,
          owner: { id: ids.owen, name: 'owen' },
        }),
      ]);
      expect(keysOf(mine[0])).toEqual(['ALPHA', 'BETA']);
      // Nobody else sees it, or can reach it.
      expect(await layout('ana')).toEqual([]);
      for (const options of [
        { method: 'PATCH', url: `/api/v1/track-groups/${group}`, payload: { minimized: true } },
        { method: 'DELETE', url: `/api/v1/track-groups/${group}` },
        { method: 'GET', url: `/api/v1/track-groups/${group}/shares` },
      ] as const) {
        expect((await as('ana', options)).statusCode).toBe(404);
      }
      expect((await as(undefined, { method: 'GET', url: '/api/v1/track-groups' })).statusCode).toBe(
        401,
      );
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${group}` });
    });

    it('[CORE-034] takes only tracks the person sees, and says nothing of the others', async () => {
      for (const trackIds of [[tracks.HIDDEN], [999_999], [tracks.ALPHA, tracks.HIDDEN]]) {
        const res = await as('owen', {
          method: 'POST',
          url: '/api/v1/track-groups',
          payload: { name: 'Nope', trackIds },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({ error: 'invalid_request', detail: 'trackIds' });
      }
      const empty = await makeGroup('owen', 'Empty for now', []);
      const hidden = await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${empty}/tracks/${tracks.HIDDEN}`,
      });
      expect(hidden.statusCode).toBe(404);
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${empty}` });
      expect(await layout('owen')).toEqual([]);
    });

    it('[CORE-034] moves tracks in, within, between and out of groups; a track sits in one', async () => {
      const first = await makeGroup('owen', 'First', ['ALPHA', 'BETA']);
      const second = await makeGroup('owen', 'Second', ['GAMMA']);
      // Into another group: it leaves the first.
      let res = await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${second}/tracks/${tracks.ALPHA}`,
        payload: { position: 0 },
      });
      expect(res.statusCode, res.body).toBe(200);
      let groups: GroupView[] = res.json().groups;
      expect(groups.map((g) => [g.name, keysOf(g)])).toEqual([
        ['First', ['BETA']],
        ['Second', ['ALPHA', 'GAMMA']],
      ]);
      expect((await lastEvent('track_group.track_moved')).payload).toEqual({
        trackId: tracks.ALPHA,
        fromGroupId: first,
        toGroupId: second,
        position: 0,
        given: [],
        removed: [],
      });
      // Within a group: only its place changes.
      res = await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${second}/tracks/${tracks.ALPHA}`,
        payload: { position: 5 },
      });
      groups = res.json().groups;
      expect(keysOf(groups[1])).toEqual(['GAMMA', 'ALPHA']);
      // A new group made from a track in another takes it from there.
      const third = await makeGroup('owen', 'Third', ['GAMMA']);
      groups = await layout('owen');
      expect(groups.map((g) => [g.name, keysOf(g)])).toEqual([
        ['First', ['BETA']],
        ['Second', ['ALPHA']],
        ['Third', ['GAMMA']],
      ]);
      // Out of a group: back among the tracks in none.
      res = await as('owen', {
        method: 'DELETE',
        url: `/api/v1/track-groups/${third}/tracks/${tracks.GAMMA}`,
      });
      expect(res.statusCode).toBe(200);
      expect(keysOf(res.json().groups[2])).toEqual([]);
      expect(
        (
          await as('owen', {
            method: 'DELETE',
            url: `/api/v1/track-groups/${third}/tracks/${tracks.GAMMA}`,
          })
        ).statusCode,
      ).toBe(404);
      for (const g of [first, second, third]) {
        await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
      }
    });

    it('[CORE-034] renames, minimizes, opens and orders groups, remembered on the server', async () => {
      const a = await makeGroup('owen', 'A', ['ALPHA']);
      const b = await makeGroup('owen', 'B', ['BETA']);
      let res = await as('owen', {
        method: 'PATCH',
        url: `/api/v1/track-groups/${a}`,
        payload: { name: '  Alpha work ', minimized: true },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect((await lastEvent('track_group.updated')).payload).toEqual({
        changes: {
          name: { from: 'A', to: 'Alpha work' },
          minimized: { from: false, to: true },
        },
      });
      res = await as('owen', {
        method: 'PUT',
        url: '/api/v1/track-groups/order',
        payload: { groupIds: [b, a] },
      });
      expect(res.statusCode, res.body).toBe(200);
      // A fresh read, as on another device.
      const groups = await layout('owen');
      expect(groups.map((g) => [g.name, g.minimized])).toEqual([
        ['B', false],
        ['Alpha work', true],
      ]);
      // Opened again.
      await as('owen', {
        method: 'PATCH',
        url: `/api/v1/track-groups/${a}`,
        payload: { minimized: false },
      });
      expect((await layout('owen'))[1]?.minimized).toBe(false);
      // An order must name every group once.
      for (const groupIds of [[a], [a, a], [a, b, 999]]) {
        const bad = await as('owen', {
          method: 'PUT',
          url: '/api/v1/track-groups/order',
          payload: { groupIds },
        });
        expect(bad.statusCode).toBe(400);
      }
      for (const payload of [{}, { name: '' }, { name: 'x'.repeat(101) }, { colour: 'red' }]) {
        const bad = await as('owen', {
          method: 'PATCH',
          url: `/api/v1/track-groups/${a}`,
          payload,
        });
        expect(bad.statusCode).toBe(400);
      }
      for (const g of [a, b])
        await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });
  });

  describe('sharing a group (IAM-034)', () => {
    let launch: number;

    beforeAll(async () => {
      launch = await makeGroup('owen', 'Launch', ['ALPHA', 'BETA', 'GAMMA']);
    });

    it('[IAM-034] gives the chosen role only on tracks where the sharer may give it', async () => {
      const res = await share('owen', launch, 'ana', 'Members');
      expect(res.statusCode, res.body).toBe(201);
      // Owen runs ALPHA and BETA; in GAMMA he only works, so he gives nothing there.
      expect(res.json()).toEqual({ tracks: 3, given: 2, alreadyHeld: 0, notGivable: 1 });
      expect(await rolesOf('ana')).toEqual(['ALPHA:Members', 'BETA:Members']);
      const ana = await layout('ana');
      expect(ana).toEqual([
        expect.objectContaining({
          id: launch,
          name: 'Launch',
          mine: false,
          owner: { id: ids.owen, name: 'owen' },
          role: { id: roles.Members, name: 'Members' },
        }),
      ]);
      // GAMMA stays out of her sight: the group shows only what she may see.
      expect(keysOf(ana[0])).toEqual(['ALPHA', 'BETA']);
      expect((await layout('owen'))[0]?.sharedWith).toBe(1);
      expect((await lastEvent('track_group.shared')).payload).toEqual({
        shareId: expect.any(Number),
        userId: ids.ana,
        roleId: roles.Members,
        given: [
          { trackId: tracks.ALPHA, userId: ids.ana, roleId: roles.Members },
          { trackId: tracks.BETA, userId: ids.ana, roleId: roles.Members },
        ],
      });
      // Sharing twice with one person is refused; the role changes by sharing again.
      expect((await share('owen', launch, 'ana', 'Viewers')).statusCode).toBe(409);
    });

    it('[IAM-034] someone a group is shared with may minimize and order it, nothing more', async () => {
      const minimized = await as('ana', {
        method: 'PATCH',
        url: `/api/v1/track-groups/${launch}`,
        payload: { minimized: true },
      });
      expect(minimized.statusCode).toBe(200);
      expect((await layout('ana'))[0]?.minimized).toBe(true);
      // Hers alone: the owner's stays open.
      expect((await layout('owen'))[0]?.minimized).toBe(false);
      const own = await makeGroup('ana', 'Mine', ['ALPHA']);
      const ordered = await as('ana', {
        method: 'PUT',
        url: '/api/v1/track-groups/order',
        payload: { groupIds: [own, launch] },
      });
      expect(ordered.statusCode).toBe(200);
      expect((await layout('ana')).map((g) => g.name)).toEqual(['Mine', 'Launch']);
      for (const options of [
        { method: 'PATCH', url: `/api/v1/track-groups/${launch}`, payload: { name: 'Hers' } },
        { method: 'DELETE', url: `/api/v1/track-groups/${launch}` },
        { method: 'PUT', url: `/api/v1/track-groups/${launch}/tracks/${tracks.ALPHA}` },
        { method: 'DELETE', url: `/api/v1/track-groups/${launch}/tracks/${tracks.ALPHA}` },
        { method: 'GET', url: `/api/v1/track-groups/${launch}/shares` },
        {
          method: 'POST',
          url: `/api/v1/track-groups/${launch}/shares`,
          payload: { userId: ids.ben, roleId: null },
        },
      ] as const) {
        expect((await as('ana', options)).statusCode, `${options.method} ${options.url}`).toBe(403);
      }
      await as('ana', { method: 'DELETE', url: `/api/v1/track-groups/${own}` });
    });

    it('[IAM-034] taking a share back removes what it gave and keeps a role held before', async () => {
      // Ben already works in ALPHA, given on its People page.
      expect((await give('ALPHA', 'Members', 'ben')).statusCode).toBe(204);
      const res = await share('owen', launch, 'ben', 'Members');
      expect(res.json()).toEqual({ tracks: 3, given: 1, alreadyHeld: 1, notGivable: 1 });
      expect(await rolesOf('ben')).toEqual(['ALPHA:Members', 'BETA:Members']);
      const back = await unshare('owen', launch, 'ben');
      expect(back.statusCode).toBe(204);
      expect(await rolesOf('ben')).toEqual(['ALPHA:Members']);
      expect((await lastEvent('track_group.unshared')).payload).toEqual({
        shareId: expect.any(Number),
        userId: ids.ben,
        roleId: roles.Members,
        removed: [{ trackId: tracks.BETA, userId: ids.ben, roleId: roles.Members }],
      });
      expect(await layout('ben')).toEqual([]);
      expect((await unshare('owen', launch, 'ben')).statusCode).toBe(404);
    });

    it('[IAM-034] a role given on the People page after a share is the person’s own', async () => {
      await share('owen', launch, 'cy', 'Members');
      expect(await rolesOf('cy')).toEqual(['ALPHA:Members', 'BETA:Members']);
      // An administrator gives what the share gave: from now on it is cy's.
      expect((await give('ALPHA', 'Members', 'cy')).statusCode).toBe(204);
      expect((await lastEvent('track_role.actor_added')).payload).toEqual({
        roleId: roles.Members,
        userId: ids.cy,
        groupId: null,
        keptFromGroupShares: true,
      });
      await unshare('owen', launch, 'cy');
      expect(await rolesOf('cy')).toEqual(['ALPHA:Members']);
      // Removed on the People page, a role the share held leaves no record behind.
      await share('owen', launch, 'cy', 'Viewers');
      expect((await take('BETA', 'Viewers', 'cy')).statusCode).toBe(204);
      expect((await give('BETA', 'Viewers', 'cy')).statusCode).toBe(204);
      await unshare('owen', launch, 'cy');
      expect(await rolesOf('cy')).toEqual(['ALPHA:Members', 'BETA:Viewers']);
      await take('ALPHA', 'Members', 'cy');
      await take('BETA', 'Viewers', 'cy');
    });

    it('[IAM-034] a role two shares gave stays until both are taken back', async () => {
      // The site administrator keeps a group with ALPHA too, and shares it with the same role.
      const theirs = await makeGroup('admin', 'Everything alpha', ['ALPHA']);
      await share('owen', launch, 'fay', 'Viewers');
      const second = await share('admin', theirs, 'fay', 'Viewers');
      expect(second.json()).toMatchObject({ given: 0, alreadyHeld: 1 });
      await unshare('owen', launch, 'fay');
      expect(await rolesOf('fay')).toEqual(['ALPHA:Viewers']);
      await unshare('admin', theirs, 'fay');
      expect(await rolesOf('fay')).toEqual([]);
      await as('admin', { method: 'DELETE', url: `/api/v1/track-groups/${theirs}` });
    });

    it('[IAM-034] a track moved into a shared group brings the role, and moved out takes it', async () => {
      await share('owen', launch, 'gus', 'Viewers');
      expect(await rolesOf('gus')).toEqual(['ALPHA:Viewers', 'BETA:Viewers']);
      const into = await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${launch}/tracks/${tracks.DELTA}`,
      });
      expect(into.statusCode, into.body).toBe(200);
      expect(await rolesOf('gus')).toEqual(['ALPHA:Viewers', 'BETA:Viewers', 'DELTA:Viewers']);
      expect((await lastEvent('track_group.track_moved')).payload).toMatchObject({
        trackId: tracks.DELTA,
        toGroupId: launch,
        given: expect.arrayContaining([
          { trackId: tracks.DELTA, userId: ids.gus, roleId: roles.Viewers },
        ]),
      });
      const out = await as('owen', {
        method: 'DELETE',
        url: `/api/v1/track-groups/${launch}/tracks/${tracks.DELTA}`,
      });
      expect(out.statusCode).toBe(200);
      expect(await rolesOf('gus')).toEqual(['ALPHA:Viewers', 'BETA:Viewers']);
      await unshare('owen', launch, 'gus');
      expect(await rolesOf('gus')).toEqual([]);
    });

    it('[IAM-034] a track moved between two groups shared alike keeps its role throughout', async () => {
      const side = await makeGroup('owen', 'Side', ['DELTA']);
      await share('owen', launch, 'gus', 'Viewers');
      await share('owen', side, 'gus', 'Viewers');
      const all = ['ALPHA:Viewers', 'BETA:Viewers', 'DELTA:Viewers'];
      expect(await rolesOf('gus')).toEqual(all);
      const moved = await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${launch}/tracks/${tracks.DELTA}`,
      });
      expect(moved.statusCode, moved.body).toBe(200);
      // Ana, whom the group is also shared with, gets it there; Gus's never went or came.
      expect((await lastEvent('track_group.track_moved')).payload).toEqual({
        trackId: tracks.DELTA,
        fromGroupId: side,
        toGroupId: launch,
        position: 3,
        given: [{ trackId: tracks.DELTA, userId: ids.ana, roleId: roles.Members }],
        removed: [],
      });
      expect(await rolesOf('gus')).toEqual(all);
      // Now only the first group's share holds it, and taking the track out takes the role.
      await as('owen', {
        method: 'DELETE',
        url: `/api/v1/track-groups/${launch}/tracks/${tracks.DELTA}`,
      });
      expect(await rolesOf('gus')).toEqual(['ALPHA:Viewers', 'BETA:Viewers']);
      await unshare('owen', launch, 'gus');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${side}` });
      expect(await rolesOf('gus')).toEqual([]);
    });

    it('[IAM-034] someone who runs no track shares the group and gives nothing', async () => {
      const hers = await makeGroup('eve', 'Eve’s', ['ALPHA']);
      const res = await share('eve', hers, 'gus', 'Administrators');
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ tracks: 1, given: 0, alreadyHeld: 0, notGivable: 1 });
      expect(await rolesOf('gus')).toEqual([]);
      // She sees which roles she may give: none, so the dialog offers only the group itself.
      const offer = await as('eve', { method: 'GET', url: `/api/v1/track-groups/${hers}/shares` });
      expect(offer.json()).toMatchObject({ trackCount: 1, roles: [] });
      // Without a role the group is shown and nothing is given; gus sees none of its tracks.
      expect((await share('eve', hers, 'dee', null)).json()).toEqual({
        tracks: 1,
        given: 0,
        alreadyHeld: 0,
        notGivable: 0,
      });
      const dee = await layout('dee');
      expect(dee.map((g) => [g.name, g.role, keysOf(g)])).toEqual([['Eve’s', null, []]]);
      await as('eve', { method: 'DELETE', url: `/api/v1/track-groups/${hers}` });
      expect(await layout('dee')).toEqual([]);
    });

    it('[IAM-034] the owner sees who has it, and which roles they may give on how many tracks', async () => {
      await share('owen', launch, 'gus', 'Members');
      const res = await as('owen', { method: 'GET', url: `/api/v1/track-groups/${launch}/shares` });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.trackCount).toBe(3);
      expect(body.roles).toEqual([
        { id: roles.Administrators, name: 'Administrators', givableOn: 2 },
        { id: roles.Members, name: 'Members', givableOn: 2 },
        { id: roles.Viewers, name: 'Viewers', givableOn: 2 },
      ]);
      expect(body.shares).toEqual([
        {
          userId: ids.ana,
          name: 'ana',
          active: true,
          role: { id: roles.Members, name: 'Members' },
          holds: 2,
        },
        {
          userId: ids.gus,
          name: 'gus',
          active: true,
          role: { id: roles.Members, name: 'Members' },
          holds: 2,
        },
      ]);
      await unshare('owen', launch, 'gus');
    });

    it('[IAM-034] a deactivated person gets nothing; one deactivated later loses what the share gave', async () => {
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', ids.dee as number)
        .execute();
      const refused = await share('owen', launch, 'dee', 'Members');
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: 'person_inactive' });
      const copy = await as('owen', {
        method: 'POST',
        url: `/api/v1/track-groups/${launch}/copies`,
        payload: { userId: ids.dee, roleId: roles.Members },
      });
      expect(copy.statusCode).toBe(400);
      expect(await rolesOf('dee')).toEqual([]);
      // Not offered in the picker either.
      const people = await as('owen', { method: 'GET', url: '/api/v1/track-groups/people?q=dee' });
      expect(people.json().people).toEqual([]);
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: null })
        .where('id', '=', ids.dee as number)
        .execute();

      // Shared while active, then deactivated: the share stays, and taking it back still works.
      await share('owen', launch, 'dee', 'Members');
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', ids.dee as number)
        .execute();
      const listed = await as('owen', {
        method: 'GET',
        url: `/api/v1/track-groups/${launch}/shares`,
      });
      expect(listed.json().shares).toContainEqual(
        expect.objectContaining({ userId: ids.dee, active: false, holds: 2 }),
      );
      expect((await unshare('owen', launch, 'dee')).statusCode).toBe(204);
      expect(await rolesOf('dee')).toEqual([]);
    });

    it('[IAM-034] refuses itself, unknown people and roles, and people outside the person kind', async () => {
      expect((await share('owen', launch, 'owen', 'Members')).statusCode).toBe(400);
      const unknown = await as('owen', {
        method: 'POST',
        url: `/api/v1/track-groups/${launch}/shares`,
        payload: { userId: 999_999, roleId: null },
      });
      expect(unknown.statusCode).toBe(404);
      const noRole = await as('owen', {
        method: 'POST',
        url: `/api/v1/track-groups/${launch}/shares`,
        payload: { userId: ids.ben, roleId: 999_999 },
      });
      expect(noRole.statusCode).toBe(404);
      expect(await layout('ben')).toEqual([]);
      // People are found by name or address, never the person asking.
      const found = await as('owen', { method: 'GET', url: '/api/v1/track-groups/people?q=ow' });
      expect(found.json().people).toEqual([]);
      const ana = await as('owen', { method: 'GET', url: '/api/v1/track-groups/people?q=an' });
      expect(ana.json().people).toEqual([{ id: ids.ana, name: 'ana' }]);
    });

    it('[IAM-034] never leaves a track with nobody to run it', async () => {
      const keep = await makeGroup('owen', 'Keep', ['DELTA']);
      await share('owen', keep, 'ben', 'Administrators');
      expect(await rolesOf('ben')).toContain('DELTA:Administrators');
      // Owen steps down: ben, through the share, is the only one left to run DELTA.
      expect((await take('DELTA', 'Administrators', 'owen')).statusCode).toBe(204);
      const back = await unshare('owen', keep, 'ben');
      expect(back.statusCode).toBe(409);
      expect(back.json()).toEqual({ error: 'last_track_admin', trackIds: [tracks.DELTA] });
      expect(await rolesOf('ben')).toContain('DELTA:Administrators');
      // Deleting the group is refused for the same reason, and changes nothing.
      expect(
        (await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${keep}` })).statusCode,
      ).toBe(409);
      expect((await layout('ben')).map((g) => g.name)).toContain('Keep');
      // Once someone else runs it, the share can go.
      expect((await give('DELTA', 'Administrators', 'owen')).statusCode).toBe(204);
      expect(
        (await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${keep}` })).statusCode,
      ).toBe(200);
      expect(await rolesOf('ben')).not.toContain('DELTA:Administrators');
    });

    it('[IAM-034] deleting a shared group takes back what its shares gave', async () => {
      const temp = await makeGroup('owen', 'Temporary', ['DELTA']);
      await share('owen', temp, 'gus', 'Viewers');
      expect(await rolesOf('gus')).toEqual(['DELTA:Viewers']);
      const res = await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${temp}` });
      expect(res.statusCode).toBe(200);
      expect(await rolesOf('gus')).toEqual([]);
      expect((await lastEvent('track_group.deleted')).payload).toEqual({
        name: 'Temporary',
        trackIds: [tracks.DELTA],
        removed: [{ trackId: tracks.DELTA, userId: ids.gus, roleId: roles.Viewers }],
      });
      expect(await layout('gus')).toEqual([]);
    });
  });

  describe('setting a group on someone (IAM-034)', () => {
    it('[IAM-034] gives them a copy of their own, and the role as an ordinary one', async () => {
      const crew = await makeGroup('owen', 'Crew', ['BETA', 'GAMMA']);
      const res = await as('owen', {
        method: 'POST',
        url: `/api/v1/track-groups/${crew}/copies`,
        payload: { userId: ids.ben, roleId: roles.Viewers },
      });
      expect(res.statusCode, res.body).toBe(201);
      expect(res.json()).toEqual({
        groupId: expect.any(Number),
        tracks: 2,
        given: 1,
        alreadyHeld: 0,
        notGivable: 1,
      });
      const ben = await layout('ben');
      expect(ben).toEqual([
        expect.objectContaining({
          id: res.json().groupId,
          name: 'Crew',
          mine: true,
          givenBy: { id: ids.owen, name: 'owen' },
        }),
      ]);
      expect(keysOf(ben[0])).toEqual(['BETA']);
      // His to change: he renames it, and the owner's stays as it was.
      expect(
        (
          await as('ben', {
            method: 'PATCH',
            url: `/api/v1/track-groups/${res.json().groupId}`,
            payload: { name: 'My crew' },
          })
        ).statusCode,
      ).toBe(200);
      expect((await layout('owen')).find((g) => g.id === crew)?.name).toBe('Crew');
      // The role is his like any other: the owner deleting the group takes nothing.
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${crew}` });
      expect(await rolesOf('ben')).toContain('BETA:Viewers');
      expect((await lastEvent('track_group.copied')).payload).toEqual({
        fromGroupId: crew,
        userId: ids.ben,
        roleId: roles.Viewers,
        trackIds: [tracks.BETA, tracks.GAMMA],
        given: [{ trackId: tracks.BETA, userId: ids.ben, roleId: roles.Viewers }],
      });
    });
  });

  describe('the audit log (IAM-034)', () => {
    it('[IAM-034] records sharing and taking back, with the roles that came and went', async () => {
      const bus = new EventBus(database.db);
      registerSubscribers(bus, { db: database.db });
      const runner = new JobRunner(database.db, 'track-groups-test');
      bus.attach(runner);
      while ((await bus.relayOnce()) > 0) {}
      while ((await runner.runOnce()) > 0) {}
      const records = await database.db
        .selectFrom('audit_event')
        .select(['action', 'actor_id', 'details'])
        .where('action', 'like', 'track_group.%')
        .execute();
      expect(records).toContainEqual({
        action: 'track_group.shared',
        actor_id: ids.owen,
        details: expect.objectContaining({
          userId: ids.ana,
          roleId: roles.Members,
          given: expect.arrayContaining([
            { trackId: tracks.ALPHA, userId: ids.ana, roleId: roles.Members },
          ]),
        }),
      });
      expect(records).toContainEqual({
        action: 'track_group.unshared',
        actor_id: ids.owen,
        details: expect.objectContaining({
          userId: ids.ben,
          removed: [{ trackId: tracks.BETA, userId: ids.ben, roleId: roles.Members }],
        }),
      });
      expect(records.map((r) => r.action)).toContain('track_group.copied');
      // A person's own arrangement is not audited.
      expect(records.map((r) => r.action)).not.toContain('track_group.updated');
      expect(records.map((r) => r.action)).not.toContain('track_group.reordered');
    });
  });
});
