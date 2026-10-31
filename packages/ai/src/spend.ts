import type { ProviderId } from './config';
import type { SpendLimitReached } from './errors';
import type { AdapterRequest, Usage } from './types';

/**
 * Cost tracking and spend limits (M1-077; OPS-020, IAM-021; ADR-100). Taskmoor meters nothing
 * itself: it prices each call from the provider's own token counts and the price table, and
 * refuses calls once an administrator's limit is reached.
 *
 * Prices are kept in billionths of a US dollar per token ("nanos"), so a price per million
 * tokens of $0.10 is 100 and every sum is an exact integer. A price per million tokens in
 * dollars times 1,000 is the price per token in nanos.
 */
export const NANOS_PER_USD = 1_000_000_000;

export interface ModelPrice {
  inputNanos: number;
  outputNanos: number;
  cacheReadNanos: number;
  cacheWriteNanos: number;
  /** A dearer rate for prompts above a size, where the provider charges one. */
  longContext?: { aboveTokens: number; inputNanos: number; outputNanos: number } | undefined;
}

export interface ListPrice {
  provider: ProviderId;
  model: string;
  price: ModelPrice;
}

/** Dollars per million tokens to nanos per token; three decimals of a dollar at most. */
export const nanosOf = (usdPerMillion: number): number => Math.round(usdPerMillion * 1000);
export const usdPerMillionOf = (nanos: number): number => nanos / 1000;

function list(
  usd: { input: number; output: number; cacheRead: number; cacheWrite: number },
  longContext?: { aboveTokens: number; input: number; output: number },
): ModelPrice {
  return {
    inputNanos: nanosOf(usd.input),
    outputNanos: nanosOf(usd.output),
    cacheReadNanos: nanosOf(usd.cacheRead),
    cacheWriteNanos: nanosOf(usd.cacheWrite),
    ...(longContext
      ? {
          longContext: {
            aboveTokens: longContext.aboveTokens,
            inputNanos: nanosOf(longContext.input),
            outputNanos: nanosOf(longContext.output),
          },
        }
      : {}),
  };
}

