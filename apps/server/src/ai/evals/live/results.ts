import type { EvalRun } from '../runner';
import { THRESHOLDS } from '../runner';
import { CHECKS, type CheckId, type CheckSpec, type Task } from './plan';

/**
 * What `pnpm ai:live` (T-333) makes of its children: each check passed, failed, or could not be
 * measured, with the measured value; which backlog items that closes; and the two written forms,
 * `.verify/ai-live.json` and `docs/ai/live-checks.md`. Built from counts, ids and our own wording
 * only: no prompt, no answer, no key and no request header.
 */

export type Status = 'pass' | 'fail' | 'error';

export interface CheckResult extends CheckSpec {
  status: Status;
  measured: string;
  details: string[];
}

/** What a child left for its checks. */
export interface StepOutput {
  code: number | null;
  /** Its JSON report (Vitest's, or the eval run), scrubbed and parsed; null without one. */
  report: unknown;
  /** What its tests recorded (`recordLiveResult`), a record a line. */
  records: readonly Record<string, unknown>[];
  /** The end of its output, scrubbed, for a check it could not measure. */
  tail: readonly string[];
}

const spec = (id: CheckId) => CHECKS.find((c) => c.id === id) as CheckSpec;
const checkResult = (
  id: CheckId,
  status: Status,
  measured: string,
  details: string[] = [],
): CheckResult => ({ ...spec(id), status, measured, details });

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

/** The first line of a message, at most `max` characters. */
function short(text: string, max = 200): string {
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function listed(items: readonly string[], max = 15): string {
  return items.length > max
    ? `${items.slice(0, max).join(', ')} and ${items.length - max} more`
    : items.join(', ');
}

interface TestOutcome {
  title: string;
  status: string;
  failure: string;
}

interface VitestFile {
  message?: string;
  assertionResults?: { title?: string; status?: string; failureMessages?: string[] }[];
}

/** A Vitest JSON report's tests, and the errors that stopped a file before its tests ran. */
function vitestOutcomes(report: unknown): { tests: TestOutcome[]; fileErrors: string[] } {
  const files = (report as { testResults?: unknown } | null)?.testResults;
  if (!Array.isArray(files)) return { tests: [], fileErrors: [] };
  const tests: TestOutcome[] = [];
  const fileErrors: string[] = [];
  for (const file of files as VitestFile[]) {
    if (file.message) fileErrors.push(short(file.message));
    for (const a of file.assertionResults ?? []) {
      tests.push({
        title: a.title ?? '',
        status: a.status ?? 'unknown',
        failure: short(a.failureMessages?.[0] ?? ''),
      });
    }
  }
  return { tests, fileErrors };
}

/** Why a group of tests measured nothing; null when it measured something. */
function unmeasured(out: StepOutput, tests: TestOutcome[], fileErrors: string[]): string[] | null {
  if (out.report === null) {
    return [`the test run left no report (exit code ${out.code ?? 'none'})`, ...out.tail];
  }
  if (tests.length === 0) return fileErrors.length > 0 ? fileErrors : ['no test of this check ran'];
  if (tests.every((t) => t.status === 'skipped' || t.status === 'pending')) {
    return ['the tests were skipped: the key did not reach them'];
  }
  return null;
}

const failed = (tests: TestOutcome[]) =>
  tests
    .filter((t) => t.status !== 'passed')
    .map((t) => `${t.title}: ${t.status}${t.failure ? `: ${t.failure}` : ''}`);

/** M1-073's smoke test and M1-074's cache read, from `packages/ai/src/live.test.ts`. */
export function smokeChecks(out: StepOutput): [CheckResult, CheckResult] {
  const { tests, fileErrors } = vitestOutcomes(out.report);
  // The cache test is the one that cites prompt caching (AI-008); the rest are the smoke test.
  const smoke = tests.filter((t) => !t.title.includes('[AI-008]'));
  const cache = tests.filter((t) => t.title.includes('[AI-008]'));
  const models = [
    ...new Set(
      out.records.flatMap((r) =>
        r.check === 'smoke' && typeof r.model === 'string' ? [r.model] : [],
      ),
    ),
  ];

  let smokeCheck: CheckResult;
  const smokeWhy = unmeasured(out, smoke, fileErrors);
  if (smokeWhy) smokeCheck = checkResult('smoke', 'error', 'not measured', smokeWhy);
  else {
    const passed = smoke.filter((t) => t.status === 'passed').length;
    smokeCheck = checkResult(
      'smoke',
      passed === smoke.length ? 'pass' : 'fail',
      `${passed}/${smoke.length} tests pass${models.length > 0 ? `; answered by ${models.join(', ')}` : ''}`,
      failed(smoke),
    );
  }

  let cacheCheck: CheckResult;
  const cacheWhy = unmeasured(out, cache, fileErrors);
  if (cacheWhy) cacheCheck = checkResult('cache-read', 'error', 'not measured', cacheWhy);
  else {
    const record = out.records.findLast((r) => r.check === 'cache-read');
    const read = typeof record?.cacheReadTokens === 'number' ? record.cacheReadTokens : null;
    const passed = cache.every((t) => t.status === 'passed');
    cacheCheck = checkResult(
      'cache-read',
      passed && read !== null && read > 0 ? 'pass' : 'fail',
      read === null ? 'not measured' : `${read} cache-read tokens on the repeat call`,
      [
        ...(record
          ? [
              `the first call wrote ${String(record.firstCacheWriteTokens)} and read ${String(record.firstCacheReadTokens)} cached tokens`,
            ]
          : []),
        ...failed(cache),
      ],
    );
  }
  return [smokeCheck, cacheCheck];
}

/** The corpus against the live model, from `packages/ai/src/injection/live.test.ts`. */
export function injectionCheck(out: StepOutput, total: number): CheckResult {
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of out.records) {
    if (r.check === 'injection-case' && typeof r.id === 'string') byId.set(r.id, r);
  }
  if (byId.size === 0) {
    const { tests, fileErrors } = vitestOutcomes(out.report);
    const why = unmeasured(out, tests, fileErrors) ?? ['no case recorded a result'];
    return checkResult('injection-corpus', 'error', 'not measured', why);
  }
  const cases = [...byId.values()];
  const held = cases.filter((r) => r.holds === true).length;
  const followed = cases.filter((r) => r.followed === true).length;
  const shown = cases.filter((r) => typeof r.followed === 'boolean').length;
  return checkResult(
    'injection-corpus',
    held === total ? 'pass' : 'fail',
    `${held}/${total} cases hold`,
    [
      `the model went where the injection pointed in ${followed} of the ${shown} cases where a run shows it; what must hold is the defences`,
      ...cases
        .filter((r) => r.holds !== true)
        .map(
          (r) =>
            `${String(r.id)}: ${Array.isArray(r.problems) ? r.problems.map(String).join('; ') : 'did not hold'}`,
        ),
      ...(byId.size < total
        ? [`${total - byId.size} ${total - byId.size === 1 ? 'case' : 'cases'} left no result`]
        : []),
    ],
  );
}

