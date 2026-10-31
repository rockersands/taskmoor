import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AiAbortedError, AiOutputError, AiProviderError, AiSpendLimitError } from './errors';
import { AiGateway, type AiGatewayOptions } from './gateway';
import { placeholder } from './redact';
import type { RetryOptions } from './retry';
import type { SpendLimit } from './spend';
import { FakeAdapter, FakeProviderFailure, MemoryMeter } from './testing';

const noWait: Partial<RetryOptions> = { sleep: async () => {}, random: () => 0.5 };
const usage = { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
const request = {
  feature: 'summarize' as const,
  system: 'Summarise the ticket.',
  messages: [{ role: 'user' as const, content: 'WEB-1: login fails' }],
  tag: { userId: 7 },
};

function gatewayFor(adapter: FakeAdapter, options: AiGatewayOptions = {}) {
  return new AiGateway(adapter, { ...options, retry: { ...noWait, ...options.retry } });
}

const tokensPerDay = (amount: number, over: Partial<SpendLimit> = {}): SpendLimit => ({
  id: 1,
  scope: 'workspace',
  feature: null,
  userId: null,
  period: 'day',
  metric: 'tokens',
  amount,
  ...over,
});

describe('spend limits in the gateway (M1-077)', () => {
  it('[OPS-020] (1) calls stop at the cap: the provider is not called once a limit is reached', async () => {
    const adapter = new FakeAdapter([{ text: 'ok', usage }]);
    const meter = new MemoryMeter([tokensPerDay(1_000)]);
    const gateway = gatewayFor(adapter, { meter });
    for (let i = 0; i < 3; i += 1) await gateway.generate(request);
    expect(adapter.requests).toHaveLength(3); // 400, 800, then 1,200 tokens
    const refused = await gateway.generate(request).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(AiSpendLimitError);
    expect((refused as AiSpendLimitError).limit).toMatchObject({
      scope: 'workspace',
      period: 'day',
      metric: 'tokens',
      amount: 1_000,
      used: 1_200,
    });
    // Streams are refused the same way, before anything is sent.
    const stream = gateway.stream(request);
    await expect(stream.result).rejects.toBeInstanceOf(AiSpendLimitError);
    expect(adapter.requests).toHaveLength(3);
    expect(meter.booked.map((b) => b.outcome.status)).toEqual([
      'ok',
      'ok',
      'ok',
      'limited',
      'limited',
    ]);
  });

  it('[OPS-020] a cost limit, a feature limit and a person’s limit each count only their calls', async () => {
    const adapter = new FakeAdapter([{ text: 'ok', usage }]);
    // One call on Opus costs 300 * 4,000 + 100 * 20,000 = 3,200,000 nanos.
    const meter = new MemoryMeter([
      tokensPerDay(3_200_000, {
        id: 'cost',
        metric: 'cost',
        scope: 'feature',
        feature: 'duplicates',
      }),
      tokensPerDay(400, { id: 'ada', scope: 'user', userId: 7 }),
    ]);
    const gateway = gatewayFor(adapter, { meter });
    await gateway.generate(request);
    await expect(gateway.generate(request)).rejects.toBeInstanceOf(AiSpendLimitError);
    // Someone else still gets through, and so does the system.
    await gateway.generate({ ...request, tag: { userId: 8 } });
    await gateway.generate({ ...request, tag: {} });
    await gateway.generate({ ...request, feature: 'duplicates', tag: { userId: 9 } });
    const limited = await gateway
      .generate({ ...request, feature: 'duplicates', tag: { userId: 9 } })
      .catch((e: unknown) => e);
    expect((limited as AiSpendLimitError).limit).toMatchObject({
      limitId: 'cost',
      used: 3_200_000,
    });
    expect(meter.booked.map((b) => b.costNanos)).toEqual([
      3_200_000, 0, 3_200_000, 3_200_000, 3_200_000, 0,
    ]);
  });

  it('[IAM-021] books one row per call whatever its outcome, with the tokens billed', async () => {
    const adapter = new FakeAdapter([
      { text: 'fine', usage },
      { refused: true, refusalCategory: 'cyber', stopReason: 'refusal', usage },
      new FakeProviderFailure('invalid_request', 'bad request', 400),
      { text: 'not json', usage },
      { text: 'still not json', usage },
    ]);
    const meter = new MemoryMeter();
    const gateway = gatewayFor(adapter, { meter });
    await gateway.generate(request);
    await gateway.generate(request);
    await expect(gateway.generate(request)).rejects.toBeInstanceOf(AiProviderError);
    // An invalid answer, and the repair attempt that failed too: one call, both billed.
    await expect(
      gateway.generate({
        ...request,
        feature: 'duplicates',
        schema: z.object({ ids: z.array(z.number()) }),
      }),
    ).rejects.toBeInstanceOf(AiOutputError);
    expect(adapter.requests).toHaveLength(5);
    expect(
      meter.booked.map((b) => [
        b.call.feature,
        b.call.tag.userId,
        b.outcome.status,
        b.outcome.errorKind ?? null,
        b.outcome.usage.inputTokens,
      ]),
    ).toEqual([
      ['summarize', 7, 'ok', null, 300],
      ['summarize', 7, 'refused', null, 300],
      ['summarize', 7, 'error', 'invalid_request', 0],
      ['duplicates', 7, 'error', 'invalid_output', 600],
    ]);
  });

  it('[IAM-021] books a cancelled stream as aborted and a finished one with its answer', async () => {
    const adapter = new FakeAdapter([{ text: 'one two', usage }], { deltas: ['one ', 'two'] });
    const meter = new MemoryMeter();
    const gateway = gatewayFor(adapter, { meter });
    const done = await gateway.stream(request).result;
    expect(done.text).toBe('one two');
    const cancelled = gateway.stream(request);
    for await (const _event of cancelled) break; // leaving the loop cancels
    await expect(cancelled.result).rejects.toBeInstanceOf(AiAbortedError);
    expect(meter.booked.map((b) => [b.call.mode, b.outcome.status])).toEqual([
      ['stream', 'ok'],
      ['stream', 'aborted'],
    ]);
    expect(meter.booked[0]?.outcome.content?.answer).toBe('one two');
  });
});

describe('redaction in the gateway (M1-077)', () => {
  it('[IAM-022] (1) captured requests carry placeholders, never the redacted values', async () => {
    const adapter = new FakeAdapter([
      { text: 'not json', usage },
      { text: '{"ids":[1]}', usage },
    ]);
    const gateway = gatewayFor(adapter, {
      redaction: () => ({ patterns: ['card-number'], terms: ['Heron'] }),
    });
    const secret = { value: 'ACCT-7731-SECRET', label: 'Account number' };
    await gateway.generate({
      feature: 'duplicates',
      system: 'Find duplicates for Heron.',
      context: 'Track HERON',
      messages: [
        {
          role: 'user',
          content: 'Refund card 4111 1111 1111 1111 for account acct-7731-secret.',
        },
      ],
      schema: z.object({ ids: z.array(z.number()) }),
      sensitive: [secret],
    });
    await gateway.countTokens({
      feature: 'summarize',
      system: 'x',
      messages: [{ role: 'user', content: 'ACCT-7731-SECRET' }],
      sensitive: [secret],
    });
    // The first answer, the repair attempt and the token count all went out redacted.
    expect(adapter.requests).toHaveLength(3);
    const captured = JSON.stringify(adapter.requests);
    expect(captured).not.toMatch(/4111|acct-7731|heron/i);
    expect(captured).toContain(placeholder('card number'));
    expect(captured).toContain(placeholder('Account number'));
  });

  it('[IAM-022] keeps what was sent, redacted, for content logging', async () => {
    const adapter = new FakeAdapter([{ text: 'ok', usage }]);
    const meter = new MemoryMeter();
    const gateway = gatewayFor(adapter, {
      meter,
      redaction: () => ({ patterns: ['us-ssn'], terms: [] }),
    });
    await gateway.generate({
      ...request,
      messages: [{ role: 'user', content: 'SSN 123-45-6789' }],
    });
    expect(JSON.stringify(meter.booked[0]?.outcome.content?.request)).not.toContain('123-45-6789');
  });
});
