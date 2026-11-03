import { useMigratedDatabase } from '@taskmoor/db/testing';
import { openSecret, passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { createOutboundGuard } from '../outbound/guard';
import { addressVouched } from '../sso/oidc';
import { FakeIdp, GOOGLE_HOSTS, GOOGLE_ISSUER } from '../testing/fake-idp';
import { loopbackOutbound, routedOutbound } from '../testing/outbound';

const PASSWORD = 'ladder violet harbour';
const ORIGIN = 'http://tracker.test';
const CLIENT_ID = 'an-operators-own-client.apps.example.com';
const CLIENT_SECRET = 'a client secret only the fake provider knows';
const peppers = pepperRing(pepperFromSecret('a pepper for the google sign-in tests, long enough'));
let address = 0;
const nextAddress = () => `198.51.100.${(address++ % 250) + 1}`;

function cookieNamed(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (list.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? '').split(
      ';',
    )[0] ?? ''
  );
}

const tokenOf = (link: string) =>
  new URL(link.replace('/#/', '/')).searchParams.get('token') as string;

/**
 * Google sign-in (IAM-031, IAM-032, ADR-119), all against the fake provider in Google's shape: the
 * server speaks to `https://accounts.google.com` and the other hosts of its discovery document, and
 * the test's outbound guard leads them to loopback. No test touches the network; what Google
 * really answers is for the real test in `docs/plan/google-signin-tasks.md`.
 */
