import { type CaseContext, COMPAT_CASES, type CompatCase } from './cases';
import {
  COMPAT_OPERATIONS,
  type CompatOperation,
  compatOperation,
  compatPath,
  FAMILIES,
  type Family,
  responseSchema,
  type Version,
} from './operations';
import { jiraError } from './schemas';

/**
 * Runs the Jira-compatible API's conformance cases against a server (M1-068; API-014;
 * ADR-085) and says, per operation, how far the server is:
 *
 * - `complete`: every case of the operation passed;
 * - `partial`: some passed;
 * - `failing`: none passed, but the server answers the path;
 * - `missing`: none passed and every answer was 404, 405 or 501 without a Jira-compatible error
 *   body: the server does not have it;
 * - `untested`: every case was skipped, because what it needs (an issue, a board) was not made.
 *
 * The target is any server: the tests run it in-process against Taskmoor's own; it must never
 * be pointed at an Atlassian product (ADR-003).
 */
export interface CompatRequest {
  method: string;
  path: string;
  query?: Record<string, string>;
  body?: unknown;
}

export interface CompatAnswer {
  status: number;
  body: unknown;
}

export interface CompatTarget {
  call(request: CompatRequest): Promise<CompatAnswer>;
  /** A project the caller may create issues in, an issue type it takes, and a Scrum board. */
  project: string;
  issueType: string;
  boardId?: number | null;
}

export type CaseOutcome = 'pass' | 'fail' | 'skipped';
export type OperationState = 'complete' | 'partial' | 'failing' | 'missing' | 'untested';

export interface CaseResult {
  case: string;
  operation: string;
  version: Version;
  outcome: CaseOutcome;
  status?: number;
  problem?: string;
}

export interface OperationResult {
  id: string;
  family: Family;
  method: string;
  path: string;
  state: OperationState;
  passed: number;
  total: number;
}

export interface CompatReport {
  cases: CaseResult[];
  operations: OperationResult[];
  /** Operations per state, overall. */
  totals: Record<OperationState, number>;
}

const NOT_THERE = new Set([404, 405, 501]);

/** Every case of the suite, at every version it runs at, in order. */
export function plannedRuns(cases: readonly CompatCase[] = COMPAT_CASES) {
  const runs: { version: Version; case: CompatCase; operation: CompatOperation }[] = [];
  for (const version of ['2', '3'] as const) {
    for (const c of cases) {
      const operation = compatOperation(c.operation);
      const versions = c.versions ?? operation.versions;
      if (versions.includes(version)) runs.push({ version, case: c, operation });
    }
  }
  return runs;
}

