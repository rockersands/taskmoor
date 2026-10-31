import {
  AiCircuitOpenError,
  AiError,
  AiFeatureDisabledError,
  AiGateway,
  type AiGatewayOptions,
  type AiLogger,
  AiOutputError,
  AiProviderError,
  type AiSettings,
  AiSpendLimitError,
  AiUnsupportedError,
  type ProviderAdapter,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { AiSettingsCache, DbMeter } from './usage';

/**
 * The AI provider a workspace uses, as key storage and the AI settings (M1-075, M1-076)
 * produce it: the adapter, the per-feature settings, and where inference runs when the
 * platform says (a Bedrock or Vertex AI region, a Foundry resource).
 */
export interface AiConfigured {
  adapter: ProviderAdapter;
  features?: AiSettings['features'];
  region?: string | null;
}

/** Where the service finds a workspace's provider; null when AI is not set up there. */
export type AiProviderSource = (workspaceId: number) => Promise<AiConfigured | null>;

export const NO_AI: AiProviderSource = async () => null;

export interface AiServiceOptions {
  source?: AiProviderSource;
  logger?: AiLogger;
  now?: () => number;
  /** Gateway options for tests (retries, breaker). */
  gateway?: Pick<AiGatewayOptions, 'retry' | 'breaker'>;
}

/**
 * The one way server code reaches AI (M1-077; ADR-100): a gateway for the workspace's provider
 * with its spend limits, its redaction rules and its audit log wired in. Feature code tags each
 * call with the person it acts for (`tag.userId`), so their limits apply and the audit row
 * names them. One gateway per adapter, so its circuit breaker spans calls.
 */
export class AiService {
  readonly settings: AiSettingsCache;
  private readonly source: AiProviderSource;
  private readonly gateways = new WeakMap<ProviderAdapter, { key: string; gateway: AiGateway }>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: AiServiceOptions = {},
  ) {
    this.source = options.source ?? NO_AI;
    this.settings = new AiSettingsCache(db, options.now);
  }

  /** The workspace's provider, or null when AI is not configured. */
  configured(workspaceId: number): Promise<AiConfigured | null> {
    return this.source(workspaceId);
  }

  /** The workspace's gateway, or null when AI is not configured (NFR-011: AI stays hidden). */
  async gateway(workspaceId: number): Promise<AiGateway | null> {
    const configured = await this.source(workspaceId);
    if (!configured) return null;
    const key = `${workspaceId}|${JSON.stringify(configured.features ?? {})}`;
    const hit = this.gateways.get(configured.adapter);
    if (hit && hit.key === key) return hit.gateway;
    const gateway = new AiGateway(configured.adapter, {
      ...(configured.features ? { features: configured.features } : {}),
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...this.options.gateway,
      meter: new DbMeter(this.db, workspaceId, {
        cache: this.settings,
        ...(this.options.now ? { now: this.options.now } : {}),
      }),
      redaction: () => this.settings.redactionOf(workspaceId),
    });
    this.gateways.set(configured.adapter, { key, gateway });
    return gateway;
  }
}

/** How an AI failure is answered, so the feature can say why (OPS-020 (1), AI-009). */
export function aiErrorBody(error: unknown): { status: number; body: Record<string, unknown> } {
  if (error instanceof AiSpendLimitError) {
    const { scope, feature, period, metric, resetsAt } = error.limit;
    return {
      status: 429,
      body: { error: 'ai_limit_reached', limit: { scope, feature, period, metric, resetsAt } },
    };
  }
  if (error instanceof AiFeatureDisabledError) {
    return { status: 403, body: { error: 'ai_disabled', feature: error.feature } };
  }
  if (error instanceof AiUnsupportedError) {
    return { status: 409, body: { error: 'ai_unsupported', capability: error.capability } };
  }
  if (error instanceof AiCircuitOpenError) {
    return {
      status: 503,
      body: { error: 'ai_unavailable', retryAt: new Date(error.retryAt).toISOString() },
    };
  }
  if (error instanceof AiProviderError) {
    return { status: 502, body: { error: 'ai_provider_error', kind: error.kind } };
  }
  if (error instanceof AiOutputError) return { status: 502, body: { error: 'ai_invalid_answer' } };
  if (error instanceof AiError) return { status: 500, body: { error: 'ai_failed' } };
  throw error;
}
