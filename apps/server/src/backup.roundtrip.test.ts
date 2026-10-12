import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@tracksmith/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backup, clientBinary, restore, serverMajor, tableChecksums } from './backup';

/**
 * The restore drill in miniature: back up a database, change it, restore, and compare the
 * table checksums. It needs pg_dump and pg_restore of the server's major version (the image
 * has them; locally, point TRACKSMITH_PG_BIN at a PostgreSQL client installation), and skips
 * otherwise; CI's image job runs the full drill against the Compose kit.
 */
describe('backup and restore round trip', () => {
  const database = useMigratedDatabase();
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'tracksmith-roundtrip-'));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('[OPS-008] [OPS-009] restores every row the backup held', async ({ skip }) => {
    const major = await serverMajor(database.db);
    const pgDump = clientBinary('pg_dump', major);
    let available = false;
    try {
      available = execFileSync(pgDump, ['--version'], { encoding: 'utf8' }).includes(` ${major}.`);
    } catch {
      available = false;
    }
    if (!available) skip(`no pg_dump for PostgreSQL ${major} on this machine`);

    await database.db
      .insertInto('instance_setting')
      .values({ key: 'drill', value: '{"kept":true}' })
      .execute();
    const before = await tableChecksums(database.db);

    const out = join(dir, 'backup');
    const manifest = await backup(database.db, out, {
      databaseUrl: database.url,
      dataDir: dir,
      version: 'test',
    });
    expect(manifest.checksums['db.dump']).toMatch(/^[0-9a-f]{64}$/);

    await database.db.deleteFrom('instance_setting').execute();
    expect((await tableChecksums(database.db)).instance_setting).not.toBe(before.instance_setting);

    const restored = await restore(database.db, out, { databaseUrl: database.url, dataDir: dir });
    expect(restored.createdAt).toBe(manifest.createdAt);
    expect(await tableChecksums(database.db)).toEqual(before);
  });
});

describe('client binaries', () => {
  it('[OPS-009] prefers the directory for the server major and falls back to PATH', () => {
    expect(clientBinary('pg_restore', 16, {})).toBe('pg_restore');
    expect(clientBinary('pg_dump', 16, { TRACKSMITH_PG_BIN: join(tmpdir(), 'nope') })).toBe(
      'pg_dump',
    );
  });
});
