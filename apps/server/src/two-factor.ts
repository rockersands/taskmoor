import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import {
  generateRecoveryCodes,
  newToken,
  normaliseRecoveryCode,
  openSecret,
  type Pepper,
  type PepperRing,
  pepperFromSecret,
  pepperRing,
  sealSecret,
  tokenHash,
  verifyTotp,
} from '@taskmoor/iam';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { Authorizer } from './authz/authorizer';
import { effectiveGroupIds } from './directory';

/**
 * Two-factor sign-in (M1-084, IAM-001, ASVS V2.7 and V2.8): authenticator-app codes, WebAuthn
 * security keys and passkeys, single-use recovery codes, the sign-in challenge between the
 * password and the second factor, and the workspace policy that requires a second factor.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A sign-in challenge lasts five minutes and allows five wrong second factors. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 5;
/** A setup token (TOTP secret or WebAuthn registration in progress) lasts ten minutes. */
export const SETUP_TTL_MS = 10 * 60 * 1000;

export interface TwoFactorStatus {
  totp: boolean;
  webauthn: number;
  recoveryRemaining: number;
}

export async function twoFactorStatus(db: Db, userId: number): Promise<TwoFactorStatus> {
  const [totp, keys, codes] = await Promise.all([
    db
      .selectFrom('totp_credential')
      .select('user_id')
      .where('user_id', '=', userId)
      .executeTakeFirst(),
    db
      .selectFrom('webauthn_credential')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .executeTakeFirstOrThrow(),
    db
      .selectFrom('recovery_code')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('user_id', '=', userId)
      .where('used_at', 'is', null)
      .executeTakeFirstOrThrow(),
  ]);
  return {
    totp: totp !== undefined,
    webauthn: Number(keys.n),
    recoveryRemaining: Number(codes.n),
  };
}

export const hasSecondFactor = (status: TwoFactorStatus) => status.totp || status.webauthn > 0;

export interface TwoFactorPolicy {
  required: 'none' | 'site_admins' | 'everyone';
  groupIds: number[];
}

export async function readPolicy(db: Db, workspaceId: number): Promise<TwoFactorPolicy> {
  const [row, groups] = await Promise.all([
    db
      .selectFrom('two_factor_policy')
      .select('required')
      .where('workspace_id', '=', workspaceId)
      .executeTakeFirst(),
    db
      .selectFrom('two_factor_policy_group')
      .select('group_id')
      .where('workspace_id', '=', workspaceId)
      .orderBy('group_id')
      .execute(),
  ]);
  return { required: row?.required ?? 'none', groupIds: groups.map((g) => g.group_id) };
}

/** Whether the policy requires this person to sign in with a second factor. */
export async function secondFactorRequired(
  db: Db,
  authorizer: Authorizer,
  workspaceId: number,
  userId: number,
): Promise<boolean> {
  const policy = await readPolicy(db, workspaceId);
  if (policy.required === 'everyone') return true;
  if (policy.required === 'site_admins') {
    const global = await authorizer.globalPermissions(workspaceId, userId);
    if (global.has('site_admin')) return true;
  }
  if (policy.groupIds.length === 0) return false;
  const groups = new Set(await effectiveGroupIds(db, workspaceId, userId));
  return policy.groupIds.some((g) => groups.has(g));
}

