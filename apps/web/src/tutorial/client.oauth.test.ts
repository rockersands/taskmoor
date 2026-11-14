import { afterEach, describe, expect, it, vi } from 'vitest';

// A frontend on another site signs in with OAuth (ADR-080): its access token is near its end,
// and refreshing it takes a round trip that does not come back here.
const refresh = vi.fn(() => new Promise<string | null>(() => {}));
vi.mock('../session/oauth', () => ({
  oauthClient: {
    accessToken: refresh,
    currentToken: () => 'still-good',
    forceRefresh: refresh,
  },
}));

const { tutorialClient } = await import('./client');

describe('the tutorial’s saves with OAuth sign-in (ADR-115, ADR-080)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[AGL-025] sends Finish’s save at once with the token in hand, not after an early refresh the closing page may never finish (T-245)', async () => {
    const sent: RequestInit[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        sent.push(init ?? {});
        return new Response(null, { status: 204 });
      }),
    );
    void tutorialClient.save('tracks', 'done', 4);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toMatchObject({ method: 'PUT', keepalive: true, credentials: 'omit' });
    expect(new Headers(sent[0]?.headers).get('authorization')).toBe('Bearer still-good');
    expect(refresh).not.toHaveBeenCalled();
  });
});
