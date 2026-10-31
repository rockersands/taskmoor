import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { type AgentLimits, type AgentTool, runAgent, ToolRegistry } from './agent';
import { AiPolicyError } from './errors';
import { AiGateway } from './gateway';
import { LIST_PRICES, totalTokens } from './spend';
import { FakeAbortError, FULL_CAPABILITIES, MemoryMeter, VirtualClock } from './testing';
import type {
  AdapterRequest,
  AdapterResponse,
  CallOptions,
  ErrorClassification,
  ModelCapabilities,
  ModelInfo,
  ProviderAdapter,
  StreamCallOptions,
  ToolCall,
  Usage,
} from './types';

const OPUS = LIST_PRICES.find((p) => p.provider === 'anthropic' && p.model === 'claude-opus-5-5')
  ?.price as NonNullable<(typeof LIST_PRICES)[number]['price']>;

/** One model answer the fake gives: how much it wants to write, how long it takes, tools. */
interface FakeStep {
  /** Output tokens the answer would take; the fake stops at the call's `max_tokens`. */
  output: number;
  latencyMs: number;
  /** Tool calls (by tool name); none ends the run. */
  tools: string[];
  /** Share of the prompt read from the cache, as providers report it. */
  cached?: number;
}

/** Input tokens of a request, as both the fake's counter and its usage report them. */
const promptTokens = (r: AdapterRequest) =>
  Math.ceil(JSON.stringify([r.system, r.context ?? '', r.messages, r.tools ?? []]).length / 4);

/**
 * A provider that behaves as a real one does where budgets are concerned: it counts tokens the
 * way it bills them, never writes more than `max_tokens`, takes time on a clock and stops when
 * the call is cancelled. Every answer it gave is in `billed`.
 */
class AgentFake implements ProviderAdapter {
  readonly provider = 'anthropic' as const;
  readonly secretValues: readonly string[] = [];
  readonly requests: AdapterRequest[] = [];
  readonly billed: Usage[] = [];
  private index = 0;

  constructor(
    private readonly script: FakeStep[],
    private readonly clock: VirtualClock,
    private readonly caps: Partial<ModelCapabilities> = {},
  ) {}

  capabilities(): ModelCapabilities {
    return { ...FULL_CAPABILITIES, ...this.caps };
  }

  async countTokens(request: AdapterRequest): Promise<number> {
    return promptTokens(request);
  }

  async generate(request: AdapterRequest, options?: CallOptions): Promise<AdapterResponse> {
    this.requests.push(request);
    const step = this.script[Math.min(this.index, this.script.length - 1)] as FakeStep;
    this.index += 1;
    if (!this.clock.pass(step.latencyMs, options?.signal)) throw new FakeAbortError();
    const prompt = promptTokens(request);
    const cached = Math.floor(prompt * (step.cached ?? 0));
    const output = Math.min(step.output, request.maxTokens);
    const cut = step.output > request.maxTokens;
    const usage: Usage = {
      inputTokens: prompt - cached,
      outputTokens: output,
      cacheReadTokens: cached,
      cacheWriteTokens: 0,
    };
    this.billed.push(usage);
    const toolCalls: ToolCall[] = step.tools.map((name, i) => ({
      id: `call_${this.index}_${i}`,
      name,
      input: { q: `step ${this.index}` },
    }));
    const text = toolCalls.length ? `Step ${this.index}` : `Done after ${this.index} steps`;
    return {
      text,
      toolCalls,
      stopReason: cut ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end_turn',
      refused: false,
      refusalCategory: null,
      model: request.model,
      fellBack: false,
      usage,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text },
          ...toolCalls.map((c) => ({ type: 'tool-call' as const, ...c })),
        ],
      },
    };
  }

  async stream(request: AdapterRequest, options: StreamCallOptions): Promise<AdapterResponse> {
    return this.generate(request, options);
  }

  async listModels(): Promise<ModelInfo[]> {
    return [];
  }

  classifyError(error: unknown): ErrorClassification {
    if (error instanceof FakeAbortError) return { kind: 'aborted', message: 'aborted' };
    return { kind: 'unknown', message: error instanceof Error ? error.message : String(error) };
  }
}

