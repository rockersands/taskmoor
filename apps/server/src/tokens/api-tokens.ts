import type { Database } from '@taskmoor/db';
import { isWellFormedApiToken, newApiToken, tokenHash } from '@taskmoor/iam';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import type { CurrentApiToken, SessionUser } from '../auth';
import { API_TOKEN_SCOPES, type ApiTokenScope, normalizeScopes } from './scopes';

/**
 * Personal and service-account API tokens (M1-004; IAM-007, ADR-034): issue, resolve, rotate,
 * and the views the API returns. A token is shown once; the database keeps its SHA-256.
 */
type Db = Kysely<Database> | Transaction<Database>;

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
/** `last_used_at` is written at most once a minute, so ordinary requests stay read-only. */
export const TOKEN_TOUCH_INTERVAL_MS = 60 * 1000;
/** Revoked and expired tokens stay in the inventory this long, then pruning removes them. */
export const TOKEN_RETENTION_DAYS = 90;
/** How long a rotated token keeps working next to its successor, unless the caller says. */
export const DEFAULT_OVERLAP_HOURS = 24;
export const MAX_OVERLAP_HOURS = 30 * 24;

export interface TokenPolicy {
  /** The longest lifetime a new token may have; an administrator may raise it past a year. */
  maxLifetimeDays: number;
  /** Tokens expiring within this many days are due for rotation (reminders). */
  reminderDays: number;
}

export const DEFAULT_TOKEN_POLICY: TokenPolicy = { maxLifetimeDays: 365, reminderDays: 14 };
export const POLICY_LIMITS = {
  maxLifetimeDays: { min: 1, max: 3650 },
  reminderDays: { min: 1, max: 90 },
} as const;

export async function tokenPolicy(db: Db, workspaceId: number): Promise<TokenPolicy> {
  const row = await db
    .selectFrom('token_policy')
    .select(['max_lifetime_days', 'reminder_days'])
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return row
    ? { maxLifetimeDays: row.max_lifetime_days, reminderDays: row.reminder_days }
    : { ...DEFAULT_TOKEN_POLICY };
}

export type TokenStatus = 'active' | 'expired' | 'revoked';

/** The person or service account a token acts as. */
export interface TokenOwner {
  id: number;
  name: string;
  email: string;
  kind: 'person' | 'service';
  active: boolean;
}

export interface ApiTokenView {
  id: number;
  name: string;
  scopes: ApiTokenScope[];
  status: TokenStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  /** The token that replaced this one when it was rotated; it keeps working until it expires. */
  replacedBy: number | null;
  owner: TokenOwner;
}

/** Columns of `api_token as t` joined with `app_user as u` that `toTokenView` reads. */
export const TOKEN_VIEW_COLUMNS = [
  't.id',
  't.name',
  't.scopes',
  't.created_at',
  't.expires_at',
  't.last_used_at',
  't.last_used_ip',
  't.revoked_at',
  't.replaced_by',
  'u.id as owner_id',
  'u.name as owner_name',
  'u.email as owner_email',
  'u.kind as owner_kind',
  'u.deactivated_at as owner_deactivated_at',
] as const;

export interface TokenViewRow {
  id: number;
  name: string;
  scopes: ApiTokenScope[];
  created_at: Date;
  expires_at: Date;
  last_used_at: Date | null;
  last_used_ip: string | null;
  revoked_at: Date | null;
  replaced_by: number | null;
  owner_id: number;
  owner_name: string;
  owner_email: string;
  owner_kind: 'person' | 'service';
  owner_deactivated_at: Date | null;
}

export function tokenStatus(
  row: { revoked_at: Date | null; expires_at: Date },
  now = new Date(),
): TokenStatus {
  if (row.revoked_at) return 'revoked';
  return row.expires_at.getTime() <= now.getTime() ? 'expired' : 'active';
}

export function toTokenView(row: TokenViewRow, now = new Date()): ApiTokenView {
  return {
    id: row.id,
    name: row.name,
    scopes: normalizeScopes(row.scopes),
    status: tokenStatus(row, now),
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    lastUsedIp: row.last_used_ip,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    replacedBy: row.replaced_by,
    owner: {
      id: row.owner_id,
      name: row.owner_name,
      email: row.owner_email,
      kind: row.owner_kind,
      active: row.owner_deactivated_at === null,
    },
  };
}

