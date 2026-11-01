import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ProgressEntry, parseProgress } from './backlog';
import { checkBudgets, loadResults } from './bench';
import { parseCsvRecords } from './csv';

/**
 * The milestone gate (M0-034): every exit criterion of the milestone as a check that is either
 * computed from the repository or waits on the user, printed as one checklist. `pnpm gate M0`
 * is green when every computed check passes and no human item is still open.
 */
export type GateState = 'ok' | 'fail' | 'waiting';

export interface GateCheck {
  name: string;
  state: GateState;
  detail: string;
}

export interface GateInputs {
  milestone: string;
  adrIndex: string;
  progress: ProgressEntry[];
  decisions: Record<string, string>[];
  results: Record<string, unknown>;
  verifySummary?: {
    ok: boolean;
    at: string;
    /** True when the run was narrowed with --only, --changed or a filter; such a run is not the gate. */
    partial?: boolean;
    results: { id: string; headline: string }[];
  };
  /** The latest CI conclusion on main, when known. */
  ci?: { conclusion: string; title: string };
  workflows: string[];
  ciBaselineFiles: number;
  /** M1-118's records in docs/security, when present. */
  security?: SecurityRecords;
}

/** One scanner's last run, as `docs/security/scan-results.json` records it (M1-118). */
export interface ScanRecord {
  scan: string;
  tool: string;
  ran: boolean;
  at?: string;
  /** Findings left open after triage, by severity. */
  open: { critical: number; high: number; medium: number; low: number };
  /** Why it did not run here, when it did not. */
  note?: string;
}

/** One fuzz target's longest clean run, as `docs/security/fuzz-results.json` records it. */
export interface FuzzRecord {
  target: string;
  seconds: number;
  inputs: number;
  failures: number;
}

export interface SecurityRecords {
  scans: ScanRecord[];
  fuzz: FuzzRecord[];
  asvs: string;
}

export function loadGateInputs(root: string, milestone: string, ci?: GateInputs['ci']): GateInputs {
  const read = (...parts: string[]) => readFileSync(join(root, ...parts), 'utf8');
  const summaryPath = join(root, '.verify', 'summary.json');
  const workflowsDir = join(root, '.github', 'workflows');
  const baselineDir = join(root, 'docs', 'spikes', 'baseline', 'ci');
  return {
    milestone,
    adrIndex: read('docs', 'adr', 'README.md'),
    progress: parseProgress(read('docs', 'plan', 'progress.csv')),
    decisions: parseCsvRecords(read('docs', 'plan', 'decisions.csv')),
    results: loadResults(join(root, 'docs', 'spikes', 'data')),
    ...(existsSync(summaryPath)
      ? {
          verifySummary: JSON.parse(readFileSync(summaryPath, 'utf8')) as NonNullable<
            GateInputs['verifySummary']
          >,
        }
      : {}),
    ...(ci ? { ci } : {}),
    workflows: existsSync(workflowsDir) ? readdirSync(workflowsDir) : [],
    ciBaselineFiles: existsSync(baselineDir)
      ? readdirSync(baselineDir).filter((f) => f.endsWith('.json')).length
      : 0,
    ...(existsSync(join(root, 'docs', 'security', 'scan-results.json'))
      ? {
          security: {
            scans: JSON.parse(read('docs', 'security', 'scan-results.json')) as ScanRecord[],
            fuzz: JSON.parse(read('docs', 'security', 'fuzz-results.json')) as FuzzRecord[],
            asvs: read('docs', 'security', 'asvs-l2.md'),
          },
        }
      : {}),
  };
}

/** A day: the fuzzers' bar for M1 (M1-118, "fuzzers 24 h clean"). */
export const FUZZ_GATE_SECONDS = 24 * 3600;

/**
 * The security part of the M1 gate (M1-118; ADR-104): the scans with nothing high or critical
 * left open (a scan that could not run waits), every fuzz target clean for 24 hours, and the
 * ASVS level 2 checklist without an open gap. M1-120 adds the rest of the M1 gate.
 */
