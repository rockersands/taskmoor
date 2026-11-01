import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

/**
 * How long a sign-in lasts in a workspace (the user's decision of 2026-11-01; ASVS 3.3.2;
 * ADR-104 Changes): an absolute lifetime and an idle timeout, which a site administrator sets on
 * the Security page. The defaults keep what Taskmoor always did: 14 days, or 3 days unused.
 * ASVS level 2 asks for 12 hours and 30 minutes; an administrator who needs that sets it.
 *
 * Both limits apply to cookie sessions and to the sign-ins of frontends on another site, at the
 * moment a session is used, so a shorter policy also ends sessions that began under a longer one.
 */
export interface SessionPolicy {
  lifetimeMinutes: number;
  idleMinutes: number;
}

export const DEFAULT_SESSION_POLICY: SessionPolicy = {
  lifetimeMinutes: 14 * 24 * 60,
  idleMinutes: 3 * 24 * 60,
};

/** What an administrator may choose: at least an hour of life and five idle minutes, at most 90 days. */
export const SESSION_POLICY_LIMITS = {
  lifetime: { min: 60, max: 90 * 24 * 60 },
  idle: { min: 5, max: 90 * 24 * 60 },
} as const;

export const sessionPolicyInput = z
  .object({
    lifetimeMinutes: z
      .number()
      .int()
      .min(SESSION_POLICY_LIMITS.lifetime.min)
      .max(SESSION_POLICY_LIMITS.lifetime.max),
    idleMinutes: z
      .number()
      .int()
      .min(SESSION_POLICY_LIMITS.idle.min)
      .max(SESSION_POLICY_LIMITS.idle.max),
  })
  .strict()
  .refine((p) => p.idleMinutes <= p.lifetimeMinutes, {
    message: 'The idle timeout cannot be longer than the lifetime',
    path: ['idleMinutes'],
  });

type Db = Kysely<Database> | Transaction<Database>;

/**
 * Read on every use of a session, so kept per process for a few seconds: a change made on
 * another process applies within that time; on this one it applies at once (`forget`).
 */
const CACHE_MS = 15_000;
const cache = new Map<number, { at: number; policy: SessionPolicy }>();

export async function sessionPolicy(db: Db, workspaceId: number): Promise<SessionPolicy> {
  const hit = cache.get(workspaceId);
  const now = Date.now();
  if (hit && now - hit.at < CACHE_MS) return hit.policy;
  const row = await db
    .selectFrom('session_policy')
    .select(['lifetime_minutes', 'idle_minutes'])
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  const policy = row
    ? { lifetimeMinutes: row.lifetime_minutes, idleMinutes: row.idle_minutes }
    : DEFAULT_SESSION_POLICY;
  cache.set(workspaceId, { at: now, policy });
  return policy;
}

/** Drops this process's copy after a change, so the next sign-in check reads the new policy. */
export function forgetSessionPolicy(workspaceId: number): void {
  cache.delete(workspaceId);
}

export const minutes = (n: number) => n * 60 * 1000;
