import { createDataset, loadDataset, scaleConfig } from '@tracksmith/testkit/gen';
import { useTestDatabase } from '@tracksmith/testkit/pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidates } from '../field-storage/candidates';
import { buildCandidate } from '../field-storage/run';
import {
  compileTemplate,
  type DatasetContext,
  datasetContext,
  renderQueryReport,
  runQueryBench,
  TEMPLATES,
} from './run';

describe('query compiler against the side schema', () => {
  const database = useTestDatabase();
  let pool: pg.Pool;
  let ctx: DatasetContext;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: database.url, max: 3 });
    await loadDataset(pool, createDataset(scaleConfig(4_000, { seed: 21, fields: 80 })));
    await buildCandidate(pool, candidates.side);
    ctx = await datasetContext(pool);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  for (const t of TEMPLATES) {
    it(`[QRY-003] runs "${t.id}" without error`, async () => {
      const { sql } = compileTemplate(t.text, ctx);
      const { rows } = await pool.query(sql.text, sql.params);
      expect(Array.isArray(rows)).toBe(true);
    });
  }

  it('returns the right rows for a space filter and a custom number comparison', async () => {
    const spaceId = ctx.catalogue.spaceKeys[ctx.names.spaceA];
    const space = compileTemplate(TEMPLATES[0]?.text ?? '', ctx, { limit: 1000 });
    const ids = (await pool.query<{ id: string }>(space.sql.text, space.sql.params)).rows.map((r) =>
      Number(r.id),
    );
    expect(ids.length).toBeGreaterThan(0);
    const check = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM fs_side.item WHERE id = ANY($1::bigint[]) AND space_id <> $2',
      [ids, spaceId],
    );
    expect(Number(check.rows[0]?.n)).toBe(0);

    const numberQuery = TEMPLATES.find((t) => t.id === 'number-gt-sorted');
    const number = compileTemplate(numberQuery?.text ?? '', ctx, { limit: 1000 });
    const hits = (await pool.query<{ id: string }>(number.sql.text, number.sql.params)).rows.map(
      (r) => Number(r.id),
    );
    expect(hits.length).toBeGreaterThan(0);
    const field = ctx.catalogue.customs.find((f) => f.name === ctx.names.number);
    const bad = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM fs_side.v_number WHERE item_id = ANY($1::bigint[]) AND field_id = $2 AND value <= 500`,
      [hits, field?.id],
    );
    expect(Number(bad.rows[0]?.n)).toBe(0);
  });

  it('honours the allowed-space pre-filter', async () => {
    const allowed = [ctx.catalogue.spaceKeys[ctx.names.spaceB] as number];
    const { sql } = compileTemplate('status != Nothing ORDER BY created DESC', ctx, {
      allowedSpaceIds: allowed,
      limit: 500,
    });
    const ids = (await pool.query<{ id: string }>(sql.text, sql.params)).rows.map((r) =>
      Number(r.id),
    );
    const outside = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM fs_side.item WHERE id = ANY($1::bigint[]) AND space_id <> ALL($2::int[])',
      [ids, allowed],
    );
    expect(Number(outside.rows[0]?.n)).toBe(0);
  });

  it('runs the benchmark end to end and renders a report', async () => {
    const result = await runQueryBench(pool, { runs: 2, warmup: 1 });
    expect(result.queries).toHaveLength(TEMPLATES.length + 1);
    expect(renderQueryReport(result)).toContain('# Query compiler spike: 4,000 items');
  }, 60_000);
});
