import { Rng } from './gen/rng';

/**
 * A small fuzzing harness for parsers of untrusted input (M1-118, ADR-104). A target says how
 * to make inputs (from seeds, by mutation) and what must hold on every input; `runFuzz` feeds
 * it inputs for a bounded time and collects what broke.
 *
 * Inputs are reproducible: input `i` of a run is the `i`-th draw of a generator seeded with the
 * run's seed, and the target's own randomness for that input comes from
 * `Rng.derive(seed, 'check', i)`. So a hang can be reported by its index alone (the runner that
 * watches a run, `fuzz-worker.ts`, rebuilds the input with `inputAt`).
 */
export interface FuzzTarget<T = string> {
  name: string;
  /** One line for the CLI and the report: what is fed in and what is checked. */
  description: string;
  /** Inputs to mutate: corpora, conformance cases, generated documents. */
  seeds(): readonly T[] | Promise<readonly T[]>;
  /** One input, from the generator's stream. */
  generate(rng: Rng, seeds: readonly T[]): T;
  /**
   * Every invariant on one input: an outcome label (`valid`, `refused`, ...) counted in the
   * report, or `{ problem }` when an invariant broke.
   */
  check(input: T, rng: Rng): FuzzVerdict | Promise<FuzzVerdict>;
  /** The input as text, for the report and the failure file. */
  show(input: T): string;
  /** An input slower than this (timed three times) is a failure; default `SLOW_MS`. */
  slowMs?: number;
}

export type FuzzVerdict = string | { problem: string };

/** Parsers here are linear or close to it: a second for one input is a bug. */
export const SLOW_MS = 1000;

export interface FuzzFailure {
  /** The input's index in the run, to rebuild it with `inputAt`. */
  index: number;
  input: string;
  problem: string;
}

export interface FuzzReport {
  target: string;
  seed: number;
  seconds: number;
  inputs: number;
  perSecond: number;
  failures: FuzzFailure[];
  slowest: { ms: number; input: string };
  /** How many inputs ended with each outcome label. */
  outcomes: Record<string, number>;
}