/** M1-079's measured thresholds, from `pnpm eval all --candidate ...live.ts --json`. */
export function evalChecks(out: StepOutput): CheckResult[] {
  const run = out.report as Partial<EvalRun> | null;
  const ids: CheckId[] = ['eval-query', 'eval-summary', 'eval-duplicates', 'eval-injection'];
  if (!run || !Array.isArray(run.query)) {
    const why = [`the eval run stopped (exit code ${out.code ?? 'none'})`, ...out.tail];
    return ids.map((id) => checkResult(id, 'error', 'not measured', why));
  }
  const missing = (id: CheckId) => checkResult(id, 'error', 'not measured', ['no report']);
  const broken = run.broken ?? [];
  const pending = run.pending ?? [];

  const q = run.query[0];
  const query = q
    ? checkResult(
        'eval-query',
        q.score >= THRESHOLDS.query ? 'pass' : 'fail',
        `${pct(q.score)} (${q.passed}/${q.total}; ${Object.entries(q.byLanguage)
          .map(([language, s]) => `${language} ${s.passed}/${s.total}`)
          .join(', ')})`,
        q.failures.length > 0
          ? [`no exact-result match: ${listed(q.failures.map((f) => f.id))}`]
          : [],
      )
    : missing('eval-query');

  const s = run.summary?.[0];
  const judged = s?.judged === 'judged';
  const summary = s
    ? checkResult(
        'eval-summary',
        judged && s.score >= THRESHOLDS.summary && broken.length === 0 ? 'pass' : 'fail',
        judged
          ? `${s.passed}/${s.total} pass both graders`
          : `${s.passed}/${s.total} pass the automatic criteria; the judge did not run`,
        [
          run.judge
            ? `judge calibration: ${run.judge.agree}/${run.judge.examples} graded examples agree with their labels`
            : 'the judge was not calibrated',
          ...s.failures.map(
            (f) => `${f.id}: fails ${f.failed.length > 0 ? f.failed.join(', ') : 'a criterion'}`,
          ),
          ...broken,
          ...pending,
        ],
      )
    : missing('eval-summary');

  const d = run.duplicates?.[0];
  const duplicates = d
    ? checkResult(
        'eval-duplicates',
        d.recallAt3 >= THRESHOLDS.duplicates ? 'pass' : 'fail',
        `${pct(d.recallAt3)} over ${d.queries} queries (MRR ${d.mrr.toFixed(3)})`,
        [
          'where the model’s re-ranking fails or runs out of its 2 seconds, the embedding order stands: this measures the feature as people get it',
          ...(d.failures.length > 0
            ? [`no duplicate in the top 3: ${listed(d.failures.map((f) => f.id))}`]
            : []),
        ],
      )
    : missing('eval-duplicates');

  const i = run.injection?.[0];
  // A feature that failed holds too: a case counts once the model has answered at least once.
  const unanswered = (i?.outcomes ?? []).filter((o) => o.answered === 0).map((o) => o.id);
  const injection = i
    ? checkResult(
        'eval-injection',
        i.score >= THRESHOLDS.injection && unanswered.length === 0 ? 'pass' : 'fail',
        `${i.passed}/${i.total} cases hold; the model answered ${i.answered} of ${i.asked} requests`,
        [
          ...i.failures.map((f) => `${f.id}: ${f.problems.join('; ')}`),
          ...(unanswered.length > 0
            ? [`no feature got an answer from the model for ${listed(unanswered)}`]
            : []),
        ],
      )
    : missing('eval-injection');

  return [query, summary, duplicates, injection];
}

