import type { AiLimitsClient, AiPrice, StoredLimit } from './AiLimitsPage';

/** Synthetic limits: everyone together this month, and each person per day. */
export const LIMITS: StoredLimit[] = [
  {
    id: 1,
    scope: 'workspace',
    feature: null,
    user: null,
    period: 'month',
    metric: 'tokens',
    amount: 200_000,
    used: 1_200,
    resetsAt: '2026-12-01T00:00:00.000Z',
    alertPercents: [80, 100],
  },
  {
    id: 2,
    scope: 'user',
    feature: null,
    user: null,
    period: 'day',
    metric: 'tokens',
    amount: 200_000,
    used: null,
    resetsAt: '2026-11-04T00:00:00.000Z',
    alertPercents: [100],
  },
];

/** Synthetic rates, not any provider's real prices. */
export const PRICES: AiPrice[] = [
  {
    provider: 'anthropic',
    model: 'claude-example',
    source: 'list',
    input: 1,
    output: 5,
    cacheRead: 0.1,
    cacheWrite: 1.25,
    longContext: { aboveTokens: 100_000, input: 2, output: 10 },
  },
  {
    provider: 'bedrock',
    model: 'claude-other',
    source: 'admin',
    input: 3,
    output: 15,
    cacheRead: 0.3,
    cacheWrite: 3.75,
    longContext: null,
  },
];

/** Limits and prices in memory. */
export function fakeAiLimitsClient(
  limits: StoredLimit[] = LIMITS,
  prices: AiPrice[] = PRICES,
): AiLimitsClient & { calls: { action: string; args: unknown[] }[] } {
  const calls: { action: string; args: unknown[] }[] = [];
  let storedLimits = structuredClone(limits);
  let storedPrices = structuredClone(prices);
  let next = 10;
  const log = (action: string, ...args: unknown[]) => calls.push({ action, args });
  return {
    calls,
    limits: async () => structuredClone(storedLimits),
    createLimit: async (input) => {
      log('createLimit', input);
      storedLimits.push({
        ...input,
        id: next++,
        user: input.userId ? { id: input.userId, name: 'Noor Haddad' } : null,
        used: input.scope === 'user' && !input.userId ? null : 0,
        resetsAt: '2026-12-01T00:00:00.000Z',
      });
    },
    updateLimit: async (id, input) => {
      log('updateLimit', id, input);
      storedLimits = storedLimits.map((l) => (l.id === id ? { ...l, ...input } : l));
    },
    deleteLimit: async (id) => {
      log('deleteLimit', id);
      storedLimits = storedLimits.filter((l) => l.id !== id);
    },
    prices: async () => structuredClone(storedPrices),
    setPrice: async (price) => {
      log('setPrice', price);
      const key = (p: AiPrice) => p.provider === price.provider && p.model === price.model;
      storedPrices = storedPrices.some(key)
        ? storedPrices.map((p) => (key(p) ? { ...price, source: 'admin' } : p))
        : [...storedPrices, { ...price, source: 'admin' }];
    },
    resetPrice: async (provider, model) => {
      log('resetPrice', provider, model);
      storedPrices = storedPrices.map((p) =>
        p.provider === provider && p.model === model ? { ...p, source: 'list' } : p,
      );
    },
    findPeople: async (query) =>
      [{ id: 8, name: 'Noor Haddad' }].filter((p) =>
        p.name.toLowerCase().includes(query.toLowerCase()),
      ),
  };
}
