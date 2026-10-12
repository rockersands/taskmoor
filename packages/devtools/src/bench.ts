import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Performance budgets (M0-033) over the spike result files in docs/spikes/data. Each spike
 * writes `<name>.json` or `<name>-<size>.json`; this module turns them into named measurements,
 * checks them against the budgets from the build plan, and compares them with a baseline
 * directory to catch regressions.
 */
export interface Measurement {
  spike: string;
  name: string;
  value: number;
  unit: string;
}

export interface Problem {
  kind: 'budget' | 'regression';
  spike: string;
  name: string;
  message: string;
}

interface Budget {
  spike: string;
  unit: string;
  /** Upper bound (max) or lower bound (min) for every value `select` returns. */
  max?: number;
  min?: number;
  select: (result: never) => { name: string; value: number }[];
}

type Timed = { p95: number };
type Candidates<T> = { candidates: (T & { id: string })[] };

/** The budgets from the M0 gate and the specs, one line each. */
export const BUDGETS: readonly Budget[] = [
  {
    // QRY: every representative query p95 under 300 ms at 10M items.
    spike: 'query-compiler',
    unit: 'ms',
    max: 300,
    select: (r: { queries: (Timed & { id: string })[] }) =>
      r.queries.map((q) => ({ name: `${q.id} p95`, value: q.p95 })),
  },
  {
    // CORE: field edit p95 under 50 ms and item open under 100 ms, on the chosen candidate.
    spike: 'field-storage',
    unit: 'ms',
    max: 50,
    select: (r: Candidates<{ queries: (Timed & { name: string })[] }>) =>
      r.candidates
        .filter((c) => c.id === 'side')
        .flatMap((c) =>
          c.queries
            .filter((q) => q.name === 'edit-number')
            .map((q) => ({ name: `${c.id} ${q.name} p95`, value: q.p95 })),
        ),
  },
  {
    spike: 'field-storage',
    unit: 'ms',
    max: 100,
    select: (r: Candidates<{ queries: (Timed & { name: string })[] }>) =>
      r.candidates
        .filter((c) => c.id === 'side')
        .flatMap((c) =>
          c.queries
            .filter((q) => q.name === 'open')
            .map((q) => ({ name: `${c.id} ${q.name} p95`, value: q.p95 })),
        ),
  },
  {
    // IAM-012: permission check p95 under 10 ms.
    spike: 'authz',
    unit: 'ms',
    max: 10,
    select: (r: Candidates<{ check: Timed }>) =>
      r.candidates
        .filter((c) => c.id.startsWith('inprocess'))
        .map((c) => ({ name: `${c.id} check p95`, value: c.check.p95 })),
  },
  {
    // QRY-008: the pre-filter adds at most 10 ms to a query's p95. An absolute budget, decided
    // by the user on 2026-10-12: a relative one on sub-millisecond queries measured noise and the
    // extra rows a filtered walk reads, not the design (decisions.csv).
    spike: 'authz-overhead',
    unit: 'ms',
    max: 10,
    select: (r: {
      rows: { query: string; allowedShare: number; unfilteredP95: number; filteredP95: number }[];
    }) =>
      r.rows.map((row) => ({
        name: `${row.query} @${row.allowedShare} overhead`,
        value: Math.max(0, Math.round((row.filteredP95 - row.unfilteredP95) * 100) / 100),
      })),
  },
  {
    // NTF-008: a change reaches other screens within 1 s.
    spike: 'sync',
    unit: 'ms',
    max: 1000,
    select: (r: { deltaUnderLoad: Timed; deltaIdle: Timed }) => [
      { name: 'delta under load p95', value: r.deltaUnderLoad.p95 },
      { name: 'delta idle p95', value: r.deltaIdle.p95 },
    ],
  },
  {
    // M0-019: a 50k-item bootstrap stays interactive.
    spike: 'sync',
    unit: 's',
    max: 30,
    select: (r: { bootstrap: { rows: number; seconds: number } }) => [
      { name: 'bootstrap of 50k items', value: (r.bootstrap.seconds * 50_000) / r.bootstrap.rows },
    ],
  },
  {
    // ADR-015: 1,000 jobs per second.
    spike: 'queue',
    unit: 'jobs/s',
    min: 1000,
    select: (r: Candidates<{ jobsPerSecond: number }>) =>
      r.candidates
        .filter((c) => c.id === 'inhouse')
        .map((c) => ({ name: `${c.id} drain`, value: c.jobsPerSecond })),
  },
  {
    // M0-022: 5 GB in under 20 minutes, scaled to the file that was parsed.
    spike: 'xml',
    unit: 'min',
    max: 20,
    select: (r: { file: { bytes: number }; parse: { seconds: number } }) => [
      { name: 'minutes per 5 GB', value: (r.parse.seconds / 60) * (5e9 / r.file.bytes) },
    ],
  },
  {
    spike: 'xml',
    unit: 'MB',
    max: 512,
    select: (r: { parse: { maxRssMb: number } }) => [{ name: 'max RSS', value: r.parse.maxRssMb }],
  },
];

/** Splits "query-compiler-200k" into its spike and size; "authz" has no size. */
export function parseStem(stem: string): { spike: string; size?: string } {
  const m = /^(.*?)-(\d+(?:\.\d+)?[kmg])$/.exec(stem);
  const size = m?.[2];
  return m && size ? { spike: m[1] ?? stem, size } : { spike: stem };
}

