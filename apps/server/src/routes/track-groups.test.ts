import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import { LocalStore } from '@taskmoor/storage';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { storesOf } from '../attachments/stores';
import { SESSION_COOKIE } from '../auth';
import { Authorizer } from '../authz/authorizer';
import { deliverEmail } from '../email/deliver';
import type { MailTransport, OutgoingEmail } from '../email/transport';
import { EventBus } from '../events/bus';
import { JobRunner } from '../events/queue';
import { registerSubscribers } from '../events/subscribers';
import { folderSink } from '../export/sinks';
import { addRoleActors } from '../import/load';
import { writePersonalData } from '../privacy/export';
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
      publicUrl: 'http://tracker.test',
      invitationMail: async () => null,
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
        kept: [],
      });
    });
  });

  describe('changes that run at once, and every other way a role is written (IAM-034)', () => {
    /** The shares' records of a person's role in a track. */
    const records = (track: string, role: string, user: string) =>
      database.db
        .selectFrom('track_group_access')
        .select('share_id')
        .where('track_id', '=', tracks[track] as number)
        .where('role_id', '=', roles[role] as number)
        .where('user_id', '=', ids[user] as number)
        .execute();
    const shareOf = (group: number, user: string) =>
      database.db
        .selectFrom('track_group_share')
        .select('id')
        .where('group_id', '=', group)
        .where('user_id', '=', ids[user] as number)
        .executeTakeFirstOrThrow();

    it('[IAM-034] taking a share back waits for a give in progress on the group, and takes that too', async () => {
      const race = await makeGroup('owen', 'Race', ['DELTA']);
      await share('owen', race, 'fay', 'Viewers');
      const s = await shareOf(race, 'fay');
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      let held!: () => void;
      const holding = new Promise<void>((resolve) => {
        held = resolve;
      });
      // Moving BETA into the group, half done: the change holds its locks as the route does and
      // has given fay the share's role on BETA, not yet committed.
      const inFlight = database.db.transaction().execute(async (trx) => {
        await sql`SELECT pg_advisory_xact_lock(hashtext('track-groups'), ${ids.owen}::int)`.execute(
          trx,
        );
        await trx
          .selectFrom('track_group')
          .select('id')
          .where('id', '=', race)
          .forUpdate()
          .execute();
        await trx
          .insertInto('track_group_track')
          .values({
            workspace_id: 1,
            group_id: race,
            owner_id: ids.owen as number,
            track_id: tracks.BETA as number,
            position: 1,
          })
          .execute();
        const beta = {
          workspace_id: 1,
          track_id: tracks.BETA as number,
          role_id: roles.Viewers as number,
          user_id: ids.fay as number,
        };
        await trx.insertInto('track_role_actor').values(beta).execute();
        await trx
          .insertInto('track_group_access')
          .values({ ...beta, share_id: s.id })
          .execute();
        held();
        await gate;
      });
      await holding;
      const back = unshare('owen', race, 'fay');
      await new Promise((resolve) => setTimeout(resolve, 200));
      finish();
      await inFlight;
      expect((await back).statusCode).toBe(204);
      expect(await rolesOf('fay')).toEqual([]);
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${race}` });
    });

    it('[CORE-034] two moves of one track into different groups at once both land, one after the other', async () => {
      const a = await makeGroup('owen', 'A', []);
      const b = await makeGroup('owen', 'B', []);
      const moves = await Promise.all(
        [a, b].map((g) =>
          as('owen', { method: 'PUT', url: `/api/v1/track-groups/${g}/tracks/${tracks.BETA}` }),
        ),
      );
      expect(moves.map((m) => m.statusCode)).toEqual([200, 200]);
      const holding = (await layout('owen')).filter((g) => keysOf(g)?.includes('BETA'));
      expect(holding).toHaveLength(1);
      for (const g of [a, b])
        await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[CORE-034] a place counts the tracks the person sees, so hidden ones never shift a move', async () => {
      // Owen sees HIDDEN while he groups it, then loses it: the group keeps it, unseen.
      expect((await give('HIDDEN', 'Viewers', 'owen')).statusCode).toBe(204);
      const g = await makeGroup('owen', 'With a hidden one', ['DELTA', 'HIDDEN', 'BETA']);
      expect((await take('HIDDEN', 'Viewers', 'owen')).statusCode).toBe(204);
      const shown = async () => keysOf((await layout('owen')).find((x) => x.id === g));
      expect(await shown()).toEqual(['DELTA', 'BETA']);
      // One place later, as the page counts it: after BETA.
      const later = await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${g}/tracks/${tracks.DELTA}`,
        payload: { position: 1 },
      });
      expect(later.statusCode).toBe(200);
      expect(await shown()).toEqual(['BETA', 'DELTA']);
      // And back to the start: before BETA.
      await as('owen', {
        method: 'PUT',
        url: `/api/v1/track-groups/${g}/tracks/${tracks.DELTA}`,
        payload: { position: 0 },
      });
      expect(await shown()).toEqual(['DELTA', 'BETA']);
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[IAM-034] revoking an invitation that gave a role clears the shares’ record of it', async () => {
      // An invitation gives cy Members on BETA at once; the role is then taken on the People page.
      const invited = await as('admin', {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.BETA}/invitations`,
        payload: { addresses: ['cy@example.com'], roleId: roles.Members, delivery: 'link' },
      });
      expect(invited.statusCode, invited.body).toBe(201);
      const invitationId = invited.json().results[0].invitationId;
      expect(await rolesOf('cy')).toEqual(['BETA:Members']);
      expect((await take('BETA', 'Members', 'cy')).statusCode).toBe(204);
      // A share gives it again; then the invitation is revoked, which removes the role.
      const g = await makeGroup('owen', 'Stale', ['BETA']);
      await share('owen', g, 'cy', 'Members');
      expect(await records('BETA', 'Members', 'cy')).toHaveLength(1);
      const revoked = await as('admin', {
        method: 'DELETE',
        url: `/api/v1/tracks/${tracks.BETA}/invitations/${invitationId}`,
      });
      expect(revoked.statusCode).toBe(204);
      expect(await rolesOf('cy')).toEqual([]);
      expect(await records('BETA', 'Members', 'cy')).toEqual([]);
      // Given again on the People page, it is cy's: taking the share back leaves it.
      expect((await give('BETA', 'Members', 'cy')).statusCode).toBe(204);
      await unshare('owen', g, 'cy');
      expect(await rolesOf('cy')).toEqual(['BETA:Members']);
      await take('BETA', 'Members', 'cy');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[IAM-034] a role given on the People page is the person’s own even past a stale record', async () => {
      const g = await makeGroup('owen', 'Old record', ['BETA']);
      await share('owen', g, 'cy', null);
      const s = await shareOf(g, 'cy');
      // A record with no role behind it, as an older release could leave.
      await database.db
        .insertInto('track_group_access')
        .values({
          workspace_id: 1,
          share_id: s.id,
          track_id: tracks.BETA as number,
          role_id: roles.Viewers as number,
          user_id: ids.cy as number,
        })
        .execute();
      expect((await give('BETA', 'Viewers', 'cy')).statusCode).toBe(204);
      expect(await records('BETA', 'Viewers', 'cy')).toEqual([]);
      await unshare('owen', g, 'cy');
      expect(await rolesOf('cy')).toEqual(['BETA:Viewers']);
      await take('BETA', 'Viewers', 'cy');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[IAM-034] a role an import names is the person’s own, not the share’s', async () => {
      const g = await makeGroup('owen', 'Imported', ['BETA']);
      await share('owen', g, 'cy', 'Viewers');
      await database.db
        .transaction()
        .execute((trx) =>
          addRoleActors({ trx, workspaceId: 1 }, tracks.BETA as number, [
            { role: roles.Viewers as number, user: ids.cy as number, group: null },
          ]),
        );
      expect(await records('BETA', 'Viewers', 'cy')).toEqual([]);
      await unshare('owen', g, 'cy');
      expect(await rolesOf('cy')).toEqual(['BETA:Viewers']);
      await take('BETA', 'Viewers', 'cy');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[IAM-034] an invitation to a role a share held makes it the person’s own, and says so', async () => {
      const g = await makeGroup('owen', 'Invited', ['BETA']);
      await share('owen', g, 'cy', 'Viewers');
      // By name, as the People page's Invite does for someone with an account.
      const byName = await as('admin', {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.BETA}/invitations`,
        payload: { userIds: [ids.cy], roleId: roles.Viewers, delivery: 'link' },
      });
      expect(byName.statusCode, byName.body).toBe(201);
      expect((await lastEvent('track_role.actor_added')).payload).toEqual({
        roleId: roles.Viewers,
        userId: ids.cy,
        groupId: null,
        keptFromGroupShares: true,
      });
      await unshare('owen', g, 'cy');
      expect(await rolesOf('cy')).toEqual(['BETA:Viewers']);
      await take('BETA', 'Viewers', 'cy');
      // By address: the invitation's own event says it.
      await share('owen', g, 'cy', 'Viewers');
      const byAddress = await as('admin', {
        method: 'POST',
        url: `/api/v1/tracks/${tracks.BETA}/invitations`,
        payload: { addresses: ['cy@example.com'], roleId: roles.Viewers, delivery: 'link' },
      });
      expect(byAddress.statusCode, byAddress.body).toBe(201);
      expect((await lastEvent('track_invitation.created')).payload).toMatchObject({
        grantedUserId: null,
        keptFromGroupShares: true,
      });
      await unshare('owen', g, 'cy');
      expect(await rolesOf('cy')).toEqual(['BETA:Viewers']);
      await take('BETA', 'Viewers', 'cy');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[IAM-034] setting a group on someone lists the roles it made theirs from shares', async () => {
      const g = await makeGroup('owen', 'Handed over', ['BETA']);
      await share('owen', g, 'cy', 'Viewers');
      const res = await as('owen', {
        method: 'POST',
        url: `/api/v1/track-groups/${g}/copies`,
        payload: { userId: ids.cy, roleId: roles.Viewers },
      });
      expect(res.statusCode).toBe(201);
      expect((await lastEvent('track_group.copied')).payload).toMatchObject({
        given: [],
        kept: [{ trackId: tracks.BETA, userId: ids.cy, roleId: roles.Viewers }],
      });
      await unshare('owen', g, 'cy');
      expect(await rolesOf('cy')).toEqual(['BETA:Viewers']);
      await take('BETA', 'Viewers', 'cy');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
      await as('cy', { method: 'DELETE', url: `/api/v1/track-groups/${res.json().groupId}` });
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

  /** The worker's part: events to their subscribers (notifications, the audit log). */
  async function work(): Promise<void> {
    const bus = new EventBus(database.db);
    registerSubscribers(bus, { db: database.db });
    const runner = new JobRunner(database.db, 'track-groups-work');
    bus.attach(runner);
    while ((await bus.relayOnce()) > 0) {}
    while ((await runner.runOnce()) > 0) {}
  }
  const leave = (who: string, group: number) =>
    as(who, { method: 'POST', url: `/api/v1/track-groups/${group}/leave` });

  describe('leaving a group shared with you (IAM-034, T-204)', () => {
    beforeAll(async () => {
      for (const name of ['hal', 'ivy']) await addUser(name);
    });

    it('[IAM-034] a person leaves a group shared with them, and only what that share gave goes', async () => {
      // Hal already works in ALPHA, given on its People page.
      expect((await give('ALPHA', 'Members', 'hal')).statusCode).toBe(204);
      const one = await makeGroup('owen', 'Leave one', ['ALPHA', 'BETA', 'DELTA']);
      expect((await share('owen', one, 'hal', 'Members')).json()).toEqual({
        tracks: 3,
        given: 2,
        alreadyHeld: 1,
        notGivable: 0,
      });
      expect(await rolesOf('hal')).toEqual(['ALPHA:Members', 'BETA:Members', 'DELTA:Members']);
      // What leaving would take: the roles this share alone gives.
      expect((await layout('hal')).find((g) => g.id === one)).toMatchObject({
        role: { id: roles.Members, name: 'Members' },
        holds: 2,
      });
      // Ivy runs DELTA too, and shares a group of hers with the same role there.
      expect((await give('DELTA', 'Administrators', 'ivy')).statusCode).toBe(204);
      const hers = await makeGroup('ivy', 'Ivy picks', ['DELTA']);
      expect((await share('ivy', hers, 'hal', 'Members')).statusCode).toBe(201);
      expect((await layout('hal')).find((g) => g.id === one)?.holds).toBe(1);
      expect((await layout('hal')).find((g) => g.id === hers)?.holds).toBe(0);

      const left = await leave('hal', one);
      expect(left.statusCode, left.body).toBe(200);
      // The answer is hal's arrangement, without the group.
      expect((left.json().groups as GroupView[]).map((g) => g.name)).toEqual(['Ivy picks']);
      // BETA went; ALPHA was hal's own, and Ivy's share still gives DELTA.
      expect(await rolesOf('hal')).toEqual(['ALPHA:Members', 'DELTA:Members']);
      const event = await lastEvent('track_group.left');
      expect(event.actor_id).toBe(ids.hal);
      expect(event.subject_id).toBe(String(one));
      expect(event.payload).toEqual({
        shareId: expect.any(Number),
        userId: ids.hal,
        ownerId: ids.owen,
        roleId: roles.Members,
        removed: [{ trackId: tracks.BETA, userId: ids.hal, roleId: roles.Members }],
      });
      // The owner sees it no longer shared with hal.
      expect((await layout('owen')).find((g) => g.id === one)?.sharedWith).toBe(0);
      const listed = await as('owen', {
        method: 'GET',
        url: `/api/v1/track-groups/${one}/shares`,
      });
      expect(listed.json().shares).toEqual([]);

      // Once is enough; one's own group is deleted, not left; a group never shared answers 404.
      expect((await leave('hal', one)).statusCode).toBe(404);
      expect((await leave('owen', one)).statusCode).toBe(403);
      expect((await leave('ivy', one)).statusCode).toBe(404);
      expect((await leave('hal', 999_999)).statusCode).toBe(404);

      // The owner's audit trail records who left and what went.
      await work();
      const audited = await database.db
        .selectFrom('audit_event')
        .select(['actor_id', 'subject_type', 'subject_id', 'details'])
        .where('action', '=', 'track_group.left')
        .execute();
      expect(audited).toContainEqual({
        actor_id: ids.hal,
        subject_type: 'track_group',
        subject_id: String(one),
        details: expect.objectContaining({
          ownerId: ids.owen,
          userId: ids.hal,
          removed: [{ trackId: tracks.BETA, userId: ids.hal, roleId: roles.Members }],
        }),
      });

      expect((await leave('hal', hers)).statusCode).toBe(200);
      expect(await rolesOf('hal')).toEqual(['ALPHA:Members']);
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${one}` });
      await as('ivy', { method: 'DELETE', url: `/api/v1/track-groups/${hers}` });
      await take('DELTA', 'Administrators', 'ivy');
    });

    it('[IAM-034] leaving never leaves a track with nobody to run it', async () => {
      const run = await makeGroup('owen', 'Run', ['BETA']);
      await share('owen', run, 'hal', 'Administrators');
      expect(await rolesOf('hal')).toContain('BETA:Administrators');
      // Owen steps down: hal, through the share, is the only one left to run BETA.
      expect((await take('BETA', 'Administrators', 'owen')).statusCode).toBe(204);
      const refused = await leave('hal', run);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: 'last_track_admin', trackIds: [tracks.BETA] });
      expect((await layout('hal')).map((g) => g.name)).toContain('Run');
      expect(await rolesOf('hal')).toContain('BETA:Administrators');
      // Once Owen runs it again, hal may go.
      expect((await give('BETA', 'Administrators', 'owen')).statusCode).toBe(204);
      expect((await leave('hal', run)).statusCode).toBe(200);
      expect(await rolesOf('hal')).not.toContain('BETA:Administrators');
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${run}` });
    });
  });

  describe('telling people a group was shared with them or set on them (IAM-034, T-206)', () => {
    const sent: OutgoingEmail[] = [];
    const transport: MailTransport = {
      send: async (email) => {
        sent.push(email);
        return { messageId: `<${sent.length}@test>` };
      },
    };
    const mail = () =>
      deliverEmail(database.db, new Authorizer(database.db), {
        transport,
        from: 'tracker@example.com',
        publicUrl: 'http://tracker.test',
        // Past the two-minute batch window; nobody here keeps quiet hours.
        now: new Date(Date.now() + 10 * 60 * 1000),
      });
    const told = (user: string) =>
      database.db
        .selectFrom('notification')
        .select(['channel', 'event', 'ticket_id', 'actor_id', 'payload'])
        .where('user_id', '=', ids[user] as number)
        .orderBy('id')
        .execute();
    const inbox = async (who: string) => {
      const res = await as(who, { method: 'GET', url: '/api/v1/inbox' });
      expect(res.statusCode, res.body).toBe(200);
      return res.json().items as {
        event: string;
        ticket: unknown;
        group?: { id: number; name: string; how: string; role: string | null };
        actor: { id: number; name: string } | null;
      }[];
    };

    beforeAll(async () => {
      for (const name of ['jo', 'kit']) await addUser(name);
      await work();
      await mail();
      sent.length = 0;
    });

    it('[IAM-034] the person hears of a share in their inbox and by email, naming the group and the sharer, never a track', async () => {
      const g = await makeGroup('owen', 'Quarterly', ['ALPHA', 'GAMMA']);
      expect((await share('owen', g, 'jo', 'Members')).statusCode).toBe(201);
      await work();
      const notes = await told('jo');
      expect(notes.map((n) => n.channel).sort()).toEqual(['email', 'inbox']);
      for (const n of notes) {
        expect(n).toMatchObject({
          event: 'track_group_shared',
          ticket_id: null,
          actor_id: ids.owen,
        });
        expect(n.payload).toEqual({
          type: 'track_group.shared',
          groupId: g,
          name: 'Quarterly',
          how: 'shared',
          role: 'Members',
        });
      }
      // Nobody else hears of it, the sharer included.
      expect(await told('owen')).toEqual([]);

      // The inbox shows it under the group's name now, and nothing of its tracks.
      await as('owen', {
        method: 'PATCH',
        url: `/api/v1/track-groups/${g}`,
        payload: { name: 'Quarter plan' },
      });
      const items = await inbox('jo');
      expect(items).toEqual([
        expect.objectContaining({
          event: 'track_group_shared',
          ticket: null,
          group: { id: g, name: 'Quarter plan', how: 'shared', role: 'Members' },
          actor: { id: ids.owen, name: 'owen' },
        }),
      ]);
      expect(JSON.stringify(items)).not.toMatch(/ALPHA|GAMMA|Alpha|Gamma/);
      // The inbox filters by it, as by any other kind of notification.
      const filtered = await as('jo', {
        method: 'GET',
        url: '/api/v1/inbox?event=track_group_shared',
      });
      expect(filtered.json().items).toHaveLength(1);

      // The email names the group and who shared it, and links to the Tracks page.
      const run = await mail();
      expect(run.sent).toBe(1);
      expect(sent).toHaveLength(1);
      const email = sent[0] as OutgoingEmail;
      expect(email.to).toBe('jo@example.com');
      expect(email.subject).toBe('owen shared the track group “Quarter plan” with you');
      expect(email.text).toContain(
        'owen shared the track group “Quarter plan” with you, with the role Members.',
      );
      expect(email.text).toContain('http://tracker.test/#/tracks');
      expect(`${email.text}${email.html}`).not.toMatch(/ALPHA|GAMMA|Alpha|Gamma/);
      sent.length = 0;
      await unshare('owen', g, 'jo');
      // Taken back: the item leaves the inbox.
      expect(await inbox('jo')).toEqual([]);
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
    });

    it('[IAM-034] setting a group on someone tells them too; their choices and a share taken back are kept', async () => {
      const g = await makeGroup('owen', 'Handover', ['BETA']);
      const copy = await as('owen', {
        method: 'POST',
        url: `/api/v1/track-groups/${g}/copies`,
        payload: { userId: ids.kit, roleId: null },
      });
      expect(copy.statusCode, copy.body).toBe(201);
      await work();
      expect((await inbox('kit'))[0]?.group).toEqual({
        id: copy.json().groupId,
        name: 'Handover',
        how: 'set',
        role: null,
      });
      await mail();
      expect(sent.map((e) => e.subject)).toEqual(['owen set the track group “Handover” on you']);
      sent.length = 0;

      // Kit turns email off for groups: the next share reaches the inbox only.
      const off = await as('kit', {
        method: 'PATCH',
        url: '/api/v1/account/notification-preferences',
        payload: { events: { track_group_shared: { email: false } } },
      });
      expect(off.statusCode, off.body).toBe(200);
      expect(off.json().preferences.events.track_group_shared).toEqual({
        email: false,
        inbox: true,
      });
      await share('owen', g, 'kit', null);
      await work();
      const channels = (await told('kit')).map((n) => n.channel);
      expect(channels.filter((c) => c === 'inbox')).toHaveLength(2);
      expect(channels.filter((c) => c === 'email')).toHaveLength(1);
      await unshare('owen', g, 'kit');

      // Jo hears of a share by email, but it is taken back before the email goes: none goes.
      await share('owen', g, 'jo', null);
      await work();
      await unshare('owen', g, 'jo');
      const run = await mail();
      expect(run.sent).toBe(0);
      expect(sent).toEqual([]);
      await as('owen', { method: 'DELETE', url: `/api/v1/track-groups/${g}` });
      await as('kit', { method: 'DELETE', url: `/api/v1/track-groups/${copy.json().groupId}` });
    });
  });

  describe('a person’s data download and erasure (IAM-008, IAM-034, T-205)', () => {
    let erase = 0;
    const files = mkdtempSync(join(tmpdir(), 'taskmoor-groups-privacy-'));
    afterAll(() => rmSync(files, { recursive: true, force: true }));

    const download = async (user: string, self: boolean) => {
      const dir = mkdtempSync(join(files, 'download-'));
      await writePersonalData(database.db, folderSink(dir), {
        workspaceId: 1,
        userId: ids[user] as number,
        self,
        stores: storesOf(await LocalStore.open(join(files, 'store'))),
        authorizer: new Authorizer(database.db),
      });
      return JSON.parse(readFileSync(join(dir, 'track-groups.json'), 'utf8'));
    };

    beforeAll(async () => {
      for (const name of ['kai', 'lou', 'mo']) await addUser(name);
      const policy = await database.db
        .selectFrom('access_policy')
        .select('id')
        .where('name', '=', 'Default access policy')
        .executeTakeFirstOrThrow();
      erase = (
        await database.db
          .insertInto('track')
          .values({ workspace_id: 1, key: 'ERASE', name: 'Erase', access_policy_id: policy.id })
          .returning('id')
          .executeTakeFirstOrThrow()
      ).id;
      tracks.ERASE = erase;
    });

    it('[IAM-008] the download holds the groups a person owns and those shared with them, tracks by key', async () => {
      // Kai works in ALPHA and runs ERASE; Owen shares BETA and GAMMA with Kai, giving on BETA.
      expect((await give('ALPHA', 'Members', 'kai')).statusCode).toBe(204);
      expect((await give('ERASE', 'Administrators', 'kai')).statusCode).toBe(204);
      const own = await makeGroup('kai', 'Kai picks', ['ALPHA', 'ERASE']);
      expect((await share('kai', own, 'lou', 'Administrators')).statusCode).toBe(201);
      expect(await rolesOf('lou')).toEqual(['ERASE:Administrators']);
      const theirs = await makeGroup('owen', 'For Kai', ['BETA', 'GAMMA']);
      expect((await share('owen', theirs, 'kai', 'Members')).statusCode).toBe(201);

      expect(await download('kai', true)).toEqual({
        groups: [
          {
            name: 'Kai picks',
            createdAt: expect.any(String),
            minimized: false,
            givenBy: null,
            tracks: ['ALPHA', 'ERASE'],
            sharedWith: [{ person: 'lou', role: 'Administrators', since: expect.any(String) }],
          },
        ],
        sharedWithMe: [
          {
            name: 'For Kai',
            owner: 'owen',
            role: 'Members',
            since: expect.any(String),
            minimized: false,
            // GAMMA is in the group, but Kai may not see it: left out, as on the page.
            tracks: ['BETA'],
            rolesGiven: [{ track: 'BETA', role: 'Members' }],
          },
        ],
      });
      // A site administrator's download has every track.
      expect((await download('kai', false)).sharedWithMe[0].tracks).toEqual(['BETA', 'GAMMA']);
      // Lou's lists the share Kai gave them; Mo has none.
      expect((await download('lou', true)).sharedWithMe).toEqual([
        expect.objectContaining({ name: 'Kai picks', owner: 'kai', role: 'Administrators' }),
      ]);
      expect(await download('mo', true)).toEqual({ groups: [], sharedWithMe: [] });
    });

    it('[IAM-008] erasure deletes the person’s groups and takes back the shares they gave and received, never the last one to run a track', async () => {
      const eraseKai = () =>
        as('admin', {
          method: 'POST',
          url: `/api/v1/users/${ids.kai}/erase`,
          payload: { confirmEmail: 'kai@example.com' },
        });
      // Erased, Kai runs nothing: Lou, through Kai's share, would be the last to run ERASE.
      const refused = await eraseKai();
      expect(refused.statusCode, refused.body).toBe(409);
      expect(refused.json()).toEqual({ error: 'last_track_admin', trackIds: [erase] });
      // Nothing changed.
      const kai = await database.db
        .selectFrom('app_user')
        .select(['erased_at', 'deactivated_at'])
        .where('id', '=', ids.kai as number)
        .executeTakeFirstOrThrow();
      expect(kai).toEqual({ erased_at: null, deactivated_at: null });
      expect(await rolesOf('lou')).toEqual(['ERASE:Administrators']);
      expect((await layout('lou')).map((g) => g.name)).toEqual(['Kai picks']);

      // Once Mo runs ERASE too, the erasure goes through.
      expect((await give('ERASE', 'Administrators', 'mo')).statusCode).toBe(204);
      const erased = await eraseKai();
      expect(erased.statusCode, erased.body).toBe(200);
      expect(erased.json().erased.removed).toMatchObject({ track_group: 1, track_group_share: 2 });
      // Kai's group is gone with the role its share gave Lou; the share Kai received is gone
      // with the role it gave, and Kai's own roles stay, as erasure keeps them.
      expect(await layout('lou')).toEqual([]);
      expect(await rolesOf('lou')).toEqual([]);
      expect(await rolesOf('kai')).toEqual(['ALPHA:Members', 'ERASE:Administrators']);
      const owens = await layout('owen');
      expect(owens.find((g) => g.name === 'For Kai')?.sharedWith).toBe(0);
      expect(
        await database.db
          .selectFrom('track_group')
          .select('id')
          .where('owner_id', '=', ids.kai as number)
          .execute(),
      ).toEqual([]);
      // The erasure's event lists the roles that went with the groups.
      expect((await lastEvent('user.erased')).payload).toMatchObject({
        groupAccess: expect.arrayContaining([
          { trackId: erase, userId: ids.lou, roleId: roles.Administrators },
          { trackId: tracks.BETA, userId: ids.kai, roleId: roles.Members },
        ]),
      });
      await as('owen', {
        method: 'DELETE',
        url: `/api/v1/track-groups/${owens.find((g) => g.name === 'For Kai')?.id}`,
      });
    });
  });
});