export interface TaskVerdict {
  task: Task;
  done: boolean;
  /** Its checks that did not pass. */
  open: CheckId[];
}

/** A backlog item is done when every check that belongs to it passes. */
export function verdicts(checks: readonly CheckResult[]): TaskVerdict[] {
  return (['M1-073', 'M1-074', 'M1-079'] as const).map((task) => {
    const mine = checks.filter((c) => c.task === task);
    const open = mine.filter((c) => c.status !== 'pass').map((c) => c.id);
    return { task, done: mine.length > 0 && open.length === 0, open };
  });
}

export interface LiveSummary {
  ran: true;
  at: string;
  seconds: number;
  model: string;
  /** Where the calls went: the Anthropic API, or the address given with --base-url. */
  endpoint: string;
  estimate: { calls: [number, number]; dollars: [number, number] };
  checks: CheckResult[];
  tasks: TaskVerdict[];
  ok: boolean;
  exitCode: 0 | 1;
}

/** Why nothing was run: no key, a key the API refused, a no, or a stop. */
export interface NotRun {
  ran: false;
  at: string;
  reason: string;
  exitCode: 2;
}

export function summarize(
  checks: CheckResult[],
  meta: Pick<LiveSummary, 'at' | 'seconds' | 'model' | 'endpoint' | 'estimate'>,
): LiveSummary {
  const ok = checks.length > 0 && checks.every((c) => c.status === 'pass');
  return { ran: true, ...meta, checks, tasks: verdicts(checks), ok, exitCode: ok ? 0 : 1 };
}

const RESULT_WORD: Record<Status, string> = {
  pass: 'pass',
  fail: 'fail',
  error: 'not measured',
};

function took(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return `${Math.round(seconds)} s`;
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function recordLine(v: TaskVerdict, checks: readonly CheckResult[]): string {
  if (v.done) return `${v.task}: done.`;
  const why = v.open
    .map((id) => `${id} ${RESULT_WORD[checks.find((c) => c.id === id)?.status ?? 'error']}`)
    .join(', ');
  return `${v.task}: not yet (${why}).`;
}

/** `docs/ai/live-checks.md`: the run, a row per check, what to record, and the details. */
export function renderMarkdown(s: LiveSummary): string {
  const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const passed = s.checks.filter((c) => c.status === 'pass').length;
  const out = [
    '# Live AI checks',
    '',
    'The last run of `pnpm ai:live` (T-333), written by the command: the checks of M1-073, M1-074',
    'and M1-079 that need a real model. It holds no key, no request header and no prompt. How to',
    'run it safely: [README.md](README.md).',
    '',
    `- Run: ${s.at.slice(0, 16).replace('T', ' ')} UTC, took ${took(s.seconds)}`,
    `- Against: ${s.endpoint}, model \`${s.model}\``,
    `- Result: ${passed} of ${s.checks.length} checks pass`,
    '',
    '| Check | Backlog | Threshold | Measured | Result |',
    '| --- | --- | --- | --- | --- |',
    ...s.checks.map(
      (c) =>
        `| ${cell(c.title)} | ${c.task} | ${cell(c.threshold)} | ${cell(c.measured)} | ${RESULT_WORD[c.status]} |`,
    ),
    '',
    '## What to record',
    '',
    ...s.tasks.map((v) => `- ${recordLine(v, s.checks)}`),
    '',
    '## Details',
  ];
  for (const c of s.checks) {
    if (c.details.length === 0) continue;
    out.push('', `### ${c.title}`, '', ...c.details.map((d) => `- ${d}`));
  }
  return `${out.join('\n')}\n`;
}

/** The run as the terminal shows it at the end, with what the coordinator records. */
export function renderConsole(s: LiveSummary, written: readonly string[]): string {
  const out = ['', 'ai:live results:'];
  for (const c of s.checks) {
    out.push(
      `  ${RESULT_WORD[c.status].padEnd(12)} ${c.id.padEnd(16)} ${c.measured} (threshold: ${c.threshold})`,
    );
    if (c.status !== 'pass') {
      for (const d of c.details.slice(0, 8)) out.push(`      ${d}`);
      if (c.details.length > 8) out.push(`      ... ${c.details.length - 8} more in the report`);
    }
  }
  out.push('', 'What the coordinator records in docs/plan/progress.csv:');
  out.push(...s.tasks.map((v) => `  ${recordLine(v, s.checks)}`));
  out.push(
    s.ok
      ? '  Every check passes: M1-073, M1-074 and M1-079 are done, with the measured values above; the M1 gate then counts the injection corpus green against a live model.'
      : '  Record as done only the items marked done; the rest stay in progress.',
  );
  out.push('', `Written: ${written.join(', ')}`, s.ok ? 'PASS' : 'FAIL', '');
  return out.join('\n');
}