function lookup(clock: VirtualClock, latencyMs = 50): AgentTool<{ q: string }> {
  return {
    name: 'find_tickets',
    description: 'Search tickets.',
    input: z.object({ q: z.string() }),
    run: async ({ q }, { signal }) => {
      if (!clock.pass(latencyMs, signal)) throw new Error('cancelled');
      return { content: `WEB-1 matches ${q}`, done: `Searched for ${q}` };
    },
  };
}

const base = {
  feature: 'assisted-creation' as const,
  system: 'Break the ticket down.',
  task: 'Break down WEB-7: a new sign-in page.',
};

describe('agent runs with budgets (M1-131)', () => {
  it('[AI-011] runs tools through the registry until the model answers', async () => {
    const clock = new VirtualClock();
    const adapter = new AgentFake(
      [
        { output: 200, latencyMs: 100, tools: ['find_tickets'] },
        { output: 300, latencyMs: 100, tools: [] },
      ],
      clock,
    );
    const meter = new MemoryMeter();
    const report = await runAgent(new AiGateway(adapter, { meter, now: () => clock.now() }), {
      ...base,
      tools: [lookup(clock)],
      limits: { maxSteps: 5, maxWallMs: 60_000 },
      price: OPUS,
      tag: { userId: 4 },
      clock,
    });
    expect(report).toMatchObject({
      status: 'completed',
      limit: null,
      completed: ['Searched for step 1'],
      answer: 'Done after 2 steps',
      elapsedMs: 250,
    });
    expect(report.steps.map((s) => s.toolCalls)).toEqual([
      [{ name: 'find_tickets', ok: true }],
      [],
    ]);
    // The tool's result went back to the model with its call.
    expect(adapter.requests[1]?.messages.at(-1)?.content).toEqual([
      { type: 'tool-result', toolCallId: 'call_1_0', content: 'WEB-1 matches step 1' },
    ]);
    // Each step is one audit row tagged with the run.
    expect(meter.booked.map((b) => [b.call.tag.userId, b.call.tag.runId])).toEqual([
      [4, report.runId],
      [4, report.runId],
    ]);
    expect(report.costNanos).toBe(meter.booked.reduce((n, b) => n + b.costNanos, 0));
  });

  it('[AI-011] (1) a run that reaches its cost limit stops, says so and reports what it completed', async () => {
    const clock = new VirtualClock();
    const adapter = new AgentFake(
      [{ output: 2_000, latencyMs: 10, tools: ['find_tickets'] }],
      clock,
    );
    const limits: AgentLimits = { maxSteps: 50, maxCostNanos: 150_000_000, maxWallMs: 60_000 };
    const report = await runAgent(new AiGateway(adapter), {
      ...base,
      tools: [lookup(clock)],
      limits,
      price: OPUS,
      clock,
    });
    expect(report.status).toBe('budget_reached');
    expect(report.limit).toBe('cost');
    expect(report.costNanos).toBeLessThanOrEqual(150_000_000);
    expect(report.completed.slice(0, 2)).toEqual(['Searched for step 1', 'Searched for step 2']);
    expect(adapter.requests.length).toBe(report.steps.length);
  });

  it('[AI-011] (2) stops at the step limit, and refuses a run without limits or a price', async () => {
    const clock = new VirtualClock();
    const adapter = new AgentFake([{ output: 100, latencyMs: 1, tools: ['find_tickets'] }], clock);
    const gateway = new AiGateway(adapter);
    const report = await runAgent(gateway, {
      ...base,
      tools: [lookup(clock)],
      limits: { maxSteps: 3, maxWallMs: 60_000 },
      clock,
    });
    expect(report).toMatchObject({ status: 'budget_reached', limit: 'steps' });
    expect(adapter.requests).toHaveLength(3);
    await expect(
      runAgent(gateway, { ...base, tools: [], limits: { maxSteps: 0, maxWallMs: 1 } }),
    ).rejects.toBeInstanceOf(AiPolicyError);
    await expect(
      runAgent(gateway, {
        ...base,
        tools: [],
        limits: { maxSteps: 1, maxWallMs: 1_000, maxCostNanos: 1 },
      }),
    ).rejects.toBeInstanceOf(AiPolicyError);
    expect(() => new ToolRegistry([lookup(clock), lookup(clock)])).toThrow(AiPolicyError);
  });

  it('[AI-011] stops at the deadline: a slow tool or model call is cut off, not waited for', async () => {
    const clock = new VirtualClock(1_000);
    const slowTool = new AgentFake(
      [{ output: 100, latencyMs: 400, tools: ['find_tickets'] }],
      clock,
    );
    const report = await runAgent(new AiGateway(slowTool), {
      ...base,
      tools: [lookup(clock, 10_000)],
      limits: { maxSteps: 10, maxWallMs: 5_000 },
      clock,
    });
    expect(report).toMatchObject({ status: 'budget_reached', limit: 'time', elapsedMs: 5_000 });
    expect(clock.now()).toBe(6_000);
    expect(report.completed).toEqual([]);

    const slowModel = new AgentFake([{ output: 100, latencyMs: 9_000, tools: [] }], clock);
    const second = await runAgent(new AiGateway(slowModel), {
      ...base,
      tools: [],
      limits: { maxSteps: 10, maxWallMs: 2_000 },
      clock,
    });
    expect(second).toMatchObject({ status: 'budget_reached', limit: 'time', elapsedMs: 2_000 });
    // The cancelled call billed nothing the fake reported.
    expect(slowModel.billed).toEqual([]);
  });

  it('[AI-011] a caller can cancel a run', async () => {
    const clock = new VirtualClock();
    const controller = new AbortController();
    const tool: AgentTool<{ q: string }> = {
      ...lookup(clock),
      run: async () => {
        controller.abort();
        return { content: 'late' };
      },
    };
    const adapter = new AgentFake([{ output: 100, latencyMs: 1, tools: ['find_tickets'] }], clock);
    const report = await runAgent(new AiGateway(adapter), {
      ...base,
      tools: [tool],
      limits: { maxSteps: 10, maxWallMs: 60_000 },
      signal: controller.signal,
      clock,
    });
    expect(report.status).toBe('cancelled');
    expect(adapter.requests).toHaveLength(1);
  });

  it('[AI-011] passes the run’s token budget to models that take one, the same on every step', async () => {
    const clock = new VirtualClock();
    const script: FakeStep[] = [
      { output: 100, latencyMs: 1, tools: ['find_tickets'] },
      { output: 100, latencyMs: 1, tools: [] },
    ];
    const capable = new AgentFake(script, clock);
    await runAgent(new AiGateway(capable), {
      ...base,
      tools: [lookup(clock)],
      limits: { maxSteps: 5, maxTokens: 64_000, maxWallMs: 60_000 },
      clock,
    });
    expect(capable.requests.map((r) => r.taskBudget)).toEqual([64_000, 64_000]);
    // Each step's output cap leaves room for what the run already used.
    const caps = capable.requests.map((r) => r.maxTokens);
    expect(caps[0]).toBe(16_000);
    // Not sent to a model without it, nor below the provider's minimum.
    const other = new AgentFake(script, clock, { taskBudget: false });
    await runAgent(new AiGateway(other), {
      ...base,
      tools: [lookup(clock)],
      limits: { maxSteps: 5, maxTokens: 64_000, maxWallMs: 60_000 },
      clock,
    });
    expect(other.requests.map((r) => r.taskBudget)).toEqual([undefined, undefined]);
    const small = new AgentFake(script, clock);
    await runAgent(new AiGateway(small), {
      ...base,
      tools: [lookup(clock)],
      limits: { maxSteps: 5, maxTokens: 19_999, maxWallMs: 60_000 },
      clock,
    });
    expect(small.requests[0]?.taskBudget).toBeUndefined();
  });

  it('[AI-011] [IAM-022] feeds tool errors back to the model and redacts what tools mark sensitive', async () => {
    const clock = new VirtualClock();
    const adapter = new AgentFake(
      [
        { output: 100, latencyMs: 1, tools: ['read_account', 'failing_tool'] },
        { output: 100, latencyMs: 1, tools: [] },
      ],
      clock,
    );
    const account: AgentTool<{ q: string }> = {
      name: 'read_account',
      description: 'Read the account.',
      input: z.object({ q: z.string() }),
      run: async () => ({
        content: 'Account ACCT-9911-SECRET is overdue',
        sensitive: [{ value: 'ACCT-9911-SECRET', label: 'Account number' }],
      }),
    };
    const failing: AgentTool<{ q: string }> = {
      name: 'failing_tool',
      description: 'Always fails.',
      input: z.object({ q: z.string() }),
      run: async () => {
        throw new Error('The search index is rebuilding.');
      },
    };
    const report = await runAgent(new AiGateway(adapter), {
      ...base,
      tools: [account, failing],
      limits: { maxSteps: 5, maxWallMs: 60_000 },
      clock,
    });
    expect(report.status).toBe('completed');
    expect(report.steps[0]?.toolCalls).toEqual([
      { name: 'read_account', ok: true },
      { name: 'failing_tool', ok: false },
    ]);
    const sent = JSON.stringify(adapter.requests[1]?.messages);
    expect(sent).not.toContain('ACCT-9911');
    expect(sent).toContain('[redacted: Account number]');
    expect(sent).toContain('The search index is rebuilding.');
    // A call to a tool outside the registry never runs: the gateway refuses the answer.
    const stray = new AgentFake([{ output: 100, latencyMs: 1, tools: ['delete_track'] }], clock);
    const refused = await runAgent(new AiGateway(stray), {
      ...base,
      tools: [account],
      limits: { maxSteps: 5, maxWallMs: 60_000 },
      clock,
    });
    expect(refused).toMatchObject({ status: 'failed', completed: [] });
    expect(refused.error).toMatch(/unknown tool "delete_track"/);
  });

  it('[AI-011] (2) no run exceeds its step, token, cost or time limit (property)', async () => {
    const step = fc.record({
      output: fc.integer({ min: 1, max: 20_000 }),
      latencyMs: fc.integer({ min: 0, max: 4_000 }),
      tools: fc.array(fc.constantFrom('find_tickets', 'other'), { maxLength: 2 }),
      cached: fc.constantFrom(0, 0.5, 0.9),
    });
    const limits = fc.record(
      {
        maxSteps: fc.integer({ min: 1, max: 8 }),
        maxTokens: fc.integer({ min: 500, max: 120_000 }),
        maxInputTokens: fc.integer({ min: 200, max: 60_000 }),
        maxOutputTokens: fc.integer({ min: 500, max: 60_000 }),
        maxCostNanos: fc.integer({ min: 1_000_000, max: 2_000_000_000 }),
        maxWallMs: fc.integer({ min: 100, max: 20_000 }),
      },
      { requiredKeys: ['maxSteps', 'maxWallMs'] },
    );
    await fc.assert(
      fc.asyncProperty(
        fc.array(step, { minLength: 1, maxLength: 10 }),
        limits,
        fc.integer({ min: 0, max: 3_000 }),
        async (script, limits, toolMs) => {
          const clock = new VirtualClock(10_000);
          const adapter = new AgentFake(script, clock);
          const other: AgentTool<{ q: string }> = { ...lookup(clock, toolMs), name: 'other' };
          const report = await runAgent(new AiGateway(adapter, { retry: { maxRetries: 0 } }), {
            ...base,
            tools: [lookup(clock, toolMs), other],
            limits,
            price: OPUS,
            clock,
          });
          // What the provider billed is what the run counted.
          const billed = adapter.billed.reduce((sum, u) => sum + totalTokens(u), 0);
          expect(totalTokens(report.usage)).toBe(billed);
          expect(adapter.requests.length).toBeLessThanOrEqual(limits.maxSteps);
          expect(report.steps.length).toBeLessThanOrEqual(limits.maxSteps);
          if (limits.maxTokens !== undefined) {
            expect(totalTokens(report.usage)).toBeLessThanOrEqual(limits.maxTokens);
          }
          if (limits.maxInputTokens !== undefined) {
            const input =
              report.usage.inputTokens +
              report.usage.cacheReadTokens +
              report.usage.cacheWriteTokens;
            expect(input).toBeLessThanOrEqual(limits.maxInputTokens);
          }
          if (limits.maxOutputTokens !== undefined) {
            expect(report.usage.outputTokens).toBeLessThanOrEqual(limits.maxOutputTokens);
          }
          if (limits.maxCostNanos !== undefined) {
            expect(report.costNanos).toBeLessThanOrEqual(limits.maxCostNanos);
          }
          expect(clock.now() - 10_000).toBeLessThanOrEqual(limits.maxWallMs);
          expect(['completed', 'budget_reached', 'failed']).toContain(report.status);
          if (report.status === 'budget_reached') expect(report.limit).not.toBeNull();
        },
      ),
    );
  });
});
