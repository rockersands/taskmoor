import type { ApiUsageClient, RateLimits, UsageRow } from './ApiUsagePage';

export const LIMITS: RateLimits = {
  token: { rate: 50, burst: 200 },
  user: { rate: 50, burst: 200 },
  address: { rate: 20, burst: 100 },
  ticketWrite: { rate: 10, burst: 40 },
};

/** A busy hour: a nightly sync token that ran into its limit, a person, a script by address. */
export const BUSY_HOUR: UsageRow[] = [
  {
    client: {
      kind: 'token',
      id: '7',
      name: 'Nightly sync',
      owner: { id: 3, name: 'Grace Hopper' },
    },
    requests: 18_240,
    errors: 312,
    throttled: 290,
  },
  {
    client: { kind: 'user', id: '1', name: 'Ada Lovelace', owner: null },
    requests: 1_204,
    errors: 2,
    throttled: 0,
  },
  {
    client: { kind: 'address', id: '203.0.113.9', name: '203.0.113.9', owner: null },
    requests: 96,
    errors: 96,
    throttled: 0,
  },
];

/** An in-memory backend for stories and tests. */
export function fakeApiUsageClient(
  rows: { hour: UsageRow[]; day: UsageRow[] } = { hour: BUSY_HOUR, day: BUSY_HOUR },
): ApiUsageClient & { saved: RateLimits[] } {
  let limits = structuredClone(LIMITS);
  const saved: RateLimits[] = [];
  return {
    saved,
    usage: async (window) => structuredClone(rows[window]),
    limits: async () => structuredClone(limits),
    saveLimits: async (next) => {
      saved.push(structuredClone(next));
      limits = structuredClone(next);
      return structuredClone(limits);
    },
  };
}
