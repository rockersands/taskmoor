/**
 * The HTTP side of the Cloud REST importer (M1-095; IMP-002; ADR-094): requests to a server that
 * speaks the Jira-compatible REST API, signed with the customer's own token, throttled as such a
 * server asks.
 *
 * - **429 and 503** are retried after the server's `Retry-After` (seconds, or an HTTP date),
 *   and every request of the client waits it out, not only the refused one; without the header,
 *   after the backoff below.
 * - **Other 5xx answers and network errors** are retried with exponential backoff and full
 *   jitter, capped (`baseDelayMs` doubling to `maxDelayMs`).
 * - **At most `concurrency` requests** are in flight at once.
 * - After `maxAttempts` a request fails with `CloudRequestError`; so does any other answer that
 *   is not a success. The fetch (`fetch.ts`) then stops, and the job's next attempt resumes from
 *   the last page it committed.
 *
 * The transport is the only part that touches the network, so tests replace it: a recorded
 * replay (`replay.ts`), or Taskmoor's own compatible API in process. A transport is handed the
 * `Authorization` value separately from the request, so a recording never holds it, and no
 * error message carries it.
 */

/** A request as the importer makes it: the path holds its query, in a stable order. */
export interface CloudRequest {
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

export interface CloudResponse {
  status: number;
  /** Header names in lower case; only the ones the client reads need be there. */
  headers: Record<string, string>;
  body: unknown;
}

/** Sends one request; throws on a network error. */
export type Transport = (request: CloudRequest, authorization: string) => Promise<CloudResponse>;

export interface ClientOptions {
  transport: Transport;
  /** The `Authorization` header: `Basic <email:token>` or `Bearer <token>`. */
  authorization: string;
  concurrency?: number;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** The longest `Retry-After` honoured as given; a longer one waits this long. */
  maxRetryAfterMs?: number;
  /** Replaced in tests: waiting, the clock and the jitter. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
}

/** What the client did, for the report and the tests. */
export interface ClientStats {
  requests: number;
  retries: number;
  /** Answers 429 or 503: the server asked the client to slow down. */
  throttled: number;
  /** 5xx answers other than 503, and network errors. */
  failures: number;
  /** Milliseconds spent waiting before retries. */
  waitedMs: number;
}

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_MAX_ATTEMPTS = 8;
export const DEFAULT_BASE_DELAY_MS = 1_000;
export const DEFAULT_MAX_DELAY_MS = 60_000;
export const DEFAULT_MAX_RETRY_AFTER_MS = 15 * 60_000;

/** The request could not be made, or the server refused it. Never holds the credentials. */
export class CloudRequestError extends Error {
  constructor(
    readonly request: { method: string; path: string },
    /** The last answer's status; null for a network error. */
    readonly status: number | null,
    readonly attempts: number,
    detail: string,
  ) {
    super(`${request.method} ${request.path}: ${detail}`);
  }

