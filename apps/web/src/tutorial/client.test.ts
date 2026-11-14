import { afterEach, describe, expect, it, vi } from 'vitest';
import { tutorialClient } from './client';

describe('the tutorial’s saves (ADR-115)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[AGL-025] sends a section’s place so that it arrives when the person leaves at once (T-245)', async () => {
    const sent: { url: string; init: RequestInit | undefined }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, init });
        return new Response(null, { status: 204 });
      }),
    );
    // Finish saves Done without waiting; the page may close before the answer comes.
    await tutorialClient.save('tracks', 'done', 4);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe('/api/v1/account/tutorial/tracks');
    expect(sent[0]?.init).toMatchObject({ method: 'PUT', keepalive: true });
    expect(JSON.parse(String(sent[0]?.init?.body))).toEqual({ state: 'done', step: 4 });
  });
});
