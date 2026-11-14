import { describe, expect, it } from 'vitest';
import { fakePlanClient } from './fixtures';
import { type FakeScenarioOptions, fakeScenarioClient } from './scenarioFixtures';

/**
 * The fake auto-scheduler honours the run's mode (ADR-122 stage 9), so stories and tests built on
 * it see an even-out answer: over the fake plan, SHOP-2 (5 points) is in progress and kept, and
 * SHOP-3 (8) and OPS-4 (3) end in the second period (16 to 29 Nov), OPS-5 has neither days nor an
 * estimate.
 */
async function evenOut(options: FakeScenarioOptions = {}) {
  const scenarios = fakeScenarioClient(fakePlanClient(), {
    scenarios: [
      {
        name: 'Faster',
        proposals: [{ ticketId: 3, startDate: '2026-11-30', dueDate: '2026-12-11' }],
      },
    ],
    ...options,
  });
  const faster = (await scenarios.list(12)).scenarios[0];
  if (!faster) throw new Error('no scenario');
  const run = await scenarios.schedule(12, {
    into: { scenarioId: faster.id },
    from: '2026-11-04',
    mode: 'even_out',
  });
  if (!run.ok) throw new Error(run.code);
  return { result: run.value, scenarios, faster };
}

describe('the fake auto-scheduler’s Even out load (PLN-011)', () => {
  it('[PLN-011] moves the lowest-ranked ticket of an over period later, keeping its length', async () => {
    const { result } = await evenOut({ capacity: 10 });
    expect(result.mode).toBe('even_out');
    expect(result.overLeft).toEqual([]);
    expect(result.counts).toMatchObject({ placed: 3, already: 2, moved: 1 });
    expect(result.counts.kept.in_progress).toBe(1);
    expect(Object.values(result.counts.notPlaced).every((n) => n === 0)).toBe(true);
    expect(result.tickets[0]).toMatchObject({
      key: 'OPS-4',
      outcome: 'placed',
      reason: 'moved_off_over',
      args: {
        teamId: 3,
        fromPeriod: '2026-11-16',
        fromPeriodEnd: '2026-11-29',
        toPeriod: '2026-11-30',
        toPeriodEnd: '2026-12-13',
        days: 12,
        over: 1,
      },
    });
  });

  it('[PLN-011] lists a ticket with no later room as still over, and the cell left over', async () => {
    const { result } = await evenOut({ capacity: 7 });
    expect(result.tickets.map((t) => [t.key, t.reason])).toEqual([
      ['SHOP-3', 'still_over'],
      ['OPS-4', 'moved_off_over'],
      ['SHOP-2', 'in_progress'],
      ['OPS-5', 'already'],
    ]);
    expect(result.counts.notPlaced).toMatchObject({ still_over: 1, would_make_late: 0 });
    expect(result.overLeft).toEqual([
      {
        teamId: 3,
        periodStart: '2026-11-16',
        periodEnd: '2026-11-29',
        over: 1,
        onlyFixed: false,
      },
    ]);
  });

  it('[PLN-011] [PLN-004] replaces the earlier run’s proposals: a ticket that stays loses its draft', async () => {
    const { result, scenarios, faster } = await evenOut();
    expect(result.counts.moved).toBe(0);
    expect(result.overLeft).toEqual([]);
    const page = await scenarios.changes(12, faster.id);
    expect(page.drafts).toBe(0);
  });
});
