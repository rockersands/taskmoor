import { expect } from 'storybook/test';

/**
 * Speed limits in stories, as `@taskmoor/testkit/budget` does for Node tests: measured in every
 * run, enforced only when TASKMOOR_ENFORCE_BUDGETS=1 (`pnpm bench:check`), which the story
 * configs pass into the browser. The browser cannot write the budgets log, so elsewhere the
 * measurement goes unchecked.
 */
export const ENFORCE_BUDGETS = import.meta.env.TASKMOOR_ENFORCE_BUDGETS === '1';

export async function expectWithinBudget(
  measured: number,
  budget: number,
  what: string,
): Promise<void> {
  if (!ENFORCE_BUDGETS) return;
  await expect(measured, `${what}: ${measured.toFixed(1)} against ${budget}`).toBeLessThan(budget);
}
