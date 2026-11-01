import type { z } from 'zod';
import { AiAbortedError, AiOutputError, AiPolicyError, AiSpendLimitError } from './errors';
import { AI_FEATURES, type FeatureId } from './features';
import type { AiGateway, AiTool, GenerateRequest, GenerateResult } from './gateway';
import type { SensitiveValue } from './redact';
import { type CallTag, callCost, type ModelPrice, totalTokens, ZERO_USAGE } from './spend';
import type { ChatMessage, ContentPart, Usage } from './types';

/**
 * Agent runs with budgets (M1-131; AI-011; ADR-101): the model calls tools, the loop runs them
 * through a registry and feeds the results back, until the model answers without a tool call or
 * a limit would be passed. Every limit is enforced before it can be passed, not after:
 *
 * - steps: model calls; the next one is not made once the count is reached;
 * - tokens (all, input, output) and cost: before each call the loop counts the prompt's input
 *   tokens with the provider's counter and caps the call's output (`max_tokens`, which thinking
 *   counts against) so that the worst case still fits; a step with too little room left is not
 *   made;
 * - wall time: one deadline for the run; a model call or tool still running at the deadline is
 *   cancelled and its result not waited for.
 *
 * On any limit the run stops gracefully: no further call, status `budget_reached` with the
 * limit's name, and a report of what it completed. Models that take a task budget (Claude on
 * the Anthropic API) are told the run's token budget, so they pace themselves.
 */

export interface AgentToolContext {
  runId: string;
  step: number;
  /** Aborted at the run's deadline or when the caller cancels: stop work then. */
  signal: AbortSignal;
}

export interface AgentToolResult {
  /** What the model reads. */
  content: string;
  isError?: boolean;
  /** Values of fields marked sensitive that `content` was built from (IAM-022). */
  sensitive?: readonly SensitiveValue[];
  /** A line for the run's report, when the call did something worth naming. */
  done?: string;
}

/** A tool the agent may call: its input is validated against `input` before `run` sees it. */
export interface AgentTool<I = unknown> {
  name: string;
  description: string;
  input: z.ZodType<I>;
  /**
   * `write` for a tool that changes anything (M1-118; AI v1 "writes need user confirmation"):
   * the loop runs it only when the run's `confirm` approves that call, so text in a ticket
   * cannot make the model change data on its own. Tools that only read leave it out.
   */
  effect?: 'read' | 'write';
  run(input: I, context: AgentToolContext): Promise<AgentToolResult>;
}

/** The tools an agent may use (IAM-023 (4): its allowlist); names are unique. */
export class ToolRegistry {
  private readonly tools = new Map<string, AgentTool>();

  constructor(tools: readonly AgentTool<unknown>[] = []) {
    for (const tool of tools) this.register(tool);
  }

  register<I>(tool: AgentTool<I>): this {
    if (this.tools.has(tool.name)) throw new AiPolicyError(`Duplicate tool name "${tool.name}"`);
    this.tools.set(tool.name, tool as AgentTool);
    return this;
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }

  get names(): string[] {
    return [...this.tools.keys()];
  }

  /** The tools as the gateway offers them to the model. */
  specs(): AiTool[] {
    return [...this.tools.values()].map(({ name, description, input }) => ({
      name,
      description,
      input,
    }));
  }
}

export interface AgentLimits {
  /** Model calls. */
  maxSteps: number;
  /** Every token billed: input, output, cache reads and cache writes. */
  maxTokens?: number;
  /** Input tokens, cache reads and writes included. */
  maxInputTokens?: number;
  /** Output tokens, thinking included. */
  maxOutputTokens?: number;
  /** Cost in billionths of a dollar; needs the model's price. */
  maxCostNanos?: number;
  /** Wall-clock time for the whole run. */
  maxWallMs: number;
}

export const AGENT_LIMITS = [
  'steps',
  'tokens',
  'input_tokens',
  'output_tokens',
  'cost',
  'time',
  /** A workspace, feature or person spend limit of M1-077 refused the next call. */
  'spend_limit',
] as const;
export type AgentLimit = (typeof AGENT_LIMITS)[number];

