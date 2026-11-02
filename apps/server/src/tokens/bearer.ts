import type { Database } from '@taskmoor/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { AUDIT_ACTIONS, recordRefusedAttempt } from '../audit/record';
import type { Authorizer } from '../authz/authorizer';
import { userAgentOf } from '../request-scope';
import { countForAlert } from '../security/alerts';
import { lockedUntil, recordFailure, secondsUntil } from '../throttle';
import { defaultWorkspaceId } from '../workspace';
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
 * Audits a refused API token or Basic credential (ASVS 7.2.1; ADR-109) and counts it towards
 * the address alert rule. Only failures the throttle let through get here, so a flood writes at
 * most its window's 50 records per address. A token's owner is named when the token is known;
 * it does not count towards the account rule, since a forgotten script with an expired token is
 * no attack on its owner's password.
 */
export async function recordTokenFailure(
  db: Kysely<Database>,
  request: FastifyRequest,
  failure: {
    reason:
      | 'token_unknown'
      | 'token_expired'
      | 'token_revoked'
      | 'token_owner_deactivated'
      | 'email_mismatch'
      | 'not_a_token';
    method: 'api_token' | 'basic';
    userId: number | null;
    lockedUntil: Date | null;
    tokenId?: number;
  },
): Promise<void> {
  await recordRefusedAttempt(db, AUDIT_ACTIONS.signInFailed, {
    workspaceId: request.workspaceId,
    ip: request.ip,
    userAgent: userAgentOf(request.headers),
    actorId: null,
    userId: failure.userId,
    lockedUntil: failure.lockedUntil,
    reason: failure.reason,
    method: failure.method,
    ...(failure.tokenId !== undefined ? { tokenId: failure.tokenId } : {}),
    countsForAlerts: false,
  });
  await countForAlert(db, request.workspaceId, 'sign_in_failures_address', `ip:${request.ip}`, {
    address: request.ip,
  });
}

/**
 * Credentials the Jira-compatible API refused itself (Basic with a password, or with another
 * person's email): throttled per address like bearer tokens, audited while not locked.
 */
export async function refuseCompatCredentials(
  db: Kysely<Database>,
  request: FastifyRequest,
  failure: { reason: 'not_a_token' | 'email_mismatch'; userId: number | null },
): Promise<{ retryAfterSeconds: number } | null> {
  // The compatible routes live outside /api, where the workspace is not resolved for them.
  if (!request.workspaceId) request.workspaceId = await defaultWorkspaceId(db);
  const key = bearerThrottleKey(request.ip);
  const now = new Date();
  const locked = await lockedUntil(db, request.workspaceId, [key], now);
  if (locked) return { retryAfterSeconds: secondsUntil(locked, now) };
  const lock = await recordFailure(db, request.workspaceId, { address: key }, now);
  await recordTokenFailure(db, request, {
    reason: failure.reason,
    method: 'basic',
    userId: failure.userId,
    lockedUntil: lock,
  });
  return null;
}

/**
 * Authenticates a request that sent `Authorization: Bearer <token>` (IAM-007, ADR-035) and
 * checks the token's scopes against the matched route. Sets `request.user`, `apiToken` and
 * `authz` (as the owner, without administrator rights unless the token has the admin scope).
 * Returns false after answering the request itself:
 *
 * - 429 while the address is locked: like sign-in, 50 failed attempts in 15 minutes lock it
 *   for the rest of the window, valid tokens included;
 * - 401 `invalid_token` (with the reason, which only the token's holder learns) for unknown,
 *   expired and revoked tokens and for tokens of deactivated owners, audited without the token;
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
    const lock = await recordFailure(db, workspaceId, { address: key }, now);
    await recordTokenFailure(db, request, {
      reason: `token_${outcome.reason}`,
      method: 'api_token',
      userId: outcome.userId ?? null,
      lockedUntil: lock,
      ...(outcome.tokenId !== undefined ? { tokenId: outcome.tokenId } : {}),
    });
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
