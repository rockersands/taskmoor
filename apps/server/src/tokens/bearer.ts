import type { Database } from '@taskmoor/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Authorizer } from '../authz/authorizer';
import { lockedUntil, recordFailure, secondsUntil } from '../throttle';
import { type InvalidTokenReason, resolveApiToken } from './api-tokens';
import { scopeDenial } from './scopes';

const DESCRIPTIONS: Record<InvalidTokenReason, string> = {
  unknown: 'The token is not recognised',
  expired: 'The token has expired',
  revoked: 'The token was revoked',
  owner_deactivated: 'The account the token belongs to is deactivated',
};

/** Failed bearer attempts count per address under their own key, apart from sign-in's. */
export const bearerThrottleKey = (ip: string) => `token-ip:${ip}`;

/**
 * Authenticates a request that sent `Authorization: Bearer <token>` (IAM-007, ADR-034) and
 * checks the token's scopes against the matched route. Sets `request.user`, `apiToken` and
 * `authz` (as the owner, without administrator rights unless the token has the admin scope).
 * Returns false after answering the request itself:
 *
 * - 429 while the address is locked: like sign-in, 50 failed attempts in 15 minutes lock it
 *   for the rest of the window, valid tokens included;
 * - 401 `invalid_token` (with the reason, which only the token's holder learns) for unknown,
 *   expired and revoked tokens and for tokens of deactivated owners;
 * - 403 `insufficient_scope` or `session_required` when the route needs more than the token.
 */
export async function authenticateBearer(
  db: Kysely<Database>,
  authorizer: Authorizer,
  request: FastifyRequest,
  reply: FastifyReply,
  token: string,
): Promise<boolean> {
  const workspaceId = request.workspaceId;
  const key = bearerThrottleKey(request.ip);
  const now = new Date();
  const locked = await lockedUntil(db, workspaceId, [key], now);
  if (locked) {
    const retryAfter = secondsUntil(locked, now);
    await reply
      .code(429)
      .header('retry-after', String(retryAfter))
      .send({ error: 'too_many_attempts', retryAfterSeconds: retryAfter });
    return false;
  }
  const outcome = await resolveApiToken(db, workspaceId, token, { ip: request.ip, now });
  if (!outcome.ok) {
    await recordFailure(db, workspaceId, { address: key }, now);
    await reply
      .code(401)
      .header(
        'www-authenticate',
        `Bearer realm="taskmoor", error="invalid_token", error_description="${DESCRIPTIONS[outcome.reason]}"`,
      )
      .send({ error: 'invalid_token', reason: outcome.reason });
    return false;
  }
  request.apiToken = outcome.token;
  request.user = outcome.user;
  request.authSession = null;
  request.authz = authorizer.context(workspaceId, {
    userId: outcome.user.id,
    withoutAdminRights: !outcome.token.scopes.includes('admin'),
  });
  const denial = scopeDenial(request.method, request.routeOptions.url, outcome.token.scopes);
  if (denial) {
    if (denial.error === 'insufficient_scope') {
      reply.header(
        'www-authenticate',
        `Bearer realm="taskmoor", error="insufficient_scope", scope="${denial.requiredScope}"`,
      );
    }
    await reply.code(403).send(denial);
    return false;
  }
  return true;
}
