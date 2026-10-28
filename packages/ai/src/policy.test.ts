import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  buildClaudeParams,
  claudeUsage,
  echoableContent,
  fromClaudeMessage,
} from './adapters/claude-request';
import { EFFORTS } from './config';
import { AiPolicyError } from './errors';
import { assertClaudeRequestPolicy, SERVER_FALLBACK_BETA } from './policy';
import { strictJsonSchema } from './schema';
import type { AdapterRequest, ToolSpec } from './types';

const tool = (name: string): ToolSpec => ({
  name,
  description: `The ${name} tool.`,
  inputSchema: strictJsonSchema(z.object({ value: z.string() })),
});

const base: AdapterRequest = {
  model: 'claude-opus-5-5',
  system: 'Stable instructions.',
  messages: [{ role: 'user', content: 'Hello' }],
  maxTokens: 16_000,
  effort: 'medium',
  cacheSystem: true,
};

const adapterRequests = fc.record({
  model: fc.constantFrom('claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'),
  system: fc.string({ maxLength: 40 }),
  context: fc.option(fc.string({ minLength: 1, maxLength: 40 }), { nil: undefined }),
  effort: fc.constantFrom(...EFFORTS),
  cacheSystem: fc.boolean(),
  maxTokens: fc.integer({ min: 1, max: 64_000 }),
  structured: fc.boolean(),
  tools: fc.uniqueArray(fc.stringMatching(/^[a-z_]{1,12}$/), { maxLength: 4 }),
  serverFallback: fc.boolean(),
});

