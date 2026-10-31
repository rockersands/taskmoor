import {
  type AiMeter,
  AiSpendLimitError,
  type CallOutcome,
  callCost,
  DEFAULT_REDACTION_PATTERNS,
  LIST_PRICES,
  limitApplies,
  type MeteredCall,
  type ModelPrice,
  periodWindow,
  priceModelId,
  type RedactionPattern,
  type RedactionRules,
  reachedLimit,
  SPEND_PERIODS,
  type SpendLimit,
  type SpendPeriod,
  totalTokens,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { emit } from '../events/bus';

/**
 * AI spend limits, cost and the AI audit log on the database (M1-077; OPS-020, IAM-021;
 * ADR-100). `DbMeter` is the gateway's meter: before a call it reads the usage counters of the
 * limits that apply (by primary key) and refuses at a limit; after the call it writes the audit
 * row, the day's sums and the counters in one transaction, so the dashboard's totals always
 * match the log, and raises each limit's alert thresholds once per period.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface AiPolicy {
  contentDays: number;
  patterns: RedactionPattern[];
  terms: string[];
  /** `description`, `environment`, `summary` or `cf[<id>]`. */
  redactedFields: string[];
  updatedAt: Date | null;
}

export const DEFAULT_POLICY: AiPolicy = {
  contentDays: 0,
  patterns: [...DEFAULT_REDACTION_PATTERNS],
  terms: [],
  redactedFields: [],
  updatedAt: null,
};

export async function readPolicy(db: Db, workspaceId: number): Promise<AiPolicy> {
  const row = await db
    .selectFrom('ai_policy')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirst();
  if (!row) return { ...DEFAULT_POLICY, patterns: [...DEFAULT_POLICY.patterns] };
  return {
    contentDays: row.content_days,
    patterns: row.redact_patterns as RedactionPattern[],
    terms: row.redact_terms,
    redactedFields: row.redacted_fields,
    updatedAt: row.updated_at,
  };
}

export interface PriceRow {
  provider: string;
  model: string;
  price: ModelPrice;
  /** `list`: a default to verify; `admin`: an administrator's rate. */
  source: 'list' | 'admin';
}

/** The workspace's price table: administrators' rates over the list prices. */
export async function readPrices(db: Db, workspaceId: number): Promise<PriceRow[]> {
  const rows = await db
    .selectFrom('ai_price')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .execute();
  const out = new Map<string, PriceRow>();
  for (const entry of LIST_PRICES) {
    out.set(`${entry.provider}|${entry.model}`, { ...entry, source: 'list' });
  }
  for (const row of rows) {
    out.set(`${row.provider}|${row.model}`, {
      provider: row.provider,
      model: row.model,
      source: 'admin',
      price: {
        inputNanos: Number(row.input_nanos),
        outputNanos: Number(row.output_nanos),
        cacheReadNanos: Number(row.cache_read_nanos),
        cacheWriteNanos: Number(row.cache_write_nanos),
        ...(row.long_above_tokens !== null
          ? {
              longContext: {
                aboveTokens: row.long_above_tokens,
                inputNanos: Number(row.long_input_nanos),
                outputNanos: Number(row.long_output_nanos),
              },
            }
          : {}),
      },
    });
  }
  return [...out.values()].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
}

export interface StoredLimit extends SpendLimit {
  id: number;
  alertPercents: number[];
  createdAt: Date;
  updatedAt: Date;
}