/** Reads one token's view; undefined when it is not in the workspace. */
export async function findTokenView(
  db: Db,
  workspaceId: number,
  id: number,
): Promise<ApiTokenView | undefined> {
  const row = await db
    .selectFrom('api_token as t')
    .innerJoin('app_user as u', 'u.id', 't.user_id')
    .select([...TOKEN_VIEW_COLUMNS])
    .where('t.id', '=', id)
    .where('t.workspace_id', '=', workspaceId)
    .executeTakeFirst();
  return row ? toTokenView(row) : undefined;
}

export type InvalidTokenReason = 'unknown' | 'expired' | 'revoked' | 'owner_deactivated';

export type BearerOutcome =
  | { ok: true; token: CurrentApiToken; user: SessionUser }
  | { ok: false; reason: InvalidTokenReason };

/**
 * Finds the token a request presented. Text that is not shaped like a token is refused without
 * a lookup. A token answers as itself only while it is unrevoked, unexpired and its owner is
 * active; the reason for a refusal is told only to the holder of the token.
 */
export async function resolveApiToken(
  db: Kysely<Database>,
  workspaceId: number,
  token: string,
  options: { ip: string; now?: Date },
): Promise<BearerOutcome> {
  if (!isWellFormedApiToken(token)) return { ok: false, reason: 'unknown' };
  const now = options.now ?? new Date();
  const row = await db
    .selectFrom('api_token as t')
    .innerJoin('app_user as u', 'u.id', 't.user_id')
    .select([
      't.id as tokenId',
      't.scopes',
      't.expires_at',
      't.revoked_at',
      't.last_used_at',
      'u.id',
      'u.email',
      'u.name',
      'u.is_site_admin',
      'u.time_zone',
      'u.locale',
      'u.deactivated_at',
    ])
    .where('t.token_hash', '=', tokenHash(token))
    .where('t.workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at) return { ok: false, reason: 'revoked' };
  if (row.expires_at.getTime() <= now.getTime()) return { ok: false, reason: 'expired' };
  if (row.deactivated_at) return { ok: false, reason: 'owner_deactivated' };
  if (!row.last_used_at || now.getTime() - row.last_used_at.getTime() > TOKEN_TOUCH_INTERVAL_MS) {
    await db
      .updateTable('api_token')
      .set({ last_used_at: now, last_used_ip: options.ip })
      .where('id', '=', row.tokenId)
      .execute();
  }
  return {
    ok: true,
    token: { id: row.tokenId, scopes: normalizeScopes(row.scopes) },
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

/** The token after `Bearer ` in the Authorization header; undefined for other schemes. */
export function bearerToken(authorization: string | undefined): string | undefined {
  if (!authorization) return undefined;
  const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
  return match?.[1];
}

/** The body fields that say when a new token expires: one of the two is required. */
export const expiryFields = {
  expiresInDays: z.number().int().min(1).max(POLICY_LIMITS.maxLifetimeDays.max).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
};

export const scopesField = z
  .array(z.enum(API_TOKEN_SCOPES))
  .min(1)
  .max(API_TOKEN_SCOPES.length)
  .transform((scopes) => normalizeScopes(scopes));

export const tokenNameField = z.string().trim().min(1).max(100);

export type ExpiryProblem =
  | { error: 'expiry_required' }
  | { error: 'expiry_in_past' }
  | { error: 'expiry_too_long'; maxLifetimeDays: number };

/**
 * When a token asked for at `now` expires: in a number of days or at a moment, never past the
 * policy's maximum (a minute of slack covers clocks and the time a form takes to send).
 */
export function expiryFrom(
  input: { expiresInDays?: number | undefined; expiresAt?: string | undefined },
  policy: TokenPolicy,
  now = new Date(),
): Date | ExpiryProblem {
  const limit = now.getTime() + policy.maxLifetimeDays * DAY_MS + 60_000;
  let at: number;
  if (input.expiresInDays !== undefined && input.expiresAt === undefined) {
    at = now.getTime() + input.expiresInDays * DAY_MS;
  } else if (input.expiresAt !== undefined && input.expiresInDays === undefined) {
    at = Date.parse(input.expiresAt);
  } else {
    return { error: 'expiry_required' };
  }
  if (at <= now.getTime() + 60_000) return { error: 'expiry_in_past' };
  if (at > limit) return { error: 'expiry_too_long', maxLifetimeDays: policy.maxLifetimeDays };
  return new Date(at);
}

export function isExpiryProblem(value: Date | ExpiryProblem): value is ExpiryProblem {
  return !(value instanceof Date);
}

/** Writes a new token for a person or service account; returns the token, shown once. */
export async function issueApiToken(
  db: Db,
  options: {
    workspaceId: number;
    userId: number;
    name: string;
    scopes: ApiTokenScope[];
    expiresAt: Date;
    createdBy: number | null;
    now?: Date;
  },
): Promise<{ token: string; id: number }> {
  const { token, hash } = newApiToken();
  const row = await db
    .insertInto('api_token')
    .values({
      workspace_id: options.workspaceId,
      user_id: options.userId,
      name: options.name,
      token_hash: hash,
      scopes: normalizeScopes(options.scopes),
      created_by: options.createdBy,
      created_at: options.now ?? new Date(),
      expires_at: options.expiresAt,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  return { token, id: row.id };
}

export type RotateOutcome =
  | { ok: true; token: string; id: number; previous: { id: number; userId: number } }
  | { ok: false; error: 'not_found' | 'not_active' };

/**
 * Rotation (IAM-007 criterion 3): a new token with the same owner, name and scopes, and the
 * old one keeps working for the overlap window (at most until its own expiry), so a deployment
 * can switch without downtime. An overlap of zero revokes the old token at once. The new
 * token lives as long as the old one did, within today's policy, unless the caller says.
 */
export async function rotateApiToken(
  trx: Transaction<Database>,
  options: {
    workspaceId: number;
    tokenId: number;
    /** Only rotate a token of this owner (people rotate their own; admins a service account's). */
    ownerId: number;
    overlapHours: number;
    expiresAt: Date | null;
    policy: TokenPolicy;
    actorId: number;
    now?: Date;
  },
): Promise<RotateOutcome> {
  const now = options.now ?? new Date();
  const old = await trx
    .selectFrom('api_token')
    .select(['id', 'user_id', 'name', 'scopes', 'created_at', 'expires_at', 'revoked_at'])
    .where('id', '=', options.tokenId)
    .where('workspace_id', '=', options.workspaceId)
    .where('user_id', '=', options.ownerId)
    .forUpdate()
    .executeTakeFirst();
  if (!old) return { ok: false, error: 'not_found' };
  if (tokenStatus(old, now) !== 'active') return { ok: false, error: 'not_active' };
  const lifetime = Math.min(
    old.expires_at.getTime() - old.created_at.getTime(),
    options.policy.maxLifetimeDays * DAY_MS,
  );
  const expiresAt = options.expiresAt ?? new Date(now.getTime() + Math.max(lifetime, DAY_MS));
  const issued = await issueApiToken(trx, {
    workspaceId: options.workspaceId,
    userId: old.user_id,
    name: old.name,
    scopes: old.scopes,
    expiresAt,
    createdBy: options.actorId,
    now,
  });
  const overlapEnd = new Date(now.getTime() + options.overlapHours * HOUR_MS);
  await trx
    .updateTable('api_token')
    .set(
      options.overlapHours === 0
        ? { replaced_by: issued.id, revoked_at: now, revoked_by: options.actorId }
        : {
            replaced_by: issued.id,
            expires_at: overlapEnd < old.expires_at ? overlapEnd : old.expires_at,
          },
    )
    .where('id', '=', old.id)
    .execute();
  return { ok: true, ...issued, previous: { id: old.id, userId: old.user_id } };
}

/** Revoked or expired tokens past the retention period; safe to run from several pods. */
export async function pruneApiTokens(db: Kysely<Database>, now = new Date()): Promise<void> {
  const before = new Date(now.getTime() - TOKEN_RETENTION_DAYS * DAY_MS);
  await db
    .deleteFrom('api_token')
    .where((eb) =>
      eb.or([
        eb('expires_at', '<', before),
        eb.and([eb('revoked_at', 'is not', null), eb('revoked_at', '<', before)]),
      ]),
    )
    .execute();
}