export type AgentStatus = 'completed' | 'budget_reached' | 'refused' | 'failed' | 'cancelled';

export interface AgentStep {
  step: number;
  usage: Usage;
  costNanos: number;
  /** The output cap the step was sent with. */
  maxOutputTokens: number;
  text: string;
  toolCalls: { name: string; ok: boolean }[];
}

/** What a run did, for the caller to post and the audit to record. */
export interface AgentReport {
  runId: string;
  feature: FeatureId;
  status: AgentStatus;
  /** Which limit stopped it, for `budget_reached`. */
  limit: AgentLimit | null;
  steps: AgentStep[];
  usage: Usage;
  costNanos: number;
  elapsedMs: number;
  /** What the tools did, in order: their `done` lines, else their names. */
  completed: string[];
  /** The model's last text. */
  answer: string;
  /** For `failed`: what went wrong (no prompt content). */
  error: string | null;
}

/** Time for the run; tests pass a virtual clock. */
export interface AgentClock {
  now(): number;
  /** Calls `fire` after `ms`; returns a function that cancels it. */
  after(ms: number, fire: () => void): () => void;
}

export const SYSTEM_CLOCK: AgentClock = {
  now: () => Date.now(),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

/** The smallest task budget the Anthropic API accepts. */
export const MIN_TASK_BUDGET = 20_000;

export interface AgentRunOptions {
  feature: FeatureId;
  system: string;
  context?: string;
  /** The task, or a conversation to continue. */
  task: string | ChatMessage[];
  tools: ToolRegistry | readonly AgentTool<unknown>[];
  limits: AgentLimits;
  /** The model's price, for a cost limit and the report's cost. */
  price?: ModelPrice;
  tag?: CallTag;
  runId?: string;
  /** Values of sensitive fields the task was built from. */
  sensitive?: readonly SensitiveValue[];
  signal?: AbortSignal;
  clock?: AgentClock;
  /** The fewest output tokens worth a step (1,024): with less room the run stops. */
  minStepOutputTokens?: number;
  /**
   * Asks the person whether a `write` tool may run with this input. Without it, no write tool
   * runs: the model is told the call needs the person's confirmation.
   */
  confirm?: (call: { name: string; input: unknown }) => Promise<boolean>;
}

/** What the model reads when a write was not confirmed. */
export const NOT_CONFIRMED = (name: string) =>
  `${name} changes data and needs the person's confirmation; it was not run.`;

function addUsage(a: Usage, b: Usage): Usage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

const inputOf = (u: Usage) => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;

/** The dearest rates a prompt of `tokens` can be billed at. */
function worstRates(price: ModelPrice, tokens: number) {
  const long = price.longContext && tokens > price.longContext.aboveTokens;
  const input = Math.max(
    long && price.longContext ? price.longContext.inputNanos : price.inputNanos,
    price.cacheWriteNanos,
    price.cacheReadNanos,
  );
  // The output rate depends on the prompt's size, which is known: take the long rate only
  // when the prompt may be long.
  const output = long && price.longContext ? price.longContext.outputNanos : price.outputNanos;
  return { input, output };
}

/** Input tokens a request would use: the provider's count, or an upper estimate without one. */
async function countInput(gateway: AiGateway, request: GenerateRequest, signal: AbortSignal) {
  if (gateway.capabilities(request.feature).tokenCounting) {
    return gateway.countTokens(request, { signal });
  }
  // About four characters a token in practice; two leaves room for code and other scripts.
  const text = JSON.stringify([request.system, request.context ?? '', request.messages]);
  return Math.ceil(text.length / 2);
}

class Stop extends Error {
  constructor(
    readonly status: AgentStatus,
    readonly limit: AgentLimit | null = null,
    readonly reason: string | null = null,
  ) {
    super(status);
  }
}

/** Runs an agent loop to its end or its first limit. Never throws for a limit. */
export async function runAgent(gateway: AiGateway, options: AgentRunOptions): Promise<AgentReport> {
  const limits = options.limits;
  if (!Number.isInteger(limits.maxSteps) || limits.maxSteps < 1) {
    throw new AiPolicyError('An agent run needs at least one step');
  }
  if (!(limits.maxWallMs > 0)) throw new AiPolicyError('An agent run needs a time limit');
  if (limits.maxCostNanos !== undefined && !options.price) {
    throw new AiPolicyError('A cost limit needs the price of the model');
  }
  const registry =
    options.tools instanceof ToolRegistry ? options.tools : new ToolRegistry(options.tools);
  const clock = options.clock ?? SYSTEM_CLOCK;
  const runId = options.runId ?? crypto.randomUUID();
  const featureMax = AI_FEATURES[options.feature].maxOutputTokens;
  const minStep = options.minStepOutputTokens ?? 1_024;
  const started = clock.now();

  const controller = new AbortController();
  let timedOut = false;
  const cancelTimer = clock.after(limits.maxWallMs, () => {
    timedOut = true;
    controller.abort();
  });
  const onOuterAbort = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', onOuterAbort, { once: true });
  // Rejects at the deadline or on cancel, so nothing outlives the run.
  const aborted = new Promise<never>((_, reject) => {
    const fail = () => reject(new AiAbortedError('The agent run was stopped'));
    if (controller.signal.aborted) fail();
    else controller.signal.addEventListener('abort', fail, { once: true });
  });
  aborted.catch(() => {});

  const stopped = () =>
    new Stop(timedOut ? 'budget_reached' : 'cancelled', timedOut ? 'time' : null);
  const taskBudget = limits.maxTokens ?? limits.maxOutputTokens;
  const messages: ChatMessage[] =
    typeof options.task === 'string'
      ? [{ role: 'user', content: options.task }]
      : [...options.task];
  const sensitive: SensitiveValue[] = [...(options.sensitive ?? [])];
  const steps: AgentStep[] = [];
  const completed: string[] = [];
  let usage = ZERO_USAGE;
  let cost = 0;
  let answer = '';
  const book = (u: Usage) => {
    usage = addUsage(usage, u);
    const c = options.price ? callCost(u, options.price) : 0;
    cost += c;
    return c;
  };

  const report = (stop: Stop): AgentReport => ({
    runId,
    feature: options.feature,
    status: stop.status,
    limit: stop.limit,
    steps,
    usage,
    costNanos: cost,
    elapsedMs: clock.now() - started,
    completed,
    answer,
    error: stop.reason,
  });

  try {
    for (;;) {
      if (controller.signal.aborted) throw stopped();
      if (steps.length >= limits.maxSteps) throw new Stop('budget_reached', 'steps');
      const request: GenerateRequest = {
        feature: options.feature,
        system: options.system,
        ...(options.context ? { context: options.context } : {}),
        messages,
        tools: registry.specs(),
        tag: { ...options.tag, runId },
        sensitive,
        ...(taskBudget !== undefined && taskBudget >= MIN_TASK_BUDGET ? { taskBudget } : {}),
      };

      // The room this step has: the output cap that keeps every limit in the worst case.
      let input: number;
      try {
        input = await Promise.race([countInput(gateway, request, controller.signal), aborted]);
      } catch (error) {
        if (error instanceof AiAbortedError) throw stopped();
        throw error;
      }
      const caps: [number, AgentLimit | null][] = [[featureMax, null]];
      if (limits.maxInputTokens !== undefined && inputOf(usage) + input > limits.maxInputTokens) {
        throw new Stop('budget_reached', 'input_tokens');
      }
      if (limits.maxOutputTokens !== undefined) {
        caps.push([limits.maxOutputTokens - usage.outputTokens, 'output_tokens']);
      }
      if (limits.maxTokens !== undefined) {
        caps.push([limits.maxTokens - totalTokens(usage) - input, 'tokens']);
      }
      if (limits.maxCostNanos !== undefined && options.price) {
        const rates = worstRates(options.price, input);
        const left = limits.maxCostNanos - cost - input * rates.input;
        caps.push([
          rates.output > 0 ? Math.floor(left / rates.output) : left < 0 ? -1 : featureMax,
          'cost',
        ]);
      }
      const [room, boundBy] = caps.reduce((a, b) => (b[0] < a[0] ? b : a));
      if (room < minStep) throw new Stop('budget_reached', boundBy ?? 'tokens');

      let result: GenerateResult;
      try {
        result = await Promise.race([
          gateway.generate({ ...request, maxOutputTokens: room }, { signal: controller.signal }),
          aborted,
        ]);
      } catch (error) {
        if (error instanceof AiOutputError && error.usage) {
          const c = book(error.usage);
          steps.push({
            step: steps.length + 1,
            usage: error.usage,
            costNanos: c,
            maxOutputTokens: room,
            text: '',
            toolCalls: [],
          });
          // Cut off by the room the budget left: the limit stopped it.
          if (boundBy && room < featureMax && /cut off/.test(error.message)) {
            throw new Stop('budget_reached', boundBy);
          }
          throw new Stop('failed', null, error.message);
        }
        if (error instanceof AiAbortedError) throw stopped();
        if (error instanceof AiSpendLimitError) throw new Stop('budget_reached', 'spend_limit');
        throw new Stop('failed', null, error instanceof Error ? error.message : String(error));
      }
      const stepCost = book(result.usage);
      const step: AgentStep = {
        step: steps.length + 1,
        usage: result.usage,
        costNanos: stepCost,
        maxOutputTokens: room,
        text: result.text,
        toolCalls: [],
      };
      steps.push(step);
      if (result.text) answer = result.text;
      if (result.refused) throw new Stop('refused');
      if (result.toolCalls.length === 0) {
        if (result.stopReason === 'max_tokens' && boundBy && room < featureMax) {
          throw new Stop('budget_reached', boundBy);
        }
        throw new Stop('completed');
      }

      const parts: ContentPart[] = [];
      for (const call of result.toolCalls) {
        const tool = registry.get(call.name);
        let outcome: AgentToolResult;
        // A write runs only with the person's yes (M1-118); a confirm that fails is a no.
        let approved = true;
        if (tool?.effect === 'write') {
          try {
            approved = options.confirm
              ? await Promise.race([
                  options.confirm({ name: call.name, input: call.input }),
                  aborted,
                ])
              : false;
          } catch (error) {
            if (error instanceof AiAbortedError || controller.signal.aborted) throw stopped();
            approved = false;
          }
        }
        if (!tool) {
          outcome = { content: `No tool is named ${call.name}.`, isError: true };
        } else if (!approved) {
          outcome = { content: NOT_CONFIRMED(call.name), isError: true };
        } else {
          try {
            outcome = await Promise.race([
              tool.run(call.input as never, {
                runId,
                step: step.step,
                signal: controller.signal,
              }),
              aborted,
            ]);
          } catch (error) {
            if (error instanceof AiAbortedError || controller.signal.aborted) throw stopped();
            outcome = {
              content: error instanceof Error ? error.message : 'The tool failed.',
              isError: true,
            };
          }
        }
        step.toolCalls.push({ name: call.name, ok: !outcome.isError });
        if (!outcome.isError) completed.push(outcome.done ?? call.name);
        if (outcome.sensitive) sensitive.push(...outcome.sensitive);
        parts.push({
          type: 'tool-result',
          toolCallId: call.id,
          content: outcome.content,
          ...(outcome.isError ? { isError: true } : {}),
        });
      }
      if (controller.signal.aborted) throw stopped();
      messages.push(result.message, { role: 'user', content: parts });
    }
  } catch (error) {
    if (error instanceof Stop) return report(error);
    throw error;
  } finally {
    cancelTimer();
    options.signal?.removeEventListener('abort', onOuterAbort);
  }
}
