import { describe, expect, it } from 'vitest';
import { PLATFORM_ROUTES } from './platform';
import type { NativeAnswer, ShimContext } from './types';

interface Track {
  id: number;
  key: string;
  name: string;
  mode: string;
}

/** `count` tracks, keys in the order the native list sorts them (upper-case key). */
const tracksOf = (count: number): Track[] =>
  Array.from({ length: count }, (_, i) => {
    const key = `T${String(i + 1).padStart(4, '0')}`;
    return { id: i + 1, key, name: `Track ${key}`, mode: 'shared' };
  });

/**
 * The native track list as the server answers it (`routes/tracks.ts`): sorted by key, `limit`
 * at most 500, `q` against key and name, the page after `after`, and `next` the last key when
 * more follow.
 */
function nativeTracks(tracks: Track[], asked: string[]) {
  return async (_method: string, path: string): Promise<NativeAnswer> => {
    asked.push(path);
    const url = new URL(path, 'http://taskmoor.test');
    if (url.pathname !== '/api/v1/tracks') return { status: 404, body: { error: 'not_found' } };
    const limit = Math.min(500, Number(url.searchParams.get('limit') ?? 100));
    const q = url.searchParams.get('q')?.toLowerCase();
    const after = url.searchParams.get('after');
    const matching = tracks.filter(
      (t) =>
        (!q || t.key.toLowerCase().includes(q) || t.name.toLowerCase().includes(q)) &&
        (after === null || t.key.toUpperCase() > after.toUpperCase()),
    );
    const page = matching.slice(0, limit);
    const next = matching.length > limit ? (page[page.length - 1]?.key ?? null) : null;
    return { status: 200, body: { tracks: page, next } };
  };
}

function call(path: string, native: ShimContext['native'], query: ShimContext['query'] = {}) {
  const route = PLATFORM_ROUTES.find((r) => r.method === 'GET' && r.path === path);
  if (!route) throw new Error(`no route ${path}`);
  return route.handle({
    version: '3',
    params: { v: '3' },
    query,
    body: undefined,
    native,
    baseUrl: 'http://taskmoor.test',
    richText: (doc) => doc,
  });
}

describe('projects of the Jira-compatible API read every track (T-305)', () => {
  it('[API-003] lists every project the caller may browse, past the first page of tracks', async () => {
    const asked: string[] = [];
    const reply = await call('/rest/api/:v/project', nativeTracks(tracksOf(1_203), asked));
    const keys = (reply.body as { key: string }[]).map((p) => p.key);
    expect(keys).toHaveLength(1_203);
    expect(keys.at(-1)).toBe('T1203');
    expect(new Set(keys).size).toBe(1_203);
    expect(asked).toEqual([
      '/api/v1/tracks?limit=500',
      '/api/v1/tracks?limit=500&after=T0500',
      '/api/v1/tracks?limit=500&after=T1000',
    ]);
  });

  it('[API-003] pages a project search by startAt to the true end and total', async () => {
    const native = nativeTracks(tracksOf(260), []);
    const last = await call('/rest/api/:v/project/search', native, {
      startAt: '250',
      maxResults: '50',
    });
    const body = last.body as { total: number; isLast: boolean; values: { key: string }[] };
    expect(body.total).toBe(260);
    expect(body.isLast).toBe(true);
    expect(body.values.map((p) => p.key)).toEqual(
      tracksOf(260)
        .slice(250)
        .map((t) => t.key),
    );
    const middle = await call('/rest/api/:v/project/search', native, {
      startAt: '200',
      maxResults: '50',
    });
    expect((middle.body as { isLast: boolean }).isLast).toBe(false);
  });

  it('[API-003] finds a project by a query that only a track past the first page matches', async () => {
    const asked: string[] = [];
    const reply = await call('/rest/api/:v/project/search', nativeTracks(tracksOf(700), asked), {
      query: ' t0650 ',
    });
    const body = reply.body as { total: number; values: { key: string }[] };
    expect(body.values.map((p) => p.key)).toEqual(['T0650']);
    expect(body.total).toBe(1);
    // The server narrows the list, so one page holds the answer.
    expect(asked).toEqual(['/api/v1/tracks?limit=500&q=t0650']);
  });

  it('[API-003] stops reading when the list repeats where the next page starts', async () => {
    let calls = 0;
    const reply = await call('/rest/api/:v/project', async () => {
      calls += 1;
      return { status: 200, body: { tracks: [], next: 'SAME' } };
    });
    expect(reply.body).toEqual([]);
    expect(calls).toBe(2);
  });
});
