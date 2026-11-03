import type { Database } from '@taskmoor/db';
import { newToken, tokenHash } from '@taskmoor/iam';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { recordSsoRefusal } from '../audit/record';
import type { Authorizer } from '../authz/authorizer';
import type { OriginPolicy } from '../origins';
import { PROVIDER_COLUMNS, type Provider, returnAddress, safeReturnTo } from '../sso/oidc';
import {
  authnRequestUrl,
  decodeSamlResponse,
  newRequestId,
  SAML_MAX_RESPONSE_BYTES,
  type SamlAssertion,
  SamlError,
  serviceProviderMetadata,
  verifySamlResponse,
} from '../sso/saml';
import { samlEndpoints, samlIdentity } from '../sso/saml-provider';
import { completeSsoSignIn, type SsoIdentity } from '../sso/sign-in';

export const SAML_COOKIE = 'taskmoor_saml';
const COOKIE_PATH = '/api/v1/auth/saml';
/** How long a person may take at the identity provider. */
const LOGIN_TTL_MS = 10 * 60 * 1000;
/** How long a verified response waits for its browser: one redirect. */
const HANDOFF_TTL_MS = 2 * 60 * 1000;

const id = z.coerce.number().int().positive();
const identitySchema = z.object({
  subject: z.string().min(1),
  email: z.string().nullable(),
  emailVerified: z.boolean(),
  name: z.string().nullable(),
  groups: z.array(z.string()),
});

/**
 * SAML 2.0 sign-in (M1-081; IAM-002, IAM-004, ADR-019). Per provider:
 *
 * - `GET /api/v1/auth/saml/:id/metadata`: Taskmoor's metadata for the provider to import.
 * - `GET /api/v1/auth/saml/:id/start`: an AuthnRequest over HTTP-Redirect; its ID is stored
 *   bound to this browser (a cookie), like the OpenID Connect state.
 * - `POST /api/v1/auth/saml/:id/acs`: the provider's response (HTTP-POST). It is verified
 *   (`sso/saml.ts`), its assertion ID goes into the replay cache, and its InResponseTo must be
 *   a pending request of this provider; an unsolicited response is accepted only from a
 *   provider allowed to start sign-ins. The person then waits under a one-time handle.
 * - `GET /api/v1/auth/saml/continue`: the browser collects that sign-in. The response came
 *   by a cross-site POST, which carries no SameSite=Lax cookie, so the browser is checked
 *   here, after a redirect, where the cookie is sent: a response posted from another browser
 *   cannot complete the sign-in.
 */