export function m1SecurityChecks(input: GateInputs): GateCheck[] {
  const records = input.security;
  if (!records) {
    return [{ name: 'Security records (docs/security)', state: 'fail', detail: 'missing' }];
  }
  const checks: GateCheck[] = [];
  for (const scan of records.scans) {
    const blocking = scan.open.critical + scan.open.high;
    checks.push({
      name: `${scan.scan} scan (${scan.tool}): 0 high or critical`,
      state: !scan.ran ? 'waiting' : blocking === 0 ? 'ok' : 'fail',
      detail: !scan.ran
        ? (scan.note ?? 'not run yet')
        : `${scan.at}: ${scan.open.critical} critical, ${scan.open.high} high, ${scan.open.medium} medium, ${scan.open.low} low open`,
    });
  }
  const short = records.fuzz.filter((f) => f.failures > 0 || f.seconds < FUZZ_GATE_SECONDS);
  const failing = records.fuzz.filter((f) => f.failures > 0);
  checks.push({
    name: 'Fuzzers 24 h clean (pnpm fuzz <target> --minutes 1440)',
    state: failing.length > 0 ? 'fail' : short.length === 0 ? 'ok' : 'waiting',
    detail:
      failing.length > 0
        ? `failing: ${failing.map((f) => f.target).join(', ')}`
        : short.length === 0
          ? `${records.fuzz.length} targets`
          : `${short.length} of ${records.fuzz.length} targets ran less than 24 h (longest clean run: ${Math.max(...records.fuzz.map((f) => f.seconds))} s)`,
  });
  const gaps = [...records.asvs.matchAll(/^\| (\d+\.\d+\.\d+) \|[^\n]*\| Gap \|/gm)].map(
    (m) => m[1],
  );
  checks.push({
    name: 'ASVS 4.0.3 level 2 checklist without an open gap (docs/security/asvs-l2.md)',
    state: gaps.length === 0 ? 'ok' : 'waiting',
    detail:
      gaps.length === 0 ? 'every requirement met or not applicable' : `gaps: ${gaps.join(', ')}`,
  });
  const live = input.progress.some((p) => p.id === 'M1-079' && p.state === 'done');
  checks.push({
    name: 'Prompt-injection corpus green against a live model (M1-079)',
    state: live ? 'ok' : 'waiting',
    detail: live ? 'M1-079 done' : 'M1-079 runs packages/ai/src/injection against a live model',
  });
  return checks;
}

/** ADR numbers whose row in the index must say Accepted. */
const ADRS_FOR_M0 = Array.from({ length: 33 }, (_, i) => String(i + 1).padStart(3, '0'));