describe('signing in with Google (IAM-031, IAM-032)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  const idp = new FakeIdp(CLIENT_ID, CLIENT_SECRET, 'google');
  let app: FastifyInstance;
  let adminCookie: string;
  let providerId: number;
  let track: number;
  let roles: Record<string, number>;

  const call = (cookie: string | undefined, options: InjectOptions) =>
    app.inject({
      remoteAddress: nextAddress(),
      ...options,
      headers: { ...(options.headers ?? {}), ...(cookie ? { cookie } : {}) },
    });

  const passwordSignIn = (email: string, password = PASSWORD) =>
    app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email, password },
      remoteAddress: nextAddress(),
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

  const personNamed = (email: string) =>
    database.db
      .selectFrom('app_user')
      .select(['id', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();

  const invite = (addressToInvite: string, role = 'Viewers') =>
    call(adminCookie, {
      method: 'POST',
      url: `/api/v1/tracks/${track}/invitations`,
      payload: { addresses: [addressToInvite], roleId: roles[role], delivery: 'link' },
    });

  const holds = async (role: string, userId: number) =>
    (await database.db
      .selectFrom('track_role_actor')
      .select('track_id')
      .where('track_id', '=', track)
      .where('role_id', '=', roles[role] as number)
      .where('user_id', '=', userId)
      .executeTakeFirst()) !== undefined;

  /** What the browser does: Google's address is led to the fake provider, as the guard does. */
  const atFake = (location: string) => {
    const url = new URL(location);
    return `${idp.issuer}${url.pathname}${url.search}`;
  };

  async function googleSignIn(id = providerId) {
    const start = await call(undefined, { method: 'GET', url: `/api/v1/auth/oidc/${id}/start` });
    expect(start.statusCode).toBe(302);
    const location = String(start.headers.location);
    if (!location.startsWith(GOOGLE_ISSUER)) return { location, session: '' };
    const authorize = await fetch(atFake(location), { redirect: 'manual' });
    const back = new URL(authorize.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(`${ORIGIN}/api/v1/auth/oidc/callback`);
    const callback = await call(undefined, {
      method: 'GET',
      url: `${back.pathname}${back.search}`,
      headers: { cookie: cookieNamed(start, 'taskmoor_oidc') },
    });
    return {
      location: String(callback.headers.location),
      session: cookieNamed(callback, SESSION_COOKIE),
    };
  }

  beforeAll(async () => {
    await idp.start();
    app = await buildApp({
      db: database.db,
      outbound: routedOutbound(GOOGLE_HOSTS, idp.issuer),
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
      publicUrl: ORIGIN,
      invitationMail: async () => null,
    });
    await addUser('admin@example.com', { admin: true });
    adminCookie = cookieNamed(await passwordSignIn('admin@example.com'), SESSION_COOKIE);
    const policy = await database.db
      .selectFrom('access_policy')
      .select('id')
      .where('name', '=', 'Default access policy')
      .executeTakeFirstOrThrow();
    const rows = await database.db.selectFrom('role').select(['id', 'name']).execute();
    roles = Object.fromEntries(rows.map((r) => [r.name, r.id]));
    const made = await database.db
      .insertInto('track')
      .values({ workspace_id: 1, key: 'PAY', name: 'Track PAY', access_policy_id: policy.id })
      .returning('id')
      .executeTakeFirstOrThrow();
    track = made.id;
    // Exactly what the Google choice of the Single sign-on page sends (`googleDraft`).
    const res = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: {
        name: 'Google',
        issuer: GOOGLE_ISSUER,
        clientId: CLIENT_ID,
        clientSecret: CLIENT_SECRET,
        scopes: 'openid email profile',
        groupClaim: null,
        domains: ['gmail.com'],
        enforceSso: false,
        jit: false,
        enabled: true,
        groupMap: [],
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    providerId = res.json().provider.id;
  });

  afterAll(async () => {
    await app.close();
    await idp.stop();
  });

  describe('what the settings say', () => {
    it("[IAM-031] the safe settings are the provider's plain settings, and the secret stays sealed", async () => {
      const list = await call(adminCookie, { method: 'GET', url: '/api/v1/identity-providers' });
      expect(list.json().redirectUri).toBe(`${ORIGIN}/api/v1/auth/oidc/callback`);
      expect(list.json().providers[0]).toMatchObject({
        issuer: GOOGLE_ISSUER,
        domains: ['gmail.com'],
        jit: false,
        enforceSso: false,
        hasClientSecret: true,
      });
      expect(list.body).not.toContain(CLIENT_SECRET);
      const row = await database.db
        .selectFrom('identity_provider')
        .select('client_secret_sealed')
        .where('id', '=', providerId)
        .executeTakeFirstOrThrow();
      expect(row.client_secret_sealed).not.toContain(CLIENT_SECRET);
      expect(openSecret(row.client_secret_sealed as string, peppers)).toBe(CLIENT_SECRET);
    });

    it('[IAM-032] the sign-in page learns of Google from the domain alone, and the password stays on offer', async () => {
      const found = await call(undefined, {
        method: 'POST',
        url: '/api/v1/auth/discover',
        payload: { email: 'nobody-here@gmail.com' },
      });
      expect(found.json()).toEqual({
        provider: { id: providerId, name: 'Google', protocol: 'oidc' },
        password: true,
      });
      const elsewhere = await call(undefined, {
        method: 'POST',
        url: '/api/v1/auth/discover',
        payload: { email: 'someone@example.com' },
      });
      expect(elsewhere.json()).toEqual({ provider: null, password: true });
      const offered = await call(undefined, { method: 'GET', url: '/api/v1/auth/providers' });
      expect(offered.json().providers).toEqual([
        { id: providerId, name: 'Google', protocol: 'oidc' },
      ]);
    });
  });

  describe("Google's OpenID Connect shape", () => {
    it('[IAM-032] discovery passes the real client, and the request is what Google documents', async () => {
      idp.person = null;
      const before = idp.authorizations.length;
      const start = await call(undefined, {
        method: 'GET',
        url: `/api/v1/auth/oidc/${providerId}/start`,
      });
      const location = new URL(String(start.headers.location));
      expect(`${location.origin}${location.pathname}`).toBe(`${GOOGLE_ISSUER}/o/oauth2/v2/auth`);
      await fetch(atFake(location.href), { redirect: 'manual' });
      const query = idp.authorizations[before] as URLSearchParams;
      expect(query.get('client_id')).toBe(CLIENT_ID);
      expect(query.get('response_type')).toBe('code');
      expect(query.get('scope')).toBe('openid email profile');
      expect(query.get('redirect_uri')).toBe(`${ORIGIN}/api/v1/auth/oidc/callback`);
      expect(query.get('code_challenge_method')).toBe('S256');
      expect(query.get('code_challenge')).toBeTruthy();
      expect(query.get('nonce')).toBeTruthy();
      expect(query.get('state')).toBeTruthy();
      expect(query.get('prompt')).toBe('select_account');
    });

    it('[IAM-032] no group data is needed: no claim, no call to user info, and a group claim set by mistake does no harm', async () => {
      await addUser('groupless@gmail.com');
      idp.person = { sub: 'g-groupless', email: 'groupless@gmail.com', name: 'Group Less' };
      const before = idp.userInfoCalls;
      expect((await googleSignIn()).session).not.toBe('');
      expect(idp.userInfoCalls).toBe(before);

      const edit = await call(adminCookie, {
        method: 'PATCH',
        url: `/api/v1/identity-providers/${providerId}`,
        payload: { groupClaim: 'groups' },
      });
      expect(edit.statusCode, edit.body).toBe(200);
      try {
        expect((await googleSignIn()).session).not.toBe('');
        expect(idp.userInfoCalls).toBe(before + 1);
      } finally {
        await call(adminCookie, {
          method: 'PATCH',
          url: `/api/v1/identity-providers/${providerId}`,
          payload: { groupClaim: null },
        });
      }
    });

    it("[IAM-032] the outbound guard lets Google's hosts through, and still judges each address", async () => {
      const guard = createOutboundGuard({
        resolve: async () => [
          { address: '142.250.1.1', family: 4 },
          { address: '2a00:1450:4001::1', family: 6 },
        ],
      });
      for (const host of GOOGLE_HOSTS) {
        await expect(guard.check(host)).resolves.toHaveLength(2);
      }
      const rebound = createOutboundGuard({
        resolve: async () => [{ address: '10.0.0.5', family: 4 }],
      });
      await expect(rebound.check('accounts.google.com')).rejects.toThrow('not a public address');
    });

    it('[IAM-032] Google is believed only for Gmail and its hosted domains; other providers keep their word', () => {
      const claims = (email: string, extra: Record<string, unknown> = {}) => ({
        email,
        email_verified: true,
        ...extra,
      });
      expect(addressVouched(GOOGLE_ISSUER, claims('a@gmail.com'))).toBe(true);
      expect(addressVouched(`${GOOGLE_ISSUER}/`, claims('a@gmail.com'))).toBe(true);
      expect(addressVouched(GOOGLE_ISSUER, claims('a@example.com', { hd: 'example.com' }))).toBe(
        true,
      );
      expect(addressVouched(GOOGLE_ISSUER, claims('a@example.com'))).toBe(false);
      expect(addressVouched(GOOGLE_ISSUER, claims('a@example.com', { hd: '' }))).toBe(false);
      expect(addressVouched(GOOGLE_ISSUER, { email: 'a@gmail.com' })).toBe(false);
      expect(addressVouched(GOOGLE_ISSUER, { email_verified: true })).toBe(false);
      expect(addressVouched('https://id.example.com', claims('a@example.com'))).toBe(true);
      expect(addressVouched('https://id.example.com', { email: 'a@example.com' })).toBe(false);
      expect(addressVouched('https://accounts.google.com.example.com', claims('a@b.com'))).toBe(
        true,
      );
    });
  });

  describe('who gets in', () => {
    it('[IAM-032] an invited Gmail address gets in and lands in its track with its role', async () => {
      const made = await invite('invited@gmail.com', 'Viewers');
      expect(made.statusCode, made.body).toBe(201);
      const token = tokenOf(made.json().results[0].link);
      idp.person = { sub: 'g-invited', email: 'Invited@gmail.com', name: 'Invited Person' };
      const signedIn = await googleSignIn();
      expect(signedIn.session).not.toBe('');
      const person = await personNamed('invited@gmail.com');
      expect(person?.password_hash).toBeNull();
      expect(await holds('Viewers', person?.id as number)).toBe(false);
      const accepted = await call(signedIn.session, {
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { token },
      });
      expect(accepted.statusCode, accepted.body).toBe(200);
      expect(accepted.json().track).toEqual({ id: track, key: 'PAY' });
      expect(await holds('Viewers', person?.id as number)).toBe(true);
      expect(await holds('Members', person?.id as number)).toBe(false);

      // Next time the subject finds the person; nothing asks for an invitation any more.
      const again = await googleSignIn();
      const me = await call(again.session, { method: 'GET', url: '/api/v1/session' });
      expect(me.json().user.id).toBe(person?.id);
    });

    it('[IAM-032] an uninvited address is refused while account creation is off, and no account is made', async () => {
      idp.person = { sub: 'g-stranger', email: 'stranger@gmail.com', name: 'A Stranger' };
      const refused = await googleSignIn();
      expect(refused.location).toBe(`${ORIGIN}/#/sign-in?sso_error=no_account`);
      expect(refused.session).toBe('');
      expect(await personNamed('stranger@gmail.com')).toBeUndefined();
    });

    it('[IAM-032] an address Google has not verified is refused, invited or not', async () => {
      await invite('unconfirmed@gmail.com');
      idp.person = {
        sub: 'g-unconfirmed',
        email: 'unconfirmed@gmail.com',
        name: 'Not Confirmed',
        emailVerified: false,
      };
      const refused = await googleSignIn();
      expect(refused.location).toBe(`${ORIGIN}/#/sign-in?sso_error=email_unverified`);
      expect(await personNamed('unconfirmed@gmail.com')).toBeUndefined();
    });

    it('[IAM-032] an address outside the domains is refused, also with an invitation', async () => {
      await invite('outside@example.com');
      idp.person = {
        sub: 'g-outside',
        email: 'outside@example.com',
        name: 'Out Side',
        hd: 'example.com',
      };
      const refused = await googleSignIn();
      expect(refused.location).toBe(`${ORIGIN}/#/sign-in?sso_error=domain_not_allowed`);
      expect(await personNamed('outside@example.com')).toBeUndefined();
    });

    it('[IAM-032] a withdrawn invitation opens nothing', async () => {
      const made = await invite('withdrawn@gmail.com');
      const withdrawn = await call(adminCookie, {
        method: 'DELETE',
        url: `/api/v1/tracks/${track}/invitations/${made.json().results[0].invitationId}`,
      });
      expect(withdrawn.statusCode, withdrawn.body).toBeLessThan(300);
      idp.person = { sub: 'g-withdrawn', email: 'withdrawn@gmail.com', name: 'With Drawn' };
      const refused = await googleSignIn();
      expect(refused.location).toBe(`${ORIGIN}/#/sign-in?sso_error=no_account`);
      expect(await personNamed('withdrawn@gmail.com')).toBeUndefined();
    });

    it('[IAM-032] an address written differently from the Google account finds nothing: the match is exact', async () => {
      await invite('dotted.name@gmail.com');
      idp.person = { sub: 'g-undotted', email: 'dottedname@gmail.com', name: 'Dotted Name' };
      const refused = await googleSignIn();
      expect(refused.location).toBe(`${ORIGIN}/#/sign-in?sso_error=no_account`);
      expect(await personNamed('dottedname@gmail.com')).toBeUndefined();
    });

    it('[IAM-032] a person with an account can sign in, and keeps it through the subject', async () => {
      const id = await addUser('member@gmail.com');
      idp.person = { sub: 'g-member', email: 'member@gmail.com', name: 'Mem Ber' };
      const first = await googleSignIn();
      const me = await call(first.session, { method: 'GET', url: '/api/v1/session' });
      expect(me.json().user.id).toBe(id);
      const person = await personNamed('member@gmail.com');
      expect(person?.password_hash).not.toBeNull();
    });

    it('[IAM-032] a deactivated account stays out, whoever vouches for it', async () => {
      const id = await addUser('gone@gmail.com');
      await database.db
        .updateTable('app_user')
        .set({ deactivated_at: new Date() })
        .where('id', '=', id)
        .execute();
      idp.person = { sub: 'g-gone', email: 'gone@gmail.com', name: 'Gone' };
      expect((await googleSignIn()).location).toBe(
        `${ORIGIN}/#/sign-in?sso_error=account_deactivated`,
      );
    });

    it('[IAM-032] Google is enough: a person counted as external gets no Taskmoor second factor, though a password would ask for it', async () => {
      await addUser('outsider@gmail.com');
      const rules = await call(adminCookie, {
        method: 'PUT',
        url: '/api/v1/security/two-factor',
        payload: { required: 'none', groupIds: [], organizationDomains: ['example.com'] },
      });
      expect(rules.statusCode, rules.body).toBe(200);
      try {
        const byPassword = await passwordSignIn('outsider@gmail.com');
        expect(byPassword.json().status).toBe('enrollment_required');
        expect(cookieNamed(byPassword, SESSION_COOKIE)).toBe('');
        idp.person = { sub: 'g-outsider', email: 'outsider@gmail.com', name: 'Out Sider' };
        expect((await googleSignIn()).session).not.toBe('');
      } finally {
        await call(adminCookie, {
          method: 'PUT',
          url: '/api/v1/security/two-factor',
          payload: { required: 'none', groupIds: [], organizationDomains: [] },
        });
      }
    });
  });

  describe('a company domain on the same provider', () => {
    it('[IAM-032] a hosted account of the domain gets in; a Google account merely opened with that address does not', async () => {
      const edit = await call(adminCookie, {
        method: 'PATCH',
        url: `/api/v1/identity-providers/${providerId}`,
        payload: { domains: ['gmail.com', 'company.example.com'] },
      });
      expect(edit.statusCode, edit.body).toBe(200);
      try {
        const id = await addUser('jo@company.example.com');
        // The takeover this rule stops: a Google account with Jo's address, no hosted domain.
        idp.person = { sub: 'g-not-jo', email: 'jo@company.example.com', name: 'Not Jo' };
        const takeover = await googleSignIn();
        expect(takeover.location).toBe(`${ORIGIN}/#/sign-in?sso_error=email_unverified`);
        expect(takeover.session).toBe('');

        idp.person = {
          sub: 'g-jo',
          email: 'jo@company.example.com',
          name: 'Jo',
          hd: 'company.example.com',
        };
        const signedIn = await googleSignIn();
        const me = await call(signedIn.session, { method: 'GET', url: '/api/v1/session' });
        expect(me.json().user.id).toBe(id);
      } finally {
        await call(adminCookie, {
          method: 'PATCH',
          url: `/api/v1/identity-providers/${providerId}`,
          payload: { domains: ['gmail.com'] },
        });
      }
    });
  });

  describe('when Google is down or misconfigured', () => {
    it('[IAM-032] password sign-in still works with Google set up, for a site administrator with a Gmail address too', async () => {
      await addUser('siteadmin@gmail.com', { admin: true });
      const res = await passwordSignIn('siteadmin@gmail.com');
      expect(res.statusCode, res.body).toBe(200);
      expect(cookieNamed(res, SESSION_COOKIE)).not.toBe('');
    });

    it('[IAM-032] with Google unreachable a sign-in through it fails plainly, and the password does not care', async () => {
      const down = new FakeIdp(CLIENT_ID, CLIENT_SECRET, 'google');
      const app2 = await buildApp({
        db: database.db,
        // Nothing answers: as when Google or the way to it is down.
        outbound: loopbackOutbound(),
        version: 'test',
        roles: ['api'],
        passwords,
        peppers,
        publicUrl: ORIGIN,
      });
      try {
        // A new provider, so nothing is left in the discovery cache.
        const made = await call(adminCookie, {
          method: 'POST',
          url: '/api/v1/identity-providers',
          payload: {
            name: 'Google, unreachable',
            issuer: down.publicIssuer,
            clientId: CLIENT_ID,
            clientSecret: CLIENT_SECRET,
            domains: [],
            jit: false,
          },
        });
        expect(made.statusCode, made.body).toBe(201);
        const start = await app2.inject({
          method: 'GET',
          url: `/api/v1/auth/oidc/${made.json().provider.id}/start`,
          remoteAddress: nextAddress(),
        });
        expect(start.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_unavailable`);
        const res = await app2.inject({
          method: 'POST',
          url: '/api/v1/session',
          payload: { email: 'siteadmin@gmail.com', password: PASSWORD },
          remoteAddress: nextAddress(),
        });
        expect(res.statusCode, res.body).toBe(200);
      } finally {
        await app2.close();
      }
    });

    it('[IAM-032] enforcing the domain leaves only break-glass accounts a password, also while Google is down', async () => {
      await addUser('rescue@gmail.com', { admin: true, breakGlass: true });
      const ordinary = await addUser('ordinaryadmin@gmail.com', { admin: true });
      const edit = await call(adminCookie, {
        method: 'PATCH',
        url: `/api/v1/identity-providers/${providerId}`,
        payload: { enforceSso: true },
      });
      expect(edit.statusCode, edit.body).toBe(200);
      try {
        const refused = await passwordSignIn('ordinaryadmin@gmail.com');
        expect(refused.statusCode).toBe(403);
        expect(refused.json().error).toBe('sso_required');
        const rescue = await passwordSignIn('rescue@gmail.com');
        expect(rescue.statusCode, rescue.body).toBe(200);
        expect(cookieNamed(rescue, SESSION_COOKIE)).not.toBe('');
        // A site administrator at another domain is not touched by the rule at all.
        const other = await passwordSignIn('admin@example.com');
        expect(other.statusCode, other.body).toBe(200);
        // The last resort: a password link still gets someone in.
        const link = await call(adminCookie, {
          method: 'POST',
          url: `/api/v1/users/${ordinary}/password-link`,
        });
        expect(link.statusCode, link.body).toBeLessThan(300);
        const redeemed = await call(undefined, {
          method: 'POST',
          url: '/api/v1/password-links/redeem',
          payload: { token: tokenOf(link.json().link), password: 'a new lantern otter ladder' },
        });
        expect(redeemed.statusCode, redeemed.body).toBe(200);
        expect(cookieNamed(redeemed, SESSION_COOKIE)).not.toBe('');
      } finally {
        await call(adminCookie, {
          method: 'PATCH',
          url: `/api/v1/identity-providers/${providerId}`,
          payload: { enforceSso: false },
        });
      }
    });
  });
});
