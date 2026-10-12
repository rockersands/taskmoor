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
  };
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
  checks.push({
    name: 'Counsel sign-off on the clean-room protocol recorded',
    state: decided('Counsel review') ? 'ok' : 'waiting',
    detail: decided('Counsel review')
      ? 'recorded in decisions.csv'
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