export interface FuzzOptions {
  seed: number;
  seconds: number;
  /** Stop after this many inputs, whichever comes first. */
  inputs?: number | undefined;
  /** Stop after this many distinct problems (default 20). */
  maxFailures?: number;
  /** Called about once a minute (or every `progressMs`). */
  onProgress?: (report: FuzzReport) => void;
  progressMs?: number;
  /** Called before each input with its index (the watchdog's heartbeat). */
  onInput?: (index: number) => void;
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : `non-Error ${String(error)}`;

/** The input as text; an input too deep to print is described instead. */
function shown<T>(target: FuzzTarget<T>, input: T): string {
  try {
    return target.show(input);
  } catch (error) {
    return `<could not show the input: ${describeError(error)}>`;
  }
}

async function verdictOf<T>(target: FuzzTarget<T>, input: T, rng: Rng): Promise<FuzzVerdict> {
  try {
    return await target.check(input, rng);
  } catch (error) {
    return { problem: `the check threw ${describeError(error)}` };
  }
}

/** Input `index` of a run with `seed`, as the run generated it. */
export async function inputAt<T>(target: FuzzTarget<T>, seed: number, index: number): Promise<T> {
  const rng = new Rng(seed);
  const seeds = await target.seeds();
  let input = target.generate(rng, seeds);
  for (let i = 0; i < index; i++) input = target.generate(rng, seeds);
  return input;
}

export async function runFuzz<T>(target: FuzzTarget<T>, options: FuzzOptions): Promise<FuzzReport> {
  const rng = new Rng(options.seed);
  const seeds = await target.seeds();
  const slowMs = target.slowMs ?? SLOW_MS;
  const started = performance.now();
  const deadline = started + options.seconds * 1000;
  const limit = options.inputs ?? Number.POSITIVE_INFINITY;
  const report: FuzzReport = {
    target: target.name,
    seed: options.seed,
    seconds: 0,
    inputs: 0,
    perSecond: 0,
    failures: [],
    slowest: { ms: 0, input: '' },
    outcomes: {},
  };
  const seen = new Set<string>();
  const finish = (now: number) => {
    report.seconds = Math.round((now - started) / 100) / 10;
    report.perSecond = Math.round(report.inputs / Math.max(0.001, (now - started) / 1000));
    return report;
  };
  let lastProgress = started;
  while (performance.now() < deadline && report.inputs < limit) {
    const index = report.inputs;
    options.onInput?.(index);
    const input = target.generate(rng, seeds);
    const checkRng = () => Rng.derive(options.seed, 'check', index);
    const t0 = performance.now();
    let verdict = await verdictOf(target, input, checkRng());
    let ms = performance.now() - t0;
    if (typeof verdict === 'string' && ms > slowMs) {
      // A pause of a loaded machine is not a slow input: it must be slow three times.
      for (let again = 0; again < 2 && ms > slowMs; again++) {
        const t1 = performance.now();
        verdict = await verdictOf(target, input, checkRng());
        ms = Math.min(ms, performance.now() - t1);
      }
      if (ms > slowMs) verdict = { problem: `took ${Math.round(ms)} ms` };
    }
    report.inputs++;
    if (ms > report.slowest.ms) {
      report.slowest = {
        ms: Math.round(ms * 100) / 100,
        input: shown(target, input).slice(0, 2000),
      };
    }
    if (typeof verdict === 'string') {
      report.outcomes[verdict] = (report.outcomes[verdict] ?? 0) + 1;
    } else if (!seen.has(verdict.problem)) {
      seen.add(verdict.problem);
      report.failures.push({ index, input: shown(target, input), problem: verdict.problem });
      if (report.failures.length >= (options.maxFailures ?? 20)) break;
    }
    const now = performance.now();
    if (options.onProgress && now - lastProgress > (options.progressMs ?? 60_000)) {
      lastProgress = now;
      options.onProgress({ ...finish(now) });
    }
  }
  return finish(performance.now());
}

// --- Mutation helpers shared by text targets ---------------------------------------------------

/** Characters that tend to matter to parsers, plus a few that tend to break them. */
export const AWKWARD_CHARACTERS = [
  ...' \t\n\r()[]{}<>,.;:\'"`\\/|!?*+-=_~^%$#@&',
  '\u0000',
  '\u0007',
  '\u001b',
  '\u007f',
  ' ',
  '­',
  '​',
  '‍',
  ' ',
  '‮',
  '﻿',
  '�',
  '\ud800',
  '\udfff',
  'é',
  'ß',
  'İ',
  '日',
  '🙂',
  '👍🏽',
];

const LETTERS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

/** Random text from letters, `tokens` and awkward characters. */
export function randomText(rng: Rng, tokens: readonly string[], maxParts = 60): string {
  const n = rng.int(0, maxParts);
  let out = '';
  for (let i = 0; i < n; i++) {
    const kind = rng.int(0, 9);
    if (kind < 4) out += rng.pick(tokens);
    else if (kind < 7) out += LETTERS[rng.int(0, LETTERS.length - 1)];
    else out += rng.pick(AWKWARD_CHARACTERS);
  }
  return out;
}

/** One edit of `text`: delete, insert, duplicate, truncate, swap, splice or repeat a run. */
export function mutateText(
  rng: Rng,
  text: string,
  tokens: readonly string[],
  seeds: readonly string[],
): string {
  const at = rng.int(0, text.length);
  switch (rng.int(0, 9)) {
    case 0:
      return text.slice(0, at) + text.slice(Math.min(text.length, at + rng.int(1, 8)));
    case 1:
      return text.slice(0, at) + rng.pick(AWKWARD_CHARACTERS) + text.slice(at);
    case 2:
      return text.slice(0, at) + rng.pick(tokens) + text.slice(at);
    case 3:
      return text.slice(0, at);
    case 4:
      return text.slice(0, at) + text.slice(at, at + rng.int(1, 30)) + text.slice(at);
    case 5: {
      const other = seeds.length > 0 ? rng.pick(seeds) : '';
      const from = rng.int(0, other.length);
      return text.slice(0, at) + other.slice(from, from + rng.int(1, 200)) + text.slice(at);
    }
    case 6:
      return at + 1 < text.length
        ? text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2)
        : text;
    case 7: {
      // A run repeated many times: long lines, deep nesting, many markers.
      const run = text.slice(at, at + rng.int(1, 6)) || rng.pick(tokens);
      return text.slice(0, at) + run.repeat(rng.int(2, 400)) + text.slice(at);
    }
    case 8:
      return text.slice(0, at) + LETTERS[rng.int(0, LETTERS.length - 1)] + text.slice(at + 1);
    default:
      return `${rng.pick(tokens)}${text}${rng.pick(tokens)}`;
  }
}

/** The usual text input: random, a seed, or a seed after one to five edits. */
export function textInput(rng: Rng, seeds: readonly string[], tokens: readonly string[]): string {
  const kind = rng.int(0, 9);
  if (kind === 0 || seeds.length === 0) return randomText(rng, tokens);
  let text = rng.pick(seeds);
  if (kind === 1) return text;
  const edits = rng.int(1, 5);
  for (let i = 0; i < edits; i++) text = mutateText(rng, text, tokens, seeds);
  return text;
}
