import type { z } from 'zod';
import { type AiSettings, DEFAULT_MODEL, type ProviderId } from './config';
import {
  AiAbortedError,
  AiCircuitOpenError,
  AiError,
  AiFeatureDisabledError,
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiSpendLimitError,
  AiUnsupportedError,
} from './errors';
import { type FeatureId, type ResolvedFeature, resolveFeature } from './features';
import { NO_REDACTION, type RedactionRules, Redactor, type SensitiveValue } from './redact';
import {
  CircuitBreaker,
  type CircuitBreakerOptions,
  DEFAULT_BREAKER,
  DEFAULT_RETRY,
  type RetryOptions,
  retryDelay,
} from './retry';
import { check, checkJsonAnswer, strictJsonSchema } from './schema';
import { redactSecrets } from './secrets';
import {
  type AiMeter,
  type CallOutcome,
  type CallTag,
  type MeteredCall,
  ZERO_USAGE,
} from './spend';
import type {
  AdapterRequest,
  AdapterResponse,
  BatchAdapter,
  BatchInfo,
  BatchItemOutcome,
  CallOptions,
  Capability,
  ChatMessage,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ToolCall,
  Usage,
} from './types';

/** A tool the model may call. Its input is validated with the Zod schema before anyone uses it. */
export interface AiTool {
  name: string;
  description: string;
  input: z.ZodType;
}

export interface GenerateRequest<T = unknown> {
  feature: FeatureId;
  /** Stable instructions for the feature. No timestamps or IDs: it is the cached prefix. */
  system: string;
  /** Stable context for a scope, such as a track's settings; cached after the instructions. */
  context?: string;
  /** Volatile content goes here, last, so the prefix stays cacheable. */
  messages: ChatMessage[];
  /** When set, the model answers with JSON matching this schema and `parsed` holds the result. */
  schema?: z.ZodType<T>;
  /** Offered with automatic tool choice; calls come back in `toolCalls`, validated. */
  tools?: AiTool[];
  cacheSystem?: boolean;
  maxOutputTokens?: number;
  /** Who the call is for: the spend limits and the AI audit log count it there (M1-077). */
  tag?: CallTag;
  /**
   * Values of fields marked sensitive that the prompt was built from: they are replaced
   * wherever they appear in what is sent, besides the workspace's redaction rules (IAM-022).
   */
  sensitive?: readonly SensitiveValue[];
}

export interface GenerateResult<T = unknown> extends AdapterResponse {
  parsed: T | undefined;
  provider: ProviderId;
  latencyMs: number;
  /** Retries after transient failures (429, 5xx, overload, timeouts, lost connections). */
  retries: number;
  /** The first structured answer was invalid and the one repair attempt fixed it. */
  repaired: boolean;
}

export type StreamEvent =
  | { type: 'text'; text: string }
  /** The provider declined: discard every text event received so far. */
  | { type: 'refused'; category: string | null };

/** A streamed answer: iterate for text as it arrives; `result` settles with the whole answer. */
export interface AiStream<T = unknown> extends AsyncIterable<StreamEvent> {
  readonly result: Promise<GenerateResult<T>>;
  /** Stops the stream; the provider stops generating (and billing) the rest. */
  abort(): void;
}

/** Pino-compatible: structured data first, message second. Never receives prompt content. */
export interface AiLogger {
  warn(data: Record<string, unknown>, message: string): void;
}

export interface AiGatewayOptions {
  features?: AiSettings['features'];
  retry?: Partial<RetryOptions>;
  breaker?: Partial<CircuitBreakerOptions>;
  logger?: AiLogger;
  now?: () => number;
  /** Spend limits before each call and one audit row after it (M1-077). */
  meter?: AiMeter;
  /** The redaction rules in force for a call (IAM-022); none when left out. */
  redaction?: (tag: CallTag) => RedactionRules | Promise<RedactionRules>;
}

export type FeatureAvailability =
  | { available: true }
  | { available: false; reason: 'disabled' }
  | { available: false; reason: 'unsupported'; missing: Capability[] };

