import type { OpenAiCompatibleConfig } from '../config';
import { AiOutputError, AiUnsupportedError, kindForHttpStatus } from '../errors';
import { retryAfterFromHeaders } from '../retry';
import type { SecretStore } from '../secrets';
import { readSse } from '../sse';
import type {
  AdapterRequest,
  AdapterResponse,
  CallOptions,
  ChatMessage,
  ContentPart,
  ErrorClassification,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  ProviderErrorKind,
  StopReason,
  StreamCallOptions,
  ToolCall,
} from '../types';

interface WireToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface WireAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: WireToolCall[];
  refusal?: string | null;
}

type WireMessage =
  | { role: 'system' | 'user'; content: string }
  | WireAssistantMessage
  | { role: 'tool'; tool_call_id: string; content: string };

interface WireUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

interface ChatCompletion {
  model?: string;
  choices?: { message?: WireAssistantMessage; finish_reason?: string | null }[];
  usage?: WireUsage;
}

interface ChatCompletionChunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      refusal?: string | null;
      tool_calls?: {
        index: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: WireUsage | null;
}

/** An HTTP error answer from the server. */
export class HttpStatusError extends Error {
  constructor(
    readonly status: number,
    readonly headers: Headers,
    message: string,
  ) {
    super(message);
  }
}

/** A request that never got an answer: refused connection, timeout or cancellation. */
class TransportError extends Error {
  constructor(
    readonly kind: Extract<ProviderErrorKind, 'connection' | 'timeout' | 'aborted'>,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenAiCompatibleOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  /** Ask the server what the model supports (Ollama answers); default true. */
  detect?: boolean;
}

interface DetectedCapabilities {
  toolCalls: boolean;
  jsonSchema: boolean;
}

function stopReason(finish: string | null | undefined, refused: boolean): StopReason {
  if (refused) return 'refusal';
  switch (finish) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'refusal';
    default:
      return 'unknown';
  }
}

function toWireMessages(messages: readonly ChatMessage[]): WireMessage[] {
  const out: WireMessage[] = [];
  for (const message of messages) {
    if (message.role === 'assistant' && message.native?.format === 'openai-chat') {
      out.push(message.native.content as WireAssistantMessage);
      continue;
    }
    if (typeof message.content === 'string') {
      out.push({ role: message.role, content: message.content });
      continue;
    }
    const parts: ContentPart[] = message.content;
    const text = parts
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (message.role === 'assistant') {
      const calls = parts.filter((part) => part.type === 'tool-call');
      out.push({
        role: 'assistant',
        content: text || null,
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }
          : {}),
      });
      continue;
    }
    // Tool results answer the previous assistant turn, so they come before new user text.
    for (const part of parts) {
      if (part.type === 'tool-result') {
        out.push({ role: 'tool', tool_call_id: part.toolCallId, content: part.content });
      }
    }
    if (text) out.push({ role: 'user', content: text });
  }
  return out;
}

function parseToolCalls(calls: readonly WireToolCall[] | undefined): ToolCall[] {
  return (calls ?? []).map((call) => {
    let input: unknown;
    try {
      input = JSON.parse(call.function.arguments || '{}');
    } catch {
      throw new AiOutputError(`The arguments of tool call "${call.function.name}" are not JSON`);
    }
    return { id: call.id, name: call.function.name, input };
  });
}

/**
 * Local and self-hosted models through the OpenAI chat-completions shape (Ollama, vLLM, LM
 * Studio). The configured model serves every feature; effort and prompt caching have no
 * equivalent here, and tool calls are only offered when the server is known to support them.
 */
export class OpenAiCompatibleAdapter implements ProviderAdapter {
  readonly provider = 'openai-compatible' as const;
  readonly secretValues: readonly string[];
  private detected: DetectedCapabilities;