const CLAUDE_LIST: readonly { model: string; price: ModelPrice }[] = [
  // Spec 02c section 1.3; cache writes at 1.25 times the input rate (five-minute cache).
  {
    model: 'claude-opus-5-5',
    price: list({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }),
  },
  {
    model: 'claude-sonnet-5-5',
    price: list({ input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }),
  },
  {
    model: 'claude-haiku-5-5',
    price: list(
      { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
      { aboveTokens: 100_000, input: 0.5, output: 2.5 },
    ),
  },
  {
    model: 'claude-fable-5-1',
    price: list({ input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }),
  },
];

/**
 * First-party list prices the price table starts from: defaults for an administrator to
 * verify, never authoritative. They apply to the Anthropic API and to Foundry, which bills at
 * the same rates; Bedrock and Vertex AI price separately, so administrators enter their own
 * rates there and calls stay unpriced until they do.
 */
export const LIST_PRICES: readonly ListPrice[] = (['anthropic', 'foundry'] as const).flatMap(
  (provider) => CLAUDE_LIST.map((entry) => ({ provider, ...entry })),
);

/** Batches cost half (spec 02c section 1.3). */
export const BATCH_DISCOUNT = 0.5;

/** Every token the call was billed for: input, output, cache reads and cache writes. */
export function totalTokens(usage: Usage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** What a call cost in nanos, rounded up to a whole nano. */
export function callCost(usage: Usage, price: ModelPrice, options: { batch?: boolean } = {}) {
  const prompt = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  const long = price.longContext && prompt > price.longContext.aboveTokens;
  const input = long && price.longContext ? price.longContext.inputNanos : price.inputNanos;
  const output = long && price.longContext ? price.longContext.outputNanos : price.outputNanos;
  const full =
    usage.inputTokens * input +
    usage.outputTokens * output +
    usage.cacheReadTokens * price.cacheReadNanos +
    usage.cacheWriteTokens * price.cacheWriteNanos;
  return options.batch ? Math.ceil(full * BATCH_DISCOUNT) : full;
}

/**
 * The model ID a price is listed under: Bedrock's `anthropic.` prefix and a cross-region
 * inference prefix (`us.`, `eu.`, `apac.`, `global.`) are dropped.
 */
export function priceModelId(model: string): string {
  return model.replace(/^(?:(?:us|eu|apac|jp|au|global)\.)?anthropic\./, '');
}

export const SPEND_SCOPES = ['workspace', 'feature', 'user'] as const;
export const SPEND_PERIODS = ['day', 'week', 'month'] as const;
export const SPEND_METRICS = ['tokens', 'cost'] as const;
export type SpendScope = (typeof SPEND_SCOPES)[number];
export type SpendPeriod = (typeof SPEND_PERIODS)[number];
export type SpendMetric = (typeof SPEND_METRICS)[number];

/**
 * A hard stop: no call is sent once the usage of its period reaches the amount. `feature`
 * names the feature of a feature limit; `userId` the one person of a user limit, or null for
 * a limit every person has on their own.
 */
export interface SpendLimit {
  id: number | string;
  scope: SpendScope;
  feature: string | null;
  userId: number | null;
  period: SpendPeriod;
  metric: SpendMetric;
  /** Tokens, or nanos for a cost limit. */
  amount: number;
}

/** The period a moment falls in, in UTC: the day, the ISO week from Monday, or the month. */
export function periodWindow(period: SpendPeriod, at: Date): { start: Date; end: Date } {
  const y = at.getUTCFullYear();
  const m = at.getUTCMonth();
  const d = at.getUTCDate();
  if (period === 'month')
    return { start: new Date(Date.UTC(y, m, 1)), end: new Date(Date.UTC(y, m + 1, 1)) };
  if (period === 'week') {
    const back = (at.getUTCDay() + 6) % 7;
    return {
      start: new Date(Date.UTC(y, m, d - back)),
      end: new Date(Date.UTC(y, m, d - back + 7)),
    };
  }
  return { start: new Date(Date.UTC(y, m, d)), end: new Date(Date.UTC(y, m, d + 1)) };
}

/** Whether a limit counts this call: the workspace's, its feature's, or its person's. */
export function limitApplies(
  limit: SpendLimit,
  call: { feature: string; userId: number | null | undefined },
): boolean {
  if (limit.scope === 'workspace') return true;
  if (limit.scope === 'feature') return limit.feature === call.feature;
  if (call.userId === null || call.userId === undefined) return false;
  return limit.userId === null || limit.userId === call.userId;
}

/** The limit a usage figure breaks, if any: the first whose amount is reached. */
export function reachedLimit(
  limits: readonly { limit: SpendLimit; used: number }[],
  at: Date,
  userId: number | null,
): SpendLimitReached | null {
  for (const { limit, used } of limits) {
    if (used < limit.amount) continue;
    return {
      limitId: limit.id,
      scope: limit.scope,
      feature: limit.feature,
      userId: limit.scope === 'user' ? (limit.userId ?? userId) : null,
      period: limit.period,
      metric: limit.metric,
      amount: limit.amount,
      used,
      resetsAt: periodWindow(limit.period, at).end.toISOString(),
    };
  }
  return null;
}

/** Who and what a call is for, as the caller tags it. Nothing here goes to the provider. */
export interface CallTag {
  /** The person the call acts for; null for the system. */
  userId?: number | null;
  trackId?: number | null;
  /** The agent run the call is a step of (M1-131). */
  runId?: string | null;
}

export interface MeteredCall {
  feature: string;
  provider: ProviderId;
  /** The model the feature is set to. */
  model: string;
  mode: 'generate' | 'stream' | 'batch';
  tag: CallTag;
}

export type CallStatus = 'ok' | 'refused' | 'error' | 'aborted' | 'limited';

export interface CallOutcome {
  status: CallStatus;
  usage: Usage;
  /** The model that answered, as the provider spells it; the feature's model when none did. */
  servedModel: string;
  latencyMs: number;
  retries: number;
  fellBack: boolean;
  /** The error's kind for `error` (a provider error kind, or `output`, `policy`, ...). */
  errorKind?: string;
  /** The limit that refused a `limited` call. */
  limit?: SpendLimitReached;
  /**
   * What was sent (after redaction) and the answer text. The meter keeps it only when an
   * administrator turned content logging on (IAM-021); otherwise it is dropped.
   */
  content?: { request: AdapterRequest; answer: string };
}

/**
 * Where the gateway checks limits before a call and books it after (M1-077). `admit` throws
 * `AiSpendLimitError` when a limit is reached; `record` writes one audit row per call,
 * whatever its outcome, including calls `admit` refused.
 */
export interface AiMeter {
  admit(call: MeteredCall): Promise<void>;
  record(call: MeteredCall, outcome: CallOutcome): Promise<void>;
}

export const ZERO_USAGE: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
};
