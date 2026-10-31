// Fakes for contract and gateway tests: nothing here talks to a network.
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ProviderId } from './config';
import { encodeSse } from './sse';
import type {
  AdapterRequest,
  AdapterResponse,
  CallOptions,
  ErrorClassification,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  StreamCallOptions,
} from './types';

export interface RecordedCall {
  url: string;
  method: string;
  /** Header names lower-cased. */
  headers: Record<string, string>;
  /** The JSON body, the raw string when it is not JSON, or undefined without a body. */
  body: unknown;
}

export interface FakeResponse {
  status?: number;
  headers?: Record<string, string>;
  json?: unknown;
  /** Server-sent events; `data` objects are JSON-encoded. */
  sse?: { event?: string | undefined; data: unknown }[];
  /** Newline-delimited JSON (batch results). */
  jsonl?: unknown[];
}

export interface FakeFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

function headerRecord(headers: ConstructorParameters<typeof Headers>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const entries =
    headers instanceof Headers
      ? [...headers.entries()]
      : Array.isArray(headers)
        ? headers
        : Object.entries(headers);
  for (const [name, value] of entries) out[name.toLowerCase()] = String(value);
  return out;
}

async function recordCall(
  input: Parameters<typeof fetch>[0],
  init?: RequestInit,
): Promise<RecordedCall> {
  const request = input instanceof Request ? input : undefined;
  const url =
    typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  let raw: string | undefined;
  if (typeof init?.body === 'string') raw = init.body;
  else if (init?.body instanceof Uint8Array) raw = new TextDecoder().decode(init.body);
  else if (request) raw = (await request.clone().text()) || undefined;
  let body: unknown = raw;
  if (raw !== undefined) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }
  return {
    url,
    method: (init?.method ?? request?.method ?? 'GET').toUpperCase(),
    headers: { ...headerRecord(request?.headers), ...headerRecord(init?.headers) },
    body,
  };
}

/** Builds the HTTP response a fake answers with. */
export function fakeHttpResponse(reply: FakeResponse): Response {
  const headers = new Headers(reply.headers);
  let body: string;
  if (reply.sse) {
    headers.set('content-type', 'text/event-stream');
    body = encodeSse(
      reply.sse.map((e) => ({
        ...(e.event ? { event: e.event } : {}),
        data: typeof e.data === 'string' ? e.data : JSON.stringify(e.data),
      })),
    );
  } else if (reply.jsonl) {
    headers.set('content-type', 'application/binary');
    body = reply.jsonl.map((line) => JSON.stringify(line)).join('\n');
  } else {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(reply.json ?? {});
  }
  return new Response(body, { status: reply.status ?? 200, headers });
}

/** A fetch that records every request and answers with what `respond` returns. */
export function fakeFetch(
  respond: (call: RecordedCall) => FakeResponse | Promise<FakeResponse>,
): FakeFetch {
  const calls: RecordedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = await recordCall(input, init);
    calls.push(call);
    return fakeHttpResponse(await respond(call));
  };
  return { fetch: fetchImpl, calls };
}

// ---------------------------------------------------------------------------------------------
// Recorded fixtures: request/response pairs written from the documented API shapes. The replay
// checks every request against the recording, so a fixture is the contract for the wire format.

const headerExpectation = z.union([
  z.string(),
  z.null(),
  z.object({ pattern: z.string() }).strict(),
]);

