import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AgentTool, runAgent } from '../agent';
import { providerConfigSchema } from '../config';
import { createProviderAdapter } from '../factory';
import { AiGateway } from '../gateway';
import { InMemorySecretStore } from '../secrets';
import { LIST_PRICES } from '../spend';
import { loadFixture, replayFetch } from '../testing';

const secrets = new InMemorySecretStore({ 'anthropic-key': 'test-key-placeholder' });
const OPUS = LIST_PRICES.find((p) => p.provider === 'anthropic' && p.model === 'claude-opus-5-5')
  ?.price as NonNullable<(typeof LIST_PRICES)[number]['price']>;

const findTickets: AgentTool<{ query: string }> = {
  name: 'find_tickets',
  description: 'Search existing tickets with a query.',
  input: z.object({ query: z.string() }),
  run: async () => ({ content: 'WEB-40: Reset email arrives late (Done)', done: 'Found WEB-40' }),
};

async function replay(name: string) {
  const fixture = loadFixture(new URL(`./__fixtures__/anthropic/${name}.json`, import.meta.url));
  const recording = replayFetch(fixture);
  const adapter = await createProviderAdapter(
    providerConfigSchema.parse({ provider: 'anthropic', apiKey: { secretId: 'anthropic-key' } }),
    secrets,
    { fetch: recording.fetch },
  );
  return { gateway: new AiGateway(adapter), recording };
}

const run = {
  feature: 'assisted-creation' as const,
  system: 'Draft tickets from a description. Check for similar tickets before drafting.',
  task: 'Users report that the password reset email arrives after the link has expired.',
  tools: [findTickets],
  price: OPUS,
};

describe('agent runs on the Anthropic API (M1-131, recorded)', () => {
  it('[AI-011] counts each prompt, sends the run’s task budget on every step and runs the tool', async () => {
    const { gateway, recording } = await replay('agent-run');
    const report = await runAgent(gateway, {
      ...run,
      limits: { maxSteps: 5, maxTokens: 30_000, maxWallMs: 60_000 },
    });
    expect(recording.problems()).toEqual([]);
    expect(report).toMatchObject({
      status: 'completed',
      limit: null,
      completed: ['Found WEB-40'],
      answer: 'WEB-40 covered a late email and is done; this looks like a new problem.',
      usage: { inputTokens: 500, outputTokens: 94, cacheReadTokens: 0, cacheWriteTokens: 0 },
      costNanos: 500 * 4_000 + 94 * 20_000,
    });
    expect(report.steps.map((s) => s.maxOutputTokens)).toEqual([16_000, 16_000]);
  });

  it('[AI-011] (1) stops at its cost limit without another call, and reports what it completed', async () => {
    const { gateway, recording } = await replay('agent-budget');
    const report = await runAgent(gateway, {
      ...run,
      limits: { maxSteps: 5, maxTokens: 30_000, maxCostNanos: 22_000_000, maxWallMs: 60_000 },
    });
    // Every recorded request was sent, and nothing after them.
    expect(recording.problems()).toEqual([]);
    expect(report).toMatchObject({
      status: 'budget_reached',
      limit: 'cost',
      completed: ['Found WEB-40'],
      answer: 'I will look for similar tickets first.',
      costNanos: 210 * 4_000 + 64 * 20_000,
    });
    expect(report.steps.map((s) => s.maxOutputTokens)).toEqual([1_047]);
    expect(report.costNanos).toBeLessThanOrEqual(22_000_000);
  });
});
