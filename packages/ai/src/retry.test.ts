import { fc } from '@taskmoor/testkit/property';
import { describe, expect, it } from 'vitest';
import { AiAbortedError } from './errors';
import {
  abortableSleep,
  CircuitBreaker,
  DEFAULT_RETRY,
  retryAfterFromHeaders,
  retryDelay,
} from './retry';

describe('retry delays', () => {
  it('[AI-009] backs off exponentially with jitter, within the cap', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (attempt, r) => {
          const delay = retryDelay(attempt, undefined, { ...DEFAULT_RETRY, random: () => r });
          const ceiling = Math.min(
            DEFAULT_RETRY.maxDelayMs,
            DEFAULT_RETRY.baseDelayMs * 2 ** attempt,
          );
          expect(delay).toBeGreaterThanOrEqual(Math.floor(ceiling / 2));
          expect(delay).toBeLessThanOrEqual(ceiling);
        },
      ),
    );
  });

  it('[AI-009] honours Retry-After, and gives up when the wait is longer than allowed', () => {
    expect(retryDelay(0, 2_500, DEFAULT_RETRY)).toBe(2_500);
    expect(retryDelay(3, 0, DEFAULT_RETRY)).toBe(0);
    expect(retryDelay(0, DEFAULT_RETRY.maxRetryAfterMs + 1, DEFAULT_RETRY)).toBeUndefined();
  });

  it('[AI-009] reads retry-after-ms, retry-after in seconds and as an HTTP date', () => {
    const now = Date.parse('2026-10-28T10:00:00Z');
    expect(retryAfterFromHeaders(new Headers({ 'retry-after-ms': '1500' }), now)).toBe(1500);
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': '3' }), now)).toBe(3000);
    expect(
      retryAfterFromHeaders(new Headers({ 'retry-after': 'Wed, 28 Oct 2026 10:00:05 GMT' }), now),
    ).toBe(5000);
    expect(retryAfterFromHeaders(new Headers({ 'retry-after': 'soon' }), now)).toBeUndefined();
    expect(retryAfterFromHeaders(new Headers(), now)).toBeUndefined();
  });

  it('[AI-009] a cancelled wait ends at once', async () => {
    const controller = new AbortController();
    const waiting = abortableSleep(60_000, controller.signal);
    controller.abort();
    await expect(waiting).rejects.toBeInstanceOf(AiAbortedError);
  });
});

describe('circuit breaker', () => {
  it('[AI-009] opens after repeated outages, lets one trial call through after the cool-down, and closes on success', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1_000, now: () => now });
    for (let i = 0; i < 3; i++) {
      expect(breaker.tryAcquire()).toBe(true);
      breaker.record('down');
    }
    expect(breaker.state).toBe('open');
    expect(breaker.tryAcquire()).toBe(false);
    expect(breaker.retryAt).toBe(1_000);

    now = 1_000;
    expect(breaker.state).toBe('half-open');
    expect(breaker.tryAcquire()).toBe(true);
    expect(breaker.tryAcquire()).toBe(false); // one trial at a time
    breaker.record('up');
    expect(breaker.state).toBe('closed');
    expect(breaker.tryAcquire()).toBe(true);
  });

  it('[AI-009] a failed trial call opens the circuit for another cool-down', () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 500, now: () => now });
    breaker.tryAcquire();
    breaker.record('down');
    now = 500;
    expect(breaker.tryAcquire()).toBe(true);
    breaker.record('down');
    expect(breaker.state).toBe('open');
    expect(breaker.retryAt).toBe(1_000);
  });

  it('[AI-009] errors about the request and cancelled calls do not count as outages', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2, cooldownMs: 500, now: () => 0 });
    breaker.record('down');
    breaker.record('up');
    breaker.record('down');
    breaker.record('unknown');
    expect(breaker.state).toBe('closed');
  });
});