  private constructor(
    private readonly config: OpenAiCompatibleConfig,
    private readonly apiKey: string | undefined,
    private readonly fetchImpl: typeof fetch,
    private readonly timeoutMs: number,
  ) {
    this.secretValues = apiKey ? [apiKey] : [];
    this.detected = {
      toolCalls: config.capabilities?.toolCalls ?? false,
      jsonSchema: config.capabilities?.jsonSchema ?? true,
    };
  }

  static async create(
    config: OpenAiCompatibleConfig,
    secrets: SecretStore,
    options: OpenAiCompatibleOptions = {},
  ): Promise<OpenAiCompatibleAdapter> {
    const apiKey = config.apiKey ? await secrets.reveal(config.apiKey) : undefined;
    const adapter = new OpenAiCompatibleAdapter(
      config,
      apiKey,
      options.fetch ?? fetch,
      options.timeoutMs ?? 600_000,
    );
    const stated = config.capabilities;
    if (options.detect !== false && stated?.toolCalls === undefined) {
      await adapter.detectCapabilities();
    }
    return adapter;
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private headers(json: boolean): Record<string, string> {
    return {
      ...(json ? { 'content-type': 'application/json' } : {}),
      ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  private async send(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, signal: combined });
    } catch (error) {
      if (signal?.aborted) throw new TransportError('aborted', 'The request was cancelled');
      if (timeout.aborted) throw new TransportError('timeout', `${url} did not answer in time`);
      throw new TransportError(
        'connection',
        `Could not reach ${url}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 500);
      throw new HttpStatusError(
        response.status,
        response.headers,
        `${url} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }
    return response;
  }

  /**
   * Ollama reports per-model capabilities (`/api/show`); other servers do not say, so their
   * defaults stand. Settings in the configuration always win.
   */
  async detectCapabilities(options?: CallOptions): Promise<DetectedCapabilities> {
    const root = this.baseUrl.replace(/\/v1$/, '');
    try {
      const response = await this.send(
        `${root}/api/show`,
        {
          method: 'POST',
          headers: this.headers(true),
          body: JSON.stringify({ model: this.config.model }),
        },
        options?.signal,
      );
      const body = (await response.json()) as { capabilities?: unknown };
      if (Array.isArray(body.capabilities)) {
        this.detected = {
          toolCalls: this.config.capabilities?.toolCalls ?? body.capabilities.includes('tools'),
          jsonSchema: this.config.capabilities?.jsonSchema ?? true,
        };
      }
    } catch {
      // Not Ollama, or not reachable now: keep the defaults.
    }
    return this.detected;
  }

  capabilities(_model: string): ModelCapabilities {
    return {
      streaming: true,
      structuredOutput: this.detected.jsonSchema,
      toolCalls: this.detected.toolCalls,
      strictTools: this.detected.toolCalls,
      effort: false,
      promptCaching: false,
      tokenCounting: false,
      modelListing: true,
      batches: false,
      taskBudget: false,
      refusalFallback: 'none',
    };
  }

  private body(request: AdapterRequest, stream: boolean): Record<string, unknown> {
    const system = [request.system, request.context].filter(Boolean).join('\n\n');
    const tools = request.tools?.length
      ? [...request.tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      : undefined;
    return {
      model: this.config.model,
      max_tokens: request.maxTokens,
      messages: [
        ...(system ? [{ role: 'system', content: system }] : []),
        ...toWireMessages(request.messages),
      ],
      ...(request.jsonSchema
        ? {
            response_format: {
              type: 'json_schema',
              json_schema: { name: 'output', schema: request.jsonSchema, strict: true },
            },
          }
        : {}),
      ...(tools
        ? {
            tools: tools.map((tool) => ({
              type: 'function',
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
                strict: true,
              },
            })),
            tool_choice: 'auto',
          }
        : {}),
      ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
    };
  }

  private usage(usage: WireUsage | null | undefined): AdapterResponse['usage'] {
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    return {
      inputTokens: Math.max(0, (usage?.prompt_tokens ?? 0) - cached),
      outputTokens: usage?.completion_tokens ?? 0,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
  }

  private response(
    wire: WireAssistantMessage,
    finish: string | null | undefined,
    model: string | undefined,
    usage: WireUsage | null | undefined,
  ): AdapterResponse {
    const refused = Boolean(wire.refusal) || finish === 'content_filter';
    const text = refused ? '' : (wire.content ?? '');
    const toolCalls = refused ? [] : parseToolCalls(wire.tool_calls);
    const parts: ContentPart[] = [
      ...(text ? [{ type: 'text' as const, text }] : []),
      ...toolCalls.map((call) => ({ type: 'tool-call' as const, ...call })),
    ];
    return {
      text,
      toolCalls,
      stopReason: stopReason(finish, refused),
      refused,
      refusalCategory: null,
      model: model ?? this.config.model,
      fellBack: false,
      usage: this.usage(usage),
      message: {
        role: 'assistant',
        content: parts,
        native: { format: 'openai-chat', content: wire },
      },
    };
  }

  async generate(request: AdapterRequest, options?: CallOptions): Promise<AdapterResponse> {
    const response = await this.send(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(this.body(request, false)),
      },
      options?.signal,
    );
    const data = (await response.json()) as ChatCompletion;
    const choice = data.choices?.[0];
    return this.response(
      choice?.message ?? { role: 'assistant', content: '' },
      choice?.finish_reason,
      data.model,
      data.usage,
    );
  }

  async stream(request: AdapterRequest, options: StreamCallOptions): Promise<AdapterResponse> {
    const response = await this.send(
      `${this.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: this.headers(true),
        body: JSON.stringify(this.body(request, true)),
      },
      options.signal,
    );
    if (!response.body) throw new TransportError('connection', 'The server sent no stream');
    let text = '';
    let refusal = '';
    let finish: string | null | undefined;
    let model: string | undefined;
    let usage: WireUsage | null | undefined;
    const calls = new Map<number, WireToolCall>();
    for await (const event of readSse(response.body)) {
      if (event.data === '[DONE]') break;
      const chunk = JSON.parse(event.data) as ChatCompletionChunk & {
        error?: { message?: string };
      };
      if (chunk.error) {
        throw new HttpStatusError(500, new Headers(), chunk.error.message ?? 'stream error');
      }
      model ??= chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta;
      if (delta?.content) {
        text += delta.content;
        options.onText(delta.content);
      }
      if (delta?.refusal) refusal += delta.refusal;
      for (const call of delta?.tool_calls ?? []) {
        const current = calls.get(call.index) ?? {
          id: '',
          type: 'function' as const,
          function: { name: '', arguments: '' },
        };
        if (call.id) current.id = call.id;
        if (call.function?.name) current.function.name += call.function.name;
        if (call.function?.arguments) current.function.arguments += call.function.arguments;
        calls.set(call.index, current);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }
    const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
    const wire: WireAssistantMessage = {
      role: 'assistant',
      content: text || null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      ...(refusal ? { refusal } : {}),
    };
    return this.response(wire, finish, model, usage);
  }

  async countTokens(): Promise<number> {
    throw new AiUnsupportedError(this.provider, 'tokenCounting');
  }

  async listModels(options?: CallOptions): Promise<ModelInfo[]> {
    const response = await this.send(
      `${this.baseUrl}/models`,
      { method: 'GET', headers: this.headers(false) },
      options?.signal,
    );
    const body = (await response.json()) as { data?: { id?: unknown }[] };
    return (body.data ?? [])
      .filter((model): model is { id: string } => typeof model.id === 'string')
      .map((model) => ({ id: model.id }));
  }

  classifyError(error: unknown): ErrorClassification {
    if (error instanceof TransportError) return { kind: error.kind, message: error.message };
    if (error instanceof HttpStatusError) {
      const retryAfterMs = retryAfterFromHeaders(error.headers);
      return {
        kind: kindForHttpStatus(error.status),
        message: error.message,
        status: error.status,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
    }
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}
