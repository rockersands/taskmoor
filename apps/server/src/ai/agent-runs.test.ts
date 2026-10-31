import { type AgentReport, type AgentTool, LIST_PRICES } from '@taskmoor/ai';
import { FakeAdapter, VirtualClock } from '@taskmoor/ai/testing';
import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { buildApp } from '../app';
import { EVENT_TYPES } from '../events/catalogue';
import { type AiConfigured, AiUnavailableError } from './service';

const usage = { inputTokens: 300, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 };
/** One Opus step above: 300 * $4 + 100 * $20 per million tokens. */
const STEP_NANOS = 3_200_000;
const toolCall = (n: number) => ({
  text: `Looking up part ${n}`,
  stopReason: 'tool_use' as const,
  toolCalls: [{ id: `call_${n}`, name: 'find_tickets', input: { q: `part ${n}` } }],
  usage,
});

/**
 * Agent runs on the server (M1-131; AI-011): the loop on the workspace's gateway, with its
 * steps booked in the AI audit log, a cost limit priced from the price table, and one audited
 * record per run. Recorded answers from a fake provider; nothing calls a network.
 */
describe('agent runs with budgets on the server (M1-131)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let configured: AiConfigured | null = null;
  let userId = 0;
  const lookup: AgentTool<{ q: string }> = {
    name: 'find_tickets',
    description: 'Search tickets.',
    input: z.object({ q: z.string() }),
    run: async ({ q }) => ({ content: `WEB-3 matches ${q}`, done: `Searched for ${q}` }),
  };

  beforeAll(async () => {
    app = await buildApp({
      db: database.db,
      version: 'test',
      roles: ['api'],
      ai: { source: async () => configured, gateway: { retry: { maxRetries: 0 } } },
    });
    userId = (
      await database.db
        .insertInto('app_user')
        .values({ workspace_id: 1, email: 'ada@example.com', name: 'Ada', password_hash: 'x' })
        .returning('id')
        .executeTakeFirstOrThrow()
    ).id;
  });

  afterAll(async () => {
    await app?.close();
  });

  const agents = () => {
    const found = app.ai?.agents;
    if (!found) throw new Error('no agent runs');
    return found;
  };

  it('[AI-011] (1) a run hitting its cost limit stops, records "budget reached" and posts what it completed', async () => {
    configured = {
      adapter: new FakeAdapter([toolCall(1), toolCall(2), toolCall(3), toolCall(4)]),
    };
    const posted: AgentReport[] = [];
    const report = await agents().run({
      workspaceId: 1,
      userId,
      feature: 'assisted-creation',
      system: 'Break the ticket down.',
      task: 'Break down WEB-7.',
      tools: [lookup],
      // A step needs room for 1,024 output tokens in the worst case: two steps fit, a third not.
      limits: { maxSteps: 10, maxWallMs: 60_000, maxCostNanos: 25_000_000 },
      clock: new VirtualClock(),
      post: async (r) => {
        posted.push(r);
      },
    });
    expect(report).toMatchObject({
      status: 'budget_reached',
      limit: 'cost',
      completed: ['Searched for part 1', 'Searched for part 2'],
      costNanos: 2 * STEP_NANOS,
    });
    expect(posted).toEqual([report]);
    const event = await database.db
      .selectFrom('domain_event')
      .select(['type', 'subject_type', 'subject_id', 'actor_id', 'payload'])
      .where('type', '=', 'ai_run.finished')
      .executeTakeFirstOrThrow();
    expect(event).toMatchObject({
      subject_type: 'ai_run',
      subject_id: report.runId,
      actor_id: userId,
    });
    expect(event.payload).toMatchObject({
      status: 'budget_reached',
      limit: 'cost',
      steps: 2,
      costNanos: 2 * STEP_NANOS,
      tools: { find_tickets: 2 },
    });
    expect(() => EVENT_TYPES['ai_run.finished'].payload.parse(event.payload)).not.toThrow();
    // Each step is one row of the AI audit log, tagged with the run.
    const rows = await database.db
      .selectFrom('ai_call')
      .select(['run_id', 'user_id', 'outcome', 'cost_nanos'])
      .where('run_id', '=', report.runId)
      .execute();
    expect(rows.map((r) => [r.user_id, r.outcome, Number(r.cost_nanos)])).toEqual([
      [userId, 'ok', STEP_NANOS],
      [userId, 'ok', STEP_NANOS],
    ]);
  });

  it('[AI-011] [OPS-020] a workspace spend limit stops a run like its own limits do', async () => {
    configured = { adapter: new FakeAdapter([toolCall(1)]) };
    await database.db
      .insertInto('ai_spend_limit')
      .values({
        workspace_id: 1,
        scope: 'user',
        user_id: userId,
        period: 'day',
        metric: 'tokens',
        amount: 2_000,
      })
      .execute();
    app.ai?.service.settings.changed(1);
    const report = await agents().run({
      workspaceId: 1,
      userId,
      feature: 'assisted-creation',
      system: 'Break the ticket down.',
      task: 'Break down WEB-8.',
      tools: [lookup],
      limits: { maxSteps: 10, maxWallMs: 60_000 },
      clock: new VirtualClock(),
    });
    expect(report).toMatchObject({ status: 'budget_reached', limit: 'spend_limit' });
    await database.db.deleteFrom('ai_spend_limit').execute();
    app.ai?.service.settings.changed(1);
  });

  it('[AI-011] needs a provider, and a price for a cost limit', async () => {
    configured = null;
    const input = {
      workspaceId: 1,
      userId,
      feature: 'assisted-creation' as const,
      system: 'x',
      task: 'y',
      tools: [lookup],
      limits: { maxSteps: 1, maxWallMs: 1_000, maxCostNanos: 1_000_000 },
    };
    await expect(agents().run(input)).rejects.toBeInstanceOf(AiUnavailableError);
    configured = { adapter: new FakeAdapter([toolCall(1)], { provider: 'bedrock' }) };
    await expect(agents().run(input)).rejects.toThrow(/price/);
    expect(LIST_PRICES.some((p) => p.provider === 'bedrock')).toBe(false);
  });
});
