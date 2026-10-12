import { readFileSync } from 'node:fs';
import { createDatabase, testPgAdminUrl } from '@tracksmith/testkit/pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb } from './client';
import { knownMigrations, migrateTo, migrateToLatest, migrationStatus } from './migrate';
import { snapshotSchema } from './snapshot';
import { seededRows, UPGRADE_SEEDS } from './upgrade-fixtures';

/**
 * The upgrade harness (M0-029, OPS-006): a database left at each of the last three releases,
 * holding that release's data, is upgraded to the current code and must end with the reviewed
 * schema and every seeded row. Zero manual steps: start the new release and it migrates.
 */
const golden = JSON.parse(
  readFileSync(new URL('./__golden__/schema.json', import.meta.url), 'utf8'),
);
const all = knownMigrations();
const latest = all[all.length - 1] as string;
const starts = all.slice(Math.max(0, all.length - 4), -1);

describe('upgrade from earlier releases', () => {
  it('knows a seed for every migration, so new tables are exercised', () => {
    for (const name of all) expect(UPGRADE_SEEDS, name).toHaveProperty(name);
  });

  for (const start of starts) {
    describe(`from ${start}`, () => {
      let database: Awaited<ReturnType<typeof createDatabase>>;
      let db: ReturnType<typeof createDb>;

      beforeAll(async () => {
        database = await createDatabase(testPgAdminUrl());
        db = createDb({ connectionString: database.url, maxConnections: 2 });
        await migrateTo(db, start);
        for (const name of all.slice(0, all.indexOf(start) + 1)) {
          await UPGRADE_SEEDS[name]?.seed(db as never);
        }
      });
      afterAll(async () => {
        await db.destroy();
        await database.drop();
      });

      it(`[OPS-006] applies exactly the newer migrations up to ${latest}`, async () => {
        const before = await migrationStatus(db);
        expect(before.applied[before.applied.length - 1]).toBe(start);
        expect(before.unknown).toEqual([]);
        const applied = await migrateToLatest(db);
        expect(applied).toEqual(all.slice(all.indexOf(start) + 1));
        expect((await migrationStatus(db)).pending).toEqual([]);
      });

      it('lands on the reviewed schema with every seeded row intact', async () => {
        expect(await snapshotSchema(db)).toEqual(golden);
        const rows = await seededRows(db as never, all.slice(0, all.indexOf(start) + 1));
        expect(Object.keys(rows).length).toBeGreaterThan(0);
        for (const [table, n] of Object.entries(rows)) expect(n, table).toBe(1);
      });
    });
  }

  it('[OPS-006] reports a database migrated by a newer release as unknown', async () => {
    const database = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: database.url, maxConnections: 1 });
    try {
      await migrateToLatest(db);
      await db
        .insertInto('schema_migration' as never)
        .values({ name: '9999_from_the_future', timestamp: new Date().toISOString() } as never)
        .execute();
      const status = await migrationStatus(db);
      expect(status.unknown).toEqual(['9999_from_the_future']);
      expect(status.pending).toEqual([]);
    } finally {
      await db.destroy();
      await database.drop();
    }
  });
});
