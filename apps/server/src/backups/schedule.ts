import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Database } from '@taskmoor/db';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { type BackupManifest, backup, backupSize } from '../backup';
import { enqueue, type JobRunner } from '../events/queue';
import { readSetting, setupState, writeSetting } from '../setup';
import { defaultWorkspaceId } from '../workspace';
import { recordedDrill } from './drill';
import {
  finishRun,
  message,
  type RunRow,
  type RunView,
  runView,
  startRun,
  withHeartbeat,
} from './runs';

/**
 * Scheduled backups (M1-101, OPS-008; ADR-022).
 *
 * - **On by default:** every day at 02:30 UTC the worker role backs up the database, the files
 *   and the password keyring with the operator CLI's code path (`backup.ts`) into
 *   `TASKMOOR_BACKUP_DIR`, by default `TASKMOOR_DATA/backups` (created owner-only, 0700), one
 *   directory per run named `scheduled-<time>`. Nothing is taken before first-run setup.
 * - **Retention:** after each successful run the oldest scheduled backups beyond `keep`
 *   (default 14, so 14 days of nightly backups) are deleted. Backups taken by hand
 *   (`node cli.mjs backup`) are never deleted by it.
 * - **Verification:** with `verify` on (the default), a scheduled backup is followed, once a
 *   week, by the restore drill (`drill.ts`): it restores into a scratch database, compares
 *   every table's row count with the backup's manifest and drops the scratch database.
 * - **The log:** each backup and drill is a `backup_run` row (state, path, size, what it
 *   measured, a redacted error), which the admin status page reads. At most one backup and one
 *   drill run at a time; a run whose process died is marked failed after five minutes without
 *   a heartbeat.
 * - **Workers that take none:** a worker with `TASKMOOR_BACKUP_DIR=off`, or with neither it nor
 *   `TASKMOOR_DATA`, neither queues the day's backup nor claims it, so a worker that can take
 *   it does. Every worker says at each check whether it can (`backup_worker_ready` and
 *   `backup_worker_declined`), so the status page names no next backup when none can, and
 *   says why, instead of promising one that would fail.
 *
 * Administrators change the schedule with `PUT /api/v1/admin/backups/schedule`; the location
 * is the operator's (an environment variable), never something the API can point elsewhere.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const BACKUP_SCHEDULE_SETTING = 'backup_schedule';

export const backupScheduleShape = z
  .object({
    enabled: z.boolean(),
    /** Time of day in UTC, HH:MM. */
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM in UTC'),
    /** Scheduled backups to keep: one a day, so this many days. */
    keep: z.number().int().min(1).max(365),
    /** Restore the latest scheduled backup into a scratch database once a week. */
    verify: z.boolean(),
  })
  .strict();
export type BackupSchedule = z.infer<typeof backupScheduleShape>;

export const DEFAULT_BACKUP_SCHEDULE: BackupSchedule = {
  enabled: true,
  time: '02:30',
  keep: 14,
  verify: true,
};

/** How often a verification runs, at most. */
export const VERIFY_EVERY_MS = 7 * 86_400_000;

export async function backupSchedule(db: Db): Promise<BackupSchedule> {
  const stored = await readSetting<Partial<BackupSchedule>>(
    db as Kysely<Database>,
    BACKUP_SCHEDULE_SETTING,
  );
  const parsed = backupScheduleShape.safeParse({ ...DEFAULT_BACKUP_SCHEDULE, ...(stored ?? {}) });
  return parsed.success ? parsed.data : { ...DEFAULT_BACKUP_SCHEDULE };
}

export async function setBackupSchedule(db: Db, schedule: BackupSchedule): Promise<void> {
  await writeSetting(db, BACKUP_SCHEDULE_SETTING, schedule);
}

/**
 * Where this process puts scheduled backups: `TASKMOOR_BACKUP_DIR`, else the `backups` folder
 * of the data directory; null when neither is set or the directory is `off`.
 */
