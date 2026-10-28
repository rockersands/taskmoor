import {
  caseResolve,
  compileFormula,
  type EvalInput,
  evaluate,
  FORMULA_CASES,
  FormulaError,
  fieldToken,
  isDay,
  LIMITS,
  locate,
  OUTPUT_TYPES,
  type Program,
  rewriteRefs,
  type Scalar,
  storedValue,
  TEXT_OUTPUT_MAX,
  workingWeek,
} from '@taskmoor/formula';
import { Rng } from '@taskmoor/testkit/gen';

/**
 * Fuzzer for the formula parser, type checker and evaluator (M1-013: "evaluator fuzzed 1 h
 * without crash"). It feeds random text, token soup, generated well-typed formulas and
 * mutations of the conformance suite's formulas, and checks on every input that:
 *
 * - compiling never throws: it gives a program or a `FormulaError` whose place lies inside the
 *   text, with the line and column of that place;
 * - a program evaluates, on random field values and child tickets, to a value or to the step
 *   limit, never an exception, never a number that is not finite, and the same value twice;
 * - what any output stores from that value fits the output;
 * - the formula written with field ids (as it is stored) compiles to the same program;
 * - no input takes longer than `SLOW_MS`. A slow input is timed twice more (with other random
 *   values) before it counts, so a pause of a loaded machine is not reported as one.
 */
export const SLOW_MS = 1000;

/** Every invariant on one input; returns what broke, or undefined. */
export function checkFormulaInput(text: string, rng: Rng): string | undefined {
  let compiled: ReturnType<typeof compileFormula>;
  try {
    compiled = compileFormula(text, { resolve: caseResolve });
  } catch (error) {
    return `compileFormula threw ${describe(error)}`;
  }
  if (!compiled.ok) {
    const e = compiled.error;
    if (!(e instanceof FormulaError)) return `a refusal that is no FormulaError: ${describe(e)}`;
    if (e.start < 0 || e.end < e.start || e.end > text.length + 1) {
      return `error span ${e.start}-${e.end} outside the text (${e.code})`;
    }
    const at = locate(text, e.start);
    if (at.line !== e.line || at.column !== e.column) {
      return `error at ${e.start} reports ${e.line}:${e.column}, expected ${at.line}:${at.column}`;
    }
    if (!e.message) return `error ${e.code} has no message`;
    return undefined;
  }
  const program = compiled.program;
  // Stored with ids, read back: the same program.
  const stored = rewriteRefs(text, [...program.refs, ...program.childRefs], (r) =>
    fieldToken(r.id),
  );
  const byId = compileFormula(stored, {
    resolve: (id) => BY_ID.get(id) ?? { problem: 'unknown_field' },
  });
  if (!byId.ok) return `the formula with ids does not compile: ${byId.error.message}`;
  if (JSON.stringify(byId.program.ir) !== JSON.stringify(program.ir)) {
    return `the formula with ids ${JSON.stringify(stored)} compiles to another program`;
  }
  for (let round = 0; round < 3; round++) {
    const input = randomInput(rng, program);
    let first: ReturnType<typeof evaluate>;
    let second: ReturnType<typeof evaluate>;
    try {
      first = evaluate(program, input);
      second = evaluate(program, input);
    } catch (error) {
      return `evaluate threw ${describe(error)}`;
    }
    if (JSON.stringify(first) !== JSON.stringify(second)) return 'evaluation is not deterministic';
    if (!first.ok) continue;
    const v = first.value;
    if (typeof v === 'number' && !Number.isFinite(v)) return `evaluated to ${v}`;
    if (typeof v === 'string' && v.length > LIMITS.text) return `text of ${v.length} characters`;
    for (const output of OUTPUT_TYPES) {
      let kept: number | string | undefined;
      try {
        kept = storedValue(output, v);
      } catch (error) {
        return `storedValue(${output}) threw ${describe(error)}`;
      }
      if (kept === undefined) continue;
      const problem = storedProblem(output, kept);
      if (problem) return `${output} stores ${JSON.stringify(kept)}: ${problem}`;
    }
  }
  return undefined;
}

