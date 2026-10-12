import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { backupSize, sha256File, tableChecksums, verifyBackup } from './backup';

describe('backup manifests', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'taskmoor-backup-'));
    writeFileSync(join(dir, 'db.dump'), 'pretend dump');
    writeFileSync(join(dir, 'config.json'), '{}\n');
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('[OPS-009] accepts an archive whose checksums match and refuses a damaged one', () => {
    const manifest = {
      version: '1.0.0',
      createdAt: '2026-10-12T00:00:00Z',
      migrations: ['0001_foundation'],
      checksums: {
        'db.dump': sha256File(join(dir, 'db.dump')),
        'config.json': sha256File(join(dir, 'config.json')),
      },
    };
    writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
    expect(verifyBackup(dir)).toEqual(manifest);
    expect(backupSize(dir)).toBeGreaterThan(0);

    writeFileSync(join(dir, 'db.dump'), 'tampered');
    expect(() => verifyBackup(dir)).toThrow(/checksums differ: db.dump/);
    expect(() => verifyBackup(join(dir, 'nope'))).toThrow(/no manifest.json/);
  });
});

describe('table checksums', () => {
  const database = useMigratedDatabase();

  it('[OPS-009] change when a row changes and are stable otherwise', async () => {
    const before = await tableChecksums(database.db);
    expect(Object.keys(before)).toContain('app_user');
    expect(before.app_user).toBe('0:empty');
    expect(await tableChecksums(database.db)).toEqual(before);

    await database.db
      .insertInto('instance_setting')
      .values({ key: 'drill', value: '{"a":1}' })
      .execute();
    const after = await tableChecksums(database.db);
    expect(after.instance_setting).not.toBe(before.instance_setting);
    expect(after.instance_setting?.startsWith('1:')).toBe(true);
    expect(after.app_user).toBe(before.app_user);
  });
});
