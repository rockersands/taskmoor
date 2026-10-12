import {
  locate,
  parseQuery,
  parseWithDiagnostics,
  printQuery,
  QUERY_CASES,
  QueryError,
  stripSpans,
} from '@tracksmith/query';
import { Rng } from '@tracksmith/testkit/gen';

/**
 * Fuzzer for the query parser (M1-034: "parser fuzzed 1 h without crash"). It feeds the
 * parser random text, token soup and mutations of the conformance suite's queries, and checks
 * on every input that nothing but a `QueryError` ever escapes, that the recovering parser and
 * the throwing one agree, and that every tree, partial or not, prints as a query that reads
 * back to the same tree.
 */

/** Inputs slower than this are reported: the parser is linear, so a slow input is a bug. */
export const SLOW_MS = 250;

const SAME = (a: unknown, b: unknown) =>
  JSON.stringify(stripSpans(a)) === JSON.stringify(stripSpans(b));

/** Every invariant on one input; returns what broke, or undefined. */
export function checkQueryInput(text: string): string | undefined {
  let result: ReturnType<typeof parseWithDiagnostics>;
  try {
    result = parseWithDiagnostics(text);
  } catch (error) {
    return `parseWithDiagnostics threw ${describe(error)}`;
  }
  let last = -1;
  for (const e of result.errors) {
    if (e.start <= last) return `errors out of order or repeated at ${e.start}`;
    last = e.start;
    if (e.start < 0 || e.end < e.start || e.end > text.length + 1) {
      return `error span ${e.start}-${e.end} outside the text`;
    }
    const at = locate(text, e.start);
    if (at.line !== e.line || at.column !== e.column) {
      return `error at ${e.start} reports line ${e.line}:${e.column}, expected ${at.line}:${at.column}`;
    }
    if (!e.message) return `error at ${e.start} has no message`;
  }

  let thrown: unknown;
  let tree: unknown;
  try {
    tree = parseQuery(text);
  } catch (error) {
    thrown = error;
  }
  if (thrown !== undefined && !(thrown instanceof QueryError)) {
    return `parseQuery threw ${describe(thrown)}`;
  }
  const first = result.errors[0];
  if (first && !thrown) return 'parseQuery accepted text with errors';
  if (!first && thrown) return `parseQuery refused a valid query: ${describe(thrown)}`;
  if (first && thrown instanceof QueryError && thrown.position !== first.start) {
    return `parseQuery reports ${thrown.position}, the first diagnostic is at ${first.start}`;
  }
  if (!first && !SAME(tree, result.query))
    return 'parseQuery and parseWithDiagnostics built different trees';

  let printed: string;
  try {
    printed = printQuery(result.query);
  } catch (error) {
    return `printQuery threw ${describe(error)}`;
  }
  const again = parseWithDiagnostics(printed);
  if (again.errors.length > 0) {
    return `the printed tree ${JSON.stringify(printed)} does not parse: ${again.errors[0]?.message}`;
  }
  if (!SAME(again.query, result.query))
    return `the printed tree ${JSON.stringify(printed)} reads back differently`;
  if (printQuery(again.query) !== printed)
    return `printing is not stable for ${JSON.stringify(printed)}`;
  return undefined;
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...' \t\n\r()[],"\'\\=!<>~-+./@_#*?%&|;:{}$^`',
  'é',
  'ß',
  '日',
  '\u0000',
  '\u200b',
  '🙂',
];

const TOKENS = [
  'status',
  'assignee',
  '"Story Points"',
  "'quoted'",
  'cf[10016]',
  'cf[',
  '=',
  '!=',
  '~',
  '!~',
  '<',
  '>=',
  'IN',
  'NOT',
  'IS',
  'EMPTY',
  'NULL',
  'WAS',
  'CHANGED',
  'FROM',
  'TO',
  'BY',
  'BEFORE',
  'AFTER',
  'ON',
  'DURING',
  'AND',
  'OR',
  'ORDER',
  'ASC',
  'DESC',
  '(',
  ')',
  ',',
  '[',
  ']',
  'Done',
  'ABC-12',
  '-1w',
  '+2d',
  '2026-01-31',
  '2026/01/31',
  '3.5',
  'currentUser()',
  'startOfDay(-1d)',
  'f(',
  '@current',
  '"',
  "'",
  '\\',
  '#',
  '\n',
];

/** The seed queries: every text of the conformance suite. */
export function corpus(): string[] {
  const out: string[] = [];
  for (const c of QUERY_CASES) {
    if ('text' in c) out.push(c.text);
    if ('texts' in c) out.push(...c.texts);
  }
  return out;
}

