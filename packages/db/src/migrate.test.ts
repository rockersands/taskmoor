import { readdirSync } from 'node:fs';
import { createDatabase, testPgAdminUrl, useTestDatabase } from '@taskmoor/testkit/pg';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb } from './client';
import { MIGRATION_TABLE, migrateToLatest, migrationsFingerprint } from './migrate';
import { migrations } from './migrations';

const names = Object.keys(migrations);

describe('migration registry', () => {
  it('uses NNNN_snake_case names in ascending order', () => {
    for (const name of names) expect(name).toMatch(/^\d{4}_[a-z0-9_]+$/);
    expect(names).toEqual([...names].sort());
  });

  it('registers every migration file in the folder', () => {
    const files = readdirSync(new URL('./migrations/', import.meta.url))
      .filter((f) => f.endsWith('.ts') && f !== 'index.ts' && !f.endsWith('.test.ts'))
      .map((f) => f.slice(0, -3));
    expect([...names].sort()).toEqual(files.sort());
  });

  it('has a stable fingerprint', () => {
    expect(migrationsFingerprint()).toMatch(/^[0-9a-f]{64}$/);
    expect(migrationsFingerprint()).toBe(migrationsFingerprint());
  });
});

describe('migrateToLatest', () => {
  const database = useTestDatabase();

  it('applies every migration once on an empty database, then nothing', async () => {
    const db = createDb({ connectionString: database.url, maxConnections: 2 });
    try {
      expect(await migrateToLatest(db)).toEqual(names);
      expect(await migrateToLatest(db)).toEqual([]);
      const applied = await sql<{ name: string }>`
        SELECT name FROM ${sql.table(MIGRATION_TABLE)} ORDER BY name`.execute(db);
      expect(applied.rows.map((r) => r.name)).toEqual(names);
    } finally {
      await db.destroy();
    }
  });

  it('applies each migration exactly once when several servers start together', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const clients = [1, 2, 3].map(() =>
      createDb({ connectionString: fresh.url, maxConnections: 2 }),
    );
    try {
      const runs = await Promise.all(clients.map((db) => migrateToLatest(db)));
      expect(runs.flat().sort()).toEqual([...names].sort());
    } finally {
      await Promise.all(clients.map((db) => db.destroy()));
      await fresh.drop();
    }
  }, 30_000);
});
