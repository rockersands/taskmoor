import type pg from 'pg';

/**
 * A job queue in plain Postgres, the way ADR-015 would build it: a table claimed with
 * FOR UPDATE SKIP LOCKED, batched claims and completions, LISTEN/NOTIFY to wake idle workers,
 * and an idempotency key that stays unique after completion so duplicates are dropped forever.
 */
export const INHOUSE_SQL = `
DROP SCHEMA IF EXISTS q CASCADE;
CREATE SCHEMA q;
CREATE TABLE q.job (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  key text UNIQUE,
  run_at timestamptz NOT NULL DEFAULT now(),
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 25,
  locked_at timestamptz,
  locked_by text,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  started_at timestamptz,
  done_at timestamptz
);
CREATE INDEX job_ready ON q.job (run_at, id) WHERE done_at IS NULL AND locked_at IS NULL;`;

/** A pool or a checked-out client; both run plain queries. */
export interface Queryable {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<pg.QueryResult<R>>;
}

export interface NewJob {
  task: string;
  payload?: unknown;
  /** Idempotency key: a second job with the same key is ignored, even after the first completed. */
  key?: string;
}

export interface ClaimedJob {
  id: number;
  task: string;
  payload: unknown;
  attempts: number;
}

export type JobHandler = (job: ClaimedJob) => Promise<void>;

/** Inserts jobs in one statement and wakes the workers. Returns how many were new. */
export async function enqueue(client: Queryable, jobs: readonly NewJob[]): Promise<number> {
  if (jobs.length === 0) return 0;
  const result = await client.query(
    `INSERT INTO q.job (task, payload, key)
     SELECT * FROM unnest($1::text[], $2::jsonb[], $3::text[])
     ON CONFLICT (key) DO NOTHING`,
    [
      jobs.map((j) => j.task),
      jobs.map((j) => JSON.stringify(j.payload ?? {})),
      jobs.map((j) => j.key ?? null),
    ],
  );
  await client.query("SELECT pg_notify('q_job', '')");
  return result.rowCount ?? 0;
}

export async function claim(
  client: Queryable,
  worker: string,
  limit: number,
): Promise<ClaimedJob[]> {
  const { rows } = await client.query<ClaimedJob>(
    `WITH picked AS (
       SELECT id FROM q.job
        WHERE done_at IS NULL AND locked_at IS NULL AND run_at <= now()
        ORDER BY run_at, id LIMIT $2
        FOR UPDATE SKIP LOCKED)
     UPDATE q.job j
        SET locked_at = clock_timestamp(), locked_by = $1, attempts = attempts + 1,
            started_at = coalesce(started_at, clock_timestamp())
       FROM picked WHERE j.id = picked.id
     RETURNING j.id, j.task, j.payload, j.attempts`,
    [worker, limit],
  );
  return rows;
}

export async function complete(client: Queryable, ids: readonly number[]): Promise<void> {
  if (ids.length === 0) return;
  await client.query(
    `UPDATE q.job SET done_at = clock_timestamp(), locked_at = NULL, locked_by = NULL WHERE id = ANY($1)`,
    [ids],
  );
}

export async function fail(client: Queryable, id: number, error: string): Promise<void> {
  await client.query(
    `UPDATE q.job
        SET locked_at = NULL, locked_by = NULL, last_error = $2,
            run_at = now() + make_interval(secs => least(300, 2 ^ attempts)),
            done_at = CASE WHEN attempts >= max_attempts THEN clock_timestamp() END
      WHERE id = $1`,
    [id, error.slice(0, 2000)],
  );
}

export interface WorkerOptions {
  name: string;
  batch: number;
  handle: JobHandler;
  /** Stop once no job is ready (benchmarks and tests); otherwise wait for NOTIFY. */
  drain?: boolean;
  pollMs?: number;
}

/** Runs one worker loop on its own connection until drained or `stop` resolves. */
export async function runWorker(
  pool: pg.Pool,
  options: WorkerOptions,
  stop?: Promise<unknown>,
): Promise<number> {
  const client = await pool.connect();
  let stopped = false;
  stop?.then(() => {
    stopped = true;
  });
  let processed = 0;
  try {
    if (!options.drain) await client.query('LISTEN q_job');
    while (!stopped) {
      const jobs = await claim(client, options.name, options.batch);
      if (jobs.length === 0) {
        if (options.drain) break;
        await waitForWork(client, options.pollMs ?? 1000);
        continue;
      }
      const done: number[] = [];
      for (const job of jobs) {
        try {
          await options.handle(job);
          done.push(job.id);
        } catch (error) {
          await fail(client, job.id, error instanceof Error ? error.message : String(error));
        }
      }
      await complete(client, done);
      processed += done.length;
    }
  } finally {
    client.release();
  }
  return processed;
}

function waitForWork(client: pg.ClientBase, pollMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, pollMs);
    function finish() {
      clearTimeout(timer);
      client.removeListener('notification', finish);
      resolve();
    }
    client.once('notification', finish);
  });
}

export interface QueueStats {
  total: number;
  done: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

/** Latency from enqueue to the start of processing, read back from the table. */
export async function queueStats(client: Queryable): Promise<QueueStats> {
  const { rows } = await client.query<Record<string, string>>(
    `SELECT count(*) AS total, count(done_at) AS done,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at)) * 1000 AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM started_at - created_at)) * 1000 AS p95,
            max(extract(epoch FROM started_at - created_at)) * 1000 AS max
       FROM q.job`,
  );
  const r = rows[0] ?? {};
  return {
    total: Number(r.total ?? 0),
    done: Number(r.done ?? 0),
    p50Ms: Number(r.p50 ?? 0),
    p95Ms: Number(r.p95 ?? 0),
    maxMs: Number(r.max ?? 0),
  };
}

/** Starts `count` workers that drain the queue together; resolves with the processed total. */
export async function drainWith(
  pool: pg.Pool,
  count: number,
  batch: number,
  handle: JobHandler,
): Promise<number> {
  const totals = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      runWorker(pool, { name: `w${i}`, batch, handle, drain: true }),
    ),
  );
  return totals.reduce((a, b) => a + b, 0);
}
