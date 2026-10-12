import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import Anthropic, { type ClientOptions } from '@anthropic-ai/sdk';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { ClaudeProviderConfig, ProviderId } from '../config';
import type { AdapterRequest, AdapterResponse, ProviderAdapter } from '../gateway';
import type { SecretStore } from '../secrets';

/** The four official clients share the Messages API; this is the part the adapter uses. */
export interface ClaudeClient {
  messages: {
    create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

export interface ClaudeClientBundle {
  provider: ProviderId;
  client: ClaudeClient;
  /** Maps a Claude model ID to the platform's spelling (Bedrock adds a prefix). */
  platformModelId(model: string): string;
  secretValues: string[];
}

export interface ClientFactoryOptions {
  /** Injected in tests so no request leaves the process. */
  fetch?: ClientOptions['fetch'];
  timeoutMs?: number;
  maxRetries?: number;
}

/** Builds the official SDK client for a provider, reading credentials from the secret store. */
export async function createClaudeClient(
  config: ClaudeProviderConfig,
  secrets: SecretStore,
  options: ClientFactoryOptions = {},
): Promise<ClaudeClientBundle> {
  const common: Pick<ClientOptions, 'fetch' | 'timeout' | 'maxRetries'> = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.timeoutMs ?? 60_000,
    maxRetries: options.maxRetries ?? 2,
  };
  const identity = (model: string) => model;

  switch (config.provider) {
    case 'anthropic': {
      const apiKey = await secrets.reveal(config.apiKey);
      return {
        provider: 'anthropic',
        client: new Anthropic({ apiKey, baseURL: config.baseUrl ?? null, ...common }),
        platformModelId: identity,
        secretValues: [apiKey],
      };
    }
    case 'bedrock': {
      const awsAccessKey = await secrets.reveal(config.accessKeyId);
      const awsSecretKey = await secrets.reveal(config.secretAccessKey);
      const awsSessionToken = config.sessionToken
        ? await secrets.reveal(config.sessionToken)
        : null;
      return {
        provider: 'bedrock',
        client: new AnthropicBedrock({
          awsRegion: config.region,
          awsAccessKey,
          awsSecretKey,
          awsSessionToken,
          ...common,
        }),
        platformModelId: (model) => `${config.modelPrefix}${model}`,
        secretValues: [awsAccessKey, awsSecretKey, ...(awsSessionToken ? [awsSessionToken] : [])],
      };
    }
    case 'vertex': {
      const accessToken = config.accessToken ? await secrets.reveal(config.accessToken) : null;
      return {
        provider: 'vertex',
        client: new AnthropicVertex({
          region: config.region,
          projectId: config.projectId,
          // A configured token is used as is; otherwise the SDK finds application default
          // credentials (service account file, metadata server).
          ...(accessToken
            ? { authClient: staticTokenAuthClient(config.projectId, accessToken) }
            : {}),
          ...common,
        }),
        platformModelId: identity,
        secretValues: accessToken ? [accessToken] : [],
      };
    }
    case 'foundry': {
      const apiKey = await secrets.reveal(config.apiKey);
      return {
        provider: 'foundry',
        client: new AnthropicFoundry({ resource: config.resource, apiKey, ...common }),
        platformModelId: identity,
        secretValues: [apiKey],
      };
    }
  }
}

type VertexAuthClient = NonNullable<
  NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>['authClient']
>;

/** The subset of google-auth-library's AuthClient that the Vertex SDK calls. */
function staticTokenAuthClient(projectId: string, token: string): VertexAuthClient {
  const client = {
    projectId,
    async getRequestHeaders(): Promise<Headers> {
      return new Headers({ authorization: `Bearer ${token}` });
    },
  };
  return client as unknown as VertexAuthClient;
}

/**
 * Sends requests the same way on every Claude platform: adaptive thinking with an explicit
 * effort, strict structured output when a schema is given, and a cacheable system prompt.
 * Forced tool choice, `budget_tokens` and sampling parameters are never sent; the current
 * models reject them.
 */
export class ClaudeAdapter implements ProviderAdapter {
  constructor(private readonly bundle: ClaudeClientBundle) {}

  get provider(): ProviderId {
    return this.bundle.provider;
  }

  get secretValues(): readonly string[] {
    return this.bundle.secretValues;
  }

  async generate(request: AdapterRequest): Promise<AdapterResponse> {
    const message = await this.bundle.client.messages.create({
      model: this.bundle.platformModelId(request.model),
      max_tokens: request.maxTokens,
      system: [
        {
          type: 'text',
          text: request.system,
          ...(request.cacheSystem ? { cache_control: { type: 'ephemeral' } } : {}),
        },
      ],
      messages: request.messages.map((m) => ({ role: m.role, content: m.content })),
      thinking: { type: 'adaptive' },
      output_config: {
        effort: request.effort,
        ...(request.jsonSchema
          ? { format: { type: 'json_schema', schema: request.jsonSchema } }
          : {}),
      },
    });

    const text = message.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');
    return {
      text,
      stopReason: message.stop_reason ?? 'unknown',
      refused: message.stop_reason === 'refusal',
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
