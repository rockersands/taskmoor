import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import type { AiSettings, Effort, ProviderId } from './config';
import { type FeatureId, resolveFeature } from './features';
import { redactSecrets } from './secrets';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** What a provider adapter receives: feature defaults already applied. */
export interface AdapterRequest {
  model: string;
  system: string;
  messages: ChatMessage[];
  maxTokens: number;
  effort: Effort;
  /** Mark the system prompt cacheable; it is stable per feature, so repeats cost a fraction. */
  cacheSystem: boolean;
  /** JSON schema the answer must match (structured output). */
  jsonSchema?: Record<string, unknown>;
}

export interface AdapterResponse {
  text: string;
  stopReason: string;
  /** The provider's safety layer declined; `text` may be empty. */
  refused: boolean;
  model: string;
  usage: Usage;
}

export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** Credential values, so the gateway can scrub them from error messages. */
  readonly secretValues: readonly string[];
  generate(request: AdapterRequest): Promise<AdapterResponse>;
}

export interface GenerateRequest<T = unknown> {
  feature: FeatureId;
  system: string;
  messages: ChatMessage[];
  /** When set, the model answers with JSON matching this schema and `parsed` holds the result. */
  schema?: z.ZodType<T>;
  cacheSystem?: boolean;
  maxOutputTokens?: number;
}

export interface GenerateResult<T = unknown> extends AdapterResponse {
  parsed: T | undefined;
  provider: ProviderId;
  latencyMs: number;
}

export class AiError extends Error {}

export class AiFeatureDisabledError extends AiError {
  constructor(readonly feature: FeatureId) {
    super(`AI feature "${feature}" is turned off`);
  }
}

export class AiProviderError extends AiError {
  constructor(
    message: string,
    readonly provider: ProviderId,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class AiOutputError extends AiError {}

/**
 * The one entry point product code uses for AI. It applies feature settings, turns Zod schemas
 * into structured-output requests, validates answers and keeps credentials out of errors.
 */
export class AiGateway {
  constructor(
    private readonly adapter: ProviderAdapter,
    private readonly features: AiSettings['features'] = {},
  ) {}

  get provider(): ProviderId {
    return this.adapter.provider;
  }

  async generate<T = unknown>(request: GenerateRequest<T>): Promise<GenerateResult<T>> {
    const feature = resolveFeature(request.feature, this.features[request.feature]);
    if (!feature.enabled) throw new AiFeatureDisabledError(request.feature);

    const adapterRequest: AdapterRequest = {
      model: feature.model,
      system: request.system,
      messages: request.messages,
      maxTokens: request.maxOutputTokens ?? feature.maxOutputTokens,
      effort: feature.effort,
      cacheSystem: request.cacheSystem ?? true,
      ...(request.schema ? { jsonSchema: zodOutputFormat(request.schema).schema } : {}),
    };

    const started = Date.now();
    let response: AdapterResponse;
    try {
      response = await this.adapter.generate(adapterRequest);
    } catch (error) {
      const raw = error instanceof Error ? error.message : String(error);
      throw new AiProviderError(
        `${this.adapter.provider}: ${redactSecrets(raw, this.adapter.secretValues)}`,
        this.adapter.provider,
        { cause: error },
      );
    }
    const latencyMs = Date.now() - started;

    let parsed: T | undefined;
    if (request.schema && !response.refused) {
      let json: unknown;
      try {
        json = JSON.parse(response.text);
      } catch {
        throw new AiOutputError(`${this.adapter.provider} returned text that is not JSON`);
      }
      const result = request.schema.safeParse(json);
      if (!result.success) {
        throw new AiOutputError(
          `${this.adapter.provider} returned JSON that does not match the schema: ${result.error.issues
            .map((i) => `${i.path.join('.')} ${i.message}`)
            .join('; ')}`,
        );
      }
      parsed = result.data;
    }

    return { ...response, parsed, provider: this.adapter.provider, latencyMs };
  }
}
