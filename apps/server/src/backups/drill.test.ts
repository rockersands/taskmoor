import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAudit } from '../audit/chain';
import {
  type BackupManifest,
  backup,
  clientBinary,
  restore,
  serverMajor,
  tableChecksums,
} from '../backup';
import { latestBackup, recordedDrill, restoreDrill, scratchUrl } from './drill';
import { recordedBackup } from './schedule';

const run = promisify(execFile);

/**
 * The restore drill (M1-101, OPS-008 (2)) against real pg_dump and pg_restore of the server's
 * major version; skipped where they are missing (CI and the image have them).
 */
describe('the restore drill', () => {
  const database = useMigratedDatabase();
  let dir: string;
  let available = false;

  const drills = async () => {
    const { rows } = await sql<{ datname: string }>`
      SELECT datname FROM pg_database WHERE datname LIKE 'taskmoor_drill_%'`.execute(database.db);
    return rows.map((r) => r.datname);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'taskmoor-drill-'));
    const major = await serverMajor(database.db);
    try {
      available = execFileSync(clientBinary('pg_dump', major), ['--version'], {
        encoding: 'utf8',
      }).includes(` ${major}.`);
    } catch {
      available = false;
    }
    // Something in most tables that matter, a partitioned one included.
    await database.db
      .insertInto('instance_setting')
      .values({ key: 'drill', value: '{"kept":true}' })
      .execute();
    await appendAudit(database.db, [{ workspaceId: 1, actorId: null, action: 'drill.recorded' }]);
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('[OPS-008] counts every table in the snapshot the dump holds', async ({ skip }) => {
    if (!available) skip('no pg_dump for this server version');
    const out = join(dir, 'counted');
    const manifest = await backup(database.db, out, { databaseUrl: database.url, version: 'test' });
    expect(manifest.rowCounts?.instance_setting).toBeGreaterThanOrEqual(1);
    expect(manifest.rowCounts?.audit_event).toBe(1);
    // The backup log is not part of a backup: a restore keeps the live one.
    expect(manifest.rowCounts).not.toHaveProperty('backup_run');
    // The password never reaches the command line: it travels in PGPASSWORD.
    expect(JSON.stringify(manifest)).not.toContain('postgres:postgres@');
  });

  it('[OPS-008] (2) restores into a scratch database, checks every table and drops it', async ({
    skip,
  }) => {
    if (!available) skip('no pg_dump for this server version');
    const out = join(dir, 'drilled');
    await recordedBackup(database.db, 'manual', out, {
      databaseUrl: database.url,
      version: 'test',
    });
    const log: string[] = [];
    const report = await recordedDrill(database.db, {
      databaseUrl: database.url,
      dir: out,
      log: (m) => log.push(m),
    });
    expect(report).toMatchObject({
      backup: out,
      ok: true,
      countsChecked: true,
      migrationsMatch: true,
      mismatches: [],
    });
    expect(report.tables).toBeGreaterThan(50);
    expect(report.rows).toBeGreaterThan(0);
    expect(report.seconds.total).toBeGreaterThanOrEqual(report.seconds.restore);
    expect(report.scratchDatabase).toMatch(/^taskmoor_drill_\d{14}_\d+$/);
    expect(await drills()).toEqual([]);
    expect(log.join('\n')).not.toContain('postgres:postgres@');
    const [drill] = await database.db
      .selectFrom('backup_run')
      .selectAll()
      .where('kind', '=', 'drill')
      .execute();
    expect(drill).toMatchObject({ state: 'succeeded', path: out });
    expect(drill?.details).toMatchObject({ countsChecked: true, migrationsMatch: true });
  });

  it('[OPS-008] (2) reports a table whose rows did not come back as a failed drill', async ({
    skip,
  }) => {
    if (!available) skip('no pg_dump for this server version');
    const out = join(dir, 'drilled');
    // The manifest claims a row the dump does not hold (the manifest has no checksum of its own).
    const path = join(out, 'manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest;
    manifest.rowCounts = {
      ...manifest.rowCounts,
      instance_setting: (manifest.rowCounts?.instance_setting ?? 0) + 1,
    };
    writeFileSync(path, JSON.stringify(manifest));
    const report = await recordedDrill(database.db, { databaseUrl: database.url, dir: out });
    expect(report.ok).toBe(false);
    expect(report.mismatches).toEqual([
      {
        table: 'instance_setting',
        expected: manifest.rowCounts.instance_setting,
        actual: (manifest.rowCounts.instance_setting ?? 1) - 1,
      },
    ]);
    const [failed] = await database.db
      .selectFrom('backup_run')
      .selectAll()
      .where('kind', '=', 'drill')
      .orderBy('id', 'desc')
      .execute();
    expect(failed).toMatchObject({
      state: 'failed',
      error: '1 table(s) restored with other row counts',
    });
    expect(await drills()).toEqual([]);
  });

  it('[OPS-009] refuses a damaged backup before it creates anything', async ({ skip }) => {
    if (!available) skip('no pg_dump for this server version');
    const out = join(dir, 'damaged');
    await backup(database.db, out, { databaseUrl: database.url, version: 'test' });
    writeFileSync(join(out, 'db.dump'), 'tampered');
    await expect(
      restoreDrill(database.db, { databaseUrl: database.url, dir: out }),
    ).rejects.toThrow(/checksums differ: db.dump/);
    expect(await drills()).toEqual([]);
  });

  it('[OPS-009] keeps the live backup log through a restore', async ({ skip }) => {
    if (!available) skip('no pg_dump for this server version');
    const out = join(dir, 'restored');
    await recordedBackup(database.db, 'manual', out, {
      databaseUrl: database.url,
      version: 'test',
    });
    const log = await database.db.selectFrom('backup_run').selectAll().orderBy('id').execute();
    const before = await tableChecksums(database.db);
    await restore(database.db, out, { databaseUrl: database.url });
    expect(await tableChecksums(database.db)).toEqual(before);
    expect(await database.db.selectFrom('backup_run').selectAll().orderBy('id').execute()).toEqual(
      log,
    );
    // New runs carry on after the restored ones.
    const next = await recordedBackup(database.db, 'manual', join(dir, 'after'), {
      databaseUrl: database.url,
      version: 'test',
    });
    expect(Number(next.runId)).toBeGreaterThan(Number(log[log.length - 1]?.id));
  });

  it('[OPS-008] finds the newest backup by its manifest', () => {
    const root = mkdtempSync(join(tmpdir(), 'taskmoor-latest-'));
    try {
      expect(latestBackup(join(root, 'missing'))).toBeNull();
      for (const [name, at] of [
        ['b', '2026-10-02T00:00:00Z'],
        ['a', '2026-10-03T00:00:00Z'],
        ['c', '2026-10-01T00:00:00Z'],
      ] as const) {
        execFileSync('mkdir', ['-p', join(root, name)]);
        writeFileSync(join(root, name, 'manifest.json'), JSON.stringify({ createdAt: at }));
      }
      expect(latestBackup(root)).toBe(join(root, 'a'));
      expect(scratchUrl('postgres://u:p@db:5432/taskmoor?sslmode=require', 'scratch')).toBe(
        'postgres://u:p@db:5432/scratch?sslmode=require',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it(
    '[OPS-008] runs as `node cli.mjs drill` on the latest backup and exits 0 when it passes',
    async ({ skip }) => {
      if (!available) skip('no pg_dump for this server version');
      const data = mkdtempSync(join(tmpdir(), 'taskmoor-cli-'));
      try {
        const tsx = createRequire(import.meta.url).resolve('tsx/cli');
        const cli = fileURLToPath(new URL('../cli.ts', import.meta.url));
        const env = {
          ...process.env,
          DATABASE_URL: database.url,
          TASKMOOR_DATA: data,
          LOG_LEVEL: 'silent',
        };
        const taken = await run(process.execPath, [tsx, cli, 'backup'], { env });
        expect(taken.stdout).toMatch(/backup complete/);
        const drilled = await run(process.execPath, [tsx, cli, 'drill'], { env });
        expect(drilled.stdout).toMatch(
          /restore drill passed: \d+ tables, \d+ rows; verify .* total [\d.]+ s/,
        );
        expect(drilled.stdout).not.toContain('postgres:postgres@');
        const report = JSON.parse(drilled.stdout.trim().split('\n').pop() ?? '{}');
        expect(report).toMatchObject({ ok: true, countsChecked: true });
        expect(report.backup.startsWith(join(data, 'backups'))).toBe(true);
        expect(await drills()).toEqual([]);
        // With nothing to drill it says so and exits 2.
        const empty = mkdtempSync(join(tmpdir(), 'taskmoor-cli-empty-'));
        const none = await run(process.execPath, [tsx, cli, 'drill'], {
          env: { ...env, TASKMOOR_DATA: empty },
        }).catch((error: { code: number; stderr: string }) => error);
        expect(none).toMatchObject({ code: 2 });
        expect((none as { stderr: string }).stderr).toMatch(/no backup found/);
        rmSync(empty, { recursive: true, force: true });
      } finally {
        rmSync(data, { recursive: true, force: true });
      }
    },
    process.platform === 'win32' ? 180_000 : 60_000,
  );
});
