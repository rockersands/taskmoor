import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  AiAbortedError,
  AiCircuitOpenError,
  AiFeatureDisabledError,
  AiOutputError,
  AiPolicyError,
  AiProviderError,
  AiUnsupportedError,
} from './errors';
import { AI_FEATURES } from './features';
import { AiGateway, type AiGatewayOptions, type StreamEvent } from './gateway';
import type { RetryOptions } from './retry';
import { FakeAdapter, FakeProviderFailure } from './testing';

const request = {
  feature: 'assisted-creation' as const,
  system: 'Draft tickets.',
  messages: [{ role: 'user' as const, content: 'A login bug' }],
};

const noWait: Partial<RetryOptions> = { sleep: async () => {}, random: () => 0.5 };

function gatewayFor(adapter: FakeAdapter, options: AiGatewayOptions = {}) {
  return new AiGateway(adapter, { ...options, retry: { ...noWait, ...options.retry } });
}

describe('feature settings', () => {
  it('[AI-006] defaults every feature to claude-opus-5-5 with the effort of the spec, a cached prefix and room for thinking', async () => {
    const expected = {
      summarize: 'low',
      'query-from-text': 'low',
      'assisted-creation': 'medium',
      duplicates: 'low',
    } as const;
    for (const [feature, effort] of Object.entries(expected)) {
      const adapter = new FakeAdapter();
      await gatewayFor(adapter).generate({ ...request, feature: feature as keyof typeof expected });
      expect(adapter.requests[0]).toEqual({
        model: 'claude-opus-5-5',
        system: 'Draft tickets.',
        messages: request.messages,
        maxTokens: 16_000,
        effort,
        cacheSystem: true,
      });
    }
    expect(Object.keys(AI_FEATURES).sort()).toEqual(Object.keys(expected).sort());
  });

  it('[AI-006] an administrator’s change to Haiku and low effort takes effect on the next call', async () => {
    const adapter = new FakeAdapter();
    const features: NonNullable<AiGatewayOptions['features']> = {};
    const gateway = gatewayFor(adapter, { features });
    await gateway.generate(request);
    features['assisted-creation'] = { enabled: true, model: 'claude-haiku-5-5', effort: 'low' };
    await gateway.generate(request);
    expect(adapter.requests.map((r) => [r.model, r.effort])).toEqual([
      ['claude-opus-5-5', 'medium'],
      ['claude-haiku-5-5', 'low'],
    ]);
  });

  it('[AI-006] honours a per-call output limit, context and cache opt-out', async () => {
    const adapter = new FakeAdapter();
    await gatewayFor(adapter).generate({
      ...request,
      context: 'Track WEB.',
      maxOutputTokens: 256,
      cacheSystem: false,
    });
    expect(adapter.requests[0]).toMatchObject({
      maxTokens: 256,
      cacheSystem: false,
      context: 'Track WEB.',
    });
  });

  it('[AI-001] refuses to run a feature the administrator turned off, without calling the provider', async () => {
    const adapter = new FakeAdapter();
    const gateway = gatewayFor(adapter, {
      features: { 'assisted-creation': { enabled: false } },
    });
    await expect(gateway.generate(request)).rejects.toBeInstanceOf(AiFeatureDisabledError);
    expect(gateway.availability('assisted-creation')).toEqual({
      available: false,
      reason: 'disabled',
    });
    expect(adapter.requests).toHaveLength(0);
  });
});

