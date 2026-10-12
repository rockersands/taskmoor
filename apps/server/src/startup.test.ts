import { createDb } from '@tracksmith/db';
import { useMigratedDatabase } from '@tracksmith/db/testing';
import { describe, expect, it } from 'vitest';
import { waitForDatabase } from './startup';

describe('waitForDatabase', () => {
  const database = useMigratedDatabase();

  it('[OPS-001] returns as soon as the database answers', async () => {
    await expect(waitForDatabase(database.db, { timeoutMs: 5_000 })).resolves.toBeUndefined();
  });

  it('[OPS-001] keeps trying, says so once, and gives up at the deadline', async () => {
    const db = createDb({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      maxConnections: 1,
    });
    const messages: string[] = [];
    const t0 = Date.now();
    try {
      await expect(
        waitForDatabase(db, { timeoutMs: 400, intervalMs: 100, log: (m) => messages.push(m) }),
      ).rejects.toThrow(/did not answer within 0s/);
    } finally {
      await db.destroy();
    }
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(messages).toEqual(['waiting for the database']);
  });
});