async function runCase(
  target: CompatTarget,
  c: CompatCase,
  operation: CompatOperation,
  ctx: CaseContext,
): Promise<CaseResult> {
  const base = { case: c.id, operation: c.operation, version: ctx.version };
  const missing = (c.needs ?? []).filter((n) => !ctx.vars.has(n));
  if (missing.length > 0) {
    return { ...base, outcome: 'skipped', problem: `needs ${missing.join(', ')}` };
  }
  let request: ReturnType<CompatCase['request']>;
  let path: string;
  try {
    request = c.request(ctx);
    path = compatPath(operation, ctx.version, request.params);
  } catch (error) {
    return { ...base, outcome: 'skipped', problem: (error as Error).message };
  }
  let answer: CompatAnswer;
  try {
    answer = await target.call({
      method: operation.method,
      path,
      ...(request.query ? { query: request.query } : {}),
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
  } catch (error) {
    return { ...base, outcome: 'fail', problem: `request failed: ${(error as Error).message}` };
  }
  const fail = (problem: string): CaseResult => ({
    ...base,
    outcome: 'fail',
    status: answer.status,
    problem,
  });
  if (answer.status !== c.status) {
    const excerpt = JSON.stringify(answer.body ?? null).slice(0, 160);
    return fail(`status ${answer.status}, expected ${c.status}: ${excerpt}`);
  }
  const schema = c.error
    ? jiraError
    : c.narrowed
      ? undefined
      : responseSchema(operation, c.status, ctx.version);
  if (schema) {
    const parsed = schema.safeParse(answer.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return fail(`body: ${issue?.path.join('.') || '(root)'} ${issue?.message ?? 'invalid'}`);
    }
  }
  const problem = c.check?.(answer.body, ctx) ?? null;
  if (problem) return fail(problem);
  try {
    c.capture?.(answer.body, ctx);
  } catch (error) {
    return fail(`capture: ${(error as Error).message}`);
  }
  return { ...base, outcome: 'pass', status: answer.status };
}

function stateOf(results: CaseResult[], bodies: Map<CaseResult, unknown>): OperationState {
  const passed = results.filter((r) => r.outcome === 'pass').length;
  if (results.length > 0 && passed === results.length) return 'complete';
  if (passed > 0) return 'partial';
  const answered = results.filter((r) => r.outcome !== 'skipped');
  if (answered.length === 0) return 'untested';
  const absent = answered.every(
    (r) =>
      r.status !== undefined &&
      NOT_THERE.has(r.status) &&
      !jiraError.safeParse(bodies.get(r)).success,
  );
  return absent ? 'missing' : 'failing';
}

export async function runCompatContract(
  target: CompatTarget,
  cases: readonly CompatCase[] = COMPAT_CASES,
): Promise<CompatReport> {
  const results: CaseResult[] = [];
  const bodies = new Map<CaseResult, unknown>();
  const contexts = new Map<Version, CaseContext>();
  // The Agile cases run once, with the issues of the version 2 run.
  for (const run of plannedRuns(cases)) {
    let ctx = contexts.get(run.version);
    if (!ctx) {
      ctx = {
        version: run.version,
        project: target.project,
        issueType: target.issueType,
        boardId: target.boardId ?? null,
        vars: new Map(target.boardId ? [['board', target.boardId]] : []),
      };
      contexts.set(run.version, ctx);
    }
    let lastBody: unknown;
    const recording: CompatTarget = {
      ...target,
      call: async (request) => {
        const answer = await target.call(request);
        lastBody = answer.body;
        return answer;
      },
    };
    const result = await runCase(recording, run.case, run.operation, ctx);
    bodies.set(result, lastBody);
    results.push(result);
  }
  const operations = COMPAT_OPERATIONS.map((o): OperationResult => {
    const mine = results.filter((r) => r.operation === o.id);
    return {
      id: o.id,
      family: o.family,
      method: o.method,
      path: o.path,
      state: stateOf(mine, bodies),
      passed: mine.filter((r) => r.outcome === 'pass').length,
      total: mine.length,
    };
  });
  const totals = { complete: 0, partial: 0, failing: 0, missing: 0, untested: 0 };
  for (const o of operations) totals[o.state] += 1;
  return { cases: results, operations, totals };
}

const LABEL: Record<OperationState, string> = {
  complete: 'complete',
  partial: 'partial',
  failing: 'failing',
  missing: 'missing',
  untested: 'untested',
};

/**
 * The compatibility matrix (API-014): generated from a run, never edited by hand. Lists each
 * family's counts, then each operation with its state and the cases it passed.
 */
export function formatMatrix(report: CompatReport, title: string): string {
  const lines = [
    `# ${title}`,
    '',
    'Generated by the Jira-compatible API conformance suite (`packages/api-jira-compat`, ADR-085)',
    'from a run against this repository’s server. Do not edit it by hand: change the server or the',
    'suite, then `pnpm verify --update`.',
    '',
    `Operations: ${report.operations.length}. Complete ${report.totals.complete}, partial ${report.totals.partial}, failing ${report.totals.failing}, missing ${report.totals.missing}, untested ${report.totals.untested}.`,
    '',
    '| Family | Complete | Partial | Failing | Missing | Untested |',
    '| --- | --- | --- | --- | --- | --- |',
  ];
  for (const family of FAMILIES) {
    const ops = report.operations.filter((o) => o.family === family);
    const n = (state: OperationState) => ops.filter((o) => o.state === state).length;
    lines.push(
      `| ${family} | ${n('complete')} | ${n('partial')} | ${n('failing')} | ${n('missing')} | ${n('untested')} |`,
    );
  }
  for (const family of FAMILIES) {
    lines.push('', `## ${family}`, '', '| Operation | Method and path | State | Cases passed |');
    lines.push('| --- | --- | --- | --- |');
    for (const o of report.operations.filter((op) => op.family === family)) {
      lines.push(
        `| \`${o.id}\` | \`${o.method} ${o.path}\` | ${LABEL[o.state]} | ${o.passed} of ${o.total} |`,
      );
    }
  }
  return `${lines.join('\n')}\n`;
}

/** One line per family, and the first failing cases: what `pnpm conformance compat` prints. */
export function formatSummary(report: CompatReport, failures = 20): string {
  const lines = formatMatrix(report, 'Jira-compatible API conformance').split('\n').slice(6, 18);
  const failed = report.cases.filter((c) => c.outcome !== 'pass').slice(0, failures);
  if (failed.length > 0) {
    lines.push('', 'Not passing:');
    for (const c of failed) {
      lines.push(`  v${c.version} ${c.case}: ${c.outcome}${c.problem ? ` (${c.problem})` : ''}`);
    }
  }
  return `${lines.join('\n')}\n`;
}
