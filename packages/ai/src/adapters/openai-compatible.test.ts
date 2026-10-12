import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { providerConfigSchema } from '../config';
import { AiGateway, AiProviderError } from '../gateway';
import { InMemorySecretStore } from '../secrets';
import { chatCompletion, type FakeResponse, fakeFetch, type RecordedCall } from '../testing';
import { OpenAiCompatibleAdapter } from './openai-compatible';

const secrets = new InMemorySecretStore({ 'local-key': 'local-secret-for-tests' });
const summarize = {
  feature: 'summarize' as const,
  system: 'Be brief.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
};

async function gatewayFor(
  config: Record<string, unknown>,
  respond: (call: RecordedCall) => FakeResponse = () => chatCompletion({ content: 'Summary.' }),
) {
  const ff = fakeFetch(respond);
  const parsed = providerConfigSchema.parse({
    provider: 'openai-compatible',
    baseUrl: 'http://localhost:11434/v1',
    model: 'llama3.3',
    ...config,
  });
  if (parsed.provider !== 'openai-compatible') throw new Error('unexpected provider');
  const adapter = await OpenAiCompatibleAdapter.create(parsed, secrets, { fetch: ff.fetch });
  return { gateway: new AiGateway(adapter), calls: ff.calls };
}

describe('OpenAI-compatible servers', () => {
  it('posts a chat completion with the configured model and the system prompt first', async () => {
    const { gateway, calls } = await gatewayFor({ apiKey: { secretId: 'local-key' } });
    const result = await gateway.generate(summarize);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(call.headers.authorization).toBe('Bearer local-secret-for-tests');
    expect(call.body).toEqual({
      model: 'llama3.3',
      max_tokens: 1024,
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'Hello' },
      ],
    });
    expect(result).toMatchObject({
      text: 'Summary.',
      provider: 'openai-compatible',
      model: 'local-model',
    });
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  });

  it('sends no authorization header when the server needs no key', async () => {
    const { gateway, calls } = await gatewayFor({});
    await gateway.generate(summarize);
    expect(calls[0]?.headers.authorization).toBeUndefined();
  });

  it('asks for a strict JSON schema response and validates it', async () => {
    const schema = z.object({ duplicateOf: z.array(z.string()) });
    const { gateway, calls } = await gatewayFor({}, () =>
      chatCompletion({ content: '{"duplicateOf":["ABC-1"]}' }),
    );
    const result = await gateway.generate({ ...summarize, feature: 'duplicates', schema });
    expect(calls[0]?.body).toMatchObject({
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'output', strict: true, schema: { type: 'object' } },
      },
    });
    expect(result.parsed).toEqual({ duplicateOf: ['ABC-1'] });
  });

  it('treats content_filter as a refusal', async () => {
    const { gateway } = await gatewayFor({}, () =>
      chatCompletion({ finishReason: 'content_filter' }),
    );
    const result = await gateway.generate(summarize);
    expect(result.refused).toBe(true);
  });

  it('wraps HTTP errors', async () => {
    const { gateway } = await gatewayFor({}, () => ({ status: 503, json: { error: 'busy' } }));
    await expect(gateway.generate(summarize)).rejects.toBeInstanceOf(AiProviderError);
    await expect(gateway.generate(summarize)).rejects.toThrow(/503/);
  });
});
