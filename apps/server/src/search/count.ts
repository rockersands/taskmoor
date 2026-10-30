import { createHash } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import type { CompiledSearch } from './compile';

/**
 * How many tickets a query matches (M1-040; QRY-009 (3); ADR-068 "Counts"): exact up to
 * `COUNT_CAP`, an estimate beyond it, and the estimates kept for a short while.
 *
 * - **Exact first.** The count reads matches until one past the cap, as before: small results
 *   are counted, and the first page always knows whether there are more than the cap.
 * - **An estimate beyond.** The query judges every row of a sample of the ticket table's
 *   blocks (`TABLESAMPLE SYSTEM`, with a fixed seed per query, so a count does not move while
 *   nothing changes); the estimate is the mean of matches per sampled block times the blocks
 *   the table has now (`pg_relation_size`, exact, unlike the planner's row count, which can be
 *   behind). Blocks are sampled whole and matches cluster in them (tickets written together sit
 *   together), so the error is judged from how the matches per block vary in the sample: the
 *   standard error of a mean of a sample of clusters, with the finite population correction.
 *   An estimate is given only when that error is at most 3.5% of it, so it is within 10% of the
 *   true count 99 times in 100 or more; a sample too small for that grows once (to at most
 *   `MAX_SAMPLE_ROWS` rows), and when it still is not enough the count reads "more than the
 *   cap", as it did before.
 * - **Cached.** Estimates are kept for `TASKMOOR_COUNT_CACHE_SECONDS` (default 60; 0 keeps
 *   none) per statement and parameters, which hold the viewer's permission filter, so a cached
 *   count is never shared beyond the people whose filter it was. Within that time a count
 *   moves only by the tickets changed meanwhile; an entry is dropped when more tickets changed
 *   than 2% of its count. Exact counts are not kept: they are cheap and must stay exact.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** Counts stop here: beyond it the total is an estimate, or "more than" this. */
export const COUNT_CAP = 10_000;

/** What a page says about the number of matches. */
export interface Total {
  count: number;
  /** The count is exact. */
  exact: boolean;
  /**
   * The count is an estimate, within 10% of the true count 99 times in 100. When neither this
   * nor `exact`, the count is a lower bound: there are more than `count` matches.
   */
  approximate?: boolean;
}

/** The relative standard error an estimate may have: 10% is 2.9 of them (99.6% confidence). */
export const TARGET_ERROR = 0.035;
/** Rows the first sample reads. */
export const FIRST_SAMPLE_ROWS = 20_000;
/** Rows a sample may read at most. */
export const MAX_SAMPLE_ROWS = 500_000;
/** Cached estimates at most. */
const CACHE_SIZE = 1_000;
/** A cached estimate is dropped once more tickets changed than this share of its count. */
const CHANGED_SHARE = 0.02;

interface Entry {
  total: Total;
  /** When it was counted, as Postgres reads the time (for the changes since). */
  at: string;
  expires: number;
}

const cache = new Map<string, Entry>();

/** Forgets every cached count (tests). */
export function clearCountCache(): void {
  cache.clear();
}

const cacheSeconds = () => {
  const value = Number(process.env.TASKMOOR_COUNT_CACHE_SECONDS ?? 60);
  return Number.isFinite(value) && value >= 0 ? value : 60;
};

/** An estimate from a block sample, or undefined when no sample holds enough matches. */
export interface Estimate {
  count: number;
  /** The whole table was read: the count is exact. */
  exact: boolean;
  /** Its relative standard error. */
  error: number;
  /** The share of the table's blocks sampled, in percent. */
  percent: number;
}

