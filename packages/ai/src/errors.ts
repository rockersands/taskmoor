import type { ProviderId } from './config';
import type { FeatureId } from './features';
import type { Capability, ProviderErrorKind } from './types';

export class AiError extends Error {
  override name = 'AiError';
}

export class AiFeatureDisabledError extends AiError {
  override name = 'AiFeatureDisabledError';
  constructor(readonly feature: FeatureId) {
    super(`AI feature "${feature}" is turned off`);
  }
}

/** The configured provider or model lacks something the request needs. */
export class AiUnsupportedError extends AiError {
  override name = 'AiUnsupportedError';
  constructor(
    readonly provider: ProviderId,
    readonly capability: Capability,
  ) {
    super(`${provider} does not support ${capability} for this model`);
  }
}

/** The answer could not be used: not JSON, not matching the schema, or cut off. */
export class AiOutputError extends AiError {
  override name = 'AiOutputError';
}

/** A request was built that breaks the request rules of ADR-028; nothing was sent. */
export class AiPolicyError extends AiError {
  override name = 'AiPolicyError';
}

export class AiAbortedError extends AiError {
  override name = 'AiAbortedError';
}

/** Recent calls failed with outages; calls fail fast until the cool-down ends. */
export class AiCircuitOpenError extends AiError {
  override name = 'AiCircuitOpenError';
  constructor(
    readonly provider: ProviderId,
    readonly retryAt: number,
  ) {
    super(`${provider} is failing; AI calls are paused until ${new Date(retryAt).toISOString()}`);
  }
}

/** The usual meaning of an HTTP error status, shared by the adapters. */
export function kindForHttpStatus(status: number): ProviderErrorKind {
  if (status === 429) return 'rate_limited';
  if (status === 529) return 'overloaded';
  if (status === 408) return 'timeout';
  if (status === 409 || status >= 500) return 'server';
  if (status === 401) return 'authentication';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 413) return 'request_too_large';
  if (status >= 400) return 'invalid_request';
  return 'unknown';
}

const RETRYABLE: ReadonlySet<ProviderErrorKind> = new Set([
  'rate_limited',
  'overloaded',
  'server',
  'timeout',
  'connection',
]);

/** Kinds that mean the provider is unwell rather than the request being wrong. */
const OUTAGE: ReadonlySet<ProviderErrorKind> = new Set([
  'overloaded',
  'server',
  'timeout',
  'connection',
]);

/** A failed provider call, typed by kind; the message never contains a credential. */
export class AiProviderError extends AiError {
  override name = 'AiProviderError';
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;
  readonly retryable: boolean;

  constructor(
    message: string,
    readonly provider: ProviderId,
    readonly kind: ProviderErrorKind,
    options: {
      status?: number;
      retryAfterMs?: number;
      shouldRetry?: boolean;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.shouldRetry ?? RETRYABLE.has(kind);
  }

  get outage(): boolean {
    return OUTAGE.has(this.kind);
  }
}
