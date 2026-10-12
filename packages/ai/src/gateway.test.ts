import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type AdapterRequest,
  type AdapterResponse,
  AiFeatureDisabledError,
  AiGateway,
  AiOutputError,
  AiProviderError,
  type ProviderAdapter,
} from './gateway';

function stubAdapter(reply: Partial<AdapterResponse> | Error = {}) {
  const requests: AdapterRequest[] = [];
  const adapter: ProviderAdapter = {
    provider: 'anthropic',
    secretValues: ['hunter2-secret'],
    async generate(request) {
      requests.push(request);
      if (reply instanceof Error) throw reply;
      return {
        text: '',
        stopReason: 'end_turn',
        refused: false,
        model: 'claude-opus-5-5',
        usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
        ...reply,
      };
    },
  };
  return { adapter, requests };
}

const request = {
  feature: 'assisted-creation' as const,
  system: 'Draft items.',
  messages: [{ role: 'user' as const, content: 'A login bug' }],
};

describe('AiGateway', () => {
  it('applies feature defaults: opus 5.5, the feature effort and output limit, cached system', async () => {
    const { adapter, requests } = stubAdapter();
    await new AiGateway(adapter).generate(request);
    expect(requests[0]).toEqual({
      model: 'claude-opus-5-5',
      system: 'Draft items.',
      messages: request.messages,
      maxTokens: 4096,
      effort: 'medium',
      cacheSystem: true,
    });
  });

  it('honours per-call output limit and cache opt-out', async () => {
    const { adapter, requests } = stubAdapter();
    await new AiGateway(adapter).generate({ ...request, maxOutputTokens: 256, cacheSystem: false });
    expect(requests[0]).toMatchObject({ maxTokens: 256, cacheSystem: false });
  });

  it('refuses to run a feature the administrator turned off', async () => {
    const { adapter, requests } = stubAdapter();
    const gateway = new AiGateway(adapter, { 'assisted-creation': { enabled: false } });
    await expect(gateway.generate(request)).rejects.toBeInstanceOf(AiFeatureDisabledError);
    expect(requests).toHaveLength(0);
  });

  it('rejects answers that are not JSON or do not match the schema', async () => {
    const schema = z.object({ title: z.string() });
    const notJson = new AiGateway(stubAdapter({ text: 'Sure! Here you go' }).adapter);
    await expect(notJson.generate({ ...request, schema })).rejects.toThrow(AiOutputError);
    const wrongShape = new AiGateway(stubAdapter({ text: '{"title": 5}' }).adapter);
    await expect(wrongShape.generate({ ...request, schema })).rejects.toThrow(/title/);
  });

  it('scrubs credentials from provider errors', async () => {
    const { adapter } = stubAdapter(new Error('401 for key hunter2-secret'));
    const error = await new AiGateway(adapter).generate(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as Error).message).toBe('anthropic: 401 for key [redacted]');
    expect((error as AiProviderError).cause).toBeInstanceOf(Error);
  });
});
