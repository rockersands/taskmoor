import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { everyTeam } from './teams';

describe('every team a page reads (T-286)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[CORE-027] follows the list’s pages, so a team past the first page is read', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const after = new URL(url, 'http://x').searchParams.get('after');
        return after === null
          ? jsonResponse(200, { teams: [{ name: 'Alpha' }, { name: 'Beta' }], next: 'b-2' })
          : jsonResponse(200, { teams: [{ name: 'Zeta' }], next: null });
      }),
    );
    expect(await everyTeam<{ name: string }>('a')).toEqual([
      { name: 'Alpha' },
      { name: 'Beta' },
      { name: 'Zeta' },
    ]);
    expect(urls.map((u) => u.slice(u.indexOf('?')))).toEqual([
      '?query=a&limit=500',
      '?query=a&limit=500&after=b-2',
    ]);
  });

  it('[CORE-027] asks for every team when nothing is typed, and stops at the last page', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        return jsonResponse(200, { teams: [{ name: 'Only' }], next: null });
      }),
    );
    expect(await everyTeam<{ name: string }>()).toEqual([{ name: 'Only' }]);
    expect(urls.map((u) => u.slice(u.indexOf('?')))).toEqual(['?limit=500']);
  });
});
