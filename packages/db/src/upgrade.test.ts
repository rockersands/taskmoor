import { readFileSync } from 'node:fs';
import { createDatabase, testPgAdminUrl } from '@taskmoor/testkit/pg';
import { sql } from 'kysely';
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
        // Each seed runs right after its own migration, with the schema it was written for: a
        // later migration may drop a column an earlier seed writes (0042 dropped
        // track.workflow_id, which the 0024 seed sets).
        for (const name of all.slice(0, all.indexOf(start) + 1)) {
          await migrateTo(db, name);
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

  describe('the default workflow moves freely (0089)', () => {
    const atDefault = async (db: ReturnType<typeof createDb>) => {
      const { rows } = await sql<{
        published_version: number;
        id: number;
        definition: {
          transitions: { id: number; name: string; from: unknown; layout?: unknown }[];
        };
      }>`
        SELECT w.id, w.published_version, v.definition
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.is_default`.execute(db);
      return rows[0] as NonNullable<(typeof rows)[0]>;
    };
    const atBefore0089 = async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      await migrateTo(db, '0088_one_board_per_track');
      return { database, db };
    };

    it('[WF-008] gives a default workflow nobody changed its second version', async () => {
      const { database, db } = await atBefore0089();
      try {
        await migrateToLatest(db);
        const { published_version, definition } = await atDefault(db);
        expect(published_version).toBe(2);
        expect(definition.transitions.map((t) => [t.id, t.name, t.from, t.layout])).toEqual([
          [5, 'New', 'any', undefined],
          [1, 'Active', 'any', undefined],
          [2, 'In Review', 'any', undefined],
          [4, 'Closed', 'any', undefined],
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] leaves a default workflow an administrator edited with its own rules', async () => {
      const { database, db } = await atBefore0089();
      try {
        const before = await atDefault(db);
        await sql`
          INSERT INTO workflow_version (workspace_id, workflow_id, version, definition, published_at)
          VALUES (1, ${before.id}, 2, ${JSON.stringify(before.definition)}, now())`.execute(db);
        await sql`
          INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
          SELECT workspace_id, workflow_id, 2, status_id FROM workflow_version_status
           WHERE workflow_id = ${before.id} AND version = 1`.execute(db);
        await sql`UPDATE workflow SET published_version = 2 WHERE id = ${before.id}`.execute(db);
        await migrateToLatest(db);
        const after = await atDefault(db);
        expect(after.published_version).toBe(2);
        expect(after.definition).toEqual(before.definition);
        expect(after.definition.transitions.find((t) => t.name === 'Close')?.layout).toEqual([
          'close-reason',
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

  describe('the default workflow 0089 left strict (0103)', () => {
    const FREE = [
      [5, 'any', undefined],
      [1, 'any', undefined],
      [2, 'any', undefined],
      [4, 'any', undefined],
    ];
    const atDefault = async (db: ReturnType<typeof createDb>) => {
      const { rows } = await sql<{
        id: number;
        published_version: number;
        draft_version: number | null;
        definition: {
          transitions: { id: number; name: string; from: unknown; layout?: unknown }[];
        };
      }>`
        SELECT w.id, w.published_version, w.draft_version, v.definition
          FROM workflow w
          JOIN workflow_version v ON v.workflow_id = w.id AND v.version = w.published_version
         WHERE w.is_default`.execute(db);
      return rows[0] as NonNullable<(typeof rows)[0]>;
    };
    const atBefore0089 = async () => {
      const database = await createDatabase(testPgAdminUrl());
      const db = createDb({ connectionString: database.url, maxConnections: 2 });
      await migrateTo(db, '0088_one_board_per_track');
      return { database, db };
    };

    it('[WF-008] gives a default workflow whose status was renamed its free-moving version', async () => {
      const { database, db } = await atBefore0089();
      try {
        await sql`UPDATE status SET name = 'Review' WHERE name = 'In Review'`.execute(db);
        await migrateToLatest(db);
        const { published_version, definition } = await atDefault(db);
        expect(published_version).toBe(2);
        expect(definition.transitions.map((t) => [t.id, t.from, t.layout])).toEqual(FREE);
        expect(definition.transitions.map((t) => t.name)).toEqual([
          'New',
          'Active',
          'Review',
          'Closed',
        ]);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] publishes under an open draft and keeps the draft as its author saved it', async () => {
      const { database, db } = await atBefore0089();
      try {
        const before = await atDefault(db);
        const saved = { ...before.definition, description: undefined };
        await sql`
          INSERT INTO workflow_version (workspace_id, workflow_id, version, definition)
          VALUES (1, ${before.id}, 2, ${JSON.stringify(saved)})`.execute(db);
        await sql`
          INSERT INTO workflow_version_status (workspace_id, workflow_id, version, status_id)
          SELECT workspace_id, workflow_id, 2, status_id FROM workflow_version_status
           WHERE workflow_id = ${before.id} AND version = 1`.execute(db);
        await sql`UPDATE workflow SET draft_version = 2 WHERE id = ${before.id}`.execute(db);
        await migrateToLatest(db);
        const after = await atDefault(db);
        expect(after.published_version).toBe(2);
        expect(after.draft_version).toBe(3);
        expect(after.definition.transitions.map((t) => [t.id, t.from, t.layout])).toEqual(FREE);
        const { rows } = await sql<{ definition: unknown }>`
          SELECT definition FROM workflow_version
           WHERE workflow_id = ${before.id} AND version = 3`.execute(db);
        expect(rows[0]?.definition).toEqual(before.definition);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });

    it('[WF-008] leaves version 1 when it is no longer what the seed wrote', async () => {
      const { database, db } = await atBefore0089();
      try {
        await sql`UPDATE status SET name = 'Review' WHERE name = 'In Review'`.execute(db);
        const before = await atDefault(db);
        const edited = {
          ...before.definition,
          transitions: before.definition.transitions.map((t) =>
            t.id === 1 ? { ...t, name: 'Begin' } : t,
          ),
        };
        await sql`
          UPDATE workflow_version SET definition = ${JSON.stringify(edited)}
           WHERE workflow_id = ${before.id} AND version = 1`.execute(db);
        await migrateToLatest(db);
        const after = await atDefault(db);
        expect(after.published_version).toBe(1);
        expect(after.definition).toEqual(edited);
      } finally {
        await db.destroy();
        await database.drop();
      }
    });
  });

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
