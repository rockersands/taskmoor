import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * The SCIM compliance suite (M1-083 done-when; IAM-006; RFC 7643 and 7644 restated in our own
 * words): what any SCIM client may rely on, over HTTP. `scim.idp.test.ts` replays the request
 * shapes of specific identity providers.
 */
const PASSWORD = 'ladder violet harbour';
const USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
const ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
const GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
const ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
const LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
const BASE = 'https://tracker.example/api/v1/scim/v2';

let address = 0;
const nextAddress = () => `100.68.${Math.floor(++address / 250)}.${(address % 250) + 1}`;

function sessionCookie(res: LightMyRequestResponse): string {
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

interface ScimUser {
  id: string;
  userName: string;
  displayName: string;
  active: boolean;
  emails: { value: string; type?: string; primary?: boolean }[];
  groups?: { value: string; display: string }[];
  meta: { resourceType: string; location: string; created: string; lastModified: string };
  schemas: string[];
  [key: string]: unknown;
}

describe('SCIM 2.0 service (M1-083)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let adminCookie = '';
  const ids: Record<string, number> = {};
  const tokens: Record<string, string> = {};

  const scim = (
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: unknown,
    token = tokens.scim,
  ) =>
    app.inject({
      method,
      url: `/api/v1/scim/v2${path}`,
      remoteAddress: nextAddress(),
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}),
      },
      ...(body !== undefined
        ? { payload: typeof body === 'string' ? body : JSON.stringify(body) }
        : {}),
    });
  const admin = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: object) =>
    app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: { cookie: adminCookie },
      ...(payload ? { payload } : {}),
    });
  const error = (res: LightMyRequestResponse) => {
    const body = res.json();
    expect(body.schemas).toEqual([ERROR]);
    expect(body.status).toBe(String(res.statusCode));
    return { status: res.statusCode, scimType: body.scimType as string | undefined };
  };
  const createUser = async (body: Record<string, unknown>) => {
    const res = await scim('POST', '/Users', { schemas: [USER], ...body });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as ScimUser;
  };
  const lastEvent = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['subject_id', 'payload', 'actor_id'])
      .where('type', '=', type)
      .orderBy('id', 'desc')
      .executeTakeFirstOrThrow();

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      publicUrl: 'https://tracker.example/',
    });
    const hash = await hashPassword(PASSWORD);
    for (const [name, siteAdmin, breakGlass] of [
      ['admin', true, false],
      ['local', false, false],
      ['rescue', false, true],
    ] as const) {
      const row = await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: siteAdmin,
          break_glass: breakGlass,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      ids[name] = row.id;
    }
    const signIn = async (email: string) =>
      sessionCookie(
        await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email, password: PASSWORD },
          remoteAddress: nextAddress(),
        }),
      );
    adminCookie = await signIn('admin@example.com');
    // A provisioning account with a scim token, and another account with an ordinary token.
    for (const [name, scopes] of [
      ['scim', ['scim']],
      ['plain', ['read', 'write', 'admin']],
    ] as const) {
      const account = await admin('POST', '/api/v1/service-accounts', { name: `${name} robot` });
      ids[`${name}Robot`] = account.json().serviceAccount.id;
      const issued = await admin('POST', `/api/v1/service-accounts/${ids[`${name}Robot`]}/tokens`, {
        name,
        scopes,
        expiresInDays: 30,
      });
      expect(issued.statusCode, issued.body).toBe(201);
      tokens[name] = issued.json().token;
    }
    const group = await admin('POST', '/api/v1/groups', { name: 'Site operators' });
    ids.localGroup = group.json().group.id;
  });
  afterAll(async () => {
    await app.close();
  });

  describe('access', () => {
    it('[IAM-006] lets in only a service account token with the scim scope', async () => {
      for (const res of [
        await scim('GET', '/Users', undefined, ''),
        await app.inject({
          method: 'GET',
          url: '/api/v1/scim/v2/Users',
          headers: { cookie: adminCookie },
        }),
      ]) {
        expect(res.statusCode).toBe(401);
        expect(res.headers['content-type']).toBe('application/scim+json; charset=utf-8');
        expect(error(res).status).toBe(401);
      }
      const plain = await scim('GET', '/Users', undefined, tokens.plain);
      expect(plain.statusCode).toBe(403);
      expect(plain.json()).toEqual({ error: 'insufficient_scope', requiredScope: 'scim' });
      // The scim token reaches nothing else.
      for (const url of ['/api/v1/tracks', '/api/v1/users', '/api/v1/session']) {
        const res = await app.inject({
          method: 'GET',
          url,
          headers: { authorization: `Bearer ${tokens.scim}` },
          remoteAddress: nextAddress(),
        });
        expect(res.statusCode, url).toBe(403);
      }
    });

    it('[IAM-007] gives the scim scope only to service accounts, and alone', async () => {
      const own = await admin('POST', '/api/v1/account/tokens', {
        name: 'Mine',
        scopes: ['scim'],
        expiresInDays: 30,
      });
      expect(own.json()).toEqual({ error: 'scope_not_allowed' });
      const mixed = await admin('POST', `/api/v1/service-accounts/${ids.scimRobot}/tokens`, {
        name: 'Mixed',
        scopes: ['scim', 'read'],
        expiresInDays: 30,
      });
      expect(mixed.statusCode).toBe(400);
    });
  });

  describe('discovery', () => {
    it('[IAM-006] describes what the service supports, its resource types and its schemas', async () => {
      const config = (await scim('GET', '/ServiceProviderConfig')).json();
      expect(config).toMatchObject({
        patch: { supported: true },
        filter: { supported: true, maxResults: 200 },
        bulk: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        changePassword: { supported: false },
        authenticationSchemes: [{ type: 'oauthbearertoken' }],
        meta: { location: `${BASE}/ServiceProviderConfig` },
      });
      const types = (await scim('GET', '/ResourceTypes')).json();
      expect(types).toMatchObject({ schemas: [LIST], totalResults: 2 });
      expect(types.Resources.map((t: { endpoint: string }) => t.endpoint)).toEqual([
        '/Users',
        '/Groups',
      ]);
      expect((await scim('GET', '/ResourceTypes/User')).json()).toMatchObject({
        schema: USER,
        schemaExtensions: [{ schema: ENTERPRISE, required: false }],
      });
      const schemas = (await scim('GET', '/Schemas')).json();
      expect(schemas.Resources.map((s: { id: string }) => s.id)).toEqual([USER, ENTERPRISE, GROUP]);
      const userSchema = (await scim('GET', `/Schemas/${USER}`)).json();
      expect(
        userSchema.attributes.find((a: { name: string }) => a.name === 'userName'),
      ).toMatchObject({
        required: true,
        uniqueness: 'server',
      });
      expect(error(await scim('GET', '/Schemas/urn:nothing')).status).toBe(404);
      expect(error(await scim('GET', '/Nothing')).status).toBe(404);
    });
  });

  describe('users', () => {
    it('[IAM-006] lists the people of the workspace, never service accounts, page by page', async () => {
      const all = (await scim('GET', '/Users')).json();
      expect(all.schemas).toEqual([LIST]);
      const names = all.Resources.map((u: ScimUser) => u.userName).sort();
      expect(names).toEqual(['admin@example.com', 'local@example.com', 'rescue@example.com']);
      expect(all).toMatchObject({ totalResults: 3, startIndex: 1, itemsPerPage: 3 });
      const page = (await scim('GET', '/Users?startIndex=2&count=1')).json();
      expect(page).toMatchObject({ totalResults: 3, startIndex: 2, itemsPerPage: 1 });
      expect(page.Resources[0].userName).toBe('local@example.com');
      const none = (await scim('GET', '/Users?count=0')).json();
      expect(none).toMatchObject({ totalResults: 3, itemsPerPage: 0, Resources: [] });
      // Out-of-range paging reads as the nearest allowed value.
      expect((await scim('GET', '/Users?startIndex=-4&count=9999')).json().startIndex).toBe(1);
      expect(error(await scim('GET', '/Users?count=many'))).toMatchObject({
        status: 400,
        scimType: 'invalidValue',
      });
    });

    it('[IAM-006] provisions a person who signs in through single sign-on, with every attribute kept', async () => {
      const res = await scim('POST', '/Users', {
        schemas: [USER, ENTERPRISE],
        externalId: 'aad-0001',
        userName: 'Grace.Hopper@Example.com',
        name: { givenName: 'Grace', familyName: 'Hopper', honorificPrefix: 'Rear Admiral' },
        title: 'Computer scientist',
        active: true,
        password: 'never stored',
        emails: [{ value: 'grace.hopper@example.com', type: 'work', primary: true }],
        phoneNumbers: [{ value: '+1 555 0101', type: 'work' }],
        locale: 'en-US',
        timezone: 'america/new_york',
        [ENTERPRISE]: {
          employeeNumber: '1906',
          department: 'Navy',
          manager: { value: String(ids.admin) },
        },
        unknownAttribute: 'ignored',
      });
      expect(res.statusCode, res.body).toBe(201);
      const grace = res.json() as ScimUser;
      ids.grace = Number(grace.id);
      expect(res.headers.location).toBe(`${BASE}/Users/${grace.id}`);
      expect(res.headers['content-type']).toBe('application/scim+json; charset=utf-8');
      expect(grace).toMatchObject({
        schemas: [USER, ENTERPRISE],
        externalId: 'aad-0001',
        userName: 'Grace.Hopper@Example.com',
        displayName: 'Grace Hopper',
        title: 'Computer scientist',
        active: true,
        locale: 'en-US',
        timezone: 'America/New_York',
        emails: [{ value: 'grace.hopper@example.com', type: 'work', primary: true }],
        [ENTERPRISE]: {
          employeeNumber: '1906',
          department: 'Navy',
          manager: { value: String(ids.admin) },
        },
        meta: { resourceType: 'User', location: `${BASE}/Users/${grace.id}` },
      });
      expect(grace.password).toBeUndefined();
      expect(grace.unknownAttribute).toBeUndefined();
      const account = await database.db
        .selectFrom('app_user')
        .select(['email', 'name', 'password_hash', 'time_zone', 'kind'])
        .where('id', '=', ids.grace)
        .executeTakeFirstOrThrow();
      expect(account).toEqual({
        email: 'grace.hopper@example.com',
        name: 'Grace Hopper',
        password_hash: null,
        time_zone: 'America/New_York',
        kind: 'person',
      });
      expect(await lastEvent('scim.user_created')).toMatchObject({
        subject_id: grace.id,
        actor_id: ids.scimRobot,
        payload: { userName: 'Grace.Hopper@Example.com', revived: false },
      });
      expect((await scim('GET', `/Users/${grace.id}`)).json()).toEqual(grace);
    });

    it('[IAM-006] keeps userName and email unique and says which rule a body breaks', async () => {
      expect(
        error(
          await scim('POST', '/Users', { schemas: [USER], userName: 'grace.hopper@EXAMPLE.com' }),
        ),
      ).toEqual({
        status: 409,
        scimType: 'uniqueness',
      });
      // The local person's email is their userName until a provider sets another.
      expect(
        error(await scim('POST', '/Users', { schemas: [USER], userName: 'local@example.com' }))
          .scimType,
      ).toBe('uniqueness');
      expect(
        error(
          await scim('POST', '/Users', {
            schemas: [USER],
            userName: 'someone',
            emails: [{ value: 'local@example.com' }],
          }),
        ).scimType,
      ).toBe('uniqueness');
      for (const body of [
        { schemas: [USER] },
        { schemas: [USER], userName: 'no-address' },
        { schemas: ['urn:example:other'], userName: 'x@example.com' },
        { schemas: [USER], userName: 'x@example.com', active: 'sometimes' },
        { schemas: [USER], userName: 'x@example.com', timezone: 'Mars/Olympus' },
      ]) {
        expect(error(await scim('POST', '/Users', body)), JSON.stringify(body)).toEqual({
          status: 400,
          scimType: 'invalidValue',
        });
      }
      expect(error(await scim('POST', '/Users', '{"userName": '))).toEqual({
        status: 400,
        scimType: 'invalidSyntax',
      });
      expect(error(await scim('POST', '/Users', '[1, 2]')).scimType).toBe('invalidSyntax');
    });

    it('[IAM-006] finds people by filter and returns only the attributes asked for', async () => {
      const byName = (
        await scim('GET', '/Users?filter=userName%20eq%20%22grace.hopper%40example.com%22')
      ).json();
      expect(byName.totalResults).toBe(1);
      expect(byName.Resources[0].id).toBe(String(ids.grace));
      const byWork = (
        await scim(
          'GET',
          `/Users?filter=${encodeURIComponent('emails[type eq "work"].value co "hopper"')}`,
        )
      ).json();
      expect(byWork.Resources.map((u: ScimUser) => u.id)).toEqual([String(ids.grace)]);
      const byExternal = (
        await scim('GET', '/Users?filter=externalId%20eq%20%22aad-0001%22')
      ).json();
      expect(byExternal.totalResults).toBe(1);
      const none = (await scim('GET', '/Users?filter=externalId%20eq%20%22AAD-0001%22')).json();
      expect(none.totalResults).toBe(0);
      const local = (
        await scim(
          'GET',
          `/Users?filter=${encodeURIComponent('userName eq "LOCAL@example.com" and active eq true')}`,
        )
      ).json();
      expect(local.Resources[0].id).toBe(String(ids.local));
      expect(error(await scim('GET', '/Users?filter=userName%20is%20%22x%22'))).toEqual({
        status: 400,
        scimType: 'invalidFilter',
      });
      const slim = (
        await scim('GET', `/Users/${ids.grace}?attributes=userName,name.givenName`)
      ).json();
      expect(slim).toEqual({
        schemas: [USER, ENTERPRISE],
        id: String(ids.grace),
        userName: 'Grace.Hopper@Example.com',
        name: { givenName: 'Grace' },
      });
      const lean = (
        await scim('GET', `/Users/${ids.grace}?excludedAttributes=emails,${ENTERPRISE}:department`)
      ).json();
      expect(lean.emails).toBeUndefined();
      expect(lean[ENTERPRISE]).toEqual({
        employeeNumber: '1906',
        manager: { value: String(ids.admin) },
      });
      expect(lean.id).toBe(String(ids.grace));
    });

    it('[IAM-006] replaces a person with PUT and changes parts with PATCH', async () => {
      const put = await scim('PUT', `/Users/${ids.grace}`, {
        schemas: [USER],
        id: 'ignored',
        userName: 'grace@example.com',
        displayName: 'Amazing Grace',
        emails: [{ value: 'grace@example.com', type: 'work', primary: true }],
      });
      expect(put.statusCode, put.body).toBe(200);
      const replaced = put.json() as ScimUser;
      // Attributes the body left out are gone; id stays.
      expect(replaced).toMatchObject({
        id: String(ids.grace),
        userName: 'grace@example.com',
        displayName: 'Amazing Grace',
      });
      expect(replaced.title).toBeUndefined();
      expect(replaced[ENTERPRISE]).toBeUndefined();
      expect(replaced.externalId).toBeUndefined();
      expect(await lastEvent('scim.user_updated')).toMatchObject({
        payload: {
          changes: {
            userName: { from: 'Grace.Hopper@Example.com', to: 'grace@example.com' },
            email: { from: 'grace.hopper@example.com', to: 'grace@example.com' },
            name: { from: 'Grace Hopper', to: 'Amazing Grace' },
          },
        },
      });
      const patched = await scim('PATCH', `/Users/${ids.grace}`, {
        schemas: [PATCH_OP],
        Operations: [
          { op: 'Add', path: 'title', value: 'Admiral' },
          { op: 'Replace', path: 'name.familyName', value: 'Hopper' },
        ],
      });
      expect(patched.statusCode, patched.body).toBe(200);
      expect(patched.json()).toMatchObject({ title: 'Admiral', name: { familyName: 'Hopper' } });
      // Unchanged values change nothing: no event.
      const before = await lastEvent('scim.user_updated');
      await scim('PATCH', `/Users/${ids.grace}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: 'replace', path: 'title', value: 'Admiral' }],
      });
      expect((await lastEvent('scim.user_updated')).subject_id).toBe(before.subject_id);
      expect(
        error(await scim('PATCH', `/Users/${ids.grace}`, { schemas: [PATCH_OP], Operations: [] }))
          .scimType,
      ).toBe('invalidSyntax');
      expect(
        error(
          await scim('PATCH', `/Users/${ids.grace}`, {
            schemas: [PATCH_OP],
            Operations: [{ op: 'move' }],
          }),
        ).scimType,
      ).toBe('invalidSyntax');
      expect(error(await scim('GET', '/Users/999999')).status).toBe(404);
      expect(error(await scim('GET', '/Users/not-a-number')).status).toBe(404);
    });

    it('[IAM-006] deactivates with active false, ending sessions, and brings the person back with true', async () => {
      const cookie = sessionCookie(
        await app.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'local@example.com', password: PASSWORD },
          remoteAddress: nextAddress(),
        }),
      );
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } }))
          .statusCode,
      ).toBe(200);
      const off = await scim('PATCH', `/Users/${ids.local}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: 'replace', value: { active: false } }],
      });
      expect(off.json().active).toBe(false);
      expect(
        (await app.inject({ method: 'GET', url: '/api/v1/session', headers: { cookie } }))
          .statusCode,
      ).toBe(401);
      expect(await lastEvent('scim.user_updated')).toMatchObject({
        subject_id: String(ids.local),
        payload: { changes: { active: { from: true, to: false } }, endedSessions: 1 },
      });
      const on = await scim('PATCH', `/Users/${ids.local}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: 'replace', path: 'active', value: 'True' }],
      });
      expect(on.json().active).toBe(true);
    });

    it('[IAM-006] deprovisions with DELETE: the account stays, deactivated, keeping its work', async () => {
      const ada = await createUser({ userName: 'ada@example.com' });
      const track = await admin('POST', '/api/v1/tracks', {
        key: 'ADA',
        name: 'Engines',
        mode: 'shared',
        ownerId: Number(ada.id),
      });
      expect(track.statusCode, track.body).toBe(201);
      expect((await scim('DELETE', `/Users/${ada.id}`)).statusCode).toBe(204);
      expect(error(await scim('GET', `/Users/${ada.id}`)).status).toBe(404);
      expect(error(await scim('DELETE', `/Users/${ada.id}`)).status).toBe(404);
      const account = await database.db
        .selectFrom('app_user')
        .select(['deactivated_at'])
        .where('id', '=', Number(ada.id))
        .executeTakeFirstOrThrow();
      expect(account.deactivated_at).not.toBeNull();
      expect((await admin('GET', '/api/v1/tracks/ADA')).json().track.owner).toEqual({
        id: Number(ada.id),
        name: 'ada@example.com',
      });
      // Provisioning the address again brings the same account back.
      const back = await createUser({
        userName: 'ada.lovelace',
        emails: [{ value: 'ADA@example.com', primary: true }],
      });
      expect(back).toMatchObject({ id: ada.id, userName: 'ada.lovelace', active: true });
      expect((await lastEvent('scim.user_created')).payload).toMatchObject({ revived: true });
    });

    it('[IAM-006] never deactivates a break-glass account or the last active site administrator', async () => {
      for (const id of [ids.rescue, ids.admin]) {
        expect(
          error(
            await scim('PATCH', `/Users/${id}`, {
              schemas: [PATCH_OP],
              Operations: [{ op: 'replace', path: 'active', value: false }],
            }),
          ),
        ).toEqual({ status: 400, scimType: 'mutability' });
        expect(error(await scim('DELETE', `/Users/${id}`)).scimType).toBe('mutability');
      }
      // Other changes to them are fine.
      const renamed = await scim('PATCH', `/Users/${ids.rescue}`, {
        schemas: [PATCH_OP],
        Operations: [{ op: 'add', path: 'title', value: 'Break glass' }],
      });
      expect(renamed.statusCode).toBe(200);
    });
  });

  describe('groups', () => {
    it('[IAM-006] keeps groups made in Taskmoor out of reach', async () => {
      const list = (await scim('GET', '/Groups')).json();
      expect(list).toMatchObject({ schemas: [LIST], totalResults: 0, Resources: [] });
      expect(error(await scim('GET', `/Groups/${ids.localGroup}`)).status).toBe(404);
      expect(
        error(await scim('POST', '/Groups', { schemas: [GROUP], displayName: 'site OPERATORS' })),
      ).toEqual({
        status: 409,
        scimType: 'uniqueness',
      });
    });

    it('[IAM-006] creates, changes and deletes groups with their members', async () => {
      const res = await scim('POST', '/Groups', {
        schemas: [GROUP],
        externalId: 'g-1',
        displayName: 'Navy',
        members: [{ value: String(ids.grace) }, { value: String(ids.local) }],
      });
      expect(res.statusCode, res.body).toBe(201);
      const group = res.json();
      ids.navy = Number(group.id);
      expect(res.headers.location).toBe(`${BASE}/Groups/${group.id}`);
      expect(group).toMatchObject({
        schemas: [GROUP],
        externalId: 'g-1',
        displayName: 'Navy',
        // In the order of the people's ids, whatever order the request listed them in.
        members: [
          { value: String(ids.local), display: 'local', type: 'User' },
          {
            value: String(ids.grace),
            display: 'Amazing Grace',
            type: 'User',
            $ref: `${BASE}/Users/${ids.grace}`,
          },
        ],
        meta: { resourceType: 'Group' },
      });
      // People show the groups they are in.
      expect(((await scim('GET', `/Users/${ids.grace}`)).json() as ScimUser).groups).toEqual([
        {
          value: String(ids.navy),
          $ref: `${BASE}/Groups/${ids.navy}`,
          display: 'Navy',
          type: 'direct',
        },
      ]);
      // A member the provider does not know stays when it replaces the members.
      await database.db
        .insertInto('group_member')
        .values({ workspace_id: 1, group_id: ids.navy, user_id: ids.plainRobot as number })
        .execute();
      const put = await scim('PUT', `/Groups/${ids.navy}`, {
        schemas: [GROUP],
        displayName: 'US Navy',
        members: [{ value: String(ids.grace) }],
      });
      expect(put.json().members.map((m: { value: string }) => m.value)).toEqual([
        String(ids.grace),
      ]);
      const members = await database.db
        .selectFrom('group_member')
        .select('user_id')
        .where('group_id', '=', ids.navy)
        .orderBy('user_id')
        .execute();
      expect(members.map((m) => m.user_id)).toEqual(
        [ids.grace, ids.plainRobot].sort((a, b) => (a ?? 0) - (b ?? 0)),
      );
      expect(await lastEvent('scim.group_updated')).toMatchObject({
        payload: {
          changes: { name: { from: 'Navy', to: 'US Navy' }, externalId: { from: 'g-1', to: null } },
          added: [],
          removed: [ids.local],
        },
      });
      const patched = await scim('PATCH', `/Groups/${ids.navy}`, {
        schemas: [PATCH_OP],
        Operations: [
          { op: 'add', path: 'members', value: [{ value: String(ids.local) }] },
          { op: 'remove', path: `members[value eq "${ids.grace}"]` },
        ],
      });
      expect(patched.json().members.map((m: { value: string }) => m.value)).toEqual([
        String(ids.local),
      ]);
      expect(
        error(
          await scim('PATCH', `/Groups/${ids.navy}`, {
            schemas: [PATCH_OP],
            Operations: [{ op: 'add', path: 'members', value: [{ value: '999999' }] }],
          }),
        ),
      ).toEqual({ status: 400, scimType: 'invalidValue' });
      const byName = (
        await scim(
          'GET',
          '/Groups?filter=displayName%20eq%20%22us%20navy%22&excludedAttributes=members',
        )
      ).json();
      expect(byName).toMatchObject({
        totalResults: 1,
        Resources: [{ id: String(ids.navy), displayName: 'US Navy' }],
      });
      expect(byName.Resources[0].members).toBeUndefined();
      const byMember = (
        await scim(
          'GET',
          `/Groups?filter=${encodeURIComponent(`members[value eq "${ids.local}"]`)}`,
        )
      ).json();
      expect(byMember.totalResults).toBe(1);
      expect((await scim('DELETE', `/Groups/${ids.navy}`)).statusCode).toBe(204);
      expect(error(await scim('GET', `/Groups/${ids.navy}`)).status).toBe(404);
      const gone = await database.db
        .selectFrom('user_group')
        .select('id')
        .where('id', '=', ids.navy)
        .execute();
      expect(gone).toEqual([]);
    });
  });
});