export function m0Gate(input: GateInputs): GateCheck[] {
  const checks: GateCheck[] = [];
  const done = (id: string) => input.progress.some((p) => p.id === id && p.state === 'done');

  const accepted = new Set(
    [...input.adrIndex.matchAll(/^\| \[(\d{3})\]\([^)]+\) \| [^|]+ \| Accepted \|/gm)].map(
      (m) => m[1],
    ),
  );
  const missing = ADRS_FOR_M0.filter((n) => !accepted.has(n));
  checks.push({
    name: 'ADR-001 to ADR-033 accepted',
    state: missing.length === 0 ? 'ok' : 'fail',
    detail: missing.length === 0 ? '33 accepted' : `not accepted: ${missing.join(', ')}`,
  });

  const problems = checkBudgets(input.results);
  const items = (input.results['query-compiler'] as { items?: number } | undefined)?.items ?? 0;
  const sizeOk = items >= 10_000_000;
  checks.push({
    name: 'Spike budgets met at 10M items',
    state: problems.length === 0 && sizeOk ? 'ok' : 'fail',
    detail:
      problems.length > 0
        ? problems.map((p) => p.message).join('; ')
        : sizeOk
          ? `every budget met on the ${items.toLocaleString('en')}-item run`
          : `budgets met, but the largest query run is ${items.toLocaleString('en')} items`,
  });

  const summary = input.verifySummary;
  checks.push({
    name: 'pnpm verify green locally (embedded Postgres), AI gateway contract tests included',
    state: summary?.ok && !summary.partial ? 'ok' : 'fail',
    detail: summary
      ? summary.partial
        ? `the last run at ${summary.at} was narrowed (--only, --changed or a filter); run a full pnpm verify`
        : `${summary.ok ? 'passed' : 'failed'} at ${summary.at}: ${summary.results.map((r) => `${r.id} ${r.headline}`).join(', ')}`
      : 'no .verify/summary.json; run pnpm verify',
  });

  checks.push({
    name: 'CI green on main (PostgreSQL 16, scans)',
    state: input.ci ? (input.ci.conclusion === 'success' ? 'ok' : 'fail') : 'waiting',
    detail: input.ci
      ? `${input.ci.conclusion}: ${input.ci.title}`
      : 'pass --ci or run with the GitHub CLI signed in',
  });

  const nightly = input.workflows.includes('nightly.yml');
  checks.push({
    name: 'Nightly benchmark job live with a CI baseline',
    state: nightly && input.ciBaselineFiles > 0 ? 'ok' : nightly ? 'waiting' : 'fail',
    detail: nightly
      ? input.ciBaselineFiles > 0
        ? `${input.ciBaselineFiles} baseline file(s)`
        : 'workflow present; baseline waits for the first green run'
      : 'nightly.yml is not on this branch (see HANDOFF: ci-workflows)',
  });

  const matrix = input.progress.find((p) => p.id === 'M0-028');
  checks.push({
    name: 'Backend skeleton installs in under 10 minutes on 5 OS images (M0-028)',
    state: done('M0-028') ? 'ok' : 'waiting',
    detail: matrix
      ? `M0-028 ${matrix.state}: ${matrix.note.split('. ')[0]}`
      : 'M0-028 not started (install-matrix.yml, see tools/install-matrix)',
  });

  const decided = (prefix: string) =>
    input.decisions.some(
      (d) => d.Decision?.startsWith(prefix) && /decided/i.test(d["Claude's recommendation"] ?? ''),
    );
  // The user may move the review to the release gate; M0 then only needs that choice on record.
  const deferred = (prefix: string) =>
    input.decisions.some(
      (d) =>
        d.Decision?.startsWith(prefix) &&
        /deferred by the user/i.test(d["Claude's recommendation"] ?? ''),
    );
  checks.push({
    name: 'Counsel sign-off on the clean-room protocol recorded',
    state: decided('Counsel review') || deferred('Counsel review') ? 'ok' : 'waiting',
    detail: decided('Counsel review')
      ? 'recorded in decisions.csv'
      : deferred('Counsel review')
        ? 'deferred by the user to the first public release (decisions.csv)'
        : 'decisions.csv: "Counsel review" row',
  });
  checks.push({
    name: 'User acceptance of M0 recorded',
    state: decided(`${input.milestone} acceptance`) ? 'ok' : 'waiting',
    detail: decided(`${input.milestone} acceptance`)
      ? 'recorded in decisions.csv'
      : `add a "${input.milestone} acceptance" row to decisions.csv marked Decided`,
  });
  return checks;
}

export function runGate(input: GateInputs): GateCheck[] {
  if (input.milestone === 'M1') return m1SecurityChecks(input);
  if (input.milestone !== 'M0') throw new Error(`No gate defined for ${input.milestone} yet.`);
  return m0Gate(input);
}

export function formatGate(milestone: string, checks: readonly GateCheck[]): string {
  const mark = { ok: 'ok     ', fail: 'FAIL   ', waiting: 'waiting' } as const;
  const lines = checks.map((c) => `${mark[c.state]} ${c.name}\n        ${c.detail}`);
  const fails = checks.filter((c) => c.state === 'fail').length;
  const waiting = checks.filter((c) => c.state === 'waiting').length;
  lines.push(
    '',
    fails === 0 && waiting === 0
      ? `${milestone} gate: all green.`
      : `${milestone} gate: ${fails} failing, ${waiting} waiting on the user.`,
  );
  return `${lines.join('\n')}\n`;
}
