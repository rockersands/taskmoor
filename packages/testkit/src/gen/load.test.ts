import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../pg';
import { createDataset } from './generate';
import { arrayLiteral, copyValue, type LoadResult, loadDataset } from './load';
import { scaleConfig } from './model';

describe('COPY encoding', () => {
  it('escapes backslashes, tabs and line breaks, and writes NULL as \\N', () => {
    expect(copyValue('a\tb\nc\\d\re')).toBe('a\\tb\\nc\\\\d\\re');
    expect(copyValue(null)).toBe('\\N');
    expect(copyValue(3.5)).toBe('3.5');
    expect(copyValue(false)).toBe('false');
  });

  it('builds text[] literals with quotes and backslashes escaped', () => {
    expect(arrayLiteral([])).toBe('{}');
    expect(arrayLiteral(['a', 'b "c"', 'd\\e'])).toBe('{"a","b \\"c\\"","d\\\\e"}');
  });
});

describe('loadDataset', () => {
  const database = useTestDatabase();
  let pool: pg.Pool;
  let result: LoadResult;
  const dataset = createDataset(scaleConfig(5_000, { seed: 7, fields: 200 }));

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: database.url, max: 3 });
    // The file's database is dropped with its connections at the end; a client still closing
    // then hears "terminating connection", which is no failure of this test.
    pool.on('error', () => {});
    result = await loadDataset(pool, dataset);
  }, 120_000);
  afterAll(async () => {
    await pool.end();
  });

  it('loads every row and passes the key and foreign-key checks', () => {
    expect(result.items).toBe(5_000);
    expect(result.users).toBe(dataset.users.length);
    expect(result.history).toBeGreaterThan(5_000);
  });

  it('leaves every table logged, so a crash does not empty the dataset', async () => {
    const { rows } = await pool.query<{ relname: string; relpersistence: string }>(
      `SELECT c.relname, c.relpersistence FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'gen' AND c.relkind = 'r' ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([
      'fields',
      'history',
      'items',
      'meta',
      'spaces',
      'users',
    ]);
    expect(rows.every((r) => r.relpersistence === 'p')).toBe(true);
  });

  it('round-trips values exactly, including JSON fields and labels', async () => {
    const first = dataset.items().next().value?.item;
    const { rows } = await pool.query(
      `SELECT key, labels, fields, created_at, description FROM gen.items WHERE id = 1`,
    );
    expect(rows[0]).toEqual({
      key: first?.key,
      labels: first?.labels,
      fields: first?.fields,
      created_at: first?.createdAt,
      description: first?.description,
    });
  });

  it('supports the queries spikes will run, such as items per space', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM gen.items i JOIN gen.spaces s ON s.id = i.space_id
        WHERE s.key = 'AA'`,
    );
    expect(Number(rows[0]?.n)).toBeGreaterThan(0);
  });
});
