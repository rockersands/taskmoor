import { describe, expect, it } from 'vitest';
import {
  CASE_SECTIONS,
  caseFailure,
  FORMULA_CASES,
  type FormulaCase,
  runCase,
  runFormulaConformance,
} from './cases';

/**
 * The formula conformance suite (M1-013 done-when: "100+ case formula suite green"). Each case
 * is data in `cases.ts`; this file runs every one against the package.
 */
function check(c: FormulaCase) {
  const outcome = runCase(c);
  const want = c.expect;
  if ('error' in want) {
    expect(outcome.error, `refusal of ${JSON.stringify(c.formula.slice(0, 80))}`).toBeDefined();
    expect(outcome.error?.code).toBe(want.error);
    expect(outcome.error?.at).toBe(want.at);
    if (want.end !== undefined) expect(outcome.error?.end).toBe(want.end);
    if (want.line !== undefined) expect(outcome.error?.line).toBe(want.line);
    if (want.column !== undefined) expect(outcome.error?.column).toBe(want.column);
    return;
  }
  expect(outcome.error, outcome.error && JSON.stringify(outcome.error)).toBeUndefined();
  if ('steps' in want) {
    expect(outcome.steps).toBe(true);
    return;
  }
  expect(outcome.steps).toBeUndefined();
  if ('stored' in want) {
    expect(outcome.stored).toEqual(want.stored);
    return;
  }
  if (typeof want.value === 'number' && !Number.isInteger(want.value)) {
    expect(outcome.value).toBeCloseTo(want.value, 12);
  } else {
    expect(outcome.value).toEqual(want.value);
  }
  if (want.type !== undefined) expect(outcome.type).toBe(want.type);
}

describe('formula conformance suite (M1-013)', () => {
  it('[CORE-011] has more than 100 cases, in every section, with unique ids', () => {
    expect(FORMULA_CASES.length).toBeGreaterThan(100);
    expect(new Set(FORMULA_CASES.map((c) => c.id)).size).toBe(FORMULA_CASES.length);
    for (const section of CASE_SECTIONS) {
      expect(FORMULA_CASES.filter((c) => c.section === section).length, section).toBeGreaterThan(0);
    }
  });

  for (const section of CASE_SECTIONS) {
    describe(section, () => {
      for (const c of FORMULA_CASES.filter((x) => x.section === section)) {
        it(`[CORE-011] ${c.id}: ${c.title}`, () => {
          check(c);
          expect(caseFailure(c)).toBeNull();
        });
      }
    });
  }

  it('[CORE-011] reports every section in full for pnpm conformance formula', () => {
    const report = runFormulaConformance();
    expect(report).toMatchObject({ total: FORMULA_CASES.length, fail: 0 });
    // A wrong expectation is reported, not hidden.
    const wrong = { ...(FORMULA_CASES[0] as FormulaCase), expect: { value: 11 } };
    expect(caseFailure(wrong)).toBe('expected 11, got 10');
  });
});
