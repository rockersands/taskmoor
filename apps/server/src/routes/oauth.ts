import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin } from '../auth';
import { emit } from '../events/bus';
import type { DomainEventInput } from '../events/catalogue';
import { readMcpSettings } from '../mcp/settings';
import {
  type ClientScope,
  clientCount,
  findClient,
  MAX_CLIENTS,
  newClientId,
  pendingRequest,
  redirectMatches,
  registrationBody,
  registrationProblem,
  requestedScope,
  savePendingRequest,
} from '../oauth/clients';
import {
  CHALLENGE,
  exchangeCode,
  type GrantOutcome,
  issueCode,
  refreshTokens,
  revokeToken,
  WEB_CLIENT_ID,
} from '../oauth/tokens';
import type { OriginPolicy } from '../origins';

/**
 * The OAuth 2.1 authorization server for frontends on another site (M1-107; IAM-024, API-002,
 * ADR-080). One public client for the frontend kits (`taskmoor-web`), with the redirect URIs the
 * install lists and those of the frontends a site administrator registered (M1-108, ADR-087).
 *
 * - `GET /api/v1/oauth/authorize`: code flow with PKCE (S256). A browser signed in at this
 *   backend (its cookie, first-party here) gets a code at once; anyone else goes to this
 *   backend's own sign-in page, which comes back here when done. The answer names the issuer
 *   (RFC 9207). The first-party client needs no consent screen; other clients would (M1-072).
 * - `POST /api/v1/oauth/token`: the code (with its verifier) or a refresh token for a new
 *   access token (ten minutes) and refresh token. A spent refresh token or code that comes back
 *   ends its family and the browser session behind it (reuse detection, IAM-024 (2)).
 * - `POST /api/v1/oauth/revoke`: RFC 7009, the client gives a token back and its family ends.
 *
 * Token requests are forms (RFC 6749) or JSON; the form parser lives in their scope only.
 *
 * MCP clients (M1-072; ADR-084) register themselves and need the person's consent:
 *
 * - `GET /.well-known/oauth-authorization-server` (RFC 8414) and
 *   `GET /.well-known/oauth-protected-resource/api/v1/mcp` (RFC 9728) say where everything is.
 * - `POST /api/v1/oauth/register` (RFC 7591) registers a public client while the MCP server and
 *   its client registration are on.
 * - `GET /api/v1/oauth/authorize` with a registered client checks the request, keeps it for ten
 *   minutes and sends the browser to sign in, then to the consent page with the request's id.
 *   `GET` and `POST /api/v1/oauth/requests/:id` show the request to the signed-in person and
 *   take their answer: approved (possibly read only), the client gets a code; refused, it gets
 *   `access_denied`. Only a browser session answers, never a token.
 * - `GET` and `DELETE /api/v1/admin/oauth-clients` list the registered clients and remove one
 *   with every grant it holds (site administrators).
 */
export interface OAuthRouteOptions {
  publicUrl: string;
  /** Where the web client may be sent back, exact URLs: the environment's and the registered. */
  origins: OriginPolicy;
  /** Access-token lifetime; ten minutes unless a test shortens it. */
  accessTtlMs?: number;
}