export async function readLimits(db: Db, workspaceId: number): Promise<StoredLimit[]> {
  const rows = await db
    .selectFrom('ai_spend_limit')
    .selectAll()
    .where('workspace_id', '=', workspaceId)
    .orderBy('id')
    .execute();
  return rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    feature: row.feature,
    userId: row.user_id,
    period: row.period,
    metric: row.metric,
    amount: Number(row.amount),
    alertPercents: row.alert_percents,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

/** The counter a limit reads: the workspace, a feature, or a person. */
export function counterKey(
  limit: Pick<SpendLimit, 'scope' | 'feature'>,
  userId: number | null,
): string {
  if (limit.scope === 'feature') return `feature:${limit.feature}`;
  if (limit.scope === 'user') return `user:${userId}`;
  return 'workspace';
}

const isoDay = (date: Date) => date.toISOString().slice(0, 10);

/** How long reads of limits, prices and the policy are trusted before reading again. */
const TTL_MS = 5_000;

interface Cached<T> {
  at: number;
  value: Promise<T>;
}

/** The workspace's settings as the meter and the redaction read them, briefly cached. */
export class AiSettingsCache {
  private readonly limits = new Map<number, Cached<StoredLimit[]>>();
  private readonly prices = new Map<number, Cached<PriceRow[]>>();
  private readonly policies = new Map<number, Cached<AiPolicy>>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly now: () => number = Date.now,
  ) {}

  private read<T>(map: Map<number, Cached<T>>, workspaceId: number, load: () => Promise<T>) {
    const hit = map.get(workspaceId);
    if (hit && this.now() - hit.at < TTL_MS) return hit.value;
    const value = load();
    map.set(workspaceId, { at: this.now(), value });
    value.catch(() => map.delete(workspaceId));
    return value;
  }

  limitsOf(workspaceId: number): Promise<StoredLimit[]> {
    return this.read(this.limits, workspaceId, () => readLimits(this.db, workspaceId));
  }

  pricesOf(workspaceId: number): Promise<PriceRow[]> {
    return this.read(this.prices, workspaceId, () => readPrices(this.db, workspaceId));
  }

  policyOf(workspaceId: number): Promise<AiPolicy> {
    return this.read(this.policies, workspaceId, () => readPolicy(this.db, workspaceId));
  }

  async redactionOf(workspaceId: number): Promise<RedactionRules> {
    const policy = await this.policyOf(workspaceId);
    return { patterns: policy.patterns, terms: policy.terms };
  }

  /** After an administrator's change in this process: read again at once. */
  changed(workspaceId: number): void {
    this.limits.delete(workspaceId);
    this.prices.delete(workspaceId);
    this.policies.delete(workspaceId);
  }
}

/** The price a call is booked at: the answering model's, else the feature's model's. */
export function priceFor(
  prices: readonly PriceRow[],
  call: Pick<MeteredCall, 'provider' | 'model'>,
  servedModel: string,
): PriceRow | undefined {
  const served = priceModelId(servedModel);
  return (
    prices.find((p) => p.provider === call.provider && p.model === served) ??
    prices.find((p) => p.provider === call.provider && p.model === priceModelId(call.model))
  );
}

/** The usage counted against each limit that applies to a call, read now. */
export async function limitUsage(
  db: Db,
  workspaceId: number,
  limits: readonly StoredLimit[],
  call: { feature: string; userId: number | null },
  at: Date,
): Promise<{ limit: StoredLimit; used: number }[]> {
  const applicable = limits.filter((limit) => limitApplies(limit, call));
  if (applicable.length === 0) return [];
  const wanted = applicable.map((limit) => ({
    limit,
    period: limit.period,
    start: isoDay(periodWindow(limit.period, at).start),
    key: counterKey(limit, call.userId),
  }));
  const rows = await db
    .selectFrom('ai_spend_counter')
    .select(['period', 'period_start', 'key', 'tokens', 'cost_nanos'])
    .where('workspace_id', '=', workspaceId)
    .where((eb) =>
      eb.or(
        wanted.map((w) =>
          eb.and([
            eb('period', '=', w.period),
            eb('period_start', '=', w.start),
            eb('key', '=', w.key),
          ]),
        ),
      ),
    )
    .execute();
  return wanted.map((w) => {
    const row = rows.find(
      (r) => r.period === w.period && r.period_start === w.start && r.key === w.key,
    );
    const used = row ? Number(w.limit.metric === 'cost' ? row.cost_nanos : row.tokens) : 0;
    return { limit: w.limit, used };
  });
}