/** One input: random text, token soup, a mutated corpus query, or a splice of two. */
export function generate(rng: Rng, seeds: readonly string[]): string {
  const kind = rng.int(0, 9);
  if (kind === 0) {
    const n = rng.int(0, 80);
    let s = '';
    for (let i = 0; i < n; i++) s += rng.pick(ALPHABET);
    return s;
  }
  if (kind <= 2) {
    const n = rng.int(0, 40);
    const parts: string[] = [];
    for (let i = 0; i < n; i++) parts.push(rng.pick(TOKENS));
    return parts.join(rng.chance(0.8) ? ' ' : '');
  }
  if (kind === 3) {
    // Deep or unbalanced nesting.
    const depth = rng.int(1, 300);
    const open = rng.pick(['(', 'NOT ', 'f(', '((']);
    const close = rng.chance(0.5) ? ')'.repeat(rng.int(0, depth)) : '';
    return `${open.repeat(depth)}${rng.pick(seeds)}${close}`;
  }
  let text = rng.pick(seeds);
  const edits = rng.int(1, 4);
  for (let e = 0; e < edits; e++) text = mutate(rng, text, seeds);
  return text;
}

function mutate(rng: Rng, text: string, seeds: readonly string[]): string {
  const at = rng.int(0, text.length);
  switch (rng.int(0, 7)) {
    case 0: // delete a run
      return text.slice(0, at) + text.slice(Math.min(text.length, at + rng.int(1, 6)));
    case 1: // insert a character
      return text.slice(0, at) + rng.pick(ALPHABET) + text.slice(at);
    case 2: // insert a token
      return `${text.slice(0, at)} ${rng.pick(TOKENS)} ${text.slice(at)}`;
    case 3: // truncate
      return text.slice(0, at);
    case 4: // duplicate a slice
      return text.slice(0, at) + text.slice(at, at + rng.int(1, 20)) + text.slice(at);
    case 5: // splice two queries
      return `${text.slice(0, at)} ${rng.pick(['AND', 'OR', ''])} ${rng.pick(seeds).slice(rng.int(0, 10))}`;
    case 6: // swap two characters
      return at + 1 < text.length
        ? text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2)
        : text;
    default: // replace a character with a quote or bracket
      return text.slice(0, at) + rng.pick(['"', "'", '(', ')', '[', ']', ',']) + text.slice(at + 1);
  }
}

export interface FuzzFailure {
  input: string;
  problem: string;
}

export interface FuzzReport {
  seed: number;
  seconds: number;
  inputs: number;
  failures: FuzzFailure[];
  slowest: { ms: number; input: string };
  /** Inputs that parsed without error, and inputs with at least one error. */
  valid: number;
  invalid: number;
}

/**
 * Runs the fuzzer for `seconds` (or `inputs` inputs, whichever comes first) and collects at
 * most `maxFailures` distinct problems.
 */
export function fuzzQueryParser(options: {
  seed: number;
  seconds: number;
  inputs?: number;
  maxFailures?: number;
  onProgress?: (report: FuzzReport) => void;
}): FuzzReport {
  const rng = new Rng(options.seed);
  const seeds = corpus();
  const started = performance.now();
  const deadline = started + options.seconds * 1000;
  const report: FuzzReport = {
    seed: options.seed,
    seconds: 0,
    inputs: 0,
    failures: [],
    slowest: { ms: 0, input: '' },
    valid: 0,
    invalid: 0,
  };
  const seen = new Set<string>();
  let lastProgress = started;
  while (
    performance.now() < deadline &&
    report.inputs < (options.inputs ?? Number.POSITIVE_INFINITY)
  ) {
    const input = generate(rng, seeds);
    const t0 = performance.now();
    const problem = checkQueryInput(input);
    const ms = performance.now() - t0;
    report.inputs++;
    if (ms > report.slowest.ms) report.slowest = { ms: Math.round(ms * 100) / 100, input };
    if (problem === undefined && ms > SLOW_MS) {
      report.failures.push({ input, problem: `took ${Math.round(ms)} ms` });
    }
    if (problem !== undefined && !seen.has(problem)) {
      seen.add(problem);
      report.failures.push({ input, problem });
    }
    if (problem === undefined) {
      if (parseWithDiagnostics(input).errors.length === 0) report.valid++;
      else report.invalid++;
    }
    if ((options.maxFailures ?? 20) <= report.failures.length) break;
    const now = performance.now();
    if (options.onProgress && now - lastProgress > 60_000) {
      lastProgress = now;
      options.onProgress({ ...report, seconds: Math.round((now - started) / 1000) });
    }
  }
  report.seconds = Math.round((performance.now() - started) / 1000);
  return report;
}
