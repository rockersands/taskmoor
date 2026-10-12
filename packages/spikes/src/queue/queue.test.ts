import { useTestDatabase } from '@taskmoor/testkit/pg';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { graphileEnqueue, graphileReset, graphileStart } from './graphile';
import { claim, drainWith, enqueue, fail, INHOUSE_SQL, queueStats } from './inhouse';
import { createItemWithEvent, OUTBOX_SQL, relayOnce } from './outbox';

const database = useTestDatabase();
let pool: pg.Pool;

beforeAll(() => {
  pool = new pg.Pool({ connectionString: database.url, max: 12 });
});
afterAll(async () => {
  await pool.end();
});

async function waitUntil(check: () => boolean, timeoutMs = 20_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > until) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('in-house queue', () => {
  beforeEach(async () => {
    await pool.query(INHOUSE_SQL);
  });

  it('delivers each job exactly once across concurrent workers', async () => {
    const jobs = Array.from({ length: 2_000 }, (_, n) => ({ task: 'count', payload: { n } }));
    expect(await enqueue(pool, jobs)).toBe(2_000);

    const seen = new Map<number, number>();
    const processed = await drainWith(pool, 8, 25, async (job) => {
      const n = (job.payload as { n: number }).n;
      seen.set(n, (seen.get(n) ?? 0) + 1);
    });

    expect(processed).toBe(2_000);
    expect(seen.size).toBe(2_000);
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    const stats = await queueStats(pool);
    expect(stats).toMatchObject({ total: 2_000, done: 2_000 });
    expect(stats.p95Ms).toBeGreaterThan(0);
  });

  it('ignores a duplicate key even after the first job completed', async () => {
    expect(await enqueue(pool, [{ task: 'once', key: 'event:1' }])).toBe(1);
    expect(await drainWith(pool, 1, 10, async () => {})).toBe(1);
    expect(await enqueue(pool, [{ task: 'once', key: 'event:1' }])).toBe(0);
    expect((await queueStats(pool)).total).toBe(1);
  });

  it('retries a failed job later with backoff and gives up at max attempts', async () => {
    await enqueue(pool, [{ task: 'flaky' }]);
    const client = await pool.connect();
    try {
      const [job] = await claim(client, 'w', 1);
      if (!job) throw new Error('no job claimed');
      await fail(client, job.id, 'boom');
      const after = await client.query<{ attempts: number; later: boolean; done_at: Date | null }>(
        'SELECT attempts, run_at > now() AS later, done_at FROM q.job WHERE id = $1',
        [job.id],
      );
      expect(after.rows[0]).toMatchObject({ attempts: 1, later: true, done_at: null });
      // Not claimable until run_at.
      expect(await claim(client, 'w', 1)).toEqual([]);

      await client.query('UPDATE q.job SET run_at = now(), max_attempts = 2 WHERE id = $1', [
        job.id,
      ]);
      const [again] = await claim(client, 'w', 1);
      expect(again?.attempts).toBe(2);
      await fail(client, job.id, 'boom again');
      const given = await client.query<{ done_at: Date | null; last_error: string }>(
        'SELECT done_at, last_error FROM q.job WHERE id = $1',
        [job.id],
      );
      expect(given.rows[0]?.done_at).not.toBeNull();
      expect(given.rows[0]?.last_error).toBe('boom again');
    } finally {
      client.release();
    }
  });
});

describe('transactional outbox', () => {
  beforeEach(async () => {
    await pool.query(INHOUSE_SQL);
    await pool.query(OUTBOX_SQL);
  });

  it('delivers every event exactly once even when the relay crashes after publishing', async () => {
    for (let i = 0; i < 50; i++) await createItemWithEvent(pool, `Item ${i}`);

    // The publisher uses its own connection, like an external broker would: what it publishes
    // survives the relay's rollback, so the crash produces duplicates that the key must absorb.
    const publish = (events: { id: number; topic: string; payload: unknown }[]) =>
      enqueue(
        pool,
        events.map((e) => ({ task: e.topic, payload: e.payload, key: `event:${e.id}` })),
      ).then(() => {});

    await expect(relayOnce(pool, publish, { crashAfterPublish: true })).rejects.toThrow('crashed');
    const unpublished = await pool.query(
      'SELECT count(*)::int AS n FROM ob.event WHERE published_at IS NULL',
    );
    expect(unpublished.rows[0]?.n).toBe(50);

    expect(await relayOnce(pool, publish)).toBe(50);
    expect(await relayOnce(pool, publish)).toBe(0);

    const handled = new Set<number>();
    const processed = await drainWith(pool, 4, 10, async (job) => {
      const { itemId } = job.payload as { itemId: number };
      if (handled.has(itemId)) throw new Error(`item ${itemId} handled twice`);
      handled.add(itemId);
    });
    expect(processed).toBe(50);
    expect(handled.size).toBe(50);
    expect((await queueStats(pool)).total).toBe(50);
  });
});

describe('Graphile Worker', () => {
  it('runs each job exactly once with eight concurrent workers', async () => {
    await graphileReset(pool);
    const jobs = Array.from({ length: 300 }, (_, n) => ({ task: 'count', payload: { n } }));
    await graphileEnqueue(pool, jobs);

    const seen = new Map<number, number>();
    const workers = await graphileStart(pool, 'count', 8, async (payload) => {
      const n = (payload as { n: number }).n;
      seen.set(n, (seen.get(n) ?? 0) + 1);
    });
    try {
      await waitUntil(() => seen.size === 300);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      await workers.stop();
    }
    expect([...seen.values()].every((count) => count === 1)).toBe(true);
    const left = await pool.query('SELECT count(*)::int AS n FROM graphile_worker.jobs');
    expect(left.rows[0]?.n).toBe(0);
  }, 60_000);
});
