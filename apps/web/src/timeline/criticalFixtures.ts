import type { PlanClient, PlanCriticalPath } from '../plans/client';

/**
 * The critical path the server gives for the fixture plan (`planItems`, PLN-011): SHOP-3 ends the
 * plan on 20 Nov; SHOP-2 blocks it but ends after it starts, so a dependency on the path is two
 * days late; OPS-4 has two days of slack; OPS-5 has no dates, and OPS-4 waits for work outside.
 */
export const criticalPathFixture = (): PlanCriticalPath => ({
  planEnd: '2026-11-20',
  chains: [
    {
      tickets: [
        {
          id: 2,
          key: 'SHOP-2',
          summary: 'Build the shop page',
          start: '2026-11-02',
          end: '2026-11-10',
          slack: -2,
        },
        {
          id: 3,
          key: 'SHOP-3',
          summary: 'Take payments',
          start: '2026-11-09',
          end: '2026-11-20',
          slack: 0,
        },
      ],
    },
  ],
  more: 0,
  counts: { critical: 2, cycles: 0, undated: 1, waitsElsewhere: 1 },
  listed: [
    { id: 2, slack: -2 },
    { id: 3, slack: 0 },
    { id: 4, slack: 2 },
  ],
});

/** A plan client that also reads the critical path, and records what each read asked. */
export function withCriticalPath<C extends PlanClient>(
  client: C,
  answer: () => Promise<PlanCriticalPath> = async () => criticalPathFixture(),
): C & { pathReads: { filters: object; scenario: number | undefined }[] } {
  const pathReads: { filters: object; scenario: number | undefined }[] = [];
  return Object.assign(client, {
    pathReads,
    criticalPath: (_id: number, filters: object, scenario?: number) => {
      pathReads.push({ filters, scenario });
      return answer();
    },
  });
}
