import { createHash, timingSafeEqual } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { newToken, tokenHash } from '@taskmoor/iam';
import type { Kysely, Transaction } from 'kysely';
import type { CurrentSession } from '../auth';
import { minutes, sessionPolicy } from '../session-policy';

/**
 * OAuth 2.1 for frontends on another site (M1-107; IAM-024, ADR-080): authorization codes with
 * PKCE (S256 only), short-lived bearer access tokens and refresh tokens that rotate on every
 * use, with reuse detection.
 *
 * A code is approved by a signed-in browser session at this backend (the cookie, first-party
 * on the backend's own pages). Exchanging it starts a token family: a `user_session` row with
 * the client's id and that browser session as its parent, so the session list, signing out
 * everywhere and deactivation reach it like any session. Every token is random and stored by
 * its SHA-256, so it can be revoked at once (ADR-080 says why not signed tokens).
 */
type Db = Kysely<Database> | Transaction<Database>;

/** The frontend kits' client (first-party, public, no secret): its redirect URIs are configured. */
export const WEB_CLIENT_ID = 'taskmoor-web';
/** IAM-024's default: ten minutes. */
export const ACCESS_TOKEN_TTL_MS = 10 * 60 * 1000;
export const CODE_TTL_MS = 60 * 1000;
/** How long a registered client's grant lasts before the person approves it again (M1-072). */
export const CLIENT_FAMILY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Prefixes tell the two kinds from API tokens (`tmk_`) and from each other at a glance. */
export const ACCESS_TOKEN_PREFIX = 'tma_';
export const REFRESH_TOKEN_PREFIX = 'tmr_';
/** RFC 7636: 43 to 128 unreserved characters. */
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
/** `last_seen_at` is written at most once a minute, as for cookie sessions. */
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives. */
  expiresIn: number;
}

/** True when the verifier hashes to the challenge (S256). */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!VERIFIER.test(verifier) || !CHALLENGE.test(challenge)) return false;
  const computed = Buffer.from(createHash('sha256').update(verifier).digest('base64url'));
  const expected = Buffer.from(challenge);
  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

export const isAccessToken = (token: string) => token.startsWith(ACCESS_TOKEN_PREFIX);

/** A code for the client, bound to the browser session that approved it. */
export async function issueCode(
  db: Db,
  options: {
    workspaceId: number;
    sessionId: number;
    clientId: string;
    redirectUri: string;
    challenge: string;
    /** A registered client's scope (M1-072); none for the first-party frontends. */
    scope?: string | null;
    now?: Date;
  },
): Promise<string> {
  const now = options.now ?? new Date();
  const code = newToken();
  await db
    .insertInto('oauth_code')
    .values({
      code_hash: tokenHash(code),
      workspace_id: options.workspaceId,
      session_id: options.sessionId,
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      code_challenge: options.challenge,
      expires_at: new Date(now.getTime() + CODE_TTL_MS),
      used_at: null,
      family_id: null,
      scope: options.scope ?? null,
    })
    .execute();
  return code;
}

async function issueTokens(
  db: Db,
  workspaceId: number,
  familyId: number,
  familyExpiresAt: Date,
  now: Date,
  accessTtlMs: number,
): Promise<TokenSet> {
  const accessToken = `${ACCESS_TOKEN_PREFIX}${newToken()}`;
  const refreshToken = `${REFRESH_TOKEN_PREFIX}${newToken()}`;
  const accessExpires = new Date(Math.min(now.getTime() + accessTtlMs, familyExpiresAt.getTime()));
  await db
    .insertInto('oauth_token')
    .values([
      {
        token_hash: tokenHash(accessToken),
        workspace_id: workspaceId,
        session_id: familyId,
        kind: 'access',
        expires_at: accessExpires,
        used_at: null,
      },
      {
        token_hash: tokenHash(refreshToken),
        workspace_id: workspaceId,
        session_id: familyId,
        kind: 'refresh',
        expires_at: familyExpiresAt,
        used_at: null,
      },
    ])
    .execute();
  return {
    accessToken,
    refreshToken,
    expiresIn: Math.max(1, Math.floor((accessExpires.getTime() - now.getTime()) / 1000)),
  };
}

/**
 * Ends a family together with the browser session that approved it, and so every other family
 * of that browser (ON DELETE CASCADE): the person is signed out there. Returns who it was and
 * how many sessions ended.
 */
export async function endFamilyAndParent(
  db: Db,
  familyId: number,
): Promise<{ userId: number; count: number } | null> {
  const family = await db
    .selectFrom('user_session')
    .select(['user_id', 'parent_id'])
    .where('id', '=', familyId)
    .executeTakeFirst();
  if (!family) return null;
  const root = family.parent_id ?? familyId;
  const ended = await db
    .selectFrom('user_session')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where((eb) => eb.or([eb('id', '=', root), eb('parent_id', '=', root)]))
    .executeTakeFirstOrThrow();
  await db.deleteFrom('user_session').where('id', '=', root).execute();
  return { userId: family.user_id, count: Number(ended.n) };
}

