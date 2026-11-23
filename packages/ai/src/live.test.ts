// Live smoke test against the Anthropic API (M1-073) and the cache read of M1-074. Skipped unless
// TASKMOOR_AI_TEST_KEY holds a key (use a key with a spend limit); `pnpm ai:live` (T-333) runs it
// with the key it asked for and reports what each test measured. The key comes from the
// environment only; it is never written anywhere, and the gateway scrubs it from errors.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_MODEL, providerConfigSchema } from './config';
import { createProviderAdapter } from './factory';
import { AiGateway } from './gateway';
import { InMemorySecretStore } from './secrets';
import { recordLiveResult } from './testing';

const key = process.env.TASKMOOR_AI_TEST_KEY;
/** Another address for the API, such as the fake provider in `pnpm ai:live`'s own test. */
const baseUrl = process.env.TASKMOOR_AI_TEST_BASE_URL;

// A stable prefix well above the minimum cacheable length, with nothing that changes per call.
const RULES = Array.from(
  { length: 40 },
  (_, i) =>
    `Rule ${i + 1}: a summary names the ticket key, states the problem in one sentence, says who is working on it and what the next step is, and adds nothing the ticket does not say.`,
).join('\n');

// The features' own output limit (16,000 tokens): adaptive thinking counts against it.
const summary = {
  feature: 'summarize' as const,
  system: `You summarise work tickets for a project team.\n${RULES}`,
  messages: [
    {
      role: 'user' as const,
      content:
        'Summarise WEB-42. Description: sign-in fails after a password reset. Comments: Sam is investigating.',
    },
  ],
};

describe.skipIf(!key)('live Anthropic API (TASKMOOR_AI_TEST_KEY)', () => {
  async function gateway() {
    const adapter = await createProviderAdapter(
      providerConfigSchema.parse({
        provider: 'anthropic',
        apiKey: { secretId: 'live' },
        ...(baseUrl ? { baseUrl } : {}),
      }),
      new InMemorySecretStore({ live: key ?? '' }),
      { timeoutMs: 120_000 },
    );
    return new AiGateway(adapter, {
      features: {
        summarize: { enabled: true, effort: 'low' },
        'query-from-text': { enabled: true, effort: 'low' },
        'assisted-creation': { enabled: true, effort: 'low' },
      },
    });
  }

  it('[AI-003] answers a summary through the gateway', { timeout: 180_000 }, async () => {
    const ai = await gateway();
    const first = await ai.generate(summary);
    recordLiveResult('smoke', { test: 'answers', model: first.model, refused: first.refused });
    expect(first.refused).toBe(false);
    expect(first.text).toContain('WEB-42');
  });

  it('[AI-008] a repeat call with the same prefix reads the cache', {
    timeout: 180_000,
  }, async () => {
    const ai = await gateway();
    const first = await ai.generate(summary);
    const second = await ai.generate(summary);
    recordLiveResult('cache-read', {
      model: second.model,
      firstCacheWriteTokens: first.usage.cacheWriteTokens,
      firstCacheReadTokens: first.usage.cacheReadTokens,
      cacheReadTokens: second.usage.cacheReadTokens,
    });
    expect(first.usage.cacheWriteTokens + first.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
  });

  it('[AI-007] streams, returns strict structured output and calls a strict tool with automatic choice', {
    timeout: 180_000,
  }, async () => {
    const ai = await gateway();
    const stream = ai.stream(summary);
    let streamed = '';
    for await (const event of stream) if (event.type === 'text') streamed += event.text;
    expect(streamed.length).toBeGreaterThan(0);
    expect((await stream.result).text).toBe(streamed);

    const query = await ai.generate({
      feature: 'query-from-text',
      system:
        'Turn a question about tickets into a query. Fields: assignee, type, status, updated.',
      messages: [{ role: 'user', content: 'my open bugs updated this week' }],
      schema: z.object({ query: z.string().min(1), explanation: z.string() }),
    });
    expect(query.parsed?.query).toBeTruthy();

    const drafted = await ai.generate({
      feature: 'assisted-creation',
      system: 'Before drafting a ticket, always search for similar tickets with find_tickets.',
      messages: [
        { role: 'user', content: 'The password reset email arrives after the link expired.' },
      ],
      tools: [
        {
          name: 'find_tickets',
          description: 'Search existing tickets with a short text query.',
          input: z.object({ query: z.string() }),
        },
      ],
    });
    recordLiveResult('smoke', {
      test: 'stream-structured-tool',
      model: drafted.model,
      repaired: query.repaired,
      stopReason: drafted.stopReason,
      toolCalls: drafted.toolCalls.length,
    });
    expect(drafted.stopReason === 'tool_use' || drafted.stopReason === 'end_turn').toBe(true);
    for (const call of drafted.toolCalls) expect(call.name).toBe('find_tickets');
  });

  it('[AI-001] [AI-002] counts tokens and lists models live', { timeout: 60_000 }, async () => {
    const ai = await gateway();
    const counted = await ai.countTokens(summary);
    const models = await ai.listModels();
    recordLiveResult('smoke', {
      test: 'count-and-list',
      inputTokens: counted,
      models: models.length,
      defaultModelListed: models.some((m) => m.id === DEFAULT_MODEL),
    });
    expect(counted).toBeGreaterThan(500);
    expect(models.map((m) => m.id)).toContain(DEFAULT_MODEL);
  });
});
