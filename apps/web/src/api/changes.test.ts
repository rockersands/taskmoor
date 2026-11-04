import { afterEach, describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { type ApiChange, changedPath, onApiChange } from './changes';
import { API_BASE, api, apiFetch } from './client';

describe('changes the backend accepted (ADR-115)', () => {
  const seen: ApiChange[] = [];
  const off = onApiChange((change) => seen.push(change));
  afterEach(() => {
    seen.length = 0;
  });

  it('[AGL-025] are told with their method and path, and reads and refusals are not', async () => {
    stubBackend({
      'GET /dashboards': () => jsonResponse(200, { dashboards: [] }),
      'POST /dashboards': () => jsonResponse(201, { dashboard: { id: 7 } }),
      'PATCH /dashboards/7': () => jsonResponse(403, { error: 'forbidden' }),
      'POST /admin/imports/files?name=a.csv': () => jsonResponse(201, { file: {} }),
    });
    await api('/dashboards');
    await api('/dashboards', { method: 'POST', body: { name: 'Mine' } });
    await expect(api('/dashboards/7', { method: 'PATCH', body: {} })).rejects.toThrow();
    // Uploads go through apiFetch directly; the query is left out.
    await apiFetch(`${API_BASE}/admin/imports/files?name=a.csv`, { method: 'POST', body: '{}' });
    expect(seen).toEqual([
      { method: 'POST', path: '/dashboards' },
      { method: 'POST', path: '/admin/imports/files' },
    ]);
  });

  it('[AGL-025] stop once unsubscribed, and a listener that throws stops nothing', async () => {
    stubBackend({ 'POST /search': () => jsonResponse(200, { tickets: [] }) });
    const broken = onApiChange(() => {
      throw new Error('broken listener');
    });
    await api('/search', { method: 'POST', body: { q: '' } });
    broken();
    off();
    await api('/search', { method: 'POST', body: { q: '' } });
    expect(seen).toEqual([{ method: 'POST', path: '/search' }]);
  });

  it('[AGL-025] read the path under the API, from a backend on another origin too', () => {
    expect(changedPath('/api/v1/tickets/A-1/comments?x=1', '/api/v1')).toBe(
      '/tickets/A-1/comments',
    );
    expect(
      changedPath('https://api.example.test/api/v1/tracks', 'https://api.example.test/api/v1'),
    ).toBe('/tracks');
    expect(changedPath('https://other.test/api/v1/users', '/api/v1')).toBe('/users');
  });
});
