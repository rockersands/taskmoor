import { createDataset, loadDataset, scaleConfig } from '@taskmoor/testkit/gen';
import { useTestDatabase } from '@taskmoor/testkit/pg';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootstrap, deltaSince, follow, mutate, SYNC_SQL } from './changelog';

describe('in-house change log', () => {
  const database = useTestDatabase();
  let pool: pg.Pool;
  let spaces: number[];

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: database.url, max: 10 });
    // The file's database is dropped with its connections at the end; a client still open or
    // closing then hears "terminating connection", which is no failure of this test.
    pool.on('error', () => {});
    pool.on('connect', (client) => client.on('error', () => {}));
    await loadDataset(pool, createDataset(scaleConfig(3_000, { seed: 4, fields: 20 })));
    await pool.query(SYNC_SQL);
    spaces = [1, 2];
  });
  afterAll(async () => {
    await pool.end();
  });

  it('bootstraps exactly the items of the allowed spaces, in id order', async () => {
    const client = await pool.connect();
    try {
      const lines: string[] = [];
      const { rows, startSeq } = await bootstrap(client, spaces, (t) => lines.push(t), 100);
      const expected = await pool.query<{ n: string }>(
        'SELECT count(*) AS n FROM gen.items WHERE space_id = ANY($1::int[])',
        [spaces],
      );
      expect(rows).toBe(Number(expected.rows[0]?.n));
      expect(startSeq).toBe(0);
      const ids = lines
        .join('')
        .trim()
        .split('\n')
        .map((l) => Number((JSON.parse(l) as { id: string }).id));
      expect(ids).toEqual([...ids].sort((a, b) => a - b));
    } finally {
      client.release();
    }
  });

  it('[NTF-008] delivers every change to a follower in commit order without gaps', async () => {
    const targets = (
      await pool.query<{ id: string; space_id: number }>(
        'SELECT id, space_id FROM gen.items WHERE space_id = ANY($1::int[]) LIMIT 300',
        [spaces],
      )
    ).rows;
    const follower = new pg.Client({ connectionString: database.url });
    await follower.connect();
    const latencies: number[] = [];
    const following = follow(follower, spaces, 0, targets.length, (ms) => latencies.push(ms));
    let next = 0;
    const writer = async () => {
      const client = await pool.connect();
      try {
        for (;;) {
          const t = targets[next++];
          if (!t) return;
          await mutate(client, { itemId: t.id, spaceId: t.space_id, status: 'Done' });
        }
      } finally {
        client.release();
      }
    };
    await Promise.all([writer(), writer(), writer(), writer()]);
    const { seen, gaps } = await following;
    await follower.end();
    expect(seen).toBe(targets.length);
    expect(gaps).toBe(0);
    const reader = await pool.connect();
    let seqs: number[];
    try {
      seqs = (await deltaSince(reader, 0, spaces, 1000)).map((c) => Number(c.seq));
    } finally {
      reader.release();
    }
    expect(seqs).toEqual(Array.from({ length: targets.length }, (_, i) => i + 1));
    expect(Math.max(...latencies)).toBeLessThan(5_000);
  });

  it('applies an offline outbox mutation once, however often it is replayed', async () => {
    const client = await pool.connect();
    try {
      const target = (
        await pool.query<{ id: string; space_id: number }>(
          'SELECT id, space_id FROM gen.items WHERE space_id = 1 LIMIT 1',
        )
      ).rows[0];
      if (!target) throw new Error('no item');
      const m = { itemId: target.id, spaceId: target.space_id, status: 'In Progress' };
      const first = await mutate(client, m, { clientId: 'phone', mutationId: 7 });
      const again = await mutate(client, m, { clientId: 'phone', mutationId: 7 });
      expect(first.applied).toBe(true);
      expect(again).toEqual({ applied: false, seq: first.seq });
      const other = await mutate(client, m, { clientId: 'phone', mutationId: 8 });
      expect(other.applied).toBe(true);
    } finally {
      client.release();
    }
  });
});
