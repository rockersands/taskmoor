import type { Database } from '@tracksmith/db';
import { newToken, tokenHash, tokenMatches } from '@tracksmith/iam';
import type { Kysely } from 'kysely';

/** Keys in instance_setting the setup flow owns. */
export const SETUP_KEY = 'setup';
export const SETUP_TOKEN_KEY = 'setup_token';
export const INSTANCE_KEY = 'instance';
export const SMTP_KEY = 'smtp';

/** OPS-003: the setup token works once and expires after use or 24 hours. */
export const SETUP_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export interface SetupState {
  completed: boolean;
  completedAt?: string;
}

export async function readSetting<T>(db: Kysely<Database>, key: string): Promise<T | undefined> {
  const row = await db
    .selectFrom('instance_setting')
    .select('value')
    .where('key', '=', key)
    .executeTakeFirst();
  return row?.value as T | undefined;
}

export async function writeSetting(
  db: Kysely<Database>,
  key: string,
  value: unknown,
): Promise<void> {
  const text = JSON.stringify(value);
  await db
    .insertInto('instance_setting')
    .values({ key, value: text, updated_at: new Date() })
    .onConflict((oc) => oc.column('key').doUpdateSet({ value: text, updated_at: new Date() }))
    .execute();
}

export async function setupState(db: Kysely<Database>): Promise<SetupState> {
  return (await readSetting<SetupState>(db, SETUP_KEY)) ?? { completed: false };
}

/**
 * Issues the setup token while setup is incomplete: a fresh one on every start (the previous
 * stops working), or the one from TRACKSMITH_SETUP_TOKEN for installers and tests. Only its
 * hash is stored; the caller prints the link once.
 */
export async function issueSetupToken(
  db: Kysely<Database>,
  override?: string,
): Promise<string | undefined> {
  if ((await setupState(db)).completed) return undefined;
  const token = override ?? newToken();
  await writeSetting(db, SETUP_TOKEN_KEY, {
    hash: tokenHash(token),
    expiresAt: new Date(Date.now() + SETUP_TOKEN_TTL_MS).toISOString(),
  });
  return token;
}

export async function setupTokenIsValid(db: Kysely<Database>, token: string): Promise<boolean> {
  const stored = await readSetting<{ hash: string; expiresAt: string }>(db, SETUP_TOKEN_KEY);
  if (!stored) return false;
  if (Date.parse(stored.expiresAt) < Date.now()) return false;
  return tokenMatches(token, stored.hash);
}

export function setupLink(publicUrl: string, token: string): string {
  return `${publicUrl.replace(/\/$/, '')}/#/setup?token=${token}`;
}
