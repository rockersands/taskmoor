// Fakes for contract and gateway tests: nothing here talks to a network.
import { appendFileSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { ProviderId } from './config';
import { AiSpendLimitError } from './errors';
import {
  type AiMeter,
  type CallOutcome,
  callCost,
  LIST_PRICES,
  type ListPrice,
  limitApplies,
  type MeteredCall,
  periodWindow,
  priceModelId,
  reachedLimit,
  type SpendLimit,
  totalTokens,
} from './spend';
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
  taskBudget: true,
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
export { type FakeMessagesRequest, FakeProviderServer } from './fake-server';

// ---------------------------------------------------------------------------------------------
// An in-memory meter: the spend limits and audit rows of M1-077 without a database.

export interface BookedCall {
  call: MeteredCall;
  outcome: CallOutcome;
  costNanos: number;
  at: Date;
}

/** Applies spend limits over the calls it booked; prices from `LIST_PRICES` unless given. */
export class MemoryMeter implements AiMeter {
  readonly booked: BookedCall[] = [];

  constructor(
    public limits: SpendLimit[] = [],
    private readonly options: { now?: () => number; prices?: readonly ListPrice[] } = {},
  ) {}

  private now(): Date {
    return new Date(this.options.now?.() ?? Date.now());
  }

  private used(limit: SpendLimit, call: MeteredCall, at: Date): number {
    const { start } = periodWindow(limit.period, at);
    return this.booked
      .filter(
        (b) =>
          b.at >= start &&
          limitApplies(limit, { feature: b.call.feature, userId: b.call.tag.userId }) &&
          (limit.scope !== 'user' || b.call.tag.userId === call.tag.userId),
      )
      .reduce(
        (sum, b) => sum + (limit.metric === 'cost' ? b.costNanos : totalTokens(b.outcome.usage)),
        0,
      );
  }

  async admit(call: MeteredCall): Promise<void> {
    const at = this.now();
    const applicable = this.limits
      .filter((limit) => limitApplies(limit, { feature: call.feature, userId: call.tag.userId }))
      .map((limit) => ({ limit, used: this.used(limit, call, at) }));
    const reached = reachedLimit(applicable, at, call.tag.userId ?? null);
    if (reached) throw new AiSpendLimitError(reached);
  }

  async record(call: MeteredCall, outcome: CallOutcome): Promise<void> {
    const prices = this.options.prices ?? LIST_PRICES;
    const model = priceModelId(outcome.servedModel);
    const price =
      prices.find((p) => p.provider === call.provider && p.model === model) ??
      prices.find((p) => p.provider === call.provider && p.model === call.model);
    const costNanos = price
      ? callCost(outcome.usage, price.price, { batch: call.mode === 'batch' })
      : 0;
    this.booked.push({ call, outcome, costNanos, at: this.now() });
  }
}

// ---------------------------------------------------------------------------------------------
// A virtual clock for agent runs (M1-131): time passes only when a fake says so.

/** An `AgentClock` whose time moves only through `pass`, firing timers as it goes. */
export class VirtualClock {
  private time: number;
  private timers: { at: number; fire: () => void }[] = [];

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  after(ms: number, fire: () => void): () => void {
    const timer = { at: this.time + ms, fire };
    this.timers.push(timer);
    return () => {
      this.timers = this.timers.filter((t) => t !== timer);
    };
  }

  /**
   * Lets `ms` pass, firing the timers that fall due. Stops at the moment `signal` is aborted;
   * answers whether the whole time passed.
   */
  pass(ms: number, signal?: AbortSignal): boolean {
    const end = this.time + ms;
    for (;;) {
      if (signal?.aborted) return false;
      const due = this.timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) {
        this.time = end;
        return true;
      }
      this.time = Math.max(this.time, due.at);
      this.timers = this.timers.filter((t) => t !== due);
      due.fire();
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The live tests, which run only under `pnpm ai:live` (T-333), and what they measured.

/**
 * The key a live test runs with: `TASKMOOR_AI_TEST_KEY`, but only when `pnpm ai:live` started
 * the run, which also names the file for its results (`TASKMOOR_AI_LIVE_RESULTS`). A key left
 * in the environment alone never makes `pnpm verify` call a live model: only the command checks
 * the key for free, prices the run and asks first.
 */
export function liveTestKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const key = env.TASKMOOR_AI_TEST_KEY;
  return key && env.TASKMOOR_AI_LIVE_RESULTS ? key : undefined;
}

/**
 * Appends one measurement of a live test as a JSON line to the file `TASKMOOR_AI_LIVE_RESULTS`
 * names; without it, nothing is written. Measurements are counts, usage and our own wording,
 * never a prompt, an answer or a credential.
 */
export function recordLiveResult(check: string, data: Readonly<Record<string, unknown>>): void {
  const file = process.env.TASKMOOR_AI_LIVE_RESULTS;
  if (!file) return;
  appendFileSync(file, `${JSON.stringify({ ...data, check })}\n`);
}

/** The prompt-injection corpus (M1-118), for the server's harness and M1-079's live run. */
export {
  fill as fillInjection,
  INJECTION_CASES,
  INJECTION_GOALS,
  type InjectionCase,
  type InjectionGoal,
} from './injection/corpus';