function storedProblem(output: string, kept: number | string): string | undefined {
  switch (output) {
    case 'text':
      if (typeof kept !== 'string') return 'not text';
      if ([...kept].length > TEXT_OUTPUT_MAX) return 'too long';
      if (/\p{Cc}/u.test(kept)) return 'a control character';
      return kept.trim() === kept && kept !== '' ? undefined : 'not trimmed';
    case 'date':
      return typeof kept === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(kept) ? undefined : 'no day';
    case 'duration':
      return Number.isInteger(kept) ? undefined : 'not whole seconds';
    default:
      return typeof kept === 'number' && Number.isFinite(kept) && Math.abs(kept) <= 1e12
        ? undefined
        : 'out of range';
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const FIELD_NAMES = [
  'Points',
  'Effort',
  'Customer',
  'Due date',
  'Start date',
  'Created',
  'Summary',
  'Time spent',
  'Original estimate',
  'Remaining estimate',
];

/** The fixture's fields by the ids a stored formula names them with. */
const BY_ID = new Map(
  FIELD_NAMES.flatMap((name) => {
    const f = caseResolve(name);
    return 'id' in f ? [[f.id, f] as const] : [];
  }),
);

/** A value of any kind, the awkward ones included. */
function randomScalar(rng: Rng): Scalar {
  switch (rng.int(0, 9)) {
    case 0:
      return null;
    case 1:
      return rng.int(-1000, 1000);
    case 2:
      return (rng.next() - 0.5) * 10 ** rng.int(-5, 20);
    case 3:
      return rng.pick([0, -0, 1e308, -1e308, 5e-324, Number.MAX_SAFE_INTEGER, 2 ** 53 + 1]);
    case 4:
      return rng.int(-354_285, 2_932_896);
    case 5:
      return rng.pick(['', 'Acme', 'ÄÖü', '🙂', 'a\nb', 'x'.repeat(rng.int(0, 300))]);
    case 6:
      return rng.int(0, 10_000_000);
    case 7:
      return rng.chance(0.5);
    default:
      return rng.int(15_000, 25_000);
  }
}

function randomInput(rng: Rng, program: Program): EvalInput {
  const values = new Map<string, Scalar>();
  for (const r of program.refs) values.set(r.id, randomScalar(rng));
  const count = rng.chance(0.1) ? rng.int(0, 5000) : rng.int(0, 20);
  const lists = new Map<string, Scalar[]>();
  for (const r of program.childRefs) {
    lists.set(
      r.id,
      Array.from({ length: count }, () => randomScalar(rng)),
    );
  }
  const today = rng.int(-354_285, 2_932_896);
  return {
    field: (id) => values.get(id) ?? null,
    children: (id) => lists.get(id) ?? [],
    childCount: () => count,
    today: isDay(today) ? today : 20_000,
    workingWeek: workingWeek(rng.int(1, 700) / 100),
  };
}

const ALPHABET = [
  ...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  ...' \t\n\r(){}[],."\'\\=!<>-+*/^&|;:#$%?~`@_',
  'é',
  '日',
  '\u0000',
  '\u2028',
  '🙂',
];

const TOKENS = [
  ...FIELD_NAMES.map((n) => `{${n}}`),
  '{Nope}',
  '{Size}',
  '{Labels}',
  '{',
  '}',
  'children',
  'children.{Points}',
  'children.{Due date}',
  'children.{Customer}',
  'children.',
  ...Object.keys({
    if: 1,
    isEmpty: 1,
    ifEmpty: 1,
    sum: 1,
    avg: 1,
    min: 1,
    max: 1,
    count: 1,
    abs: 1,
    round: 1,
    floor: 1,
    ceil: 1,
    mod: 1,
    pow: 1,
    sqrt: 1,
    today: 1,
    date: 1,
    daysBetween: 1,
    workingDaysBetween: 1,
    workingDaysUntil: 1,
    addDays: 1,
    year: 1,
    month: 1,
    day: 1,
    weekday: 1,
    hours: 1,
    minutes: 1,
    text: 1,
    concat: 1,
    upper: 1,
    lower: 1,
    len: 1,
    constructor: 1,
    __proto__: 1,
  }).map((f) => `${f}(`),
  '(',
  ')',
  ',',
  '+',
  '-',
  '*',
  '/',
  '^',
  '&',
  '=',
  '==',
  '!=',
  '<>',
  '<',
  '<=',
  '>',
  '>=',
  'and',
  'or',
  'not',
  '&&',
  '||',
  '!',
  'true',
  'false',
  'null',
  '0',
  '1',
  '2.5',
  '-1',
  '1e308',
  '1e-400',
  '.5',
  '"Overdue"',
  "'x'",
  '"',
  '"2026-02-29"',
  '"2026-10-28"',
];

const NUMBER_LEAVES = [
  '{Points}',
  '{Effort}',
  '1',
  '0',
  '2.5',
  '-3',
  '1e6',
  'null',
  'count(children)',
];
const DATE_LEAVES = ['{Due date}', '{Start date}', '{Created}', 'today()', 'date("2026-02-28")'];
const TEXT_LEAVES = ['{Customer}', '{Summary}', '"Overdue"', "''", 'text({Points})'];
const DURATION_LEAVES = ['{Time spent}', '{Original estimate}', 'hours(1.5)', 'minutes(-30)'];

/** A random formula that mostly type-checks, so evaluation is reached often. */
function generated(rng: Rng, depth: number, type: 'n' | 'd' | 't' | 'u' | 'b'): string {
  const leaf = () =>
    rng.pick(
      type === 'n'
        ? NUMBER_LEAVES
        : type === 'd'
          ? DATE_LEAVES
          : type === 't'
            ? TEXT_LEAVES
            : type === 'u'
              ? DURATION_LEAVES
              : ['true', 'false', 'isEmpty({Points})'],
    );
  if (depth <= 0 || rng.chance(0.25)) return leaf();
  const g = (t: typeof type) => generated(rng, depth - 1, t);
  switch (type) {
    case 'n':
      return rng.pick([
        () => `(${g('n')} ${rng.pick(['+', '-', '*', '/', '^'])} ${g('n')})`,
        () => `-${g('n')}`,
        () => `${rng.pick(['abs', 'floor', 'ceil', 'sqrt'])}(${g('n')})`,
        () => `round(${g('n')}, ${g('n')})`,
        () => `${rng.pick(['pow', 'mod'])}(${g('n')}, ${g('n')})`,
        () => `${rng.pick(['sum', 'avg', 'min', 'max'])}(${g('n')}, children.{Points}, ${g('n')})`,
        () => `count(children.{${rng.pick(FIELD_NAMES)}})`,
        () => `(${g('d')} - ${g('d')})`,
        () => `${rng.pick(['daysBetween', 'workingDaysBetween'])}(${g('d')}, ${g('d')})`,
        () => `workingDaysUntil(${g('d')})`,
        () => `${rng.pick(['year', 'month', 'day', 'weekday'])}(${g('d')})`,
        () => `len(${g('t')})`,
        () => `(${g('u')} / ${g('u')})`,
        () => `if(${g('b')}, ${g('n')}, ${g('n')})`,
        () => `ifEmpty(${g('n')}, ${g('n')})`,
      ])();
    case 'd':
      return rng.pick([
        () => `(${g('d')} ${rng.pick(['+', '-'])} ${g('n')})`,
        () => `addDays(${g('d')}, ${g('n')})`,
        () => `${rng.pick(['min', 'max'])}(${g('d')}, children.{Due date})`,
        () => `if(${g('b')}, ${g('d')}, ${g('d')})`,
      ])();
    case 't':
      return rng.pick([
        () => `(${g(rng.pick(['n', 'd', 't', 'u', 'b']))} & ${g(rng.pick(['n', 'd', 't', 'u']))})`,
        () => `${rng.pick(['upper', 'lower'])}(${g('t')})`,
        () => `concat(${g('t')}, ${g('n')}, ${g('d')}, ${g('u')})`,
        () => `if(${g('b')}, ${g('t')}, ${g(rng.pick(['n', 'd', 'u']))})`,
        () => `text(${g(rng.pick(['n', 'd', 'u', 'b']))})`,
      ])();
    case 'u':
      return rng.pick([
        () => `(${g('u')} ${rng.pick(['+', '-'])} ${g('u')})`,
        () => `(${g('u')} * ${g('n')})`,
        () => `${rng.pick(['sum', 'min', 'max', 'avg'])}(children.{Time spent}, ${g('u')})`,
        () => `abs(${g('u')})`,
        () => `${rng.pick(['hours', 'minutes'])}(${g('n')})`,
      ])();
    default:
      return rng.pick([
        () => `(${g('n')} ${rng.pick(['<', '<=', '>', '>=', '=', '!='])} ${g('n')})`,
        () => `(${g('d')} < ${g('d')})`,
        () => `(${g('t')} = ${g('t')})`,
        () => `(${g('b')} ${rng.pick(['and', 'or', '&&', '||'])} ${g('b')})`,
        () => `not ${g('b')}`,
        () => `isEmpty(${g(rng.pick(['n', 'd', 't', 'u']))})`,
      ])();
  }
}

/** The seed formulas: every formula of the conformance suite. */
export function corpus(): string[] {
  return FORMULA_CASES.map((c) => c.formula);
}

/** One input: random text, token soup, a generated formula, a mutated or spliced seed. */
export function generate(rng: Rng, seeds: readonly string[]): string {
  const kind = rng.int(0, 11);
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
    // Deep or unbalanced nesting, long chains, long texts.
    const depth = rng.int(1, 200);
    const open = rng.pick(['(', '-', 'not ', 'abs(', '((', 'if(true, ', '2 ^ ']);
    const close = rng.chance(0.5) ? ')'.repeat(rng.int(0, depth)) : '';
    return `${open.repeat(depth)}${rng.pick(seeds)}${close}`;
  }
  if (kind === 4) {
    const n = rng.int(1, 700);
    return Array.from({ length: n }, () => rng.pick(['1', '{Points}', 'children.{Points}'])).join(
      rng.pick([' + ', '&', ', ']),
    );
  }
  if (kind <= 7) return generated(rng, rng.int(1, 7), rng.pick(['n', 'd', 't', 'u', 'b']));
  let text = rng.pick(seeds);
  const edits = rng.int(1, 4);
  for (let e = 0; e < edits; e++) text = mutate(rng, text, seeds);
  return text;
}

function mutate(rng: Rng, text: string, seeds: readonly string[]): string {
  const at = rng.int(0, text.length);
  switch (rng.int(0, 7)) {
    case 0:
      return text.slice(0, at) + text.slice(Math.min(text.length, at + rng.int(1, 6)));
    case 1:
      return text.slice(0, at) + rng.pick(ALPHABET) + text.slice(at);
    case 2:
      return `${text.slice(0, at)} ${rng.pick(TOKENS)} ${text.slice(at)}`;
    case 3:
      return text.slice(0, at);
    case 4:
      return text.slice(0, at) + text.slice(at, at + rng.int(1, 20)) + text.slice(at);
    case 5:
      return `${text.slice(0, at)} ${rng.pick(['+', '&', ',', 'and', ''])} ${rng.pick(seeds).slice(rng.int(0, 10))}`;
    case 6:
      return at + 1 < text.length
        ? text.slice(0, at) + text[at + 1] + text[at] + text.slice(at + 2)
        : text;
    default:
      return (
        text.slice(0, at) + rng.pick(['"', "'", '(', ')', '{', '}', ',', '.']) + text.slice(at + 1)
      );
  }
}

export interface FuzzFailure {
  input: string;
  problem: string;
}

export interface FormulaFuzzReport {
  seed: number;
  seconds: number;
  inputs: number;
  failures: FuzzFailure[];
  slowest: { ms: number; input: string };
  /** Inputs that compiled (and were evaluated), and inputs refused with a place. */
  valid: number;
  invalid: number;
}

/**
 * Runs the fuzzer for `seconds` (or `inputs` inputs, whichever comes first) and collects at
 * most `maxFailures` distinct problems.
 */
export function fuzzFormulas(options: {
  seed: number;
  seconds: number;
  inputs?: number;
  maxFailures?: number;
  onProgress?: (report: FormulaFuzzReport) => void;
}): FormulaFuzzReport {
  const rng = new Rng(options.seed);
  const seeds = corpus();
  const started = performance.now();
  const deadline = started + options.seconds * 1000;
  const report: FormulaFuzzReport = {
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
    const problem = checkFormulaInput(input, rng);
    const ms = performance.now() - t0;
    report.inputs++;
    let fastest = ms;
    for (let retry = 0; problem === undefined && fastest > SLOW_MS && retry < 2; retry++) {
      const t1 = performance.now();
      checkFormulaInput(input, new Rng(report.inputs + retry));
      fastest = Math.min(fastest, performance.now() - t1);
    }
    if (fastest > report.slowest.ms) {
      report.slowest = { ms: Math.round(fastest * 100) / 100, input };
    }
    if (problem === undefined && fastest > SLOW_MS) {
      report.failures.push({ input, problem: `took ${Math.round(fastest)} ms` });
    }
    if (problem !== undefined && !seen.has(problem)) {
      seen.add(problem);
      report.failures.push({ input, problem });
    }
    if (problem === undefined) {
      if (compileFormula(input, { resolve: caseResolve }).ok) report.valid++;
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
