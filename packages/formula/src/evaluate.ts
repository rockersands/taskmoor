import { dayOfIso, isDay, partsOfDay, workingDaysBetween, workingDaysUntil } from './calendar';
import { LIMITS } from './lexer';
import type { Ir, Op, Program, Scalar, ValueType } from './program';
import { ceilOf, floorOf, formatValue, roundTo } from './values';

/**
 * The evaluator (M1-013; CORE-011): a plain interpreter over the checked tree. It reaches
 * nothing but the values the caller hands it (no globals, no `eval`, no property lookups by
 * name), counts its steps against `LIMITS.steps`, and never throws for a value: a missing
 * value, a division by zero, a number out of range or text grown too long gives empty.
 */
export type ListValue = readonly Scalar[];

export interface EvalInput {
  /** A field of the ticket, by the id its resolver gave; dates as day numbers, durations in seconds. */
  field(id: string): Scalar;
  /** A field's values on the child tickets. */
  children(id: string): ListValue;
  /** How many child tickets there are. */
  childCount(): number;
  /** Today as a day number (days since 1970-01-01, UTC). */
  today: number;
  /** Working days, Monday first. */
  workingWeek: readonly boolean[];
}

export interface EvalOptions {
  maxSteps?: number;
}

export type EvalResult =
  | { ok: true; value: Scalar }
  /** The step budget ran out: the field is left empty. */
  | { ok: false; reason: 'steps' };

class OutOfSteps extends Error {}

const fold = (s: string) => s.normalize('NFKC').toLowerCase();

/** Code point order, as text sorts elsewhere (fields/types.ts `compareText`). */
function compareText(a: string, b: string): number {
  const x = fold(a);
  const y = fold(b);
  if (x === y) return 0;
  const xs = [...x];
  const ys = [...y];
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    const d = (xs[i]?.codePointAt(0) as number) - (ys[i]?.codePointAt(0) as number);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return xs.length < ys.length ? -1 : 1;
}

/** A finite number, or empty; minus zero is zero. */
const finite = (x: number): number | null => (Number.isFinite(x) ? (x === 0 ? 0 : x) : null);
const day = (x: number): number | null => {
  const d = Math.trunc(x);
  return isDay(d) ? d : null;
};

class Evaluator {
  private steps = 0;

  constructor(
    private readonly input: EvalInput,
    private readonly maxSteps: number,
  ) {}

  private step(n = 1) {
    this.steps += n;
    if (this.steps > this.maxSteps) throw new OutOfSteps();
  }

  run(ir: Ir): Scalar {
    this.step();
    switch (ir.k) {
      case 'lit':
        return ir.v;
      case 'ref':
        return this.input.field(ir.id);
      case 'list':
      case 'kids':
        // Lists only stand inside roll-ups, which read them themselves.
        return null;
      case 'op':
        return this.op(ir.op, ir.a, ir.t);
    }
  }

  /** The values an aggregate reads: each argument, or each child's value for a list. */
  private values(args: readonly Ir[]): Scalar[] {
    const out: Scalar[] = [];
    for (const a of args) {
      if (a.k === 'list') {
        const list = this.input.children(a.id);
        this.step(list.length);
        // One by one: spreading a long list into push overflows the stack.
        for (const v of list) out.push(v);
      } else if (a.k === 'kids') {
        const n = this.input.childCount();
        this.step(n);
        for (let i = 0; i < n; i++) out.push(true);
      } else {
        out.push(this.run(a));
      }
    }
    return out;
  }

  private numbers(args: readonly Ir[]): number[] {
    return this.values(args).filter(
      (v): v is number => typeof v === 'number' && Number.isFinite(v),
    );
  }

