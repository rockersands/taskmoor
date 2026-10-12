import { createDataset, loadDataset, scaleConfig } from '@taskmoor/testkit/gen';
import { useTestDatabase } from '@taskmoor/testkit/pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CANDIDATES, candidates } from './candidates';
import { loadContext, QUERIES, type QueryContext } from './queries';
import { buildCandidate, candidateIsCurrent, renderReport, runFieldStorageSpike } from './run';

/**
 * The spike's candidates must agree on every query's answer before their speed means anything.
 * A small dataset is enough for that; the sizes that matter run through `pnpm spike`.
 */
describe('field storage candidates', () => {
  const database = useTestDatabase();
  let pool: pg.Pool;
  let ctx: QueryContext;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: database.url, max: 3 });
    await loadDataset(pool, createDataset(scaleConfig(3_000, { seed: 11, fields: 60 })));
    for (const id of CANDIDATES) await buildCandidate(pool, candidates[id]);
    ctx = await loadContext(pool, 5);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  it('are marked as built from the current dataset', async () => {
    for (const id of CANDIDATES) expect(await candidateIsCurrent(pool, candidates[id])).toBe(true);
  });

  for (const q of QUERIES.filter((q) => q.kind === 'read')) {
    it(`agree on "${q.title}"`, async () => {
      for (let run = 0; run < 5; run++) {
        const params = q.params(ctx, run);
        const answers = await Promise.all(
          CANDIDATES.map(async (id) => {
            const { rows } = await pool.query(q.sql[id], params);
            return q.compare === 'ids' ? rows.map((r) => Number(r.id)) : rows;
          }),
        );
        for (let i = 1; i < answers.length; i++) {
          expect(answers[i], `${CANDIDATES[i]} vs ${CANDIDATES[0]} on run ${run}`).toEqual(
            answers[0],
          );
        }
        // Queries that never match anything would prove nothing.
        if (q.compare === 'ids' && run === 0)
          expect((answers[0] as number[]).length).toBeGreaterThan(0);
      }
    });
  }

  it('write the same value through each candidate', async () => {
    const q = QUERIES.find((x) => x.id === 'edit-number');
    if (!q) throw new Error('edit-number query missing');
    const [itemId, fieldId, value] = q.params(ctx, 0) as [number, number, number];
    for (const id of CANDIDATES) {
      const result = await pool.query(q.sql[id], [itemId, fieldId, value]);
      expect(result.rowCount).toBe(1);
    }
    const jsonb = await pool.query<{ v: string }>(
      'SELECT fields->>$2::int::text AS v FROM fs_jsonb.item WHERE id = $1',
      [itemId, fieldId],
    );
    const side = await pool.query<{ v: string }>(
      'SELECT value::text AS v FROM fs_side.v_number WHERE item_id = $1 AND field_id = $2',
      [itemId, fieldId],
    );
    const eav = await pool.query<{ v: string }>(
      'SELECT num_value::text AS v FROM fs_eav.value WHERE item_id = $1 AND field_id = $2',
      [itemId, fieldId],
    );
    expect(Number(jsonb.rows[0]?.v)).toBe(value);
    expect(Number(side.rows[0]?.v)).toBe(value);
    expect(Number(eav.rows[0]?.v)).toBe(value);
  });

  it('runs end to end and renders a report', async () => {
    const result = await runFieldStorageSpike(pool, { runs: 2, warmup: 1 });
    expect(result.candidates.map((c) => c.id)).toEqual([...CANDIDATES]);
    expect(result.candidates[0]?.build).toEqual([]); // reused, not rebuilt
    expect(result.candidates.every((c) => c.queries.length === QUERIES.length)).toBe(true);
    const report = renderReport(result);
    expect(report).toContain('# Field storage spike: 3,000 items, 60 fields');
    expect(report).toContain('| Open one item with all its field values |');
    expect(report).toContain('| side | v_number |');
  });
});