describe('capabilities', () => {
  it('[AI-002] hides a feature whose capability the model lacks, and says which', () => {
    const gateway = gatewayFor(
      new FakeAdapter([{}], { capabilities: { structuredOutput: false } }),
    );
    expect(gateway.availability('summarize')).toEqual({ available: true });
    expect(gateway.availability('query-from-text')).toEqual({
      available: false,
      reason: 'unsupported',
      missing: ['structuredOutput'],
    });
  });

  it('[AI-002] [AI-004] never sends a schema or tools to a model that cannot take them', async () => {
    const adapter = new FakeAdapter([{}], {
      capabilities: { structuredOutput: false, toolCalls: false, tokenCounting: false },
    });
    const gateway = gatewayFor(adapter);
    await expect(
      gateway.generate({ ...request, schema: z.object({ a: z.string() }) }),
    ).rejects.toMatchObject({ capability: 'structuredOutput' });
    await expect(
      gateway.generate({
        ...request,
        tools: [{ name: 'find', description: 'Find.', input: z.object({ q: z.string() }) }],
      }),
    ).rejects.toMatchObject({ capability: 'toolCalls' });
    await expect(gateway.countTokens(request)).rejects.toBeInstanceOf(AiUnsupportedError);
    await expect(
      gateway.submitBatch({ feature: 'duplicates', system: 'x', items: [] }),
    ).rejects.toBeInstanceOf(AiUnsupportedError);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe('structured output', () => {
  const schema = z.object({ title: z.string().min(3) });

  it('[AI-007] an invalid structured result gets one repair attempt that sees the mistake', async () => {
    const adapter = new FakeAdapter([
      { text: '{"title": "ab"}' },
      { text: '{"title": "Login bug"}' },
    ]);
    const result = await gatewayFor(adapter).generate({ ...request, schema });
    expect(result).toMatchObject({ parsed: { title: 'Login bug' }, repaired: true });
    expect(result.usage).toEqual({
      inputTokens: 2,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    const repair = adapter.requests[1];
    expect(repair?.messages).toEqual([
      ...request.messages,
      { role: 'assistant', content: '{"title": "ab"}' },
      { role: 'user', content: expect.stringContaining('title') },
    ]);
    expect(repair?.jsonSchema).toEqual(adapter.requests[0]?.jsonSchema);
  });

  it('[AI-007] a second invalid result is an error, and invalid data is never returned', async () => {
    const adapter = new FakeAdapter([{ text: 'Sure! Here it is' }, { text: '{"title": 5}' }]);
    const error = await gatewayFor(adapter)
      .generate({ ...request, schema })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiOutputError);
    expect((error as Error).message).toContain('title');
    expect(adapter.requests).toHaveLength(2);
  });

  it('[AI-007] an answer cut off at the output limit is not repaired or trusted', async () => {
    const adapter = new FakeAdapter([{ text: '{"title": "Lo', stopReason: 'max_tokens' }]);
    await expect(gatewayFor(adapter).generate({ ...request, schema })).rejects.toThrow(/cut off/);
    expect(adapter.requests).toHaveLength(1);
  });

  it('[AI-009] a refusal is data: no parsed value, no repair, no text', async () => {
    const adapter = new FakeAdapter([
      { refused: true, stopReason: 'refusal', refusalCategory: 'cyber' },
    ]);
    const result = await gatewayFor(adapter).generate({ ...request, schema });
    expect(result).toMatchObject({ refused: true, parsed: undefined, text: '', toolCalls: [] });
    expect(adapter.requests).toHaveLength(1);
  });
});

describe('tool calls', () => {
  const tools = [
    {
      name: 'find_tickets',
      description: 'Search tickets.',
      input: z.object({ query: z.string().trim() }),
    },
  ];
  const call = (name: string, input: unknown) => ({
    toolCalls: [{ id: 't1', name, input }],
    stopReason: 'tool_use' as const,
  });

  it('[AI-007] returns tool inputs only after they pass the tool’s schema', async () => {
    const adapter = new FakeAdapter([call('find_tickets', { query: '  status = Open ' })]);
    const result = await gatewayFor(adapter).generate({ ...request, tools });
    expect(result.toolCalls).toEqual([
      { id: 't1', name: 'find_tickets', input: { query: 'status = Open' } },
    ]);
    expect(adapter.requests[0]?.tools).toEqual([
      {
        name: 'find_tickets',
        description: 'Search tickets.',
        inputSchema: {
          type: 'object',
          properties: { query: { type: 'string' } },
          additionalProperties: false,
          required: ['query'],
        },
      },
    ]);
  });

  it('[AI-007] rejects calls to unknown tools, invalid inputs and cut-off calls', async () => {
    for (const step of [
      call('drop_tables', {}),
      call('find_tickets', { query: 7 }),
      { ...call('find_tickets', { query: 'x' }), stopReason: 'max_tokens' as const },
    ]) {
      await expect(
        gatewayFor(new FakeAdapter([step])).generate({ ...request, tools }),
      ).rejects.toBeInstanceOf(AiOutputError);
    }
  });

  it('[AI-007] refuses badly named or duplicate tools before calling the provider', async () => {
    const adapter = new FakeAdapter();
    const gateway = gatewayFor(adapter);
    await expect(
      gateway.generate({ ...request, tools: [{ ...tools[0], name: 'find tickets' }] as never }),
    ).rejects.toBeInstanceOf(AiPolicyError);
    await expect(
      gateway.generate({ ...request, tools: [tools[0], tools[0]] as never }),
    ).rejects.toBeInstanceOf(AiPolicyError);
    expect(adapter.requests).toHaveLength(0);
  });
});

describe('retries and outages', () => {
  it('[AI-009] retries 429, 5xx, overloads, timeouts and lost connections, logging each retry', async () => {
    const logger = { warn: vi.fn() };
    const adapter = new FakeAdapter([
      new FakeProviderFailure('rate_limited', 'slow down', 429),
      new FakeProviderFailure('connection'),
      { text: 'done' },
    ]);
    const result = await gatewayFor(adapter, { logger }).generate(request);
    expect(result).toMatchObject({ text: 'done', retries: 2 });
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({
      provider: 'anthropic',
      feature: 'assisted-creation',
      retry: 1,
      kind: 'rate_limited',
      status: 429,
    });
  });

  it('[AI-009] gives up after the configured retries and does not retry request errors', async () => {
    const overloaded = new FakeAdapter([new FakeProviderFailure('overloaded', 'busy', 529)]);
    await expect(
      gatewayFor(overloaded, { retry: { ...noWait, maxRetries: 2 } }).generate(request),
    ).rejects.toMatchObject({ kind: 'overloaded', retryable: true });
    expect(overloaded.requests).toHaveLength(3);

    const invalid = new FakeAdapter([new FakeProviderFailure('invalid_request', 'bad', 400)]);
    await expect(gatewayFor(invalid).generate(request)).rejects.toMatchObject({
      kind: 'invalid_request',
      retryable: false,
    });
    expect(invalid.requests).toHaveLength(1);
  });

  it('[AI-009] does not wait for a Retry-After beyond the limit', async () => {
    const adapter = new FakeAdapter([
      new FakeProviderFailure('rate_limited', 'later', 429, 600_000),
    ]);
    await expect(gatewayFor(adapter).generate(request)).rejects.toBeInstanceOf(AiProviderError);
    expect(adapter.requests).toHaveLength(1);
  });

  it('[AI-009] a provider that keeps failing trips the circuit breaker; calls then fail at once until a trial succeeds', async () => {
    let now = 0;
    const adapter = new FakeAdapter([
      new FakeProviderFailure('server', 'down', 500),
      new FakeProviderFailure('server', 'down', 500),
      { text: 'back' },
    ]);
    const gateway = gatewayFor(adapter, {
      retry: { ...noWait, maxRetries: 0 },
      breaker: { failureThreshold: 2, cooldownMs: 10_000 },
      now: () => now,
    });
    await expect(gateway.generate(request)).rejects.toBeInstanceOf(AiProviderError);
    await expect(gateway.generate(request)).rejects.toBeInstanceOf(AiProviderError);
    const open = await gateway.generate(request).catch((e: unknown) => e);
    expect(open).toBeInstanceOf(AiCircuitOpenError);
    expect((open as AiCircuitOpenError).retryAt).toBe(10_000);
    expect(adapter.requests).toHaveLength(2);

    now = 10_000;
    expect((await gateway.generate(request)).text).toBe('back');
    expect(adapter.requests).toHaveLength(3);
  });

  it('[AI-009] scrubs credentials from provider errors and attaches no raw cause', async () => {
    const adapter = new FakeAdapter(
      [new FakeProviderFailure('authentication', '401 for key secret-placeholder-1234')],
      {
        secretValues: ['secret-placeholder-1234'],
      },
    );
    const error = await gatewayFor(adapter)
      .generate(request)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as Error).message).toBe('anthropic: 401 for key [redacted]');
    expect((error as Error).cause).toBeUndefined();
  });
});

describe('streaming', () => {
  async function drain(stream: AsyncIterable<StreamEvent>) {
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    return events;
  }

  it('[AI-007] yields text as it arrives, then settles with the whole answer', async () => {
    const adapter = new FakeAdapter([{ text: 'Hello world' }], { deltas: ['Hello', ' world'] });
    const stream = gatewayFor(adapter).stream({ ...request, feature: 'summarize' });
    expect(await drain(stream)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
    ]);
    expect((await stream.result).text).toBe('Hello world');
  });

  it('[AI-007] cancel stops the stream: iteration ends and the result is an abort', async () => {
    const adapter = new FakeAdapter([{ text: 'a b c' }], { deltas: ['a', ' b', ' c'] });
    const stream = gatewayFor(adapter).stream({ ...request, feature: 'summarize' });
    const seen: string[] = [];
    for await (const event of stream) {
      if (event.type === 'text') seen.push(event.text);
      break; // leaving the loop cancels
    }
    expect(seen).toEqual(['a']);
    await expect(stream.result).rejects.toBeInstanceOf(AiAbortedError);
  });

  it('[AI-007] a caller’s abort signal cancels the stream', async () => {
    const controller = new AbortController();
    controller.abort();
    const stream = gatewayFor(new FakeAdapter()).stream(
      { ...request, feature: 'summarize' },
      { signal: controller.signal },
    );
    await expect(drain(stream)).rejects.toBeInstanceOf(AiAbortedError);
  });

  it('[AI-009] retries a stream that failed before any text, but not one that failed midway', async () => {
    const early = new FakeAdapter([new FakeProviderFailure('overloaded'), { text: 'ok' }]);
    const recovered = gatewayFor(early).stream({ ...request, feature: 'summarize' });
    expect(await drain(recovered)).toEqual([{ type: 'text', text: 'ok' }]);
    expect((await recovered.result).retries).toBe(1);

    let calls = 0;
    const midway = new FakeAdapter();
    midway.stream = async (_request, options) => {
      calls += 1;
      options.onText('partial');
      throw new FakeProviderFailure('overloaded');
    };
    const failed = gatewayFor(midway).stream({ ...request, feature: 'summarize' });
    await expect(drain(failed)).rejects.toMatchObject({ kind: 'overloaded' });
    expect(calls).toBe(1);
  });

  it('[AI-009] a refusal emits refused, so partial text is discarded', async () => {
    const adapter = new FakeAdapter(
      [{ refused: true, stopReason: 'refusal', refusalCategory: 'cyber', text: '' }],
      { deltas: ['Here is'] },
    );
    const stream = gatewayFor(adapter).stream({ ...request, feature: 'summarize' });
    expect(await drain(stream)).toEqual([
      { type: 'text', text: 'Here is' },
      { type: 'refused', category: 'cyber' },
    ]);
    expect(await stream.result).toMatchObject({ refused: true, text: '' });
  });
});

describe('batches', () => {
  it('[AI-008] validates item IDs before anything is sent', async () => {
    const adapter = new FakeAdapter([{}], { capabilities: { batches: true } });
    const submitted: unknown[] = [];
    Object.assign(adapter, {
      batches: {
        submit: async (items: unknown[]) => {
          submitted.push(...items);
          return { id: 'b1' };
        },
      },
    });
    const gateway = gatewayFor(adapter);
    const batch = (ids: string[]) => ({
      feature: 'duplicates' as const,
      system: 'x',
      items: ids.map((id) => ({ id, messages: [{ role: 'user' as const, content: id }] })),
    });
    await expect(gateway.submitBatch(batch([]))).rejects.toBeInstanceOf(AiPolicyError);
    await expect(gateway.submitBatch(batch(['WEB 1']))).rejects.toBeInstanceOf(AiPolicyError);
    await expect(gateway.submitBatch(batch(['WEB-1', 'WEB-1']))).rejects.toBeInstanceOf(
      AiPolicyError,
    );
    expect(submitted).toEqual([]);
    await gateway.submitBatch(batch(['WEB-1', 'WEB-2']));
    expect(submitted).toHaveLength(2);
  });
});