  /** Whether a later attempt may do better (throttling, a server or network failure). */
  get transient(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

/**
 * Milliseconds a `Retry-After` value asks for: whole seconds, or an HTTP date (RFC 9110,
 * section 10.2.3) from `now`. Null when the value is neither; a date in the past is zero.
 */
export function retryAfterMs(value: string | undefined, now: number): number | null {
  if (value === undefined) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  if (Number.isNaN(at) || !/[a-z]/i.test(text)) return null;
  return Math.max(0, at - now);
}

/** Exponential backoff with full jitter: a random wait up to the attempt's capped delay. */
export function backoffMs(
  attempt: number,
  random: () => number,
  base = DEFAULT_BASE_DELAY_MS,
  cap = DEFAULT_MAX_DELAY_MS,
): number {
  const ceiling = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  // Half fixed, half random: never a zero wait, and retries of many requests spread out.
  return Math.round(ceiling / 2 + random() * (ceiling / 2));
}

/** Atlassian's hosted and own addresses: the clean room forbids using them (ADR-003). */
export const ATLASSIAN_HOST = /(^|\.)(atlassian\.net|atlassian\.com|jira\.com)$/i;

/** Whether this process runs tests: no request then goes to an Atlassian product. */
const underTest = () => process.env.VITEST !== undefined || process.env.NODE_ENV === 'test';

/**
 * Refuses an Atlassian host when tests run (ADR-003): fixtures are recorded from Taskmoor's own
 * compatible API, never from a real product. A customer's own run may name their site.
 */
export function checkSourceHost(baseUrl: string, testing = underTest()): void {
  const host = new URL(baseUrl).hostname;
  if (testing && ATLASSIAN_HOST.test(host)) {
    throw new Error('Tests never call an Atlassian product (ADR-003): use a recorded replay.');
  }
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class CloudClient {
  readonly stats: ClientStats = { requests: 0, retries: 0, throttled: 0, failures: 0, waitedMs: 0 };
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  /** No request starts before this instant: a `Retry-After` holds every request back. */
  private pausedUntil = 0;
  private readonly concurrency: number;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(private readonly options: ClientOptions) {
    this.concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);
    this.maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    this.baseDelayMs = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
    this.maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
    this.sleep = options.sleep ?? sleepFor;
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  /** The most requests in flight at once so far (the concurrency tests read it). */
  peak = 0;

  private async acquire(): Promise<void> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    }
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
  }

  private release(): void {
    this.active -= 1;
    this.waiting.shift()?.();
  }

  private async wait(ms: number): Promise<void> {
    if (ms <= 0) return;
    this.stats.waitedMs += ms;
    await this.sleep(ms);
  }

  /** The answer's body when it is a success; retries throttling and failures as above. */
  async request(request: CloudRequest): Promise<unknown> {
    let last = 'no attempt';
    let lastStatus: number | null = null;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      // A pause another request was asked for holds this one back too.
      await this.wait(this.pausedUntil - this.now());
      await this.acquire();
      let response: CloudResponse | null = null;
      try {
        this.stats.requests += 1;
        response = await this.options.transport(request, this.options.authorization);
      } catch (error) {
        last = `network error (${error instanceof Error ? error.name : 'unknown'})`;
        lastStatus = null;
      } finally {
        this.release();
      }
      if (response && response.status >= 200 && response.status < 300) return response.body;
      let delay: number;
      if (response) {
        lastStatus = response.status;
        last = `answered ${response.status}`;
        const throttled = response.status === 429 || response.status === 503;
        if (!throttled && response.status < 500) {
          throw new CloudRequestError(request, response.status, attempt, last);
        }
        const asked = throttled ? retryAfterMs(response.headers['retry-after'], this.now()) : null;
        if (throttled) this.stats.throttled += 1;
        else this.stats.failures += 1;
        if (asked !== null) {
          delay = Math.min(asked, this.maxRetryAfterMs);
          this.pausedUntil = Math.max(this.pausedUntil, this.now() + delay);
        } else {
          delay = backoffMs(attempt, this.random, this.baseDelayMs, this.maxDelayMs);
        }
      } else {
        this.stats.failures += 1;
        delay = backoffMs(attempt, this.random, this.baseDelayMs, this.maxDelayMs);
      }
      if (attempt === this.maxAttempts) break;
      this.stats.retries += 1;
      await this.wait(delay);
    }
    throw new CloudRequestError(
      request,
      lastStatus,
      this.maxAttempts,
      `${last} after ${this.maxAttempts} attempts`,
    );
  }

  /** Runs `work` over `items`, at most `concurrency` at once, results in the items' order. */
  async map<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    const lanes = Array.from({ length: Math.min(this.concurrency, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await work(items[i] as T);
      }
    });
    await Promise.all(lanes);
    return out;
  }
}

/** A query string in a stable order, so a replay finds the same request. */
export function withQuery(
  path: string,
  query: Record<string, string | number | undefined>,
): string {
  const entries = Object.entries(query)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (entries.length === 0) return path;
  return `${path}?${new URLSearchParams(entries.map(([k, v]) => [k, String(v)]))}`;
}

/** The platform's fetch as a transport, against a base URL. */
export function fetchTransport(baseUrl: string, timeoutMs = 60_000): Transport {
  const base = baseUrl.replace(/\/+$/, '');
  checkSourceHost(base);
  return async (request, authorization) => {
    const res = await fetch(`${base}${request.path}`, {
      method: request.method,
      headers: {
        authorization,
        accept: 'application/json',
        ...(request.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    const headers: Record<string, string> = {};
    const retry = res.headers.get('retry-after');
    if (retry !== null) headers['retry-after'] = retry;
    return { status: res.status, headers, body };
  };
}
