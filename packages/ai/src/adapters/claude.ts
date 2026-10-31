import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { AnthropicFoundry } from '@anthropic-ai/foundry-sdk';
import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
  BetaFallbackState,
  betaRefusalFallbackMiddleware,
  type ClientOptions,
} from '@anthropic-ai/sdk';
import type { BetaMessageStream } from '@anthropic-ai/sdk/lib/BetaMessageStream';
import type { BetaMessage } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type {
  MessageCountTokensParams,
  MessageTokensCount,
} from '@anthropic-ai/sdk/resources/messages/messages';
import { AnthropicVertex } from '@anthropic-ai/vertex-sdk';
import type { ClaudeProviderConfig, ClaudeProviderId, ProviderId } from '../config';
import { AiUnsupportedError, kindForHttpStatus } from '../errors';
import { SERVER_FALLBACK_MODELS, TASK_BUDGET_MODELS } from '../policy';
import { retryAfterFromHeaders, shouldRetryFromHeaders } from '../retry';
import type { SecretStore } from '../secrets';
import type {
  AdapterRequest,
  AdapterResponse,
  BatchAdapter,
  CallOptions,
  ErrorClassification,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderErrorKind,
  StreamCallOptions,
} from '../types';
import { ClaudeBatches } from './claude-batches';
import { buildClaudeParams, type ClaudeParams, fromClaudeMessage } from './claude-request';

interface ClaudeRequestOptions {
  signal?: AbortSignal;
  fallbackState?: BetaFallbackState;
}

/** The part of the four official clients the adapter uses; they share the Messages API. */
export interface ClaudeClient {
  beta: {
    messages: {
      create(params: ClaudeParams, options?: ClaudeRequestOptions): Promise<BetaMessage>;
      stream(params: ClaudeParams, options?: ClaudeRequestOptions): BetaMessageStream;
    };
  };
  messages: {
    countTokens(
      params: MessageCountTokensParams,
      options?: ClaudeRequestOptions,
    ): Promise<MessageTokensCount>;
  };
}

export interface ClaudeClientBundle {
  provider: ClaudeProviderId;
  client: ClaudeClient;
  /** Maps a Claude model ID to the platform's spelling (Bedrock adds `anthropic.`). */
  platformModelId(model: string): string;
  secretValues: string[];
  /** How a refusal is retried on another model: by the API, by SDK middleware, or not at all. */
  refusalFallback: 'server' | 'client' | 'none';
  /** The first-party client, for what only the Anthropic API offers (batches, model listing). */
  firstParty?: Anthropic;
}

export interface ClientFactoryOptions {
  /** Injected in tests so no request leaves the process. */
  fetch?: ClientOptions['fetch'];
  timeoutMs?: number;
  /** Notified when the SDK fallback middleware could not retry a refusal. */
  onFallbackError?: (kind: string) => void;
}

