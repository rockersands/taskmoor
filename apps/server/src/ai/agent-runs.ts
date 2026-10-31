import {
  type AgentClock,
  type AgentLimits,
  type AgentReport,
  type AgentTool,
  AiError,
  AiPolicyError,
  type FeatureId,
  resolveFeature,
  runAgent,
  type SensitiveValue,
  type ToolRegistry,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { emit } from '../events/bus';
import type { AiService } from './service';
import { priceFor } from './usage';

/** No AI provider is set up for the workspace. */
export class AiNotConfiguredError extends AiError {
  override name = 'AiNotConfiguredError';
}

export interface AgentRunInput {
  workspaceId: number;
  /** The person the run acts for: their limits apply and the audit names them. */
  userId: number | null;
  trackId?: number | null;
  feature: FeatureId;
  system: string;
  context?: string;
  task: string;
  /** The run's allowlist (IAM-023 (4)); each tool acts with the person's own rights. */
  tools: ToolRegistry | readonly AgentTool<unknown>[];
  limits: AgentLimits;
  sensitive?: readonly SensitiveValue[];
  signal?: AbortSignal;
  clock?: AgentClock;
  /** Where the run's report goes when it ends, budget reached or not (AI-011 (1)). */
  post?: (report: AgentReport) => Promise<void>;
}

/**
 * Agent runs for AI features (M1-131; AI-011; ADR-101): the loop of `@taskmoor/ai` on the
 * workspace's gateway, so each step is limited, redacted and booked like any call (M1-077), the
 * cost limit is priced from the workspace's price table, and every run ends with one audited
 * `ai_run.finished` record of how it ended, which limit stopped it and what it used, with the
 * report posted to the feature.
 */
export class AgentRuns {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly ai: AiService,
  ) {}

  async run(input: AgentRunInput): Promise<AgentReport> {
    const configured = await this.ai.configured(input.workspaceId);
    const gateway = await this.ai.gateway(input.workspaceId);
    if (!configured || !gateway) throw new AiNotConfiguredError('AI is not set up');
    const model = resolveFeature(input.feature, configured.features?.[input.feature]).model;
    const prices = await this.ai.settings.pricesOf(input.workspaceId);
    const price = priceFor(prices, { provider: configured.adapter.provider, model }, model)?.price;
    if (input.limits.maxCostNanos !== undefined && !price) {
      throw new AiPolicyError(`A cost limit needs a price for ${model}`);
    }
    const report = await runAgent(gateway, {
      feature: input.feature,
      system: input.system,
      ...(input.context ? { context: input.context } : {}),
      task: input.task,
      tools: input.tools,
      limits: input.limits,
      ...(price ? { price } : {}),
      tag: { userId: input.userId, trackId: input.trackId ?? null },
      ...(input.sensitive ? { sensitive: input.sensitive } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.clock ? { clock: input.clock } : {}),
    });
    const tools: Record<string, number> = {};
    for (const step of report.steps) {
      for (const call of step.toolCalls) tools[call.name] = (tools[call.name] ?? 0) + 1;
    }
    await this.db.transaction().execute((trx) =>
      emit(
        trx,
        { workspaceId: input.workspaceId, actorId: input.userId },
        {
          type: 'ai_run.finished',
          subjectId: report.runId,
          payload: {
            feature: report.feature,
            status: report.status,
            limit: report.limit,
            steps: report.steps.length,
            inputTokens:
              report.usage.inputTokens +
              report.usage.cacheReadTokens +
              report.usage.cacheWriteTokens,
            outputTokens: report.usage.outputTokens,
            costNanos: report.costNanos,
            elapsedMs: report.elapsedMs,
            // Tool names and counts only: what the tools read stays out of the audit log.
            tools,
            limits: {
              maxSteps: input.limits.maxSteps,
              maxWallMs: input.limits.maxWallMs,
              maxTokens: input.limits.maxTokens ?? null,
              maxInputTokens: input.limits.maxInputTokens ?? null,
              maxOutputTokens: input.limits.maxOutputTokens ?? null,
              maxCostNanos: input.limits.maxCostNanos ?? null,
            },
          },
        },
      ),
    );
    await input.post?.(report);
    return report;
  }
}