export interface BatchRequest<T = unknown> {
  feature: FeatureId;
  system: string;
  context?: string;
  schema?: z.ZodType<T>;
  maxOutputTokens?: number;
  /** IDs are the caller's (1 to 64 letters, digits, `-` or `_`); results are matched by them. */
  items: { id: string; messages: ChatMessage[] }[];
  tag?: CallTag;
  sensitive?: readonly SensitiveValue[];
}

export type BatchResult<T = unknown> =
  | { id: string; ok: true; result: GenerateResult<T> }
  | Extract<BatchItemOutcome, { ok: false }>;

const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const BATCH_ITEM_ID = /^[a-zA-Z0-9_-]{1,64}$/;
const MAX_BATCH_ITEMS = 100_000;

interface Prepared {
  feature: ResolvedFeature;
  request: AdapterRequest;
  tools: Map<string, AiTool>;
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

function repairPrompt(problem: string): string {
  return `Your previous answer did not match the required JSON schema (${problem}). Reply again with only JSON that matches the schema.`;
}

/** A single-consumer queue that turns adapter callbacks into an async iterator. */
class EventQueue<E> {
  private readonly items: E[] = [];
  private waiter:
    | { resolve(result: IteratorResult<E>): void; reject(error: unknown): void }
    | undefined;
  private finished = false;
  private failure: { error: unknown } | undefined;

  constructor(private readonly onCancel: () => void) {}

  push(item: E): void {
    if (this.finished) return;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      waiter.resolve({ value: item, done: false });
    } else {
      this.items.push(item);
    }
  }

  end(): void {
    this.finished = true;
    this.wake();
  }

  fail(error: unknown): void {
    if (this.finished) return;
    this.failure = { error };
    this.wake();
  }

  private wake(): void {
    const waiter = this.waiter;
    if (!waiter) return;
    this.waiter = undefined;
    if (this.failure) waiter.reject(this.failure.error);
    else waiter.resolve({ value: undefined, done: true });
  }

