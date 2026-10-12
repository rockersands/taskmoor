import { Logger, makeWorkerUtils, type Runner, run, runMigrations } from 'graphile-worker';
import type pg from 'pg';
import type { NewJob } from './inhouse';

/** Graphile logs every completed job at INFO by default; that would dominate a benchmark. */
const silent = new Logger(() => () => {});

/** Resets and migrates Graphile Worker's own schema. */
export async function graphileReset(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA IF EXISTS graphile_worker CASCADE');
  await runMigrations({ pgPool: pool, logger: silent });
}

/** Adds jobs in bulk; `key` becomes the Graphile job key (deduplicated while the job is queued). */
export async function graphileEnqueue(pool: pg.Pool, jobs: readonly NewJob[]): Promise<void> {
  const utils = await makeWorkerUtils({ pgPool: pool, logger: silent });
  try {
    await utils.addJobs(
      jobs.map((j) => ({
        identifier: j.task,
        payload: j.payload ?? {},
        ...(j.key ? { jobKey: j.key } : {}),
      })),
    );
  } finally {
    await utils.release();
  }
}

export interface GraphileWorkers {
  stop(): Promise<void>;
}

/** Starts a worker pool for one task; the caller decides when the work is done. */
export async function graphileStart(
  pool: pg.Pool,
  task: string,
  concurrency: number,
  handle: (payload: unknown) => Promise<void>,
): Promise<GraphileWorkers> {
  const runner: Runner = await run({
    pgPool: pool,
    logger: silent,
    concurrency,
    noHandleSignals: true,
    pollInterval: 100,
    taskList: { [task]: async (payload) => handle(payload) },
  });
  return { stop: () => runner.stop() };
}