/** The query's matches estimated from a sample of the ticket table (see above). */
export async function estimateMatches(
  db: Db,
  compiled: CompiledSearch,
  seed: number,
  sizes: { first: number; max: number } = { first: FIRST_SAMPLE_ROWS, max: MAX_SAMPLE_ROWS },
): Promise<Estimate | undefined> {
  const { rows } = await sql<{ rows: number; blocks: number }>`
    SELECT greatest(reltuples, 0)::float8 AS rows,
           (pg_relation_size('ticket') / current_setting('block_size')::int)::float8 AS blocks
      FROM pg_class WHERE oid = 'ticket'::regclass`.execute(db);
  // The planner's row count only sizes the sample.
  const tableRows = rows[0]?.rows ?? 0;
  const tableBlocks = rows[0]?.blocks ?? 0;
  const ceiling = tableRows > 0 ? Math.min(100, (100 * sizes.max) / tableRows) : 100;
  let percent = tableRows > 0 ? Math.min(ceiling, (100 * sizes.first) / tableRows) : 100;
  for (let round = 0; round < 2; round++) {
    const sampled = (await compiled.sample(percent, seed).execute(db)).rows[0];
    const b = Number(sampled?.blocks ?? 0);
    const m = Number(sampled?.m ?? 0);
    const m2 = Number(sampled?.m2 ?? 0);
    if (percent >= 100) return { count: m, exact: true, error: 0, percent };
    let error = Number.POSITIVE_INFINITY;
    if (b >= 2 && m > 0 && tableBlocks > 0) {
      const mean = m / b;
      const variance = Math.max(0, (m2 - m * mean) / (b - 1));
      const fraction = Math.min(1, b / tableBlocks);
      error = Math.sqrt(((1 - fraction) * variance) / b) / mean;
      if (error <= TARGET_ERROR) {
        return { count: Math.round(mean * tableBlocks), exact: false, error, percent };
      }
    }
    if (percent >= ceiling) return undefined;
    // The error shrinks with the square root of the blocks sampled; a fifth more for luck.
    const grow = Number.isFinite(error) ? 1.2 * (error / TARGET_ERROR) ** 2 : 25;
    percent = Math.min(ceiling, percent * grow);
  }
  return undefined;
}

/** The total for a first page: exact, estimated or "more than", from the cache when fresh. */
export async function countMatches(
  db: Db,
  compiled: CompiledSearch,
  cap: number = COUNT_CAP,
  sizes?: { first: number; max: number },
): Promise<Total> {
  const statement = compiled.count(cap + 1).compile(db);
  const key = createHash('sha256')
    .update(statement.sql)
    .update(JSON.stringify(statement.parameters))
    .digest('base64url');
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now() && (await unchanged(db, compiled, hit))) {
    return hit.total;
  }
  cache.delete(key);
  const n = (await compiled.count(cap + 1).execute(db)).rows[0]?.n ?? 0;
  if (n <= cap) return { count: n, exact: true };
  const seed = createHash('sha256').update(key).digest().readUInt32BE(0) % 1_000_000;
  const estimate = await estimateMatches(db, compiled, seed, sizes);
  if (!estimate) return { count: cap, exact: false };
  if (estimate.exact) return { count: estimate.count, exact: true };
  // The exact count already found more than the cap.
  const total: Total = {
    count: Math.max(estimate.count, cap + 1),
    exact: false,
    approximate: true,
  };
  const seconds = cacheSeconds();
  if (seconds > 0) {
    const { rows } = await sql<{ at: string }>`SELECT now()::text AS at`.execute(db);
    if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value as string);
    cache.set(key, { total, at: rows[0]?.at as string, expires: Date.now() + seconds * 1000 });
  }
  return total;
}

/** Fewer tickets of the workspace changed since the entry than 2% of its count. */
async function unchanged(db: Db, compiled: CompiledSearch, entry: Entry): Promise<boolean> {
  const limit = Math.max(1, Math.ceil(entry.total.count * CHANGED_SHARE));
  const { rows } = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM ticket
       WHERE workspace_id = ${compiled.workspaceId} AND updated_at > ${entry.at}::timestamptz
         AND deleted_at IS NULL
       LIMIT ${limit}) c`.execute(db);
  return (rows[0]?.n ?? 0) < limit;
}
