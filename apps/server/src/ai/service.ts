import {
  type AdapterFactoryOptions,
  AiError,
  AiGateway,
  type AiGatewayOptions,
  type AiLogger,
  createProviderAdapter,
  InMemorySecretStore,
  type ProviderAdapter,
  type ProviderConfig,
  type SecretStore,
} from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import type { KeyRing } from '@taskmoor/iam';
import type { Kysely } from 'kysely';
import { openCredentials } from './credentials';
import {
  type CredentialSlot,
  readAiSettings,
  type StoredAiSettings,
  withCredentialRefs,
} from './settings';

/** Builds a provider client; the server uses the gateway's own, tests pass fakes. */
export type AdapterFactory = (
  config: ProviderConfig,
  secrets: SecretStore,
  options: AdapterFactoryOptions,
) => Promise<ProviderAdapter>;

/** AI cannot run for the workspace: not set up, switched off, or its settings do not work. */
export class AiUnavailableError extends AiError {
  constructor(
    readonly reason: 'not_configured' | 'disabled' | 'invalid' | 'key_unreadable',
    message: string,
  ) {
    super(message);
    this.name = 'AiUnavailableError';
  }
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
  gateway?: Omit<AiGatewayOptions, 'features' | 'logger'>;
}

/**
 * The server's way into AI (M1-075; IAM-020 (2); ADR-098). Each workspace has one provider
 * client per settings version. A call reads the version (one indexed row); when a key or a
 * setting changed, the next call builds a new client from the sealed credentials, and calls
 * already running keep the client they started with until they finish. Nothing here holds a
 * credential after the client is built, and nothing logs one.
 */
export class AiService {
  private readonly current = new Map<number, { version: number; runtime: Promise<Runtime> }>();
  /** Runtimes replaced by a newer version with calls still in flight. */
  private readonly retired = new Set<Runtime>();

  constructor(
    private readonly db: Kysely<Database>,
    private readonly options: AiServiceOptions,
  ) {}

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
    const head = await readAiSettings(this.db, workspaceId);
    if (!head.settings.enabled) {
      throw new AiUnavailableError('disabled', 'AI is switched off for this workspace');
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

  /** A gateway for settings that are not saved yet ("test connection"); nothing is cached. */
  async probe(
    settings: StoredAiSettings,
    credentials: Map<CredentialSlot, string>,
  ): Promise<AiGateway> {
    return this.build(settings, credentials);
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
      runtime.gateway = await this.build(settings, credentials);
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
    return new AiGateway(adapter, {
      ...this.options.gateway,
      ...(this.options.logger ? { logger: this.options.logger } : {}),
    });
  }
}
