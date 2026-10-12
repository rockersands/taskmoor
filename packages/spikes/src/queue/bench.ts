import { cpus } from 'node:os';
import type pg from 'pg';
import { summarize, type Timing } from '../bench/stats';
import { graphileEnqueue, graphileReset, graphileStart } from './graphile';
import { drainWith, enqueue, INHOUSE_SQL, runWorker } from './inhouse';

export interface QueueBenchOptions {
  jobs: number;
  workers: number;
  /** Jobs claimed per round trip (in-house queue only). */
  batch: number;
  log?: (message: string) => void;
}

export interface QueueCandidateResult {
  id: 'inhouse' | 'graphile';
  enqueueSeconds: number;
  drainSeconds: number;
  jobsPerSecond: number;
  /** Enqueue to handler start while draining a backlog (mostly queue wait). */
  latency: Timing;
  /** Enqueue to handler start for one job at a time while the workers sit idle. */
  wake: Timing;
}

export interface QueueBenchResult {
  spike: 'queue';
  at: string;
  jobs: number;
  workers: number;
  batch: number;
  durable: boolean;
  machine: { cpu: string; cores: number; postgres: string };
  candidates: QueueCandidateResult[];
}

const CHUNK = 5_000;
const WAKE_SAMPLES = 200;

function chunks<T>(items: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
}

async function benchInhouse(pool: pg.Pool, o: QueueBenchOptions): Promise<QueueCandidateResult> {
  await pool.query(INHOUSE_SQL);
  const jobs = Array.from({ length: o.jobs }, (_, n) => ({ task: 'bench', payload: { n, t: 0 } }));
  const t0 = Date.now();
  for (const chunk of chunks(jobs)) {
    const now = Date.now();
    await enqueue(
      pool,
      chunk.map((j) => ({ ...j, payload: { ...j.payload, t: now } })),
    );
  }
  const enqueueSeconds = (Date.now() - t0) / 1000;

  const latencies: number[] = [];
  const t1 = Date.now();
  const processed = await drainWith(pool, o.workers, o.batch, async (job) => {
    latencies.push(Date.now() - (job.payload as { t: number }).t);
  });
  const drainSeconds = (Date.now() - t1) / 1000;
  if (processed !== o.jobs) throw new Error(`in-house processed ${processed} of ${o.jobs}`);

  // Wake-up latency: idle workers listening for NOTIFY, one job at a time.
  const wake: number[] = [];
  let signal: () => void = () => {};
  let stopWorkers: () => void = () => {};
  const stop = new Promise<void>((resolve) => {
    stopWorkers = resolve;
  });
  const idle = Array.from({ length: o.workers }, (_, i) =>
    runWorker(
      pool,
      {
        name: `idle${i}`,
        batch: o.batch,
        drain: false,
        pollMs: 2000,
        handle: async (job) => {
          wake.push(Date.now() - (job.payload as { t: number }).t);
          signal();
        },
      },
      stop,
    ),
  );
  for (let i = 0; i < WAKE_SAMPLES; i++) {
    const done = new Promise<void>((resolve) => {
      signal = resolve;
    });
    await enqueue(pool, [{ task: 'bench', payload: { n: i, t: Date.now() } }]);
    await done;
  }
  stopWorkers();
  await Promise.all(idle);

  return {
    id: 'inhouse',
    enqueueSeconds,
    drainSeconds,
    jobsPerSecond: Math.round(o.jobs / drainSeconds),
    latency: summarize('inhouse', latencies),
    wake: summarize('inhouse wake', wake),
  };
}

