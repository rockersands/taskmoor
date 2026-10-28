// Contract tests: each request is compared with a recorded fixture (written from the documented
// API shapes) and answered with the recorded response. No key, no network.
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { type AiSettings, providerConfigSchema } from '../config';
import { AiProviderError, AiUnsupportedError } from '../errors';
import { createProviderAdapter } from '../factory';
import { AiGateway, type AiLogger, type StreamEvent } from '../gateway';
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

// Placeholders only: no credential, real or fake-but-real-looking, is ever stored in the repo.
const secrets = new InMemorySecretStore({
  'anthropic-key': 'test-key-placeholder',
  'aws-access-key': 'test-access-key-placeholder',
  'aws-secret-key': 'test-secret-placeholder',
  'bedrock-key': 'test-bedrock-key-placeholder',
  'gcp-token': 'test-token-placeholder',
  'foundry-key': 'test-foundry-key-placeholder',
});

const configs = {
  anthropic: { provider: 'anthropic', apiKey: { secretId: 'anthropic-key' } },
  bedrock: {
    provider: 'bedrock',
    region: 'eu-west-1',
    accessKeyId: { secretId: 'aws-access-key' },
    secretAccessKey: { secretId: 'aws-secret-key' },
  },
  vertex: {
    provider: 'vertex',
    region: 'global',
    projectId: 'taskmoor-fixture',
    accessToken: { secretId: 'gcp-token' },
  },
  foundry: {
    provider: 'foundry',
    resource: 'taskmoor-fixture',
    apiKey: { secretId: 'foundry-key' },
  },
};

