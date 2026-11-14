import {
  type AdapterFactoryOptions,
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
  createProviderAdapter,
  type FeatureId,
  InMemorySecretStore,
  type ProviderAdapter,
  type ProviderConfig,
  type ProviderId,
  type SecretStore,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { KeyRing } from '@taskmoor/iam';
import type { Kysely } from 'kysely';
import { openCredentials } from './credentials';
import {
  type CredentialSlot,
  DEFAULT_AI_SETTINGS,
  FEATURE_IDS,
  readAiSettings,
  type StoredAiSettings,
  scopeBlock,
  withCredentialRefs,
} from './settings';
import { AiSettingsCache, DbMeter } from './usage';

/** Builds a provider client; the server uses the gateway's own, tests pass fakes. */
export type AdapterFactory = (
  config: ProviderConfig,
  secrets: SecretStore,
  options: AdapterFactoryOptions,
) => Promise<ProviderAdapter>;

/**
 * Why AI does not run here: switched off for the workspace (`disabled`), for the track
 * (`track_off`) or by strict mode (`strict`, the track not opted in), the feature switched off
 * (`feature_off`) or beyond the provider (`unsupported`), or the provider not set up, its settings
 * incomplete, or its keys unreadable with this server's master key.
 */
export type AiUnavailableReason =
  | 'disabled'
  | 'track_off'
  | 'strict'
  | 'feature_off'
  | 'unsupported'
  | 'not_configured'
  | 'invalid'
  | 'key_unreadable';

/** The feature as the person may use it here, for showing or hiding its controls (M1-076). */
export type AiFeatureState =
  | { available: true }
  | { available: false; reason: AiUnavailableReason };

const BLOCK_MESSAGE: Record<string, string> = {
  disabled: 'AI is switched off on this site',
  track_off: 'AI is switched off for this track',
  strict: 'Strict mode: AI runs only in tracks an administrator opted in',
  feature_off: 'This AI feature is switched off',
  unsupported: 'The AI provider cannot serve this feature',
};

/** AI cannot run for the workspace: not set up, switched off, or its settings do not work. */
export class AiUnavailableError extends AiError {
  constructor(
    readonly reason: AiUnavailableReason,
    message: string = BLOCK_MESSAGE[reason] ?? 'AI is not available',
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
}

/**
 * A provider supplied from elsewhere than the stored settings: tests, or a host that builds its
 * own client. The adapter, its per-feature settings, and where inference runs when the platform
 * says (a Bedrock or Vertex AI region, a Foundry resource).
 */
export interface AiConfigured {
  adapter: ProviderAdapter;
  features?: AiSettings['features'];
  region?: string | null;
}

/** Where such a provider comes from; null when there is none for the workspace. */
export type AiProviderSource = (workspaceId: number) => Promise<AiConfigured | null>;

/** The provider a workspace uses, as the data statement names it (M1-077). */
export interface AiProviderSummary {
  id: ProviderId;
  region: string | null;
  features: AiSettings['features'];
}

interface Runtime {
  workspaceId: number;
  version: number;
  gateway: AiGateway | undefined;
  failure: AiUnavailableError | undefined;
  inFlight: number;
  retired: boolean;
  drained: Promise<void>;
  markDrained: () => void;
}

export interface AiServiceOptions {
  ring: KeyRing;
  adapterFactory?: AdapterFactory;
  adapterOptions?: AdapterFactoryOptions;
  logger?: AiLogger;
  gateway?: Omit<AiGatewayOptions, 'features' | 'logger' | 'meter' | 'redaction' | 'now'>;
  /** A provider that wins over the stored settings when it answers (tests; M1-077). */
  source?: AiProviderSource;
  now?: () => number;
}

/**
 * The server's way into AI (M1-075; IAM-020 (2); ADR-098). Each workspace has one provider
 * client per settings version. A call reads the version (one indexed row); when a key or a
 * setting changed, the next call builds a new client from the sealed credentials, and calls
 * already running keep the client they started with until they finish. Nothing here holds a
 * credential after the client is built, and nothing logs one.
 *
 * Every gateway it builds for a workspace has that workspace's spend limits, redaction rules and
 * AI audit log wired in (M1-077; ADR-100): feature code tags each call with the person it acts
 * for (`tag.userId`), so their limits apply and the audit row names them.
 */
export class AiService {
  /** Limits, prices and data policy, cached per workspace (M1-077). */
  readonly settings: AiSettingsCache;
  private readonly current = new Map<number, { version: number; runtime: Promise<Runtime> }>();
  /** Runtimes replaced by a newer version with calls still in flight. */
  private readonly retired = new Set<Runtime>();
  /** Gateways for a supplied provider, one per adapter so its circuit breaker spans calls. */
  private readonly supplied = new WeakMap<ProviderAdapter, { key: string; gateway: AiGateway }>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: AiServiceOptions,
  ) {
    this.settings = new AiSettingsCache(db, options.now);
  }

  get ring(): KeyRing {
    return this.options.ring;
  }

  /**
   * Runs `fn` with the workspace's gateway as of now. The gateway stays the same for the whole
   * of `fn`, retries included, even if the key is replaced meanwhile.
   */
  async use<T>(
    workspaceId: number,
    fn: (gateway: AiGateway, settings: StoredAiSettings) => Promise<T>,
  ): Promise<T> {
    const supplied = await this.suppliedFor(workspaceId);
    if (supplied) return fn(supplied.gateway, supplied.settings);
    const head = await readAiSettings(this.db, workspaceId);
    if (!head.settings.enabled) {
      throw new AiUnavailableError('disabled', 'AI is switched off on this site');
    }
    const runtime = await this.runtimeFor(workspaceId, head.version, head.settings);
    if (!runtime.gateway) throw runtime.failure;
    runtime.inFlight += 1;
    try {
      return await fn(runtime.gateway, head.settings);
    } finally {
      runtime.inFlight -= 1;
      if (runtime.retired && runtime.inFlight === 0) this.drain(runtime);
    }
  }

  /**
   * The one way product code calls AI (M1-076; AI-001, IAM-019): refused before anything is
   * sent when AI is off for the workspace or the track, strict mode keeps the track out, or the
   * feature is off or beyond the provider. Then `fn` runs as in `use`.
   */
  async call<T>(
    scope: { workspaceId: number; trackId?: number | null; feature: FeatureId },
    fn: (gateway: AiGateway, settings: StoredAiSettings) => Promise<T>,
  ): Promise<T> {
    return this.use(scope.workspaceId, async (gateway, settings) => {
      const block = scopeBlock(settings, scope.trackId);
      if (block) throw new AiUnavailableError(block);
      const availability = gateway.availability(scope.feature);
      if (!availability.available) {
        throw new AiUnavailableError(
          availability.reason === 'disabled' ? 'feature_off' : 'unsupported',
        );
      }
      return fn(gateway, settings);
    });
  }

  /** Every feature's state for a workspace and track, without calling the provider. */
  async features(
    workspaceId: number,
    trackId?: number | null,
  ): Promise<Record<FeatureId, AiFeatureState>> {
    const supplied = await this.suppliedFor(workspaceId);
    const head = supplied
      ? { settings: supplied.settings, version: 0 }
      : await readAiSettings(this.db, workspaceId);
    const all = (state: AiFeatureState) =>
      Object.fromEntries(FEATURE_IDS.map((f) => [f, state])) as Record<FeatureId, AiFeatureState>;
    const block = scopeBlock(head.settings, trackId);
    if (block) return all({ available: false, reason: block });
    const runtime = supplied
      ? undefined
      : await this.runtimeFor(workspaceId, head.version, head.settings);
    const gateway = supplied ? supplied.gateway : runtime?.gateway;
    if (!gateway) return all({ available: false, reason: runtime?.failure?.reason ?? 'invalid' });
    return Object.fromEntries(
      FEATURE_IDS.map((f) => {
        const a = gateway.availability(f);
        const state: AiFeatureState = a.available
          ? { available: true }
          : { available: false, reason: a.reason === 'disabled' ? 'feature_off' : 'unsupported' };
        return [f, state];
      }),
    ) as Record<FeatureId, AiFeatureState>;
  }

  /**
   * A gateway for settings that are not saved yet ("test connection"); nothing is cached, and
   * it is not metered: listing models or counting tokens costs nothing.
   */
  async probe(
    settings: StoredAiSettings,
    credentials: Map<CredentialSlot, string>,
  ): Promise<AiGateway> {
    return this.build(settings, credentials);
  }

  /**
   * The workspace's gateway as of now, or null when AI is not set up or switched off there
   * (NFR-011: AI stays hidden). Feature code uses `call` or `use`, which keep the gateway for the
   * whole call; this is for code that only asks.
   */
  async gateway(workspaceId: number): Promise<AiGateway | null> {
    const supplied = await this.suppliedFor(workspaceId);
    if (supplied) return supplied.gateway;
    const head = await readAiSettings(this.db, workspaceId);
    if (!head.settings.enabled) return null;
    return (await this.runtimeFor(workspaceId, head.version, head.settings)).gateway ?? null;
  }

  /** The provider the workspace uses and where it runs, for the data statement (M1-077). */
  async summary(workspaceId: number): Promise<AiProviderSummary | null> {
    const configured = await this.options.source?.(workspaceId);
    if (configured) {
      return {
        id: configured.adapter.provider,
        region: configured.region ?? null,
        features: configured.features ?? {},
      };
    }
    const { settings } = await readAiSettings(this.db, workspaceId);
    if (!settings.enabled || !settings.provider) return null;
    const p = settings.provider as Record<string, unknown>;
    const where = p.region ?? p.location ?? p.resource;
    return {
      id: settings.provider.provider,
      region: typeof where === 'string' ? where : null,
      features: settings.features as AiSettings['features'],
    };
  }

  /**
   * Resolves once no call uses a client older than the given version: it builds the current
   * client first (so no new call can take an older one), then waits for the calls in flight.
   */
  async drained(workspaceId: number, olderThan: number): Promise<void> {
    const head = await readAiSettings(this.db, workspaceId);
    await this.runtimeFor(workspaceId, head.version, head.settings);
    // The replaced client is retired in a callback of its own promise: let it run.
    await new Promise((resolve) => setImmediate(resolve));
    const waits = [...this.retired]
      .filter((r) => r.workspaceId === workspaceId && r.version < olderThan)
      .map((r) => r.drained);
    await Promise.all(waits);
  }

  /** Calls in flight on clients a newer version replaced, per workspace (for tests). */
  inFlightOnRetired(workspaceId: number): number {
    let n = 0;
    for (const r of this.retired) if (r.workspaceId === workspaceId) n += r.inFlight;
    return n;
  }

  private drain(runtime: Runtime): void {
    this.retired.delete(runtime);
    runtime.markDrained();
  }

  private runtimeFor(
    workspaceId: number,
    version: number,
    settings: StoredAiSettings,
  ): Promise<Runtime> {
    const entry = this.current.get(workspaceId);
    // Calls for the same version share one build; a call that read an older version than the
    // one built already uses the newer client.
    if (entry && entry.version >= version) return entry.runtime;
    const runtime = this.newRuntime(workspaceId, version, settings);
    this.current.set(workspaceId, { version, runtime });
    if (entry) void entry.runtime.then((old) => this.retire(old));
    return runtime;
  }

  private retire(runtime: Runtime): void {
    runtime.retired = true;
    this.retired.add(runtime);
    // After the calls that already hold it have counted themselves in.
    setImmediate(() => {
      if (runtime.inFlight === 0) this.drain(runtime);
    });
  }

  private async newRuntime(
    workspaceId: number,
    version: number,
    settings: StoredAiSettings,
  ): Promise<Runtime> {
    let markDrained = () => {};
    const drained = new Promise<void>((resolve) => {
      markDrained = resolve;
    });
    const runtime: Runtime = {
      workspaceId,
      version,
      gateway: undefined,
      failure: undefined,
      inFlight: 0,
      retired: false,
      drained,
      markDrained,
    };
    try {
      const credentials = await openCredentials(this.db, this.options.ring, workspaceId).catch(
        () => {
          throw new AiUnavailableError(
            'key_unreadable',
            'The stored AI credentials do not open with the configured master key',
          );
        },
      );
      runtime.gateway = await this.build(settings, credentials, workspaceId);
    } catch (error) {
      runtime.failure =
        error instanceof AiUnavailableError
          ? error
          : new AiUnavailableError('invalid', 'The AI provider client could not be built');
    }
    return runtime;
  }

  private async build(
    settings: StoredAiSettings,
    credentials: Map<CredentialSlot, string>,
    workspaceId?: number,
  ): Promise<AiGateway> {
    if (!settings.provider) {
      throw new AiUnavailableError('not_configured', 'No AI provider is set up');
    }
    const resolved = withCredentialRefs(settings.provider, credentials.keys());
    if (!resolved.ok) {
      throw new AiUnavailableError(
        'invalid',
        `The AI provider settings are incomplete: ${resolved.problems.join('; ')}`,
      );
    }
    const factory = this.options.adapterFactory ?? createProviderAdapter;
    const adapter = await factory(
      resolved.config,
      new InMemorySecretStore(Object.fromEntries(credentials)),
      this.options.adapterOptions ?? {},
    );
    return this.gatewayOf(adapter, settings.features as AiSettings['features'], workspaceId);
  }

  /**
   * A gateway on `adapter`. For a workspace, its spend limits, redaction and audit log are wired
   * in (M1-077); without one (test connection) nothing is metered.
   */
  private gatewayOf(
    adapter: ProviderAdapter,
    features: AiSettings['features'],
    workspaceId?: number,
  ): AiGateway {
    const now = this.options.now;
    return new AiGateway(adapter, {
      ...this.options.gateway,
      // Per-feature switch, model and effort (AI-006): a change moves the version, so the next
      // call builds a client with it.
      features,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
      ...(now ? { now } : {}),
      ...(workspaceId === undefined
        ? {}
        : {
            meter: new DbMeter(this.db, workspaceId, {
              cache: this.settings,
              ...(now ? { now } : {}),
            }),
            redaction: () => this.settings.redactionOf(workspaceId),
          }),
    });
  }

  /** The supplied provider's gateway and settings, when a source answers for the workspace. */
  private async suppliedFor(
    workspaceId: number,
  ): Promise<{ gateway: AiGateway; settings: StoredAiSettings } | null> {
    const configured = await this.options.source?.(workspaceId);
    if (!configured) return null;
    const features = configured.features ?? {};
    const key = `${workspaceId}|${JSON.stringify(features)}`;
    let hit = this.supplied.get(configured.adapter);
    if (!hit || hit.key !== key) {
      hit = { key, gateway: this.gatewayOf(configured.adapter, features, workspaceId) };
      this.supplied.set(configured.adapter, hit);
    }
    return {
      gateway: hit.gateway,
      settings: { ...DEFAULT_AI_SETTINGS, enabled: true, features } as StoredAiSettings,
    };
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
  if (error instanceof AiUnavailableError) {
    return { status: 403, body: { error: 'ai_unavailable', reason: error.reason } };
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
