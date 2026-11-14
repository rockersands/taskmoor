import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import { hashPassword } from '@taskmoor/iam';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { SESSION_COOKIE } from '../auth';
import type { BackupManifest, backup } from '../backup';
import { enqueue, JobRunner } from '../events/queue';
import { writeSetting } from '../setup';
import { BackupBusyError, failStaleRuns, startRun } from './runs';
import {
  BACKUP_TASK,
  backupDirectory,
  backupDue,
  backupSchedule,
  backupStatus,
  backupWorkerState,
  DEFAULT_BACKUP_SCHEDULE,
  nextBackupAt,
  recordedBackup,
  registerBackupJobs,
  runScheduledBackup,
  scheduleBackups,
  scheduleSlot,
} from './schedule';

/** A stand-in for pg_dump: a directory with a manifest, as `backup` leaves one. */
const fakeBackup: typeof backup = async (_db, out, options) => {
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'db.dump'), 'pretend dump');
  const manifest: BackupManifest = {
    version: options.version,
    createdAt: new Date().toISOString(),
    migrations: ['0001_foundation'],
    checksums: { 'db.dump': 'x' },
    rowCounts: { ticket: 2, track: 1 },
  };
  writeFileSync(join(out, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
};

const at = (iso: string) => new Date(iso);

describe('the backup schedule (M1-101, OPS-008)', () => {
  it('[OPS-008] is on by default: every day at 02:30 UTC, keeping 14, verified weekly', () => {
    expect(DEFAULT_BACKUP_SCHEDULE).toEqual({
      enabled: true,
      time: '02:30',
      keep: 14,
      verify: true,
    });
  });

  it('[OPS-008] is due once a day from its time on', () => {
    const s = DEFAULT_BACKUP_SCHEDULE;
    expect(scheduleSlot(s, at('2026-10-28T17:00:00Z')).toISOString()).toBe(
      '2026-10-28T02:30:00.000Z',
    );
    expect(backupDue(s, null, at('2026-10-28T02:29:59Z'))).toBe(false);
    expect(backupDue(s, null, at('2026-10-28T02:30:00Z'))).toBe(true);
    expect(backupDue(s, at('2026-10-27T02:30:05Z'), at('2026-10-28T09:00:00Z'))).toBe(true);
    expect(backupDue(s, at('2026-10-28T02:30:05Z'), at('2026-10-28T23:59:00Z'))).toBe(false);
    expect(backupDue({ ...s, enabled: false }, null, at('2026-10-28T09:00:00Z'))).toBe(false);
    expect(
      nextBackupAt(s, at('2026-10-28T02:30:05Z'), at('2026-10-28T09:00:00Z'))?.toISOString(),
    ).toBe('2026-10-29T02:30:00.000Z');
    expect(nextBackupAt(s, null, at('2026-10-28T01:00:00Z'))?.toISOString()).toBe(
      '2026-10-28T02:30:00.000Z',
    );
    expect(nextBackupAt({ ...s, enabled: false }, null, at('2026-10-28T01:00:00Z'))).toBeNull();
  });

  it('[OPS-008] goes to TASKMOOR_BACKUP_DIR, else the data directory, and nowhere when off', () => {
    // Absolute paths of the platform (D:\data\backups on Windows).
    expect(backupDirectory({ dataDir: '/data' })).toBe(resolve('/data', 'backups'));
    expect(backupDirectory({ dataDir: '/data', backupDir: '/mnt/backups' })).toBe(
      resolve('/mnt/backups'),
    );
    expect(backupDirectory({ dataDir: '/data', backupDir: 'off' })).toBeNull();
    expect(backupDirectory({})).toBeNull();
    // Off is said apart from nowhere to put them (S3-AC-1).
    expect(backupWorkerState({ dataDir: '/data' })).toBe('ready');
    expect(backupWorkerState({ dataDir: '/data', backupDir: 'off' })).toBe('off');
    expect(backupWorkerState({})).toBe('no-directory');
  });
});

describe('scheduled backups (M1-101, OPS-008)', () => {
  const database = useMigratedDatabase();
  let dir: string;
  let app: FastifyInstance;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'taskmoor-schedule-'));
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    const hash = await hashPassword('ladder violet harbour');
    for (const [name, admin] of [
      ['admin', true],
      ['alice', false],
    ] as const) {
      await database.db
        .insertInto('app_user')
        .values({
          workspace_id: 1,
          email: `${name}@example.com`,
          name,
          password_hash: hash,
          is_site_admin: admin,
        })
        .execute();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/session',
        payload: { email: `${name}@example.com`, password: 'ladder violet harbour' },
      });
      const header = res.headers['set-cookie'];
      const list = Array.isArray(header) ? header : [String(header)];
      cookies[name] = list.find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? '';
    }
  });
  beforeEach(async () => {
    await database.db.deleteFrom('backup_run').execute();
    await database.db.deleteFrom('job').execute();
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("[OPS-008] queues nothing before first-run setup, then the day's backup once", async () => {
    const now = at('2026-10-28T03:00:00Z');
    expect(await scheduleBackups(database.db, now)).toBe(false);
    await writeSetting(database.db, 'setup', { completed: true });
    expect(await scheduleBackups(database.db, now)).toBe(true);
    // Every worker asks; the key lets one job through.
    expect(await scheduleBackups(database.db, at('2026-10-28T03:05:00Z'))).toBe(false);
    const jobs = await database.db.selectFrom('job').select(['task', 'key']).execute();
    expect(jobs).toEqual([{ task: BACKUP_TASK, key: `${BACKUP_TASK}:2026-10-28T02:30:00.000Z` }]);
  });

  it('[OPS-008] (1) a nightly backup with 14-day retention keeps exactly 14 backups', async () => {
    const root = join(dir, 'nightly');
    for (let day = 1; day <= 20; day++) {
      const now = at(`2026-11-${String(day).padStart(2, '0')}T02:31:00Z`);
      const outcome = await runScheduledBackup(database.db, {
        databaseUrl: database.url,
        backupDir: root,
        version: 'test',
        now: () => now,
        take: fakeBackup,
      });
      expect(outcome.state).toBe('succeeded');
      if (day === 1) {
        // Created owner-only: backups hold the password keyring (POSIX modes; Windows has ACLs).
        if (process.platform !== 'win32') expect(statSync(root).mode & 0o777).toBe(0o700);
        // A backup taken by hand sits next to them and is never removed by the retention.
        mkdirSync(join(root, 'by-hand'));
        writeFileSync(join(root, 'by-hand', 'manifest.json'), '{}');
      }
      // Running again for the same night does nothing.
      expect(
        await runScheduledBackup(database.db, {
          databaseUrl: database.url,
          backupDir: root,
          version: 'test',
          now: () => now,
          take: fakeBackup,
        }),
      ).toEqual({ state: 'skipped', reason: 'already backed up' });
    }
    const kept = readdirSync(root)
      .filter((d) => d.startsWith('scheduled-'))
      .sort();
    expect(kept).toHaveLength(14);
    expect(kept[0]).toBe('scheduled-2026-11-07T02-31-00');
    expect(kept[13]).toBe('scheduled-2026-11-20T02-31-00');
    expect(existsSync(join(root, 'by-hand', 'manifest.json'))).toBe(true);
    const runs = await database.db
      .selectFrom('backup_run')
      .select(['state', 'pruned_at'])
      .where('kind', '=', 'scheduled')
      .execute();
    expect(runs).toHaveLength(20);
    expect(runs.filter((r) => r.pruned_at === null)).toHaveLength(14);
  });

  it('[OPS-008] records a failed backup with its error, never the password, and leaves no partial directory', async () => {
    const root = join(dir, 'failing');
    const failing: typeof backup = async (_db, out) => {
      mkdirSync(out, { recursive: true });
      writeFileSync(join(out, 'db.dump'), 'half');
      throw new Error(
        'Command failed: pg_dump postgres://taskmoor:not-a-real-password@db:5432/taskmoor',
      );
    };
    await expect(
      runScheduledBackup(database.db, {
        databaseUrl: database.url,
        backupDir: root,
        version: 'test',
        take: failing,
      }),
    ).rejects.toThrow(/pg_dump/);
    expect(readdirSync(root)).toEqual([]);
    const [run] = await database.db.selectFrom('backup_run').selectAll().execute();
    expect(run?.state).toBe('failed');
    expect(run?.error).toContain('postgres://taskmoor:***@db:5432/taskmoor');
    expect(run?.error).not.toContain('not-a-real-password');
  });

  it('[OPS-008] (2) follows a scheduled backup with the restore drill once a week', async () => {
    const root = join(dir, 'weekly');
    const runner = new JobRunner(database.db, 'test-worker');
    const day = (n: number) => at(`2026-12-${String(n).padStart(2, '0')}T02:31:00Z`);
    let today = day(1);
    registerBackupJobs(runner, database.db, {
      databaseUrl: database.url,
      backupDir: root,
      version: 'test',
      now: () => today,
      take: fakeBackup,
    });
    const nightly = async () => {
      await enqueue(database.db, [
        { workspaceId: 1, task: BACKUP_TASK, key: `${BACKUP_TASK}:${today.toISOString()}` },
      ]);
      // The backup, then the drill it queued (the fake dump does not restore: a failed drill).
      await runner.runOnce();
      await runner.runOnce();
    };
    const drills = () =>
      database.db.selectFrom('backup_run').select('state').where('kind', '=', 'drill').execute();
    await nightly();
    expect(await drills()).toEqual([{ state: 'failed' }]);
    for (let n = 2; n <= 7; n++) {
      today = day(n);
      await nightly();
    }
    // A week later, the next one.
    expect(await drills()).toHaveLength(1);
    today = day(8);
    await nightly();
    expect(await drills()).toHaveLength(2);
    const runs = await database.db
      .selectFrom('backup_run')
      .select('state')
      .where('kind', '=', 'scheduled')
      .execute();
    expect(runs.map((r) => r.state)).toEqual(Array(8).fill('succeeded'));
  });

  it('[OPS-008] says so when this worker has no backup directory', async () => {
    const outcome = await runScheduledBackup(database.db, {
      databaseUrl: database.url,
      backupDir: null,
      version: 'test',
    });
    expect(outcome).toEqual({ state: 'skipped', reason: 'no backup directory' });
    const [run] = await database.db.selectFrom('backup_run').selectAll().execute();
    expect(run).toMatchObject({ kind: 'scheduled', state: 'failed' });
    expect(run?.error).toMatch(/TASKMOOR_BACKUP_DIR/);
  });

  it('[OPS-008] gives the reason a worker with backups turned off took none, not a setting to set (S3-AC-1)', async () => {
    await runScheduledBackup(database.db, {
      databaseUrl: database.url,
      backupDir: null,
      declined: 'off',
      version: 'test',
    });
    const [run] = await database.db.selectFrom('backup_run').selectAll().execute();
    expect(run).toMatchObject({ kind: 'scheduled', state: 'failed', details: { reason: 'off' } });
    expect(run?.error).toMatch(/off on this worker/);
    expect(run?.error).not.toMatch(/TASKMOOR_DATA/);
  });

  it('[OPS-008] leaves the backup to a worker that has a place for it, and promises none when no worker has (S3-AC-1)', async () => {
    await writeSetting(database.db, 'setup', { completed: true });
    const now = at('2026-12-20T03:00:00Z');
    const slot = '2026-12-20T02:30:00.000Z';
    // A worker with scheduled backups turned off (TASKMOOR_BACKUP_DIR=off) queues nothing, and
    // the status page promises no next backup and says why.
    expect(await scheduleBackups(database.db, now, 'off')).toBe(false);
    expect(await database.db.selectFrom('job').select('id').execute()).toEqual([]);
    expect(await backupStatus(database.db, now)).toMatchObject({ workers: 'off', nextAt: null });
    // Nor with nowhere to put one.
    expect(await scheduleBackups(database.db, now, 'no-directory')).toBe(false);
    expect(await backupStatus(database.db, now)).toMatchObject({
      workers: 'no-directory',
      nextAt: null,
    });

    // Once a worker that can take it checks, the backup is queued and promised.
    expect(await scheduleBackups(database.db, now, 'ready')).toBe(true);
    expect(await backupStatus(database.db, now)).toMatchObject({ workers: 'ready', nextAt: slot });
    // The worker without a place never claims the job, so it records no failure and spends
    // none of the job's attempts; the one with a place takes it.
    const off = new JobRunner(database.db, 'worker-off');
    registerBackupJobs(off, database.db, {
      databaseUrl: database.url,
      backupDir: null,
      declined: 'off',
      version: 'test',
      now: () => now,
    });
    expect(await off.runOnce()).toBe(0);
    expect(await database.db.selectFrom('job').select(['attempts', 'done_at']).execute()).toEqual([
      { attempts: 0, done_at: null },
    ]);
    expect(await database.db.selectFrom('backup_run').select('id').execute()).toEqual([]);
    const ready = new JobRunner(database.db, 'worker-ready');
    registerBackupJobs(ready, database.db, {
      databaseUrl: database.url,
      backupDir: join(dir, 'shared'),
      version: 'test',
      now: () => now,
      take: fakeBackup,
    });
    expect(await ready.runOnce()).toBe(1);
    expect(await database.db.selectFrom('backup_run').select(['kind', 'state']).execute()).toEqual([
      { kind: 'scheduled', state: 'succeeded' },
    ]);

    // A worker that stopped checking no longer counts: three missed checks.
    const later = new Date(now.getTime() + 16 * 60_000);
    await scheduleBackups(database.db, later, 'off');
    expect(await backupStatus(database.db, later)).toMatchObject({ workers: 'off', nextAt: null });
  });

  it('[OPS-008] runs one backup at a time and fails runs whose process died', async () => {
    const first = await startRun(database.db, 'manual', join(dir, 'a'));
    await expect(startRun(database.db, 'scheduled', join(dir, 'b'))).rejects.toBeInstanceOf(
      BackupBusyError,
    );
    // A drill may run next to a backup.
    await startRun(database.db, 'drill', join(dir, 'a'));
    await database.db
      .updateTable('backup_run')
      .set({ heartbeat_at: new Date(Date.now() - 6 * 60_000) })
      .where('id', '=', first)
      .execute();
    expect(await failStaleRuns(database.db)).toBe(1);
    await startRun(database.db, 'scheduled', join(dir, 'b'));
  });

  it('[OPS-008] shows administrators the schedule, the last success and failure, and lets them change it', async () => {
    const root = join(dir, 'status');
    await recordedBackup(
      database.db,
      'manual',
      join(root, 'one'),
      {
        databaseUrl: database.url,
        version: 'test',
      },
      { take: fakeBackup },
    );
    await expect(
      recordedBackup(
        database.db,
        'manual',
        join(root, 'two'),
        { databaseUrl: database.url, version: 'test' },
        {
          take: async () => {
            throw new Error('disk full');
          },
        },
      ),
    ).rejects.toThrow('disk full');

    const as = (who: string, method: 'GET' | 'PUT', url: string, payload?: object) =>
      app.inject({
        method,
        url,
        headers: { cookie: cookies[who] ?? '' },
        ...(payload ? { payload } : {}),
      });
    expect((await as('alice', 'GET', '/api/v1/admin/backups')).statusCode).toBe(403);
    const status = (await as('admin', 'GET', '/api/v1/admin/backups')).json();
    expect(status).toMatchObject({
      schedule: DEFAULT_BACKUP_SCHEDULE,
      running: null,
      lastSuccess: {
        kind: 'manual',
        state: 'succeeded',
        path: join(root, 'one'),
        sizeBytes: expect.any(Number),
      },
      lastFailure: { kind: 'manual', state: 'failed', error: 'disk full' },
      lastDrill: null,
      kept: 0,
    });
    expect(status.recent).toHaveLength(2);
    expect(status.lastSuccess.details).toMatchObject({ entries: 1, migrations: 1, rows: 3 });
    // The status page shows the same.
    const system = (await as('admin', 'GET', '/api/v1/admin/system')).json();
    expect(system.backups).toMatchObject({ lastFailure: { error: 'disk full' } });

    for (const bad of [
      { time: '25:00' },
      { keep: 0 },
      { keep: 366 },
      { directory: '/tmp' },
      { enabled: 'yes' },
    ]) {
      expect(
        (await as('admin', 'PUT', '/api/v1/admin/backups/schedule', bad)).statusCode,
        JSON.stringify(bad),
      ).toBe(400);
    }
    expect(
      (await as('alice', 'PUT', '/api/v1/admin/backups/schedule', { keep: 7 })).statusCode,
    ).toBe(403);
    const changed = await as('admin', 'PUT', '/api/v1/admin/backups/schedule', {
      time: '04:05',
      keep: 7,
    });
    expect(changed.json()).toEqual({
      schedule: { enabled: true, time: '04:05', keep: 7, verify: true },
    });
    expect(await backupSchedule(database.db)).toEqual({
      enabled: true,
      time: '04:05',
      keep: 7,
      verify: true,
    });
    const [event] = await database.db
      .selectFrom('domain_event')
      .select('payload')
      .where('type', '=', 'backup_schedule.updated')
      .execute();
    expect(event?.payload).toEqual({
      changes: { time: { from: '02:30', to: '04:05' }, keep: { from: 14, to: 7 } },
    });
    await as('admin', 'PUT', '/api/v1/admin/backups/schedule', { enabled: false });
    expect((await as('admin', 'GET', '/api/v1/admin/backups')).json().nextAt).toBeNull();
    await as('admin', 'PUT', '/api/v1/admin/backups/schedule', { ...DEFAULT_BACKUP_SCHEDULE });
  });
});
