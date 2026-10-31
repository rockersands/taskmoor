import type { AiNoticeClient, AiNoticeState } from '../ai/AiNotice';
import type { DataStatement } from '../ai/DataStatement';
import type { AiCall, AiLimit, AiUsage, AiUsageClient, UsageTotals } from './AiUsagePage';

const totals = (calls: number, input: number, output: number, costNanos: number): UsageTotals => ({
  calls,
  limited: 0,
  failed: 0,
  unpriced: 0,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costNanos,
});

/** A week of synthetic use: summaries for two people and the system's duplicate checks. */
export const BUSY_MONTH: AiUsage = {
  from: '2026-10-02',
  to: '2026-10-31',
  totals: { ...totals(42, 120_000, 30_000, 1_080_000_000), limited: 3, failed: 1 },
  byDay: [
    { day: '2026-10-30', ...totals(20, 60_000, 15_000, 540_000_000) },
    { day: '2026-10-31', ...totals(22, 60_000, 15_000, 540_000_000) },
  ],
  byFeature: [
    { feature: 'duplicates', ...totals(12, 30_000, 3_000, 180_000_000) },
    { feature: 'summarize', ...totals(30, 90_000, 27_000, 900_000_000) },
  ],
  byPerson: [
    { user: { id: 1, name: 'Ada Lovelace' }, ...totals(25, 80_000, 20_000, 720_000_000) },
    { user: { id: 3, name: 'Grace Hopper' }, ...totals(5, 10_000, 7_000, 180_000_000) },
    { user: null, ...totals(12, 30_000, 3_000, 180_000_000) },
  ],
  byModel: [
    {
      provider: 'anthropic',
      model: 'claude-opus-5-5',
      ...totals(42, 120_000, 30_000, 1_080_000_000),
    },
  ],
};

export const QUIET_MONTH: AiUsage = {
  from: '2026-10-02',
  to: '2026-10-31',
  totals: totals(0, 0, 0, 0),
  byDay: [],
  byFeature: [],
  byPerson: [],
  byModel: [],
};

export const CALLS: AiCall[] = [
  {
    id: 2,
    at: '2026-10-31T14:05:00Z',
    user: { id: 1, name: 'Ada Lovelace' },
    feature: 'summarize',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    outcome: 'limited',
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costNanos: 0,
    priced: true,
    latencyMs: 0,
  },
  {
    id: 1,
    at: '2026-10-31T14:00:00Z',
    user: { id: 1, name: 'Ada Lovelace' },
    feature: 'summarize',
    provider: 'anthropic',
    model: 'claude-opus-5-5',
    outcome: 'ok',
    inputTokens: 3_000,
    outputTokens: 900,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costNanos: 30_000_000,
    priced: true,
    latencyMs: 2_300,
  },
];

export const LIMITS: AiLimit[] = [
  {
    id: 1,
    scope: 'workspace',
    feature: null,
    user: null,
    period: 'month',
    metric: 'cost',
    amount: 50,
    used: 1.08,
    resetsAt: '2026-11-01T00:00:00Z',
  },
  {
    id: 2,
    scope: 'user',
    feature: null,
    user: null,
    period: 'day',
    metric: 'tokens',
    amount: 100_000,
    used: null,
    resetsAt: '2026-11-01T00:00:00Z',
  },
  {
    id: 3,
    scope: 'feature',
    feature: 'summarize',
    user: null,
    period: 'week',
    metric: 'tokens',
    amount: 117_000,
    used: 117_000,
    resetsAt: '2026-11-02T00:00:00Z',
  },
];

export const STATEMENT: DataStatement = {
  configured: true,
  provider: 'bedrock',
  region: 'eu-central-1',
  features: [
    {
      id: 'summarize',
      enabled: true,
      model: 'claude-opus-5-5',
      effort: 'low',
      sends: ['ticket-fields', 'comments'],
    },
    {
      id: 'query-from-text',
      enabled: true,
      model: 'claude-haiku-5-5',
      effort: 'low',
      sends: ['question', 'field-names'],
    },
    {
      id: 'assisted-creation',
      enabled: false,
      model: 'claude-opus-5-5',
      effort: 'medium',
      sends: ['pasted-text', 'track-settings', 'field-names'],
    },
    {
      id: 'duplicates',
      enabled: true,
      model: 'claude-opus-5-5',
      effort: 'low',
      sends: ['ticket-fields', 'candidate-tickets'],
    },
  ],
  redaction: { patterns: ['card-number', 'iban', 'us-ssn'], terms: 2, fields: ['cf[12]'] },
  contentDays: 0,
  neverSent: ['hidden-tickets', 'hidden-fields', 'redacted-fields', 'attachments', 'credentials'],
};

/** An in-memory backend for stories and tests; records the periods asked for. */
export function fakeAiUsageClient(
  usage: AiUsage = BUSY_MONTH,
  options: { limits?: AiLimit[]; statement?: DataStatement; calls?: AiCall[] } = {},
): AiUsageClient & { asked: { from: string; to: string }[] } {
  const asked: { from: string; to: string }[] = [];
  return {
    asked,
    usage: async (from, to) => {
      asked.push({ from, to });
      return structuredClone(usage);
    },
    calls: async () => structuredClone(options.calls ?? (usage.totals.calls ? CALLS : [])),
    limits: async () => structuredClone(options.limits ?? LIMITS),
    statement: async () => structuredClone(options.statement ?? STATEMENT),
  };
}

export function fakeAiNoticeClient(
  acknowledgedAt: string | null = null,
): AiNoticeClient & { acknowledged: number } {
  const { redaction: _r, ...statement } = STATEMENT;
  const state: AiNoticeState = { acknowledgedAt, statement };
  const client = {
    acknowledged: 0,
    notice: async () => structuredClone(state),
    acknowledge: async () => {
      client.acknowledged += 1;
      state.acknowledgedAt = '2026-10-31T12:00:00Z';
    },
  };
  return client;
}
