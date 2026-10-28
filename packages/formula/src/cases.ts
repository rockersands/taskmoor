import { dayOfIso, isoOfDay, MONDAY_TO_FRIDAY, workingWeek } from './calendar';
import { compileFormula, type Resolution } from './check';
import type { FormulaErrorCode } from './errors';
import { type EvalInput, evaluate } from './evaluate';
import type { OutputType, Scalar, ValueType } from './program';
import { storedValue } from './values';

/**
 * The formula conformance suite (M1-013; CORE-011): cases as data, each a formula, the ticket
 * it runs on and what must come out: a value, what the field stores, or a refusal at a place.
 * The cases restate spec 01a CORE-011 and section 1.4 in our own words; behaviour the spec
 * leaves open (how empty values combine, which week counts as working) is decided in ADR-009
 * "Implementation (M1-013)" and marked `decided` here.
 *
 * The fixture: a ticket with the fields below, three child tickets, today 2026-10-28 (a
 * Wednesday) and a Monday-to-Friday week unless a case says otherwise.
 */
export type CaseSection =
  | 'arithmetic'
  | 'aggregates'
  | 'roll-ups'
  | 'dates'
  | 'working-days'
  | 'conditions'
  | 'text'
  | 'durations'
  | 'empty'
  | 'outputs'
  | 'errors'
  | 'limits';

export const CASE_SECTIONS: readonly CaseSection[] = [
  'arithmetic',
  'aggregates',
  'roll-ups',
  'dates',
  'working-days',
  'conditions',
  'text',
  'durations',
  'empty',
  'outputs',
  'errors',
  'limits',
];

/** Field values by name: numbers, text, dates as `YYYY-MM-DD`, durations in seconds. */
export type CaseValues = Record<string, number | string | null>;

export interface FormulaCase {
  /** Unique and stable: `CORE-011-<section>-<slug>`. */
  id: string;
  requirement: 'CORE-011';
  section: CaseSection;
  title: string;
  formula: string;
  /** Values that differ from the fixture ticket's. */
  ticket?: CaseValues;
  /** The child tickets, replacing the fixture's three. */
  children?: CaseValues[];
  /** Today, when not 2026-10-28. */
  today?: string;
  /** Days per week of the working week (time tracking setting), when not 5. */
  daysPerWeek?: number;
  /** The field's output, for `stored` and for refusals of the output. */
  output?: OutputType;
  maxSteps?: number;
  /** A choice the spec leaves open, made in ADR-009 "Implementation (M1-013)". */
  decided?: string;
  expect:
    | { value: Scalar; type?: ValueType }
    | { stored: number | string | null }
    | { error: FormulaErrorCode; at: number; end?: number; line?: number; column?: number }
    | { steps: true };
}

/** The fixture's fields: name (any case) to id and type. */
const FIELDS: Readonly<Record<string, Resolution>> = {
  points: { id: 'cf[1]', type: 'number' },
  effort: { id: 'cf[2]', type: 'number' },
  customer: { id: 'cf[3]', type: 'text' },
  'due date': { id: 'due', type: 'date' },
  'start date': { id: 'start', type: 'date' },
  created: { id: 'created', type: 'date' },
  summary: { id: 'summary', type: 'text' },
  'time spent': { id: 'timeSpent', type: 'duration' },
  'original estimate': { id: 'originalEstimate', type: 'duration' },
  'remaining estimate': { id: 'remainingEstimate', type: 'duration' },
  labels: { problem: 'unsupported_field', message: 'Formulas cannot read labels yet' },
  size: { problem: 'ambiguous_field' },
};

export function caseResolve(name: string): Resolution {
  const key = name.toLowerCase();
  return Object.hasOwn(FIELDS, key) ? (FIELDS[key] as Resolution) : { problem: 'unknown_field' };
}

const TICKET: CaseValues = {
  Points: 5,
  Effort: 3,
  Customer: 'Acme',
  'Due date': '2026-11-02',
  'Start date': '2026-10-26',
  Created: '2026-10-01',
  Summary: 'Fix login',
  'Time spent': 5400,
  'Original estimate': 28_800,
  'Remaining estimate': 21_600,
};

const CHILDREN: CaseValues[] = [
  { Points: 3, 'Time spent': 3600, 'Due date': '2026-11-20', Customer: 'Acme' },
  { Points: null, 'Time spent': 0, 'Due date': null, Customer: null },
  { Points: 8, 'Time spent': 1800, 'Due date': '2026-11-05', Customer: 'Initech' },
];

/** A case ticket's values by field id, in run-time form (dates as day numbers). */
function byId(values: CaseValues): Map<string, Scalar> {
  const out = new Map<string, Scalar>();
  for (const [name, value] of Object.entries(values)) {
    const f = caseResolve(name);
    if ('problem' in f) continue;
    out.set(f.id, f.type === 'date' && typeof value === 'string' ? dayOfIso(value) : value);
  }
  return out;
}