export interface DbMeterOptions {
  cache: AiSettingsCache;
  now?: () => number;
}

/** The gateway's meter for one workspace. */
export class DbMeter implements AiMeter {
  private readonly now: () => number;

  constructor(
    private readonly db: Kysely<Database>,
    private readonly workspaceId: number,
    private readonly options: DbMeterOptions,
  ) {
    this.now = options.now ?? Date.now;
  }

  async admit(call: MeteredCall): Promise<void> {
    const limits = await this.options.cache.limitsOf(this.workspaceId);
    if (limits.length === 0) return;
    const at = new Date(this.now());
    const userId = call.tag.userId ?? null;
    const used = await limitUsage(
      this.db,
      this.workspaceId,
      limits,
      { feature: call.feature, userId },
      at,
    );
    const reached = reachedLimit(used, at, userId);
    if (reached) throw new AiSpendLimitError(reached);
  }

  async record(call: MeteredCall, outcome: CallOutcome): Promise<void> {
    const at = new Date(this.now());
    const [prices, policy, limits] = await Promise.all([
      this.options.cache.pricesOf(this.workspaceId),
      this.options.cache.policyOf(this.workspaceId),
      this.options.cache.limitsOf(this.workspaceId),
    ]);
    const price = priceFor(prices, call, outcome.servedModel);
    const cost = price ? callCost(outcome.usage, price.price, { batch: call.mode === 'batch' }) : 0;
    const tokens = totalTokens(outcome.usage);
    const userId = call.tag.userId ?? null;
    const keepContent = policy.contentDays > 0 && outcome.content !== undefined;
    const u = outcome.usage;
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('ai_call')
        .values({
          workspace_id: this.workspaceId,
          occurred_at: at,
          user_id: userId,
          track_id: call.tag.trackId ?? null,
          run_id: call.tag.runId ?? null,
          feature: call.feature,
          provider: call.provider,
          model: call.model,
          served_model: outcome.servedModel,
          mode: call.mode,
          outcome: outcome.status,
          error_kind: outcome.errorKind ?? null,
          limit_id:
            outcome.limit && typeof outcome.limit.limitId === 'number'
              ? outcome.limit.limitId
              : null,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_tokens: u.cacheReadTokens,
          cache_write_tokens: u.cacheWriteTokens,
          cost_nanos: cost,
          priced: price !== undefined,
          latency_ms: Math.max(0, Math.round(outcome.latencyMs)),
          retries: outcome.retries,
          fell_back: outcome.fellBack,
          content: keepContent ? JSON.stringify(outcome.content) : null,
          content_expires_at: keepContent
            ? new Date(at.getTime() + policy.contentDays * 86_400_000)
            : null,
        })
        .execute();
      const failed = outcome.status === 'error' || outcome.status === 'aborted' ? 1 : 0;
      const limited = outcome.status === 'limited' ? 1 : 0;
      const unpriced = price === undefined && tokens > 0 ? 1 : 0;
      await trx
        .insertInto('ai_usage_day')
        .values({
          workspace_id: this.workspaceId,
          day: isoDay(at),
          feature: call.feature,
          user_id: userId ?? 0,
          provider: call.provider,
          model: call.model,
          calls: 1,
          limited,
          failed,
          unpriced,
          input_tokens: u.inputTokens,
          output_tokens: u.outputTokens,
          cache_read_tokens: u.cacheReadTokens,
          cache_write_tokens: u.cacheWriteTokens,
          cost_nanos: cost,
        })
        .onConflict((oc) =>
          oc
            .columns(['workspace_id', 'day', 'feature', 'user_id', 'provider', 'model'])
            .doUpdateSet({
              calls: sql`ai_usage_day.calls + 1`,
              limited: sql`ai_usage_day.limited + ${limited}`,
              failed: sql`ai_usage_day.failed + ${failed}`,
              unpriced: sql`ai_usage_day.unpriced + ${unpriced}`,
              input_tokens: sql`ai_usage_day.input_tokens + ${u.inputTokens}`,
              output_tokens: sql`ai_usage_day.output_tokens + ${u.outputTokens}`,
              cache_read_tokens: sql`ai_usage_day.cache_read_tokens + ${u.cacheReadTokens}`,
              cache_write_tokens: sql`ai_usage_day.cache_write_tokens + ${u.cacheWriteTokens}`,
              cost_nanos: sql`ai_usage_day.cost_nanos + ${cost}`,
            }),
        )
        .execute();
      if (tokens === 0 && cost === 0) return;
      const keys = ['workspace', `feature:${call.feature}`];
      if (userId !== null) keys.push(`user:${userId}`);
      const counters = SPEND_PERIODS.flatMap((period) =>
        keys.map((key) => ({
          workspace_id: this.workspaceId,
          period,
          period_start: isoDay(periodWindow(period, at).start),
          key,
          tokens,
          cost_nanos: cost,
        })),
      );
      const totals = await trx
        .insertInto('ai_spend_counter')
        .values(counters)
        .onConflict((oc) =>
          oc.columns(['workspace_id', 'period', 'period_start', 'key']).doUpdateSet({
            tokens: sql`ai_spend_counter.tokens + excluded.tokens`,
            cost_nanos: sql`ai_spend_counter.cost_nanos + excluded.cost_nanos`,
          }),
        )
        .returning(['period', 'period_start', 'key', 'tokens', 'cost_nanos'])
        .execute();
      await this.alerts(trx, limits, call.feature, userId, totals);
    });
  }

  /** Raises each threshold a limit's usage crossed, once per period and person (OPS-020 (2)). */
  private async alerts(
    trx: Transaction<Database>,
    limits: readonly StoredLimit[],
    feature: string,
    userId: number | null,
    totals: readonly {
      period: SpendPeriod;
      period_start: string;
      key: string;
      tokens: string;
      cost_nanos: string;
    }[],
  ): Promise<void> {
    for (const limit of limits) {
      if (!limitApplies(limit, { feature, userId })) continue;
      const key = counterKey(limit, userId);
      const total = totals.find((t) => t.period === limit.period && t.key === key);
      if (!total) continue;
      const used = Number(limit.metric === 'cost' ? total.cost_nanos : total.tokens);
      for (const percent of [...limit.alertPercents].sort((a, b) => a - b)) {
        if (used * 100 < limit.amount * percent) break;
        const raised = await trx
          .insertInto('ai_limit_alert')
          .values({
            workspace_id: this.workspaceId,
            limit_id: limit.id,
            period_start: total.period_start,
            user_id: limit.scope === 'user' ? (userId ?? 0) : 0,
            percent,
            used,
          })
          .onConflict((oc) => oc.doNothing())
          .returning('limit_id')
          .executeTakeFirst();
        if (!raised) continue;
        await emit(
          trx,
          { workspaceId: this.workspaceId, actorId: null, ip: null },
          {
            type: 'ai_limit.threshold_reached',
            subjectId: limit.id,
            payload: {
              scope: limit.scope,
              feature: limit.feature,
              userId: limit.scope === 'user' ? userId : null,
              period: limit.period,
              periodStart: total.period_start,
              metric: limit.metric,
              amount: limit.amount,
              used,
              percent,
            },
          },
        );
      }
    }
  }
}

/** Drops stored prompt and answer content past its days, and counters of past periods. */
export async function purgeAiContent(db: Kysely<Database>, now: Date = new Date()) {
  const cleared = await db
    .updateTable('ai_call')
    .set({ content: null, content_expires_at: null })
    .where('content_expires_at', '<=', now)
    .executeTakeFirst();
  // The longest period is a month: anything that started more than 62 days ago is spent.
  await db
    .deleteFrom('ai_spend_counter')
    .where('period_start', '<', isoDay(new Date(now.getTime() - 62 * 86_400_000)))
    .execute();
  return Number(cleared.numUpdatedRows);
}
