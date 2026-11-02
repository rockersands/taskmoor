// OpenAI's API and Gemini's OpenAI-compatible endpoint through the chat-completions adapter: what
// each request carries. A fake fetch records the requests; no network, no key.
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { providerConfigSchema } from '../config';
import { createProviderAdapter } from '../factory';
import { AiGateway } from '../gateway';
import { InMemorySecretStore } from '../secrets';
import { knownService, SERVICE_BASE_URLS } from './openai-compatible';

const secrets = new InMemorySecretStore({ key: 'test-key-placeholder' });

function recordingFetch() {
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(
      JSON.stringify({
        model: 'm',
        choices: [
          { message: { role: 'assistant', content: '{"answer":"ok"}' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 3 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
  return { requests, fetchImpl };
}

async function ask(baseUrl: string) {
  const { requests, fetchImpl } = recordingFetch();
  const adapter = await createProviderAdapter(
    providerConfigSchema.parse({
      provider: 'openai-compatible',
      baseUrl,
      model: 'some-model',
      apiKey: { secretId: 'key' },
    }),
    secrets,
    { fetch: fetchImpl },
  );
  const gateway = new AiGateway(adapter);
  await gateway.generate({
    feature: 'query-from-text',
    system: 'Answer with JSON.',
    messages: [{ role: 'user', content: 'open bugs' }],
    schema: z.object({ answer: z.string() }),
  });
  return { requests, capabilities: adapter.capabilities('some-model') };
}

describe('hosted OpenAI-compatible services (AI-002)', () => {
  it('[AI-002] knows OpenAI and Gemini by their API hosts only', () => {
    expect(knownService(SERVICE_BASE_URLS.openai)).toBe('openai');
    expect(knownService(SERVICE_BASE_URLS.gemini)).toBe('gemini');
    expect(knownService('http://localhost:11434/v1')).toBeNull();
    expect(knownService('https://api.openai.com.example.net/v1')).toBeNull();
    expect(knownService('not a url')).toBeNull();
  });

  it('[AI-002] OpenAI: no capability probe, max_completion_tokens, strict structured output, tools offered', async () => {
    const { requests, capabilities } = await ask(SERVICE_BASE_URLS.openai);
    expect(requests.map((r) => r.url)).toEqual(['https://api.openai.com/v1/chat/completions']);
    const body = requests[0]?.body ?? {};
    expect(body.max_tokens).toBeUndefined();
    expect(typeof body.max_completion_tokens).toBe('number');
    expect(body.response_format).toMatchObject({ json_schema: { strict: true } });
    expect(capabilities).toMatchObject({ toolCalls: true, structuredOutput: true });
  });

  it('[AI-002] Gemini: no capability probe, max_tokens, no strict flags', async () => {
    const { requests, capabilities } = await ask(SERVICE_BASE_URLS.gemini);
    expect(requests.map((r) => r.url)).toEqual([
      'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    ]);
    const body = requests[0]?.body ?? {};
    expect(typeof body.max_tokens).toBe('number');
    expect(
      (body.response_format as { json_schema: Record<string, unknown> }).json_schema,
    ).not.toHaveProperty('strict');
    expect(capabilities).toMatchObject({ toolCalls: true, structuredOutput: true });
  });

  it('[AI-002] a local server is still asked what it supports (Ollama), and keeps max_tokens', async () => {
    const { requests } = await ask('http://localhost:11434/v1');
    expect(requests.map((r) => r.url)).toEqual([
      'http://localhost:11434/api/show',
      'http://localhost:11434/v1/chat/completions',
    ]);
    expect(typeof requests[1]?.body.max_tokens).toBe('number');
  });
});