/** Builds the official SDK client for a provider, reading credentials from the secret store. */
export async function createClaudeClient(
  config: ClaudeProviderConfig,
  secrets: SecretStore,
  options: ClientFactoryOptions = {},
): Promise<ClaudeClientBundle> {
  // The gateway owns retries (typed, logged, with a circuit breaker), so the SDK makes one
  // attempt. The SDK's own logging stays off: it could print request headers.
  const common = {
    ...(options.fetch ? { fetch: options.fetch } : {}),
    timeout: options.timeoutMs ?? 600_000,
    maxRetries: 0,
    logLevel: 'off' as const,
  };
  const identity = (model: string) => model;
  const clientSide = (platformModelId: (model: string) => string) => {
    if (config.provider === 'anthropic' || !config.refusalFallbackModel) return {};
    return {
      middleware: [
        betaRefusalFallbackMiddleware([{ model: platformModelId(config.refusalFallbackModel) }], {
          onError: (error) => options.onFallbackError?.(error.kind),
        }),
      ],
    };
  };
  const refusalFallback =
    config.provider === 'anthropic' ? 'server' : config.refusalFallbackModel ? 'client' : 'none';

  switch (config.provider) {
    case 'anthropic': {
      const apiKey = await secrets.reveal(config.apiKey);
      const client = new Anthropic({
        apiKey,
        authToken: null,
        baseURL: config.baseUrl ?? null,
        ...common,
      });
      return {
        provider: 'anthropic',
        client,
        platformModelId: identity,
        secretValues: [apiKey],
        refusalFallback,
        firstParty: client,
      };
    }
    case 'bedrock': {
      const apiKey = config.apiKey ? await secrets.reveal(config.apiKey) : undefined;
      const awsAccessKey = config.accessKeyId ? await secrets.reveal(config.accessKeyId) : null;
      const awsSecretAccessKey = config.secretAccessKey
        ? await secrets.reveal(config.secretAccessKey)
        : null;
      const awsSessionToken = config.sessionToken
        ? await secrets.reveal(config.sessionToken)
        : null;
      const platformModelId = (model: string) => `anthropic.${model}`;
      return {
        provider: 'bedrock',
        client: new AnthropicBedrockMantle({
          awsRegion: config.region,
          ...(apiKey ? { apiKey } : { awsAccessKey, awsSecretAccessKey, awsSessionToken }),
          ...common,
          ...clientSide(platformModelId),
        }),
        platformModelId,
        secretValues: [apiKey, awsAccessKey, awsSecretAccessKey, awsSessionToken].filter(
          (value): value is string => typeof value === 'string',
        ),
        refusalFallback,
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
          ...clientSide(identity),
        }),
        platformModelId: identity,
        secretValues: accessToken ? [accessToken] : [],
        refusalFallback,
      };
    }
    case 'foundry': {
      const apiKey = await secrets.reveal(config.apiKey);
      return {
        provider: 'foundry',
        client: new AnthropicFoundry({
          resource: config.resource,
          apiKey,
          ...common,
          ...clientSide(identity),
        }),
        platformModelId: identity,
        secretValues: [apiKey],
        refusalFallback,
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

/** Error `type` values from the API's error body, for errors that arrive mid-stream. */
function kindForErrorType(type: unknown): ProviderErrorKind {
  switch (type) {
    case 'overloaded_error':
      return 'overloaded';
    case 'rate_limit_error':
      return 'rate_limited';
    case 'api_error':
      return 'server';
    case 'timeout_error':
      return 'timeout';
    case 'invalid_request_error':
      return 'invalid_request';
    case 'authentication_error':
      return 'authentication';
    case 'permission_error':
      return 'permission';
    case 'not_found_error':
      return 'not_found';
    case 'request_too_large':
      return 'request_too_large';
    default:
      return 'unknown';
  }
}

/** Reads the SDK's typed errors; never string-matches messages. */
export function classifyClaudeError(error: unknown): ErrorClassification {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof APIUserAbortError) return { kind: 'aborted', message };
  if (error instanceof APIConnectionTimeoutError) return { kind: 'timeout', message };
  if (error instanceof APIConnectionError) return { kind: 'connection', message };
  if (error instanceof APIError) {
    const headers = error.headers instanceof Headers ? error.headers : undefined;
    const body = error.error as { error?: { type?: unknown } } | undefined;
    const kind =
      typeof error.status === 'number'
        ? kindForHttpStatus(error.status)
        : kindForErrorType(body?.error?.type);
    const retryAfterMs = retryAfterFromHeaders(headers);
    const shouldRetry = shouldRetryFromHeaders(headers);
    return {
      kind,
      message,
      ...(typeof error.status === 'number' ? { status: error.status } : {}),
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      ...(shouldRetry !== undefined ? { shouldRetry } : {}),
    };
  }
  return { kind: 'unknown', message };
}

/**
 * Claude on the Anthropic API, Amazon Bedrock, Google Cloud Vertex AI and Microsoft Foundry.
 * Requests are built once (`buildClaudeParams`) and checked against the request policy;
 * only client construction and model spelling differ per platform.
 */
export class ClaudeAdapter implements ProviderAdapter {
  readonly batches: BatchAdapter | undefined;

  constructor(private readonly bundle: ClaudeClientBundle) {
    this.batches = bundle.firstParty
      ? new ClaudeBatches(bundle.firstParty, (request) => this.params(request, false))
      : undefined;
  }

  get provider(): ProviderId {
    return this.bundle.provider;
  }

  get secretValues(): readonly string[] {
    return this.bundle.secretValues;
  }

  capabilities(model: string): ModelCapabilities {
    const firstParty = this.bundle.provider === 'anthropic';
    return {
      streaming: true,
      structuredOutput: true,
      toolCalls: true,
      strictTools: true,
      effort: true,
      promptCaching: true,
      tokenCounting: true,
      modelListing: firstParty,
      batches: firstParty,
      taskBudget: firstParty && TASK_BUDGET_MODELS.has(model),
      refusalFallback:
        this.bundle.refusalFallback === 'server'
          ? SERVER_FALLBACK_MODELS.has(model)
            ? 'server'
            : 'none'
          : this.bundle.refusalFallback,
    };
  }

  /** `serverFallback` is off for batches, which reject the parameter. */
  private params(request: AdapterRequest, allowFallback = true): ClaudeParams {
    return buildClaudeParams(request, {
      model: this.bundle.platformModelId(request.model),
      serverFallback:
        allowFallback && this.capabilities(request.model).refusalFallback === 'server',
    });
  }

  private requestOptions(options: CallOptions | undefined): ClaudeRequestOptions {
    return {
      ...(options?.signal ? { signal: options.signal } : {}),
      // One state per call: the middleware pins only within it.
      ...(this.bundle.refusalFallback === 'client'
        ? { fallbackState: new BetaFallbackState() }
        : {}),
    };
  }

  async generate(request: AdapterRequest, options?: CallOptions): Promise<AdapterResponse> {
    const message = await this.bundle.client.beta.messages.create(
      this.params(request),
      this.requestOptions(options),
    );
    return fromClaudeMessage(message);
  }

  async stream(request: AdapterRequest, options: StreamCallOptions): Promise<AdapterResponse> {
    const stream = this.bundle.client.beta.messages.stream(
      this.params(request),
      this.requestOptions(options),
    );
    stream.on('text', (delta) => options.onText(delta));
    return fromClaudeMessage(await stream.finalMessage());
  }

  async countTokens(request: AdapterRequest, options?: CallOptions): Promise<number> {
    // The task budget belongs to the run, not to the count: the count leaves it out.
    const { taskBudget: _budget, ...unbudgeted } = request;
    const {
      max_tokens: _max,
      betas: _betas,
      fallbacks: _fallbacks,
      ...rest
    } = this.params(unbudgeted, false);
    // The generally available endpoint: same body, no beta header.
    const counted = await this.bundle.client.messages.countTokens(
      rest as unknown as MessageCountTokensParams,
      options?.signal ? { signal: options.signal } : {},
    );
    return counted.input_tokens;
  }

  async listModels(options?: CallOptions): Promise<ModelInfo[]> {
    const client = this.bundle.firstParty;
    if (!client) throw new AiUnsupportedError(this.provider, 'modelListing');
    const models: ModelInfo[] = [];
    for await (const model of client.models.list(
      {},
      options?.signal ? { signal: options.signal } : {},
    )) {
      models.push({
        id: model.id,
        displayName: model.display_name,
        ...(model.max_input_tokens ? { maxInputTokens: model.max_input_tokens } : {}),
        ...(model.max_tokens ? { maxOutputTokens: model.max_tokens } : {}),
      });
    }
    return models;
  }

  classifyError(error: unknown): ErrorClassification {
    return classifyClaudeError(error);
  }
}
