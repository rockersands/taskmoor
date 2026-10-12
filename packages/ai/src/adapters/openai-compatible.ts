import type { OpenAiCompatibleConfig } from '../config';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../gateway';
import type { SecretStore } from '../secrets';

interface ChatCompletion {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Local and self-hosted models through the OpenAI chat-completions shape (Ollama, vLLM, LM
 * Studio). The configured model is used for every feature; effort has no equivalent here.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly provider = 'openai-compatible' as const;
  readonly secretValues: readonly string[];

  private constructor(
    private readonly config: OpenAiCompatibleConfig,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch,
  ) {
    this.secretValues = apiKey ? [apiKey] : [];
  }

  static async create(
    config: OpenAiCompatibleConfig,
    secrets: SecretStore,
    options: { fetch?: typeof fetch } = {},
  ): Promise<OpenAiCompatibleAdapter> {
    const apiKey = config.apiKey ? await secrets.reveal(config.apiKey) : undefined;
    return new OpenAiCompatibleAdapter(config, apiKey, options.fetch ?? fetch);
  }

  async generate(request: AdapterRequest): Promise<AdapterResponse> {
    const body = {
      model: this.config.model,
      max_tokens: request.maxTokens,
      messages: [{ role: 'system', content: request.system }, ...request.messages],
      ...(request.jsonSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'output', schema: request.jsonSchema, strict: true },
            },
          }
        : {}),
    };
    const response = await this.fetchImpl(
      `${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      },
    );
    if (!response.ok) {
      throw new Error(`${this.config.baseUrl} answered ${response.status} ${response.statusText}`);
    }
    const data = (await response.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    const stopReason = choice?.finish_reason ?? 'unknown';
    return {
      text: choice?.message?.content ?? '',
      stopReason,
      refused: stopReason === 'content_filter',
      model: data.model ?? this.config.model,
      usage: {
        inputTokens: data.usage?.prompt_tokens ?? 0,
        outputTokens: data.usage?.completion_tokens ?? 0,
        cacheReadTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: 0,
      },
    };
  }
}
