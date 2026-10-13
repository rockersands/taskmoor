import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher } from '@taskmoor/iam';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';

/**
 * Single sign-on against a real Keycloak (M1-080 done-when). Runs only when
 * TASKMOOR_KEYCLOAK_URL names the realm of tools/sso/keycloak-realm.json, which
 * `bash tools/sso/keycloak-test.sh` starts in a container. The browser's part is played with
 * fetch: the provider's login form is read and submitted like a person would.
 */
const ISSUER = process.env.TASKMOOR_KEYCLOAK_URL;
const ORIGIN = 'http://tracker.test';
const PASSWORD = 'ladder violet harbour';

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
  html.replaceAll('&amp;', '&').replaceAll('&#x2F;', '/').replaceAll('&#47;', '/');

describe.skipIf(!ISSUER)('single sign-on against Keycloak (M1-080)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let admin = '';
  let providerId = 0;

  /** Starts a sign-in here, logs in at Keycloak, and returns where the callback sends us. */
  async function signIn(username: string, password: string) {
    const start = await app.inject({ method: 'GET', url: `/api/v1/auth/oidc/${providerId}/start` });
    expect(start.statusCode).toBe(302);
    const browser = cookieNamed(start, 'taskmoor_oidc');
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
    expect(login.status, 'redirect back').toBe(302);
    const back = new URL(login.headers.get('location') ?? '');
    expect(`${back.origin}${back.pathname}`).toBe(`${ORIGIN}/api/v1/auth/oidc/callback`);
    const callback = await app.inject({
      method: 'GET',
      url: `${back.pathname}${back.search}`,
      headers: { cookie: browser },
    });
    expect(callback.statusCode).toBe(302);
    return {
      location: String(callback.headers.location),
      session: cookieNamed(callback, SESSION_COOKIE),
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
    const group = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name: 'Engineering' })
      .returning('id')
      .executeTakeFirstOrThrow();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/identity-providers',
      headers: { cookie: admin },
      payload: {
        name: 'Keycloak',
        issuer: ISSUER,
        clientId: 'taskmoor',
        clientSecret: 'keycloak-client-secret-for-tests',
        domains: ['keycloak.test'],
        groupClaim: 'groups',
        groupMap: [{ claimValue: 'engineers', groupId: group.id }],
        enforceSso: true,
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    providerId = created.json().provider.id;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('[IAM-003] signs a verified person in, creates the account and maps the group claim', async () => {
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

    // The second sign-in finds the same account by Keycloak's subject.
    const second = await signIn('kim', 'kim-password-for-tests');
    const again = await app.inject({
      method: 'GET',
      url: '/api/v1/session',
      headers: { cookie: second.session },
    });
    expect(again.json().user.id).toBe(me.json().user.id);
  });

  it('[IAM-003] refuses an unverified address', async () => {
    const result = await signIn('lou', 'lou-password-for-tests');
    expect(result.location).toBe(`${ORIGIN}/#/sign-in?sso_error=email_unverified`);
    expect(result.session).toBe('');
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
      provider: { id: providerId, name: 'Keycloak' },
    });
  });
});
