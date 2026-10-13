import type { Database } from '@taskmoor/db';
import { newToken, tokenHash } from '@taskmoor/iam';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import type { AuthzContext } from './authz/authorizer';
import type { GlobalPermission } from './authz/permissions';
import type { ApiTokenScope } from './tokens/scopes';

/**
 * Cookie sessions (ADR-032, IAM-004). The browser holds a random 256-bit token; the database
 * keeps only its SHA-256, so a copy of the table cannot sign anyone in. On HTTPS the cookie is
 * named with the `__Host-` prefix, which pins it to this host and path (ASVS 3.4.4).
 */
export const SESSION_COOKIE = 'taskmoor_session';
export const SECURE_SESSION_COOKIE = '__Host-taskmoor_session';

export function sessionCookieName(secure: boolean): string {
  return secure ? SECURE_SESSION_COOKIE : SESSION_COOKIE;
}

/** IAM-004 turns these into policies per group or domain; until then they apply to everyone. */
export const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
export const SESSION_IDLE_MS = 3 * 24 * 60 * 60 * 1000;
/** `last_seen_at` is written at most once a minute, so ordinary requests stay read-only. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  isSiteAdmin: boolean;
  timeZone: string | null;
  locale: string | null;
}

/** What a request made with an API token knows about it (IAM-007). */
export interface CurrentApiToken {
  id: number;
  scopes: ApiTokenScope[];
}

export interface CurrentSession {
  /** The session row's id: what the session list shows and revocation names. */
  id: number;
  user: SessionUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The workspace every query of this request is scoped to (ADR-006). */
    workspaceId: number;
    /** The signed-in session, resolved from the cookie before every handler. */
    authSession: CurrentSession | null;
    /** The API token of a request sent with `Authorization: Bearer` (IAM-007); then no session. */
    apiToken: CurrentApiToken | null;
    /** Who the request acts as: the session's person or the token's owner. */
    user: SessionUser | null;
    /** Permission checks for this request's person (ADR-012). */
    authz: AuthzContext;
  }
}

export function presentedToken(request: FastifyRequest): string | undefined {
  return request.cookies[SECURE_SESSION_COOKIE] ?? request.cookies[SESSION_COOKIE];
}

/**
 * Finds the live session for a presented token. A session is over after its lifetime, after
 * the idle timeout, or once its user is deactivated; any of these reads as signed out.
 */
export async function resolveSession(
  db: Kysely<Database>,
  workspaceId: number,
  token: string | undefined,
  now = new Date(),
): Promise<CurrentSession | null> {
  if (!token) return null;
  const row = await db
    .selectFrom('user_session as s')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select([
      's.id as sessionId',
      's.last_seen_at',
      'u.id',
      'u.email',
      'u.name',
      'u.is_site_admin',
      'u.time_zone',
      'u.locale',
    ])
    .where('s.token_hash', '=', tokenHash(token))
    .where('s.workspace_id', '=', workspaceId)
    .where('s.expires_at', '>', now)
    .where('s.last_seen_at', '>', new Date(now.getTime() - SESSION_IDLE_MS))
    .where('u.deactivated_at', 'is', null)
    // Service accounts never sign in; a session row for one would be a bug, not a session.
    .where('u.kind', '=', 'person')
    .executeTakeFirst();
  if (!row) return null;
  if (now.getTime() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
    await db
      .updateTable('user_session')
      .set({ last_seen_at: now })
      .where('id', '=', row.sessionId)
      .execute();
  }
  return {
    id: row.sessionId,
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      isSiteAdmin: row.is_site_admin,
      timeZone: row.time_zone,
      locale: row.locale,
    },
  };
}

/** Starts a session with a fresh token (ASVS 3.2.1) and sets the cookie. Returns the row id. */
export async function startSession(
  db: Kysely<Database> | Transaction<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
  options: { userId: number; secure: boolean },
): Promise<number> {
  const token = newToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  const agent = request.headers['user-agent']?.slice(0, 400) || null;
  const row = await db
    .insertInto('user_session')
    .values({
      workspace_id: request.workspaceId,
      user_id: options.userId,
      token_hash: tokenHash(token),
      expires_at: expiresAt,
      ip: request.ip,
      user_agent: agent,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  reply.setCookie(sessionCookieName(options.secure), token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    expires: expiresAt,
  });
  return row.id;
}

export function clearSessionCookies(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
  reply.clearCookie(SECURE_SESSION_COOKIE, { path: '/', secure: true });
}

/**
 * Signs this browser out: the row goes, so the token is worthless even if it was copied.
 * Returns the ended session's id, or null when there was none.
 */
export async function endSession(
  db: Kysely<Database> | Transaction<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<number | null> {
  const token = presentedToken(request);
  clearSessionCookies(reply);
  if (!token) return null;
  const row = await db
    .deleteFrom('user_session')
    .where('token_hash', '=', tokenHash(token))
    .returning('id')
    .executeTakeFirst();
  return row?.id ?? null;
}

/** Ends every session of a user, except one when given (the browser that asked). */
export async function revokeUserSessions(
  db: Kysely<Database> | Transaction<Database>,
  workspaceId: number,
  userId: number,
  except?: number,
): Promise<number> {
  let query = db
    .deleteFrom('user_session')
    .where('workspace_id', '=', workspaceId)
    .where('user_id', '=', userId);
  if (except !== undefined) query = query.where('id', '!=', except);
  const result = await query.executeTakeFirst();
  return Number(result.numDeletedRows);
}

/** 401 for anonymous callers; returns the user otherwise. */
export function requireUser(request: FastifyRequest, reply: FastifyReply): SessionUser | null {
  if (!request.user) {
    void reply.code(401).send({ error: 'not_signed_in' });
    return null;
  }
  return request.user;
}

/**
 * 401 for anonymous callers, 403 for everyone without the global permission. Site
 * administrators (by the account flag or a global grant, also through a group) hold them all.
 */
export async function requireGlobal(
  request: FastifyRequest,
  reply: FastifyReply,
  ...permissions: GlobalPermission[]
): Promise<SessionUser | null> {
  const user = requireUser(request, reply);
  if (!user) return null;
  const held = await request.authz.global();
  if (!permissions.some((p) => held.has(p))) {
    void reply.code(403).send({ error: 'forbidden' });
    return null;
  }
  return user;
}

export function requireSiteAdmin(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<SessionUser | null> {
  return requireGlobal(request, reply, 'site_admin');
}
