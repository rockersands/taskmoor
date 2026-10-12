import type pg from 'pg';

export interface Timing {
  name: string;
  runs: number;
  /** Milliseconds. */
  p50: number;
  p95: number;
  max: number;
  mean: number;
}

/** Nearest-rank percentile of an ascending list; p in [0, 100]. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] as number;
}

export function summarize(name: string, samples: readonly number[]): Timing {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = sorted.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
  return {
    name,
    runs: sorted.length,
    p50: round(percentile(sorted, 50)),
    p95: round(percentile(sorted, 95)),
    max: round(sorted[sorted.length - 1] ?? Number.NaN),
    mean: round(mean),
  };
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

export interface TimedQuery {
  name: string;
  sql: string;
  /** Called before each run; different parameters per run defeat plan and result caching. */
  params: (run: number) => unknown[];
}

export interface TimeOptions {
  warmup?: number;
  runs?: number;
}

export interface TimedResult extends Timing {
  /** Row count of the last run, for sanity checks. */
  rows: number;
}

/** Runs a query repeatedly on one connection and reports wall-clock latency from the client. */
export async function timeQuery(
  client: pg.ClientBase,
  query: TimedQuery,
  options: TimeOptions = {},
): Promise<TimedResult> {
  const warmup = options.warmup ?? 3;
  const runs = options.runs ?? 20;
  let rows = 0;
  for (let i = 0; i < warmup; i++) await client.query(query.sql, query.params(-1 - i));
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const params = query.params(i);
    const t0 = process.hrtime.bigint();
    const result = await client.query(query.sql, params);
    samples.push(Number(process.hrtime.bigint() - t0) / 1e6);
    rows = result.rowCount ?? result.rows.length;
  }
  return { ...summarize(query.name, samples), rows };
}

/** Markdown table of timings, one row per query, for spike reports. */
export function timingsTable(results: readonly Timing[]): string {
  const lines = ['| Query | Runs | p50 ms | p95 ms | Max ms |', '|---|---:|---:|---:|---:|'];
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.runs} | ${r.p50} | ${r.p95} | ${r.max} |`);
  }
  return lines.join('\n');
}
