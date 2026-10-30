import { createDataset, loadDataset, scaleConfig } from '@taskmoor/testkit/gen';
import { useTestDatabase } from '@taskmoor/testkit/pg';
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
    // The file's database is dropped with its connections at the end; a client still open or
    // closing then hears "terminating connection", which is no failure of this test.
    pool.on('error', () => {});
    pool.on('connect', (client) => client.on('error', () => {}));
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

  /** Queries aimed at each way the compiler can drive from a side table. */
  const ANCHORED = [
    '"{option}" = "{optionValue}" ORDER BY created DESC',
    '"{option}" = "{optionValue}" ORDER BY created ASC',
    '"{option}" IN ("{optionValue}") AND stage = todo ORDER BY created DESC',
    '"{multi}" = "{multiA}" ORDER BY created DESC',
    '"{multi}" IN ("{multiA}") AND track = {spaceA} ORDER BY created DESC',
    '"{number}" > 100 ORDER BY created DESC',
    '"{number}" >= 100 AND "{number}" < 700 ORDER BY "{number}" ASC',
    '"{date}" >= -365d ORDER BY "{date}" DESC',
    '"{user}" = currentUser() ORDER BY created DESC',
    '"{option}" = "{optionValue}" AND "{number}" > 300 ORDER BY created DESC',
    '"{option}" = "{optionValue}" AND track IN ({spaceA}, {spaceB}) ORDER BY created DESC',
    '"{multi}" IN ("{multiA}", "{multiB}") ORDER BY created DESC',
    '"{multi}" IN ("{multiA}", "{multiB}") AND stage != done ORDER BY created ASC',
    '"{multi}" IN ("{multiA}", "{multiB}") AND "{multi}" = "{multiA}" ORDER BY created DESC',
  ];

  it('[QRY-003] drives from the side table and returns exactly what the item-table form returns', async () => {
    const spaces = Object.values(ctx.catalogue.trackKeys);
    let anchored = 0;
    for (const template of [...TEMPLATES.map((t) => t.text), ...ANCHORED]) {
      for (const allowed of [null, spaces.slice(0, Math.ceil(spaces.length / 2))]) {
        for (const limit of [50, 500]) {
          const plain = compileTemplate(template, ctx, {
            allowedTrackIds: allowed,
            limit,
            anchor: false,
          });
          const fast = compileTemplate(template, ctx, { allowedTrackIds: allowed, limit });
          if (fast.sql.text.startsWith('SELECT a.item_id')) anchored++;
          const a = await pool.query<{ id: string }>(plain.sql.text, plain.sql.params);
          const b = await pool.query<{ id: string }>(fast.sql.text, fast.sql.params);
          expect(
            b.rows.map((r) => String(r.id)),
            `${template} (${allowed ? 'filtered' : 'all spaces'}, ${limit})`,
          ).toEqual(a.rows.map((r) => String(r.id)));
        }
      }
    }
    // Every ANCHORED query, and the benchmark's custom-field queries, take the side-table route.
    expect(anchored).toBeGreaterThanOrEqual(ANCHORED.length * 4);
    for (const template of ANCHORED) {
      expect(compileTemplate(template, ctx).sql.text, template).toMatch(/^SELECT a\.item_id/);
    }
  });

  it('returns the right rows for a space filter and a custom number comparison', async () => {
    const spaceId = ctx.catalogue.trackKeys[ctx.names.spaceA];
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
    const allowed = [ctx.catalogue.trackKeys[ctx.names.spaceB] as number];
    const { sql } = compileTemplate('status != Nothing ORDER BY created DESC', ctx, {
      allowedTrackIds: allowed,
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