async function replay(
  platform: string,
  name: string,
  config: unknown,
  options: { features?: AiSettings['features']; logger?: AiLogger; waits?: number[] } = {},
) {
  const fixture = loadFixture(new URL(`./__fixtures__/${platform}/${name}.json`, import.meta.url));
  const recording = replayFetch(fixture);
  const adapter = await createProviderAdapter(providerConfigSchema.parse(config), secrets, {
    fetch: recording.fetch,
  });
  const gateway = new AiGateway(adapter, {
    ...(options.features ? { features: options.features } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    retry: {
      random: () => 0.5,
      sleep: async (ms) => {
        options.waits?.push(ms);
      },
    },
  });
  return { gateway, recording };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

const platforms = [
  { name: 'Anthropic API', dir: 'anthropic', config: configs.anthropic, served: 'claude-opus-5-5' },
  {
    name: 'Amazon Bedrock',
    dir: 'bedrock',
    config: configs.bedrock,
    served: 'anthropic.claude-opus-5-5',
  },
  {
    name: 'Google Cloud Vertex AI',
    dir: 'vertex',
    config: configs.vertex,
    served: 'claude-opus-5-5',
  },
  { name: 'Microsoft Foundry', dir: 'foundry', config: configs.foundry, served: 'claude-opus-5-5' },
];

describe.each(platforms)('$name', ({ dir, config, served }) => {
  it('[AI-003] [AI-006] [AI-008] summarises a ticket with a cached prefix, adaptive thinking and an explicit effort', async () => {
    const { gateway, recording } = await replay(dir, 'summary', config);
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result).toMatchObject({
      text: ANSWER_SUMMARY,
      stopReason: 'end_turn',
      refused: false,
      fellBack: false,
      model: served,
      provider: dir,
    });
    expect(result.usage).toEqual({
      inputTokens: 96,
      outputTokens: 41,
      cacheReadTokens: 0,
      cacheWriteTokens: 1450,
    });
    // The assistant turn keeps the thinking block, to be sent back unchanged.
    expect(result.message.native).toEqual({
      format: 'claude-messages',
      content: [
        { type: 'thinking', thinking: '', signature: 'signature-placeholder' },
        { type: 'text', text: ANSWER_SUMMARY },
      ],
    });
  });

  it('[AI-007] streams a summary: text deltas first, then the whole answer', async () => {
    const { gateway, recording } = await replay(dir, 'stream', config);
    const stream = gateway.stream(summary);
    const events = await collect(stream);
    const result = await stream.result;
    expect(recording.problems()).toEqual([]);
    expect(events).toEqual([
      { type: 'text', text: 'WEB-42: sign-in fails after a password reset. ' },
      {
        type: 'text',
        text: 'Sam is investigating; the next step is a fix in the session service.',
      },
    ]);
    expect(result).toMatchObject({ text: ANSWER_SUMMARY, stopReason: 'end_turn', model: served });
    expect(result.usage).toMatchObject({ inputTokens: 110, outputTokens: 38 });
  });
});

describe('Anthropic API', () => {
  const config = configs.anthropic;

  it('[AI-008] a repeat call with the same prefix reports cache-read tokens above zero', async () => {
    const { gateway, recording } = await replay('anthropic', 'cache-repeat', config);
    const first = await gateway.generate(summary);
    const second = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(first.usage.cacheWriteTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBeGreaterThan(0);
    expect(second.usage.cacheReadTokens).toBe(first.usage.cacheWriteTokens);
  });

  it('[AI-007] asks for strict structured output and returns the validated answer', async () => {
    const { gateway, recording } = await replay('anthropic', 'structured', config);
    const result = await gateway.generate({
      feature: 'query-from-text',
      system: "Turn a question about tickets into a query in the tracker's query language.",
      messages: [{ role: 'user', content: 'my open bugs updated this week' }],
      schema: z.object({ query: z.string(), explanation: z.string() }),
    });
    expect(recording.problems()).toEqual([]);
    expect(result.parsed).toEqual({
      query: 'assignee = currentUser() AND type = Bug AND status != Done AND updated >= -7d',
      explanation: 'Bugs assigned to you, not done, changed in the last seven days.',
    });
    expect(result.repaired).toBe(false);
  });

  it('[AI-007] offers strict tools with automatic choice and sends thinking back with the result', async () => {
    const { gateway, recording } = await replay('anthropic', 'tools', config);
    const tools = [
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
    ];
    const request = {
      feature: 'assisted-creation' as const,
      system: 'Draft tickets from a description. Check for similar tickets before drafting.',
      messages: [
        {
          role: 'user' as const,
          content: 'Users report that the password reset email arrives after the link has expired.',
        },
      ],
      tools,
    };
    const first = await gateway.generate(request);
    expect(first.stopReason).toBe('tool_use');
    expect(first.toolCalls).toEqual([
      { id: 'toolu_fixture_01', name: 'find_tickets', input: { query: 'text ~ "password reset"' } },
    ]);

    const second = await gateway.generate({
      ...request,
      messages: [
        ...request.messages,
        first.message,
        {
          role: 'user',
          content: [
            {
              type: 'tool-result',
              toolCallId: 'toolu_fixture_01',
              content: 'WEB-40: Reset email arrives late (Done)',
            },
          ],
        },
      ],
    });
    expect(recording.problems()).toEqual([]);
    expect(second.text).toBe(
      'WEB-40 covered a late email and is done; this looks like a new problem.',
    );
  });

  it('[AI-009] reports a refusal as data and never returns partial content', async () => {
    const { gateway, recording } = await replay('anthropic', 'refusal', config);
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result).toMatchObject({
      refused: true,
      refusalCategory: 'cyber',
      text: '',
      toolCalls: [],
      stopReason: 'refusal',
    });
  });

  it('[AI-009] a refusal mid-stream emits refused, and the result carries no text', async () => {
    const { gateway, recording } = await replay('anthropic', 'stream-refusal', config);
    const stream = gateway.stream(summary);
    const events = await collect(stream);
    const result = await stream.result;
    expect(recording.problems()).toEqual([]);
    expect(events).toEqual([
      { type: 'text', text: 'WEB-42: sign-in fails after a password reset. ' },
      { type: 'refused', category: 'cyber' },
    ]);
    expect(result).toMatchObject({ refused: true, text: '' });
  });

  it('[AI-009] an answer from the server-side fallback is marked, and every attempt is billed', async () => {
    const { gateway, recording } = await replay('anthropic', 'server-fallback', config);
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result).toMatchObject({ text: ANSWER_SUMMARY, fellBack: true, model: 'claude-opus-5' });
    expect(result.usage).toEqual({
      inputTokens: 192,
      outputTokens: 40,
      cacheReadTokens: 0,
      cacheWriteTokens: 2900,
    });
    expect(gateway.capabilities('summarize').refusalFallback).toBe('server');
  });

  it('[AI-009] two 529 responses followed by success yield one result and two logged retries', async () => {
    const logger = { warn: vi.fn() };
    const waits: number[] = [];
    const { gateway, recording } = await replay('anthropic', 'overloaded-retry', config, {
      logger,
      waits,
    });
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result.text).toBe(ANSWER_SUMMARY);
    expect(result.retries).toBe(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
    expect(logger.warn.mock.calls.map(([data]) => data)).toEqual([
      expect.objectContaining({ kind: 'overloaded', status: 529, retry: 1 }),
      expect.objectContaining({ kind: 'overloaded', status: 529, retry: 2 }),
    ]);
    // Exponential backoff with jitter: the second wait is longer than the first.
    expect(waits).toHaveLength(2);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
  });

  it('[AI-009] waits as long as retry-after asks before retrying', async () => {
    const waits: number[] = [];
    const { gateway, recording } = await replay('anthropic', 'rate-limited', config, { waits });
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result.retries).toBe(1);
    expect(waits).toEqual([3000]);
  });

  it('[AI-009] does not retry a rejected key, and the key never appears in the error', async () => {
    const { gateway, recording } = await replay('anthropic', 'authentication-error', config);
    const error = await gateway.generate(summary).catch((e: unknown) => e);
    expect(recording.problems()).toEqual([]);
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toMatchObject({ kind: 'authentication', status: 401, retryable: false });
    expect((error as Error).message).not.toContain('test-key-placeholder');
    expect((error as Error).message).toContain('[redacted]');
    expect((error as Error).cause).toBeUndefined();
  });

  it('[AI-002] counts tokens on the generally available endpoint', async () => {
    const { gateway, recording } = await replay('anthropic', 'count-tokens', config);
    expect(await gateway.countTokens(summary)).toBe(182);
    expect(recording.problems()).toEqual([]);
  });

  it('[AI-001] lists models live from the provider', async () => {
    const { gateway, recording } = await replay('anthropic', 'models', config);
    expect(await gateway.listModels()).toEqual([
      {
        id: 'claude-opus-5-5',
        displayName: 'Claude Opus 5.5',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 128_000,
      },
      {
        id: 'claude-haiku-5-5',
        displayName: 'Claude Haiku 5.5',
        maxInputTokens: 1_000_000,
        maxOutputTokens: 128_000,
      },
    ]);
    expect(recording.problems()).toEqual([]);
  });

  it('[AI-008] submits a batch and matches results by ID, in any order', async () => {
    const { gateway, recording } = await replay('anthropic', 'batch', config);
    const schema = z.object({ duplicateOf: z.array(z.string().regex(/^WEB-\d+$/)) });
    const submitted = await gateway.submitBatch({
      feature: 'duplicates',
      system:
        'Given a new ticket and candidates, list the candidate keys that describe the same problem.',
      schema,
      items: [
        {
          id: 'WEB-101',
          messages: [
            {
              role: 'user',
              content:
                'New: login loops after reset. Candidates: WEB-42 sign-in fails after a password reset.',
            },
          ],
        },
        {
          id: 'WEB-102',
          messages: [
            {
              role: 'user',
              content: 'New: dark mode colours. Candidates: WEB-7 contrast too low.',
            },
          ],
        },
        {
          id: 'WEB-103',
          messages: [{ role: 'user', content: 'New: export to CSV. Candidates: none.' }],
        },
      ],
    });
    expect(submitted).toMatchObject({ id: 'msgbatch_fixture_01', status: 'in_progress' });

    // Only the batch ID is needed to pick the job up again, for example after a restart.
    const status = await gateway.batchStatus('msgbatch_fixture_01');
    expect(status).toMatchObject({ status: 'ended', counts: { succeeded: 2, errored: 1 } });

    const results = new Map<string, unknown>();
    for await (const item of gateway.batchResults('msgbatch_fixture_01', { schema })) {
      results.set(item.id, item.ok ? item.result.parsed : item.error);
    }
    expect(recording.problems()).toEqual([]);
    expect(Object.fromEntries(results)).toEqual({
      'WEB-101': { duplicateOf: ['WEB-42'] },
      'WEB-102': { type: 'invalid_output', message: expect.stringContaining('duplicateOf.0') },
      'WEB-103': { type: 'errored', message: 'Item could not be processed' },
    });
  });
});

