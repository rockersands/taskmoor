import { afterEach, describe, expect, it, vi } from 'vitest';
import { FIRST_PAGE_TRACK, SECOND_PAGE_TRACK, stubTwoTrackPages } from '../test/trackPages';
import { trackClient } from './client';

describe('the Tracks directory (T-305)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[CORE-001] lists every track the person sees, past the list’s first page', async () => {
    const asked = stubTwoTrackPages();
    expect(await trackClient.list()).toEqual([FIRST_PAGE_TRACK, SECOND_PAGE_TRACK]);
    expect(asked).toEqual(['/tracks?limit=500', '/tracks?limit=500&after=AAA']);
  });
});

describe('the custom fields a track’s statistics group by (T-251)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[RPT-002] [RPT-005] asks the list of fields for the track by its id, never the per-type route without a type', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        // The per-type route needs a ticket type and refuses a request without one.
        if (/\/tracks\/[^/]+\/fields(\?|$)/.test(url) && !url.includes('ticketTypeId=')) {
          return new Response(JSON.stringify({ error: 'invalid_request' }), {
            status: 400,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(
          JSON.stringify({
            fields: [
              { id: 4, name: 'Notes', type: 'text' },
              { id: 7, name: 'Team', type: 'team' },
              { id: 8, name: 'Size', type: 'select' },
              { id: 9, name: 'Cost', type: 'number' },
              { id: 10, name: 'Tags', type: 'labels' },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    const fields = await trackClient.groupFields(12);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/\/api\/v1\/fields\?trackId=12$/);
    // Only the types a report groups by: the server refuses the others as an axis.
    expect(fields).toEqual([
      { id: 'cf[7]', name: 'Team' },
      { id: 'cf[8]', name: 'Size' },
      { id: 'cf[10]', name: 'Tags' },
    ]);
  });
});
