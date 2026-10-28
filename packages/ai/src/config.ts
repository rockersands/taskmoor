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

/** A Claude model ID as the Anthropic API spells it (platform prefixes are added later). */
const claudeModelId = z
  .string()
  .regex(/^claude-[a-z0-9-]+$/, 'a Claude model ID such as claude-opus-5');

/**
 * Model the SDK middleware retries a refused request on, for platforms without server-side
 * fallbacks (Bedrock, Vertex AI, Foundry). Unset means a refusal is reported as is.
 */
const refusalFallbackModel = claudeModelId.optional();

const anthropic = z.object({
  provider: z.literal('anthropic'),
  apiKey: secretRefSchema,
  baseUrl: z.url().optional(),
});

/**
 * Amazon Bedrock through its Messages API endpoint (Mantle). Model IDs carry the `anthropic.`
 * prefix. Authenticates with a Bedrock API key, with access keys, or, when neither is set,
 * with the server's AWS credential chain (instance or task role).
 */
const bedrock = z.object({
  provider: z.literal('bedrock'),
  region: z.string().min(1),
  apiKey: secretRefSchema.optional(),
  accessKeyId: secretRefSchema.optional(),
  secretAccessKey: secretRefSchema.optional(),
  sessionToken: secretRefSchema.optional(),
  refusalFallbackModel,
});

/** Google Cloud Vertex AI. Without an access token the SDK uses application default credentials. */
const vertex = z.object({
  provider: z.literal('vertex'),
  region: z.string().min(1),
  projectId: z.string().min(1),
  accessToken: secretRefSchema.optional(),
  refusalFallbackModel,
});

const foundry = z.object({
  provider: z.literal('foundry'),
  resource: z.string().min(1),
  apiKey: secretRefSchema,
  refusalFallbackModel,
});

/**
 * Ollama, vLLM, LM Studio and other servers that speak the OpenAI chat API. Capabilities not
 * stated here are detected from the server where it says (Ollama), otherwise assumed
 * conservatively: JSON schema output yes, tool calls no.
 */
const openaiCompatible = z.object({
  provider: z.literal('openai-compatible'),
  baseUrl: z.url(),
  apiKey: secretRefSchema.optional(),
  model: z.string().min(1),
  capabilities: z
    .object({ toolCalls: z.boolean().optional(), jsonSchema: z.boolean().optional() })
    .optional(),
});

export const providerConfigSchema = z
  .discriminatedUnion('provider', [anthropic, bedrock, vertex, foundry, openaiCompatible])
  .superRefine((config, ctx) => {
    if (config.provider !== 'bedrock') return;
    if (Boolean(config.accessKeyId) !== Boolean(config.secretAccessKey)) {
      ctx.addIssue({
        code: 'custom',
        path: ['secretAccessKey'],
        message: 'Access key ID and secret access key go together',
      });
    }
    if (config.apiKey && config.accessKeyId) {
      ctx.addIssue({
        code: 'custom',
        path: ['apiKey'],
        message: 'Use either a Bedrock API key or access keys, not both',
      });
    }
    if (config.sessionToken && !config.accessKeyId) {
      ctx.addIssue({
        code: 'custom',
        path: ['sessionToken'],
        message: 'A session token needs access keys',
      });
    }
  });
export type ProviderConfig = z.infer<typeof providerConfigSchema>;
export type ProviderId = ProviderConfig['provider'];
export type ClaudeProviderConfig = Exclude<ProviderConfig, { provider: 'openai-compatible' }>;
export type ClaudeProviderId = ClaudeProviderConfig['provider'];
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
