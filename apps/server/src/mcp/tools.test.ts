import { describe, expect, it } from 'vitest';
import { type Api, TOOLS } from './tools';

const listTracks = TOOLS.find((t) => t.name === 'list_tracks');

/** The native track list: 250 tracks by key, a page of `limit` (100 unless asked) after `after`. */
function tracksApi(asked: string[]): Api {
  const tracks = Array.from({ length: 250 }, (_, i) => {
    const key = `T${String(i + 1).padStart(3, '0')}`;
    return { id: i + 1, key, name: `Track ${key}`, type: 'software' };
  });
  return async (_method, url) => {
    asked.push(url);
    const params = new URL(url, 'http://taskmoor.test').searchParams;
    const limit = Number(params.get('limit') ?? 100);
    const after = params.get('after');
    const rest = tracks.filter((t) => after === null || t.key > after);
    const page = rest.slice(0, limit);
    const next = rest.length > limit ? (page[page.length - 1]?.key ?? null) : null;
    return { status: 200, body: { tracks: page, next } };
  };
}

describe('the MCP tool list_tracks (M1-072; T-305)', () => {
  it('[API-012] says where the next page starts, and reads it from that cursor', async () => {
    if (!listTracks) throw new Error('no list_tracks tool');
    const asked: string[] = [];
    const api = tracksApi(asked);
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
      const args = listTracks.input.parse(cursor ? { cursor } : {});
      const answer = (await listTracks.run(api, args)) as {
        tracks: { key: string }[];
        next: string | null;
      };
      keys.push(...answer.tracks.map((t) => t.key));
      cursor = answer.next ?? undefined;
    } while (cursor !== undefined && asked.length < 10);
    expect(keys).toHaveLength(250);
    expect(keys.at(-1)).toBe('T250');
    expect(asked).toEqual([
      '/api/v1/tracks?limit=100',
      '/api/v1/tracks?limit=100&after=T100',
      '/api/v1/tracks?limit=100&after=T200',
    ]);
  });

  it('[API-012] reads up to the limit asked for, at most 500', async () => {
    if (!listTracks) throw new Error('no list_tracks tool');
    const asked: string[] = [];
    const answer = (await listTracks.run(
      tracksApi(asked),
      listTracks.input.parse({ limit: 300 }),
    )) as { tracks: unknown[]; next: string | null };
    expect(answer.tracks).toHaveLength(250);
    expect(answer.next).toBeNull();
    expect(asked).toEqual(['/api/v1/tracks?limit=300']);
    expect(listTracks.input.safeParse({ limit: 501 }).success).toBe(false);
    expect(listTracks.input.safeParse({ cursor: '' }).success).toBe(false);
  });
});
