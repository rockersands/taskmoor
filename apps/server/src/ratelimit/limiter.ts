import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';

/**
 * Rate limits (M1-066; API-010; ADR-075): token buckets per API client, kept in each API
 * process's memory. A bucket holds up to `burst` requests and refills `rate` a second; a
 * request takes one, and without one it is refused with 429 and the seconds until one is back.
 * Clients are API tokens, signed-in people (their sessions together) and, for requests with
 * neither, the address. Writes to one ticket have a bucket of their own as well, whoever
 * sends them, so a loop cannot flood a ticket's history and its followers' inboxes.
 *
 * Buckets live in the process, not in Postgres: a database write per request would cost more
 * than the requests it limits. With several API processes behind a balancer each keeps its
 * own buckets, so a client may reach the limit once per process; the defaults leave room for
 * that, and an administrator sets them for the whole workspace.
 */
export interface Limits {
  /** Requests a second, on average. */
  rate: number;
  /** Requests at once, after a quiet spell. */
  burst: number;
}

export interface RateLimitPolicy {
  token: Limits;
  user: Limits;
  address: Limits;
  ticketWrite: Limits;
}

/**
 * Generous enough that a person never meets them (API-010 (3): never under 20 requests a
 * second), tight enough that a runaway script slows down before it hurts everyone else.
 */
export const DEFAULT_RATE_LIMITS: RateLimitPolicy = {
  token: { rate: 50, burst: 200 },
  user: { rate: 50, burst: 200 },
  address: { rate: 20, burst: 100 },
  ticketWrite: { rate: 10, burst: 40 },
};

export const RATE_LIMIT_BOUNDS = { rate: { min: 1, max: 10_000 }, burst: { min: 1, max: 100_000 } };

export interface Taken {
  allowed: boolean;
  limit: number;
  /** Requests left in the bucket after this one. */
  remaining: number;
  /** Seconds until the bucket is full again. */
  resetSeconds: number;
  /** Seconds until a refused client may try again; 0 when allowed. */
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

/** How many buckets a process keeps before it drops the full ones. */
const SWEEP_AT = 50_000;

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;

  constructor(options: { now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /** Takes one request from the bucket `key` under `limits`. */
  take(key: string, limits: Limits): Taken {
    const now = this.now();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= SWEEP_AT) this.sweep(now, limits);
      bucket = { tokens: limits.burst, at: now };
      this.buckets.set(key, bucket);
    } else {
      bucket.tokens = Math.min(
        limits.burst,
        bucket.tokens + ((now - bucket.at) / 1000) * limits.rate,
      );
      bucket.at = now;
    }
    const allowed = bucket.tokens >= 1;
    if (allowed) bucket.tokens -= 1;
    const missing = limits.burst - bucket.tokens;
    return {
      allowed,
      limit: limits.burst,
      remaining: Math.floor(bucket.tokens),
      resetSeconds: Math.ceil(missing / limits.rate),
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / limits.rate)),
    };
  }

  /** Forgets buckets that have refilled: they would start full anyway. */
  private sweep(now: number, limits: Limits): void {
    const full = (limits.burst / limits.rate) * 1000;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at >= full) this.buckets.delete(key);
    }
  }
}

type Db = Pick<Kysely<Database>, 'selectFrom'>;

export async function readRateLimits(db: Db, workspaceId: number): Promise<RateLimitPolicy> {
  const row = await db
    .selectFrom('rate_limit_policy')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!row) return structuredClone(DEFAULT_RATE_LIMITS);
  return {
    token: { rate: row.token_rate, burst: row.token_burst },
    user: { rate: row.user_rate, burst: row.user_burst },
    address: { rate: row.address_rate, burst: row.address_burst },
    ticketWrite: { rate: row.ticket_write_rate, burst: row.ticket_write_burst },
  };
}

/** A workspace's limits, read at most every `ttlMs` per process; a change here is seen at once. */
export class RateLimitPolicies {
  private readonly cache = new Map<number, { policy: RateLimitPolicy; until: number }>();

  constructor(
    private readonly db: Db,
    private readonly ttlMs = 30_000,
  ) {}

  async get(workspaceId: number): Promise<RateLimitPolicy> {
    const hit = this.cache.get(workspaceId);
    if (hit && hit.until > Date.now()) return hit.policy;
    const policy = await readRateLimits(this.db, workspaceId);
    this.cache.set(workspaceId, { policy, until: Date.now() + this.ttlMs });
    return policy;
  }

  set(workspaceId: number, policy: RateLimitPolicy): void {
    this.cache.set(workspaceId, { policy, until: Date.now() + this.ttlMs });
  }
}
