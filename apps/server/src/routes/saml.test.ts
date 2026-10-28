import { useMigratedDatabase } from '@taskmoor/db/testing';
import { passwordHasher, pepperFromSecret, pepperRing } from '@taskmoor/iam';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import { NAME_ID_FORMAT, SAML_NS } from '../sso/saml';
import {
  encodeSamlResponse,
  FakeSamlIdp,
  type SamlPerson,
  type SamlResponseOptions,
} from '../testing/fake-saml-idp';

const PASSWORD = 'ladder violet harbour';
const ORIGIN = 'http://tracker.test';
const peppers = pepperRing(pepperFromSecret('a pepper for SAML sign-in tests, long enough'));
let address = 0;
const nextAddress = () => `203.0.113.${++address}`;

function cookieNamed(res: LightMyRequestResponse, name: string): string {
  const header = res.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return (
    (list.find((c) => c.startsWith(`${name}=`) && !c.startsWith(`${name}=;`)) ?? '').split(
      ';',
    )[0] ?? ''
  );
}

interface SamlView {
  id: number;
  protocol: 'saml';
  entityId: string;
  ssoUrl: string;
  certificates: { fingerprint: string; subject: string; notAfter: string; pem: string }[];
  spEntityId: string | null;
  idpInitiated: boolean;
  serviceProvider: { spEntityId: string; acsUrl: string; metadataUrl: string };
}

