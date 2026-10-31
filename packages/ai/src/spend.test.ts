import { describe, expect, it } from 'vitest';
import {
  callCost,
  LIST_PRICES,
  limitApplies,
  nanosOf,
  periodWindow,
  priceModelId,
  reachedLimit,
  type SpendLimit,
  totalTokens,
} from './spend';

const opus = LIST_PRICES.find((p) => p.provider === 'anthropic' && p.model === 'claude-opus-5-5');
const haiku = LIST_PRICES.find((p) => p.provider === 'anthropic' && p.model === 'claude-haiku-5-5');

describe('prices and cost (M1-077)', () => {
  it('[OPS-020] prices a call from its token counts and the list price, in exact nanos', () => {
    if (!opus) throw new Error('no list price for Opus');
    // $4 in, $20 out, $0.20 cache read, $5 cache write per million tokens.
    const usage = {
      inputTokens: 1_000,
      outputTokens: 500,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 2_000,
    };
    expect(callCost(usage, opus.price)).toBe(
      1_000 * 4_000 + 500 * 20_000 + 10_000 * 200 + 2_000 * 5_000,
    );
    // Batches cost half, rounded up to a whole nano.
    expect(callCost({ ...usage, outputTokens: 1 }, opus.price, { batch: true })).toBe(
      Math.ceil((1_000 * 4_000 + 20_000 + 10_000 * 200 + 2_000 * 5_000) / 2),
    );
    expect(totalTokens(usage)).toBe(13_500);
    expect(nanosOf(0.1)).toBe(100);
  });

  it('[OPS-020] charges the long-prompt rate above its threshold', () => {
    if (!haiku) throw new Error('no list price for Haiku');
    const short = {
      inputTokens: 100_000,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    };
    expect(callCost(short, haiku.price)).toBe(100_000 * 100 + 10 * 500);
    const long = { ...short, inputTokens: 100_001 };
    expect(callCost(long, haiku.price)).toBe(100_001 * 500 + 10 * 2_500);
  });

  it('[OPS-020] lists first-party prices for the Anthropic API and Foundry, none for Bedrock or Vertex', () => {
    const providers = new Set(LIST_PRICES.map((p) => p.provider));
    expect([...providers].sort()).toEqual(['anthropic', 'foundry']);
    expect(priceModelId('anthropic.claude-opus-5-5')).toBe('claude-opus-5-5');
    expect(priceModelId('eu.anthropic.claude-sonnet-5-5')).toBe('claude-sonnet-5-5');
    expect(priceModelId('claude-haiku-5-5')).toBe('claude-haiku-5-5');
  });
});

describe('spend limits (M1-077)', () => {
  it('[OPS-020] periods are UTC days, ISO weeks from Monday and calendar months', () => {
    const at = new Date('2026-10-31T23:30:00Z'); // a Saturday
    expect(periodWindow('day', at)).toEqual({
      start: new Date('2026-10-31T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
    });
    expect(periodWindow('week', at)).toEqual({
      start: new Date('2026-10-26T00:00:00Z'),
      end: new Date('2026-11-02T00:00:00Z'),
    });
    expect(periodWindow('month', at)).toEqual({
      start: new Date('2026-10-01T00:00:00Z'),
      end: new Date('2026-11-01T00:00:00Z'),
    });
    // A Monday starts its own week.
    expect(periodWindow('week', new Date('2026-11-02T08:00:00Z')).start).toEqual(
      new Date('2026-11-02T00:00:00Z'),
    );
  });

  it('[OPS-020] a limit counts the workspace, its feature, or one person or each person', () => {
    const limit = (over: Partial<SpendLimit>): SpendLimit => ({
      id: 1,
      scope: 'workspace',
      feature: null,
      userId: null,
      period: 'day',
      metric: 'tokens',
      amount: 10,
      ...over,
    });
    const call = { feature: 'summarize', userId: 7 };
    expect(limitApplies(limit({}), call)).toBe(true);
    expect(limitApplies(limit({ scope: 'feature', feature: 'summarize' }), call)).toBe(true);
    expect(limitApplies(limit({ scope: 'feature', feature: 'duplicates' }), call)).toBe(false);
    expect(limitApplies(limit({ scope: 'user' }), call)).toBe(true);
    expect(limitApplies(limit({ scope: 'user', userId: 7 }), call)).toBe(true);
    expect(limitApplies(limit({ scope: 'user', userId: 8 }), call)).toBe(false);
    // The system's own calls have no person.
    expect(limitApplies(limit({ scope: 'user' }), { feature: 'summarize', userId: null })).toBe(
      false,
    );
    const at = new Date('2026-10-31T12:00:00Z');
    expect(reachedLimit([{ limit: limit({}), used: 9 }], at, 7)).toBeNull();
    expect(reachedLimit([{ limit: limit({ scope: 'user' }), used: 10 }], at, 7)).toEqual({
      limitId: 1,
      scope: 'user',
      feature: null,
      userId: 7,
      period: 'day',
      metric: 'tokens',
      amount: 10,
      used: 10,
      resetsAt: '2026-11-01T00:00:00.000Z',
    });
  });
});
