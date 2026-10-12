import type { Database } from '@tracksmith/db';
import { newToken } from '@tracksmith/iam';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';

export const SESSION_COOKIE = 'tracksmith_session';
/** IAM-004 makes this a policy; until then two weeks of inactivity signs a browser out. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface SessionUser {
  id: number;
  email: string;
  name: string;
  isSiteAdmin: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user, resolved from the session cookie before every handler. */
    user: SessionUser | null;
  }
}

/** Looks up the cookie's session; expired and unknown sessions count as signed out. */
export async function resolveSession(
  db: Kysely<Database>,
  sessionId: string | undefined,
): Promise<SessionUser | null> {
  if (!sessionId) return null;
  const row = await db
    .selectFrom('session')
    .innerJoin('app_user', 'app_user.id', 'session.user_id')
    .select(['app_user.id', 'app_user.email', 'app_user.name', 'app_user.is_site_admin'])
    .where('session.id', '=', sessionId)
    .where('session.expires_at', '>', new Date())
    .where('app_user.deactivated_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  return { id: row.id, email: row.email, name: row.name, isSiteAdmin: row.is_site_admin };
}

/** Creates a session row and sets the cookie (ADR-032: HttpOnly, SameSite=Lax, Secure on HTTPS). */
export async function startSession(
  db: Kysely<Database>,
  reply: FastifyReply,
  userId: number,
  options: { secure: boolean },
): Promise<string> {
  const id = newToken();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insertInto('session').values({ id, user_id: userId, expires_at: expiresAt }).execute();
  reply.setCookie(SESSION_COOKIE, id, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: options.secure,
    expires: expiresAt,
  });
  return id;
}

export async function endSession(
  db: Kysely<Database>,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const id = request.cookies[SESSION_COOKIE];
  if (id) await db.deleteFrom('session').where('id', '=', id).execute();
  reply.clearCookie(SESSION_COOKIE, { path: '/' });
}
