// Contract tests against recorded Ollama and vLLM exchanges. No server, no network.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { providerConfigSchema } from '../config';
import { AiUnsupportedError } from '../errors';
import { createProviderAdapter } from '../factory';
import { AiGateway, type StreamEvent } from '../gateway';
import { InMemorySecretStore } from '../secrets';
import { loadFixture, replayFetch } from '../testing';

const SYSTEM_SUMMARY =
  'You summarise work tickets for a project team. Keep to the facts in the ticket: purpose, status, who is working on it and what happens next.';
const CONTEXT = 'Track WEB is the public website. Ticket keys look like WEB-123.';
const USER_SUMMARY =
  'Summarise WEB-42. Description: sign-in fails after a password reset. Comments: Sam is investigating; the fix belongs in the session service.';
const ANSWER_SUMMARY =
  'WEB-42: sign-in fails after a password reset. Sam is investigating; the next step is a fix in the session service.';
const summary = {
  feature: 'summarize' as const,
  system: SYSTEM_SUMMARY,
  context: CONTEXT,
  messages: [{ role: 'user' as const, content: USER_SUMMARY }],
};

const secrets = new InMemorySecretStore({ 'local-key': 'test-local-key-placeholder' });

/** vLLM with a key; tool support stated as absent, so nothing is detected. */
const vllm = {
  provider: 'openai-compatible',
  baseUrl: 'http://vllm.internal:8000/v1',
  model: 'llama3.3',
  apiKey: { secretId: 'local-key' },
  capabilities: { toolCalls: false },
};

async function replay(name: string, config: unknown, waits: number[] = []) {
  const fixture = loadFixture(
    new URL(`./__fixtures__/openai-compatible/${name}.json`, import.meta.url),
  );
  const recording = replayFetch(fixture);
  const adapter = await createProviderAdapter(providerConfigSchema.parse(config), secrets, {
    fetch: recording.fetch,
  });
  const gateway = new AiGateway(adapter, {
    retry: {
      random: () => 0.5,
      sleep: async (ms) => {
        waits.push(ms);
      },
    },
  });
  return { gateway, recording };
}

describe('OpenAI-compatible servers', () => {
  it('[AI-004] summarises with one chat completion: system prompt first, no effort or caching fields', async () => {
    const { gateway, recording } = await replay('summary', vllm);
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result).toMatchObject({
      text: ANSWER_SUMMARY,
      stopReason: 'end_turn',
      refused: false,
      model: 'llama3.3',
      provider: 'openai-compatible',
    });
    // Cached prompt tokens are reported apart from the full-price remainder.
    expect(result.usage).toEqual({
      inputTokens: 30,
      outputTokens: 35,
      cacheReadTokens: 100,
      cacheWriteTokens: 0,
    });
  });

  it('[AI-004] [AI-007] offers strict tools when Ollama reports that the model supports them', async () => {
    const { gateway, recording } = await replay('ollama-tools', {
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'qwen3',
    });
    expect(gateway.capabilities('assisted-creation')).toMatchObject({
      toolCalls: true,
      structuredOutput: true,
    });
    const result = await gateway.generate({
      feature: 'assisted-creation',
      system: 'Draft tickets from a description. Check for similar tickets before drafting.',
      messages: [
        {
          role: 'user',
          content: 'Users report that the password reset email arrives after the link has expired.',
        },
      ],
      tools: [
        {
          name: 'find_tickets',
          description: 'Search existing tickets with a query.',
          input: z.object({ query: z.string() }),
        },
        {
          name: 'draft_ticket',
          description: 'Propose a ticket for the user to review.',
          input: z.object({ summary: z.string() }),
        },
      ],
    });
    expect(recording.problems()).toEqual([]);
    expect(result.stopReason).toBe('tool_use');
    expect(result.toolCalls).toEqual([
      { id: 'call_fixture_01', name: 'find_tickets', input: { query: 'text ~ "password reset"' } },
    ]);
  });

  it('[AI-004] a model without tool calling never receives tools', async () => {
    const { gateway, recording } = await replay('detect-unsupported', {
      provider: 'openai-compatible',
      baseUrl: 'http://vllm.internal:8000/v1',
      model: 'llama3.3',
      apiKey: { secretId: 'local-key' },
    });
    expect(gateway.capabilities('assisted-creation').toolCalls).toBe(false);
    await expect(
      gateway.generate({
        feature: 'assisted-creation',
        system: 'Draft tickets.',
        messages: [{ role: 'user', content: 'x' }],
        tools: [
          { name: 'find_tickets', description: 'Search.', input: z.object({ q: z.string() }) },
        ],
      }),
    ).rejects.toBeInstanceOf(AiUnsupportedError);
    // Only the capability probe went out; no chat request carried tools.
    expect(recording.problems()).toEqual([]);
  });

  it('[AI-007] asks for a strict JSON schema answer and validates it', async () => {
    const { gateway, recording } = await replay('structured', vllm);
    const result = await gateway.generate({
      feature: 'query-from-text',
      system: "Turn a question about tickets into a query in the tracker's query language.",
      messages: [{ role: 'user', content: 'my open bugs updated this week' }],
      schema: z.object({ query: z.string(), explanation: z.string() }),
    });
    expect(recording.problems()).toEqual([]);
    expect(result.parsed).toMatchObject({ query: expect.stringContaining('type = Bug') });
  });

  it('[AI-007] streams content deltas and reads usage from the last chunk', async () => {
    const { gateway, recording } = await replay('stream', vllm);
    const stream = gateway.stream(summary);
    const events: StreamEvent[] = [];
    for await (const event of stream) events.push(event);
    const result = await stream.result;
    expect(recording.problems()).toEqual([]);
    expect(events.map((e) => (e.type === 'text' ? e.text : e.type)).join('')).toBe(ANSWER_SUMMARY);
    expect(result).toMatchObject({ text: ANSWER_SUMMARY, stopReason: 'end_turn' });
    expect(result.usage).toMatchObject({ inputTokens: 130, outputTokens: 35 });
  });

  it('[AI-001] lists the models the server offers', async () => {
    const { gateway, recording } = await replay('models', vllm);
    expect(await gateway.listModels()).toEqual([{ id: 'llama3.3' }, { id: 'qwen3' }]);
    expect(recording.problems()).toEqual([]);
  });

  it('[AI-009] retries a 503 after the wait the server asked for', async () => {
    const waits: number[] = [];
    const { gateway, recording } = await replay('unavailable-retry', vllm, waits);
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result).toMatchObject({ text: ANSWER_SUMMARY, retries: 1 });
    expect(waits).toEqual([0]);
  });

  it('[AI-002] has no effort, prompt caching, token counting or batches, and says so', async () => {
    const { gateway, recording } = await replay('summary', vllm);
    expect(gateway.capabilities('summarize')).toMatchObject({
      effort: false,
      promptCaching: false,
      tokenCounting: false,
      batches: false,
      refusalFallback: 'none',
    });
    await expect(gateway.countTokens(summary)).rejects.toBeInstanceOf(AiUnsupportedError);
    expect(recording.calls).toEqual([]);
  });
});
