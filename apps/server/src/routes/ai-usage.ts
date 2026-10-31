import {
  AI_FEATURES,
  type FeatureId,
  nanosOf,
  periodWindow,
  REDACTION_PATTERNS,
  SPEND_METRICS,
  SPEND_PERIODS,
  SPEND_SCOPES,
  usdPerMillionOf,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import type { AiService } from '../ai/service';
import { dataStatement } from '../ai/statement';
import {
  counterKey,
  type PriceRow,
  readLimits,
  readPolicy,
  readPrices,
  type StoredLimit,
} from '../ai/usage';
import { requireSiteAdmin, requireUser } from '../auth';
import { diff, emit } from '../events/bus';
import { isFieldKey } from '../fields/layouts';

/**
 * The AI usage dashboard and the spend, price and data settings behind it, for site
 * administrators (M1-077; OPS-020, IAM-021, IAM-022; ADR-100), and the data-egress notice
 * every person reads before their first AI use.
 *
 * - `GET /admin/ai/usage`: totals by day, feature, person and model for a date range (UTC),
 *   from the same transaction that writes the audit log, so they match it;
 * - `GET /admin/ai/calls`: the AI audit log, newest first, one row per call;
 * - `/admin/ai/limits`: hard stops with their current use and the alerts they raised;
 * - `/admin/ai/prices`: the price table, list prices to verify beside administrators' rates;
 * - `/admin/ai/policy`: content logging days and redaction (patterns, terms, fields);
 * - `GET /admin/ai/statement` and `/ai/notice`: what leaves the instance.
 */
const FEATURE_IDS = Object.keys(AI_FEATURES) as [FeatureId, ...FeatureId[]];
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const rangeQuery = z.object({ from: day.optional(), to: day.optional() });
const MAX_DAYS = 366;
const id = z.coerce.number().int().positive();
const usd = z.number().min(0).max(100_000);

const limitBody = z
  .object({
    scope: z.enum(SPEND_SCOPES),
    feature: z.enum(FEATURE_IDS).nullable().optional(),
    userId: z.number().int().positive().nullable().optional(),
    period: z.enum(SPEND_PERIODS),
    metric: z.enum(SPEND_METRICS),
    /** Tokens, or US dollars for a cost limit. */
    amount: z.number().positive().max(1e12),
    alertPercents: z.array(z.number().int().min(1).max(100)).max(5).optional(),
  })
  .strict();
const limitPatch = limitBody.partial().strict();

const priceBody = z
  .object({
    provider: z.string().min(1).max(40),
    model: z.string().min(1).max(200),
    input: usd,
    output: usd,
    cacheRead: usd,
    cacheWrite: usd,
    longContext: z
      .object({ aboveTokens: z.number().int().positive(), input: usd, output: usd })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();
const priceKey = z.object({
  provider: z.string().min(1).max(40),
  model: z.string().min(1).max(200),
});

const policyBody = z
  .object({
    contentDays: z.number().int().min(0).max(90).optional(),
    patterns: z.array(z.enum(REDACTION_PATTERNS)).max(REDACTION_PATTERNS.length).optional(),
    terms: z.array(z.string().trim().min(1).max(200)).max(200).optional(),
    redactedFields: z.array(z.string().refine(isFieldKey)).max(500).optional(),
  })
  .strict();

const callsQuery = z.object({
  from: day.optional(),
  to: day.optional(),
  userId: id.optional(),
  feature: z.string().max(64).optional(),
  outcome: z.enum(['ok', 'refused', 'error', 'aborted', 'limited']).optional(),
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** The days asked for, both ends included; the last 30 days by default. */
function range(q: z.infer<typeof rangeQuery>, now: Date): { from: string; to: string } | null {
  const to = q.to ?? isoDay(now);
  const from = q.from ?? isoDay(new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000));
  const span = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000;
  if (Number.isNaN(span) || span < 0 || span >= MAX_DAYS) return null;
  return { from, to };
}

const SUMS = [
  sql<string>`sum(calls)`.as('calls'),
  sql<string>`sum(limited)`.as('limited'),
  sql<string>`sum(failed)`.as('failed'),
  sql<string>`sum(unpriced)`.as('unpriced'),
  sql<string>`sum(input_tokens)`.as('inputTokens'),
  sql<string>`sum(output_tokens)`.as('outputTokens'),
  sql<string>`sum(cache_read_tokens)`.as('cacheReadTokens'),
  sql<string>`sum(cache_write_tokens)`.as('cacheWriteTokens'),
  sql<string>`sum(cost_nanos)`.as('costNanos'),
];
interface SumRow {
  calls: string | null;
  limited: string | null;
  failed: string | null;
  unpriced: string | null;
  inputTokens: string | null;
  outputTokens: string | null;
  cacheReadTokens: string | null;
  cacheWriteTokens: string | null;
  costNanos: string | null;
}

function totals(row: SumRow | undefined) {
  const n = (v: string | null | undefined) => Number(v ?? 0);
  return {
    calls: n(row?.calls),
    limited: n(row?.limited),
    failed: n(row?.failed),
    unpriced: n(row?.unpriced),
    inputTokens: n(row?.inputTokens),
    outputTokens: n(row?.outputTokens),
    cacheReadTokens: n(row?.cacheReadTokens),
    cacheWriteTokens: n(row?.cacheWriteTokens),
    costNanos: n(row?.costNanos),
  };
}

function priceView(row: PriceRow) {
  const p = row.price;
  return {
    provider: row.provider,
    model: row.model,
    source: row.source,
    // A list price is a default an administrator should check against their bill.
    verify: row.source === 'list',
    input: usdPerMillionOf(p.inputNanos),
    output: usdPerMillionOf(p.outputNanos),
    cacheRead: usdPerMillionOf(p.cacheReadNanos),
    cacheWrite: usdPerMillionOf(p.cacheWriteNanos),
    longContext: p.longContext
      ? {
          aboveTokens: p.longContext.aboveTokens,
          input: usdPerMillionOf(p.longContext.inputNanos),
          output: usdPerMillionOf(p.longContext.outputNanos),
        }
      : null,
  };
}

/** A limit as the API shows it: a cost amount in US dollars. */
function limitView(limit: StoredLimit) {
  return {
    id: limit.id,
    scope: limit.scope,
    feature: limit.feature,
    userId: limit.userId,
    period: limit.period,
    metric: limit.metric,
    amount: limit.metric === 'cost' ? limit.amount / 1e9 : limit.amount,
    alertPercents: limit.alertPercents,
  };
}

/** A limit's amount as stored: tokens, or nanos for a cost limit. */
const storedAmount = (metric: 'tokens' | 'cost', amount: number) =>
  metric === 'cost' ? Math.round(amount * 1e9) : Math.round(amount);

function limitProblem(l: {
  scope: string;
  feature?: string | null | undefined;
  userId?: number | null | undefined;
}): string | null {
  if (l.scope === 'feature' && !l.feature) return 'feature_required';
  if (l.scope !== 'feature' && l.feature) return 'feature_not_allowed';
  if (l.scope !== 'user' && l.userId) return 'user_not_allowed';
  return null;
}

export function registerAiUsageRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { ai: AiService; now?: () => number },
): void {
  const now = () => new Date(options.now?.() ?? Date.now());
  const ai = options.ai;

  app.get('/api/v1/admin/ai/usage', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const q = rangeQuery.safeParse(request.query);
    const span = q.success ? range(q.data, now()) : null;
    if (!span) return reply.code(400).send({ error: 'invalid_request' });
    const base = db
      .selectFrom('ai_usage_day')
      .where('ai_usage_day.workspace_id', '=', request.workspaceId)
      .where('ai_usage_day.day', '>=', span.from)
      .where('ai_usage_day.day', '<=', span.to);
    const [all, byDay, byFeature, byPerson, byModel] = await Promise.all([
      base.select(SUMS).executeTakeFirst(),
      base
        .select(['day', ...SUMS])
        .groupBy('day')
        .orderBy('day')
        .execute(),
      base
        .select(['feature', ...SUMS])
        .groupBy('feature')
        .orderBy('feature')
        .execute(),
      base
        .leftJoin('app_user as u', 'u.id', 'ai_usage_day.user_id')
        .select(['ai_usage_day.user_id', 'u.name', ...SUMS])
        .groupBy(['ai_usage_day.user_id', 'u.name'])
        .orderBy(sql`sum(cost_nanos)`, 'desc')
        .orderBy(sql`sum(input_tokens + output_tokens)`, 'desc')
        .execute(),
      base
        .select(['provider', 'model', ...SUMS])
        .groupBy(['provider', 'model'])
        .orderBy('provider')
        .orderBy('model')
        .execute(),
    ]);
    return {
      ...span,
      totals: totals(all as SumRow | undefined),
      byDay: byDay.map((r) => ({ day: r.day, ...totals(r as unknown as SumRow) })),
      byFeature: byFeature.map((r) => ({ feature: r.feature, ...totals(r as unknown as SumRow) })),
      byPerson: byPerson.map((r) => ({
        user: r.user_id === 0 ? null : { id: r.user_id, name: r.name ?? '' },
        ...totals(r as unknown as SumRow),
      })),
      byModel: byModel.map((r) => ({
        provider: r.provider,
        model: r.model,
        ...totals(r as unknown as SumRow),
      })),
    };
  });

  app.get('/api/v1/admin/ai/calls', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const parsed = callsQuery.safeParse(request.query);
    const span = parsed.success ? range(parsed.data, now()) : null;
    if (!parsed.success || !span) return reply.code(400).send({ error: 'invalid_request' });
    const q = parsed.data;
    let query = db
      .selectFrom('ai_call as c')
      .leftJoin('app_user as u', 'u.id', 'c.user_id')
      .select([
        'c.id',
        'c.occurred_at',
        'c.user_id',
        'u.name as user_name',
        'c.track_id',
        'c.run_id',
        'c.feature',
        'c.provider',
        'c.model',
        'c.served_model',
        'c.mode',
        'c.outcome',
        'c.error_kind',
        'c.limit_id',
        'c.input_tokens',
        'c.output_tokens',
        'c.cache_read_tokens',
        'c.cache_write_tokens',
        'c.cost_nanos',
        'c.priced',
        'c.latency_ms',
        'c.retries',
        'c.fell_back',
        'c.content',
      ])
      .where('c.workspace_id', '=', request.workspaceId)
      .where('c.occurred_at', '>=', new Date(`${span.from}T00:00:00Z`))
      .where('c.occurred_at', '<', new Date(Date.parse(`${span.to}T00:00:00Z`) + 86_400_000));
    if (q.userId !== undefined) query = query.where('c.user_id', '=', q.userId);
    if (q.feature !== undefined) query = query.where('c.feature', '=', q.feature);
    if (q.outcome !== undefined) query = query.where('c.outcome', '=', q.outcome);
    if (q.before !== undefined) query = query.where('c.id', '<', String(q.before));
    const rows = await query
      .orderBy('c.occurred_at', 'desc')
      .orderBy('c.id', 'desc')
      .limit(q.limit + 1)
      .execute();
    const page = rows.slice(0, q.limit);
    return {
      calls: page.map((r) => ({
        id: Number(r.id),
        at: r.occurred_at.toISOString(),
        user: r.user_id === null ? null : { id: r.user_id, name: r.user_name ?? '' },
        trackId: r.track_id,
        runId: r.run_id,
        feature: r.feature,
        provider: r.provider,
        model: r.model,
        servedModel: r.served_model,
        mode: r.mode,
        outcome: r.outcome,
        errorKind: r.error_kind,
        limitId: r.limit_id,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        costNanos: Number(r.cost_nanos),
        priced: r.priced,
        latencyMs: r.latency_ms,
        retries: r.retries,
        fellBack: r.fell_back,
        // Only while content logging keeps it (IAM-021).
        content: r.content,
      })),
      next: rows.length > q.limit ? Number(page[page.length - 1]?.id) : null,
    };
  });

  app.get('/api/v1/admin/ai/limits', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const at = now();
    const limits = await readLimits(db, request.workspaceId);
    const counters = await db
      .selectFrom('ai_spend_counter')
      .select(['period', 'period_start', 'key', 'tokens', 'cost_nanos'])
      .where('workspace_id', '=', request.workspaceId)
      .where('period_start', '>=', isoDay(periodWindow('month', at).start))
      .execute();
    const alerts = await db
      .selectFrom('ai_limit_alert')
      .selectAll()
      .where('workspace_id', '=', request.workspaceId)
      .orderBy('raised_at', 'desc')
      .limit(20)
      .execute();
    const ids = [...new Set(limits.flatMap((l) => (l.userId === null ? [] : [l.userId])))];
    const names = new Map(
      (ids.length
        ? await db.selectFrom('app_user').select(['id', 'name']).where('id', 'in', ids).execute()
        : []
      ).map((u) => [u.id, u.name]),
    );
    return {
      limits: limits.map((limit) => {
        const window = periodWindow(limit.period, at);
        // "Each person" has no single figure: its use is per person.
        const each = limit.scope === 'user' && limit.userId === null;
        const counter = each
          ? undefined
          : counters.find(
              (c) =>
                c.period === limit.period &&
                c.period_start === isoDay(window.start) &&
                c.key === counterKey(limit, limit.userId),
            );
        const used = each
          ? null
          : Number(limit.metric === 'cost' ? (counter?.cost_nanos ?? 0) : (counter?.tokens ?? 0));
        return {
          ...limitView(limit),
          user:
            limit.userId === null
              ? null
              : { id: limit.userId, name: names.get(limit.userId) ?? '' },
          used: used === null ? null : limit.metric === 'cost' ? used / 1e9 : used,
          resetsAt: window.end.toISOString(),
        };
      }),
      alerts: alerts.map((a) => ({
        limitId: a.limit_id,
        periodStart: a.period_start,
        userId: a.user_id === 0 ? null : a.user_id,
        percent: a.percent,
        at: a.raised_at.toISOString(),
      })),
    };
  });

  app.post('/api/v1/admin/ai/limits', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = limitBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const problem = limitProblem(b);
    if (problem) return reply.code(400).send({ error: 'invalid_request', reason: problem });
    const amount = storedAmount(b.metric, b.amount);
    if (amount < 1) return reply.code(400).send({ error: 'invalid_request', reason: 'amount' });
    const created = await db.transaction().execute(async (trx) => {
      if (b.userId) {
        const user = await trx
          .selectFrom('app_user')
          .select('id')
          .where('id', '=', b.userId)
          .executeTakeFirst();
        if (!user) return null;
      }
      const row = await trx
        .insertInto('ai_spend_limit')
        .values({
          workspace_id: request.workspaceId,
          scope: b.scope,
          feature: b.feature ?? null,
          user_id: b.userId ?? null,
          period: b.period,
          metric: b.metric,
          amount,
          ...(b.alertPercents ? { alert_percents: [...new Set(b.alertPercents)].sort() } : {}),
          created_by: admin.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'ai_limit.created',
          subjectId: row.id,
          payload: {
            scope: row.scope,
            feature: row.feature,
            userId: row.user_id,
            period: row.period,
            metric: row.metric,
            amount: Number(row.amount),
            alertPercents: row.alert_percents,
          },
        },
      );
      return row.id;
    });
    if (created === null) return reply.code(400).send({ error: 'invalid_request', reason: 'user' });
    ai.settings.changed(request.workspaceId);
    const limit = (await readLimits(db, request.workspaceId)).find((l) => l.id === created);
    return reply.code(201).send({ limit: limit ? limitView(limit) : null });
  });

  app.patch('/api/v1/admin/ai/limits/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const p = z.object({ id }).safeParse(request.params);
    const parsed = limitPatch.safeParse(request.body);
    if (!p.success || !parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const result = await db.transaction().execute(async (trx) => {
      const before = (await readLimits(trx, request.workspaceId)).find((l) => l.id === p.data.id);
      if (!before) return 'not_found' as const;
      const view = limitView(before);
      const asked = Object.fromEntries(
        Object.entries(parsed.data).filter(([, v]) => v !== undefined),
      ) as Partial<typeof view>;
      const next = { ...view, ...asked };
      const problem = limitProblem(next);
      if (problem) return problem;
      const amount = storedAmount(next.metric, next.amount);
      if (amount < 1) return 'amount';
      await trx
        .updateTable('ai_spend_limit')
        .set({
          scope: next.scope,
          feature: next.feature ?? null,
          user_id: next.userId ?? null,
          period: next.period,
          metric: next.metric,
          amount,
          alert_percents: [...new Set(next.alertPercents)].sort(),
          updated_at: new Date(),
        })
        .where('id', '=', before.id)
        .execute();
      const changes = diff(view, {
        ...next,
        alertPercents: [...new Set(next.alertPercents)].sort(),
      });
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        { type: 'ai_limit.updated', subjectId: before.id, payload: { changes } },
      );
      return null;
    });
    if (result === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (result) return reply.code(400).send({ error: 'invalid_request', reason: result });
    ai.settings.changed(request.workspaceId);
    const limit = (await readLimits(db, request.workspaceId)).find((l) => l.id === p.data.id);
    return { limit: limit ? limitView(limit) : null };
  });

  app.delete('/api/v1/admin/ai/limits/:id', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const p = z.object({ id }).safeParse(request.params);
    if (!p.success) return reply.code(400).send({ error: 'invalid_request' });
    const gone = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('ai_spend_limit')
        .where('id', '=', p.data.id)
        .where('workspace_id', '=', request.workspaceId)
        .returningAll()
        .executeTakeFirst();
      if (!row) return false;
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'ai_limit.deleted',
          subjectId: row.id,
          payload: {
            scope: row.scope,
            feature: row.feature,
            userId: row.user_id,
            period: row.period,
            metric: row.metric,
          },
        },
      );
      return true;
    });
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    ai.settings.changed(request.workspaceId);
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/ai/prices', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { prices: (await readPrices(db, request.workspaceId)).map(priceView) };
  });

  app.put('/api/v1/admin/ai/prices', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = priceBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const row = {
      input_nanos: nanosOf(b.input),
      output_nanos: nanosOf(b.output),
      cache_read_nanos: nanosOf(b.cacheRead),
      cache_write_nanos: nanosOf(b.cacheWrite),
      long_above_tokens: b.longContext?.aboveTokens ?? null,
      long_input_nanos: b.longContext ? nanosOf(b.longContext.input) : null,
      long_output_nanos: b.longContext ? nanosOf(b.longContext.output) : null,
      updated_by: admin.id,
      updated_at: new Date(),
    };
    const saved = await db.transaction().execute(async (trx) => {
      const before = (await readPrices(trx, request.workspaceId)).find(
        (p) => p.provider === b.provider && p.model === b.model,
      );
      await trx
        .insertInto('ai_price')
        .values({ workspace_id: request.workspaceId, provider: b.provider, model: b.model, ...row })
        .onConflict((oc) => oc.columns(['workspace_id', 'provider', 'model']).doUpdateSet(row))
        .execute();
      const after = (await readPrices(trx, request.workspaceId)).find(
        (p) => p.provider === b.provider && p.model === b.model,
      ) as PriceRow;
      const { source: _s, verify: _v, ...shownAfter } = priceView(after);
      const shownBefore = before
        ? (({ source: _a, verify: _b, ...rest }) => rest)(priceView(before))
        : {};
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'ai_price.updated',
          subjectId: request.workspaceId,
          payload: {
            provider: b.provider,
            model: b.model,
            changes: diff(shownBefore as Record<string, unknown>, shownAfter),
          },
        },
      );
      return after;
    });
    ai.settings.changed(request.workspaceId);
    return { price: priceView(saved) };
  });

  app.delete('/api/v1/admin/ai/prices', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = priceKey.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { provider, model } = parsed.data;
    const gone = await db.transaction().execute(async (trx) => {
      const row = await trx
        .deleteFrom('ai_price')
        .where('workspace_id', '=', request.workspaceId)
        .where('provider', '=', provider)
        .where('model', '=', model)
        .returning('model')
        .executeTakeFirst();
      if (!row) return false;
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        { type: 'ai_price.reset', subjectId: request.workspaceId, payload: { provider, model } },
      );
      return true;
    });
    if (!gone) return reply.code(404).send({ error: 'not_found' });
    ai.settings.changed(request.workspaceId);
    return reply.code(204).send();
  });

  app.get('/api/v1/admin/ai/policy', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    const { updatedAt: _u, ...policy } = await readPolicy(db, request.workspaceId);
    return { policy };
  });

  app.put('/api/v1/admin/ai/policy', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = policyBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const b = parsed.data;
    const policy = await db.transaction().execute(async (trx) => {
      const before = await readPolicy(trx, request.workspaceId);
      const next = {
        contentDays: b.contentDays ?? before.contentDays,
        patterns: b.patterns
          ? REDACTION_PATTERNS.filter((x) => b.patterns?.includes(x))
          : before.patterns,
        terms: b.terms ? [...new Set(b.terms)] : before.terms,
        redactedFields: b.redactedFields
          ? [...new Set(b.redactedFields)].sort()
          : before.redactedFields,
      };
      const row = {
        content_days: next.contentDays,
        redact_patterns: next.patterns,
        redact_terms: next.terms,
        redacted_fields: next.redactedFields,
        updated_by: admin.id,
        updated_at: new Date(),
      };
      await trx
        .insertInto('ai_policy')
        .values({ workspace_id: request.workspaceId, ...row })
        .onConflict((oc) => oc.column('workspace_id').doUpdateSet(row))
        .execute();
      // The terms themselves stay out of the audit log: they name what is to be kept quiet.
      const shown = (p: typeof next) => ({ ...p, terms: p.terms.length });
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: admin.id },
        {
          type: 'ai_policy.updated',
          subjectId: request.workspaceId,
          payload: { changes: diff(shown(before), shown(next)) },
        },
      );
      return next;
    });
    ai.settings.changed(request.workspaceId);
    return { policy };
  });

  const statementFor = async (workspaceId: number) => {
    const [configured, policy] = await Promise.all([
      ai.configured(workspaceId),
      readPolicy(db, workspaceId),
    ]);
    return dataStatement(
      configured
        ? {
            id: configured.adapter.provider,
            region: configured.region ?? null,
            ...(configured.features ? { features: configured.features } : {}),
          }
        : null,
      policy,
    );
  };

  app.get('/api/v1/admin/ai/statement', async (request, reply) => {
    if (!(await requireSiteAdmin(request, reply))) return reply;
    return { statement: await statementFor(request.workspaceId) };
  });

  // The notice a person reads before their first AI use (M1-077; IAM-022).
  app.get('/api/v1/ai/notice', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const ack = await db
      .selectFrom('ai_notice_ack')
      .select('acknowledged_at')
      .where('workspace_id', '=', request.workspaceId)
      .where('user_id', '=', user.id)
      .executeTakeFirst();
    const { redaction: _r, ...statement } = await statementFor(request.workspaceId);
    return {
      acknowledgedAt: ack?.acknowledged_at.toISOString() ?? null,
      statement,
    };
  });

  app.post('/api/v1/ai/notice', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const at = await db.transaction().execute(async (trx) => {
      const row = await trx
        .insertInto('ai_notice_ack')
        .values({ workspace_id: request.workspaceId, user_id: user.id })
        .onConflict((oc) => oc.columns(['workspace_id', 'user_id']).doNothing())
        .returning('acknowledged_at')
        .executeTakeFirst();
      if (!row) return null;
      await emit(
        trx,
        { workspaceId: request.workspaceId, actorId: user.id },
        { type: 'ai_notice.acknowledged', subjectId: user.id, payload: {} },
      );
      return row.acknowledged_at;
    });
    if (at === null) return reply.code(200).send({ acknowledged: true, already: true });
    return { acknowledged: true, already: false };
  });
}
