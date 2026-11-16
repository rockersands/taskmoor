import { afterEach, describe, expect, it, vi } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { labelsClient } from './client';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the labels client (T-322)', () => {
  it('[CORE-017] reads a page of labels with their counts, by how they start and after the last one', async () => {
    const page = { labels: [{ name: 'front-end', ticketCount: 2 }], more: true };
    const calls = stubBackend({
      'GET /labels/usage?limit=50': () => jsonResponse(200, page),
      'GET /labels/usage?q=front+end&after=fe&limit=50': () => jsonResponse(200, page),
    });
    expect(await labelsClient.usage({ limit: 50 })).toEqual(page);
    expect(await labelsClient.usage({ q: 'front end', after: 'fe', limit: 50 })).toEqual(page);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /labels/usage?limit=50',
      'GET /labels/usage?q=front+end&after=fe&limit=50',
    ]);
  });

  it('[CORE-017] sends a merge as the route takes it', async () => {
    const merged = { into: 'frontend', labels: ['front-end', 'fe'], ticketCount: 3 };
    const calls = stubBackend({ 'POST /labels/merge': () => jsonResponse(200, merged) });
    expect(await labelsClient.merge(['front-end', 'fe'], 'frontend')).toEqual(merged);
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/labels/merge',
        body: { labels: ['front-end', 'fe'], into: 'frontend' },
      },
    ]);
  });
});
