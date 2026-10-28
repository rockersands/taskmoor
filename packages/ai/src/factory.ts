import { ClaudeAdapter, createClaudeClient } from './adapters/claude';
import { OpenAiCompatibleAdapter } from './adapters/openai-compatible';
import type { ProviderConfig } from './config';
import type { SecretStore } from './secrets';
import type { ProviderAdapter } from './types';

export interface AdapterFactoryOptions {
  /** Injected in tests so no request leaves the process. */
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** OpenAI-compatible servers: ask the server what the model supports (default true). */
  detect?: boolean;
  /** Notified when the SDK fallback middleware could not retry a refusal. */
  onFallbackError?: (kind: string) => void;
}

/** Builds the adapter for a configured provider; credentials are read from the secret store. */
export async function createProviderAdapter(
  config: ProviderConfig,
  secrets: SecretStore,
  options: AdapterFactoryOptions = {},
): Promise<ProviderAdapter> {
  if (config.provider === 'openai-compatible') {
    return OpenAiCompatibleAdapter.create(config, secrets, options);
  }
  return new ClaudeAdapter(await createClaudeClient(config, secrets, options));
}
