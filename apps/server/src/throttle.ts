import type { Database } from '@taskmoor/db';
import { LOCKOUT, lockoutSeconds } from '@taskmoor/iam';
import { type Kysely, sql } from 'kysely';

/**
 * The sign-in counters of `@taskmoor/iam`'s throttle rules, kept in Postgres so every API pod
 * sees the same counts (ADR-006: no other store). Keys come from `throttleKeys()`.
 */

/** The latest lock among the keys, or null when none is locked at `now`. */
export async function lockedUntil(
  db: Kysely<Database>,
  workspaceId: number,
  keys: readonly string[],
  now = new Date(),
): Promise<Date | null> {
  const row = await db
    .selectFrom('sign_in_throttle')
    .select((eb) => eb.fn.max('locked_until').as('until'))
    .where('workspace_id', '=', workspaceId)
    .where('key', 'in', [...keys])
    .where('locked_until', '>', now)
    .executeTakeFirst();
  return row?.until ? new Date(row.until) : null;
}

/** Seconds until `until`, rounded up, for the Retry-After header. */
export function secondsUntil(until: Date, now = new Date()): number {
  return Math.max(1, Math.ceil((until.getTime() - now.getTime()) / 1000));
}

/**
 * Counts a failed attempt against an account key (progressive lockout) and, when given, an
 * address key (a fixed window). Returns the lock now in force, if any.
 */
export async function recordFailure(
  db: Kysely<Database>,
  workspaceId: number,
  keys: { account?: string; address?: string },
  now = new Date(),
): Promise<Date | null> {
  let until: Date | null = null;
  if (keys.account) {
    const forgetBefore = new Date(now.getTime() - LOCKOUT.forgetAfterSeconds * 1000);
    const { rows } = await sql<{ failures: number }>`
      INSERT INTO sign_in_throttle (workspace_id, key, failures, window_started_at, updated_at)
      VALUES (${workspaceId}, ${keys.account}, 1, ${now}, ${now})
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        failures = CASE WHEN sign_in_throttle.updated_at < ${forgetBefore} THEN 1
                        ELSE sign_in_throttle.failures + 1 END,
        updated_at = ${now}
      RETURNING failures`.execute(db);
    const seconds = lockoutSeconds(rows[0]?.failures ?? 1);
    if (seconds > 0) {
      until = new Date(now.getTime() + seconds * 1000);
      await db
        .updateTable('sign_in_throttle')
        .set({ locked_until: until })
        .where('workspace_id', '=', workspaceId)
        .where('key', '=', keys.account)
        .execute();
    }
  }
  if (keys.address) {
    const windowStart = new Date(now.getTime() - LOCKOUT.addressWindowSeconds * 1000);
    const { rows } = await sql<{ failures: number; window_started_at: Date }>`
      INSERT INTO sign_in_throttle (workspace_id, key, failures, window_started_at, updated_at)
      VALUES (${workspaceId}, ${keys.address}, 1, ${now}, ${now})
      ON CONFLICT (workspace_id, key) DO UPDATE SET
        failures = CASE WHEN sign_in_throttle.window_started_at < ${windowStart} THEN 1
                        ELSE sign_in_throttle.failures + 1 END,
        window_started_at = CASE WHEN sign_in_throttle.window_started_at < ${windowStart} THEN ${now}
                                 ELSE sign_in_throttle.window_started_at END,
        updated_at = ${now}
      RETURNING failures, window_started_at`.execute(db);
    const row = rows[0];
    if (row && row.failures >= LOCKOUT.addressFailures) {
      const windowEnd = new Date(
        new Date(row.window_started_at).getTime() + LOCKOUT.addressWindowSeconds * 1000,
      );
      await db
        .updateTable('sign_in_throttle')
        .set({ locked_until: windowEnd })
        .where('workspace_id', '=', workspaceId)
        .where('key', '=', keys.address)
        .execute();
      if (!until || windowEnd > until) until = windowEnd;
    }
  }
  return until;
}

/** A successful sign-in clears the account's counter; the address keeps its window. */
export async function clearFailures(
  db: Kysely<Database>,
  workspaceId: number,
  key: string,
): Promise<void> {
  await db
    .deleteFrom('sign_in_throttle')
    .where('workspace_id', '=', workspaceId)
    .where('key', '=', key)
    .execute();
}

/**
 * Removes what has run out: expired sessions, used or expired password links and counters
 * nobody has touched for a day. Safe to run from several pods at once.
 */
export async function pruneIdentityData(db: Kysely<Database>, now = new Date()): Promise<void> {
  const dayAgo = new Date(now.getTime() - LOCKOUT.forgetAfterSeconds * 1000);
  await db.deleteFrom('user_session').where('expires_at', '<', now).execute();
  await db
    .deleteFrom('password_link')
    .where((eb) => eb.or([eb('expires_at', '<', now), eb('used_at', 'is not', null)]))
    .execute();
  await db
    .deleteFrom('sign_in_throttle')
    .where('updated_at', '<', dayAgo)
    .where((eb) => eb.or([eb('locked_until', 'is', null), eb('locked_until', '<', now)]))
    .execute();
}
