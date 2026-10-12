export { ClaudeAdapter, type ClaudeClientBundle, createClaudeClient } from './adapters/claude';
export { OpenAiCompatibleAdapter } from './adapters/openai-compatible';
export {
  type AiSettings,
  aiSettingsSchema,
  CLAUDE_MODELS,
  type ClaudeModelId,
  DEFAULT_MODEL,
  EFFORTS,
  type Effort,
  type FeatureSettings,
  featureSettingsSchema,
  type ProviderConfig,
  type ProviderId,
  providerConfigSchema,
} from './config';
export { AI_FEATURES, type FeatureId, type ResolvedFeature, resolveFeature } from './features';
export {
  type AdapterRequest,
  type AdapterResponse,
  AiError,
  AiFeatureDisabledError,
  AiGateway,
  AiOutputError,
  AiProviderError,
  type ChatMessage,
  type GenerateRequest,
  type GenerateResult,
  type ProviderAdapter,
  type Usage,
} from './gateway';
export { InMemorySecretStore, redactSecrets, type SecretRef, type SecretStore } from './secrets';
