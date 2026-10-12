import { cpus, totalmem } from 'node:os';
import pg from 'pg';
import { type TimedResult, timeQuery } from '../bench/stats';
import { type Candidate, type CandidateId, candidates } from './candidates';
import { loadContext, QUERIES, type QueryContext } from './queries';

export interface BuildStep {
  step: string;
  seconds: number;
}

export interface TableSize {
  table: string;
  rows: number;
  totalBytes: number;
  tableBytes: number;
  indexBytes: number;
}

export interface CandidateResult {
  id: CandidateId;
  title: string;
  build: BuildStep[];
  sizes: TableSize[];
  queries: TimedResult[];
}

export interface SpikeResult {
  spike: 'field-storage';
  at: string;
  items: number;
  fields: number;
  runs: number;
  machine: { cpu: string; cores: number; memoryGb: number; postgres: string };
  candidates: CandidateResult[];
}

export interface RunOptions {
  candidates?: readonly CandidateId[];
  runs?: number;
  warmup?: number;
  /** Rebuild candidate schemas even when they already hold the dataset. */
  rebuild?: boolean;
  log?: (message: string) => void;
}

/** Runs each build step in its own statement batch and times it. */
export async function buildCandidate(
  pool: pg.Pool,
  candidate: Candidate,
  log: (message: string) => void = () => {},
): Promise<BuildStep[]> {
  const steps: BuildStep[] = [];
  for (const { step, sql } of candidate.build) {
    const t0 = Date.now();
    await pool.query(sql);
    const seconds = (Date.now() - t0) / 1000;
    steps.push({ step, seconds });
    log(`  ${candidate.id}: ${step} in ${seconds.toFixed(1)}s`);
  }
  // COMMENT takes no parameters, so the value is escaped as a literal.
  await pool.query(
    `COMMENT ON SCHEMA ${candidate.schema} IS ${pg.escapeLiteral(`built from gen fingerprint ${await genFingerprint(pool)}`)}`,
  );
  return steps;
}

async function genFingerprint(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ fingerprint: string }>('SELECT fingerprint FROM gen.meta');
  return rows[0]?.fingerprint ?? 'unknown';
}

/** True when the candidate schema was built from the dataset currently in `gen`. */
export async function candidateIsCurrent(pool: pg.Pool, candidate: Candidate): Promise<boolean> {
  const { rows } = await pool.query<{ comment: string | null }>(
    `SELECT obj_description(n.oid, 'pg_namespace') AS comment FROM pg_namespace n WHERE nspname = $1`,
    [candidate.schema],
  );
  return rows[0]?.comment === `built from gen fingerprint ${await genFingerprint(pool)}`;
}

export async function tableSizes(pool: pg.Pool, candidate: Candidate): Promise<TableSize[]> {
  const { rows } = await pool.query<{
    table: string;
    rows: string;
    total: string;
    data: string;
    indexes: string;
  }>(
    `SELECT c.relname AS "table", c.reltuples::bigint AS rows,
            pg_total_relation_size(c.oid) AS total, pg_relation_size(c.oid) AS data,
            pg_indexes_size(c.oid) AS indexes
       FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY c.relname`,
    [candidate.schema],
  );
  return rows.map((r) => ({
    table: r.table,
    rows: Number(r.rows),
    totalBytes: Number(r.total),
    tableBytes: Number(r.data),
    indexBytes: Number(r.indexes),
  }));
}

export async function runQueries(
  pool: pg.Pool,
  candidate: Candidate,
  ctx: QueryContext,
  options: { runs?: number; warmup?: number } = {},
): Promise<TimedResult[]> {
  const client = await pool.connect();
  try {
    const results: TimedResult[] = [];
    for (const q of QUERIES) {
      results.push(
        await timeQuery(
          client,
          { name: q.id, sql: q.sql[candidate.id], params: (run) => q.params(ctx, run) },
          options,
        ),
      );
    }
    return results;
  } finally {
    client.release();
  }
}

