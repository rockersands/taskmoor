import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher } from '@taskmoor/iam';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { selfSignedCertificate } from '../testing/x509';

/**
 * SAML sign-in against a real Keycloak (M1-081 done-when). Runs only when
 * TASKMOOR_KEYCLOAK_URL names the realm of tools/sso/keycloak-realm.json, which
 * `bash tools/sso/keycloak-test.sh` starts in a container. The provider is added from
 * Keycloak's own metadata; the browser's part is played with fetch: Keycloak's login form is
 * submitted, then the form it answers with (the HTTP-POST binding) is posted to the ACS.
 */
const REALM = process.env.TASKMOOR_KEYCLOAK_URL;
const ORIGIN = 'http://tracker.test';
const PASSWORD = 'ladder violet harbour';
/** The SAML client's ID in the realm, which is Taskmoor's entity ID towards it. */
const SP_ENTITY_ID = 'taskmoor-saml';

/** A cookie jar for one simulated browser at the provider. */
class Jar {
  private readonly cookies = new Map<string, string>();
  take(res: Response): void {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const at = pair.indexOf('=');
      if (at > 0) this.cookies.set(pair.slice(0, at).trim(), pair.slice(at + 1));
    }
  }
  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

function cookieNamed(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (list.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? '').split(
      ';',
    )[0] ?? ''
  );
}

const decode = (html: string) =>
  html
    .replaceAll('&amp;', '&')
    .replaceAll('&#x2F;', '/')
    .replaceAll('&#47;', '/')
    .replaceAll('&#x3D;', '=')
    .replaceAll('&#61;', '=')
    .replaceAll('&#x2B;', '+')
    .replaceAll('&#43;', '+')
    .replaceAll('&quot;', '"');

/** A hidden field of the HTTP-POST binding page (Keycloak's template may be upper case). */
const field = (html: string, name: string) =>
  new RegExp(`name="${name}"[^>]*value="([^"]*)"`, 'i').exec(html)?.[1] ??
  new RegExp(`value="([^"]*)"[^>]*name="${name}"`, 'i').exec(html)?.[1];