export interface CaseOutcome {
  /** The value in display form: dates as `YYYY-MM-DD`. */
  value?: Scalar;
  type?: ValueType;
  stored?: number | string | null;
  error?: { code: FormulaErrorCode; at: number; end: number; line: number; column: number };
  steps?: true;
}

/** Runs one case against this package. */
export function runCase(c: FormulaCase): CaseOutcome {
  const compiled = compileFormula(c.formula, {
    resolve: caseResolve,
    ...(c.output ? { output: c.output } : {}),
  });
  if (!compiled.ok) {
    const e = compiled.error;
    return { error: { code: e.code, at: e.start, end: e.end, line: e.line, column: e.column } };
  }
  const program = compiled.program;
  const own = byId({ ...TICKET, ...(c.ticket ?? {}) });
  const kids = (c.children ?? CHILDREN).map((k) => byId(k));
  const input: EvalInput = {
    field: (id) => own.get(id) ?? null,
    children: (id) => kids.map((k) => k.get(id) ?? null),
    childCount: () => kids.length,
    today: dayOfIso(c.today ?? '2026-10-28') as number,
    workingWeek: c.daysPerWeek === undefined ? MONDAY_TO_FRIDAY : workingWeek(c.daysPerWeek),
  };
  const result = evaluate(program, input, c.maxSteps ? { maxSteps: c.maxSteps } : {});
  if (!result.ok) return { steps: true };
  const value =
    program.type === 'date' && typeof result.value === 'number'
      ? isoOfDay(result.value)
      : result.value;
  return {
    value,
    type: program.type,
    ...(c.output ? { stored: storedValue(c.output, result.value) ?? null } : {}),
  };
}

/** Why a case fails, or null when it passes. Fractions compare to 12 decimals. */
export function caseFailure(c: FormulaCase): string | null {
  const got = runCase(c);
  const want = c.expect;
  const show = (x: unknown) => JSON.stringify(x);
  if ('error' in want) {
    const e = got.error;
    if (!e) return `expected a refusal ${want.error} at ${want.at}, got ${show(got)}`;
    const fits =
      e.code === want.error &&
      e.at === want.at &&
      (want.end === undefined || e.end === want.end) &&
      (want.line === undefined || e.line === want.line) &&
      (want.column === undefined || e.column === want.column);
    return fits ? null : `expected ${show(want)}, got ${show(e)}`;
  }
  if (got.error) return `refused: ${show(got.error)}`;
  if ('steps' in want) return got.steps ? null : `expected the step limit, got ${show(got)}`;
  if (got.steps) return 'ran out of steps';
  if ('stored' in want) {
    return show(got.stored) === show(want.stored)
      ? null
      : `expected to store ${show(want.stored)}, got ${show(got.stored)}`;
  }
  const close =
    typeof want.value === 'number' && typeof got.value === 'number' && !Number.isInteger(want.value)
      ? Math.abs(want.value - got.value) < 1e-12
      : show(got.value) === show(want.value);
  if (!close) return `expected ${show(want.value)}, got ${show(got.value)}`;
  if (want.type !== undefined && got.type !== want.type) {
    return `expected the type ${want.type}, got ${got.type}`;
  }
  return null;
}

/** Cases passed and failed per section, with the failures. */
export function runFormulaConformance(cases: readonly FormulaCase[] = FORMULA_CASES) {
  const sections = CASE_SECTIONS.map((section) => {
    const own = cases.filter((c) => c.section === section);
    const failed = own.flatMap((c) => {
      const problem = caseFailure(c);
      return problem === null ? [] : [{ id: c.id, problem }];
    });
    return { section, total: own.length, pass: own.length - failed.length, failed };
  });
  const total = sections.reduce((n, s) => n + s.total, 0);
  const pass = sections.reduce((n, s) => n + s.pass, 0);
  return { total, pass, fail: total - pass, sections };
}

const slugs = new Set<string>();
function section(name: CaseSection) {
  return (
    slug: string,
    title: string,
    formula: string,
    expect: FormulaCase['expect'],
    extra: Partial<Omit<FormulaCase, 'id' | 'section' | 'title' | 'formula' | 'expect'>> = {},
  ): FormulaCase => {
    const id = `CORE-011-${name}-${slug}`;
    if (slugs.has(id)) throw new Error(`duplicate case ${id}`);
    slugs.add(id);
    return { id, requirement: 'CORE-011', section: name, title, formula, expect, ...extra };
  };
}

const a = section('arithmetic');
const g = section('aggregates');
const r = section('roll-ups');
const d = section('dates');
const w = section('working-days');
const k = section('conditions');
const t = section('text');
const u = section('durations');
const e = section('empty');
const o = section('outputs');
const x = section('errors');
const l = section('limits');