export type GrantOutcome =
  | { ok: true; tokens: TokenSet; familyId: number; userId: number }
  | {
      ok: false;
      error: 'invalid_grant';
      /** A used code or refresh token came back: these sessions were ended (reuse detection). */
      revoked?: { userId: number; count: number };
    };

/** A live browser session at this backend, by id: the parent a code names. */
async function liveParent(db: Db, workspaceId: number, sessionId: number, now: Date) {
  const idle = minutes((await sessionPolicy(db, workspaceId)).idleMinutes);
  return db
    .selectFrom('user_session as s')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select(['s.id', 's.user_id', 's.expires_at'])
    .where('s.id', '=', sessionId)
    .where('s.workspace_id', '=', workspaceId)
    .where('s.client_id', 'is', null)
    .where('s.expires_at', '>', now)
    .where('s.last_seen_at', '>', new Date(now.getTime() - idle))
    .where('u.deactivated_at', 'is', null)
    .where('u.kind', '=', 'person')
    .executeTakeFirst();
}

/**
 * The authorization-code grant: the code must be live, unused, the client's, for this redirect
 * URI, and the verifier must hash to its challenge. A code presented twice ends the family the
 * first exchange made (RFC 9700 section 4.2.1 asks for that much).
 */
export async function exchangeCode(
  db: Transaction<Database>,
  options: {
    workspaceId: number;
    code: string;
    clientId: string;
    redirectUri: string;
    verifier: string;
    ip: string | null;
    userAgent: string | null;
    now?: Date;
    accessTtlMs?: number;
  },
): Promise<GrantOutcome> {
  const now = options.now ?? new Date();
  const row = await db
    .selectFrom('oauth_code')
    .selectAll()
    .where('code_hash', '=', tokenHash(options.code))
    .where('workspace_id', '=', options.workspaceId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return { ok: false, error: 'invalid_grant' };
  if (row.used_at !== null) {
    const revoked = row.family_id ? await endFamilyAndParent(db, row.family_id) : null;
    return { ok: false, error: 'invalid_grant', ...(revoked ? { revoked } : {}) };
  }
  if (
    row.expires_at <= now ||
    row.client_id !== options.clientId ||
    row.redirect_uri !== options.redirectUri ||
    !pkceMatches(options.verifier, row.code_challenge)
  ) {
    return { ok: false, error: 'invalid_grant' };
  }
  const parent = await liveParent(db, options.workspaceId, row.session_id, now);
  if (!parent) return { ok: false, error: 'invalid_grant' };
  // A registered client's family (M1-072) outlives the browser that approved it: an MCP client
  // keeps working after the person signs out there, for its own lifetime. The first-party
  // frontends' families end with their browser session.
  const registered = row.scope !== null;
  const expiresAt = registered ? new Date(now.getTime() + CLIENT_FAMILY_TTL_MS) : parent.expires_at;
  const family = await db
    .insertInto('user_session')
    .values({
      workspace_id: options.workspaceId,
      user_id: parent.user_id,
      token_hash: null,
      expires_at: expiresAt,
      ip: options.ip,
      user_agent: options.userAgent,
      client_id: row.client_id,
      parent_id: registered ? null : parent.id,
      scope: row.scope,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .updateTable('oauth_code')
    .set({ used_at: now, family_id: family.id })
    .where('code_hash', '=', row.code_hash)
    .execute();
  const tokens = await issueTokens(
    db,
    options.workspaceId,
    family.id,
    expiresAt,
    now,
    options.accessTtlMs ?? ACCESS_TOKEN_TTL_MS,
  );
  return { ok: true, tokens, familyId: family.id, userId: parent.user_id };
}

/**
 * The refresh-token grant: the token is spent and a new pair issued in the same family. A spent
 * token presented again means two holders, so the family ends with the browser session that
 * approved it (IAM-024 (2)); whoever holds the newer token is signed out too.
 */
export async function refreshTokens(
  db: Transaction<Database>,
  options: {
    workspaceId: number;
    refreshToken: string;
    clientId: string;
    now?: Date;
    accessTtlMs?: number;
  },
): Promise<GrantOutcome> {
  const now = options.now ?? new Date();
  const idle = minutes((await sessionPolicy(db, options.workspaceId)).idleMinutes);
  const row = await db
    .selectFrom('oauth_token as t')
    .innerJoin('user_session as s', 's.id', 't.session_id')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select([
      't.token_hash',
      't.used_at',
      's.id as familyId',
      's.client_id',
      's.parent_id',
      's.user_id',
      's.expires_at',
      's.last_seen_at',
      's.scope',
      'u.deactivated_at',
      'u.kind as userKind',
    ])
    .where('t.token_hash', '=', tokenHash(options.refreshToken))
    .where('t.kind', '=', 'refresh')
    .where('s.workspace_id', '=', options.workspaceId)
    .forUpdate('t')
    .executeTakeFirst();
  if (!row) return { ok: false, error: 'invalid_grant' };
  if (row.used_at !== null) {
    const revoked = await endFamilyAndParent(db, row.familyId);
    return { ok: false, error: 'invalid_grant', ...(revoked ? { revoked } : {}) };
  }
  if (
    row.client_id !== options.clientId ||
    row.expires_at <= now ||
    // A registered client's family is bounded by its lifetime, not by idleness (M1-072).
    (row.scope === null && row.last_seen_at.getTime() <= now.getTime() - idle) ||
    row.deactivated_at !== null ||
    row.userKind !== 'person'
  ) {
    return { ok: false, error: 'invalid_grant' };
  }
  await db
    .updateTable('oauth_token')
    .set({ used_at: now })
    .where('token_hash', '=', row.token_hash)
    .execute();
  // A family in use keeps itself and the browser session behind it from idling out, so the
  // backend's own pages (downloads, the next sign-in) still know the person.
  await db
    .updateTable('user_session')
    .set({ last_seen_at: now })
    .where((eb) =>
      eb.or([
        eb('id', '=', row.familyId),
        ...(row.parent_id !== null ? [eb('id', '=', row.parent_id)] : []),
      ]),
    )
    .execute();
  const tokens = await issueTokens(
    db,
    options.workspaceId,
    row.familyId,
    row.expires_at,
    now,
    options.accessTtlMs ?? ACCESS_TOKEN_TTL_MS,
  );
  return { ok: true, tokens, familyId: row.familyId, userId: row.user_id };
}

/**
 * RFC 7009: a client gives back an access or refresh token and its family ends (the browser
 * session at the backend stays). Answers the ended family, or null for an unknown token.
 */
export async function revokeToken(
  db: Db,
  workspaceId: number,
  token: string,
  clientId: string,
): Promise<{ familyId: number; userId: number } | null> {
  const row = await db
    .selectFrom('oauth_token as t')
    .innerJoin('user_session as s', 's.id', 't.session_id')
    .select(['s.id', 's.user_id', 's.client_id'])
    .where('t.token_hash', '=', tokenHash(token))
    .where('s.workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!row || row.client_id !== clientId) return null;
  await db.deleteFrom('user_session').where('id', '=', row.id).execute();
  return { familyId: row.id, userId: row.user_id };
}

/** The family an access token belongs to, as a session, while token, family and person live. */
export async function resolveAccessToken(
  db: Kysely<Database>,
  workspaceId: number,
  token: string,
  now = new Date(),
): Promise<
  (CurrentSession & { parentId: number | null; scope: string | null; clientId: string }) | null
> {
  const idle = minutes((await sessionPolicy(db, workspaceId)).idleMinutes);
  const row = await db
    .selectFrom('oauth_token as t')
    .innerJoin('user_session as s', 's.id', 't.session_id')
    .innerJoin('app_user as u', 'u.id', 's.user_id')
    .select([
      's.id as sessionId',
      's.parent_id',
      's.scope',
      's.client_id',
      's.last_seen_at',
      'u.id',
      'u.email',
      'u.name',
      'u.is_site_admin',
      'u.time_zone',
      'u.locale',
      'u.appearance',
    ])
    .where('t.token_hash', '=', tokenHash(token))
    .where('t.kind', '=', 'access')
    .where('t.expires_at', '>', now)
    .where('s.workspace_id', '=', workspaceId)
    .where('s.expires_at', '>', now)
    .where((eb) =>
      eb.or([
        eb('s.scope', 'is not', null),
        eb('s.last_seen_at', '>', new Date(now.getTime() - idle)),
      ]),
    )
    .where('u.deactivated_at', 'is', null)
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
    parentId: row.parent_id,
    scope: row.scope,
    clientId: row.client_id ?? '',
    user: {
      id: row.id,
      email: row.email,
      name: row.name,
      isSiteAdmin: row.is_site_admin,
      timeZone: row.time_zone,
      locale: row.locale,
      appearance: row.appearance,
    },
  };
}

/**
 * Expired codes and access tokens go; refresh tokens stay while their family lives, since a
 * spent one is how reuse is recognised (they go with the family).
 */
export async function pruneOAuth(db: Kysely<Database>, now = new Date()): Promise<void> {
  await db.deleteFrom('oauth_code').where('expires_at', '<', now).execute();
  await db.deleteFrom('oauth_request').where('expires_at', '<', now).execute();
  // Registrations nobody completed within a day: what an endless stream of them would leave.
  await db
    .deleteFrom('oauth_client')
    .where('last_used_at', 'is', null)
    .where('created_at', '<', new Date(now.getTime() - 24 * 60 * 60 * 1000))
    .execute();
  await db
    .deleteFrom('oauth_token')
    .where('kind', '=', 'access')
    .where('expires_at', '<', now)
    .execute();
}