export function backupDirectory(config: {
  backupDir?: string | undefined;
  dataDir?: string | undefined;
}): string | null {
  const configured = config.backupDir?.trim();
  if (configured === 'off') return null;
  if (configured) return resolve(configured);
  return config.dataDir ? resolve(config.dataDir, 'backups') : null;
}

/**
 * Whether this process takes scheduled backups: `ready` with a backup directory, `off` when
 * `TASKMOOR_BACKUP_DIR` is `off`, `no-directory` when neither it nor `TASKMOOR_DATA` is set.
 */
export type BackupWorkerState = 'ready' | 'off' | 'no-directory';

export function backupWorkerState(config: {
  backupDir?: string | undefined;
  dataDir?: string | undefined;
}): BackupWorkerState {
  if (config.backupDir?.trim() === 'off') return 'off';
  return backupDirectory(config) === null ? 'no-directory' : 'ready';
}

/** When a worker that can take scheduled backups last checked (every five minutes). */
export const BACKUP_WORKER_READY_SETTING = 'backup_worker_ready';
/** When a worker that cannot last checked, and why. */
export const BACKUP_WORKER_DECLINED_SETTING = 'backup_worker_declined';
/** A check older than this is from a worker that has stopped: three missed checks. */
export const BACKUP_WORKER_FRESH_MS = 15 * 60_000;

/**
 * What the workers said about scheduled backups: `ready` when one that can take them checked
 * lately; `off` or `no-directory` when only workers that cannot did; `unknown` when no worker
 * checked lately (none runs, or none has this version yet).
 */
export type BackupWorkers = BackupWorkerState | 'unknown';

async function checkIn(db: Kysely<Database>, state: BackupWorkerState, now: Date): Promise<void> {
  if (state === 'ready') {
    await writeSetting(db, BACKUP_WORKER_READY_SETTING, { at: now.toISOString() });
  } else {
    await writeSetting(db, BACKUP_WORKER_DECLINED_SETTING, { at: now.toISOString(), why: state });
  }
}

export async function backupWorkers(db: Kysely<Database>, now: Date): Promise<BackupWorkers> {
  const [ready, declined] = await Promise.all([
    readSetting<{ at?: string }>(db, BACKUP_WORKER_READY_SETTING),
    readSetting<{ at?: string; why?: string }>(db, BACKUP_WORKER_DECLINED_SETTING),
  ]);
  const fresh = (at: string | undefined) =>
    at !== undefined && Math.abs(now.getTime() - Date.parse(at)) <= BACKUP_WORKER_FRESH_MS;
  if (fresh(ready?.at)) return 'ready';
  if (fresh(declined?.at)) return declined?.why === 'off' ? 'off' : 'no-directory';
  return 'unknown';
}

/** The scheduled time on the day of `at`, in UTC. */
export function scheduleSlot(schedule: BackupSchedule, at: Date): Date {
  const [hours, minutes] = schedule.time.split(':').map(Number) as [number, number];
  const slot = new Date(at);
  slot.setUTCHours(hours, minutes, 0, 0);
  return slot;
}

/** Due when today's time has come and no scheduled backup started since. */
export function backupDue(
  schedule: BackupSchedule,
  lastStartedAt: Date | null,
  now: Date,
): boolean {
  if (!schedule.enabled) return false;
  const slot = scheduleSlot(schedule, now);
  return now >= slot && (lastStartedAt === null || lastStartedAt < slot);
}

/** When the next scheduled backup starts (now when one is due); null when they are off. */
export function nextBackupAt(
  schedule: BackupSchedule,
  lastStartedAt: Date | null,
  now: Date,
): Date | null {
  if (!schedule.enabled) return null;
  const slot = scheduleSlot(schedule, now);
  if (backupDue(schedule, lastStartedAt, now)) return slot;
  return now < slot ? slot : new Date(slot.getTime() + 86_400_000);
}

export interface BackupTarget {
  databaseUrl: string;
  dataDir?: string | undefined;
  version: string;
  /** Non-secret settings kept next to the data. */
  config?: Record<string, string>;
  log?: (message: string) => void;
}