/** Checks a code against the person's authenticator app and burns its time step. */
export async function checkTotp(
  db: Db,
  peppers: PepperRing | undefined,
  userId: number,
  code: string,
  now = new Date(),
): Promise<boolean> {
  const row = await db
    .selectFrom('totp_credential')
    .select(['secret_sealed', 'last_step'])
    .where('user_id', '=', userId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return false;
  const secret = openSecret(row.secret_sealed, peppers);
  if (!secret) return false;
  const step = verifyTotp(secret, code, now, row.last_step === null ? null : Number(row.last_step));
  if (step === null) return false;
  await db
    .updateTable('totp_credential')
    .set({ last_step: String(step) })
    .where('user_id', '=', userId)
    .execute();
  return true;
}

/** Uses up a recovery code; true when it was one of the person's unused codes. */
export async function useRecoveryCode(db: Db, userId: number, code: string): Promise<boolean> {
  const result = await db
    .updateTable('recovery_code')
    .set({ used_at: new Date() })
    .where('user_id', '=', userId)
    .where('used_at', 'is', null)
    .where('code_hash', '=', tokenHash(normaliseRecoveryCode(code)))
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** Replaces the person's recovery codes; the new ones are returned once and stored as hashes. */
export async function replaceRecoveryCodes(
  db: Db,
  workspaceId: number,
  userId: number,
): Promise<string[]> {
  const codes = generateRecoveryCodes();
  await db.deleteFrom('recovery_code').where('user_id', '=', userId).execute();
  await db
    .insertInto('recovery_code')
    .values(
      codes.map((code) => ({
        workspace_id: workspaceId,
        user_id: userId,
        code_hash: tokenHash(normaliseRecoveryCode(code)),
      })),
    )
    .execute();
  return codes;
}

/** Removes every second factor of a person (administrator reset, IAM-001). */
export async function removeSecondFactors(db: Db, userId: number): Promise<void> {
  await db.deleteFrom('totp_credential').where('user_id', '=', userId).execute();
  await db.deleteFrom('webauthn_credential').where('user_id', '=', userId).execute();
  await db.deleteFrom('recovery_code').where('user_id', '=', userId).execute();
  await db.deleteFrom('sign_in_challenge').where('user_id', '=', userId).execute();
}

export interface Challenge {
  id: number;
  userId: number;
  purpose: 'second_factor' | 'enrollment';
  webauthnChallenge: string | null;
}

export async function issueChallenge(
  db: Db,
  workspaceId: number,
  userId: number,
  purpose: Challenge['purpose'],
): Promise<string> {
  const token = newToken();
  // One challenge per person at a time: a new sign-in replaces an abandoned one.
  await db.deleteFrom('sign_in_challenge').where('user_id', '=', userId).execute();
  await db
    .insertInto('sign_in_challenge')
    .values({
      workspace_id: workspaceId,
      user_id: userId,
      token_hash: tokenHash(token),
      purpose,
      expires_at: new Date(Date.now() + CHALLENGE_TTL_MS),
    })
    .execute();
  return token;
}

/** A live challenge for this token and purpose, or null (unknown, expired, used up). */
export async function findChallenge(
  db: Db,
  workspaceId: number,
  token: string,
  purpose: Challenge['purpose'],
): Promise<Challenge | null> {
  const row = await db
    .selectFrom('sign_in_challenge as c')
    .innerJoin('app_user as u', 'u.id', 'c.user_id')
    .select(['c.id', 'c.user_id', 'c.purpose', 'c.webauthn_challenge'])
    .where('c.token_hash', '=', tokenHash(token))
    .where('c.workspace_id', '=', workspaceId)
    .where('c.purpose', '=', purpose)
    .where('c.expires_at', '>', new Date())
    .where('c.attempts', '<', CHALLENGE_MAX_ATTEMPTS)
    .where('u.deactivated_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    purpose: row.purpose,
    webauthnChallenge: row.webauthn_challenge,
  };
}

export async function countChallengeFailure(db: Db, id: number): Promise<void> {
  await db
    .updateTable('sign_in_challenge')
    .set((eb) => ({ attempts: eb('attempts', '+', 1) }))
    .where('id', '=', id)
    .execute();
}

export async function endChallenge(db: Db, id: number): Promise<void> {
  await db.deleteFrom('sign_in_challenge').where('id', '=', id).execute();
}

/**
 * Setup tokens carry work in progress between two requests of a signed-in person (a TOTP
 * secret waiting for its first code, a WebAuthn registration challenge) without storing it:
 * the server seals it. Sealing uses the install's active pepper; a development install without
 * one seals with a key that lives as long as the process, so a token can never be forged.
 */
const processKey = pepperFromSecret(randomBytes(32));

function sealingKey(peppers: PepperRing | undefined): Pepper {
  return peppers?.active ?? processKey;
}

export function sealSetup(
  peppers: PepperRing | undefined,
  value: { userId: number; kind: 'totp' | 'webauthn'; secret: string },
): string {
  const body = JSON.stringify({ ...value, exp: Date.now() + SETUP_TTL_MS });
  return Buffer.from(sealSecret(body, sealingKey(peppers))).toString('base64url');
}

export function openSetup(
  peppers: PepperRing | undefined,
  token: string,
  expected: { userId: number; kind: 'totp' | 'webauthn' },
): string | null {
  let sealed: string;
  try {
    sealed = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!sealed.startsWith('enc1:')) return null;
  const key = sealingKey(peppers);
  const ring = peppers ? peppers : pepperRing(key);
  const opened = openSecret(sealed, ring) ?? openSecret(sealed, pepperRing(processKey));
  if (!opened) return null;
  try {
    const value = JSON.parse(opened) as {
      userId: number;
      kind: string;
      secret: string;
      exp: number;
    };
    if (value.userId !== expected.userId || value.kind !== expected.kind) return null;
    if (value.exp < Date.now()) return null;
    return value.secret;
  } catch {
    return null;
  }
}

/** Removes expired challenges; part of the identity housekeeping. */
export async function pruneChallenges(db: Db): Promise<void> {
  await sql`DELETE FROM sign_in_challenge WHERE expires_at < now()`.execute(db);
}
