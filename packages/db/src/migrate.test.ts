import { readdirSync } from 'node:fs';
import { createDatabase, testPgAdminUrl, useTestDatabase } from '@taskmoor/testkit/pg';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { createDb } from './client';
import {
  knownMigrations,
  MIGRATION_TABLE,
  MigrationError,
  type MigrationSet,
  migrateTo,
  migrateToLatest,
  migrationStatus,
  migrationsFingerprint,
  segmentPlan,
  type TaskmoorMigration,
} from './migrate';
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

describe('migration segments (ADR-022, M1-102)', () => {
  const tableExists = async (db: ReturnType<typeof createDb>, name: string) => {
    const { rows } = await sql<{
      ok: boolean;
    }>`SELECT to_regclass(${name}) IS NOT NULL AS ok`.execute(db);
    return rows[0]?.ok === true;
  };
  const appliedNames = async (db: ReturnType<typeof createDb>) =>
    (await migrationStatus(db, extra)).applied;

  // A small set of its own: two ordinary migrations, an online one, then two ordinary ones.
  const extra: MigrationSet = {
    '0001_a': { up: async (db) => void (await sql`CREATE TABLE a (id int)`.execute(db)) },
    '0002_b': {
      up: async (db) => void (await sql`INSERT INTO a VALUES (1), (2)`.execute(db)),
    },
    '0003_index': {
      online: true,
      up: async (db) => void (await sql`CREATE INDEX CONCURRENTLY a_id_idx ON a (id)`.execute(db)),
    },
    '0004_c': { up: async (db) => void (await sql`CREATE TABLE c (id int)`.execute(db)) },
    '0005_d': { up: async (db) => void (await sql`ALTER TABLE c ADD COLUMN x int`.execute(db)) },
  };

  it('[OPS-006] groups ordinary migrations into one transaction and runs online ones alone', () => {
    expect(segmentPlan(knownMigrations(extra), extra)).toEqual([
      { online: false, names: ['0001_a', '0002_b'] },
      { online: true, names: ['0003_index'] },
      { online: false, names: ['0004_c', '0005_d'] },
    ]);
    expect(segmentPlan([], extra)).toEqual([]);
  });

  it('[OPS-006] runs an online migration outside a transaction, times each one and reports status', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: fresh.url, maxConnections: 2 });
    try {
      const timed: string[] = [];
      const applied = await migrateToLatest(db, {
        migrations: extra,
        onApplied: (name, ms) => {
          expect(ms).toBeGreaterThanOrEqual(0);
          timed.push(name);
        },
      });
      expect(applied).toEqual(knownMigrations(extra));
      expect(timed).toEqual(applied);
      expect(await tableExists(db, 'a_id_idx')).toBe(true);
      expect(await migrationStatus(db, extra)).toMatchObject({ pending: [], unknown: [] });
      // Against the shipped set, these names are unknown: a newer release migrated it.
      expect((await migrationStatus(db)).unknown).toEqual(knownMigrations(extra));
    } finally {
      await db.destroy();
      await fresh.drop();
    }
  });

  it('[OPS-006] rolls back every migration of a failed transaction, leaving the database as it was', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: fresh.url, maxConnections: 2 });
    const failing: MigrationSet = {
      '0001_a': extra['0001_a'] as TaskmoorMigration,
      '0002_b': extra['0002_b'] as TaskmoorMigration,
      '0003_fails': {
        up: async (db) => {
          await sql`CREATE TABLE half_done (id int)`.execute(db);
          await sql`SELECT 1 / 0`.execute(db);
        },
      },
    };
    try {
      const error = await migrateToLatest(db, { migrations: failing }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MigrationError);
      expect(error).toMatchObject({ migration: '0003_fails', committed: [], partial: false });
      expect((error as Error).message).toMatch(/0003_fails failed: division by zero/);
      // Not even the migration table: the first run's bookkeeping was in the transaction too.
      for (const name of ['a', 'half_done', 'schema_migration']) {
        expect(await tableExists(db, name), name).toBe(false);
      }
    } finally {
      await db.destroy();
      await fresh.drop();
    }
  });

  it('[OPS-006] reports what an online migration committed before a later failure', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: fresh.url, maxConnections: 2 });
    const failing: MigrationSet = {
      ...extra,
      '0005_d': {
        up: async (db) => {
          await sql`ALTER TABLE c ADD COLUMN x int`.execute(db);
          throw new Error('injected');
        },
      },
    };
    try {
      const error = await migrateToLatest(db, { migrations: failing }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        migration: '0005_d',
        committed: ['0001_a', '0002_b', '0003_index'],
        partial: false,
      });
      expect(await appliedNames(db)).toEqual(['0001_a', '0002_b', '0003_index']);
      expect(await tableExists(db, 'c')).toBe(false);
    } finally {
      await db.destroy();
      await fresh.drop();
    }
  });

  it('[OPS-006] marks a failed online migration as partial', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: fresh.url, maxConnections: 2 });
    const failing: MigrationSet = {
      '0001_a': extra['0001_a'] as TaskmoorMigration,
      '0002_online': {
        online: true,
        up: async (db) => {
          await sql`CREATE TABLE stuck (id int)`.execute(db);
          await sql`SELECT 1 / 0`.execute(db);
        },
      },
    };
    try {
      const error = await migrateToLatest(db, { migrations: failing }).catch((e: unknown) => e);
      expect(error).toMatchObject({
        migration: '0002_online',
        committed: ['0001_a'],
        partial: true,
      });
      // Without a transaction, what ran before the failure stays: the upgrade restores a backup.
      expect(await tableExists(db, 'stuck')).toBe(true);
    } finally {
      await db.destroy();
      await fresh.drop();
    }
  });

  it('[OPS-006] runs beforeCommit inside the last transaction; throwing there rolls it back', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: fresh.url, maxConnections: 2 });
    const plain: MigrationSet = {
      '0001_a': extra['0001_a'] as TaskmoorMigration,
      '0002_b': extra['0002_b'] as TaskmoorMigration,
    };
    try {
      let seen = -1;
      const error = await migrateToLatest(db, {
        migrations: plain,
        beforeCommit: async (trx) => {
          const { rows } = await sql<{ n: string }>`SELECT count(*) AS n FROM a`.execute(trx);
          seen = Number(rows[0]?.n);
          throw new Error('verification failed');
        },
      }).catch((e: unknown) => e);
      expect(seen).toBe(2);
      expect(error).toMatchObject({ migration: null, committed: [], partial: false });
      expect((error as Error).message).toMatch(/0001_a to 0002_b were rolled back: verification/);
      expect(await tableExists(db, 'a')).toBe(false);
      expect(await migrateTo(db, '0001_a', { migrations: plain })).toEqual(['0001_a']);
      expect(await migrateToLatest(db, { migrations: plain })).toEqual(['0002_b']);
    } finally {
      await db.destroy();
      await fresh.drop();
    }
  });

  it('[OPS-006] lists pending migrations that sort before an applied one as out of order', async () => {
    const fresh = await createDatabase(testPgAdminUrl());
    const db = createDb({ connectionString: fresh.url, maxConnections: 2 });
    try {
      const { '0002_b': _skipped, ...withoutB } = extra;
      await migrateTo(db, '0001_a', { migrations: withoutB });
      await migrateTo(db, '0004_c', { migrations: withoutB });
      expect((await migrationStatus(db, extra)).outOfOrder).toEqual(['0002_b']);
      await expect(migrateToLatest(db, { migrations: extra })).rejects.toThrow(/corrupted/);
    } finally {
      await db.destroy();
      await fresh.drop();
    }
  });
});