describe.skipIf(!REALM)('SAML single sign-on against Keycloak (M1-081)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let admin = '';
  let providerId = 0;
  let engineering = 0;

  /** Starts a sign-in here, logs in at Keycloak and posts its answer back. */
  async function signIn(username: string, password: string) {
    const start = await app.inject({ method: 'GET', url: `/api/v1/auth/saml/${providerId}/start` });
    expect(start.statusCode).toBe(302);
    const browser = cookieNamed(start, 'taskmoor_saml');
    const jar = new Jar();
    const page = await fetch(String(start.headers.location), { redirect: 'manual' });
    jar.take(page);
    expect(page.status, 'login page').toBe(200);
    const html = await page.text();
    const action = /<form[^>]*id="kc-form-login"[^>]*action="([^"]+)"/.exec(html)?.[1];
    expect(action, 'login form').toBeDefined();
    const login = await fetch(decode(action ?? ''), {
      method: 'POST',
      redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: jar.header() },
      body: new URLSearchParams({ username, password, credentialId: '' }),
    });
    expect(login.status, 'the HTTP-POST binding form').toBe(200);
    const post = await login.text();
    const target = /<form[^>]*action="([^"]+)"/i.exec(post)?.[1];
    const samlResponse = field(post, 'SAMLResponse');
    expect(samlResponse, 'SAMLResponse').toBeDefined();
    const acs = new URL(decode(target ?? ''));
    expect(`${acs.origin}${acs.pathname}`).toBe(`${ORIGIN}/api/v1/auth/saml/${providerId}/acs`);
    const relayState = field(post, 'RelayState');
    const form = new URLSearchParams({
      SAMLResponse: decode(samlResponse ?? ''),
      ...(relayState ? { RelayState: decode(relayState) } : {}),
    }).toString();
    const posted = await app.inject({
      method: 'POST',
      url: acs.pathname,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: form,
    });
    expect(posted.statusCode).toBe(303);
    const next = new URL(String(posted.headers.location));
    if (next.pathname !== '/api/v1/auth/saml/continue') {
      return { location: String(posted.headers.location), session: '', form };
    }
    const done = await app.inject({
      method: 'GET',
      url: `${next.pathname}${next.search}`,
      headers: { cookie: browser },
    });
    expect(done.statusCode).toBe(302);
    return {
      location: String(done.headers.location),
      session: cookieNamed(done, SESSION_COOKIE),
      form,
    };
  }

  beforeAll(async () => {
    const passwords = passwordHasher();
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      passwords,
      publicUrl: ORIGIN,
    });
    await database.db
      .insertInto('app_user')
      .values({
        workspace_id: 1,
        email: 'admin@example.com',
        name: 'Admin',
        password_hash: await passwords.hash(PASSWORD),
        is_site_admin: true,
      })
      .execute();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'admin@example.com', password: PASSWORD },
    });
    admin = cookieNamed(res, SESSION_COOKIE);
    engineering = (
      await database.db
        .insertInto('user_group')
        .values({ workspace_id: 1, name: 'Engineering' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
    const descriptor = await fetch(`${REALM}/protocol/saml/descriptor`);
    expect(descriptor.status, 'Keycloak metadata').toBe(200);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/identity-providers',
      headers: { cookie: admin },
      payload: {
        protocol: 'saml',
        name: 'Keycloak SAML',
        metadataXml: await descriptor.text(),
        spEntityId: SP_ENTITY_ID,
        domains: ['keycloak.test'],
        groupClaim: 'groups',
        groupMap: [{ claimValue: 'engineers', groupId: engineering }],
        enforceSso: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    providerId = created.json().provider.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[IAM-002] signs a person in through Keycloak, creates the account and maps the group attribute', async () => {
    const first = await signIn('kim', 'kim-password-for-tests');
    expect(first.location).toBe(`${ORIGIN}/`);
    const me = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: first.session },
    });
    expect(me.json().user).toMatchObject({ email: 'kim@keycloak.test', name: 'Kim Park' });
    const groups = await database.db
      .selectFrom('group_member as m')
      .innerJoin('user_group as g', 'g.id', 'm.group_id')
      .select('g.name')
      .where('m.user_id', '=', me.json().user.id)
      .execute();
    expect(groups.map((g) => g.name)).toEqual(['Engineering']);

    // The second sign-in finds the same account by the NameID.
    const second = await signIn('kim', 'kim-password-for-tests');
    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: second.session },
    });
    expect(again.json().user.id).toBe(me.json().user.id);

    // Keycloak's response cannot be used a second time.
    const replay = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/saml/${providerId}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: second.form,
    });
    expect(replay.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);
  });

  it('[IAM-002] refuses Keycloak responses once its certificate is no longer trusted', async () => {
    const metadata = await fetch(`${REALM}/protocol/saml/descriptor`).then((r) => r.text());
    const certificate = /<(?:\w+:)?X509Certificate>([^<]+)</.exec(metadata)?.[1] ?? '';
    expect(certificate).not.toBe('');
    // Trusting only a stranger's certificate, Keycloak's genuine signatures do not count.
    const stranger = selfSignedCertificate('Stranger').certificate;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/identity-providers/${providerId}`,
      headers: { cookie: admin },
      payload: { certificates: [stranger] },
    });
    const refused = await signIn('kim', 'kim-password-for-tests');
    expect(refused.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_error`);
    expect(refused.session).toBe('');
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/identity-providers/${providerId}`,
      headers: { cookie: admin },
      payload: { certificates: [certificate] },
    });
  });

  it('[IAM-004] enforced single sign-on sends the domain to Keycloak instead of a password', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/session',
      payload: { email: 'kim@keycloak.test', password: 'kim-password-for-tests' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({
      error: 'sso_required',
      provider: { id: providerId, name: 'Keycloak SAML', protocol: 'saml' },
    });
  });
});