  private op(op: Op, a: readonly Ir[], t: readonly ValueType[]): Scalar {
    const num = (i: number): number | null => {
      const v = this.run(a[i] as Ir);
      return typeof v === 'number' && Number.isFinite(v) ? v : null;
    };
    const text = (i: number): string | null => {
      const v = this.run(a[i] as Ir);
      return typeof v === 'string' ? v : null;
    };
    const both = (f: (x: number, y: number) => number): number | null => {
      const x = num(0);
      if (x === null) return null;
      const y = num(1);
      return y === null ? null : finite(f(x, y));
    };
    switch (op) {
      case 'add':
        return both((x, y) => x + y);
      case 'sub':
        return both((x, y) => x - y);
      case 'mul':
        return both((x, y) => x * y);
      case 'div':
        return both((x, y) => (y === 0 ? Number.NaN : x / y));
      case 'pow':
        return both((x, y) => x ** y);
      case 'mod':
        return both((x, y) => (y === 0 ? Number.NaN : x - y * Math.floor(x / y)));
      case 'neg': {
        const x = num(0);
        return x === null ? null : x === 0 ? 0 : -x;
      }
      case 'pos':
        return num(0);
      case 'abs': {
        const x = num(0);
        return x === null ? null : Math.abs(x);
      }
      case 'sqrt': {
        const x = num(0);
        return x === null || x < 0 ? null : Math.sqrt(x);
      }
      case 'round': {
        const x = num(0);
        if (x === null) return null;
        const digits = a.length > 1 ? num(1) : 0;
        return digits === null ? null : roundTo(x, digits);
      }
      case 'floor': {
        const x = num(0);
        return x === null ? null : floorOf(x);
      }
      case 'ceil': {
        const x = num(0);
        return x === null ? null : ceilOf(x);
      }
      case 'not': {
        const x = this.run(a[0] as Ir);
        return x === null ? null : !x;
      }
      case 'and': {
        // Empty counts as false, so a condition on a missing value picks the other branch.
        if (this.run(a[0] as Ir) !== true) return false;
        return this.run(a[1] as Ir) === true;
      }
      case 'or':
        if (this.run(a[0] as Ir) === true) return true;
        return this.run(a[1] as Ir) === true;
      case 'eq':
      case 'ne':
      case 'lt':
      case 'le':
      case 'gt':
      case 'ge': {
        const x = this.run(a[0] as Ir);
        const y = this.run(a[1] as Ir);
        // A comparison with an empty value is false, whichever way it asks.
        if (x === null || y === null) return false;
        const c =
          t[0] === 'text'
            ? compareText(String(x), String(y))
            : x === y
              ? 0
              : (x as number) < (y as number)
                ? -1
                : 1;
        return {
          eq: c === 0,
          ne: c !== 0,
          lt: c < 0,
          le: c <= 0,
          gt: c > 0,
          ge: c >= 0,
        }[op];
      }
      case 'join': {
        let out = '';
        for (let i = 0; i < a.length; i++) {
          out += formatValue(this.run(a[i] as Ir), t[i] ?? 'text');
          if (out.length > LIMITS.text) return null;
        }
        return out;
      }
      case 'text':
        return formatValue(this.run(a[0] as Ir), t[0] ?? 'text');
      case 'upper': {
        const s = text(0);
        return s === null ? null : s.toUpperCase().slice(0, LIMITS.text);
      }
      case 'lower': {
        const s = text(0);
        return s === null ? null : s.toLowerCase().slice(0, LIMITS.text);
      }
      case 'len': {
        const s = text(0);
        return s === null ? null : [...s].length;
      }
      case 'if': {
        const c = this.run(a[0] as Ir);
        if (c === true) return this.run(a[1] as Ir);
        return a.length > 2 ? this.run(a[2] as Ir) : null;
      }
      case 'isempty': {
        const x = this.run(a[0] as Ir);
        return x === null || x === '';
      }
      case 'ifempty': {
        const x = this.run(a[0] as Ir);
        return x === null || x === '' ? this.run(a[1] as Ir) : x;
      }
      case 'sum': {
        let total = 0;
        for (const x of this.numbers(a)) total += x;
        return finite(total);
      }
      case 'avg': {
        const xs = this.numbers(a);
        if (xs.length === 0) return null;
        let total = 0;
        for (const x of xs) total += x;
        return finite(total / xs.length);
      }
      case 'min':
      case 'max': {
        const xs = this.numbers(a);
        if (xs.length === 0) return null;
        let best = xs[0] as number;
        for (const x of xs) if (op === 'min' ? x < best : x > best) best = x;
        return best;
      }
      case 'count':
        return this.values(a).filter((v) => v !== null && v !== '').length;
      case 'today':
        return this.input.today;
      case 'date': {
        const v = this.run(a[0] as Ir);
        if (typeof v === 'number') return day(v);
        return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())
          ? dayOfIso(v.trim())
          : null;
      }
      case 'daysbetween':
        return both((x, y) => y - x);
      case 'workingdaysbetween': {
        // Only days of the calendar have working days; a number far outside it has none.
        const x = num(0);
        const y = x === null ? null : num(1);
        return x === null || y === null || !isDay(x) || !isDay(y)
          ? null
          : workingDaysBetween(x, y, this.input.workingWeek);
      }
      case 'workingdaysuntil': {
        const due = num(0);
        return due === null || !isDay(due)
          ? null
          : workingDaysUntil(due, this.input.today, this.input.workingWeek);
      }
      case 'adddays': {
        const d = both((x, y) => x + Math.trunc(y));
        return d === null ? null : day(d);
      }
      case 'year':
      case 'month':
      case 'day':
      case 'weekday': {
        const d = num(0);
        if (d === null || !isDay(d)) return null;
        return partsOfDay(d)[op];
      }
      case 'hours': {
        const x = num(0);
        return x === null ? null : finite(x * 3600);
      }
      case 'minutes': {
        const x = num(0);
        return x === null ? null : finite(x * 60);
      }
    }
  }
}

/**
 * Evaluates a checked formula for one ticket. The value is in run-time form (dates as day
 * numbers); `storedValue` turns it into what the field keeps.
 */
export function evaluate(
  program: Program,
  input: EvalInput,
  options: EvalOptions = {},
): EvalResult {
  const evaluator = new Evaluator(input, options.maxSteps ?? LIMITS.steps);
  try {
    const value = evaluator.run(program.ir);
    if (typeof value === 'number' && !Number.isFinite(value)) return { ok: true, value: null };
    return { ok: true, value };
  } catch (error) {
    if (error instanceof OutOfSteps) return { ok: false, reason: 'steps' };
    throw error;
  }
}
