import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AiSettings, providerConfigSchema } from '../config';
import { AiGateway, AiProviderError } from '../gateway';
import { InMemorySecretStore } from '../secrets';
import { claudeMessage, type FakeResponse, fakeFetch, type RecordedCall } from '../testing';
import { ClaudeAdapter, createClaudeClient } from './claude';

// Fake credentials are assembled at runtime so the secret scanner never sees a key-shaped literal.
const API_KEY = ['sk-ant', 'api03', 'x'.repeat(40)].join('-');
const AWS_ID = ['AKIA', 'TEST'.repeat(4)].join('');
const secrets = new InMemorySecretStore({
  'anthropic-key': API_KEY,
  'aws-id': AWS_ID,
  'aws-secret': 'aws-secret-value-for-tests-only',
  'gcp-token': 'ya29.test-token',
  'foundry-key': 'foundry-key-for-tests-only',
});

const ok = () => claudeMessage({ text: 'Summary.' });

async function gatewayFor(
  config: unknown,
  respond: (call: RecordedCall) => FakeResponse = ok,
  features: AiSettings['features'] = {},
) {
  const ff = fakeFetch(respond);
  const parsed = providerConfigSchema.parse(config);
  if (parsed.provider === 'openai-compatible') throw new Error('use the other adapter');
  const bundle = await createClaudeClient(parsed, secrets, { fetch: ff.fetch, maxRetries: 0 });
  return { gateway: new AiGateway(new ClaudeAdapter(bundle), features), calls: ff.calls };
}

const anthropic = { provider: 'anthropic', apiKey: { secretId: 'anthropic-key' } };
const summarize = {
  feature: 'summarize' as const,
  system: 'Be brief.',
  messages: [{ role: 'user' as const, content: 'Hello' }],
};

describe('Anthropic API', () => {
  it('sends the request shape the current models accept', async () => {
    const { gateway, calls } = await gatewayFor(anthropic);
    const result = await gateway.generate(summarize);

    expect(calls).toHaveLength(1);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe('https://api.anthropic.com/v1/messages');
    expect(call.headers['x-api-key']).toBe(API_KEY);
    expect(call.headers.authorization).toBeUndefined();
    expect(call.body).toMatchObject({
      model: 'claude-opus-5-5',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
      system: [{ type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: 'Hello' }],
    });
    for (const banned of ['temperature', 'top_p', 'top_k', 'tool_choice', 'tools']) {
      expect(call.body).not.toHaveProperty(banned);
    }
    expect((call.body as { thinking: object }).thinking).not.toHaveProperty('budget_tokens');
    expect(result).toMatchObject({ text: 'Summary.', refused: false, provider: 'anthropic' });
  });

  it('requests strict structured output and validates the answer', async () => {
    const schema = z.object({ query: z.string(), confidence: z.number() });
    const { gateway, calls } = await gatewayFor(anthropic, () =>
      claudeMessage({ text: '{"query":"status = Done","confidence":0.9}' }),
    );
    const result = await gateway.generate({ ...summarize, feature: 'query-from-text', schema });

    const body = calls[0]?.body as {
      output_config: { effort: string; format: { type: string; schema: Record<string, unknown> } };
    };
    expect(body.output_config.effort).toBe('high');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(result.parsed).toEqual({ query: 'status = Done', confidence: 0.9 });
  });

  it('reports a refusal instead of throwing', async () => {
    const { gateway } = await gatewayFor(anthropic, () => claudeMessage({ stopReason: 'refusal' }));
    const result = await gateway.generate({ ...summarize, schema: z.object({ a: z.string() }) });
    expect(result.refused).toBe(true);
    expect(result.parsed).toBeUndefined();
    expect(result.text).toBe('');
  });

  it('maps usage, including cache reads and writes', async () => {
    const { gateway } = await gatewayFor(anthropic, () =>
      claudeMessage({ text: 'x', inputTokens: 40, outputTokens: 7, cacheRead: 900, cacheWrite: 0 }),
    );
    const result = await gateway.generate(summarize);
    expect(result.usage).toEqual({
      inputTokens: 40,
      outputTokens: 7,
      cacheReadTokens: 900,
      cacheWriteTokens: 0,
    });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("applies the administrator's model and effort for a feature", async () => {
    const { gateway, calls } = await gatewayFor(anthropic, ok, {
      summarize: { enabled: true, model: 'claude-haiku-5-5', effort: 'low' },
    });
    await gateway.generate(summarize);
    expect(calls[0]?.body).toMatchObject({
      model: 'claude-haiku-5-5',
      output_config: { effort: 'low' },
    });
  });

  it('wraps provider errors and keeps the key out of the message', async () => {
    const { gateway } = await gatewayFor(anthropic, () => ({
      status: 401,
      json: {
        type: 'error',
        error: { type: 'authentication_error', message: `bad key ${API_KEY}` },
      },
    }));
    const error = await gateway.generate(summarize).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as Error).message).toMatch(/^anthropic: /);
    expect((error as Error).message).not.toContain(API_KEY);
    expect((error as Error).message).toContain('[redacted]');
  });
});

describe('Amazon Bedrock', () => {
  const bedrock = {
    provider: 'bedrock',
    region: 'eu-west-1',
    accessKeyId: { secretId: 'aws-id' },
    secretAccessKey: { secretId: 'aws-secret' },
  };

  it('signs the request and puts the prefixed model in the path', async () => {
    const { gateway, calls } = await gatewayFor(bedrock);
    await gateway.generate(summarize);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe(
      'https://bedrock-runtime.eu-west-1.amazonaws.com/model/anthropic.claude-opus-5-5/invoke',
    );
    expect(call.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIA/);
    expect(call.body).not.toHaveProperty('model');
    expect(call.body).toMatchObject({
      anthropic_version: expect.any(String),
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium' },
    });
  });

  it('uses the configured inference-profile prefix', async () => {
    const { gateway, calls } = await gatewayFor(
      { ...bedrock, modelPrefix: 'global.anthropic.' },
      ok,
      {
        summarize: { enabled: true, model: 'claude-sonnet-5-5' },
      },
    );
    await gateway.generate(summarize);
    expect(calls[0]?.url).toContain('/model/global.anthropic.claude-sonnet-5-5/invoke');
  });
});

describe('Google Cloud Vertex AI', () => {
  it('calls rawPredict for the project and region with a bearer token', async () => {
    const { gateway, calls } = await gatewayFor({
      provider: 'vertex',
      region: 'europe-west1',
      projectId: 'proj-1',
      accessToken: { secretId: 'gcp-token' },
    });
    await gateway.generate(summarize);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe(
      'https://europe-west1-aiplatform.googleapis.com/v1/projects/proj-1/locations/europe-west1/publishers/anthropic/models/claude-opus-5-5:rawPredict',
    );
    expect(call.headers.authorization).toBe('Bearer ya29.test-token');
    expect(call.body).toMatchObject({ anthropic_version: 'vertex-2023-10-16' });
    expect(call.body).not.toHaveProperty('model');
  });
});

describe('Microsoft Foundry', () => {
  it('calls the resource endpoint with the API key header', async () => {
    const { gateway, calls } = await gatewayFor({
      provider: 'foundry',
      resource: 'my-resource',
      apiKey: { secretId: 'foundry-key' },
    });
    await gateway.generate(summarize);
    const call = calls[0] as RecordedCall;
    expect(call.url).toBe('https://my-resource.services.ai.azure.com/anthropic/v1/messages');
    expect(call.headers['x-api-key']).toBe('foundry-key-for-tests-only');
    expect(call.body).toMatchObject({ model: 'claude-opus-5-5' });
  });
});
