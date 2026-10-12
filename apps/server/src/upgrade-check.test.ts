import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@taskmoor/db';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkUpgrade, formatChecks } from './upgrade-check';

describe('pre-upgrade check', () => {
  const database = useMigratedDatabase();
  let dataDir: string;

  beforeAll(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'taskmoor-data-'));
    mkdirSync(join(dataDir, 'backups'));
  });
  afterAll(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('[OPS-006] passes on a current database with a fresh backup and room on disk', async () => {
    writeFileSync(join(dataDir, 'backups', 'last'), '');
    const checks = await checkUpgrade(database.db, { dataDir });
    expect(checks.map((c) => `${c.name}:${c.state}`)).toEqual([
      'database:ok',
      'postgres-version:ok',
      'migrations:ok',
      'disk-space:ok',
      'backup:ok',
    ]);
    expect(formatChecks(checks)).toContain('Upgrade can proceed.');
  });

  it('[OPS-006] warns on a stale or missing backup and when no data directory is given', async () => {
    const old = new Date(Date.now() - 40 * 3_600_000);
    utimesSync(join(dataDir, 'backups', 'last'), old, old);
    const stale = await checkUpgrade(database.db, { dataDir });
    expect(stale.find((c) => c.name === 'backup')).toMatchObject({ state: 'warn' });
    expect(stale.find((c) => c.name === 'backup')?.detail).toMatch(/40 h ago/);

    rmSync(join(dataDir, 'backups', 'last'));
    const missing = await checkUpgrade(database.db, { dataDir });
    expect(missing.find((c) => c.name === 'backup')?.detail).toMatch(/no backup recorded/);

    const none = await checkUpgrade(database.db);
    expect(none.find((c) => c.name === 'disk-space')).toMatchObject({ state: 'warn' });
  });

  it('[OPS-006] blocks when the database was migrated by a newer release', async () => {
    await database.db
      .insertInto('schema_migration' as never)
      .values({ name: '9999_newer', timestamp: new Date().toISOString() } as never)
      .execute();
    try {
      const checks = await checkUpgrade(database.db);
      expect(checks.find((c) => c.name === 'migrations')).toMatchObject({ state: 'block' });
      expect(formatChecks(checks)).toContain('1 blocking problem(s)');
    } finally {
      await database.db
        .deleteFrom('schema_migration' as never)
        .where('name' as never, '=', '9999_newer' as never)
        .execute();
    }
  });

  it('[OPS-006] blocks when the database is unreachable', async () => {
    const db = createDb({
      connectionString: 'postgres://nobody@127.0.0.1:1/none',
      maxConnections: 1,
    });
    try {
      const checks = await checkUpgrade(db);
      expect(checks).toHaveLength(1);
      expect(checks[0]).toMatchObject({ name: 'database', state: 'block' });
    } finally {
      await db.destroy();
    }
  });
});
