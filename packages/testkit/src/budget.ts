import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { expect } from 'vitest';

/**
 * Speed limits (time budgets) in tests. Every run measures them, but only the benchmark run
 * enforces them: `pnpm bench:check` sets TASKMOOR_ENFORCE_BUDGETS=1. The routine gate checks
 * correctness, and a correct change on a busy laptop can miss a millisecond budget. That was the
 * gate's main source of false failures.
 *
 * Outside the benchmark run, each measurement is appended to `.verify/budgets.jsonl`, and
 * `pnpm verify` says how many budgets this machine missed. A test keeps its other assertions,
 * so "the event arrives" still fails in every run; only "within N ms" waits for the benchmark.
 */
export const ENFORCE_BUDGETS = process.env.TASKMOOR_ENFORCE_BUDGETS === '1';

/** Where measurements go when budgets are not enforced. */
export const BUDGET_LOG = join(process.cwd(), '.verify', 'budgets.jsonl');

export interface BudgetMeasurement {
  what: string;
  measured: number;
  budget: number;
  over: boolean;
  test: string;
}

/** `measured` must be under `budget` (both in the same unit, usually milliseconds). */
export function expectWithinBudget(measured: number, budget: number, what: string): void {
  if (ENFORCE_BUDGETS) {
    expect(measured, `${what}: ${measured.toFixed(1)} against a budget of ${budget}`).toBeLessThan(
      budget,
    );
    return;
  }
  const state = expect.getState();
  const entry: BudgetMeasurement = {
    what,
    measured: Math.round(measured * 10) / 10,
    budget,
    over: measured >= budget,
    test: `${relative(process.cwd(), state.testPath ?? '')} > ${state.currentTestName ?? ''}`,
  };
  try {
    mkdirSync(dirname(BUDGET_LOG), { recursive: true });
    appendFileSync(BUDGET_LOG, `${JSON.stringify(entry)}\n`);
  } catch {
    // The log is a convenience; a read-only checkout loses it and nothing else.
  }
}
