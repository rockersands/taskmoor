import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { ARCHIVED_TRACK_PERMISSIONS } from '../authz/permissions';
import { FEATURE_DEFAULTS } from '../tracks/model';

const PASSWORD = 'ladder violet harbour';
let address = 0;
const nextAddress = () => `100.65.0.${++address}`;

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

interface TrackJson {
  id: number;
  key: string;
  name: string;
  description: string;
  type: string;
  mode: string;
  owner: { id: number; name: string } | null;
  category: { id: number; name: string } | null;
  icon: string | null;
  color: string | null;
  accessPolicyId: number;
  features: Record<string, boolean>;
  archived: boolean;
  archivedBy: { id: number; name: string } | null;
  previousKeys?: string[];
}

describe('tracks and track categories (M1-006)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let hash: string;
  const users: Record<string, { id: number; cookie: string }> = {};
  let defaultPolicy: number;
  let administrators: number;

  const as = (who: string | null, options: InjectOptions) =>
    app.inject({
      ...options,
      remoteAddress: nextAddress(),
      headers: { ...(options.headers ?? {}), cookie: (who && users[who]?.cookie) || '' },
    });
  const create = (who: string, payload: Record<string, unknown>) =>
    as(who, { method: 'POST', url: '/api/v1/tracks', payload });
  const get = (who: string | null, ref: string | number) =>
    as(who, { method: 'GET', url: `/api/v1/tracks/${ref}` });
  const patch = (who: string, trackId: number, payload: Record<string, unknown>) =>
    as(who, { method: 'PATCH', url: `/api/v1/tracks/${trackId}`, payload });
  const list = async (who: string | null, query = '') => {
    const res = await as(who, { method: 'GET', url: `/api/v1/tracks${query}` });
    return { res, keys: ((res.json().tracks ?? []) as TrackJson[]).map((t) => t.key) };
  };
  const track = (res: LightMyRequestResponse) => res.json().track as TrackJson;
  const myPermissions = async (who: string, trackId: number) =>
    (await as(who, { method: 'GET', url: `/api/v1/me/permissions?trackId=${trackId}` })).json() as {
      global: string[];
      track: string[];
    };

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
      ['alice', false],
      ['bob', false],
      ['stranger', false],
    ] as const) {
      await addUser(name, admin);
    }
    await database.db
      .insertInto('global_grant')
      .values({
        workspace_id: 1,
        permission: 'configuration_admin',
        grantee: 'user',
        user_id: users.config?.id as number,
      })
      .execute();
    defaultPolicy = (
      await database.db
        .selectFrom('access_policy')
        .select('id')
        .where('is_default', '=', true)
        .executeTakeFirstOrThrow()
    ).id;
    administrators = (
      await database.db
        .selectFrom('role')
        .select('id')
        .where('name', '=', 'Administrators')
        .executeTakeFirstOrThrow()
    ).id;
  });
  afterAll(async () => {
    await app.close();
  });

  async function roleActors(trackId: number) {
    return database.db
      .selectFrom('track_role_actor')
      .select(['role_id', 'user_id'])
      .where('track_id', '=', trackId)
      .execute();
  }

  it('[CORE-001] creates a shared track with key, name, owner, category, avatar and description', async () => {
    const category = await as('config', {
      method: 'POST',
      url: '/api/v1/track-categories',
      payload: { name: 'Finance' },
    });
    expect(category.statusCode).toBe(201);
    const res = await create('config', {
      key: 'pay',
      name: 'Payments',
      mode: 'shared',
      description: 'Money in and out',
      ownerId: users.alice?.id,
      categoryId: category.json().category.id,
      icon: 'credit-card',
      color: '#1F6FEB',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(track(res)).toMatchObject({
      key: 'PAY',
      name: 'Payments',
      description: 'Money in and out',
      type: 'software',
      mode: 'shared',
      owner: { id: users.alice?.id, name: 'alice' },
      category: { name: 'Finance' },
      icon: 'credit-card',
      color: '#1f6feb',
      accessPolicyId: defaultPolicy,
      features: FEATURE_DEFAULTS.software,
      archived: false,
    });
    // The creator joins the role that administers the track; the owner administers it too.
    expect(await roleActors(track(res).id)).toEqual([
      { role_id: administrators, user_id: users.config?.id },
    ]);
    expect((await myPermissions('alice', track(res).id)).track).toEqual([
      'administer_track',
      'browse_track',
    ]);
    expect((await myPermissions('config', track(res).id)).track).toContain('edit_tickets');
    const event = await database.db
      .selectFrom('domain_event')
      .select(['type', 'payload'])
      .where('type', '=', 'track.created')
      .where('subject_id', '=', String(track(res).id))
      .executeTakeFirstOrThrow();
    expect(event.payload).toMatchObject({
      key: 'PAY',
      mode: 'shared',
      accessPolicyId: defaultPolicy,
      administratorRoleId: administrators,
    });
  });

  it('[CORE-001] lets administrators create shared tracks and Create local-mode tracks holders local ones', async () => {
    expect((await create('alice', { key: 'NOPE', name: 'No', mode: 'shared' })).statusCode).toBe(
      403,
    );
    expect((await create('admin', { key: 'ADM', name: 'Admin', mode: 'shared' })).statusCode).toBe(
      201,
    );
    const local = await create('alice', { key: 'ALI', name: "Alice's", mode: 'local' });
    expect(local.statusCode, local.body).toBe(201);
    expect(track(local)).toMatchObject({ mode: 'local', owner: { id: users.alice?.id } });
    // Without the global permission nobody but administrators creates local-mode tracks.
    await database.db
      .deleteFrom('global_grant')
      .where('permission', '=', 'create_local_tracks')
      .execute();
    try {
      expect((await create('bob', { key: 'BOB', name: 'Bob', mode: 'local' })).statusCode).toBe(
        403,
      );
      expect((await create('admin', { key: 'ADML', name: 'Al', mode: 'local' })).statusCode).toBe(
        201,
      );
    } finally {
      await database.db
        .insertInto('global_grant')
        .values({ workspace_id: 1, permission: 'create_local_tracks', grantee: 'any_user' })
        .execute();
    }
    expect((await create('bob', { key: 'BOB', name: 'Bob', mode: 'local' })).statusCode).toBe(201);
    expect(
      (await as(null, { method: 'POST', url: '/api/v1/tracks', payload: {} })).statusCode,
    ).toBe(401);
    // The mode is required and fixed.
    expect((await create('admin', { key: 'NOMODE', name: 'x' })).statusCode).toBe(400);
  });

  it('[CORE-001] rejects invalid keys and keys already taken, ignoring case', async () => {
    for (const [key, problem] of [
      ['1AB', 'must_start_with_letter'],
      ['A', 'too_short'],
      ['ABCDEFGHIJK', 'too_long'],
      ['AB-1', 'invalid_character'],
      ['', 'empty'],
    ] as const) {
      const res = await create('admin', { key, name: 'Bad', mode: 'shared' });
      expect(res.statusCode, key).toBe(400);
      expect(res.json(), key).toEqual({ error: 'invalid_key', problem });
    }
    const taken = await create('admin', { key: 'Pay', name: 'Again', mode: 'shared' });
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'key_taken' });
    const local = await create('alice', { key: 'pay', name: 'Again', mode: 'local' });
    expect(local.statusCode).toBe(409);
    // A failed local-mode create leaves no policy behind.
    const policies = await database.db
      .selectFrom('access_policy')
      .select('name')
      .where('name', 'like', 'PAY local%')
      .execute();
    expect(policies).toEqual([]);
  });

  it('[CORE-001] lets one of two concurrent creates with the same key win', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        create(i % 2 ? 'admin' : 'alice', {
          key: i % 3 ? 'RACE' : 'race',
          name: `Race ${i}`,
          mode: i % 2 ? 'shared' : 'local',
        }),
      ),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes).toEqual([201, 409, 409, 409, 409, 409]);
    const rows = await database.db
      .selectFrom('track')
      .select('id')
      .where('key', '=', 'RACE')
      .execute();
    expect(rows).toHaveLength(1);
    // Exactly one local policy exists if the local create won, none otherwise.
    const winner = results.find((r) => r.statusCode === 201);
    const policies = await database.db
      .selectFrom('access_policy')
      .select('owner_track_id')
      .where('name', 'like', 'RACE local%')
      .execute();
    expect(policies.length).toBe(track(winner as LightMyRequestResponse).mode === 'local' ? 1 : 0);
  });

  it('[CORE-001] (2) keeps a renamed key resolving and never gives it to another track', async () => {
    const created = track(await create('admin', { key: 'ABC', name: 'Alphabet', mode: 'shared' }));
    const other = track(await create('admin', { key: 'OTHER', name: 'Other', mode: 'shared' }));
    const renamed = await patch('admin', created.id, { key: 'xyz' });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(track(renamed).key).toBe('XYZ');
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'track.updated')
      .where('subject_id', '=', String(created.id))
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();
    expect(event.payload).toEqual({ changes: { key: { from: 'ABC', to: 'XYZ' } } });

    // The old key answers with the track, its current key and a redirect.
    const old = await get('admin', 'abc');
    expect(old.statusCode).toBe(200);
    expect(old.json().redirect).toEqual({ from: 'ABC', to: 'XYZ' });
    expect(track(old)).toMatchObject({ id: created.id, key: 'XYZ', previousKeys: ['ABC'] });
    const current = await get('admin', 'Xyz');
    expect(current.json().redirect).toBeUndefined();
    expect(track(current).id).toBe(created.id);
    expect(track(await get('admin', created.id)).key).toBe('XYZ');

    // Nobody else gets the old key, by create or by rename.
    expect((await create('admin', { key: 'ABC', name: 'Thief', mode: 'shared' })).json()).toEqual({
      error: 'key_taken',
    });
    expect((await patch('admin', other.id, { key: 'abc' })).statusCode).toBe(409);
    expect((await patch('admin', other.id, { key: 'XYZ' })).statusCode).toBe(409);
    // The track itself may take its old key back; the key it leaves keeps resolving too.
    const back = await patch('admin', created.id, { key: 'ABC' });
    expect(back.statusCode, back.body).toBe(200);
    expect((await get('admin', 'XYZ')).json().redirect).toEqual({ from: 'XYZ', to: 'ABC' });
    expect(track(await get('admin', 'ABC')).previousKeys).toEqual(['XYZ']);
    expect((await get('admin', 'NOSUCH')).statusCode).toBe(404);
    expect((await get('admin', 'not-a-key')).statusCode).toBe(404);
    expect((await get('admin', '99999999999')).statusCode).toBe(404);
  });

  it('[CORE-001] shows a track only to people who may browse or administer it', async () => {
    const res = await create('config', { key: 'HIDE', name: 'Hidden', mode: 'shared' });
    const hidden = track(res);
    expect((await get('stranger', hidden.id)).statusCode).toBe(404);
    expect((await get('stranger', 'HIDE')).statusCode).toBe(404);
    expect((await get(null, 'HIDE')).statusCode).toBe(404);
    expect((await list('stranger')).keys).not.toContain('HIDE');
    expect((await list(null)).keys).toEqual([]);
    // Configuration administrators see every track; the creator browses through the role.
    expect((await list('config')).keys).toContain('HIDE');
    expect((await get('config', 'hide')).statusCode).toBe(200);
    // A Viewers actor browses it.
    const viewers = await database.db
      .selectFrom('role')
      .select('id')
      .where('name', '=', 'Viewers')
      .executeTakeFirstOrThrow();
    await as('config', {
      method: 'PUT',
      url: `/api/v1/tracks/${hidden.id}/roles/${viewers.id}/users/${users.stranger?.id}`,
    });
    expect((await get('stranger', 'HIDE')).statusCode).toBe(200);
    expect((await list('stranger')).keys).toContain('HIDE');
    // Viewing is not editing.
    expect((await patch('stranger', hidden.id, { name: 'Mine' })).statusCode).toBe(403);
  });

  it('[CORE-002] defaults the feature toggles from the type and lets a track admin change them', async () => {
    const res = await create('admin', {
      key: 'BIZ',
      name: 'Business',
      mode: 'shared',
      type: 'business',
      ownerId: users.bob?.id,
      features: { development: true },
    });
    const biz = track(res);
    expect(biz.features).toEqual({ ...FEATURE_DEFAULTS.business, development: true });
    // The owner administers the track (the default policy's grant to the track owner).
    const toggled = await patch('bob', biz.id, {
      features: { sprints: true, calendar: false },
      description: 'Now with sprints',
    });
    expect(toggled.statusCode, toggled.body).toBe(200);
    expect(track(toggled).features).toMatchObject({ sprints: true, calendar: false, board: true });
    expect((await patch('alice', biz.id, { features: { sprints: false } })).statusCode).toBe(404);
    expect((await patch('bob', biz.id, { features: { teleport: true } })).statusCode).toBe(400);
    // Changing nothing emits nothing.
    const before = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect((await patch('bob', biz.id, { features: { sprints: true } })).statusCode).toBe(200);
    const after = await database.db
      .selectFrom('domain_event')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(after.n).toBe(before.n);
    // Only configuration administration moves a track to another policy.
    const strict = await as('config', {
      method: 'POST',
      url: '/api/v1/access-policies',
      payload: { name: 'Strict', copyFrom: defaultPolicy },
    });
    const strictId = strict.json().policy.id as number;
    expect((await patch('bob', biz.id, { accessPolicyId: strictId })).statusCode).toBe(403);
    const moved = await patch('config', biz.id, { accessPolicyId: strictId });
    expect(moved.statusCode, moved.body).toBe(200);
    expect(track(moved).accessPolicyId).toBe(strictId);
    expect((await patch('config', biz.id, { mode: 'local' })).statusCode).toBe(400);
  });

  it('[CORE-003] gives a local-mode track its own copy of the default policy, so nothing leaks', async () => {
    const res = await create('alice', { key: 'LOC', name: 'Local', mode: 'local' });
    const loc = track(res);
    expect(loc.accessPolicyId).not.toBe(defaultPolicy);
    const policy = await database.db
      .selectFrom('access_policy')
      .selectAll()
      .where('id', '=', loc.accessPolicyId)
      .executeTakeFirstOrThrow();
    expect(policy).toMatchObject({ owner_track_id: loc.id, is_default: false });
    const grants = async (policyId: number) =>
      (
        await database.db
          .selectFrom('access_grant')
          .select(['permission', 'grantee', 'role_id', 'group_id', 'user_id', 'field_key'])
          .where('policy_id', '=', policyId)
          .orderBy('permission')
          .orderBy('grantee')
          .orderBy('role_id')
          .execute()
      ).map((g) => JSON.stringify(g));
    const defaults = await grants(defaultPolicy);
    expect(await grants(loc.accessPolicyId)).toEqual(defaults);
    expect(await roleActors(loc.id)).toEqual([
      { role_id: administrators, user_id: users.alice?.id },
    ]);

    // The track's administrator grants in its own policy; that reaches this track only.
    const pay = track(await get('admin', 'PAY'));
    const added = await as('alice', {
      method: 'POST',
      url: `/api/v1/access-policies/${loc.accessPolicyId}/grants`,
      payload: { permission: 'browse_track', grantee: 'user', userId: users.bob?.id },
    });
    expect(added.statusCode, added.body).toBe(201);
    expect((await myPermissions('bob', loc.id)).track).toEqual(['browse_track']);
    expect((await myPermissions('bob', pay.id)).track).toEqual([]);
    expect(await grants(defaultPolicy)).toEqual(defaults);
    // ... and cannot touch the shared policy or another track's.
    expect(
      (
        await as('alice', {
          method: 'POST',
          url: `/api/v1/access-policies/${defaultPolicy}/grants`,
          payload: { permission: 'browse_track', grantee: 'any_user' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (await as('bob', { method: 'GET', url: `/api/v1/access-policies/${loc.accessPolicyId}` }))
        .statusCode,
    ).toBe(403);
    // A change to the default policy no longer reaches the local track.
    await as('config', {
      method: 'POST',
      url: `/api/v1/access-policies/${defaultPolicy}/grants`,
      payload: { permission: 'browse_track', grantee: 'user', userId: users.stranger?.id },
    });
    expect((await myPermissions('stranger', pay.id)).track).toEqual(['browse_track']);
    expect((await myPermissions('stranger', loc.id)).track).toEqual([]);
    // No shared track may borrow the local policy, and the local track keeps its own.
    expect((await patch('config', pay.id, { accessPolicyId: loc.accessPolicyId })).statusCode).toBe(
      400,
    );
    expect(
      (
        await create('config', {
          key: 'BORROW',
          name: 'Borrow',
          mode: 'shared',
          accessPolicyId: loc.accessPolicyId,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await create('alice', { key: 'LOC3', name: 'x', mode: 'local', accessPolicyId: 1 }))
        .statusCode,
    ).toBe(400);
    expect((await patch('admin', loc.id, { accessPolicyId: defaultPolicy })).statusCode).toBe(400);
    const listed = await as('config', { method: 'GET', url: '/api/v1/access-policies' });
    expect(
      (listed.json().policies as { id: number; ownerTrackId: number | null }[]).find(
        (p) => p.id === loc.accessPolicyId,
      )?.ownerTrackId,
    ).toBe(loc.id);
  });

  it('[CORE-025] archives a track read-only, hides it from lists and search, and restores it', async () => {
    const res = await create('config', {
      key: 'OLD',
      name: 'Old project',
      mode: 'shared',
      ownerId: users.bob?.id,
    });
    const old = track(res);
    expect((await list('bob')).keys).toContain('OLD');
    expect(
      (await as('bob', { method: 'POST', url: `/api/v1/tracks/${old.id}/archive` })).statusCode,
    ).toBe(403);
    const archived = await as('config', {
      method: 'POST',
      url: `/api/v1/tracks/${old.id}/archive`,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(track(archived)).toMatchObject({
      archived: true,
      archivedBy: { id: users.config?.id, name: 'config' },
    });
    expect(
      (await as('admin', { method: 'POST', url: `/api/v1/tracks/${old.id}/archive` })).json(),
    ).toEqual({ error: 'already_archived' });

    // Hidden from lists for everyone; administrators can ask for the archive.
    expect((await list('bob')).keys).not.toContain('OLD');
    expect((await list('admin')).keys).not.toContain('OLD');
    expect((await list('bob', '?archived=include')).res.statusCode).toBe(403);
    expect((await list('admin', '?archived=include')).keys).toEqual(
      expect.arrayContaining(['OLD', 'PAY']),
    );
    expect((await list('config', '?archived=only')).keys).toEqual(['OLD']);
    // Read-only by link: the owner still opens it, holds only read permissions, changes nothing.
    const opened = await get('bob', 'old');
    expect(opened.statusCode).toBe(200);
    expect(track(opened).archived).toBe(true);
    expect((await myPermissions('bob', old.id)).track).toEqual(
      [...ARCHIVED_TRACK_PERMISSIONS].filter((p) => p === 'browse_track'),
    );
    expect((await myPermissions('admin', old.id)).track).toEqual(
      [...ARCHIVED_TRACK_PERMISSIONS].sort(),
    );
    for (const who of ['bob', 'admin']) {
      expect((await patch(who, old.id, { name: 'Renamed' })).json()).toEqual({
        error: 'track_archived',
      });
    }
    expect(
      (
        await as('admin', {
          method: 'PUT',
          url: `/api/v1/tracks/${old.id}/roles/${administrators}/users/${users.alice?.id}`,
        })
      ).statusCode,
    ).toBe(403);

    // Restore brings everything back.
    expect(
      (await as('bob', { method: 'POST', url: `/api/v1/tracks/${old.id}/restore` })).statusCode,
    ).toBe(403);
    const restored = await as('admin', { method: 'POST', url: `/api/v1/tracks/${old.id}/restore` });
    expect(restored.statusCode).toBe(200);
    expect(track(restored)).toMatchObject({ archived: false, archivedBy: null });
    expect(
      (await as('admin', { method: 'POST', url: `/api/v1/tracks/${old.id}/restore` })).json(),
    ).toEqual({ error: 'not_archived' });
    expect((await list('bob')).keys).toContain('OLD');
    expect((await myPermissions('bob', old.id)).track).toEqual([
      'administer_track',
      'browse_track',
    ]);
    expect((await patch('bob', old.id, { name: 'Renamed' })).statusCode).toBe(200);
    expect(
      (await as('admin', { method: 'POST', url: '/api/v1/tracks/999999/archive' })).statusCode,
    ).toBe(404);
  });

  it('[CORE-001] lists tracks with filters and pages by key', async () => {
    const all = (await list('admin', '?limit=500')).keys;
    expect(all).toEqual([...all].sort());
    const first = await list('admin', '?limit=2');
    expect(first.keys).toEqual(all.slice(0, 2));
    expect(first.res.json().next).toBe(all[1]);
    const second = await list('admin', `?limit=2&after=${all[1]}`);
    expect(second.keys).toEqual(all.slice(2, 4));
    expect((await list('admin', '?type=business')).keys).toEqual(['BIZ']);
    expect((await list('admin', '?mode=local')).keys).toEqual(
      expect.arrayContaining(['ALI', 'LOC']),
    );
    expect((await list('admin', '?q=alpha')).keys).toEqual(['ABC']);
    expect((await list('admin', '?q=%25')).keys).toEqual([]);
    expect((await list('admin', '?limit=0')).res.statusCode).toBe(400);
    expect((await list('admin', '?archived=maybe')).res.statusCode).toBe(400);
  });

  it('[CORE-001] lets configuration administrators manage track categories', async () => {
    const made = await as('config', {
      method: 'POST',
      url: '/api/v1/track-categories',
      payload: { name: 'Operations', description: 'Run the place' },
    });
    expect(made.statusCode).toBe(201);
    const categoryId = made.json().category.id as number;
    expect(
      (
        await as('admin', {
          method: 'POST',
          url: '/api/v1/track-categories',
          payload: { name: 'operations' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await as('alice', {
          method: 'POST',
          url: '/api/v1/track-categories',
          payload: { name: 'Mine' },
        })
      ).statusCode,
    ).toBe(403);
    const renamed = await as('config', {
      method: 'PATCH',
      url: `/api/v1/track-categories/${categoryId}`,
      payload: { name: 'Ops' },
    });
    expect(renamed.json().category).toMatchObject({ name: 'Ops', description: 'Run the place' });
    const ops = track(
      await create('config', { key: 'OPS', name: 'Ops', mode: 'shared', categoryId }),
    );
    expect(ops.category).toEqual({ id: categoryId, name: 'Ops' });
    expect((await list('admin', `?categoryId=${categoryId}`)).keys).toEqual(['OPS']);
    // Everyone signed in reads categories; only administrators see how many tracks use them.
    const forAlice = await as('alice', { method: 'GET', url: '/api/v1/track-categories' });
    const forConfig = await as('config', { method: 'GET', url: '/api/v1/track-categories' });
    expect(forAlice.json().categories).toContainEqual({
      id: categoryId,
      name: 'Ops',
      description: 'Run the place',
    });
    expect(forConfig.json().categories).toContainEqual(
      expect.objectContaining({ id: categoryId, trackCount: 1 }),
    );
    expect((await as(null, { method: 'GET', url: '/api/v1/track-categories' })).statusCode).toBe(
      401,
    );
    expect((await patch('config', ops.id, { categoryId: 999_999 })).statusCode).toBe(400);
    // Deleting a category leaves its tracks without one.
    const deleted = await as('config', {
      method: 'DELETE',
      url: `/api/v1/track-categories/${categoryId}`,
    });
    expect(deleted.statusCode).toBe(204);
    expect(track(await get('config', ops.id)).category).toBeNull();
    const event = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'track_category.deleted')
      .where('subject_id', '=', String(categoryId))
      .executeTakeFirstOrThrow();
    expect(event.payload).toEqual({ name: 'Ops', trackCount: 1 });
    expect(
      (await as('config', { method: 'DELETE', url: `/api/v1/track-categories/${categoryId}` }))
        .statusCode,
    ).toBe(404);
  });
});
