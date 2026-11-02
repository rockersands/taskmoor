// pnpm eval all --candidate apps/server/src/ai/evals/candidates/live.ts
//
// The AI features of M1-079 against a real provider (ADR-108): queries, summaries (with the
// judge), duplicate re-ranking and the prompt-injection run, all through the product's own
// routes. The key comes from the environment only, never from a file:
//
//   TASKMOOR_AI_EVAL_KEY       an API key with a spend limit (or TASKMOOR_AI_TEST_KEY)
//   TASKMOOR_AI_EVAL_PROVIDER  optional: anthropic (default), openai or gemini (an OpenAI or a
//                              Google AI Studio key, through the OpenAI-compatible adapter)
//   TASKMOOR_AI_EVAL_BASE_URL  optional: another address for the provider's API
//   TASKMOOR_AI_EVAL_MODEL     optional: claude-opus-5-5 (default), claude-sonnet-5-5 or
//                              claude-haiku-5-5; for openai or gemini the provider's model name
//                              (defaults gpt-5 and gemini-2.5-pro)
//
// The thresholds of M1-079 were set for Claude: a run on another provider measures that model
// and records its name in the candidate's name.
//
// Without a key the candidate says it cannot run and the CLI stops: no score is made up.
import {
  type ClaudeModelId,
  createProviderAdapter,
  InMemorySecretStore,
  providerConfigSchema,
  SERVICE_BASE_URLS,
} from '@taskmoor/ai';
import type { EvalCandidate } from '../runner';
import { featureCandidate } from './features';

const key = process.env.TASKMOOR_AI_EVAL_KEY ?? process.env.TASKMOOR_AI_TEST_KEY;
const baseUrl = process.env.TASKMOOR_AI_EVAL_BASE_URL;
const provider = (process.env.TASKMOOR_AI_EVAL_PROVIDER ?? 'anthropic').toLowerCase();
const FEATURES = ['summarize', 'query-from-text', 'assisted-creation', 'duplicates'] as const;
const HOSTED = { openai: 'gpt-5', gemini: 'gemini-2.5-pro' } as const;

function liveCandidate(apiKey: string): EvalCandidate {
  const secrets = () => new InMemorySecretStore({ eval: apiKey });
  if (provider === 'openai' || provider === 'gemini') {
    const model = process.env.TASKMOOR_AI_EVAL_MODEL ?? HOSTED[provider];
    return featureCandidate(
      `live: ${provider} ${model}`,
      () =>
        createProviderAdapter(
          providerConfigSchema.parse({
            provider: 'openai-compatible',
            baseUrl: baseUrl ?? SERVICE_BASE_URLS[provider],
            model,
            apiKey: { secretId: 'eval' },
          }),
          secrets(),
          { timeoutMs: 120_000 },
        ),
      { features: Object.fromEntries(FEATURES.map((f) => [f, { enabled: true }])), judge: true },
    );
  }
  if (provider !== 'anthropic') {
    return {
      name: 'live',
      unavailable: `TASKMOOR_AI_EVAL_PROVIDER is "${provider}"; it takes anthropic, openai or gemini.`,
    };
  }
  const model = (process.env.TASKMOOR_AI_EVAL_MODEL ?? 'claude-opus-5-5') as ClaudeModelId;
  return featureCandidate(
    `live: anthropic ${model}`,
    () =>
      createProviderAdapter(
        providerConfigSchema.parse({
          provider: 'anthropic',
          apiKey: { secretId: 'eval' },
          ...(baseUrl ? { baseUrl } : {}),
        }),
        secrets(),
        { timeoutMs: 120_000 },
      ),
    {
      features: Object.fromEntries(FEATURES.map((f) => [f, { enabled: true, model }])),
      judge: true,
    },
  );
}

export const candidate: EvalCandidate = key
  ? liveCandidate(key)
  : {
      name: 'live',
      unavailable:
        'no AI key in the environment. Set TASKMOOR_AI_EVAL_KEY (an Anthropic, OpenAI or Google AI Studio key with a spend limit; TASKMOOR_AI_EVAL_PROVIDER names which) and run again; the thresholds of M1-079 are measured only with a real model.',
    };

export default candidate;
