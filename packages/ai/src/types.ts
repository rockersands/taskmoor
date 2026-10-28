import type { Effort, ProviderId } from './config';

/** A piece of a chat turn in the gateway's provider-neutral form. */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; id: string; name: string; input: unknown }
  | { type: 'tool-result'; toolCallId: string; content: string; isError?: boolean };

/**
 * An assistant turn exactly as the provider returned it. Sent back unchanged on the next
 * request to the same provider, because Claude requires its thinking blocks to come back as
 * they were produced.
 */
export interface NativeTurn {
  format: 'claude-messages' | 'openai-chat';
  content: unknown;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string | ContentPart[];
  native?: NativeTurn;
}

export interface Usage {
  /** Input tokens billed at the full rate (the part after the last cache breakpoint). */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

/** A tool as adapters receive it: the input schema is already strict JSON schema. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** Why the model stopped, in Claude's vocabulary; other providers map onto it. */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use'
  | 'pause_turn'
  | 'refusal'
  | 'unknown';

/** What a provider adapter receives: feature defaults and policy already applied. */
export interface AdapterRequest {
  model: string;
  /** Stable instructions; the first cacheable prefix. */
  system: string;
  /** Stable context for a scope such as a track; cached after the instructions. */
  context?: string;
  messages: ChatMessage[];
  maxTokens: number;
  effort: Effort;
  /** Mark the stable prefix (tools, system, context) cacheable. */
  cacheSystem: boolean;
  /** Strict JSON schema the answer must match (structured output). */
  jsonSchema?: Record<string, unknown>;
  /** Offered with automatic tool choice; the model decides whether to call one. */
  tools?: ToolSpec[];
}

export interface AdapterResponse {
  /** The answer text; always empty when the provider refused. */
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  /** The provider's safety layer declined; text and tool calls are discarded. */
  refused: boolean;
  /** The provider's refusal category when it gives one (for example `cyber`). */
  refusalCategory: string | null;
  /** The model that produced the answer, as the provider spells it. */
  model: string;
  /** A refusal fallback served the answer on another model. */
  fellBack: boolean;
  usage: Usage;
  /** The assistant turn to append when the conversation continues. */
  message: ChatMessage;
}

export interface CallOptions {
  signal?: AbortSignal;
}

export interface StreamCallOptions extends CallOptions {
  onText(delta: string): void;
}

/** What a provider and model can do; features that need a missing capability are hidden. */
export interface ModelCapabilities {
  streaming: boolean;
  structuredOutput: boolean;
  toolCalls: boolean;
  strictTools: boolean;
  effort: boolean;
  promptCaching: boolean;
  tokenCounting: boolean;
  modelListing: boolean;
  batches: boolean;
  /** Where a refused request is retried on another model, if anywhere. */
  refusalFallback: 'server' | 'client' | 'none';
}

export type Capability = {
  [K in keyof ModelCapabilities]: ModelCapabilities[K] extends boolean ? K : never;
}[keyof ModelCapabilities];

export interface ModelInfo {
  id: string;
  displayName?: string;
  maxInputTokens?: number;
  maxOutputTokens?: number;
}

export type BatchStatus = 'in_progress' | 'canceling' | 'ended';

export interface BatchInfo {
  id: string;
  status: BatchStatus;
  counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  createdAt: string;
  endedAt: string | null;
}

export type BatchItemOutcome =
  | { id: string; ok: true; response: AdapterResponse }
  | {
      id: string;
      ok: false;
      error: { type: 'errored' | 'canceled' | 'expired' | 'invalid_output'; message: string };
    };

/** Asynchronous bulk processing at reduced cost, where the provider offers it. */
export interface BatchAdapter {
  submit(
    items: { id: string; request: AdapterRequest }[],
    options?: CallOptions,
  ): Promise<BatchInfo>;
  retrieve(batchId: string, options?: CallOptions): Promise<BatchInfo>;
  cancel(batchId: string, options?: CallOptions): Promise<BatchInfo>;
  results(batchId: string, options?: CallOptions): AsyncIterable<BatchItemOutcome>;
}

export type ProviderErrorKind =
  | 'rate_limited'
  | 'overloaded'
  | 'server'
  | 'timeout'
  | 'connection'
  | 'authentication'
  | 'permission'
  | 'not_found'
  | 'invalid_request'
  | 'request_too_large'
  | 'aborted'
  | 'unknown';

/** An adapter's reading of a failed call, before the gateway decides whether to retry. */
export interface ErrorClassification {
  kind: ProviderErrorKind;
  message: string;
  status?: number;
  retryAfterMs?: number;
  /** The provider's explicit retry hint (`x-should-retry`), when it sent one. */
  shouldRetry?: boolean;
}

/**
 * The one interface every provider implements. Adding a provider means implementing this;
 * feature code only ever talks to the gateway.
 */
export interface ProviderAdapter {
  readonly provider: ProviderId;
  /** Credential values, so the gateway can scrub them from error messages and logs. */
  readonly secretValues: readonly string[];
  capabilities(model: string): ModelCapabilities;
  generate(request: AdapterRequest, options?: CallOptions): Promise<AdapterResponse>;
  stream(request: AdapterRequest, options: StreamCallOptions): Promise<AdapterResponse>;
  countTokens(request: AdapterRequest, options?: CallOptions): Promise<number>;
  listModels(options?: CallOptions): Promise<ModelInfo[]>;
  readonly batches?: BatchAdapter | undefined;
  classifyError(error: unknown): ErrorClassification;
}