describe('single sign-on with SAML 2.0 (M1-081)', () => {
  const database = useMigratedDatabase();
  const passwords = passwordHasher(peppers);
  const idp = new FakeSamlIdp({
    entityId: 'https://idp.alpha.test/saml',
    ssoUrl: 'https://idp.alpha.test/sso',
  });
  const second = new FakeSamlIdp({
    entityId: 'https://idp.beta.test/saml',
    ssoUrl: 'https://idp.beta.test/sso',
  });
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

  async function addGroup(name: string) {
    const row = await database.db
      .insertInto('user_group')
      .values({ workspace_id: 1, name })
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

  async function createProvider(body: Record<string, unknown>, from = idp) {
    const res = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: { protocol: 'saml', metadataXml: from.metadata(), ...body },
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().provider as SamlView;
  }

  const postResponse = (providerId: number, samlResponse: string, relayState?: string) =>
    call(undefined, {
      method: 'POST',
      url: `/api/v1/auth/saml/${providerId}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({
        SAMLResponse: samlResponse,
        ...(relayState ? { RelayState: relayState } : {}),
      }).toString(),
    });

  /** Where the browser goes after the ACS: the continue step with its cookie, or an error. */
  async function collect(acs: LightMyRequestResponse, browserCookie: string) {
    const location = String(acs.headers.location);
    if (!location.startsWith(`${ORIGIN}/api/v1/auth/saml/continue`)) {
      return { location, session: '' };
    }
    expect(acs.statusCode).toBe(303);
    const back = new URL(location);
    const done = await call(undefined, {
      method: 'GET',
      url: `${back.pathname}${back.search}`,
      headers: browserCookie ? { cookie: browserCookie } : {},
    });
    expect(done.statusCode).toBe(302);
    return { location: String(done.headers.location), session: cookieNamed(done, SESSION_COOKIE) };
  }

  /**
   * A whole service-provider-initiated sign-in as a browser makes it: start here, the provider
   * reads the AuthnRequest and answers, the browser posts the answer back and follows on.
   */
  async function samlSignIn(
    provider: SamlView,
    person: SamlPerson | null,
    options: {
      from?: FakeSamlIdp;
      returnTo?: string;
      response?: Partial<SamlResponseOptions>;
      browserCookie?: (real: string) => string;
      edit?: (xml: string) => string;
    } = {},
  ) {
    const query = options.returnTo ? `?returnTo=${encodeURIComponent(options.returnTo)}` : '';
    const start = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/saml/${provider.id}/start${query}`,
    });
    expect(start.statusCode).toBe(302);
    const location = String(start.headers.location);
    if (!person) {
      return { start, acs: null, location, session: '', requestId: '', browser: '', saml: '' };
    }
    const from = options.from ?? idp;
    const request = from.readRequest(location);
    expect(request.acsUrl).toBe(provider.serviceProvider.acsUrl);
    expect(request.issuer).toBe(provider.serviceProvider.spEntityId);
    const browser = cookieNamed(start, 'taskmoor_saml');
    let xml = from.response({
      person,
      acsUrl: request.acsUrl ?? '',
      audience: request.issuer,
      inResponseTo: request.id,
      ...options.response,
    });
    if (options.edit) xml = options.edit(xml);
    const saml = encodeSamlResponse(xml);
    const acs = await postResponse(provider.id, saml);
    const result = await collect(
      acs,
      options.browserCookie ? options.browserCookie(browser) : browser,
    );
    return { ...result, start, acs, requestId: request.id, browser, saml };
  }

  const lastEvent = (type: string) =>
    database.db
      .selectFrom('domain_event')
      .select(['payload', 'subject_id', 'actor_id'])
      .where('type', '=', type as never)
      .orderBy('id', 'desc')
      .executeTakeFirst();

  const refusals = (providerId: number) =>
    database.db
      .selectFrom('audit_event')
      .select(['subject_id', 'details'])
      .where('action', '=', 'sso.sign_in_refused')
      .where(sql<boolean>`details->>'providerId' = ${String(providerId)}`)
      .orderBy('seq')
      .execute()
      .then((rows) => rows.map((r) => (r.details as { reason: string }).reason));

  const userByEmail = (email: string) =>
    database.db
      .selectFrom('app_user')
      .select(['id', 'name', 'password_hash'])
      .where('email', '=', email)
      .executeTakeFirst();

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      passwords,
      peppers,
      publicUrl: ORIGIN,
    });
    await addUser('admin@example.com', { admin: true });
    adminCookie = cookieNamed(await passwordSignIn('admin@example.com'), SESSION_COOKIE);
  });

  afterAll(async () => {
    await app.close();
  });

  it('[IAM-002] administrators add a SAML provider from metadata or by hand and get its addresses', async () => {
    const provider = await createProvider({ name: 'Alpha SAML', domains: ['alpha.example'] });
    expect(provider).toMatchObject({
      protocol: 'saml',
      entityId: idp.entityId,
      ssoUrl: idp.ssoUrl,
      spEntityId: null,
      idpInitiated: false,
      serviceProvider: {
        spEntityId: `${ORIGIN}/api/v1/auth/saml/${provider.id}/metadata`,
        acsUrl: `${ORIGIN}/api/v1/auth/saml/${provider.id}/acs`,
        metadataUrl: `${ORIGIN}/api/v1/auth/saml/${provider.id}/metadata`,
      },
    });
    expect(provider.certificates).toHaveLength(1);
    expect(provider.certificates[0]?.subject).toBe('CN=Fake SAML IdP');
    expect(provider.certificates[0]?.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    expect(provider).not.toHaveProperty('clientId');

    // The service provider metadata the identity provider imports, public.
    const metadata = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/saml/${provider.id}/metadata`,
    });
    expect(metadata.statusCode).toBe(200);
    expect(metadata.headers['content-type']).toContain('application/samlmetadata+xml');
    const doc = new DOMParser().parseFromString(metadata.body, 'text/xml');
    expect(doc.documentElement?.getAttribute('entityID')).toBe(provider.serviceProvider.spEntityId);
    expect(
      doc
        .getElementsByTagNameNS(SAML_NS.metadata, 'AssertionConsumerService')[0]
        ?.getAttribute('Location'),
    ).toBe(provider.serviceProvider.acsUrl);
    expect(
      (await call(undefined, { method: 'GET', url: '/api/v1/auth/saml/9999/metadata' })).statusCode,
    ).toBe(404);

    // The sign-in page sees the protocol, to send the browser to the right start.
    const publicList = await call(undefined, { method: 'GET', url: '/api/v1/auth/providers' });
    expect(publicList.json().providers).toContainEqual({
      id: provider.id,
      name: 'Alpha SAML',
      protocol: 'saml',
    });
    const created = await lastEvent('identity_provider.created');
    expect(created?.payload).toMatchObject({ protocol: 'saml', issuer: idp.entityId });

    // By hand: entity ID, sign-in address and certificate; Taskmoor's entity ID fixed.
    const manual = await call(adminCookie, {
      method: 'POST',
      url: '/api/v1/identity-providers',
      payload: {
        protocol: 'saml',
        name: 'Manual SAML',
        entityId: 'urn:example:idp',
        ssoUrl: 'https://manual.example/sso',
        certificates: [second.signing.certificate],
        spEntityId: 'taskmoor-manual',
        enabled: false,
      },
    });
    expect(manual.statusCode, manual.body).toBe(201);
    expect(manual.json().provider).toMatchObject({
      entityId: 'urn:example:idp',
      spEntityId: 'taskmoor-manual',
      serviceProvider: { spEntityId: 'taskmoor-manual' },
    });

    const refused = async (payload: Record<string, unknown>) =>
      (
        await call(adminCookie, {
          method: 'POST',
          url: '/api/v1/identity-providers',
          payload: { protocol: 'saml', name: 'Refused', ...payload },
        })
      ).json();
    expect(await refused({ metadataXml: '<not metadata/>' })).toMatchObject({
      error: 'invalid_metadata',
    });
    expect(
      await refused({
        entityId: 'urn:x',
        ssoUrl: 'https://x.example/sso',
        certificates: ['not a certificate'],
      }),
    ).toMatchObject({ error: 'invalid_certificate' });
    expect(
      await refused({
        entityId: 'urn:x',
        ssoUrl: 'http://x.example/sso',
        certificates: [second.signing.certificate],
      }),
    ).toMatchObject({ error: 'insecure_sso_url' });
    expect(await refused({ entityId: 'urn:x' })).toMatchObject({ error: 'invalid_request' });
    // OpenID Connect fields do not belong to a SAML provider, and the other way round.
    expect(await refused({ metadataXml: idp.metadata(), clientId: 'x' })).toMatchObject({
      error: 'invalid_request',
    });
    const patchOidcField = await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { clientSecret: 'x' },
    });
    expect(patchOidcField.statusCode).toBe(400);

    // A domain belongs to one enabled provider, whatever its protocol.
    const clash = await refused({ metadataXml: second.metadata(), domains: ['alpha.example'] });
    expect(clash).toMatchObject({ error: 'domain_taken', domains: ['alpha.example'] });

    // Rolling the certificate over: the audit log records fingerprints, not certificates.
    const roll = await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { certificates: [idp.signing.certificate, second.signing.certificate] },
    });
    expect(roll.statusCode, roll.body).toBe(200);
    expect(roll.json().provider.certificates).toHaveLength(2);
    const updated = await lastEvent('identity_provider.updated');
    if (!updated) throw new Error('no event');
    const { changes } = updated.payload as {
      changes: Record<string, { from: unknown; to: unknown }>;
    };
    expect(changes.certificates?.from).toEqual([provider.certificates[0]?.fingerprint]);
    expect(changes.certificates?.to).toHaveLength(2);
    expect(JSON.stringify(updated.payload)).not.toContain('BEGIN CERTIFICATE');

    await call(adminCookie, { method: 'DELETE', url: `/api/v1/identity-providers/${provider.id}` });
    await call(adminCookie, {
      method: 'DELETE',
      url: `/api/v1/identity-providers/${manual.json().provider.id}`,
    });
  });

  it('[IAM-002] people of two domains sign in through two identity providers, each creating the account', async () => {
    const alpha = await createProvider({ name: 'Alpha', domains: ['alpha.example'] });
    const beta = await createProvider({ name: 'Beta', domains: ['beta.example'] }, second);

    const discover = async (email: string) =>
      (
        await call(undefined, { method: 'POST', url: '/api/v1/auth/discover', payload: { email } })
      ).json().provider;
    expect(await discover('ann@alpha.example')).toEqual({
      id: alpha.id,
      name: 'Alpha',
      protocol: 'saml',
    });
    expect(await discover('bob@beta.example')).toEqual({
      id: beta.id,
      name: 'Beta',
      protocol: 'saml',
    });

    const ann = await samlSignIn(
      alpha,
      {
        nameId: 'ann-persistent-1',
        nameIdFormat: NAME_ID_FORMAT.persistent,
        attributes: { email: ['Ann@Alpha.example'], displayName: ['Ann Archer'] },
      },
      { returnTo: '/#/tickets/ALPHA-1' },
    );
    expect(ann.location).toBe(`${ORIGIN}/#/tickets/ALPHA-1`);
    expect(ann.session).not.toBe('');
    const me = await call(ann.session, { method: 'GET', url: '/api/v1/session' });
    expect(me.json().user).toMatchObject({ email: 'ann@alpha.example', name: 'Ann Archer' });
    expect((await userByEmail('ann@alpha.example'))?.password_hash).toBeNull();
    expect((await lastEvent('sso.signed_in'))?.payload).toMatchObject({
      providerId: alpha.id,
      protocol: 'saml',
      userCreated: true,
    });

    const bob = await samlSignIn(
      beta,
      {
        nameId: 'bob@beta.example',
        attributes: { givenName: ['Bob'], sn: ['Baker'] },
      },
      { from: second },
    );
    const bobMe = await call(bob.session, { method: 'GET', url: '/api/v1/session' });
    expect(bobMe.json().user).toMatchObject({ email: 'bob@beta.example', name: 'Bob Baker' });

    // Each provider trusts only its own key: Alpha's answer is no good at Beta.
    const crossed = await samlSignIn(beta, { nameId: 'ann@alpha.example' }, { from: idp });
    expect(crossed.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_error`);
    expect(crossed.session).toBe('');

    // The persistent NameID identifies Ann later, even after her address changed.
    const again = await samlSignIn(alpha, {
      nameId: 'ann-persistent-1',
      nameIdFormat: NAME_ID_FORMAT.persistent,
      attributes: { email: ['ann.archer@alpha.example'] },
    });
    const meAgain = await call(again.session, { method: 'GET', url: '/api/v1/session' });
    expect(meAgain.json().user.id).toBe(me.json().user.id);
    expect((await lastEvent('sso.signed_in'))?.payload).toMatchObject({ userCreated: false });
  });

  it('[IAM-002] an assertion meant for one provider is refused by another sharing its key', async () => {
    // Two providers backed by the same identity provider key (as two applications of one
    // realm are): each has its own entity ID and address, so the audience gives it away.
    const one = await createProvider({ name: 'Shared one', domains: ['one.example'] });
    const two = await createProvider({ name: 'Shared two', domains: ['two.example'] });
    const start = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/saml/${two.id}/start`,
    });
    const request = idp.readRequest(String(start.headers.location));
    const forOne = idp.post({
      person: { nameId: 'carl@two.example' },
      acsUrl: two.serviceProvider.acsUrl,
      audience: one.serviceProvider.spEntityId,
      inResponseTo: request.id,
    });
    const acs = await postResponse(two.id, forOne);
    expect(acs.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_error`);
    expect(await refusals(two.id)).toEqual(['response_audience']);
  });

  it('[IAM-002] a group attribute adds and removes memberships of the mapped groups at each sign-in', async () => {
    const engineers = await addGroup('saml-engineers');
    const managers = await addGroup('saml-managers');
    const local = await addGroup('saml-local');
    const provider = await createProvider({
      name: 'Groups SAML',
      domains: ['groups.example'],
      groupClaim: 'memberOf',
      groupMap: [
        { claimValue: 'eng', groupId: engineers },
        { claimValue: 'mgmt', groupId: managers },
      ],
    });
    const dana = { nameId: 'dana@groups.example', attributes: { memberOf: ['eng', 'mgmt'] } };
    await samlSignIn(provider, dana);
    const user = await userByEmail('dana@groups.example');
    if (!user) throw new Error('no account');
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

    await samlSignIn(provider, { ...dana, attributes: { memberOf: ['eng'] } });
    expect(await groupsOf()).toEqual([engineers, local].sort((a, b) => a - b));
    expect((await lastEvent('sso.signed_in'))?.payload).toMatchObject({
      groupsAdded: [],
      groupsRemoved: [managers],
    });
  });

  it('[IAM-002] links or creates accounts only for addresses of served domains, and audits refusals', async () => {
    const provider = await createProvider({
      name: 'Initrode',
      domains: ['initrode.example'],
      jit: false,
      emailAttribute: 'mailAddress',
    });
    const existing = await addUser('milton@initrode.example');
    const at = async (person: SamlPerson) => (await samlSignIn(provider, person)).location;

    // The configured attribute is missing: no address the provider vouches for.
    expect(await at({ nameId: 'm-1', attributes: { email: ['milton@initrode.example'] } })).toBe(
      `${ORIGIN}/#/sign-in?sso_error=email_unverified`,
    );
    expect(
      await at({ nameId: 'm-1', attributes: { mailAddress: ['milton@elsewhere.example'] } }),
    ).toBe(`${ORIGIN}/#/sign-in?sso_error=domain_not_allowed`);
    expect(
      await at({ nameId: 'n-1', attributes: { mailAddress: ['nobody@initrode.example'] } }),
    ).toBe(`${ORIGIN}/#/sign-in?sso_error=no_account`);
    const linked = await samlSignIn(provider, {
      nameId: 'm-1',
      attributes: { mailAddress: ['milton@initrode.example'] },
    });
    const me = await call(linked.session, { method: 'GET', url: '/api/v1/session' });
    expect(me.json().user.id).toBe(existing);

    await database.db
      .updateTable('app_user')
      .set({ deactivated_at: new Date() })
      .where('id', '=', existing)
      .execute();
    expect(
      await at({ nameId: 'm-1', attributes: { mailAddress: ['milton@initrode.example'] } }),
    ).toBe(`${ORIGIN}/#/sign-in?sso_error=account_deactivated`);
    expect(await refusals(provider.id)).toEqual([
      'email_unverified',
      'domain_not_allowed',
      'no_account',
      'account_deactivated',
    ]);
  });

  it('[IAM-002] a transient NameID identifies the person by address', async () => {
    const provider = await createProvider({ name: 'Transient', domains: ['transient.example'] });
    const person = (nameId: string) => ({
      nameId,
      nameIdFormat: NAME_ID_FORMAT.transient,
      attributes: { mail: ['tess@transient.example'] },
    });
    const first = await samlSignIn(provider, person('_t1'));
    const again = await samlSignIn(provider, person('_t2'));
    const a = await call(first.session, { method: 'GET', url: '/api/v1/session' });
    const b = await call(again.session, { method: 'GET', url: '/api/v1/session' });
    expect(b.json().user.id).toBe(a.json().user.id);
    const links = await database.db
      .selectFrom('user_identity')
      .select('subject')
      .where('provider_id', '=', provider.id)
      .execute();
    expect(links).toEqual([{ subject: 'email:tess@transient.example' }]);
  });

  it('[IAM-002] refuses unsigned, expired, wrapped and misaddressed responses; audits what the provider signed', async () => {
    const provider = await createProvider({ name: 'Strict', domains: ['strict.example'] });
    const erin = { nameId: 'erin@strict.example' };
    const location = async (options: Parameters<typeof samlSignIn>[2]) =>
      (await samlSignIn(provider, erin, options)).location;
    const refused = `${ORIGIN}/#/sign-in?sso_error=provider_error`;

    expect(await location({ response: { sign: 'none' } })).toBe(refused);
    expect(await location({ response: { now: new Date(Date.now() - 60 * 60 * 1000) } })).toBe(
      refused,
    );
    expect(await location({ response: { recipient: `${ORIGIN}/elsewhere` } })).toBe(refused);
    expect(await location({ response: { issuer: 'https://idp.other.test' } })).toBe(refused);
    // XSW3: an unsigned assertion slipped in before the signed one.
    const wrapped = await location({
      edit: (xml) => {
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const assertion = doc.getElementsByTagNameNS(SAML_NS.assertion, 'Assertion')[0] as Element;
        const evil = new DOMParser().parseFromString(
          idp.assertionXml(
            {
              person: { nameId: 'admin@strict.example' },
              acsUrl: provider.serviceProvider.acsUrl,
              audience: provider.serviceProvider.spEntityId,
            },
            '_evil',
          ),
          'text/xml',
        ).documentElement as Element;
        assertion.parentNode?.insertBefore(doc.importNode(evil, true), assertion);
        return new XMLSerializer().serializeToString(doc);
      },
    });
    expect(wrapped).toBe(refused);
    // The provider signed the expired, misaddressed and foreign-issuer ones; nobody signed the
    // others.
    expect(await refusals(provider.id)).toEqual([
      'response_expired',
      'response_recipient',
      'response_issuer',
    ]);
    expect(await userByEmail('erin@strict.example')).toBeUndefined();
    expect(await userByEmail('admin@strict.example')).toBeUndefined();

    // A form without a response, and garbage, end the same way.
    const empty = await call(undefined, {
      method: 'POST',
      url: `/api/v1/auth/saml/${provider.id}/acs`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'RelayState=x',
    });
    expect(empty.statusCode).toBe(303);
    expect(empty.headers.location).toBe(refused);
    expect((await postResponse(provider.id, '!!!')).headers.location).toBe(refused);
  });

  it('[IAM-002] a response is used once, answers a request of this browser, and only that browser collects it', async () => {
    const provider = await createProvider({ name: 'Bound', domains: ['bound.example'] });
    const fay = { nameId: 'fay@bound.example' };

    // Replay: the same response a second time.
    const ok = await samlSignIn(provider, fay);
    expect(ok.session).not.toBe('');
    const replay = await collect(await postResponse(provider.id, ok.saml), ok.browser);
    expect(replay.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);

    // A response to a request this service provider never sent (or already answered).
    const start = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/saml/${provider.id}/start`,
    });
    const browser = cookieNamed(start, 'taskmoor_saml');
    const forged = idp.post({
      person: fay,
      acsUrl: provider.serviceProvider.acsUrl,
      audience: provider.serviceProvider.spEntityId,
      inResponseTo: '_never-sent',
    });
    expect((await collect(await postResponse(provider.id, forged), browser)).location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=invalid_state`,
    );
    expect(await refusals(provider.id)).toEqual(['response_replayed', 'response_unknown_request']);

    // Another browser, or none, cannot collect the sign-in; the right one still can, once.
    const stranger = await samlSignIn(provider, fay, {
      browserCookie: () => 'taskmoor_saml=someone-else',
    });
    expect(stranger.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);
    const none = await samlSignIn(provider, fay, { browserCookie: () => '' });
    expect(none.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);
    const handle = String(none.acs?.headers.location);
    const owner = await call(undefined, {
      method: 'GET',
      url: new URL(handle).pathname + new URL(handle).search,
      headers: { cookie: none.browser },
    });
    expect(cookieNamed(owner, SESSION_COOKIE)).not.toBe('');
    const twice = await call(undefined, {
      method: 'GET',
      url: new URL(handle).pathname + new URL(handle).search,
      headers: { cookie: none.browser },
    });
    expect(twice.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);

    // The return address stays on this site.
    const away = await samlSignIn(provider, fay, { returnTo: '//evil.example/steal' });
    expect(away.location).toBe(`${ORIGIN}/`);
  });

  it('[IAM-002] IdP-initiated sign-in is refused unless the provider allows it', async () => {
    const provider = await createProvider({ name: 'Portal', domains: ['portal.example'] });
    const unsolicited = () =>
      idp.post({
        person: { nameId: 'gus@portal.example' },
        acsUrl: provider.serviceProvider.acsUrl,
        audience: provider.serviceProvider.spEntityId,
        inResponseTo: null,
      });
    const off = await collect(await postResponse(provider.id, unsolicited(), '/#/settings'), '');
    expect(off.location).toBe(`${ORIGIN}/#/sign-in?sso_error=invalid_state`);
    expect(await refusals(provider.id)).toEqual(['response_unsolicited']);

    await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { idpInitiated: true },
    });
    const on = await collect(await postResponse(provider.id, unsolicited(), '/#/settings'), '');
    expect(on.location).toBe(`${ORIGIN}/#/settings`);
    expect(on.session).not.toBe('');
    const away = await collect(
      await postResponse(provider.id, unsolicited(), 'https://evil.example/'),
      '',
    );
    expect(away.location).toBe(`${ORIGIN}/`);
  });

  it('[IAM-004] a SAML provider enforcing single sign-on refuses passwords except break-glass', async () => {
    const provider = await createProvider({
      name: 'Enforcer',
      domains: ['enforced.example'],
      enforceSso: true,
    });
    await addUser('hal@enforced.example');
    await addUser('root@enforced.example', { breakGlass: true });
    const refused = await passwordSignIn('hal@enforced.example');
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({
      error: 'sso_required',
      provider: { id: provider.id, name: 'Enforcer', protocol: 'saml' },
    });
    expect((await passwordSignIn('root@enforced.example')).json()).toMatchObject({
      status: 'signed_in',
    });
  });

  it('[IAM-002] a disabled provider neither starts nor accepts sign-ins', async () => {
    const provider = await createProvider({ name: 'Paused', domains: ['paused.example'] });
    const issued = await samlSignIn(provider, null);
    const request = idp.readRequest(issued.location);
    await call(adminCookie, {
      method: 'PATCH',
      url: `/api/v1/identity-providers/${provider.id}`,
      payload: { enabled: false },
    });
    const start = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/saml/${provider.id}/start`,
    });
    expect(start.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_unavailable`);
    const late = idp.post({
      person: { nameId: 'ivy@paused.example' },
      acsUrl: provider.serviceProvider.acsUrl,
      audience: provider.serviceProvider.spEntityId,
      inResponseTo: request.id,
    });
    expect((await postResponse(provider.id, late)).headers.location).toBe(
      `${ORIGIN}/#/sign-in?sso_error=provider_unavailable`,
    );
    // An OpenID Connect start does not serve a SAML provider.
    const wrongDoor = await call(undefined, {
      method: 'GET',
      url: `/api/v1/auth/oidc/${provider.id}/start`,
    });
    expect(wrongDoor.headers.location).toBe(`${ORIGIN}/#/sign-in?sso_error=provider_unavailable`);
  });
});