  iterator(): AsyncIterator<E> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.failure) return Promise.reject(this.failure.error);
        if (this.finished) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          this.waiter = { resolve, reject };
        });
      },
      return: () => {
        if (!this.finished && !this.failure) this.onCancel();
        this.finished = true;
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

/**
 * The one entry point product code uses for AI. It applies feature settings and the request
 * policy, hides features the provider cannot serve, retries transient failures with backoff
 * (logged, honouring Retry-After), stops calling a failing provider for a while (circuit
 * breaker), validates structured answers and tool inputs, reports refusals as data and keeps
 * credentials out of errors and logs.
 */
export class AiGateway {
  private readonly features: AiSettings['features'];
  private readonly retry: RetryOptions;
  private readonly breaker: CircuitBreaker;
  private readonly logger: AiLogger | undefined;
  private readonly now: () => number;
  private readonly meter: AiMeter | undefined;
  private readonly redaction: AiGatewayOptions['redaction'];

  constructor(
    private readonly adapter: ProviderAdapter,
    options: AiGatewayOptions = {},
  ) {
    this.features = options.features ?? {};
    this.retry = { ...DEFAULT_RETRY, ...options.retry };
    this.now = options.now ?? Date.now;
    this.breaker = new CircuitBreaker({ ...DEFAULT_BREAKER, now: this.now, ...options.breaker });
    this.logger = options.logger;
    this.meter = options.meter;
    this.redaction = options.redaction;
  }

  get provider(): ProviderId {
    return this.adapter.provider;
  }

  /** What the provider offers for the model a feature uses. */
  capabilities(feature: FeatureId): ModelCapabilities {
    return this.adapter.capabilities(this.resolve(feature).model);
  }

  /** Whether to show a feature at all, and why not (AI-002). */
  availability(feature: FeatureId): FeatureAvailability {
    const resolved = this.resolve(feature);
    if (!resolved.enabled) return { available: false, reason: 'disabled' };
    const capabilities = this.adapter.capabilities(resolved.model);
    const missing = resolved.needs.filter((capability) => !capabilities[capability]);
    return missing.length > 0
      ? { available: false, reason: 'unsupported', missing }
      : { available: true };
  }

  async generate<T = unknown>(
    request: GenerateRequest<T>,
    options: CallOptions = {},
  ): Promise<GenerateResult<T>> {
    const prepared = await this.outgoing(this.prepare(request), request);
    return this.metered(this.callOf(request, prepared, 'generate'), prepared.request, async () => {
      const started = this.now();
      const first = await this.attempt(
        request.feature,
        (signal) => this.adapter.generate(prepared.request, signal ? { signal } : {}),
        options.signal,
      );
      return this.complete(request, prepared, first.value, first.retries, started, options.signal);
    });
  }

  /**
   * Streams the answer. Transient failures are retried only until the first text arrives;
   * after that a failure ends the stream. A refusal emits `refused` and the result carries no
   * text, so partial content is never shown as an answer.
   */
  stream<T = unknown>(request: GenerateRequest<T>, options: CallOptions = {}): AiStream<T> {
    const controller = new AbortController();
    const outer = options.signal;
    const onOuterAbort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener('abort', onOuterAbort, { once: true });

    const queue = new EventQueue<StreamEvent>(() => controller.abort());
    let emitted = false;
    const result = (async () => {
      try {
        const prepared = await this.outgoing(this.prepare(request), request);
        const done = await this.metered(
          this.callOf(request, prepared, 'stream'),
          prepared.request,
          async () => {
            const started = this.now();
            const first = await this.attempt(
              request.feature,
              (signal) =>
                this.adapter.stream(prepared.request, {
                  ...(signal ? { signal } : {}),
                  onText: (text) => {
                    emitted = true;
                    queue.push({ type: 'text', text });
                  },
                }),
              controller.signal,
              () => !emitted,
            );
            if (first.value.refused) {
              queue.push({ type: 'refused', category: first.value.refusalCategory });
            }
            return this.complete(
              request,
              prepared,
              first.value,
              first.retries,
              started,
              controller.signal,
            );
          },
        );
        queue.end();
        return done;
      } catch (error) {
        queue.fail(error);
        throw error;
      } finally {
        outer?.removeEventListener('abort', onOuterAbort);
      }
    })();
    // The caller may only iterate; a failure then surfaces there, not as an unhandled rejection.
    result.catch(() => {});
    return {
      [Symbol.asyncIterator]: () => queue.iterator(),
      result,
      abort: () => controller.abort(),
    };
  }

  /** Input tokens the request would use, from the provider's own counter. */
  async countTokens(request: GenerateRequest, options: CallOptions = {}): Promise<number> {
    const prepared = await this.outgoing(this.prepare(request), request);
    if (!this.adapter.capabilities(prepared.request.model).tokenCounting) {
      throw new AiUnsupportedError(this.provider, 'tokenCounting');
    }
    const counted = await this.attempt(
      request.feature,
      (signal) => this.adapter.countTokens(prepared.request, signal ? { signal } : {}),
      options.signal,
    );
    return counted.value;
  }

  /** Models the provider offers right now, fetched live (AI-001). */
  async listModels(options: CallOptions = {}): Promise<ModelInfo[]> {
    if (!this.adapter.capabilities(DEFAULT_MODEL).modelListing) {
      throw new AiUnsupportedError(this.provider, 'modelListing');
    }
    const listed = await this.attempt(
      'models',
      (signal) => this.adapter.listModels(signal ? { signal } : {}),
      options.signal,
    );
    return listed.value;
  }

  /**
   * Submits a batch for one feature. Store the returned ID: status and results can be read
   * with it alone, so a job resumes after a restart.
   */
  async submitBatch<T>(batch: BatchRequest<T>, options: CallOptions = {}): Promise<BatchInfo> {
    const batches = this.batchAdapter(batch.feature);
    if (batch.items.length === 0 || batch.items.length > MAX_BATCH_ITEMS) {
      throw new AiPolicyError(`A batch holds 1 to ${MAX_BATCH_ITEMS} items`);
    }
    const ids = new Set<string>();
    for (const item of batch.items) {
      if (!BATCH_ITEM_ID.test(item.id))
        throw new AiPolicyError(`Invalid batch item ID "${item.id}"`);
      if (ids.has(item.id)) throw new AiPolicyError(`Duplicate batch item ID "${item.id}"`);
      ids.add(item.id);
    }
    const base = this.prepare({
      feature: batch.feature,
      system: batch.system,
      ...(batch.context ? { context: batch.context } : {}),
      messages: [],
      ...(batch.schema ? { schema: batch.schema } : {}),
      ...(batch.maxOutputTokens ? { maxOutputTokens: batch.maxOutputTokens } : {}),
    });
    const rules = this.redaction ? await this.redaction(batch.tag ?? {}) : NO_REDACTION;
    const redactor = new Redactor(rules, batch.sensitive ?? []);
    const items = batch.items.map((item) => ({
      id: item.id,
      request: redactor.request({ ...base.request, messages: item.messages }),
    }));
    const call: MeteredCall = {
      feature: batch.feature,
      provider: this.provider,
      model: base.request.model,
      mode: 'batch',
      tag: batch.tag ?? {},
    };
    await this.admit(call);
    // Retry only when the provider plainly turned the submission away; after a lost answer
    // the batch may exist already, and a second one would be billed twice.
    const submitted = await this.attempt(
      batch.feature,
      (signal) => batches.submit(items, signal ? { signal } : {}),
      options.signal,
      (error) => error.kind === 'rate_limited' || error.kind === 'overloaded',
    );
    return submitted.value;
  }

  async batchStatus(batchId: string, options: CallOptions = {}): Promise<BatchInfo> {
    const batches = this.batchAdapter();
    return (
      await this.attempt(
        'batch',
        (signal) => batches.retrieve(batchId, signal ? { signal } : {}),
        options.signal,
      )
    ).value;
  }

  async cancelBatch(batchId: string, options: CallOptions = {}): Promise<BatchInfo> {
    const batches = this.batchAdapter();
    return (
      await this.attempt(
        'batch',
        (signal) => batches.cancel(batchId, signal ? { signal } : {}),
        options.signal,
      )
    ).value;
  }

  /**
   * Results in any order, keyed by item ID; structured answers are validated per item. With
   * `feature`, each result is booked as one call at the batch rate (M1-077): read a batch's
   * results once.
   */
  async *batchResults<T = unknown>(
    batchId: string,
    options: CallOptions & { schema?: z.ZodType<T>; feature?: FeatureId; tag?: CallTag } = {},
  ): AsyncGenerator<BatchResult<T>> {
    const batches = this.batchAdapter();
    const call: MeteredCall | undefined = options.feature
      ? {
          feature: options.feature,
          provider: this.provider,
          model: this.resolve(options.feature).model,
          mode: 'batch',
          tag: options.tag ?? {},
        }
      : undefined;
    for await (const outcome of batches.results(
      batchId,
      options.signal ? { signal: options.signal } : {},
    )) {
      if (!outcome.ok) {
        if (call) {
          await this.book(call, {
            ...this.blank(call),
            status: outcome.error.type === 'canceled' ? 'aborted' : 'error',
            errorKind: outcome.error.type,
          });
        }
        yield outcome;
        continue;
      }
      const response = outcome.response;
      if (call) {
        await this.book(call, {
          ...this.blank(call),
          status: response.refused ? 'refused' : 'ok',
          usage: response.usage,
          servedModel: response.model,
          fellBack: response.fellBack,
        });
      }
      const base: GenerateResult<T> = {
        ...response,
        parsed: undefined,
        provider: this.provider,
        latencyMs: 0,
        retries: 0,
        repaired: false,
      };
      if (response.refused || !options.schema) {
        yield { id: outcome.id, ok: true, result: base };
        continue;
      }
      const checked =
        response.stopReason === 'max_tokens'
          ? ({ ok: false, problem: 'the answer was cut off at the output limit' } as const)
          : checkJsonAnswer(options.schema, response.text);
      yield checked.ok
        ? { id: outcome.id, ok: true, result: { ...base, parsed: checked.data } }
        : {
            id: outcome.id,
            ok: false,
            error: { type: 'invalid_output', message: checked.problem },
          };
    }
  }

  /** The request as it leaves the process: the workspace's redaction rules applied. */
  private async outgoing(
    prepared: Prepared,
    request: { tag?: CallTag; sensitive?: readonly SensitiveValue[] },
  ): Promise<Prepared> {
    if (!this.redaction && !request.sensitive?.length) return prepared;
    const rules = this.redaction ? await this.redaction(request.tag ?? {}) : NO_REDACTION;
    const redactor = new Redactor(rules, request.sensitive ?? []);
    return redactor.active
      ? { ...prepared, request: redactor.request(prepared.request) }
      : prepared;
  }

  private callOf(
    request: { feature: FeatureId; tag?: CallTag },
    prepared: Prepared,
    mode: MeteredCall['mode'],
  ): MeteredCall {
    return {
      feature: request.feature,
      provider: this.provider,
      model: prepared.request.model,
      mode,
      tag: request.tag ?? {},
    };
  }

  private blank(call: MeteredCall): CallOutcome {
    return {
      status: 'ok',
      usage: ZERO_USAGE,
      servedModel: call.model,
      latencyMs: 0,
      retries: 0,
      fellBack: false,
    };
  }

  /** Checks the spend limits; a refusal is booked as a call of its own before it is thrown. */
  private async admit(call: MeteredCall): Promise<void> {
    if (!this.meter) return;
    try {
      await this.meter.admit(call);
    } catch (error) {
      if (error instanceof AiSpendLimitError) {
        await this.book(call, { ...this.blank(call), status: 'limited', limit: error.limit });
      }
      throw error;
    }
  }

  /** Books a call; a failure to book is logged, never turned into a failed call. */
  private async book(call: MeteredCall, outcome: CallOutcome): Promise<void> {
    if (!this.meter) return;
    try {
      await this.meter.record(call, outcome);
    } catch (error) {
      this.logger?.warn(
        {
          provider: this.provider,
          feature: call.feature,
          error: error instanceof Error ? error.message : String(error),
        },
        'AI call could not be booked',
      );
    }
  }

  /** Admits, runs and books one call: exactly one audit row whatever happens (M1-077). */
  private async metered<R extends GenerateResult<unknown>>(
    call: MeteredCall,
    sent: AdapterRequest,
    run: () => Promise<R>,
  ): Promise<R> {
    if (!this.meter) return run();
    await this.admit(call);
    const started = this.now();
    try {
      const result = await run();
      await this.book(call, {
        status: result.refused ? 'refused' : 'ok',
        usage: result.usage,
        servedModel: result.model,
        latencyMs: result.latencyMs,
        retries: result.retries,
        fellBack: result.fellBack,
        content: { request: sent, answer: result.text },
      });
      return result;
    } catch (error) {
      await this.book(call, {
        ...this.blank(call),
        status: error instanceof AiAbortedError ? 'aborted' : 'error',
        latencyMs: this.now() - started,
        errorKind: errorKind(error),
        ...(error instanceof AiOutputError && error.usage ? { usage: error.usage } : {}),
      });
      throw error;
    }
  }

  private resolve(feature: FeatureId): ResolvedFeature {
    return resolveFeature(feature, this.features[feature]);
  }

  private batchAdapter(feature?: FeatureId): BatchAdapter {
    const model = feature ? this.resolve(feature).model : DEFAULT_MODEL;
    if (!this.adapter.batches || !this.adapter.capabilities(model).batches) {
      throw new AiUnsupportedError(this.provider, 'batches');
    }
    return this.adapter.batches;
  }

  private prepare(request: GenerateRequest<unknown>): Prepared {
    const feature = this.resolve(request.feature);
    if (!feature.enabled) throw new AiFeatureDisabledError(request.feature);
    const capabilities = this.adapter.capabilities(feature.model);
    if (request.schema && !capabilities.structuredOutput) {
      throw new AiUnsupportedError(this.provider, 'structuredOutput');
    }
    const tools = new Map<string, AiTool>();
    if (request.tools?.length) {
      if (!capabilities.toolCalls) throw new AiUnsupportedError(this.provider, 'toolCalls');
      for (const tool of request.tools) {
        if (!TOOL_NAME.test(tool.name)) throw new AiPolicyError(`Invalid tool name "${tool.name}"`);
        if (tools.has(tool.name)) throw new AiPolicyError(`Duplicate tool name "${tool.name}"`);
        tools.set(tool.name, tool);
      }
    }
    return {
      feature,
      tools,
      request: {
        model: feature.model,
        system: request.system,
        ...(request.context ? { context: request.context } : {}),
        messages: request.messages,
        maxTokens: request.maxOutputTokens ?? feature.maxOutputTokens,
        effort: feature.effort,
        cacheSystem: request.cacheSystem ?? true,
        ...(request.schema ? { jsonSchema: strictJsonSchema(request.schema) } : {}),
        ...(tools.size > 0
          ? {
              tools: [...tools.values()].map((tool) => ({
                name: tool.name,
                description: tool.description,
                inputSchema: strictJsonSchema(tool.input),
              })),
            }
          : {}),
      },
    };
  }

  private toError(raw: unknown, signal: AbortSignal | undefined): AiError {
    if (raw instanceof AiError) return raw;
    const classified = this.adapter.classifyError(raw);
    if (classified.kind === 'aborted' || signal?.aborted) {
      return new AiAbortedError('The AI call was cancelled');
    }
    // The raw error is not attached as the cause: SDK errors can carry request details.
    return new AiProviderError(
      `${this.provider}: ${redactSecrets(classified.message, this.adapter.secretValues)}`,
      this.provider,
      classified.kind,
      {
        ...(classified.status !== undefined ? { status: classified.status } : {}),
        ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
        ...(classified.shouldRetry !== undefined ? { shouldRetry: classified.shouldRetry } : {}),
      },
    );
  }

  /** One call with typed retries, inside the circuit breaker. */
  private async attempt<R>(
    feature: string,
    call: (signal: AbortSignal | undefined) => Promise<R>,
    signal: AbortSignal | undefined,
    mayRetry: (error: AiProviderError) => boolean = () => true,
  ): Promise<{ value: R; retries: number }> {
    if (signal?.aborted) throw new AiAbortedError('The AI call was cancelled');
    if (!this.breaker.tryAcquire()) {
      throw new AiCircuitOpenError(this.provider, this.breaker.retryAt ?? this.now());
    }
    let retries = 0;
    for (;;) {
      try {
        const value = await call(signal);
        this.breaker.record('up');
        return { value, retries };
      } catch (raw) {
        const error = this.toError(raw, signal);
        if (!(error instanceof AiProviderError)) {
          this.breaker.record(error instanceof AiAbortedError ? 'unknown' : 'up');
          throw error;
        }
        const delay =
          error.retryable && retries < this.retry.maxRetries && mayRetry(error)
            ? retryDelay(retries, error.retryAfterMs, this.retry)
            : undefined;
        if (delay === undefined) {
          this.breaker.record(error.outage ? 'down' : 'up');
          throw error;
        }
        retries += 1;
        this.logger?.warn(
          {
            provider: this.provider,
            feature,
            retry: retries,
            delayMs: delay,
            kind: error.kind,
            ...(error.status !== undefined ? { status: error.status } : {}),
          },
          'AI provider call failed; retrying',
        );
        try {
          await this.retry.sleep(delay, signal);
        } catch (sleepError) {
          this.breaker.record('unknown');
          throw sleepError;
        }
      }
    }
  }

  private checkedToolCalls(response: AdapterResponse, tools: Map<string, AiTool>): ToolCall[] {
    if (response.toolCalls.length === 0) return [];
    if (response.stopReason === 'max_tokens') {
      throw new AiOutputError(`${this.provider}: a tool call was cut off at the output limit`);
    }
    return response.toolCalls.map((call) => {
      const tool = tools.get(call.name);
      if (!tool) throw new AiOutputError(`${this.provider} called an unknown tool "${call.name}"`);
      const checked = check(tool.input, call.input);
      if (!checked.ok) {
        throw new AiOutputError(
          `${this.provider}: the input for tool "${call.name}" does not match its schema: ${checked.problem}`,
        );
      }
      return { ...call, input: checked.data };
    });
  }

  /** Validates the answer; an invalid structured answer gets one repair attempt (AI-007). */
  private async complete<T>(
    request: GenerateRequest<T>,
    prepared: Prepared,
    response: AdapterResponse,
    retries: number,
    started: number,
    signal: AbortSignal | undefined,
  ): Promise<GenerateResult<T>> {
    let usage = response.usage;
    try {
      return await this.completeChecked(request, prepared, response, retries, started, signal, {
        add: (more) => {
          usage = addUsage(usage, more);
          return usage;
        },
      });
    } catch (error) {
      if (error instanceof AiOutputError && !error.usage) error.usage = usage;
      throw error;
    }
  }

  private async completeChecked<T>(
    request: GenerateRequest<T>,
    prepared: Prepared,
    response: AdapterResponse,
    retries: number,
    started: number,
    signal: AbortSignal | undefined,
    billed: { add(more: Usage): Usage },
  ): Promise<GenerateResult<T>> {
    let current = response;
    let usage = response.usage;
    let totalRetries = retries;
    let repaired = false;
    const finish = (answer: AdapterResponse, parsed: T | undefined): GenerateResult<T> => ({
      ...answer,
      toolCalls: answer.refused ? [] : this.checkedToolCalls(answer, prepared.tools),
      usage,
      parsed,
      provider: this.provider,
      latencyMs: this.now() - started,
      retries: totalRetries,
      repaired,
    });

    if (current.refused || !request.schema) return finish(current, undefined);
    const cutOff = () =>
      new AiOutputError(`${this.provider}: the answer was cut off at the output limit`);
    if (current.stopReason === 'max_tokens') throw cutOff();

    let checked = checkJsonAnswer(request.schema, current.text);
    if (!checked.ok) {
      const repairRequest: AdapterRequest = {
        ...prepared.request,
        messages: [
          ...prepared.request.messages,
          current.message,
          { role: 'user', content: repairPrompt(checked.problem) },
        ],
      };
      const second = await this.attempt(
        request.feature,
        (attemptSignal) =>
          this.adapter.generate(repairRequest, attemptSignal ? { signal: attemptSignal } : {}),
        signal,
      );
      current = second.value;
      usage = billed.add(current.usage);
      totalRetries += second.retries;
      repaired = true;
      if (current.refused) return finish(current, undefined);
      if (current.stopReason === 'max_tokens') throw cutOff();
      checked = checkJsonAnswer(request.schema, current.text);
      if (!checked.ok) {
        throw new AiOutputError(
          `${this.provider} returned an answer that does not match the schema: ${checked.problem}`,
        );
      }
    }
    return finish(current, checked.data);
  }
}

function errorKind(error: unknown): string {
  if (error instanceof AiProviderError) return error.kind;
  if (error instanceof AiOutputError) return 'invalid_output';
  if (error instanceof AiPolicyError) return 'policy';
  if (error instanceof AiUnsupportedError) return 'unsupported';
  if (error instanceof AiCircuitOpenError) return 'circuit_open';
  if (error instanceof AiAbortedError) return 'aborted';
  return 'unknown';
}