describe('Claude request policy', () => {
  it('[AI-006] [AI-007] every built request has adaptive thinking and an explicit effort, and never a budget, sampling or forced tool choice', () => {
    fc.assert(
      fc.property(adapterRequests, (generated) => {
        const params = buildClaudeParams(
          {
            ...base,
            model: generated.model,
            system: generated.system,
            ...(generated.context ? { context: generated.context } : {}),
            effort: generated.effort,
            cacheSystem: generated.cacheSystem,
            maxTokens: generated.maxTokens,
            ...(generated.structured
              ? { jsonSchema: strictJsonSchema(z.object({ a: z.string() })) }
              : {}),
            ...(generated.tools.length ? { tools: generated.tools.map(tool) } : {}),
          },
          { model: generated.model, serverFallback: generated.serverFallback },
        ) as unknown as Record<string, unknown>;
        expect(params.thinking).toEqual({ type: 'adaptive' });
        expect((params.output_config as { effort: string }).effort).toBe(generated.effort);
        for (const banned of ['temperature', 'top_p', 'top_k'])
          expect(params).not.toHaveProperty(banned);
        if (generated.tools.length) {
          expect(params.tool_choice).toEqual({ type: 'auto' });
          for (const t of params.tools as { strict: boolean }[]) expect(t.strict).toBe(true);
        } else {
          expect(params).not.toHaveProperty('tool_choice');
        }
      }),
    );
  });

  it('[AI-007] refuses to send a forced tool choice, a thinking budget, disabled thinking, sampling or a missing effort', () => {
    const good = buildClaudeParams(
      { ...base, tools: [tool('find')] },
      { model: 'claude-opus-5-5', serverFallback: false },
    ) as unknown as Record<string, unknown>;
    expect(() => assertClaudeRequestPolicy(good)).not.toThrow();
    const broken: Record<string, unknown>[] = [
      { ...good, tool_choice: { type: 'any' } },
      { ...good, tool_choice: { type: 'tool', name: 'find' } },
      { ...good, thinking: { type: 'enabled', budget_tokens: 2048 } },
      { ...good, thinking: { type: 'adaptive', budget_tokens: 2048 } },
      { ...good, thinking: { type: 'disabled' } },
      { ...good, temperature: 0.2 },
      { ...good, top_p: 0.9 },
      { ...good, output_config: {} },
      { ...good, output_config: { effort: 'extreme' } },
      { ...good, tools: [{ name: 'find', input_schema: { type: 'object' } }] },
    ];
    for (const params of broken) {
      expect(() => assertClaudeRequestPolicy(params)).toThrow(AiPolicyError);
    }
  });

  it('[AI-008] puts the stable prefix first, with a cache breakpoint on the instructions and on the context', () => {
    const params = buildClaudeParams(
      { ...base, context: 'Track WEB.' },
      { model: 'claude-opus-5-5', serverFallback: false },
    );
    expect(params.system).toEqual([
      { type: 'text', text: 'Stable instructions.', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Track WEB.', cache_control: { type: 'ephemeral' } },
    ]);
    const uncached = buildClaudeParams(
      { ...base, cacheSystem: false },
      { model: 'claude-opus-5-5', serverFallback: false },
    );
    expect(uncached.system).toEqual([{ type: 'text', text: 'Stable instructions.' }]);
  });

  it('[AI-008] builds byte-identical prefixes whatever order tools are given in', () => {
    fc.assert(
      fc.property(
        fc.shuffledSubarray(['alpha', 'beta', 'gamma', 'delta'], { minLength: 4, maxLength: 4 }),
        (names) => {
          const build = (order: string[]) =>
            JSON.stringify(
              buildClaudeParams(
                { ...base, tools: order.map(tool) },
                { model: 'claude-opus-5-5', serverFallback: true },
              ),
            );
          expect(build(names)).toBe(build(['alpha', 'beta', 'delta', 'gamma']));
        },
      ),
    );
  });

  it('[AI-009] asks for the server-side fallback only when told to, with its beta', () => {
    const on = buildClaudeParams(base, { model: 'claude-opus-5-5', serverFallback: true });
    expect(on).toMatchObject({ fallbacks: 'default', betas: [SERVER_FALLBACK_BETA] });
    const off = buildClaudeParams(base, { model: 'claude-opus-5-5', serverFallback: false });
    expect(off).not.toHaveProperty('fallbacks');
    expect(off).not.toHaveProperty('betas');
  });
});

describe('Claude answers', () => {
  const message = (overrides: Record<string, unknown>) =>
    fromClaudeMessage({
      id: 'msg_unit',
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5-5',
      content: [],
      stop_reason: 'end_turn',
      stop_sequence: null,
      stop_details: null,
      usage: { input_tokens: 5, output_tokens: 2 },
      ...overrides,
    } as never);

  it('[AI-009] reads stop_reason first: a refusal yields no text and no tool calls', () => {
    const refused = message({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'bio', explanation: null },
      content: [
        { type: 'text', text: 'Partial' },
        { type: 'tool_use', id: 't1', name: 'find', input: {} },
      ],
    });
    expect(refused).toMatchObject({
      refused: true,
      refusalCategory: 'bio',
      text: '',
      toolCalls: [],
      stopReason: 'refusal',
    });
  });

  it('[AI-007] maps a context-window stop to max_tokens, so a cut-off answer is never trusted', () => {
    expect(message({ stop_reason: 'model_context_window_exceeded' }).stopReason).toBe('max_tokens');
  });

  it('[AI-008] counts every attempt when a fallback ran, and the top-level usage otherwise', () => {
    expect(
      claudeUsage({
        input_tokens: 10,
        output_tokens: 4,
        cache_read_input_tokens: 7,
        cache_creation_input_tokens: null,
      } as never),
    ).toEqual({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 0 });
    expect(
      claudeUsage({
        input_tokens: 10,
        output_tokens: 4,
        iterations: [
          {
            type: 'message',
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 0,
          },
          {
            type: 'fallback_message',
            input_tokens: 10,
            output_tokens: 4,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 5,
          },
        ],
      } as never),
    ).toEqual({ inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, cacheWriteTokens: 5 });
  });

  it('[AI-009] sends a fallback turn back without the seams or the declined model’s thinking and tool calls', () => {
    const thinking = { type: 'thinking', thinking: '', signature: 's1' } as const;
    const echoed = echoableContent([
      thinking,
      { type: 'text', text: 'Partial ' },
      { type: 'tool_use', id: 't1', name: 'find', input: {} },
      { type: 'fallback', from: { model: 'claude-opus-5-5' }, to: { model: 'claude-opus-5' } },
      { ...thinking, signature: 's2' },
      { type: 'text', text: 'answer' },
    ]);
    expect(echoed).toEqual([
      { type: 'text', text: 'Partial ' },
      { ...thinking, signature: 's2' },
      { type: 'text', text: 'answer' },
    ]);
    // Without a seam, the turn goes back exactly as it came.
    const plain = [thinking, { type: 'text' as const, text: 'answer' }];
    expect(echoableContent(plain)).toEqual(plain);
  });
});

describe('strict JSON schema', () => {
  it('[AI-007] closes every object, requires every property and leaves out the $schema marker', () => {
    const schema = strictJsonSchema(
      z.object({
        title: z.string().max(80),
        children: z.array(z.object({ title: z.string() })),
      }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string', description: '{maxLength: 80}' },
        children: {
          type: 'array',
          items: {
            type: 'object',
            properties: { title: { type: 'string' } },
            additionalProperties: false,
            required: ['title'],
          },
        },
      },
      additionalProperties: false,
      required: ['title', 'children'],
    });
  });
});
