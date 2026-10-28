import { AiAbortedError } from './errors';

export interface RetryOptions {
  /** Retries after the first attempt. */
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /** A Retry-After longer than this is not waited for; the call fails instead. */
  maxRetryAfterMs: number;
  random: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 60_000,
  random: Math.random,
  sleep: abortableSleep,
};

/**
 * How long to wait before retry number `attempt` (0-based). The provider's Retry-After wins
 * when present; otherwise exponential backoff with jitter (half fixed, half random), so a
 * burst of clients does not retry in lockstep. `undefined` means do not retry.
 */
export function retryDelay(
  attempt: number,
  retryAfterMs: number | undefined,
  options: Pick<RetryOptions, 'baseDelayMs' | 'maxDelayMs' | 'maxRetryAfterMs' | 'random'>,
): number | undefined {
  if (retryAfterMs !== undefined) {
    return retryAfterMs > options.maxRetryAfterMs ? undefined : Math.max(0, retryAfterMs);
  }
  const ceiling = Math.min(options.maxDelayMs, options.baseDelayMs * 2 ** attempt);
  return Math.round(ceiling / 2 + (options.random() * ceiling) / 2);
}

/** Reads `retry-after-ms` (milliseconds) or `retry-after` (seconds or an HTTP date). */
export function retryAfterFromHeaders(
  headers: Headers | undefined,
  now: number = Date.now(),
): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms !== null && ms.trim() !== '') {
    const value = Number(ms);
    if (Number.isFinite(value) && value >= 0) return value;
  }
  const after = headers.get('retry-after');
  if (after === null || after.trim() === '') return undefined;
  const seconds = Number(after);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : undefined;
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** `x-should-retry`: the provider's own verdict, which overrides the status-based guess. */
export function shouldRetryFromHeaders(headers: Headers | undefined): boolean | undefined {
  const value = headers?.get('x-should-retry');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AiAbortedError('The AI call was cancelled'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AiAbortedError('The AI call was cancelled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export interface CircuitBreakerOptions {
  /** Consecutive failed calls (after retries) that open the circuit. */
  failureThreshold: number;
  cooldownMs: number;
  now: () => number;
}

export const DEFAULT_BREAKER: CircuitBreakerOptions = {
  failureThreshold: 5,
  cooldownMs: 30_000,
  now: Date.now,
};

export type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * One per provider. Closed: calls go through. Open: calls fail at once until the cool-down
 * ends, so a provider outage does not stall the actions that use AI. Half-open: one trial
 * call decides whether to close again or wait another cool-down.
 */
export class CircuitBreaker {
  private failures = 0;
  private openedAt: number | undefined;
  private probing = false;

  constructor(private readonly options: CircuitBreakerOptions = DEFAULT_BREAKER) {}

  get state(): CircuitState {
    if (this.openedAt === undefined) return 'closed';
    return this.options.now() - this.openedAt >= this.options.cooldownMs ? 'half-open' : 'open';
  }

  /** When an open circuit lets the next trial call through. */
  get retryAt(): number | undefined {
    return this.openedAt === undefined ? undefined : this.openedAt + this.options.cooldownMs;
  }

  /** Whether a call may start now. In half-open state only one trial call is allowed. */
  tryAcquire(): boolean {
    const state = this.state;
    if (state === 'closed') return true;
    if (state === 'open' || this.probing) return false;
    this.probing = true;
    return true;
  }

  /**
   * Records how a call ended: `up` (the provider answered, even with an error about the
   * request), `down` (an outage after retries), or `unknown` (cancelled).
   */
  record(outcome: 'up' | 'down' | 'unknown'): void {
    const wasProbe = this.probing;
    this.probing = false;
    if (outcome === 'up') {
      this.failures = 0;
      this.openedAt = undefined;
      return;
    }
    if (outcome === 'unknown') return;
    this.failures += 1;
    if (wasProbe || this.failures >= this.options.failureThreshold) {
      this.openedAt = this.options.now();
    }
  }
}