/**
 * The size each spike's result file would be chosen at: one size for every spike, a size per
 * spike (so a baseline is read at the sizes the current results have), or, with nothing given,
 * the largest present.
 */
export type SizeChoice = string | Record<string, string | undefined> | undefined;

function chooseFiles(dir: string, size: SizeChoice): Map<string, { size?: string; stem: string }> {
  const chosen = new Map<string, { size?: string; stem: string }>();
  if (!existsSync(dir)) return chosen;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    const stem = file.slice(0, -'.json'.length);
    const { spike, size: fileSize } = parseStem(stem);
    if (!fileSize) {
      chosen.set(spike, { stem });
      continue;
    }
    const wanted = typeof size === 'string' ? size : size?.[spike];
    if (wanted && fileSize !== wanted) continue;
    const current = chosen.get(spike);
    if (!current?.size || sizeBytes(fileSize) > sizeBytes(current.size)) {
      chosen.set(spike, { size: fileSize, stem });
    }
  }
  return chosen;
}

/**
 * Reads the result files of a directory. Sized spikes keep only the chosen size (see
 * SizeChoice), so one directory can hold several dataset sizes.
 */
export function loadResults(dir: string, size?: SizeChoice): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [spike, { stem }] of chooseFiles(dir, size)) {
    out[spike] = JSON.parse(readFileSync(join(dir, `${stem}.json`), 'utf8'));
  }
  return out;
}

/** The sizes `loadResults` picks per sized spike, to read a baseline at the same sizes. */
export function resultSizes(dir: string, size?: SizeChoice): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [spike, { size: chosen }] of chooseFiles(dir, size)) {
    if (chosen) out[spike] = chosen;
  }
  return out;
}

function sizeBytes(label: string): number {
  const n = Number.parseFloat(label);
  const unit = label.at(-1);
  return n * (unit === 'g' ? 1e9 : unit === 'm' ? 1e6 : 1e3);
}

export function measurements(results: Record<string, unknown>): Measurement[] {
  const out: Measurement[] = [];
  for (const budget of BUDGETS) {
    const result = results[budget.spike];
    if (!result) continue;
    for (const { name, value } of budget.select(result as never)) {
      out.push({ spike: budget.spike, name, value: round(value), unit: budget.unit });
    }
  }
  return out;
}

export function checkBudgets(results: Record<string, unknown>): Problem[] {
  const problems: Problem[] = [];
  for (const budget of BUDGETS) {
    const result = results[budget.spike];
    if (!result) continue;
    for (const { name, value } of budget.select(result as never)) {
      if (budget.max !== undefined && value > budget.max) {
        problems.push({
          kind: 'budget',
          spike: budget.spike,
          name,
          message: `${budget.spike}: ${name} is ${round(value)} ${budget.unit}, budget ${budget.max}`,
        });
      }
      if (budget.min !== undefined && value < budget.min) {
        problems.push({
          kind: 'budget',
          spike: budget.spike,
          name,
          message: `${budget.spike}: ${name} is ${round(value)} ${budget.unit}, budget at least ${budget.min}`,
        });
      }
    }
  }
  return problems;
}

/** Absolute change below which a relative regression is noise, per unit. */
const NOISE_FLOOR: Record<string, number> = {
  ms: 2,
  s: 1,
  min: 1,
  MB: 16,
  ratio: 0.05,
  'jobs/s': 100,
};

/**
 * A measurement regressed when it is worse than the baseline by more than `tolerance` (20%)
 * and by more than the unit's noise floor. "Worse" is higher for max budgets and lower for min
 * budgets. Measurements without a baseline are skipped: the first run sets it.
 */
export function checkRegressions(
  current: Record<string, unknown>,
  baseline: Record<string, unknown>,
  tolerance = 0.2,
): Problem[] {
  const before = new Map(measurements(baseline).map((m) => [`${m.spike}|${m.name}`, m]));
  const lower = new Set(BUDGETS.filter((b) => b.min !== undefined).map((b) => b.spike));
  const problems: Problem[] = [];
  for (const m of measurements(current)) {
    const base = before.get(`${m.spike}|${m.name}`);
    if (!base) continue;
    const floor = NOISE_FLOOR[m.unit] ?? 0;
    const worse = lower.has(m.spike)
      ? base.value - m.value > floor && m.value < base.value * (1 - tolerance)
      : m.value - base.value > floor && m.value > base.value * (1 + tolerance);
    if (worse) {
      const change = Math.round(((m.value - base.value) / Math.max(base.value, 1e-9)) * 100);
      problems.push({
        kind: 'regression',
        spike: m.spike,
        name: m.name,
        message: `${m.spike}: ${m.name} went from ${base.value} to ${m.value} ${m.unit} (${change > 0 ? '+' : ''}${change}%)`,
      });
    }
  }
  return problems;
}

export function formatBenchReport(
  results: Record<string, unknown>,
  problems: readonly Problem[],
  baselineNote: string,
): string {
  const lines = ['| Spike | Measure | Value |', '|---|---|---:|'];
  for (const m of measurements(results))
    lines.push(`| ${m.spike} | ${m.name} | ${m.value} ${m.unit} |`);
  lines.push('', baselineNote);
  if (problems.length === 0) lines.push('', 'Budgets met; no regressions.');
  else {
    lines.push('', `${problems.length} problem(s):`);
    for (const p of problems) lines.push(`- ${p.message}`);
  }
  return `${lines.join('\n')}\n`;
}

function round(v: number): number {
  return Math.round(v * 100) / 100;
}