const value = (v: Scalar, type?: ValueType) => (type ? { value: v, type } : { value: v });
const error = (code: FormulaErrorCode, at: number, end?: number) =>
  end === undefined ? { error: code, at } : { error: code, at, end };

export const FORMULA_CASES: readonly FormulaCase[] = [
  // Arithmetic, power, abs and rounding (CORE-011).
  a('double-points', '{Points} * 2 (acceptance criterion 1)', '{Points} * 2', value(10, 'number')),
  a('precedence', 'multiplication before addition', '1 + 2 * 3', value(7)),
  a('parentheses', 'parentheses first', '(1 + 2) * 3', value(9)),
  a('left-to-right', 'subtraction runs left to right', '10 - 4 - 3', value(3)),
  a('power-right', 'powers run right to left', '2 ^ 3 ^ 2', value(512)),
  a('power-sign', 'a sign applies after the power', '-2 ^ 2', value(-4)),
  a('power-negative-base', 'a parenthesised negative base', '(-2) ^ 2', value(4)),
  a('division', 'division keeps fractions', '{Points} / {Effort}', value(5 / 3)),
  a('division-by-zero', 'division by zero is empty', '7 / 0', value(null)),
  a(
    'division-by-zero-spreads',
    'empty spreads through arithmetic',
    '{Points} / 0 + 1',
    value(null),
  ),
  a(
    'scientific',
    'numbers in scientific notation and without a leading zero',
    '1.5e3 + .5',
    value(1500.5),
  ),
  a('negate-field', 'a minus sign on a field', '-{Points}', value(-5)),
  a('plus-sign', 'a plus sign changes nothing', '+{Points}', value(5)),
  a('double-minus', 'minus a negative number', '{Points} - -3', value(8)),
  a('sum-of-products', 'products before the sum', '2 * 3 + 4 * 5', value(26)),
  a('division-left', 'division runs left to right', '100 / 8 / 5', value(2.5)),
  a('pow-function', 'pow(base, exponent)', 'pow(2, 10)', value(1024)),
  a('pow-not-a-number', 'a power with no real result is empty', 'pow(-8, 1/3)', value(null)),
  a('pow-overflow', 'a power beyond the range of numbers is empty', '10 ^ 400', value(null)),
  a('abs', 'abs of a negative number', 'abs(-4.5)', value(4.5)),
  a('abs-field', 'abs of a difference', 'abs({Points} - 9)', value(4)),
  a('round-half-up', 'round takes halves away from zero', 'round(2.5)', value(3)),
  a('round-half-down', 'negative halves too', 'round(-2.5)', value(-3)),
  a('round-decimals', 'round to decimals on the written digits', 'round(1.005, 2)', value(1.01)),
  a(
    'round-tens',
    'negative decimals round to tens and hundreds',
    'round(1234.5678, -2)',
    value(1200),
  ),
  a('round-ratio', 'round a ratio of fields', 'round({Points} / {Effort}, 1)', value(1.7)),
  a('floor', 'floor of a positive number', 'floor(7.9)', value(7)),
  a('floor-negative', 'floor of a negative number goes down', 'floor(-7.1)', value(-8)),
  a('ceil', 'ceil goes up', 'ceil(7.1)', value(8)),
  a('ceil-binary-noise', 'ceil of 0.1 * 30 is 3, not 4', 'ceil(0.1 * 30)', value(3)),
  a('mod', 'remainder', 'mod(10, 3)', value(1)),
  a('mod-negative', 'the remainder takes the sign of the divisor', 'mod(-10, 3)', value(2), {
    decided: 'as spreadsheets do',
  }),
  a('mod-zero', 'remainder of a division by zero is empty', 'mod(10, 0)', value(null)),
  a('sqrt', 'square root', 'sqrt(16)', value(4)),
  a('sqrt-negative', 'square root of a negative number is empty', 'sqrt(-1)', value(null)),
  a('case-insensitive-functions', 'function names ignore case', 'ROUND(2.4) + Abs(-1)', value(3)),

  // Average, maximum, minimum and friends (CORE-011).
  g('avg', 'average of fields', 'avg({Points}, {Effort})', value(4)),
  g('avg-skips-empty', 'average skips empty values', 'avg({Points}, null, 3)', value(4)),
  g('max', 'largest value', 'max({Points}, {Effort}, 7)', value(7)),
  g('min', 'smallest value', 'min({Points}, {Effort}, 7)', value(3)),
  g('sum', 'sum of values', 'sum(1, 2, 3)', value(6)),
  g('min-of-empty', 'the minimum of nothing is empty', 'min(null, null)', value(null)),
  g('sum-of-empty', 'the sum of nothing is zero', 'sum(null)', value(0, 'number')),
  g(
    'count-values',
    'count counts the values that are there',
    'count({Points}, null, {Customer})',
    value(2),
  ),
  g(
    'max-of-dates',
    'the latest of two dates',
    'max({Due date}, {Start date})',
    value('2026-11-02', 'date'),
  ),
  g(
    'min-of-durations',
    'the shortest of two durations',
    'min({Time spent}, {Original estimate})',
    value(5400, 'duration'),
  ),

  // Roll-ups over child tickets (backlog M1-013).
  r(
    'sum',
    'sum of a field over the children, empty ones left out',
    'sum(children.{Points})',
    value(11, 'number'),
  ),
  r('avg', 'average over the children that have a value', 'avg(children.{Points})', value(5.5)),
  r('max', 'largest value on a child', 'max(children.{Points})', value(8)),
  r('min', 'smallest value on a child', 'min(children.{Points})', value(3)),
  r('count-children', 'number of child tickets', 'count(children)', value(3)),
  r('count-values', 'number of children with a value', 'count(children.{Points})', value(2)),
  r(
    'own-plus-children',
    'own value plus the children',
    '{Points} + sum(children.{Points})',
    value(16),
  ),
  r(
    'durations-in-hours',
    'time spent on the children in hours',
    'sum(children.{Time spent}) / hours(1)',
    value(1.5),
  ),
  r(
    'latest-date',
    'latest due date of the children',
    'max(children.{Due date})',
    value('2026-11-20', 'date'),
  ),
  r(
    'mixed-arguments',
    'a roll-up and own values together',
    'sum(children.{Points}, {Points})',
    value(16),
  ),
  r(
    'average-guarded',
    'an average guarded against no children',
    'if(count(children) > 0, sum(children.{Points}) / count(children), 0)',
    value(11 / 3),
  ),
  r('sum-no-children', 'a sum over no children is zero', 'sum(children.{Points})', value(0), {
    children: [],
  }),
  r(
    'avg-no-children',
    'an average over no children is empty',
    'avg(children.{Points})',
    value(null),
    {
      children: [],
    },
  ),
  r('count-no-children', 'no children count as zero', 'count(children)', value(0), {
    children: [],
  }),
  r(
    'text-values-counted',
    'count works on text values too',
    'count(children.{Customer})',
    value(2),
  ),
  r('case-insensitive-keyword', 'the keyword children ignores case', 'COUNT(Children)', value(3)),

  // Dates and date difference (backlog M1-013).
  d('difference', 'a date minus a date is days', '{Due date} - {Start date}', value(7, 'number')),
  d('days-between', 'daysBetween(from, to)', 'daysBetween({Start date}, {Due date})', value(7)),
  d(
    'days-between-backwards',
    'backwards is negative',
    'daysBetween({Due date}, {Start date})',
    value(-7),
  ),
  d('add-days', 'a date plus days', '{Due date} + 3', value('2026-11-05', 'date')),
  d('days-plus-date', 'days plus a date', '3 + {Due date}', value('2026-11-05', 'date')),
  d('subtract-days', 'a date minus days', '{Due date} - 3', value('2026-10-30', 'date')),
  d(
    'add-days-function',
    'addDays with a negative number',
    'addDays({Due date}, -30)',
    value('2026-10-03'),
  ),
  d(
    'add-fraction',
    'fractions of days are dropped',
    'addDays({Due date}, 1.9)',
    value('2026-11-03'),
    {
      decided: 'whole days only',
    },
  ),
  d('today', 'today', 'today()', value('2026-10-28', 'date')),
  d(
    'days-until-due',
    'days from today to the due date',
    'daysBetween(today(), {Due date})',
    value(5),
  ),
  d(
    'compare-dates',
    'dates compare in time order',
    '{Due date} < today()',
    value(false, 'boolean'),
  ),
  d('date-literal', 'a date written as text', 'date("2026-12-31") - today()', value(64)),
  d('date-invalid-day', 'a day that does not exist is empty', 'date("2026-02-30")', value(null)),
  d('date-not-a-date', 'text that is no date is empty', 'date("tomorrow")', value(null)),
  d(
    'parts',
    'year, month and day',
    'year({Due date}) * 10000 + month({Due date}) * 100 + day({Due date})',
    value(20261102),
  ),
  d('weekday', 'weekday is 1 for Monday', 'weekday({Due date})', value(1)),
  d('out-of-range', 'a date beyond 9999-12-31 is empty', '{Created} + 4000000', value(null)),
  d('created', 'creation date to due date', '{Due date} - {Created}', value(32)),
  d(
    'empty-side',
    'a difference with an empty date is empty',
    'daysBetween({Due date}, null)',
    value(null),
  ),
  d('no-due-date', 'a missing due date is empty', '{Due date} - today()', value(null), {
    ticket: { 'Due date': null },
  }),

  // Working days until due (CORE-011 (2)).
  w(
    'until-due',
    'working days after today up to the due date',
    'workingDaysUntil({Due date})',
    value(3, 'number'),
  ),
  w('until-today', 'due today is zero', 'workingDaysUntil(today())', value(0)),
  w('until-yesterday', 'due yesterday is -1', 'workingDaysUntil(date("2026-10-27"))', value(-1)),
  w(
    'until-past-weekend',
    'a past Sunday counts the working days since',
    'workingDaysUntil(date("2026-10-25"))',
    value(-2),
  ),
  w(
    'until-saturday',
    'a Saturday ahead counts Thursday and Friday',
    'workingDaysUntil(date("2026-10-31"))',
    value(2),
  ),
  w('until-sunday', 'and so does a Sunday', 'workingDaysUntil(date("2026-11-01"))', value(2)),
  w(
    'past-weekend-overdue',
    'a due date on a weekend just past is still overdue',
    'workingDaysUntil({Due date})',
    value(-1),
    {
      ticket: { 'Due date': '2026-10-24' },
      today: '2026-10-26',
      decided: 'at least -1 once passed',
    },
  ),
  w(
    'friday-to-monday',
    'Friday to Monday is one working day',
    'workingDaysBetween(date("2026-10-30"), date("2026-11-02"))',
    value(1),
  ),
  w(
    'monday-to-friday',
    'backwards is negative',
    'workingDaysBetween(date("2026-11-02"), date("2026-10-30"))',
    value(-1),
  ),
  w(
    'whole-year',
    'working days in 2026 after New Year',
    'workingDaysBetween(date("2026-01-01"), date("2026-12-31"))',
    value(260),
  ),
  w('six-day-week', 'a six-day week counts Saturday', 'workingDaysUntil({Due date})', value(4), {
    daysPerWeek: 6,
  }),
  w(
    'seven-day-week',
    'a seven-day week counts every day',
    'workingDaysUntil({Due date})',
    value(5),
    {
      daysPerWeek: 7,
    },
  ),
  w('one-day-week', 'a one-day week counts Mondays', 'workingDaysUntil({Due date})', value(1), {
    daysPerWeek: 1,
  }),
  w(
    'half-day',
    'four and a half days count Friday',
    'workingDaysUntil(date("2026-10-30"))',
    value(2),
    {
      daysPerWeek: 4.5,
      decided: 'the setting rounds up to whole days from Monday',
    },
  ),
  w(
    'overdue',
    '"Overdue" once the due date has passed (acceptance criterion 2)',
    'if(workingDaysUntil({Due date}) < 0, "Overdue", workingDaysUntil({Due date}))',
    value('Overdue', 'text'),
    { ticket: { 'Due date': '2026-10-23' } },
  ),
  w(
    'not-overdue',
    'the days left as text otherwise',
    'if(workingDaysUntil({Due date}) < 0, "Overdue", workingDaysUntil({Due date}))',
    value('3', 'text'),
  ),
  w(
    'due-today-not-overdue',
    'due today is not overdue',
    'if(workingDaysUntil({Due date}) < 0, "Overdue", workingDaysUntil({Due date}))',
    value('0'),
    { ticket: { 'Due date': '2026-10-28' } },
  ),
  w(
    'no-due-date',
    'no due date gives its own answer',
    'if(isEmpty({Due date}), "No due date", if({Due date} < today(), "Overdue", workingDaysUntil({Due date}) & " days"))',
    value('No due date'),
    { ticket: { 'Due date': null } },
  ),
  w(
    'days-left-text',
    'days left as a phrase',
    'if(isEmpty({Due date}), "No due date", if({Due date} < today(), "Overdue", workingDaysUntil({Due date}) & " days"))',
    value('3 days'),
  ),

  // Conditions and conditional text output (CORE-011).
  k(
    'if-true',
    'if picks the first branch when true',
    'if({Points} > 3, "Large", "Small")',
    value('Large', 'text'),
  ),
  k('if-false', 'and the second when false', 'if({Points} > 8, "Large", "Small")', value('Small')),
  k('and', 'and', 'if({Points} >= 5 and {Effort} < 5, "Yes", "No")', value('Yes')),
  k('or', 'or', 'if({Points} > 8 or {Effort} = 3, 1, 0)', value(1)),
  k('not', 'not', 'if(not ({Points} = 5), 1, 0)', value(0)),
  k('bang', '! and !=', 'if(!({Points} != 5), 1, 0)', value(1)),
  k('angle-not-equal', '<> is not equal', 'if({Points} <> 5, 1, 0)', value(0)),
  k('double-equals', '== is equal', 'if({Points} == 5, 1, 0)', value(1)),
  k('symbols', '&& and ||', 'if({Points} > 1 && ({Effort} > 9 || {Effort} = 3), 1, 0)', value(1)),
  k('keywords-any-case', 'keywords ignore case', 'IF({Points} > 1 AND NOT FALSE, 1, 0)', value(1)),
  k(
    'empty-condition',
    'a comparison with an empty value is false',
    'if({Points} > 1, "a", "b")',
    value('b'),
    {
      ticket: { Points: null },
      decided: 'comparisons with empty are false',
    },
  ),
  k('empty-not-equal', 'also for not equal', 'if({Points} != 1, "a", "b")', value('b'), {
    ticket: { Points: null },
    decided: 'comparisons with empty are false',
  }),
  k('no-else', 'without an else branch, false gives empty', 'if({Points} > 9, "a")', value(null)),
  k(
    'dates-out',
    'branches may give dates',
    'if({Points} = 5, {Due date}, {Start date})',
    value('2026-11-02', 'date'),
  ),
  k('text-case', 'text equality ignores case', 'if({Customer} = "ACME", 1, 0)', value(1)),
  k(
    'text-order',
    'text compares in alphabetical order',
    'if({Customer} < "Bravo", 1, 0)',
    value(1),
  ),
  k('nested', 'nested conditions', 'if({Points} < 3, "S", if({Points} < 8, "M", "L"))', value('M')),
  k('boolean-equality', 'true and false compare equal', 'if((1 < 2) = true, 1, 0)', value(1)),
  k('null-branch', 'a branch may be null', 'if({Points} > 1, null, 4)', value(null, 'number')),

  // Text (conditional text output).
  t('join', '& joins text', '{Customer} & " / " & {Summary}', value('Acme / Fix login', 'text')),
  t('join-number', 'numbers join as written', '"Points: " & {Points}', value('Points: 5')),
  t(
    'concat',
    'concat turns every type into text',
    'concat({Points} / 3, " ", {Due date}, " ", {Time spent}, " ", true)',
    value('1.667 2026-11-02 1h 30m true'),
  ),
  t('text-duration', 'a duration as text', 'text({Original estimate})', value('8h')),
  t('upper', 'upper case', 'upper({Customer})', value('ACME')),
  t('lower', 'lower case', 'lower({Summary})', value('fix login')),
  t('len', 'length in characters', 'len({Summary})', value(9)),
  t('join-empty', 'empty joins as nothing', '"a" & null & "b"', value('ab')),
  t('quotes', 'single and double quotes', '\'single\' & "double"', value('singledouble')),
  t('escape', 'a backslash keeps the next character', '"say \\"hi\\""', value('say "hi"')),
  t('is-empty-text', 'empty text is empty', 'isEmpty("")', value(true)),
  t('is-empty-field', 'a field with text is not empty', 'isEmpty({Customer})', value(false)),
  t(
    'text-to-number-branch',
    'if with text and a date gives text',
    'if({Points} > 1, {Due date}, "none")',
    value('2026-11-02', 'text'),
  ),

  // Durations.
  u(
    'remaining',
    'estimate minus time spent',
    '{Original estimate} - {Time spent}',
    value(23_400, 'duration'),
  ),
  u('scale', 'a duration times a number', '{Time spent} * 2', value(10_800, 'duration')),
  u(
    'ratio',
    'a duration over a duration is a number',
    '{Time spent} / {Original estimate}',
    value(0.1875, 'number'),
  ),
  u(
    'percentage',
    'effort ratio as a percentage',
    '{Time spent} / {Original estimate} * 100',
    value(18.75),
  ),
  u(
    'build',
    'durations from hours and minutes',
    'hours(1.5) + minutes(30)',
    value(7200, 'duration'),
  ),
  u('negate', 'a negative duration', '-{Time spent}', value(-5400)),
  u(
    'abs',
    'abs of a duration',
    'abs({Time spent} - {Original estimate})',
    value(23_400, 'duration'),
  ),
  u('hours', 'a duration in hours', '{Remaining estimate} / hours(1)', value(6)),

  // Empty values (backlog: missing values yield empty, never an error).
  e('field', 'a missing value gives empty', '{Points} * 2', value(null, 'number'), {
    ticket: { Points: null },
  }),
  e('plus', 'also in a sum', '{Points} + 1', value(null), { ticket: { Points: null } }),
  e('null', 'null is empty', 'null', value(null, 'empty')),
  e('sum-skips', 'sum leaves empty values out', 'sum({Points}, 1)', value(1), {
    ticket: { Points: null },
  }),
  e('if-empty', 'ifEmpty gives a fallback', 'ifEmpty({Points}, 0) * 2', value(0), {
    ticket: { Points: null },
  }),
  e('if-empty-kept', 'and keeps a value', 'ifEmpty({Points}, 0) * 2', value(10)),
  e('is-empty', 'isEmpty of a missing value', 'isEmpty({Due date})', value(true), {
    ticket: { 'Due date': null },
  }),
  e('text-missing', 'missing text joins as nothing', '"[" & {Customer} & "]"', value('[]'), {
    ticket: { Customer: null },
  }),
  e(
    'empty-arithmetic-type',
    'null in arithmetic takes the other type',
    'null + {Due date}',
    value(null, 'date'),
  ),

  // What a field stores for each output (spec 01a section 1.4).
  o(
    'number-rounded',
    'numbers keep three decimals',
    '2 / 3',
    { stored: 0.667 },
    { output: 'number' },
  ),
  o(
    'binary-noise',
    'the shortest decimal is kept',
    '0.1 + 0.2',
    { stored: 0.3 },
    { output: 'number' },
  ),
  o(
    'number-range',
    'numbers beyond 10^12 are empty',
    '1e13',
    { stored: null },
    { output: 'number' },
  ),
  o(
    'currency',
    'currency stores a number',
    '{Points} * 12.5',
    { stored: 62.5 },
    { output: 'currency' },
  ),
  o(
    'percentage',
    'percentage stores the percent',
    'round({Time spent} / {Original estimate} * 100, 1)',
    { stored: 18.8 },
    { output: 'percentage', decided: '40 means 40%' },
  ),
  o(
    'date',
    'a date stores as YYYY-MM-DD',
    '{Due date} + 1',
    { stored: '2026-11-03' },
    { output: 'date' },
  ),
  o(
    'date-from-instant',
    'a creation date stores its UTC day',
    '{Created}',
    { stored: '2026-10-01' },
    { output: 'date' },
  ),
  o(
    'duration',
    'durations store whole seconds',
    '{Time spent} / 7',
    { stored: 771 },
    { output: 'duration' },
  ),
  o(
    'text',
    'text stores as written',
    '"Due " & {Due date}',
    { stored: 'Due 2026-11-02' },
    { output: 'text' },
  ),
  o(
    'text-truncated',
    'text keeps 255 characters',
    `"${'x'.repeat(300)}"`,
    { stored: 'x'.repeat(255) },
    {
      output: 'text',
    },
  ),
  o(
    'text-one-line',
    'line breaks become spaces',
    '"line one\nline two"',
    { stored: 'line one line two' },
    {
      output: 'text',
    },
  ),
  o('text-blank', 'blank text is empty', '"   "', { stored: null }, { output: 'text' }),
  o('empty-fits', 'null fits every output', 'null', { stored: null }, { output: 'date' }),
  o(
    'overdue-text',
    'the overdue formula stores its text',
    'if({Due date} < today(), "Overdue", "On time")',
    { stored: 'On time' },
    {
      output: 'text',
    },
  ),

  // Refusals with their place (CORE-011 (3)).
  x(
    'dangling-operator',
    'an operator with nothing after it',
    '{Points} *',
    error('unexpected_end', 10),
  ),
  x(
    'double-operator',
    'two operators in a row',
    '{Points} * * 2',
    error('unexpected_token', 11, 12),
  ),
  x(
    'open-parenthesis',
    'a parenthesis left open points at it',
    '(1 + 2',
    error('unexpected_end', 0, 1),
  ),
  x(
    'stray-parenthesis',
    'a closing parenthesis too many',
    '1 + 2)',
    error('unexpected_token', 5, 6),
  ),
  x(
    'open-field',
    'a field without its closing brace',
    '1 + {Points',
    error('unterminated_field', 4),
  ),
  x('open-text', 'text without its closing quote', '"abc', error('unterminated_string', 0, 4)),
  x('empty-field', 'braces with no name', '{} + 1', error('empty_field', 0, 2)),
  x('unknown-field', 'a field that does not exist', '2 * {Nope}', error('unknown_field', 4, 10)),
  x('ambiguous-field', 'a name several fields share', '{Size}', error('ambiguous_field', 0, 6)),
  x(
    'unsupported-field',
    'a field type formulas cannot read',
    'count({Labels})',
    error('unsupported_field', 6, 14),
  ),
  x(
    'unknown-function',
    'a function that does not exist',
    '1 + foo(1)',
    error('unknown_function', 4, 7),
  ),
  x('arity-few', 'too few arguments', 'round()', error('arity', 0, 7)),
  x('arity-many', 'too many arguments', 'round(1, 2, 3)', error('arity', 0, 14)),
  x('bare-name', 'a field name without braces', 'Points * 2', error('unknown_name', 0, 6)),
  x('number-plus-text', 'a number plus text', '{Points} + "a"', error('type_mismatch', 9, 10)),
  x('text-plus-text', 'text is joined with &, not +', '"a" + "b"', error('type_mismatch', 4, 5)),
  x(
    'date-plus-date',
    'two dates do not add up',
    '{Due date} + {Due date}',
    error('type_mismatch', 11, 12),
  ),
  x('date-times-number', 'dates do not multiply', '{Due date} * 2', error('type_mismatch', 11, 12)),
  x(
    'condition-not-boolean',
    'a condition must be true or false',
    'if({Points}, 1, 2)',
    error('type_mismatch', 3, 11),
  ),
  x(
    'branches-differ',
    'branches of different types',
    'if({Points} > 1, {Due date}, 2)',
    error('type_mismatch', 29, 30),
  ),
  x('compare-null', 'comparing with null', '{Points} > null', error('type_mismatch', 9, 10)),
  x(
    'compare-types',
    'comparing text with a number',
    '{Customer} > 3',
    error('type_mismatch', 11, 12),
  ),
  x('order-booleans', 'true and false have no order', 'true < false', error('type_mismatch', 5, 6)),
  x(
    'sum-children',
    'sum of the children themselves',
    'sum(children)',
    error('type_mismatch', 4, 12),
  ),
  x(
    'children-outside',
    'children outside a roll-up',
    'children.{Points} + 1',
    error('children_misplaced', 0, 17),
  ),
  x('children-alone', 'children alone', 'children', error('children_misplaced', 0, 8)),
  x('sum-of-text', 'a sum of text', 'sum(children.{Customer})', error('type_mismatch', 4, 23)),
  x(
    'mixed-min',
    'min of a number and a date',
    'min({Points}, {Due date})',
    error('type_mismatch', 14, 24),
  ),
  x('number-letters', 'a number running into letters', '2x + 1', error('invalid_number', 0, 2)),
  x('number-dots', 'a number with two points', '1.2.3', error('invalid_number', 0, 5)),
  x(
    'unexpected-character',
    'a character the language does not use',
    '1 # 2',
    error('unexpected_character', 2, 3),
  ),
  x('missing-operator', 'two values side by side', '{Points} 2', error('unexpected_token', 9, 10)),
  x('empty', 'an empty formula', '', error('empty', 0, 0)),
  x('blank', 'a blank formula', '   ', error('empty', 0, 0)),
  x('not-alone', 'not with nothing after it', 'not', error('unexpected_end', 3)),
  x('and-first', 'a formula starting with and', 'and 1', error('unexpected_token', 0, 3)),
  x(
    'children-without-braces',
    'children. needs a field in braces',
    'sum(children.Points)',
    error('unexpected_token', 13, 19),
  ),
  x(
    'output-date-as-number',
    'a date for a number field',
    '{Due date}',
    error('output_mismatch', 0, 10),
    {
      output: 'number',
    },
  ),
  x(
    'output-number-as-text',
    'a number for a text field',
    '{Points}',
    error('output_mismatch', 0, 8),
    {
      output: 'text',
    },
  ),
  x('output-boolean', 'true or false fits no output', '1 = 1', error('output_mismatch', 0, 5), {
    output: 'number',
  }),
  x(
    'output-duration-as-date',
    'a duration for a date field',
    '{Time spent}',
    error('output_mismatch', 0, 12),
    {
      output: 'date',
    },
  ),
  {
    ...x(
      'line-and-column',
      'positions carry line and column',
      '1 +\n  * 2',
      error('unexpected_token', 6, 7),
    ),
    expect: { error: 'unexpected_token', at: 6, end: 7, line: 2, column: 3 },
  },

  // The sandbox's limits.
  l(
    'too-long',
    'at most 4,000 characters',
    `1${' + 1'.repeat(1000)}`,
    error('too_long', 4000, 4001),
  ),
  l(
    'too-deep',
    'at most 64 levels of parentheses',
    `${'('.repeat(70)}1${')'.repeat(70)}`,
    error('too_deep', 64, 65),
  ),
  l('too-deep-signs', 'and of signs', `${'-'.repeat(100)}1`, error('too_deep', 64, 65)),
  l('too-deep-powers', 'and of powers', `2${' ^ 2'.repeat(100)}`, error('too_deep', 256, 257)),
  l('too-complex', 'at most 1,000 parts', `1${'+1'.repeat(600)}`, error('too_complex', 999, 1000)),
  l('deep-enough', '60 levels are fine', `${'('.repeat(60)}1${')'.repeat(60)}`, value(1)),
  l('long-enough', '4,000 characters are fine', `1 +${' '.repeat(3996)}1`, value(2)),
  l(
    'steps',
    'evaluation stops at its step budget',
    '1 + 2 + 3 + 4 + 5',
    { steps: true },
    { maxSteps: 5 },
  ),
  l(
    'steps-children',
    'every child value read is a step',
    'sum(children.{Points})',
    { steps: true },
    {
      maxSteps: 2,
    },
  ),
  l(
    'text-growth',
    'text longer than 10,000 characters is empty',
    `concat(${Array(40).fill('{Summary}').join(', ')})`,
    value(null),
    { ticket: { Summary: 'y'.repeat(255) } },
  ),
  l(
    'text-short-enough',
    'text up to 10,000 characters is kept',
    `len(concat(${Array(39).fill('{Summary}').join(', ')}))`,
    value(9945),
    {
      ticket: { Summary: 'y'.repeat(255) },
    },
  ),
];