/**
 * Takes a backup and records it in the log. A failed scheduled backup leaves no directory.
 * `details` go into the log entry beside the measurements (the upgrade command marks its
 * backup `purpose: 'pre-upgrade'`).
 */
export async function recordedBackup(
  db: Kysely<Database>,
  kind: 'scheduled' | 'manual',
  out: string,
  target: BackupTarget,
  options: {
    jobId?: string;
    take?: typeof backup;
    startedAt?: Date;
    details?: Record<string, unknown>;
  } = {},
): Promise<{ runId: string; manifest: BackupManifest; sizeBytes: number }> {
  const runId = await startRun(db, kind, out, options.startedAt);
  const started = Date.now();
  try {
    const manifest = await withHeartbeat(db, runId, options.jobId, () =>
      (options.take ?? backup)(db, out, {
        databaseUrl: target.databaseUrl,
        ...(target.dataDir ? { dataDir: target.dataDir } : {}),
        version: target.version,
        ...(target.config ? { config: target.config } : {}),
        ...(target.log ? { log: target.log } : {}),
      }),
    );
    const sizeBytes = backupSize(out);
    const rows = Object.values(manifest.rowCounts ?? {}).reduce((n, c) => n + c, 0);
    await finishRun(db, runId, {
      state: 'succeeded',
      sizeBytes,
      details: {
        ...options.details,
        seconds: Math.round((Date.now() - started) / 100) / 10,
        entries: Object.keys(manifest.checksums).length,
        migrations: manifest.migrations.length,
        rows,
      },
    });
    return { runId, manifest, sizeBytes };
  } catch (error) {
    if (kind === 'scheduled') rmSync(out, { recursive: true, force: true });
    await finishRun(db, runId, {
      state: 'failed',
      error: message(error),
      ...(options.details ? { details: options.details } : {}),
    });
    throw error;
  }
}

