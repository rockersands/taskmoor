import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type TestInfo } from '@playwright/test';

/**
 * Speed limits in end-to-end tests, as `@taskmoor/testkit/budget` does for Vitest: measured in
 * every run, enforced only when TASKMOOR_ENFORCE_BUDGETS=1 (`pnpm bench:check --e2e`). Outside
 * that run each measurement goes to `.verify/budgets.jsonl` and to the test's annotations.
 */
export const ENFORCE_BUDGETS = process.env.TASKMOOR_ENFORCE_BUDGETS === '1';
const LOG = fileURLToPath(new URL('../../../.verify/budgets.jsonl', import.meta.url));

export function expectWithinBudget(
  testInfo: TestInfo,
  measured: number,
  budget: number,
  what: string,
): void {
  if (ENFORCE_BUDGETS) {
    expect(measured, `${what}: ${measured.toFixed(1)} against a budget of ${budget}`).toBeLessThan(
      budget,
    );
    return;
  }
  const over = measured >= budget;
  testInfo.annotations.push({
    type: 'budget',
    description: `${what}: ${measured.toFixed(1)} (budget ${budget})${over ? ', over' : ''}`,
  });
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(
      LOG,
      `${JSON.stringify({
        what,
        measured: Math.round(measured * 10) / 10,
        budget,
        over,
        test: `${testInfo.titlePath.join(' > ')} [${testInfo.project.name}]`,
      })}\n`,
    );
  } catch {
    // The log is a convenience.
  }
}
