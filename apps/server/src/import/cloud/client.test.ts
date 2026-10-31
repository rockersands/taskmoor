import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  backoffMs,
  CloudClient,
  CloudRequestError,
  type CloudResponse,
  checkSourceHost,
  retryAfterMs,
  type Transport,
  withQuery,
} from './client';

/** A clock that only moves when the client sleeps, and the waits it slept. */
function fakeTime(start = Date.UTC(2026, 9, 31, 12, 0, 0)) {
  let now = start;
  const waits: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      waits.push(ms);
      now += ms;
    },
    waits,
  };
}

const ok: CloudResponse = { status: 200, headers: {}, body: { ok: true } };

/** Answers from a list, one per call, then success. */
function scripted(answers: (CloudResponse | 'network')[]): Transport & { calls: number } {
  const t = Object.assign(
    async () => {
      t.calls += 1;
      const next = answers.shift();
      if (next === 'network') throw new TypeError('fetch failed');
      return next ?? ok;
    },
    { calls: 0 },
  );
  return t;
}

// Made at run time: no credential is written in the repository.
const auth = () => `Bearer ${randomBytes(24).toString('base64url')}`;

describe('Cloud REST client throttling (M1-095)', () => {
  it('[IMP-002] reads Retry-After as seconds or an HTTP date, and nothing else', () => {
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    expect(retryAfterMs('7', now)).toBe(7000);
    expect(retryAfterMs(' 0 ', now)).toBe(0);
    expect(retryAfterMs(new Date(now + 30_000).toUTCString(), now)).toBe(30_000);
    // A date already past asks for no wait; text that is neither is ignored.
    expect(retryAfterMs(new Date(now - 60_000).toUTCString(), now)).toBe(0);
    expect(retryAfterMs('soon', now)).toBeNull();
    expect(retryAfterMs('-5', now)).toBeNull();
    expect(retryAfterMs('2026', now)).toBe(2026 * 1000);
    expect(retryAfterMs(undefined, now)).toBeNull();
  });

  it('[IMP-002] backs off exponentially with jitter, up to the cap', () => {
    const lowest = [1, 2, 3, 4, 10].map((n) => backoffMs(n, () => 0, 1000, 60_000));
    const highest = [1, 2, 3, 4, 10].map((n) => backoffMs(n, () => 1, 1000, 60_000));
    expect(lowest).toEqual([500, 1000, 2000, 4000, 30_000]);
    expect(highest).toEqual([1000, 2000, 4000, 8000, 60_000]);
  });

  it('[IMP-002] honours 429 with Retry-After in seconds, then succeeds', async () => {
    const time = fakeTime();
    const transport = scripted([{ status: 429, headers: { 'retry-after': '7' }, body: null }]);
    const client = new CloudClient({ transport, authorization: auth(), ...time });
    expect(await client.request({ method: 'GET', path: '/rest/api/3/field' })).toEqual({
      ok: true,
    });
    expect(time.waits).toEqual([7000]);
    expect(client.stats).toMatchObject({ requests: 2, retries: 1, throttled: 1 });
  });

  it('[IMP-002] honours 503 with Retry-After as an HTTP date', async () => {
    const time = fakeTime();
    const at = new Date(time.now() + 45_000).toUTCString();
    const transport = scripted([{ status: 503, headers: { 'retry-after': at }, body: null }]);
    const client = new CloudClient({ transport, authorization: auth(), ...time });
    await client.request({ method: 'GET', path: '/rest/api/3/status' });
    expect(time.waits).toEqual([45_000]);
  });

  it('[IMP-002] backs off on repeated 429s without Retry-After, and gives up after the last attempt', async () => {
    const time = fakeTime();
    const throttled = { status: 429, headers: {}, body: null };
    const transport = scripted([throttled, throttled, throttled]);
    const client = new CloudClient({
      transport,
      authorization: auth(),
      ...time,
      random: () => 0.5,
    });
    await client.request({ method: 'GET', path: '/rest/api/3/priority' });
    expect(time.waits).toEqual([750, 1500, 3000]);

    const always = scripted(Array.from({ length: 10 }, () => throttled));
    const give = new CloudClient({
      transport: always,
      authorization: auth(),
      maxAttempts: 4,
      ...fakeTime(),
    });
    const error = await give.request({ method: 'GET', path: '/x' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CloudRequestError);
    expect((error as CloudRequestError).status).toBe(429);
    expect((error as CloudRequestError).transient).toBe(true);
    expect(always.calls).toBe(4);
  });

  it('[IMP-002] caps a long Retry-After', async () => {
    const time = fakeTime();
    const transport = scripted([{ status: 429, headers: { 'retry-after': '86400' }, body: null }]);
    const client = new CloudClient({
      transport,
      authorization: auth(),
      maxRetryAfterMs: 600_000,
      ...time,
    });
    await client.request({ method: 'GET', path: '/x' });
    expect(time.waits).toEqual([600_000]);
  });

  it('[IMP-002] retries 5xx answers and network errors; other refusals fail at once', async () => {
    const time = fakeTime();
    const transport = scripted([
      { status: 500, headers: {}, body: null },
      'network',
      { status: 502, headers: {}, body: null },
    ]);
    const client = new CloudClient({ transport, authorization: auth(), ...time, random: () => 0 });
    await client.request({ method: 'GET', path: '/x' });
    expect(time.waits).toEqual([500, 1000, 2000]);
    expect(client.stats.failures).toBe(3);

    const refused = scripted([{ status: 403, headers: {}, body: { errorMessages: ['no'] } }]);
    const strict = new CloudClient({ transport: refused, authorization: auth(), ...fakeTime() });
    const error = await strict.request({ method: 'GET', path: '/y' }).catch((e: unknown) => e);
    expect((error as CloudRequestError).status).toBe(403);
    expect((error as CloudRequestError).transient).toBe(false);
    expect(refused.calls).toBe(1);
  });

  it('[IMP-002] holds every request back while the server asked for a pause', async () => {
    const time = fakeTime();
    let first = true;
    const starts: number[] = [];
    const transport: Transport = async () => {
      starts.push(time.now());
      if (first) {
        first = false;
        return { status: 429, headers: { 'retry-after': '5' }, body: null };
      }
      return ok;
    };
    const client = new CloudClient({ transport, authorization: auth(), ...time });
    await client.request({ method: 'GET', path: '/a' });
    // A later request waits out what is left of the pause before it starts.
    await client.request({ method: 'GET', path: '/b' });
    expect(starts.every((s, i) => i === 0 || s >= (starts[0] as number) + 5000)).toBe(true);
  });

  it('[IMP-002] keeps at most the concurrency limit in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const transport: Transport = async () => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok;
    };
    const client = new CloudClient({ transport, authorization: auth(), concurrency: 3 });
    await client.map(
      Array.from({ length: 20 }, (_, i) => i),
      (i) => client.request({ method: 'GET', path: `/rest/api/3/issue/${i}` }),
    );
    expect(most).toBe(3);
    expect(client.peak).toBe(3);
  });

  it('[IMP-002] never puts the credentials in an error', async () => {
    const authorization = auth();
    const transport = scripted(['network', 'network']);
    const client = new CloudClient({ transport, authorization, maxAttempts: 2, ...fakeTime() });
    const error = (await client
      .request({ method: 'GET', path: '/rest/api/3/myself' })
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('/rest/api/3/myself');
    expect(error.message).not.toContain(authorization.slice('Bearer '.length));
  });

  it('[IMP-002] refuses Atlassian hosts when tests run (ADR-003)', () => {
    for (const url of [
      'https://example.atlassian.net',
      'https://x.jira.com/rest',
      'https://api.atlassian.com',
    ]) {
      expect(() => checkSourceHost(url)).toThrow(/ADR-003/);
    }
    expect(() => checkSourceHost('https://source.example.test')).not.toThrow();
    // A customer's own run outside tests may name their site.
    expect(() => checkSourceHost('https://example.atlassian.net', false)).not.toThrow();
  });

  it('writes query strings in a stable order', () => {
    expect(withQuery('/p', { b: 2, a: 'x y', c: undefined })).toBe('/p?a=x+y&b=2');
    expect(withQuery('/p', {})).toBe('/p');
  });
});
