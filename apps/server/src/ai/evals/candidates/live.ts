// pnpm eval all --candidate apps/server/src/ai/evals/candidates/live.ts
//
// The AI features of M1-079 against a real provider (ADR-108): queries, summaries (with the
// judge), duplicate re-ranking and the prompt-injection run, all through the product's own
// routes. The key comes from the environment only, never from a file:
//
//   TASKMOOR_AI_EVAL_KEY      an Anthropic API key with a spend limit (or TASKMOOR_AI_TEST_KEY)
//   TASKMOOR_AI_EVAL_BASE_URL optional: another address for the Anthropic API
//   TASKMOOR_AI_EVAL_MODEL    optional: claude-opus-5-5 (default), claude-sonnet-5-5, claude-haiku-5-5
//
// Without a key the candidate says it cannot run and the CLI stops: no score is made up.
import {
  type ClaudeModelId,
  createProviderAdapter,
  InMemorySecretStore,
  providerConfigSchema,
} from '@taskmoor/ai';
import type { EvalCandidate } from '../runner';
import { featureCandidate } from './features';

const key = process.env.TASKMOOR_AI_EVAL_KEY ?? process.env.TASKMOOR_AI_TEST_KEY;
const baseUrl = process.env.TASKMOOR_AI_EVAL_BASE_URL;
const model = (process.env.TASKMOOR_AI_EVAL_MODEL ?? 'claude-opus-5-5') as ClaudeModelId;
const FEATURES = ['summarize', 'query-from-text', 'assisted-creation', 'duplicates'] as const;

export const candidate: EvalCandidate = key
  ? featureCandidate(
      `live: anthropic ${model}`,
      () =>
        createProviderAdapter(
          providerConfigSchema.parse({
            provider: 'anthropic',
            apiKey: { secretId: 'eval' },
            ...(baseUrl ? { baseUrl } : {}),
          }),
          new InMemorySecretStore({ eval: key }),
          { timeoutMs: 120_000 },
        ),
      {
        features: Object.fromEntries(FEATURES.map((f) => [f, { enabled: true, model }])),
        judge: true,
      },
    )
  : {
      name: 'live',
      unavailable:
        'no AI key in the environment. Set TASKMOOR_AI_EVAL_KEY (an Anthropic API key with a spend limit) and run again; the thresholds of M1-079 are measured only with a real model.',
    };

export default candidate;
