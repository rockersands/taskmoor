import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { redactSecrets } from '../backup';
import { extendLock } from '../events/queue';

/**
 * The backup log (M1-101, OPS-008): one `backup_run` row per backup or restore drill, from the
 * scheduler or the operator CLI. At most one backup and one drill run at a time (a unique
 * index); a run whose process died is marked failed after five minutes without a heartbeat.
 * Errors are stored with passwords removed.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A running backup or drill whose heartbeat is older than this died with its process. */
export const STALE_RUN_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;

export type RunKind = 'scheduled' | 'manual' | 'drill';

export class BackupBusyError extends Error {
  constructor(kind: RunKind) {
    super(kind === 'drill' ? 'a restore drill is already running' : 'a backup is already running');
  }
}

/** Marks runs whose process stopped answering as failed. */
export async function failStaleRuns(db: Db): Promise<number> {
  const result = await sql`
    UPDATE backup_run
       SET state = 'failed', finished_at = now(),
           error = 'the process running it stopped before it finished'
     WHERE state = 'running'
       AND heartbeat_at < now() - make_interval(secs => ${STALE_RUN_MS / 1000})`.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

/** Starts a run in the log; BackupBusyError when one of its kind is running. */
export async function startRun(
  db: Db,
  kind: RunKind,
  path: string | null,
  startedAt?: Date,
): Promise<string> {
  await failStaleRuns(db);
  try {
    const row = await db
      .insertInto('backup_run')
      .values({ kind, path, ...(startedAt ? { started_at: startedAt } : {}) })
      .returning('id')
      .executeTakeFirstOrThrow();
    return String(row.id);
  } catch (error) {
    if ((error as { code?: string }).code === '23505') throw new BackupBusyError(kind);
    throw error;
  }
}

export async function finishRun(
  db: Db,
  runId: string,
  result: {
    state: 'succeeded' | 'failed';
    sizeBytes?: number;
    details?: Record<string, unknown>;
    error?: string;
  },
): Promise<void> {
  await db
    .updateTable('backup_run')
    .set({
      state: result.state,
      finished_at: new Date(),
      heartbeat_at: new Date(),
      size_bytes: result.sizeBytes ?? null,
      details: JSON.stringify(result.details ?? {}),
      error: result.error === undefined ? null : redactSecrets(result.error).slice(0, 2000),
    })
    .where('id', '=', runId)
    .execute();
}

/** Runs `work` while keeping the run (and the job that runs it) visibly alive. */
export async function withHeartbeat<T>(
  db: Db,
  runId: string,
  jobId: string | undefined,
  work: () => Promise<T>,
): Promise<T> {
  const beat = async () => {
    await db
      .updateTable('backup_run')
      .set({ heartbeat_at: new Date() })
      .where('id', '=', runId)
      .execute();
    if (jobId) await extendLock(db, jobId);
  };
  const timer = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS);
  timer.unref();
  try {
    return await work();
  } finally {
    clearInterval(timer);
  }
}

export const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export interface RunView {
  id: string;
  kind: RunKind;
  state: 'running' | 'succeeded' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  path: string | null;
  sizeBytes: number | null;
  details: unknown;
  error: string | null;
  pruned: boolean;
}

export type RunRow = {
  id: string;
  kind: RunKind;
  state: 'running' | 'succeeded' | 'failed';
  started_at: Date;
  finished_at: Date | null;
  path: string | null;
  size_bytes: string | null;
  details: unknown;
  error: string | null;
  pruned_at: Date | null;
};

export function runView(r: RunRow): RunView {
  return {
    id: String(r.id),
    kind: r.kind,
    state: r.state,
    startedAt: r.started_at.toISOString(),
    finishedAt: r.finished_at?.toISOString() ?? null,
    path: r.path,
    sizeBytes: r.size_bytes === null ? null : Number(r.size_bytes),
    details: r.details,
    error: r.error,
    pruned: r.pruned_at !== null,
  };
}
