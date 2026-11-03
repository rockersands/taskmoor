import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createClient } from '../CreateTicketPage';
import { loadSubticketProgress, SUBTICKET_PROGRESS_IDS, ticketToolsClient } from './client';

/** The server's source, from the repository root or from the app (as the SSO tests read it). */
const serverSource = (file: string) => {
  const path = [`apps/server/src/${file}`, `../server/src/${file}`]
    .map((p) => resolve(process.cwd(), p))
    .find((p) => existsSync(p));
  return readFileSync(path ?? file, 'utf8');
};

describe('subticket progress for a board or a list', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[CORE-032] asks as many at once as the server takes, the most a board holds', () => {
    const route = serverSource('routes/subtickets.ts');
    const cap = /const MAX_IDS = ([\d_]+);/.exec(route)?.[1];
    expect(Number(cap?.replaceAll('_', ''))).toBe(SUBTICKET_PROGRESS_IDS);
    const boards = serverSource('routes/boards.ts');
    const most = /limit: z\.coerce\.number\(\)\.int\(\)\.min\(1\)\.max\(([\d_]+)\)/.exec(
      boards,
    )?.[1];
    expect(Number(most?.replaceAll('_', ''))).toBeLessThanOrEqual(SUBTICKET_PROGRESS_IDS);
  });

  it('[CORE-032] sends more tickets than that in parts and merges the answers', async () => {
    const sent: number[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        expect(url).toMatch(/\/api\/v1\/tickets\/subticket-progress$/);
        const { ids } = JSON.parse(String(init?.body)) as { ids: number[] };
        sent.push(ids);
        const progress = Object.fromEntries(
          ids.filter((id) => id % 25_000 === 1).map((id) => [id, { total: 2, closed: 1 }]),
        );
        return new Response(JSON.stringify({ progress }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const ids = Array.from({ length: SUBTICKET_PROGRESS_IDS * 2 + 1 }, (_, i) => i + 1);
    const found = await loadSubticketProgress([...ids, 1]);
    expect(sent.map((part) => part.length)).toEqual([
      SUBTICKET_PROGRESS_IDS,
      SUBTICKET_PROGRESS_IDS,
      1,
    ]);
    expect(sent.flat()).toEqual(ids);
    expect(Object.keys(found)).toEqual(['1', '25001', '50001', '75001', '100001']);
    expect(found[100001]).toEqual({ total: 2, closed: 1 });
  });

  it('[CORE-032] sends one request at the limit, and none for no tickets', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ progress: { 7: { total: 1, closed: 0 } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const ids = Array.from({ length: SUBTICKET_PROGRESS_IDS }, (_, i) => i + 1);
    expect(await loadSubticketProgress(ids)).toEqual({ 7: { total: 1, closed: 0 } });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(await loadSubticketProgress([])).toEqual({});
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('the field names a subticket refusal uses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('[CORE-032] reads the type’s create form, the same request the create form makes', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const form = {
          layout: { operation: 'create', tabs: [] },
          customFields: [
            { id: 12, name: 'Customer', description: '', type: 'text', multiple: false },
          ],
        };
        return new Response(JSON.stringify(form), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    expect(await ticketToolsClient.childFields?.('SHOP & CO', 9)).toEqual([
      { id: 12, name: 'Customer' },
    ]);
    await createClient.form('SHOP & CO', 9);
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(urls[0]).toMatch(/\/tracks\/SHOP%20%26%20CO\/layout\?ticketTypeId=9&operation=create$/);
  });
});