export async function runFieldStorageSpike(
  pool: pg.Pool,
  options: RunOptions = {},
): Promise<SpikeResult> {
  const log = options.log ?? (() => {});
  const ids = options.candidates ?? (Object.keys(candidates) as CandidateId[]);
  const ctx = await loadContext(pool);
  const version = await pool.query<{ v: string }>('SHOW server_version');
  const fieldCount = await pool.query<{ n: string }>('SELECT count(*) AS n FROM gen.fields');
  const results: CandidateResult[] = [];

  for (const id of ids) {
    const candidate = candidates[id];
    let build: BuildStep[] = [];
    if (options.rebuild || !(await candidateIsCurrent(pool, candidate))) {
      log(`Building ${candidate.id} (${candidate.title})`);
      build = await buildCandidate(pool, candidate, log);
    } else {
      log(`Reusing ${candidate.id} built from the current dataset`);
    }
    const sizes = await tableSizes(pool, candidate);
    log(`Timing ${QUERIES.length} queries on ${candidate.id}`);
    const queries = await runQueries(pool, candidate, ctx, {
      ...(options.runs !== undefined ? { runs: options.runs } : {}),
      ...(options.warmup !== undefined ? { warmup: options.warmup } : {}),
    });
    for (const q of queries) log(`  ${q.name}: p50 ${q.p50} ms, p95 ${q.p95} ms (${q.rows} rows)`);
    results.push({ id, title: candidate.title, build, sizes, queries });
  }

  return {
    spike: 'field-storage',
    at: new Date().toISOString(),
    items: ctx.itemCount,
    fields: Number(fieldCount.rows[0]?.n),
    runs: options.runs ?? 20,
    machine: {
      cpu: cpus()[0]?.model.trim() ?? 'unknown',
      cores: cpus().length,
      memoryGb: Math.round(totalmem() / 2 ** 30),
      postgres: version.rows[0]?.v ?? 'unknown',
    },
    candidates: results,
  };
}

const mb = (bytes: number) => (bytes / 2 ** 20).toFixed(0);

/** Markdown summary: timings side by side, then build times and storage per candidate. */
export function renderReport(result: SpikeResult): string {
  const out: string[] = [];
  out.push(
    `# Field storage spike: ${result.items.toLocaleString('en')} items, ${result.fields} fields`,
  );
  out.push('');
  out.push(
    `Generated ${result.at.slice(0, 16).replace('T', ' ')} UTC on ${result.machine.cpu} ` +
      `(${result.machine.cores} threads, ${result.machine.memoryGb} GB), PostgreSQL ${result.machine.postgres}, ` +
      `${result.runs} timed runs per query after warm-up. Latency is measured from the client.`,
  );
  out.push('', '## Query latency (p95 ms, p50 in brackets)', '');
  const header = `| Query | ${result.candidates.map((c) => c.id).join(' | ')} |`;
  out.push(header, `|---|${result.candidates.map(() => '---:').join('|')}|`);
  for (const q of QUERIES) {
    const cells = result.candidates.map((c) => {
      const t = c.queries.find((x) => x.name === q.id);
      return t ? `${t.p95} (${t.p50})` : '';
    });
    out.push(`| ${q.title} | ${cells.join(' | ')} |`);
  }
  out.push('', '## Build time and storage', '');
  out.push('| Candidate | Load s | Index s | Item table MB | Field storage MB | Total MB |');
  out.push('|---|---:|---:|---:|---:|---:|');
  for (const c of result.candidates) {
    const load = c.build.filter((b) => b.step === 'load').reduce((a, b) => a + b.seconds, 0);
    const index = c.build.filter((b) => b.step === 'index').reduce((a, b) => a + b.seconds, 0);
    const item = c.sizes.find((s) => s.table === 'item')?.totalBytes ?? 0;
    const total = c.sizes.reduce((a, s) => a + s.totalBytes, 0);
    const built = c.build.length > 0;
    out.push(
      `| ${c.id} | ${built ? load.toFixed(0) : 'reused'} | ${built ? index.toFixed(0) : 'reused'} | ${mb(item)} | ${mb(total - item)} | ${mb(total)} |`,
    );
  }
  out.push('', '## Tables', '');
  out.push('| Candidate | Table | Rows | Data MB | Index MB |', '|---|---|---:|---:|---:|');
  for (const c of result.candidates) {
    for (const s of c.sizes) {
      out.push(
        `| ${c.id} | ${s.table} | ${s.rows.toLocaleString('en')} | ${mb(s.tableBytes)} | ${mb(s.indexBytes)} |`,
      );
    }
  }
  return `${out.join('\n')}\n`;
}
