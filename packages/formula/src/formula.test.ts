import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import {
  dayOfIso,
  isDay,
  isoOfDay,
  MONDAY_TO_FRIDAY,
  workingDaysBetween,
  workingDaysUntil,
  workingWeek,
} from './calendar';
import { caseResolve, FORMULA_CASES } from './cases';
import { compileFormula, FUNCTIONS } from './check';
import { FormulaError } from './errors';
import { type EvalInput, evaluate } from './evaluate';
import { fieldToken } from './lexer';
import { OUTPUT_TYPES, type Program, type Scalar } from './program';
import { rewriteRefs } from './rewrite';
import { roundTo, storedValue, TEXT_OUTPUT_MAX } from './values';

/**
 * The evaluator's own properties (M1-013; CORE-011): arithmetic agrees with a reference, the
 * calendar adds up, stored values always fit their output, and nothing a formula says reaches
 * past the sandbox or throws anything but a refusal.
 */
const compile = (source: string) => {
  const compiled = compileFormula(source, { resolve: caseResolve });
  if (!compiled.ok) throw compiled.error;
  return compiled.program;
};

const input = (values: Record<string, Scalar> = {}, children: Scalar[] = []): EvalInput => ({
  field: (id) => (Object.hasOwn(values, id) ? (values[id] as Scalar) : null),
  children: () => children,
  childCount: () => children.length,
  today: dayOfIso('2026-10-28') as number,
  workingWeek: MONDAY_TO_FRIDAY,
});

const run = (program: Program, values?: Record<string, Scalar>, children?: Scalar[]) => {
  const result = evaluate(program, input(values, children));
  if (!result.ok) throw new Error(result.reason);
  return result.value;
};

/** Expressions over small integers with + - * and parentheses, and their value. */
type Expr = { text: string; value: number };
const expr: fc.Arbitrary<Expr> = fc.letrec<{ e: Expr }>((tie) => ({
  e: fc.oneof(
    { depthSize: 'small', withCrossShrink: true },
    fc.integer({ min: 0, max: 99 }).map((n) => ({ text: String(n), value: n })),
    fc.tuple(tie('e'), fc.constantFrom('+', '-', '*'), tie('e')).map(([l, op, r]) => ({
      text: `(${l.text} ${op} ${r.text})`,
      value: op === '+' ? l.value + r.value : op === '-' ? l.value - r.value : l.value * r.value,
    })),
    tie('e').map((x) => ({ text: `-${x.text}`, value: -x.value })),
  ),
})).e;

