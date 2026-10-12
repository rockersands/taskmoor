import { describe, expect, it } from 'vitest';
import { aiSettingsSchema, featureSettingsSchema, providerConfigSchema } from './config';

describe('provider configuration', () => {
  it('accepts every provider and fills Bedrock defaults', () => {
    const configs = [
      { provider: 'anthropic', apiKey: { secretId: 'k' } },
      {
        provider: 'bedrock',
        region: 'us-east-1',
        accessKeyId: { secretId: 'a' },
        secretAccessKey: { secretId: 'b' },
      },
      { provider: 'vertex', region: 'global', projectId: 'p' },
      { provider: 'foundry', resource: 'r', apiKey: { secretId: 'k' } },
      { provider: 'openai-compatible', baseUrl: 'http://ollama:11434/v1', model: 'qwen3' },
    ];
    for (const config of configs) expect(providerConfigSchema.safeParse(config).success).toBe(true);
    const bedrock = providerConfigSchema.parse(configs[1]);
    expect(bedrock).toMatchObject({ modelPrefix: 'anthropic.' });
  });

  it('rejects raw credentials in configuration', () => {
    expect(
      providerConfigSchema.safeParse({ provider: 'anthropic', apiKey: 'sk-raw' }).success,
    ).toBe(false);
    expect(providerConfigSchema.safeParse({ provider: 'unknown' }).success).toBe(false);
    expect(
      providerConfigSchema.safeParse({
        provider: 'openai-compatible',
        baseUrl: 'not a url',
        model: 'x',
      }).success,
    ).toBe(false);
  });
});

describe('feature settings', () => {
  it('allows only the catalogued models and efforts', () => {
    expect(
      featureSettingsSchema.safeParse({ model: 'claude-sonnet-5-5', effort: 'xhigh' }).success,
    ).toBe(true);
    expect(featureSettingsSchema.safeParse({ model: 'claude-3-opus-20240229' }).success).toBe(
      false,
    );
    expect(featureSettingsSchema.safeParse({ effort: 'extreme' }).success).toBe(false);
  });

  it('defaults to no provider and no overrides', () => {
    expect(aiSettingsSchema.parse({})).toEqual({ provider: null, features: {} });
  });
});