async function benchGraphile(pool: pg.Pool, o: QueueBenchOptions): Promise<QueueCandidateResult> {
  await graphileReset(pool);
  const jobs = Array.from({ length: o.jobs }, (_, n) => ({ task: 'bench', payload: { n, t: 0 } }));
  const t0 = Date.now();
  for (const chunk of chunks(jobs)) {
    const now = Date.now();
    await graphileEnqueue(
      pool,
      chunk.map((j) => ({ ...j, payload: { ...j.payload, t: now } })),
    );
  }
  const enqueueSeconds = (Date.now() - t0) / 1000;

  const latencies: number[] = [];
  const t1 = Date.now();
  const workers = await graphileStart(pool, 'bench', o.workers, async (payload) => {
    latencies.push(Date.now() - (payload as { t: number }).t);
  });
  try {
    const deadline = Date.now() + 10 * 60_000;
    while (latencies.length < o.jobs) {
      if (Date.now() > deadline)
        throw new Error(`graphile processed ${latencies.length} of ${o.jobs}`);
      await new Promise((r) => setTimeout(r, 20));
    }
  } finally {
    await workers.stop();
  }
  const drainSeconds = (Date.now() - t1) / 1000;

  // Wake-up latency: Graphile listens for NOTIFY and polls every 100 ms.
  const wake: number[] = [];
  let signal: () => void = () => {};
  const idle = await graphileStart(pool, 'bench', o.workers, async (payload) => {
    wake.push(Date.now() - (payload as { t: number }).t);
    signal();
  });
  try {
    for (let i = 0; i < WAKE_SAMPLES; i++) {
      const done = new Promise<void>((resolve) => {
        signal = resolve;
      });
      await graphileEnqueue(pool, [{ task: 'bench', payload: { n: i, t: Date.now() } }]);
      await done;
    }
  } finally {
    await idle.stop();
  }

  return {
    id: 'graphile',
    enqueueSeconds,
    drainSeconds,
    jobsPerSecond: Math.round(o.jobs / drainSeconds),
    latency: summarize('graphile', latencies),
    wake: summarize('graphile wake', wake),
  };
}

export async function runQueueSpike(
  pool: pg.Pool,
  options: QueueBenchOptions & { durable: boolean },
): Promise<QueueBenchResult> {
  const log = options.log ?? (() => {});
  const version = await pool.query<{ v: string }>(`SELECT current_setting('server_version') AS v`);
  const candidates: QueueCandidateResult[] = [];
  for (const bench of [benchInhouse, benchGraphile]) {
    const result = await bench(pool, options);
    log(
      `${result.id}: enqueue ${result.enqueueSeconds.toFixed(1)}s, drain ${result.drainSeconds.toFixed(1)}s, ` +
        `${result.jobsPerSecond} jobs/s, backlog latency p95 ${result.latency.p95} ms, wake p50 ${result.wake.p50} ms, p95 ${result.wake.p95} ms`,
    );
    candidates.push(result);
  }
  return {
    spike: 'queue',
    at: new Date().toISOString(),
    jobs: options.jobs,
    workers: options.workers,
    batch: options.batch,
    durable: options.durable,
    machine: {
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      postgres: version.rows[0]?.v ?? 'unknown',
    },
    candidates,
  };
}

export function renderQueueReport(result: QueueBenchResult): string {
  const lines = [
    `# Job queue spike: ${result.jobs.toLocaleString('en')} jobs, ${result.workers} workers`,
    '',
    `Generated ${result.at.slice(0, 16).replace('T', ' ')} UTC on ${result.machine.cpu} (${result.machine.cores} threads), ` +
      `PostgreSQL ${result.machine.postgres}, fsync ${result.durable ? 'on' : 'off'}. In-house workers claim ${result.batch} jobs per round trip. ` +
      'Latency is enqueue to handler start, measured with the process clock.',
    '',
    '| Candidate | Enqueue s | Drain s | Jobs/s | Backlog latency p95 ms | Wake p50 ms | Wake p95 ms | Wake max ms |',
    '|---|---:|---:|---:|---:|---:|---:|---:|',
    ...result.candidates.map(
      (c) =>
        `| ${c.id} | ${c.enqueueSeconds.toFixed(1)} | ${c.drainSeconds.toFixed(1)} | ${c.jobsPerSecond} | ${c.latency.p95} | ${c.wake.p50} | ${c.wake.p95} | ${c.wake.max} |`,
    ),
    '',
    'Backlog latency is the wait in a pre-filled queue, so it grows with the backlog; wake latency is',
    'what a user would feel: one job enqueued while the workers are idle.',
  ];
  return `${lines.join('\n')}\n`;
}