describe('formula evaluator (M1-013)', () => {
  it('[CORE-011] agrees with plain arithmetic on random expressions', () => {
    fc.assert(
      fc.property(expr, (e) => {
        const value = run(compile(e.text));
        expect(value).toBe(e.value === 0 ? 0 : e.value);
      }),
    );
  });

  it('[CORE-011] reads the same formula the same way with the parentheses left out where precedence allows', () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom('+', '-', '*', '/'), fc.integer({ min: 1, max: 50 })), {
          maxLength: 12,
        }),
        fc.integer({ min: 1, max: 50 }),
        (rest, first) => {
          const text = `${first}${rest.map(([op, n]) => ` ${op} ${n}`).join('')}`;
          // The reference: products and quotients left to right within each term, then the
          // terms added and subtracted left to right.
          const terms: number[] = [first];
          const signs: number[] = [1];
          for (const [op, n] of rest) {
            const i = terms.length - 1;
            if (op === '*') terms[i] = (terms[i] as number) * n;
            else if (op === '/') terms[i] = (terms[i] as number) / n;
            else {
              terms.push(n);
              signs.push(op === '+' ? 1 : -1);
            }
          }
          const reference = terms.reduce((sum, x, i) => sum + (signs[i] as number) * x, 0);
          const value = run(compile(text));
          expect(value as number).toBeCloseTo(reference, 9);
        },
      ),
    );
  });

  it('[CORE-011] never throws for any text: a refusal with a place, or a program', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (text) => {
        const compiled = compileFormula(text, { resolve: caseResolve });
        if (!compiled.ok) {
          expect(compiled.error).toBeInstanceOf(FormulaError);
          expect(compiled.error.start).toBeGreaterThanOrEqual(0);
          expect(compiled.error.end).toBeGreaterThanOrEqual(compiled.error.start);
          expect(compiled.error.end).toBeLessThanOrEqual(text.length + 1);
        } else {
          expect(evaluate(compiled.program, input()).ok).toBe(true);
        }
      }),
    );
  });

  it('[CORE-011] gives empty, never an error, for any values of the fields it reads', () => {
    const programs = FORMULA_CASES.filter((c) => !('error' in c.expect) && !c.maxSteps).map((c) =>
      compile(c.formula),
    );
    const scalar = fc.oneof(
      fc.constant(null),
      fc.double(),
      fc.integer({ min: -400_000, max: 3_000_000 }),
      fc.string({ maxLength: 20 }),
    );
    fc.assert(
      fc.property(
        fc.constantFrom(...programs),
        fc.dictionary(
          fc.constantFrom(
            'cf[1]',
            'cf[2]',
            'cf[3]',
            'due',
            'start',
            'created',
            'summary',
            'timeSpent',
          ),
          scalar,
        ),
        fc.array(scalar, { maxLength: 5 }),
        (program, values, children) => {
          const result = evaluate(program, input(values, children));
          expect(result.ok).toBe(true);
          if (result.ok && typeof result.value === 'number') {
            expect(Number.isFinite(result.value)).toBe(true);
          }
        },
      ),
    );
  });

  it('[CORE-011] stores only values that fit the output', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...OUTPUT_TYPES),
        fc.oneof(fc.double(), fc.integer(), fc.string({ maxLength: 400 }), fc.constant(null)),
        (output, value) => {
          const stored = storedValue(output, value);
          if (stored === undefined) return;
          switch (output) {
            case 'text':
              expect(typeof stored).toBe('string');
              expect([...(stored as string)].length).toBeLessThanOrEqual(TEXT_OUTPUT_MAX);
              expect(stored).not.toMatch(/[\p{Cc}]/u);
              expect((stored as string).trim()).toBe(stored);
              break;
            case 'date':
              expect(dayOfIso(stored as string)).not.toBeNull();
              break;
            case 'duration':
              expect(Number.isInteger(stored)).toBe(true);
              break;
            default:
              expect(Math.abs(stored as number)).toBeLessThanOrEqual(1e12);
              expect(roundTo(stored as number, 3)).toBe(stored);
          }
        },
      ),
    );
  });

  it('[CORE-011] counts working days consistently: additive, antisymmetric, a week per week', () => {
    const day = fc.integer({ min: -100_000, max: 100_000 });
    const days = fc.integer({ min: 1, max: 700 }).map((n) => n / 100);
    fc.assert(
      fc.property(day, day, day, days, (a, b, c, perWeek) => {
        const week = workingWeek(perWeek);
        expect(workingDaysBetween(a, b, week) + workingDaysBetween(b, c, week)).toBe(
          workingDaysBetween(a, c, week),
        );
        expect(workingDaysBetween(a, b, week)).toBe(-workingDaysBetween(b, a, week) || 0);
        expect(workingDaysBetween(a, a + 7, week)).toBe(week.filter(Boolean).length);
        // Overdue exactly when the due date has passed (CORE-011 (2)).
        expect(workingDaysUntil(a, b, week) < 0).toBe(a < b);
      }),
    );
  });

  it('[CORE-011] reads and writes every day between 1000 and 9999', () => {
    fc.assert(
      fc.property(fc.integer({ min: -354_285, max: 2_932_896 }), (d) => {
        expect(isDay(d)).toBe(true);
        expect(dayOfIso(isoOfDay(d))).toBe(d);
      }),
    );
    expect(dayOfIso('2026-10-28T23:30:00-02:00')).toBe(dayOfIso('2026-10-29'));
    expect(dayOfIso('0999-12-31')).toBeNull();
  });

  it('[CORE-011] rewrites field references and keeps everything else as written', () => {
    const source = 'if( {points}>1 ,  {Due date}, {due DATE} + 1 ) ';
    const program = compileFormula(source, { resolve: caseResolve });
    expect(program.ok).toBe(true);
    if (!program.ok) return;
    const stored = rewriteRefs(source, program.program.refs, (r) => fieldToken(r.id));
    expect(stored).toBe('if( {cf[1]}>1 ,  {due}, {due} + 1 ) ');
    // Names with braces or backslashes are escaped and read back.
    const odd = 'a}b\\c{d';
    const back = compileFormula(`${fieldToken(odd)} + 1`, {
      resolve: (name) =>
        name === odd ? { id: 'x', type: 'number' } : { problem: 'unknown_field' },
    });
    expect(back.ok).toBe(true);
  });

  it('[CORE-011] reaches nothing outside the sandbox: no prototype names, no globals', () => {
    for (const name of [
      'constructor',
      'toString',
      'hasOwnProperty',
      '__proto__',
      'valueOf',
      'eval',
      'Function',
      'require',
      'process',
    ]) {
      const compiled = compileFormula(`${name}(1)`, { resolve: caseResolve });
      expect(compiled.ok, name).toBe(false);
      if (!compiled.ok) expect(compiled.error.code).toBe('unknown_function');
      expect(Object.hasOwn(FUNCTIONS, name.toLowerCase())).toBe(false);
    }
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      const compiled = compileFormula(`{${name}}`, { resolve: caseResolve });
      expect(compiled.ok).toBe(false);
      if (!compiled.ok) expect(compiled.error.code).toBe('unknown_field');
    }
    // The evaluator only asks the input for ids the checker resolved.
    const asked: string[] = [];
    const program = compile('{Points} + sum(children.{Effort}) + count(children)');
    evaluate(program, {
      ...input(),
      field: (id) => {
        asked.push(id);
        return 1;
      },
      children: (id) => {
        asked.push(`children.${id}`);
        return [1, 2];
      },
    });
    expect(asked).toEqual(['cf[1]', 'children.cf[2]']);
  });

  it('[CORE-011] a number far outside the calendar has no working days, and is answered at once', () => {
    // A date field holding a number far past the calendar once made the day count loop for ever.
    const until = compile('workingDaysUntil({Due date})');
    const between = compile('workingDaysBetween({Start date}, {Due date})');
    const start = dayOfIso('2026-10-26') as number;
    expect(run(until, { due: dayOfIso('2026-11-02') as number })).toBe(3);
    expect(run(until, { due: 1e300 })).toBeNull();
    expect(run(between, { start, due: -1e300 })).toBeNull();
    expect(run(between, { start: 2.5, due: start })).toBeNull();
    // The calendar itself stays bounded for any number.
    expect(Number.isFinite(workingDaysBetween(0, 1e300, MONDAY_TO_FRIDAY))).toBe(true);
  });

  it('[CORE-011] marks formulas that read the date or the working week, and roll-ups', () => {
    expect(compile('{Points} * 2')).toMatchObject({
      volatile: false,
      workingWeek: false,
      readsChildren: false,
    });
    expect(compile('workingDaysUntil({Due date})')).toMatchObject({
      volatile: true,
      workingWeek: true,
    });
    expect(compile('workingDaysBetween({Start date}, {Due date})')).toMatchObject({
      volatile: false,
      workingWeek: true,
    });
    expect(compile('daysBetween(today(), {Due date})').volatile).toBe(true);
    const rollup = compile('{Points} + sum(children.{Effort}) + count(children)');
    expect(rollup.readsChildren).toBe(true);
    expect(rollup.refs.map((r) => r.id)).toEqual(['cf[1]']);
    expect(rollup.childRefs.map((r) => r.id)).toEqual(['cf[2]']);
  });

  it('[CORE-011] evaluates a large roll-up within the step budget and stops past it', () => {
    const program = compile('sum(children.{Points})');
    const many = Array.from({ length: 200_000 }, (_, i) => i % 7);
    const started = performance.now();
    expect(run(program, {}, many)).toBe(many.reduce((a, b) => (a as number) + (b as number), 0));
    expect(performance.now() - started).toBeLessThan(1000);
    const result = evaluate(program, input({}, many), { maxSteps: 1000 });
    expect(result).toEqual({ ok: false, reason: 'steps' });
  });
});
