import type { Database } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { makeCatalogue } from '@taskmoor/query';
import { type Kysely, sql } from 'kysely';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from './catalogue';
import type { CompiledSearch } from './compile';
import { clearCountCache, countMatches, estimateMatches, TARGET_ERROR } from './count';
import { prepareSearch } from './run';

const TICKETS = 30_000;
/** Small samples, so a table of this size exercises every path a large one takes. */
const SIZES = { first: 1_500, max: 12_000 };
const CAP = 500;

/**
 * Counts beyond the cap (M1-040; QRY-009 (3)): estimates from block samples within 10% of the
 * exact count, the error judged from the sample, "more than" when a sample cannot get there,
 * and the cache of estimates with what drops an entry.
 */
describe('approximate counts (M1-040)', () => {
  const database = useMigratedDatabase();
  let db: Kysely<Database>;
  let newest = '';

  const compile = async (q: string): Promise<CompiledSearch> => {
    const catalog = await new FieldCatalogs(db).get(1);
    const catalogue = await queryCatalogue(db, 1, catalog, 'all');
    const { compiled } = await prepareSearch({
      db,
      workspaceId: 1,
      catalog,
      catalogue,
      filter: { sql: sql<boolean>`true`, tracks: 'all' },
      q,
      currentUserId: null,
      now: new Date('2026-01-01T00:00:00Z'),
    });
    return compiled;
  };
  const exact = async (compiled: CompiledSearch) =>
    (await compiled.count(TICKETS + 1).execute(db)).rows[0]?.n ?? 0;

  beforeAll(async () => {
    db = database.db;
    await sql`INSERT INTO track (workspace_id, key, name, access_policy_id, type_set_id)
      SELECT 1, 'C' || g, 'Track ' || g,
             (SELECT id FROM access_policy WHERE workspace_id = 1 AND is_default),
             (SELECT type_set_id FROM type_set_default WHERE workspace_id = 1 AND track_type = 'software')
        FROM generate_series(1, 10) AS g`.execute(db);
    // Tracks in turn; one ticket in three says "deploy"; created five minutes apart.
    await sql`
      WITH t AS (SELECT id, row_number() OVER (ORDER BY id) - 1 AS n FROM track WHERE key LIKE 'C%'),
           ty AS (SELECT id FROM ticket_type WHERE owner_track_id IS NULL AND name = 'Bug')
      INSERT INTO ticket (workspace_id, track_id, number, ticket_type_id, summary, rank,
                          created_at, updated_at)
      SELECT 1, t.id, g / 10 + 1, (SELECT id FROM ty),
             CASE WHEN g % 3 = 0 THEN 'Deploy step ' ELSE 'Ticket ' END || g,
             'r' || lpad(g::text, 8, '0'),
             timestamptz '2024-01-01' + g * interval '5 minutes',
             timestamptz '2024-01-01' + g * interval '5 minutes'
        FROM generate_series(0, ${TICKETS - 1}) AS g
        JOIN t ON t.n = g % 10`.execute(db);
    newest = (
      await sql<{
        at: string;
      }>`SELECT (timestamptz '2024-01-01' + ${TICKETS - 4_000} * interval '5 minutes')::text AS at`.execute(
        db,
      )
    ).rows[0]?.at as string;
    await sql`VACUUM ANALYZE ticket`.execute(db);
  }, 300_000);
  afterEach(() => {
    clearCountCache();
    delete process.env.TASKMOOR_COUNT_CACHE_SECONDS;
  });

  it('[QRY-009] estimates counts beyond the cap within 10%, and says they are estimates', async () => {
    const queries = [
      '',
      'track = C3',
      'summary ~ deploy',
      'summary ~ deploy AND track IN (C1, C2)',
      `created >= "${newest.slice(0, 16)}"`,
    ];
    const report: string[] = [];
    for (const q of queries) {
      const compiled = await compile(q);
      const truth = await exact(compiled);
      expect(truth, q).toBeGreaterThan(CAP);
      const total = await countMatches(db, compiled, CAP, SIZES);
      report.push(`${q}: ${JSON.stringify(total)} of ${truth}`);
      if (total.approximate) {
        expect(Math.abs(total.count - truth) / truth, q).toBeLessThanOrEqual(0.1);
      } else {
        // No sample was good enough: a lower bound, never a wrong number.
        expect(total, q).toEqual({ count: CAP, exact: false });
      }
    }
    // Matches spread over the table are estimated; the 4,000 newest sit in a few hundred
    // neighbouring blocks, which a 12,000-row sample may or may not reach often enough.
    expect(report.filter((r) => r.includes('"approximate":true')).length, report.join('\n')).toBe(
      4,
    );
  });

  it('[QRY-009] judges the error from the sample and grows it once', async () => {
    // Matches spread evenly over the blocks: a few blocks tell the count.
    const even = await estimateMatches(db, await compile('track = C3'), 1, {
      first: 600,
      max: 600,
    });
    expect(even?.error).toBeLessThanOrEqual(TARGET_ERROR);
    expect(even?.percent).toBeCloseTo(2);
    // Two matches a block or so vary too much for ten blocks; the sample grows once.
    const sparse = await compile('summary ~ deploy AND track = C3');
    expect(await estimateMatches(db, sparse, 1, { first: 600, max: 600 })).toBeUndefined();
    const grown = await estimateMatches(db, sparse, 1, { first: 600, max: 20_000 });
    expect(grown?.error).toBeLessThanOrEqual(TARGET_ERROR);
    expect(grown?.percent).toBeGreaterThan(2);
    const truth = await exact(sparse);
    expect(Math.abs((grown?.count ?? 0) - truth) / truth).toBeLessThanOrEqual(0.1);
    // The newest 4,000 sit in a few neighbouring blocks: no sample of this size is enough.
    const clustered = await compile(`created >= "${newest.slice(0, 16)}"`);
    expect(await estimateMatches(db, clustered, 1, { first: 600, max: 20_000 })).toBeUndefined();
    // A sample of the whole table is the exact count.
    expect(
      await estimateMatches(db, clustered, 1, { first: TICKETS * 2, max: TICKETS * 2 }),
    ).toEqual({ count: await exact(clustered), exact: true, error: 0, percent: 100 });
  });

  it('[QRY-009] counts exactly up to the cap', async () => {
    const compiled = await compile('track = C3 AND summary ~ deploy AND created < "2024-02-01"');
    const truth = await exact(compiled);
    expect(truth).toBeLessThanOrEqual(CAP);
    expect(await countMatches(db, compiled, CAP, SIZES)).toEqual({ count: truth, exact: true });
  });

  it('[QRY-009] keeps an estimate for a while, until tickets change', async () => {
    let samples = 0;
    const counted = async () => {
      const compiled = await compile('summary ~ deploy');
      return countMatches(
        db,
        {
          ...compiled,
          sample: (percent, seed) => {
            samples++;
            return compiled.sample(percent, seed);
          },
        },
        CAP,
        SIZES,
      );
    };
    const first = await counted();
    expect(first.approximate).toBe(true);
    const used = samples;
    expect(await counted()).toEqual(first);
    expect(samples).toBe(used);
    // More changed tickets than 2% of the count: counted again.
    await sql`UPDATE ticket SET updated_at = now() + interval '1 second'
               WHERE id IN (SELECT id FROM ticket ORDER BY id LIMIT 400)`.execute(db);
    await counted();
    expect(samples).toBeGreaterThan(used);
    // Kept for no time at all.
    process.env.TASKMOOR_COUNT_CACHE_SECONDS = '0';
    clearCountCache();
    const before = samples;
    await counted();
    await counted();
    expect(samples).toBeGreaterThanOrEqual(before + 2);
  });

  it('[QRY-008] keys cached counts by the viewer’s filter', async () => {
    const catalog = await new FieldCatalogs(db).get(1);
    const one = async (tracks: number[]) => {
      const { compiled } = await prepareSearch({
        db,
        workspaceId: 1,
        catalog,
        catalogue: makeCatalogue([], {}),
        filter: { sql: sql<boolean>`k.track_id = ANY(${tracks}::int[])`, tracks },
        q: 'summary ~ deploy',
        currentUserId: null,
      });
      return countMatches(db, compiled, CAP, SIZES);
    };
    const ids = (
      await db.selectFrom('track').select('id').where('key', 'like', 'C%').orderBy('id').execute()
    ).map((t) => t.id);
    const half = await one(ids.slice(0, 5));
    const all = await one(ids);
    expect(all.count).toBeGreaterThan(half.count * 1.5);
  });
});