describe('Amazon Bedrock', () => {
  it('[AI-003] authenticates with a Bedrock API key as a bearer token', async () => {
    const { gateway, recording } = await replay('bedrock', 'api-key', {
      provider: 'bedrock',
      region: 'eu-west-1',
      apiKey: { secretId: 'bedrock-key' },
    });
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result.text).toBe(ANSWER_SUMMARY);
  });

  it('[AI-009] retries a refusal on the configured fallback model with the credit token', async () => {
    const { gateway, recording } = await replay('bedrock', 'client-fallback', {
      ...configs.bedrock,
      refusalFallbackModel: 'claude-opus-5',
    });
    expect(gateway.capabilities('summarize').refusalFallback).toBe('client');
    const result = await gateway.generate(summary);
    expect(recording.problems()).toEqual([]);
    expect(result).toMatchObject({
      text: ANSWER_SUMMARY,
      refused: false,
      fellBack: true,
      model: 'anthropic.claude-opus-5',
    });
  });

  it('[AI-002] offers neither batches nor model listing, and says so', async () => {
    const { gateway, recording } = await replay('bedrock', 'summary', configs.bedrock);
    expect(gateway.capabilities('summarize')).toMatchObject({
      batches: false,
      modelListing: false,
      refusalFallback: 'none',
    });
    await expect(gateway.listModels()).rejects.toBeInstanceOf(AiUnsupportedError);
    await expect(
      gateway.submitBatch({ feature: 'duplicates', system: 'x', items: [] }),
    ).rejects.toBeInstanceOf(AiUnsupportedError);
    expect(recording.calls).toEqual([]);
  });
});

describe('Google Cloud Vertex AI', () => {
  it('[AI-002] counts tokens on a regional endpoint', async () => {
    const { gateway, recording } = await replay('vertex', 'count-tokens', {
      ...configs.vertex,
      region: 'europe-west1',
    });
    expect(await gateway.countTokens(summary)).toBe(182);
    expect(recording.problems()).toEqual([]);
  });
});