export const fixtureSchema = z
  .object({
    description: z.string(),
    exchanges: z
      .array(
        z
          .object({
            request: z
              .object({
                method: z.string(),
                url: z.string(),
                /** `null`: the header must be absent; `{ pattern }`: a regular expression. */
                headers: z.record(z.string(), headerExpectation).default({}),
                body: z.unknown().optional(),
              })
              .strict(),
            response: z
              .object({
                status: z.number().int().default(200),
                headers: z.record(z.string(), z.string()).default({}),
                body: z.unknown().optional(),
                sse: z
                  .array(z.object({ event: z.string().optional(), data: z.unknown() }).strict())
                  .optional(),
                jsonl: z.array(z.unknown()).optional(),
              })
              .strict(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();
export type Fixture = z.infer<typeof fixtureSchema>;

/** Reads and checks a fixture file, e.g. `loadFixture(new URL('./x.json', import.meta.url))`. */
export function loadFixture(path: URL): Fixture {
  return fixtureSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

function firstDifference(actual: unknown, expected: unknown, path = '$'): string | undefined {
  if (isDeepStrictEqual(actual, expected)) return undefined;
  if (
    typeof actual === 'object' &&
    actual !== null &&
    typeof expected === 'object' &&
    expected !== null &&
    Array.isArray(actual) === Array.isArray(expected)
  ) {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    for (const key of new Set([...Object.keys(e), ...Object.keys(a)])) {
      const found = firstDifference(a[key], e[key], `${path}.${key}`);
      if (found) return found;
    }
  }
  return `${path}: sent ${JSON.stringify(actual)?.slice(0, 300)}, recorded ${JSON.stringify(expected)?.slice(0, 300)}`;
}

function describeMismatch(
  call: RecordedCall,
  recorded: Fixture['exchanges'][number]['request'],
): string[] {
  const problems: string[] = [];
  if (call.method !== recorded.method.toUpperCase()) {
    problems.push(`method: sent ${call.method}, recorded ${recorded.method}`);
  }
  if (call.url !== recorded.url) problems.push(`url: sent ${call.url}, recorded ${recorded.url}`);
  for (const [name, expected] of Object.entries(recorded.headers)) {
    const actual = call.headers[name.toLowerCase()];
    if (expected === null) {
      if (actual !== undefined) problems.push(`header ${name}: must be absent`);
    } else if (typeof expected === 'string') {
      if (actual !== expected)
        problems.push(`header ${name}: sent ${actual}, recorded ${expected}`);
    } else if (actual === undefined || !new RegExp(expected.pattern).test(actual)) {
      problems.push(`header ${name}: sent ${actual}, expected to match ${expected.pattern}`);
    }
  }
  const difference = firstDifference(call.body, recorded.body);
  if (difference) problems.push(`body ${difference}`);
  return problems;
}

export interface Replay {
  fetch: typeof fetch;
  calls: RecordedCall[];
  /** Mismatches against the recording, plus exchanges never requested. Empty when all is well. */
  problems(): string[];
}

/**
 * Replays a fixture in order. Each request is compared with the recorded one (method, URL,
 * listed headers, exact JSON body) and answered with the recorded response either way, so a
 * test also sees what the code does with the answer; `problems()` reports every difference.
 */
export function replayFetch(fixture: Fixture): Replay {
  const calls: RecordedCall[] = [];
  const found: string[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const call = await recordCall(input, init);
    const index = calls.length;
    calls.push(call);
    const exchange = fixture.exchanges[index];
    if (!exchange) {
      found.push(`request ${index + 1} (${call.method} ${call.url}) is not in the recording`);
      return fakeHttpResponse({ status: 599, json: { error: 'not recorded' } });
    }
    for (const problem of describeMismatch(call, exchange.request)) {
      found.push(`request ${index + 1}: ${problem}`);
    }
    const response = exchange.response;
    return fakeHttpResponse({
      status: response.status,
      headers: response.headers,
      ...(response.sse ? { sse: response.sse } : {}),
      ...(response.jsonl ? { jsonl: response.jsonl } : {}),
      ...(response.body !== undefined ? { json: response.body } : {}),
    });
  };
  return {
    fetch: fetchImpl,
    calls,
    problems: () => [
      ...found,
      ...fixture.exchanges
        .slice(calls.length)
        .map(
          (e, i) => `recorded request ${calls.length + i + 1} (${e.request.url}) was never sent`,
        ),
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// A scripted adapter for gateway tests and for packages that use the gateway.

export const FULL_CAPABILITIES: ModelCapabilities = {
  streaming: true,
  structuredOutput: true,
  toolCalls: true,
  strictTools: true,
  effort: true,
  promptCaching: true,
  tokenCounting: true,
  modelListing: true,
  batches: false,
  refusalFallback: 'none',
};

export type ScriptStep = Partial<AdapterResponse> | Error | ((request: AdapterRequest) => never);

/** Answers each call with the next step of the script; the last step repeats. */
export class FakeAdapter implements ProviderAdapter {
  readonly requests: AdapterRequest[] = [];
  private calls = 0;

  constructor(
    private readonly script: ScriptStep[] = [{}],
    private readonly options: {
      provider?: ProviderId;
      secretValues?: string[];
      capabilities?: Partial<ModelCapabilities>;
      /** Text deltas a streamed answer emits before it completes. */
      deltas?: string[];
    } = {},
  ) {}

  get provider(): ProviderId {
    return this.options.provider ?? 'anthropic';
  }

  get secretValues(): readonly string[] {
    return this.options.secretValues ?? [];
  }

  capabilities(): ModelCapabilities {
    return { ...FULL_CAPABILITIES, ...this.options.capabilities };
  }

  private next(request: AdapterRequest): AdapterResponse {
    this.requests.push(request);
    const step = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls += 1;
    if (step instanceof Error) throw step;
    if (typeof step === 'function') return step(request);
    const text = step?.text ?? '';
    return {
      text,
      toolCalls: [],
      stopReason: 'end_turn',
      refused: false,
      refusalCategory: null,
      model: request.model,
      fellBack: false,
      usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
      message: { role: 'assistant', content: text },
      ...step,
    };
  }

  async generate(request: AdapterRequest, _options?: CallOptions): Promise<AdapterResponse> {
    return this.next(request);
  }

  async stream(request: AdapterRequest, options: StreamCallOptions): Promise<AdapterResponse> {
    const response = this.next(request);
    for (const delta of this.options.deltas ?? (response.text ? [response.text] : [])) {
      if (options.signal?.aborted) throw new FakeAbortError();
      options.onText(delta);
      // Let the consumer run between deltas, as a network stream would.
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (options.signal?.aborted) throw new FakeAbortError();
    return response;
  }

  async countTokens(request: AdapterRequest): Promise<number> {
    this.requests.push(request);
    return 42;
  }

  async listModels(): Promise<ModelInfo[]> {
    return [{ id: 'claude-opus-5-5' }];
  }

  classifyError(error: unknown): ErrorClassification {
    if (error instanceof FakeAbortError) return { kind: 'aborted', message: error.message };
    if (error instanceof FakeProviderFailure) {
      return {
        kind: error.kind,
        message: error.message,
        ...(error.status !== undefined ? { status: error.status } : {}),
        ...(error.retryAfterMs !== undefined ? { retryAfterMs: error.retryAfterMs } : {}),
      };
    }
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}

export class FakeAbortError extends Error {
  constructor() {
    super('aborted');
  }
}

/** A provider failure of a given kind, for scripting retries and outages. */
export class FakeProviderFailure extends Error {
  constructor(
    readonly kind: ErrorClassification['kind'],
    message: string = kind,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
  }
}
export { FakeProviderServer } from './fake-server';
