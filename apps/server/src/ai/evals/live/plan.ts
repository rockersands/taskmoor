import { DEFAULT_MODEL, LIST_PRICES, NANOS_PER_USD } from '@taskmoor/ai';
import { INJECTION_CASES } from '@taskmoor/ai/testing';
import { DUPLICATE_POOL } from '../duplicates-corpus';
import { QUERY_PAIRS } from '../query-corpus';
import { THRESHOLDS } from '../runner';
import { SUMMARY_CASES } from '../summary-corpus';

/**
 * What `pnpm ai:live` runs (T-333): the checks that need a real model, the backlog items they
 * close, and a rough cost made from the corpora's sizes before anything is spent.
 */

export type Task = 'M1-073' | 'M1-074' | 'M1-079';
export type CheckId =
  | 'smoke'
  | 'cache-read'
  | 'injection-corpus'
  | 'eval-query'
  | 'eval-summary'
  | 'eval-duplicates'
  | 'eval-injection';
export type StepId = 'smoke' | 'injection' | 'evals';

export interface CheckSpec {
  id: CheckId;
  task: Task;
  title: string;
  threshold: string;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

export const CHECKS: readonly CheckSpec[] = [
  {
    id: 'smoke',
    task: 'M1-073',
    title:
      'Live smoke test: an answer, a stream, strict structured output, a strict tool with automatic choice, a token count and the model list',
    threshold: 'every test passes',
  },
  {
    id: 'cache-read',
    task: 'M1-074',
    title: 'A repeat call with the same prefix reads the cache',
    threshold: 'cache_read_input_tokens above 0',
  },
  {
    id: 'injection-corpus',
    task: 'M1-079',
    title: 'The prompt-injection corpus against the live model',
    threshold: `every case holds (${pct(THRESHOLDS.injection)})`,
  },
  {
    id: 'eval-query',
    task: 'M1-079',
    title: 'Natural language to query: exact-result match',
    threshold: `${pct(THRESHOLDS.query)} or more`,
  },
  {
    id: 'eval-summary',
    task: 'M1-079',
    title: 'Summaries pass the automatic and the judged criteria',
    threshold: `every case (${pct(THRESHOLDS.summary)})`,
  },
  {
    id: 'eval-duplicates',
    task: 'M1-079',
    title: 'Duplicate suggestions: recall@3',
    threshold: `${pct(THRESHOLDS.duplicates)} or more`,
  },
  {
    id: 'eval-injection',
    task: 'M1-079',
    title: 'The injection corpus through every AI feature',
    threshold: `every case holds (${pct(THRESHOLDS.injection)})`,
  },
];

export interface StepSpec {
  id: StepId;
  title: string;
  /** What runs, as a person would type it. */
  runs: string;
  checks: readonly CheckId[];
}

export const STEPS: readonly StepSpec[] = [
  {
    id: 'smoke',
    title: 'The live smoke test and the cache read',
    runs: 'packages/ai/src/live.test.ts',
    checks: ['smoke', 'cache-read'],
  },
  {
    id: 'injection',
    title: 'The prompt-injection corpus against the live model',
    runs: 'packages/ai/src/injection/live.test.ts',
    checks: ['injection-corpus'],
  },
  {
    id: 'evals',
    title: 'The evals with the live candidate',
    runs: 'pnpm eval all --candidate apps/server/src/ai/evals/candidates/live.ts',
    checks: ['eval-query', 'eval-summary', 'eval-duplicates', 'eval-injection'],
  },
];

/** How many cases each corpus holds: what the number of model calls follows from. */
export interface CorpusSizes {
  queries: number;
  summaries: number;
  /** Graded example summaries the judge is calibrated on before it grades. */
  graded: number;
  duplicateQueries: number;
  injectionCases: number;
}

export function corpusSizes(): CorpusSizes {
  return {
    queries: QUERY_PAIRS.length,
    summaries: SUMMARY_CASES.length,
    graded: SUMMARY_CASES.reduce((n, c) => n + c.graded.length, 0),
    duplicateQueries: DUPLICATE_POOL.filter((t) => t.cluster).length,
    injectionCases: INJECTION_CASES.length,
  };
}

type Range = [low: number, high: number];

export interface Load {
  calls: Range;
  inputTokens: Range;
  outputTokens: Range;
}

/**
 * Tokens one call takes, low and high, from what each prompt carries: instructions, a ticket
 * and its thread, the query language and the person's vocabulary. Output includes adaptive
 * thinking at the features' effort, which is what makes its range wide.
 */
const PER_CALL = {
  smoke: { input: [1_700, 1_700], output: [300, 2_000] },
  agent: { input: [1_500, 3_000], output: [300, 2_000] },
  query: { input: [3_000, 3_500], output: [300, 2_000] },
  summary: { input: [2_500, 4_000], output: [500, 3_000] },
  judge: { input: [2_000, 3_000], output: [300, 1_500] },
  rerank: { input: [1_500, 2_000], output: [300, 1_500] },
  feature: { input: [2_000, 3_500], output: [300, 3_000] },
} satisfies Record<string, { input: Range; output: Range }>;

function load(parts: [calls: Range, kind: keyof typeof PER_CALL][]): Load {
  const sum = (f: (calls: Range, kind: keyof typeof PER_CALL) => Range): Range =>
    parts.reduce<Range>(
      (acc, [calls, kind]) => {
        const [lo, hi] = f(calls, kind);
        return [acc[0] + lo, acc[1] + hi];
      },
      [0, 0],
    );
  return {
    calls: sum((calls) => calls),
    inputTokens: sum((calls, kind) => [
      calls[0] * PER_CALL[kind].input[0],
      calls[1] * PER_CALL[kind].input[1],
    ]),
    outputTokens: sum((calls, kind) => [
      calls[0] * PER_CALL[kind].output[0],
      calls[1] * PER_CALL[kind].output[1],
    ]),
  };
}

export interface Estimate {
  model: string;
  steps: Record<StepId, Load>;
  total: Load;
  /** List price per million tokens, input and output. */
  price: { input: number; output: number };
  dollars: Range;
  minutes: Range;
}

/** Seconds a call takes, low and high: the calls run one after another. */
const SECONDS_PER_CALL: Range = [3, 8];

/**
 * The calls each step makes and what they cost at list price, low and high. Low: every answer
 * usable at once, one step per agent run. High: a repair turn for each structured answer, four
 * steps per agent run, long thinking. Cached prefixes cost a twentieth of their input price,
 * which only lowers the real figure.
 */
export function estimate(sizes: CorpusSizes = corpusSizes(), model = DEFAULT_MODEL): Estimate {
  const n = sizes.injectionCases;
  const steps: Record<StepId, Load> = {
    // An answer, two calls for the cache, a stream, structured output (one repair at most), a tool.
    smoke: load([[[6, 7], 'smoke']]),
    // One to four steps of the agent run per case.
    injection: load([[[n, 4 * n], 'agent']]),
    evals: load([
      [[sizes.queries, 2 * sizes.queries], 'query'],
      [[sizes.summaries, sizes.summaries], 'summary'],
      [[sizes.graded + sizes.summaries, sizes.graded + sizes.summaries], 'judge'],
      [[sizes.duplicateQueries, 2 * sizes.duplicateQueries], 'rerank'],
      // Summary, query, drafts and breakdown per case; the structured three may repair once.
      [[4 * n, 7 * n], 'feature'],
    ]),
  };
  const total = load([]);
  for (const step of Object.values(steps)) {
    for (const key of ['calls', 'inputTokens', 'outputTokens'] as const) {
      total[key] = [total[key][0] + step[key][0], total[key][1] + step[key][1]];
    }
  }
  const listed = LIST_PRICES.find((p) => p.provider === 'anthropic' && p.model === model)?.price;
  if (!listed) throw new Error(`No list price for ${model}`);
  const usd = (tokens: number, nanos: number) => (tokens * nanos) / NANOS_PER_USD;
  return {
    model,
    steps,
    total,
    price: { input: listed.inputNanos / 1000, output: listed.outputNanos / 1000 },
    dollars: [
      usd(total.inputTokens[0], listed.inputNanos) + usd(total.outputTokens[0], listed.outputNanos),
      usd(total.inputTokens[1], listed.inputNanos) + usd(total.outputTokens[1], listed.outputNanos),
    ],
    minutes: [
      (total.calls[0] * SECONDS_PER_CALL[0]) / 60,
      (total.calls[1] * SECONDS_PER_CALL[1]) / 60,
    ],
  };
}

const millions = (n: number) => (n / 1_000_000).toFixed(1);
const range = ([lo, hi]: Range, f: (n: number) => string = String) =>
  f(lo) === f(hi) ? f(lo) : `${f(lo)} to ${f(hi)}`;

function duration(minutes: number): string {
  if (minutes < 60) return `${Math.max(5, Math.round(minutes / 5) * 5)} minutes`;
  const hours = Math.round(minutes / 30) / 2;
  return hours === 1 ? 'an hour' : `${hours} hours`;
}

/** The plan as the person reads it before saying yes: what runs, and roughly what it costs. */
export function describePlan(sizes: CorpusSizes, e: Estimate, endpoint: string): string {
  const lines = [
    `pnpm ai:live (T-333): the checks that need a real model, against ${endpoint} with ${e.model}.`,
    '',
    'It runs, one after another, and stops on nothing:',
    `  1. ${STEPS[0]?.title} (${STEPS[0]?.runs}; M1-073, M1-074): ${range(e.steps.smoke.calls)} calls`,
    `  2. ${STEPS[1]?.title} (${STEPS[1]?.runs}; M1-079): ${sizes.injectionCases} cases, ${range(e.steps.injection.calls)} calls`,
    `  3. ${STEPS[2]?.title} (${STEPS[2]?.runs}; M1-079): ${sizes.queries} questions to queries, ${sizes.summaries} summaries graded by the judge (calibrated on ${sizes.graded} examples first), ${sizes.duplicateQueries} duplicate searches, ${sizes.injectionCases} injection cases through 4 features: ${range(e.steps.evals.calls)} calls`,
    '',
    `Rough cost: ${range(e.total.calls)} calls, about ${range(e.total.inputTokens, millions)} million input tokens and ${range(e.total.outputTokens, millions)} million output tokens (adaptive thinking included): about ${range(e.dollars, (d) => `$${Math.round(d)}`)} at the list price of ${e.model} ($${e.price.input} input, $${e.price.output} output per million tokens); cached prefixes cost less. It takes about ${duration(e.minutes[0])} to ${duration(e.minutes[1])}. Use a key with a spend limit.`,
  ];
  return `${lines.join('\n')}\n`;
}
