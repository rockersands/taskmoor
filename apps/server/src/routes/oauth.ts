import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { emit } from '../events/bus';
import type { DomainEventInput } from '../events/catalogue';
import {
  CHALLENGE,
  exchangeCode,
  type GrantOutcome,
  issueCode,
  refreshTokens,
  revokeToken,
  WEB_CLIENT_ID,
} from '../oauth/tokens';

/**
 * The OAuth 2.1 authorization server for frontends on another site (M1-107; IAM-024, API-002,
 * ADR-080). One public client today, the frontend kits (`taskmoor-web`), with the redirect URIs
 * the install lists; M1-108 makes them an admin list.
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
 */
export interface OAuthRouteOptions {
  publicUrl: string;
  /** Where the web client may be sent back, exact URLs. */
  redirectUris: readonly string[];
  /** Access-token lifetime; ten minutes unless a test shortens it. */
  accessTtlMs?: number;
}

const authorizeQuery = z.object({
  response_type: z.string().max(50).optional(),
  client_id: z.string().max(100),
  redirect_uri: z.string().max(2000),
  code_challenge: z.string().max(200).optional(),
  code_challenge_method: z.string().max(20).optional(),
  state: z.string().max(500).optional(),
  scope: z.string().max(500).optional(),
});

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
  const redirectUris = new Set(options.redirectUris);

  app.get('/api/v1/oauth/authorize', async (request, reply) => {
    noStore(reply);
    const query = authorizeQuery.safeParse(request.query);
    // Never redirect to an address that is not registered: answer here instead.
    if (
      !query.success ||
      query.data.client_id !== WEB_CLIENT_ID ||
      !redirectUris.has(query.data.redirect_uri)
    ) {
      return reply.code(400).send({ error: 'invalid_request', reason: 'unknown_client_or_uri' });
    }
    const q = query.data;
    const back = (params: Record<string, string>) => {
      const url = new URL(q.redirect_uri);
      for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
      if (q.state !== undefined) url.searchParams.set('state', q.state);
      url.searchParams.set('iss', issuer);
      return reply.redirect(url.href, 302);
    };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (q.code_challenge_method !== 'S256' || !CHALLENGE.test(q.code_challenge ?? '')) {
      return back({ error: 'invalid_request', error_description: 'PKCE with S256 is required' });
    }
    // Only this backend's own cookie session approves a code, never a token.
    const session = request.authSession;
    if (!session || request.apiToken || request.tokenFamily) {
      return reply.redirect(`${base}/#/sign-in?continue=${encodeURIComponent(request.url)}`, 302);
    }
    const code = await issueCode(db, {
      workspaceId: request.workspaceId,
      sessionId: session.id,
      clientId: q.client_id,
      redirectUri: q.redirect_uri,
      challenge: q.code_challenge as string,
    });
    return back({ code });
  });

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
      if (body.data.client_id !== WEB_CLIENT_ID) {
        return reply.code(401).send({ error: 'invalid_client' });
      }
      const data = body.data;
      const workspaceId = request.workspaceId;
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
