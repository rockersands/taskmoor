import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';

/**
 * The job queue of ADR-015 in the product schema: batched claims with FOR UPDATE SKIP LOCKED,
 * exponential backoff up to a job's maximum, the last error kept on the row, and keys that stay
 * unique after completion so a duplicate submission is dropped forever.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface NewJob {
  workspaceId: number;
  task: string;
  payload?: unknown;
  /** Idempotency key: a second job with the same key is ignored, even after the first is done. */
  key?: string;
  maxAttempts?: number;
  runAt?: Date;
}

export interface ClaimedJob {
  id: string;
  workspaceId: number;
  task: string;
  payload: unknown;
  attempts: number;
  maxAttempts: number;
}

/** Inserts jobs in one statement. Returns how many were new. */
export async function enqueue(db: Db, jobs: readonly NewJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const result = await sql`
    INSERT INTO job (workspace_id, task, payload, key, max_attempts, run_at)
    SELECT * FROM unnest(
      ${jobs.map((j) => j.workspaceId)}::int[],
      ${jobs.map((j) => j.task)}::text[],
      ${jobs.map((j) => JSON.stringify(j.payload ?? {}))}::jsonb[],
      ${jobs.map((j) => j.key ?? null)}::text[],
      ${jobs.map((j) => j.maxAttempts ?? 25)}::int[],
      ${jobs.map((j) => (j.runAt ?? new Date()).toISOString())}::timestamptz[])
    ON CONFLICT (key) DO NOTHING`.execute(db);
  return Number(result.numAffectedRows ?? 0);
}

export async function claim(db: Db, worker: string, limit: number): Promise<ClaimedJob[]> {
  const { rows } = await sql<{
    id: string;
    workspace_id: number;
    task: string;
    payload: unknown;
    attempts: number;
    max_attempts: number;
  }>`
    WITH picked AS (
      SELECT id FROM job
       WHERE done_at IS NULL AND locked_at IS NULL AND run_at <= now()
       ORDER BY run_at, id LIMIT ${limit}
       FOR UPDATE SKIP LOCKED)
    UPDATE job j
       SET locked_at = clock_timestamp(), locked_by = ${worker}, attempts = attempts + 1,
           started_at = coalesce(started_at, clock_timestamp())
      FROM picked WHERE j.id = picked.id
    RETURNING j.id, j.workspace_id, j.task, j.payload, j.attempts, j.max_attempts`.execute(db);
  return rows.map((r) => ({
    id: String(r.id),
    workspaceId: r.workspace_id,
    task: r.task,
    payload: r.payload,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
  }));
}

export async function complete(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    UPDATE job SET done_at = clock_timestamp(), locked_at = NULL, locked_by = NULL, last_error = NULL
     WHERE id = ANY(${ids.map(Number)}::bigint[])`.execute(db);
}

/** Puts a failed job back with backoff (2^attempts seconds, at most 5 minutes) or gives up. */
export async function fail(db: Db, id: string, error: string): Promise<void> {
  await sql`
    UPDATE job
       SET locked_at = NULL, locked_by = NULL, last_error = ${error.slice(0, 2000)},
           run_at = now() + make_interval(secs => least(300, 2 ^ attempts)),
           done_at = CASE WHEN attempts >= max_attempts THEN clock_timestamp() END
     WHERE id = ${Number(id)}`.execute(db);
}

/** Jobs locked longer than `olderThanMs` belong to a worker that died; they run again. */
export async function releaseStale(db: Db, olderThanMs: number): Promise<number> {
  const result = await sql`
    UPDATE job SET locked_at = NULL, locked_by = NULL
     WHERE done_at IS NULL AND locked_at < now() - make_interval(secs => ${olderThanMs / 1000})`.execute(
    db,
  );
  return Number(result.numAffectedRows ?? 0);
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Runs claimed jobs through their task's handler; unknown tasks fail and retry later. */
export class JobRunner {
  private readonly handlers = new Map<string, JobHandler>();

  constructor(
    private readonly db: Kysely<Database>,
    readonly name: string,
  ) {}

  handle(task: string, handler: JobHandler): void {
    this.handlers.set(task, handler);
  }

  /** Claims and runs one batch. Returns how many jobs completed. */
  async runOnce(batch = 25): Promise<number> {
    const jobs = await claim(this.db, this.name, batch);
    const done: string[] = [];
    for (const job of jobs) {
      const handler = this.handlers.get(job.task);
      try {
        if (!handler) throw new Error(`no handler for task ${job.task}`);
        await handler(job);
        done.push(job.id);
      } catch (error) {
        await fail(this.db, job.id, error instanceof Error ? error.message : String(error));
      }
    }
    await complete(this.db, done);
    return done.length;
  }
}

/**
 * Keeps a long job's lock fresh, so `releaseStale` never hands it to a second worker while it
 * still runs (a backup of a large database takes minutes).
 */
export async function extendLock(db: Db, jobId: string): Promise<void> {
  await sql`
    UPDATE job SET locked_at = clock_timestamp()
     WHERE id = ${Number(jobId)} AND done_at IS NULL AND locked_at IS NOT NULL`.execute(db);
}