export async function registerSamlRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: {
    secureCookies: boolean;
    authorizer: Authorizer;
    publicUrl: string;
    /** Frontends a sign-in may return to (M1-107, M1-108). */
    origins: OriginPolicy;
  },
): Promise<void> {
  const base = options.publicUrl.replace(/\/+$/, '');
  const frontends = async () => (await options.origins.current()).frontends;

  async function loadSamlProvider(workspaceId: number, providerId: number) {
    const row = (await db
      .selectFrom('identity_provider')
      .select([...PROVIDER_COLUMNS])
      .where('id', '=', providerId)
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', 'saml')
      .executeTakeFirst()) as Provider | undefined;
    return row;
  }

  // 303 after the POST, so the browser follows with a GET.
  const fail = (reply: FastifyReply, code: string, status: 302 | 303 = 302) =>
    reply.redirect(`${base}/#/sign-in?sso_error=${encodeURIComponent(code)}`, status);

  /** A refusal the provider stood behind goes to the audit log (IAM-013). */
  const audit = (
    request: FastifyRequest,
    provider: Provider,
    reason: string,
    extra: { email?: string | null; userId?: number | null } = {},
  ) =>
    recordSsoRefusal(db, {
      workspaceId: request.workspaceId,
      ip: request.ip,
      providerId: provider.id,
      userId: extra.userId ?? null,
      email: extra.email ?? null,
      reason,
    });

  app.get('/api/v1/auth/saml/:id/metadata', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid_request' });
    // Disabled providers too: their identity provider is set up before they are switched on.
    const provider = await loadSamlProvider(request.workspaceId, params.data.id);
    if (!provider) return reply.code(404).send({ error: 'not_found' });
    const endpoints = samlEndpoints(base, provider);
    return reply
      .type('application/samlmetadata+xml; charset=utf-8')
      .send(serviceProviderMetadata({ entityId: endpoints.spEntityId, acsUrl: endpoints.acsUrl }));
  });

  app.get('/api/v1/auth/saml/:id/start', async (request, reply) => {
    const params = z.object({ id }).safeParse(request.params);
    const query = z.object({ returnTo: z.string().max(500).optional() }).safeParse(request.query);
    if (!params.success || !query.success) {
      return reply.code(400).send({ error: 'invalid_request' });
    }
    const provider = await loadSamlProvider(request.workspaceId, params.data.id);
    if (!provider?.enabled || !provider.saml_sso_url) return fail(reply, 'provider_unavailable');
    const endpoints = samlEndpoints(base, provider);
    const requestId = newRequestId();
    const location = authnRequestUrl({
      id: requestId,
      ssoUrl: provider.saml_sso_url,
      spEntityId: endpoints.spEntityId,
      acsUrl: endpoints.acsUrl,
    });
    const browser = newToken();
    await db
      .insertInto('saml_login')
      .values({
        workspace_id: request.workspaceId,
        provider_id: provider.id,
        request_id: requestId,
        browser_hash: tokenHash(browser),
        return_to: safeReturnTo(query.data.returnTo, await frontends()),
        expires_at: new Date(Date.now() + LOGIN_TTL_MS),
      })
      .execute();
    reply.setCookie(SAML_COOKIE, browser, {
      path: COOKIE_PATH,
      httpOnly: true,
      // Sent with the top-level GET to /continue that follows the provider's POST.
      sameSite: 'lax',
      secure: options.secureCookies,
      maxAge: LOGIN_TTL_MS / 1000,
    });
    return reply.redirect(location, 302);
  });

  // The provider posts a form: the parser lives in this scope only.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: Math.ceil((SAML_MAX_RESPONSE_BYTES * 4) / 3) * 2 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

    scope.post('/api/v1/auth/saml/:id/acs', async (request, reply) => {
      const params = z.object({ id }).safeParse(request.params);
      const form = z
        .object({ SAMLResponse: z.string().min(1), RelayState: z.string().max(1000).optional() })
        .safeParse(request.body);
      if (!params.success || !form.success) return fail(reply, 'provider_error', 303);
      const ws = request.workspaceId;
      const provider = await loadSamlProvider(ws, params.data.id);
      if (!provider?.enabled) return fail(reply, 'provider_unavailable', 303);
      const endpoints = samlEndpoints(base, provider);

      let assertion: SamlAssertion;
      try {
        assertion = verifySamlResponse(decodeSamlResponse(form.data.SAMLResponse), {
          certificates: provider.saml_certificates,
          idpEntityId: provider.issuer,
          spEntityId: endpoints.spEntityId,
          acsUrl: endpoints.acsUrl,
        });
      } catch (error) {
        if (!(error instanceof SamlError)) throw error;
        request.log.warn(
          { provider: provider.id, reason: error.reason, detail: error.message },
          'SAML response refused',
        );
        // Anyone can post a broken or forged response; only what the provider signed is
        // audited.
        if (error.vouched) await audit(request, provider, `response_${error.reason}`);
        return fail(reply, 'provider_error', 303);
      }

      const identity = samlIdentity(provider, assertion);
      if (!identity.subject) {
        await audit(request, provider, 'email_unverified');
        return fail(reply, 'email_unverified', 303);
      }
      // Each assertion is used once: its ID stays until the assertion could no longer be
      // accepted anyway.
      const fresh = await db
        .insertInto('saml_assertion')
        .values({
          workspace_id: ws,
          assertion_id: assertion.assertionId,
          provider_id: provider.id,
          expires_at: assertion.replayUntil,
        })
        .onConflict((oc) => oc.columns(['workspace_id', 'assertion_id']).doNothing())
        .returning('assertion_id')
        .executeTakeFirst();
      if (!fresh) {
        await audit(request, provider, 'response_replayed', { email: identity.email });
        return fail(reply, 'invalid_state', 303);
      }

      const handle = newToken();
      const waiting = {
        handle_hash: tokenHash(handle),
        identity: JSON.stringify(identity),
        expires_at: new Date(Date.now() + HANDOFF_TTL_MS),
      };
      if (assertion.inResponseTo !== null) {
        // The answer to a request this provider was sent, still pending.
        const login = await db
          .updateTable('saml_login')
          .set(waiting)
          .where('workspace_id', '=', ws)
          .where('provider_id', '=', provider.id)
          .where('request_id', '=', assertion.inResponseTo)
          .where('handle_hash', 'is', null)
          .where('expires_at', '>', new Date())
          .returning('id')
          .executeTakeFirst();
        if (!login) {
          await audit(request, provider, 'response_unknown_request', { email: identity.email });
          return fail(reply, 'invalid_state', 303);
        }
      } else {
        if (!provider.saml_idp_initiated) {
          await audit(request, provider, 'response_unsolicited', { email: identity.email });
          return fail(reply, 'invalid_state', 303);
        }
        await db
          .insertInto('saml_login')
          .values({
            workspace_id: ws,
            provider_id: provider.id,
            return_to: safeReturnTo(form.data.RelayState, await frontends()),
            ...waiting,
          })
          .execute();
      }
      return reply.redirect(
        `${base}/api/v1/auth/saml/continue?handle=${encodeURIComponent(handle)}`,
        303,
      );
    });
  });

  app.get('/api/v1/auth/saml/continue', async (request, reply) => {
    const query = z.object({ handle: z.string().min(1).max(200) }).safeParse(request.query);
    const browser = request.cookies[SAML_COOKIE];
    reply.clearCookie(SAML_COOKIE, { path: COOKIE_PATH });
    if (!query.success) return fail(reply, 'invalid_state');
    const ws = request.workspaceId;
    // Only the browser that started the sign-in collects it (IdP-initiated ones have none),
    // and only once.
    const login = await db
      .deleteFrom('saml_login')
      .where('workspace_id', '=', ws)
      .where('handle_hash', '=', tokenHash(query.data.handle))
      .where((eb) =>
        eb.or([
          eb('browser_hash', 'is', null),
          eb('browser_hash', '=', browser ? tokenHash(browser) : ''),
        ]),
      )
      .returning(['provider_id', 'identity', 'return_to', 'expires_at'])
      .executeTakeFirst();
    if (!login || login.expires_at < new Date()) return fail(reply, 'invalid_state');
    const identity = identitySchema.safeParse(login.identity);
    const provider = await loadSamlProvider(ws, login.provider_id);
    if (!provider?.enabled || !identity.success) return fail(reply, 'provider_unavailable');
    const person: SsoIdentity = identity.data;
    const outcome = await completeSsoSignIn(
      db,
      request,
      reply,
      { id: provider.id, protocol: 'saml', domains: provider.domains, jit: provider.jit },
      person,
      { secureCookies: options.secureCookies, authorizer: options.authorizer },
    );
    if (outcome.error) {
      await audit(request, provider, outcome.error, {
        email: person.email,
        userId: outcome.userId ?? null,
      });
      return fail(reply, outcome.error);
    }
    return reply.redirect(returnAddress(base, login.return_to), 302);
  });
}