/** Whether `path` lies inside `dir`. */
function inside(dir: string, path: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/**
 * Deletes the scheduled backups beyond the newest `keep` (OPS-008 (1)): only directories in
 * the backup directory that hold a manifest, so nothing else is ever removed. Returns the
 * paths it deleted.
 */
export async function pruneScheduledBackups(
  db: Kysely<Database>,
  keep: number,
  backupDir: string,
  log: (message: string) => void = () => {},
): Promise<string[]> {
  const runs = await db
    .selectFrom('backup_run')
    .select(['id', 'path'])
    .where('kind', '=', 'scheduled')
    .where('state', '=', 'succeeded')
    .where('pruned_at', 'is', null)
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .execute();
  const removed: string[] = [];
  for (const run of runs.slice(keep)) {
    if (run.path && inside(backupDir, run.path) && existsSync(join(run.path, 'manifest.json'))) {
      rmSync(run.path, { recursive: true, force: true });
      removed.push(run.path);
      log(`retention: removed ${run.path}`);
    } else if (run.path && existsSync(run.path)) {
      log(`retention: left ${run.path} in place (outside ${backupDir} or without a manifest)`);
    }
    await db
      .updateTable('backup_run')
      .set({ pruned_at: new Date() })
      .where('id', '=', run.id)
      .execute();
  }
  return removed;
}

export interface ScheduledBackupDeps extends BackupTarget {
  /** From `backupDirectory`; null when this process has none. */
  backupDir: string | null;
  /** Why `backupDir` is null (`backupWorkerState`); `no-directory` when not given. */
  declined?: Exclude<BackupWorkerState, 'ready'>;
  now?: () => Date;
  take?: typeof backup;
}

export type ScheduledOutcome =
  | { state: 'succeeded'; runId: string; path: string; pruned: string[]; verify: boolean }
  | { state: 'skipped'; reason: string };

/** One scheduled backup: take it, apply the retention, say whether a verification is due. */
export async function runScheduledBackup(
  db: Kysely<Database>,
  deps: ScheduledBackupDeps,
  jobId?: string,
): Promise<ScheduledOutcome> {
  const now = deps.now?.() ?? new Date();
  const schedule = await backupSchedule(db);
  const slot = scheduleSlot(schedule, now);
  // A run that already succeeded for this slot (the job ran again after a restore, say).
  const done = await db
    .selectFrom('backup_run')
    .select('id')
    .where('kind', '=', 'scheduled')
    .where('state', '=', 'succeeded')
    .where('started_at', '>=', now >= slot ? slot : new Date(slot.getTime() - 86_400_000))
    .executeTakeFirst();
  if (done) return { state: 'skipped', reason: 'already backed up' };
  if (!deps.backupDir) {
    // A worker like this declines the job (`registerBackupJobs`); this is for a direct call.
    const reason = deps.declined ?? 'no-directory';
    const runId = await startRun(db, 'scheduled', null, now);
    await finishRun(db, runId, {
      state: 'failed',
      details: { reason },
      error:
        reason === 'off'
          ? 'scheduled backups are off on this worker (TASKMOOR_BACKUP_DIR=off)'
          : 'this worker has no backup directory: set TASKMOOR_DATA or TASKMOOR_BACKUP_DIR',
    });
    return { state: 'skipped', reason: 'no backup directory' };
  }
  mkdirSync(deps.backupDir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const out = join(deps.backupDir, `scheduled-${stamp}`);
  const { runId } = await recordedBackup(db, 'scheduled', out, deps, {
    ...(jobId ? { jobId } : {}),
    ...(deps.take ? { take: deps.take } : {}),
    startedAt: now,
  });
  const pruned = await pruneScheduledBackups(db, schedule.keep, deps.backupDir, deps.log);
  const lastDrill = await db
    .selectFrom('backup_run')
    .select('started_at')
    .where('kind', '=', 'drill')
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const verify =
    schedule.verify &&
    (!lastDrill || now.getTime() - lastDrill.started_at.getTime() >= VERIFY_EVERY_MS - 3_600_000);
  return { state: 'succeeded', runId, path: out, pruned, verify };
}

// Jobs

export const BACKUP_TASK = 'backup.scheduled';
export const VERIFY_TASK = 'backup.verify';

/**
 * Queues today's backup when it is due, once across all workers (the key names the slot).
 * Nothing is due before first-run setup: an empty instance needs no backup. Each worker says
 * whether it can take scheduled backups (`worker`); one that cannot queues none, since it
 * would leave a job that it declines.
 */
export async function scheduleBackups(
  db: Kysely<Database>,
  now = new Date(),
  worker: BackupWorkerState = 'ready',
): Promise<boolean> {
  await checkIn(db, worker, now);
  if (worker !== 'ready') return false;
  const schedule = await backupSchedule(db);
  if (!schedule.enabled || !(await setupState(db)).completed) return false;
  const last = await db
    .selectFrom('backup_run')
    .select('started_at')
    .where('kind', '=', 'scheduled')
    .orderBy('started_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  if (!backupDue(schedule, last?.started_at ?? null, now)) return false;
  const slot = scheduleSlot(schedule, now);
  const added = await enqueue(db, [
    {
      workspaceId: await defaultWorkspaceId(db),
      task: BACKUP_TASK,
      key: `${BACKUP_TASK}:${slot.toISOString()}`,
      maxAttempts: 3,
    },
  ]);
  return added > 0;
}

export function registerBackupJobs(
  runner: JobRunner,
  db: Kysely<Database>,
  deps: ScheduledBackupDeps,
): void {
  // A worker with nowhere to put a backup leaves the job to one that has a place: claiming it
  // would only record a failure and spend the job's attempts.
  if (!deps.backupDir) runner.decline(BACKUP_TASK);
  else
    runner.handle(BACKUP_TASK, async (job) => {
      const outcome = await runScheduledBackup(db, deps, job.id);
      if (outcome.state === 'succeeded' && outcome.verify) {
        await enqueue(db, [
          {
            workspaceId: job.workspaceId,
            task: VERIFY_TASK,
            key: `${VERIFY_TASK}:${outcome.runId}`,
            payload: { path: outcome.path },
            maxAttempts: 1,
          },
        ]);
      }
    });
  runner.handle(VERIFY_TASK, async (job) => {
    const { path } = job.payload as { path: string };
    // The drill records its own outcome; a failed one is a finding, not a job to retry.
    await recordedDrill(
      db,
      { databaseUrl: deps.databaseUrl, dir: path, ...(deps.log ? { log: deps.log } : {}) },
      job.id,
      deps.now?.(),
    ).catch((error) => deps.log?.(`restore drill failed: ${message(error)}`));
  });
}

// Status for administrators

export interface BackupStatus {
  schedule: BackupSchedule;
  /** When the next scheduled backup starts; null when they are off or no worker can take one. */
  nextAt: string | null;
  /** Whether a worker can take scheduled backups (`backupWorkers`). */
  workers: BackupWorkers;
  running: RunView | null;
  lastSuccess: RunView | null;
  lastFailure: RunView | null;
  lastDrill: RunView | null;
  /** Scheduled backups on disk now (succeeded and not pruned). */
  kept: number;
}

export async function backupStatus(db: Kysely<Database>, now = new Date()): Promise<BackupStatus> {
  const schedule = await backupSchedule(db);
  const columns = [
    'id',
    'kind',
    'state',
    'started_at',
    'finished_at',
    'path',
    'size_bytes',
    'details',
    'error',
    'pruned_at',
  ] as const;
  const latest = (where: (q: ReturnType<typeof base>) => ReturnType<typeof base>) =>
    where(base()).orderBy('started_at', 'desc').orderBy('id', 'desc').limit(1).executeTakeFirst();
  const base = () => db.selectFrom('backup_run').select(columns);
  const [running, success, failure, drill, scheduled, kept, workers] = await Promise.all([
    latest((q) => q.where('kind', '!=', 'drill').where('state', '=', 'running')),
    latest((q) => q.where('kind', '!=', 'drill').where('state', '=', 'succeeded')),
    latest((q) => q.where('kind', '!=', 'drill').where('state', '=', 'failed')),
    latest((q) => q.where('kind', '=', 'drill').where('state', '!=', 'running')),
    latest((q) => q.where('kind', '=', 'scheduled')),
    db
      .selectFrom('backup_run')
      .select((eb) => eb.fn.countAll<string>().as('n'))
      .where('kind', '=', 'scheduled')
      .where('state', '=', 'succeeded')
      .where('pruned_at', 'is', null)
      .executeTakeFirstOrThrow(),
    backupWorkers(db, now),
  ]);
  const view = (r: RunRow | undefined) => (r ? runView(r) : null);
  // No next backup to promise when every worker that checked lately cannot take one.
  const canRun = workers === 'ready' || workers === 'unknown';
  return {
    schedule,
    nextAt: canRun
      ? (nextBackupAt(schedule, scheduled?.started_at ?? null, now)?.toISOString() ?? null)
      : null,
    workers,
    running: view(running as RunRow | undefined),
    lastSuccess: view(success as RunRow | undefined),
    lastFailure: view(failure as RunRow | undefined),
    lastDrill: view(drill as RunRow | undefined),
    kept: Number(kept.n),
  };
}

/** The most recent runs, newest first. */
export async function recentRuns(db: Kysely<Database>, limit = 20): Promise<RunView[]> {
  const rows = await db
    .selectFrom('backup_run')
    .select([
      'id',
      'kind',
      'state',
      'started_at',
      'finished_at',
      'path',
      'size_bytes',
      'details',
      'error',
      'pruned_at',
    ])
    .orderBy('started_at', 'desc')
    .orderBy('id', 'desc')
    .limit(limit)
    .execute();
  return rows.map((r) => runView(r as RunRow));
}
