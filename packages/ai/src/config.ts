import { z } from 'zod';
import { secretRefSchema } from './secrets';

/** Claude models an administrator may choose. Exact IDs; no date suffixes. */
export const CLAUDE_MODELS = [
  'claude-opus-5-5',
  'claude-sonnet-5-5',
  'claude-haiku-5-5',
  'claude-fable-5-1',
] as const;
export type ClaudeModelId = (typeof CLAUDE_MODELS)[number];
export const DEFAULT_MODEL: ClaudeModelId = 'claude-opus-5-5';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

const anthropic = z.object({
  provider: z.literal('anthropic'),
  apiKey: secretRefSchema,
  baseUrl: z.url().optional(),
});

/** Amazon Bedrock. Model IDs carry a provider prefix; `global.`/`us.`/`eu.` select an inference profile. */
const bedrock = z.object({
  provider: z.literal('bedrock'),
  region: z.string().min(1),
  accessKeyId: secretRefSchema,
  secretAccessKey: secretRefSchema,
  sessionToken: secretRefSchema.optional(),
  modelPrefix: z
    .enum(['anthropic.', 'global.anthropic.', 'us.anthropic.', 'eu.anthropic.', 'apac.anthropic.'])
    .default('anthropic.'),
});

/** Google Cloud Vertex AI. Without an access token the SDK uses application default credentials. */
const vertex = z.object({
  provider: z.literal('vertex'),
  region: z.string().min(1),
  projectId: z.string().min(1),
  accessToken: secretRefSchema.optional(),
});

const foundry = z.object({
  provider: z.literal('foundry'),
  resource: z.string().min(1),
  apiKey: secretRefSchema,
});

/** Ollama, vLLM, LM Studio and other servers that speak the OpenAI chat API. */
const openaiCompatible = z.object({
  provider: z.literal('openai-compatible'),
  baseUrl: z.url(),
  apiKey: secretRefSchema.optional(),
  model: z.string().min(1),
});

export const providerConfigSchema = z.discriminatedUnion('provider', [
  anthropic,
  bedrock,
  vertex,
  foundry,
  openaiCompatible,
]);
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderId = ProviderConfig['provider'];
export type ClaudeProviderConfig = Exclude<ProviderConfig, { provider: 'openai-compatible' }>;
export type OpenAiCompatibleConfig = Extract<ProviderConfig, { provider: 'openai-compatible' }>;

/** Per-feature overrides an administrator may set; anything omitted uses the feature's default. */
export const featureSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.enum(CLAUDE_MODELS).optional(),
  effort: z.enum(EFFORTS).optional(),
});
export type FeatureSettings = z.infer<typeof featureSettingsSchema>;

export const aiSettingsSchema = z.object({
  provider: providerConfigSchema.nullable().default(null),
  features: z.record(z.string(), featureSettingsSchema).default({}),
});
export type AiSettings = z.infer<typeof aiSettingsSchema>;
