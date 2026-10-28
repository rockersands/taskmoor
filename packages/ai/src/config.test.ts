import { describe, expect, it } from 'vitest';
import { aiSettingsSchema, featureSettingsSchema, providerConfigSchema } from './config';

const valid = (config: unknown) => providerConfigSchema.safeParse(config).success;

describe('provider configuration', () => {
  it('[AI-003] [AI-004] accepts every provider', () => {
    const configs = [
      { provider: 'anthropic', apiKey: { secretId: 'k' } },
      {
        provider: 'bedrock',
        region: 'us-east-1',
        accessKeyId: { secretId: 'a' },
        secretAccessKey: { secretId: 'b' },
      },
      { provider: 'bedrock', region: 'us-east-1', apiKey: { secretId: 'k' } },
      // No credentials: the server's AWS role.
      { provider: 'bedrock', region: 'us-east-1', refusalFallbackModel: 'claude-opus-5' },
      { provider: 'vertex', region: 'global', projectId: 'p' },
      { provider: 'foundry', resource: 'r', apiKey: { secretId: 'k' } },
      { provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', model: 'qwen3' },
      {
        provider: 'openai-compatible',
        baseUrl: 'http://vllm:8000/v1',
        model: 'llama3.3',
        capabilities: { toolCalls: true },
      },
    ];
    for (const config of configs) expect(valid(config)).toBe(true);
  });

  it('[AI-001] holds credentials only as secret references', () => {
    expect(valid({ provider: 'anthropic', apiKey: 'sk-raw' })).toBe(false);
    expect(valid({ provider: 'unknown' })).toBe(false);
    expect(valid({ provider: 'openai-compatible', baseUrl: 'not a url', model: 'x' })).toBe(false);
  });

  it('[AI-003] rejects half-configured Bedrock credentials', () => {
    const bedrock = { provider: 'bedrock', region: 'eu-west-1' };
    expect(valid({ ...bedrock, accessKeyId: { secretId: 'a' } })).toBe(false);
    expect(
      valid({
        ...bedrock,
        apiKey: { secretId: 'k' },
        accessKeyId: { secretId: 'a' },
        secretAccessKey: { secretId: 'b' },
      }),
    ).toBe(false);
    expect(valid({ ...bedrock, sessionToken: { secretId: 't' } })).toBe(false);
  });

  it('[AI-009] takes a fallback model only as an exact Claude model ID', () => {
    const vertex = { provider: 'vertex', region: 'global', projectId: 'p' };
    expect(valid({ ...vertex, refusalFallbackModel: 'claude-opus-5' })).toBe(true);
    expect(valid({ ...vertex, refusalFallbackModel: 'gpt-4o' })).toBe(false);
    expect(valid({ ...vertex, refusalFallbackModel: 'Claude Opus' })).toBe(false);
  });
});

describe('feature settings', () => {
  it('[AI-006] allows only the catalogued models and efforts', () => {
    expect(
      featureSettingsSchema.safeParse({ model: 'claude-sonnet-5-5', effort: 'xhigh' }).success,
    ).toBe(true);
    expect(featureSettingsSchema.safeParse({ model: 'claude-3-opus-20240229' }).success).toBe(
      false,
    );
    expect(featureSettingsSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
  });

  it('[AI-001] defaults to no provider and no overrides', () => {
    expect(aiSettingsSchema.parse({})).toEqual({ provider: null, features: {} });
  });
});