/** The MCP endpoint's address: what registered clients' tokens are for (RFC 8707). */
export const mcpResource = (publicUrl: string) => `${publicUrl.replace(/\/+$/, '')}/api/v1/mcp`;
/** Where the MCP endpoint's protected resource metadata is (RFC 9728 section 3.1). */
export function resourceMetadataUrl(publicUrl: string): string {
  const url = new URL(mcpResource(publicUrl));
  return `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
}

const authorizeQuery = z.object({
  response_type: z.string().max(50).optional(),
  client_id: z.string().max(100),
  redirect_uri: z.string().max(2000),
  resource: z.string().max(2000).optional(),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(2000).optional(),
  scope: z.string().max(500).optional(),
});
/** The way back from sign-in to a stored request (M1-072). */
const resumeQuery = z.object({ request: z.string().min(20).max(100) }).strict();
const requestParams = z.object({ id: z.string().min(20).max(100) }).strict();
const consentBody = z
  .object({ approve: z.boolean(), scope: z.enum(['read', 'read write']).optional() })
  .strict();
const clientParams = z.object({ id: z.string().min(1).max(100) }).strict();

const tokenBody = z.discriminatedUnion('grant_type', [
  z.object({
    grant_type: z.literal('authorization_code'),
    client_id: z.string().max(100),
    code: z.string().min(1).max(200),
    redirect_uri: z.string().max(2000),
    code_verifier: z.string().min(1).max(200),
  }),
  z.object({
    grant_type: z.literal('refresh_token'),
    client_id: z.string().max(100),
    refresh_token: z.string().min(1).max(200),
  }),
]);

const revokeBody = z.object({
  token: z.string().min(1).max(200),
  client_id: z.string().max(100),
  token_type_hint: z.string().max(50).optional(),
});

/** What a grant leaves in the event log: a started family, or the sessions reuse ended. */
function grantEvent(outcome: GrantOutcome, started: boolean): DomainEventInput | null {
  if (outcome.ok) {
    return started
      ? {
          type: 'session.started',
          subjectId: outcome.userId,
          payload: { sessionId: outcome.familyId, method: 'oauth' },
        }
      : null;
  }
  return outcome.revoked
    ? {
        type: 'session.revoked',
        subjectId: outcome.revoked.userId,
        payload: { count: outcome.revoked.count, by: 'reuse' },
      }
    : null;
}

const noStore = (reply: FastifyReply) =>
  reply.header('cache-control', 'no-store').header('pragma', 'no-cache');

export async function registerOAuthRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: OAuthRouteOptions,
): Promise<void> {
  const base = options.publicUrl.replace(/\/+$/, '');
  const issuer = new URL(options.publicUrl).origin;

  const resource = mcpResource(options.publicUrl);
  /** Only this backend's own cookie session approves anything, never a token. */
  const cookieSession = (request: FastifyRequest) =>
    request.authSession && !request.apiToken && !request.tokenFamily ? request.authSession : null;
  const toSignIn = (reply: FastifyReply, continueTo: string) =>
    reply.redirect(`${base}/#/sign-in?continue=${encodeURIComponent(continueTo)}`, 302);
  const toConsent = (reply: FastifyReply, id: string) =>
    reply.redirect(`${base}/#/oauth/consent?request=${encodeURIComponent(id)}`, 302);
  const backTo = (
    redirectUri: string,
    state: string | null | undefined,
    params: Record<string, string>,
  ) => {
    const url = new URL(redirectUri);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    if (state !== undefined && state !== null) url.searchParams.set('state', state);
    url.searchParams.set('iss', issuer);
    return url.href;
  };

  app.get('/api/v1/oauth/authorize', async (request, reply) => {
    noStore(reply);
    const workspaceId = request.workspaceId;
    // Back from sign-in with a stored request (M1-072): on to the consent page.
    const resume = resumeQuery.safeParse(request.query);
    if (resume.success) {
      const pending = await pendingRequest(db, workspaceId, resume.data.request);
      if (!pending) {
        return reply.code(400).send({ error: 'invalid_request', reason: 'request_expired' });
      }
      if (!cookieSession(request)) return toSignIn(reply, request.url);
      return toConsent(reply, resume.data.request);
    }
    const query = authorizeQuery.safeParse(request.query);
    const client =
      query.success && query.data.client_id !== WEB_CLIENT_ID
        ? await findClient(db, workspaceId, query.data.client_id)
        : null;
    const known =
      query.success &&
      (query.data.client_id === WEB_CLIENT_ID
        ? (await options.origins.current()).redirectUris.has(query.data.redirect_uri)
        : client !== null && redirectMatches(client.redirectUris, query.data.redirect_uri));
    // Never redirect to an address that is not registered: answer here instead.
    if (!query.success || !known) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'unknown_client_or_uri' });
    }
    const q = query.data;
    const back = (params: Record<string, string>) =>
      reply.redirect(backTo(q.redirect_uri, q.state, params), 302);
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (q.code_challenge_method !== 'S256' || !CHALLENGE.test(q.code_challenge ?? '')) {
      return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    }
    if (client) {
      if (!(await readMcpSettings(db)).enabled) {
        return back({ error: 'access_denied', error_description: 'The MCP server is turned off' });
      }
      const scope = requestedScope(q.scope);
      if (!scope) return back({ error: 'invalid_scope' });
      // RFC 8707: the one resource these clients' tokens are for.
      if (q.resource !== undefined && q.resource.replace(/\/+$/, '') !== resource) {
        return back({ error: 'invalid_target' });
      }
      const id = await savePendingRequest(db, workspaceId, {
        clientId: client.id,
        redirectUri: q.redirect_uri,
        challenge: q.code_challenge as string,
        state: q.state ?? null,
        scope,
      });
      if (!cookieSession(request)) {
        return toSignIn(reply, `/api/v1/oauth/authorize?request=${encodeURIComponent(id)}`);
      }
      return toConsent(reply, id);
    }
    // The first-party frontends need no consent: a signed-in browser gets a code at once.
    const session = cookieSession(request);
    if (!session) return toSignIn(reply, request.url);
    const code = await issueCode(db, {
      workspaceId,
      sessionId: session.id,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      challenge: q.code_challenge as string,
    });
    return back({ code });
  });

  // The consent page's request and the person's answer (M1-072).
  app.get('/api/v1/oauth/requests/:id', async (request, reply) => {
    noStore(reply);
    const params = requestParams.safeParse(request.params);
    const pending = params.success
      ? await pendingRequest(db, request.workspaceId, params.data.id)
      : null;
    // Unknown or expired says so before signing in (D35): the id is random and says nothing else.
    if (!pending) return reply.code(404).send({ error: 'not_found' });
    if (!cookieSession(request)) return reply.code(401).send({ error: 'not_signed_in' });
    return {
      request: {
        client: {
          id: pending.client.id,
          name: pending.client.name,
          clientUri: pending.client.clientUri,
          registeredAt: pending.client.createdAt.toISOString(),
        },
        redirectUri: pending.redirectUri,
        scope: pending.scope,
      },
    };
  });

  app.post('/api/v1/oauth/requests/:id', async (request, reply) => {
    noStore(reply);
    const session = cookieSession(request);
    if (!session) return reply.code(401).send({ error: 'not_signed_in' });
    const params = requestParams.safeParse(request.params);
    const body = consentBody.safeParse(request.body);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    if (!body.success) return reply.code(400).send({ error: 'invalid_fields' });
    const workspaceId = request.workspaceId;
    const answer = await db.transaction().execute(async (trx) => {
      const pending = await pendingRequest(trx, workspaceId, params.data.id, { take: true });
      if (!pending) return { status: 404 as const };
      // The person may give less than was asked, never more.
      const scope: ClientScope = body.data.scope ?? pending.scope;
      if (scope === 'read write' && pending.scope === 'read') return { status: 400 as const };
      const approved = body.data.approve;
      const answerParams = approved
        ? {
            code: await issueCode(trx, {
              workspaceId,
              sessionId: session.id,
              clientId: pending.clientId,
              redirectUri: pending.redirectUri,
              challenge: pending.challenge,
              scope,
            }),
          }
        : { error: 'access_denied' };
      await emit(
        trx,
        { workspaceId, actorId: session.user.id },
        {
          type: 'oauth_client.consent',
          subjectId: pending.clientId,
          payload: { name: pending.client.name, approved, scope: approved ? scope : null },
        },
      );
      return {
        status: 200 as const,
        redirect: backTo(pending.redirectUri, pending.state, answerParams),
      };
    });
    if (answer.status === 404) return reply.code(404).send({ error: 'not_found' });
    if (answer.status === 400) {
      return reply
        .code(400)
        .send({ error: 'invalid_fields', fields: { scope: 'more_than_asked' } });
    }
    return { redirect: answer.redirect };
  });

  // Self-registration (RFC 7591) while the MCP server and its registration are on.
  app.post('/api/v1/oauth/register', async (request, reply) => {
    noStore(reply);
    const settings = await readMcpSettings(db);
    if (!settings.enabled || !settings.oauthRegistration) {
      return reply
        .code(403)
        .send({ error: 'access_denied', error_description: 'Client registration is turned off' });
    }
    const body = registrationBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ error: 'invalid_client_metadata', error_description: 'Not a registration' });
    }
    const problem = registrationProblem(body.data);
    if (problem) {
      return reply.code(400).send({
        error: problem.startsWith('redirect_uris')
          ? 'invalid_redirect_uri'
          : 'invalid_client_metadata',
        error_description: problem,
      });
    }
    const workspaceId = request.workspaceId;
    if ((await clientCount(db, workspaceId)) >= MAX_CLIENTS) {
      return reply.code(400).send({
        error: 'invalid_client_metadata',
        error_description: 'This site holds as many registered clients as it takes',
      });
    }
    const id = newClientId();
    const name = body.data.client_name ?? 'Unnamed client';
    const created = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('oauth_client')
        .values({
          id,
          workspace_id: workspaceId,
          name,
          redirect_uris: body.data.redirect_uris,
          client_uri: body.data.client_uri ?? null,
          software_id: body.data.software_id ?? null,
          software_version: body.data.software_version ?? null,
          registered_ip: request.ip,
        })
        .returning('created_at')
        .executeTakeFirstOrThrow();
      await emit(
        trx,
        { workspaceId, actorId: null },
        {
          type: 'oauth_client.registered',
          subjectId: id,
          payload: { name, redirectUris: body.data.redirect_uris },
        },
      );
      return row.created_at;
    });
    return reply.code(201).send({
      client_id: id,
      client_id_issued_at: Math.floor(created.getTime() / 1000),
      client_name: name,
      redirect_uris: body.data.redirect_uris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: requestedScope(body.data.scope) === 'read' ? 'read' : 'read write',
    });
  });

  // Registered clients, for site administrators: removing one ends every grant it holds.
  app.get('/api/v1/admin/oauth-clients', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const now = new Date();
    const rows = await db
      .selectFrom('oauth_client as c')
      .select([
        'c.id',
        'c.name',
        'c.redirect_uris',
        'c.client_uri',
        'c.software_id',
        'c.software_version',
        'c.created_at',
        'c.last_used_at',
      ])
      .select((eb) =>
        eb
          .selectFrom('user_session as s')
          .select((e) => e.fn.countAll<string>().as('n'))
          .whereRef('s.client_id', '=', 'c.id')
          .where('s.expires_at', '>', now)
          .as('grants'),
      )
      .where('c.workspace_id', '=', request.workspaceId)
      .orderBy('c.created_at', 'desc')
      .execute();
    return {
      clients: rows.map((r) => ({
        id: r.id,
        name: r.name,
        redirectUris: r.redirect_uris,
        clientUri: r.client_uri,
        software: r.software_id ? { id: r.software_id, version: r.software_version ?? null } : null,
        registeredAt: r.created_at.toISOString(),
        lastUsedAt: r.last_used_at ? r.last_used_at.toISOString() : null,
        grants: Number(r.grants ?? 0),
      })),
    };
  });

  app.delete('/api/v1/admin/oauth-clients/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const params = clientParams.safeParse(request.params);
    if (!params.success) return reply.code(404).send({ error: 'not_found' });
    const workspaceId = request.workspaceId;
    const gone = await db.transaction().execute(async (trx) => {
      const client = await findClient(trx, workspaceId, params.data.id);
      if (!client) return false;
      const ended = await trx
        .deleteFrom('user_session')
        .where('workspace_id', '=', workspaceId)
        .where('client_id', '=', client.id)
        .executeTakeFirst();
      await trx.deleteFrom('oauth_code').where('client_id', '=', client.id).execute();
      await trx.deleteFrom('oauth_client').where('id', '=', client.id).execute();
      await emit(
        trx,
        { workspaceId, actorId: admin.id },
        {
          type: 'oauth_client.deleted',
          subjectId: client.id,
          payload: { name: client.name, grantsEnded: Number(ended.numDeletedRows) },
        },
      );
      return true;
    });
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    return reply.code(204).send();
  });

  // Discovery (RFC 8414, RFC 9728): public, readable from any origin.
  app.get('/.well-known/oauth-authorization-server', async (_request, reply) => {
    const settings = await readMcpSettings(db);
    reply.header('access-control-allow-origin', '*');
    return {
      issuer,
      authorization_endpoint: `${base}/api/v1/oauth/authorize`,
      token_endpoint: `${base}/api/v1/oauth/token`,
      revocation_endpoint: `${base}/api/v1/oauth/revoke`,
      ...(settings.enabled && settings.oauthRegistration
        ? { registration_endpoint: `${base}/api/v1/oauth/register` }
        : {}),
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['read', 'write'],
      authorization_response_iss_parameter_supported: true,
    };
  });
  const protectedResource = async (_request: FastifyRequest, reply: FastifyReply) => {
    reply.header('access-control-allow-origin', '*');
    return {
      resource,
      authorization_servers: [issuer],
      scopes_supported: ['read', 'write'],
      bearer_methods_supported: ['header'],
      resource_name: 'Taskmoor MCP server',
    };
  };
  const metadataPath = new URL(resourceMetadataUrl(options.publicUrl)).pathname;
  app.get(metadataPath, protectedResource);
  if (metadataPath !== '/.well-known/oauth-protected-resource') {
    app.get('/.well-known/oauth-protected-resource', protectedResource);
  }

  // Token requests come as forms (RFC 6749) or JSON. Only here: elsewhere the API takes JSON
  // alone, which keeps cross-site form posts out.
  await app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 4096 },
      (_request, body, done) => {
        done(null, Object.fromEntries(new URLSearchParams(String(body))));
      },
    );

    scope.post('/api/v1/oauth/token', async (request, reply) => {
      noStore(reply);
      const grant = (request.body as { grant_type?: unknown } | null)?.grant_type;
      if (grant !== 'authorization_code' && grant !== 'refresh_token') {
        return reply.code(400).send({ error: 'unsupported_grant_type' });
      }
      const body = tokenBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const data = body.data;
      const workspaceId = request.workspaceId;
      const registered =
        data.client_id === WEB_CLIENT_ID ? null : await findClient(db, workspaceId, data.client_id);
      if (data.client_id !== WEB_CLIENT_ID && !registered) {
        return reply.code(401).send({ error: 'invalid_client' });
      }
      const outcome = await db.transaction().execute(async (trx) => {
        const result =
          data.grant_type === 'authorization_code'
            ? await exchangeCode(trx, {
                workspaceId,
                code: data.code,
                clientId: data.client_id,
                redirectUri: data.redirect_uri,
                verifier: data.code_verifier,
                ip: request.ip,
                userAgent: request.headers['user-agent']?.slice(0, 400) || null,
                ...(options.accessTtlMs ? { accessTtlMs: options.accessTtlMs } : {}),
              })
            : await refreshTokens(trx, {
                workspaceId,
                refreshToken: data.refresh_token,
                clientId: data.client_id,
                ...(options.accessTtlMs ? { accessTtlMs: options.accessTtlMs } : {}),
              });
        // A refresh is the family's own bookkeeping, like a session's last_seen_at: no event.
        const event = grantEvent(result, data.grant_type === 'authorization_code');
        if (event) {
          const actorId = result.ok ? result.userId : (result.revoked?.userId ?? null);
          await emit(trx, { workspaceId, actorId }, event);
        }
        return result;
      });
      if (!outcome.ok) return reply.code(400).send({ error: outcome.error });
      if (registered) {
        await db
          .updateTable('oauth_client')
          .set({ last_used_at: new Date() })
          .where('id', '=', registered.id)
          .execute();
      }
      return {
        access_token: outcome.tokens.accessToken,
        token_type: 'Bearer',
        expires_in: outcome.tokens.expiresIn,
        refresh_token: outcome.tokens.refreshToken,
      };
    });

    scope.post('/api/v1/oauth/revoke', async (request, reply) => {
      noStore(reply);
      const body = revokeBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: 'invalid_request' });
      const workspaceId = request.workspaceId;
      await db.transaction().execute(async (trx) => {
        const ended = await revokeToken(trx, workspaceId, body.data.token, body.data.client_id);
        if (ended) {
          await emit(
            trx,
            { workspaceId, actorId: ended.userId },
            {
              type: 'session.ended',
              subjectId: ended.userId,
              payload: { sessionId: ended.familyId },
            },
          );
        }
      });
      // RFC 7009: the same answer whether or not the token was known.
      return {};
    });
  });
}
