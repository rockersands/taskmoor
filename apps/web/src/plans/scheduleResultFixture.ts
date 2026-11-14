import type { HeldRun } from './ScheduleResult';
import type { ScheduleEntry, ScheduleResult } from './scenarioClient';

const zero = <K extends string>(keys: readonly K[]) =>
  Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/**
 * An auto-schedule run into the scenario "Faster" of the fake plan "Spring launch", for the result
 * panel's stories and tests (ADR-122 stage 7): SHOP-2 and SHOP-3 placed (SHOP-3 after its blocker
 * SHOP-2, and due after its release), OPS-4 kept for a person's draft, SHOP-5 not placed without an
 * estimate, SHOP-6 not placed for a hidden blocker; one earlier proposal removed, one left on a
 * ticket the runner is not shown, and one ticket left out.
 */
export function scheduleRunFixture(overrides: Partial<ScheduleResult> = {}): HeldRun {
  const tickets: ScheduleEntry[] = [
    {
      id: 5,
      key: 'SHOP-5',
      summary: 'Gift wrapping',
      outcome: 'not_placed',
      reason: 'no_estimate',
      args: {},
      warnings: [],
    },
    {
      id: 6,
      key: 'SHOP-6',
      summary: 'Loyalty points',
      outcome: 'not_placed',
      reason: 'hidden_blocker',
      args: {},
      warnings: [],
    },
    {
      id: 3,
      key: 'SHOP-3',
      summary: 'Checkout redesign',
      outcome: 'placed',
      reason: 'after_blocker',
      args: { blockerId: 2, blockerEnd: '2026-11-20' },
      warnings: [
        { kind: 'after_release', args: { releaseId: 21, releaseDate: '2026-11-25', days: 9 } },
      ],
    },
    {
      id: 4,
      key: 'OPS-4',
      summary: 'Warehouse sync',
      outcome: 'kept',
      reason: 'person_draft',
      args: {},
      warnings: [],
    },
    {
      id: 2,
      key: 'SHOP-2',
      summary: 'Cart totals',
      outcome: 'placed',
      reason: 'fits',
      args: {
        teamId: 1,
        periodStart: '2026-11-09',
        periodEnd: '2026-11-20',
        free: 8,
        capacity: 20,
        before: 4,
      },
      warnings: [],
    },
  ];
  return {
    result: {
      scenario: { id: 2, name: 'Faster', main: false, version: 3 },
      created: false,
      from: '2026-11-09',
      periods: [
        { start: '2026-11-09', end: '2026-11-22' },
        { start: '2026-11-23', end: '2026-12-06' },
        { start: '2026-12-07', end: '2026-12-20' },
      ],
      counts: {
        placed: 2,
        already: 0,
        unchanged: 0,
        withdrawn: 1,
        changedMeanwhile: 0,
        kept: {
          ...zero([
            'person_draft',
            'may_not_schedule',
            'kept_by_query',
            'in_progress',
            'in_sprint',
          ] as const),
          person_draft: 1,
        },
        notPlaced: {
          ...zero([
            'no_estimate',
            'no_assignee',
            'no_team',
            'no_capacity',
            'too_big',
            'cycle',
            'hidden_blocker',
            'blocker_undated',
            'blocker_not_placed',
            'no_room',
          ] as const),
          no_estimate: 1,
          hidden_blocker: 1,
        },
        leftOut: { ...zero(['level', 'type', 'release', 'query'] as const), type: 1 },
        warnings: {
          ...zero(['after_release', 'late_against_kept', 'over_where_kept'] as const),
          after_release: 1,
        },
        notShown: 1,
      },
      tickets,
      more: 0,
      names: {
        teams: [{ id: 1, name: 'Atlas' }],
        people: [],
        releases: [{ id: 21, name: '2.1' }],
        tickets: [],
      },
      ...overrides,
    },
    choices: {
      keep: { inProgress: true, inActiveSprint: false },
      leaveOut: { types: ['Bug'], releases: [] },
    },
  };
}
