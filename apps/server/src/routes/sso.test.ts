import { useMigratedDatabase } from '@taskmoor/db/testing';
import { openSecret, passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { FakeIdp } from '../testing/fake-idp';

const PASSWORD = 'ladder violet harbour';
const ORIGIN = 'http://tracker.test';
const CLIENT_SECRET = 'a client secret only the fake provider knows';
const peppers = pepperRing(pepperFromSecret('a pepper for single sign-on tests, long enough'));
let address = 0;
const nextAddress = () => `198.51.100.${++address}`;

function cookieNamed(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (list.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? '').split(
      ';',
    )[0] ?? ''
  );
}

describe('single sign-on with OpenID Connect (M1-080)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  const idp = new FakeIdp('taskmoor', CLIENT_SECRET);
  let app: FastifyInstance;
  let adminCookie: string;

  const call = (cookie: string | undefined, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });

  async function addUser(email: string, extra: { admin?: boolean; breakGlass?: boolean } = {}) {
    const row = await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email,
        name: email.split('@')[0] ?? email,
        password_hash: await passwords.hash(PASSWORD),
        is_site_admin: extra.admin ?? false,
        break_glass: extra.breakGlass ?? false,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  const passwordSignIn = (email: string, password = PASSWORD) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress: nextAddress(),
    });

  async function addGroup(name: string) {
    const row = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  }

  async function createProvider(body: Record<string, unknown>) {
    const res = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: { issuer: idp.issuer, clientId: 'taskmoor', clientSecret: CLIENT_SECRET, ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().provider as { id: number };
  }

  /**
   * Runs a whole sign-in as a browser would: start here, the provider's authorize endpoint
   * (over real HTTP), then back to the callback with the cookie the start set.
   */
  async function ssoSignIn(
    providerId: number,
    options: { returnTo?: string; browserCookie?: (real: string) => string } = {},
  ) {
    const query = options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : '';
    const start = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/oidc/${providerId}/start${query}`,
    });
    expect(start.statusCode).toBe(302);
    const location = String(start.headers.location);
    if (!location.startsWith(idp.issuer)) return { start, location, session: '', callback: start };
    const browser = cookieNamed(start, 'taskmoor_oidc');
    const authorize = await fetch(location, { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(`${ORIGIN}/api/v1/auth/oidc/callback`);
    const callback = await call(undefined, {
      method: 'GET',
      url: `${back.pathname}${back.search}`,
      headers: { cookie: options.browserCookie ? options.browserCookie(browser) : browser },
    });
    expect(callback.statusCode).toBe(302);
    return {
      start,
      callback,
      callbackUrl: `${back.pathname}${back.search}`,
      browser,
      location: String(callback.headers.location),
      session: cookieNamed(callback, SESSION_COOKIE),
    };
  }

  const lastEvent = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['payload', 'subject_id', 'actor_id'])
      .where('type', '=', type as never)
      .orderBy('id', 'desc')
      .executeTakeFirst();

  beforeAll(async () => {
    await idp.start();
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
      publicUrl: ORIGIN,
    });
    await addUser('admin@example.com', { admin: true });
    const res = await passwordSignIn('admin@example.com');
    adminCookie = cookieNamed(res, SESSION_COOKIE);
  });

  afterAll(async () => {
    await app.close();
    await idp.stop();
  });

  it('[IAM-003] administrators configure providers; the client secret is sealed and never returned', async () => {
    await addUser('someone@example.com');
    const someone = cookieNamed(await passwordSignIn('someone@example.com'), SESSION_COOKIE);
    const forbidden = await call(someone, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: { name: 'Nope', issuer: idp.issuer, clientId: 'x' },
    });
    expect(forbidden.statusCode).toBe(403);

    const reserved = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: { name: 'Robots', issuer: idp.issuer, clientId: 'x', domains: ['service.invalid'] },
    });
    expect(reserved.statusCode).toBe(400);

    const insecure = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: { name: 'Plain', issuer: 'http://idp.example.org', clientId: 'x' },
    });
    expect(insecure.json()).toMatchObject({ error: 'insecure_issuer' });

    const provider = await createProvider({ name: 'Corporate', domains: ['corp.example'] });
    const listed = await call(adminCookie, { method: 'GET', url: '/api/v1/identity-providers' });
    const view = listed.json().providers.find((p: { id: number }) => p.id === provider.id);
    expect(view).toMatchObject({
      name: 'Corporate',
      clientId: 'taskmoor',
      hasClientSecret: true,
      scopes: 'openid email profile',
      domains: ['corp.example'],
      enforceSso: false,
      jit: true,
      enabled: true,
    });
    expect(JSON.stringify(listed.json())).not.toContain(CLIENT_SECRET);
    // The address to register at the provider comes from the public URL, not the request.
    expect(listed.json().redirectUri).toBe(`${ORIGIN}/api/v1/auth/oidc/callback`);
    const row = await database.db
      .selectFrom('identity_provider')
      .select('client_secret_sealed')
      .where('id', '=', provider.id)
      .executeTakeFirstOrThrow();
    expect(row.client_secret_sealed).not.toContain(CLIENT_SECRET);
    expect(openSecret(row.client_secret_sealed ?? '', peppers)).toBe(CLIENT_SECRET);

    // One enabled provider per domain.
    const clash = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: { name: 'Second', issuer: idp.issuer, clientId: 'y', domains: ['corp.example'] },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json()).toMatchObject({ error: 'domain_taken', domains: ['corp.example'] });

    // The sign-in page sees names only.
    const publicList = await call(undefined, { method: 'GET', url: '/api/v1/auth/providers' });
    expect(publicList.json().providers).toContainEqual({ id: provider.id, name: 'Corporate' });
    expect(JSON.stringify(publicList.json())).not.toContain('taskmoor');

    const event = await lastEvent('identity_provider.created');
    expect(event?.payload).toMatchObject({ name: 'Corporate', domains: ['corp.example'] });
    expect(JSON.stringify(event?.payload)).not.toContain(CLIENT_SECRET);

    // Editing: a rotated secret, a changed list; the event lists what changed.
    const patch = await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { clientSecret: 'rotated', domains: ['corp.example'], name: 'Corporate SSO' },
    });
    expect(patch.statusCode).toBe(200);
    const updated = await lastEvent('identity_provider.updated');
    expect(updated?.payload).toEqual({
      changes: { name: { from: 'Corporate', to: 'Corporate SSO' } },
      clientSecretChanged: true,
      groupMapChanged: false,
    });
    const removed = await call(adminCookie, {
      method: 'DELETE',
      url: `/api/v1/identity-providers/${provider.id}`,
    });
    expect(removed.statusCode).toBe(204);
  });

  it('[IAM-003] a first sign-in creates the account; later sign-ins find it by subject', async () => {
    const provider = await createProvider({ name: 'Acme', domains: ['acme.example'] });
    idp.person = { sub: 'acme-1', email: 'Ada@Acme.example', name: 'Ada Lovelace' };
    const first = await ssoSignIn(provider.id, { returnTo: '/#/tickets/ACME-1' });
    expect(first.location).toBe(`${ORIGIN}/#/tickets/ACME-1`);
    expect(first.session).not.toBe('');
    const me = await call(first.session, { method: 'GET', url: '/api/v1/session' });
    expect(me.json().user).toMatchObject({ email: 'ada@acme.example', name: 'Ada Lovelace' });
    const user = await database.db
      .selectFrom('app_user')
      .select(['id', 'password_hash'])
      .where('email', '=', 'ada@acme.example')
      .executeTakeFirstOrThrow();
    expect(user.password_hash).toBeNull();
    const event = await lastEvent('sso.signed_in');
    expect(event).toMatchObject({ subject_id: String(user.id), actor_id: user.id });
    expect(event?.payload).toMatchObject({ providerId: provider.id, userCreated: true });

    // The provider changed the address: the subject still identifies the person.
    idp.person = { sub: 'acme-1', email: 'ada.l@acme.example', name: 'Ada Lovelace' };
    const second = await ssoSignIn(provider.id);
    expect(second.location).toBe(`${ORIGIN}/`);
    const again = await call(second.session, { method: 'GET', url: '/api/v1/session' });
    expect(again.json().user.id).toBe(user.id);
    expect((await lastEvent('sso.signed_in'))?.payload).toMatchObject({ userCreated: false });
    const count = await database.db
      .selectFrom('app_user')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('email', 'like', '%acme.example')
      .executeTakeFirstOrThrow();
    expect(Number(count.n)).toBe(1);
  });

  it('[IAM-003] links an existing account only through a verified address of a served domain', async () => {
    const provider = await createProvider({
      name: 'Initech',
      domains: ['initech.example'],
      jit: false,
    });
    const existing = await addUser('peter@initech.example');

    idp.person = { sub: 'i-1', email: 'peter@initech.example', name: 'P', emailVerified: false };
    expect((await ssoSignIn(provider.id)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=email_unverified`,
    );

    idp.person = { sub: 'i-1', email: 'peter@elsewhere.example', name: 'P' };
    expect((await ssoSignIn(provider.id)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=domain_not_allowed`,
    );

    idp.person = { sub: 'i-2', email: 'nobody@initech.example', name: 'N' };
    expect((await ssoSignIn(provider.id)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=no_account`,
    );

    idp.person = { sub: 'i-1', email: 'peter@initech.example', name: 'P' };
    const linked = await ssoSignIn(provider.id);
    const me = await call(linked.session, { method: 'GET', url: '/api/v1/session' });
    expect(me.json().user.id).toBe(existing);

    // A deactivated person cannot come back through the provider.
    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', existing)
      .execute();
    expect((await ssoSignIn(provider.id)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=account_deactivated`,
    );

    // Each refusal the provider vouched for is in the audit log (IAM-013).
    const refusals = await database.db
      .selectFrom('audit_event')
      .select(['subject_id', 'details'])
      .where('action', '=', 'sso.sign_in_refused')
      .where(sql<boolean>`details->>'providerId' = ${String(provider.id)}`)
      .orderBy('seq')
      .execute();
    expect(refusals.map((r) => (r.details as { reason: string }).reason)).toEqual([
      'email_unverified',
      'domain_not_allowed',
      'no_account',
      'account_deactivated',
    ]);
    expect(refusals.at(-1)?.subject_id).toBe(String(existing));
  });

  it('[IAM-003] a sign-in completes only in the browser that started it, once', async () => {
    const provider = await createProvider({ name: 'Globex', domains: ['globex.example'] });
    idp.person = { sub: 'g-1', email: 'hank@globex.example', name: 'Hank' };

    const stranger = await ssoSignIn(provider.id, {
      browserCookie: () => 'taskmoor_oidc=someone-else',
    });
    expect(stranger.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);
    expect(stranger.session).toBe('');

    const none = await ssoSignIn(provider.id, { browserCookie: () => '' });
    expect(none.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);

    const ok = await ssoSignIn(provider.id);
    expect(ok.session).not.toBe('');
    const replay = await call(undefined, {
      method: 'GET',
      url: ok.callbackUrl ?? '',
      headers: { cookie: ok.browser ?? '' },
    });
    expect(replay.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);

    // The return address stays on this site.
    const away = await ssoSignIn(provider.id, { returnTo: '//evil.example/steal' });
    expect(away.location).toBe(`${ORIGIN}/`);

    // The provider refused, or the client secret is wrong: no session either way.
    idp.person = null;
    expect((await ssoSignIn(provider.id)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=provider_error`,
    );
    idp.person = { sub: 'g-1', email: 'hank@globex.example', name: 'Hank' };
    await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { clientSecret: 'wrong' },
    });
    expect((await ssoSignIn(provider.id)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=provider_error`,
    );

    // A disabled provider does not start sign-ins.
    await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { enabled: false, clientSecret: CLIENT_SECRET },
    });
    const disabled = await ssoSignIn(provider.id);
    expect(disabled.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_unavailable`);
  });

  it('[IAM-003] group claims add and remove memberships of the mapped groups only', async () => {
    const engineers = await addGroup('sso-engineers');
    const managers = await addGroup('sso-managers');
    const local = await addGroup('sso-local');
    const provider = await createProvider({
      name: 'Hooli',
      domains: ['hooli.example'],
      groupClaim: 'groups',
      groupMap: [
        { claimValue: 'eng', groupId: engineers },
        { claimValue: 'mgmt', groupId: managers },
      ],
    });
    idp.person = {
      sub: 'h-1',
      email: 'gavin@hooli.example',
      name: 'Gavin',
      groups: ['eng', 'mgmt'],
    };
    await ssoSignIn(provider.id);
    const user = await database.db
      .selectFrom('app_user')
      .select('id')
      .where('email', '=', 'gavin@hooli.example')
      .executeTakeFirstOrThrow();
    await database.db
      .insertInto('group_member')
      .values({ workspace_id: 1, group_id: local, user_id: user.id })
      .execute();
    const groupsOf = async () =>
      (
        await database.db
          .selectFrom('group_member')
          .select('group_id')
          .where('user_id', '=', user.id)
          .orderBy('group_id')
          .execute()
      ).map((r) => r.group_id);
    expect(await groupsOf()).toEqual([engineers, managers, local].sort((a, b) => a - b));
    expect((await lastEvent('sso.signed_in'))?.payload).toMatchObject({
      groupsAdded: [engineers, managers],
      groupsRemoved: [],
    });

    // Groups only in user info; a claim gone removes the mapped group, the local one stays.
    idp.groupsInIdToken = false;
    idp.person = { ...idp.person, groups: ['eng'] };
    await ssoSignIn(provider.id);
    idp.groupsInIdToken = true;
    expect(await groupsOf()).toEqual([engineers, local].sort((a, b) => a - b));
    expect((await lastEvent('sso.signed_in'))?.payload).toMatchObject({
      groupsAdded: [],
      groupsRemoved: [managers],
    });
  });

  it('[IAM-004] enforced single sign-on refuses passwords except for break-glass accounts', async () => {
    const provider = await createProvider({
      name: 'Umbrella',
      domains: ['umbrella.example'],
      enforceSso: true,
    });
    await addUser('alice@umbrella.example');
    const glass = await addUser('root@umbrella.example', { breakGlass: true });

    const discover = await call(undefined, {
      method: 'POST',
      url: '/api/v1/auth/discover',
      payload: { email: 'whoever@Umbrella.example' },
    });
    expect(discover.json()).toEqual({
      provider: { id: provider.id, name: 'Umbrella' },
      password: false,
    });
    const elsewhere = await call(undefined, {
      method: 'POST',
      url: '/api/v1/auth/discover',
      payload: { email: 'someone@nowhere.example' },
    });
    expect(elsewhere.json()).toEqual({ provider: null, password: true });

    // The same answer for a real account, a wrong password and an unknown address.
    const expected = { error: 'sso_required', provider: { id: provider.id, name: 'Umbrella' } };
    for (const res of [
      await passwordSignIn('alice@umbrella.example'),
      await passwordSignIn('alice@umbrella.example', 'not the password'),
      await passwordSignIn('ghost@umbrella.example'),
      await passwordSignIn('root@umbrella.example', 'not the password'),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(expected);
      expect(cookieNamed(res, SESSION_COOKIE)).toBe('');
    }
    // Wrong passwords and unknown addresses still count towards the lockout.
    const failures = await database.db
      .selectFrom('sign_in_throttle')
      .select(['key', 'failures'])
      .where('key', 'like', 'email:%@umbrella.example')
      .orderBy('key')
      .execute();
    expect(failures).toEqual([
      { key: 'email:alice@umbrella.example', failures: 1 },
      { key: 'email:ghost@umbrella.example', failures: 1 },
      { key: 'email:root@umbrella.example', failures: 1 },
    ]);

    const audited = await database.db
      .selectFrom('audit_event')
      .select('details')
      .where('action', '=', 'session.sign_in_failed')
      .where(sql<boolean>`details->>'reason' = 'sso_required'`)
      .execute();
    expect(audited).toHaveLength(4);

    const ok = await passwordSignIn('root@umbrella.example');
    expect(ok.json()).toMatchObject({ status: 'signed_in', user: { id: glass } });

    // Administrators mark break-glass accounts; it is a user change like any other.
    const alice = await database.db
      .selectFrom('app_user')
      .select('id')
      .where('email', '=', 'alice@umbrella.example')
      .executeTakeFirstOrThrow();
    const mark = await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/users/${alice.id}`,
      payload: { breakGlass: true },
    });
    expect(mark.json().user).toMatchObject({ breakGlass: true });
    expect((await lastEvent('user.updated'))?.payload).toEqual({
      changes: { breakGlass: { from: false, to: true } },
    });
    expect((await passwordSignIn('alice@umbrella.example')).json()).toMatchObject({
      status: 'signed_in',
    });
  });
});
