import { afterEach, describe, expect, it, vi } from 'vitest';
import { deviceTimeZone, setAccountTimeZone } from '../i18n/zone';
import { jsonResponse } from '../test/setup';
import { API_BASE, api, apiFetch, TIME_ZONE_HEADER } from './client';

describe('the time zone the backend counts days in (T-272)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    setAccountTimeZone(null);
  });

  const stub = () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(200, {}));
    vi.stubGlobal('fetch', fetch);
    return fetch;
  };
  const sent = (fetch: ReturnType<typeof stub>, i: number) =>
    new Headers(fetch.mock.calls[i]?.[1]?.headers).get(TIME_ZONE_HEADER);

  it('[RPT-002] every request carries the device’s zone on Automatic, the clock localDay() reads', async () => {
    const fetch = stub();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: 'America/New_York',
    });
    expect(deviceTimeZone()).toBe('America/New_York');
    await api('/tracks/MOB/statistics/recently-created?days=30');
    await api('/dashboards', { method: 'POST', body: { name: 'Mine' } });
    await apiFetch(`${API_BASE}/admin/imports/files?name=a.csv`, { method: 'POST', body: '{}' });
    expect([sent(fetch, 0), sent(fetch, 1), sent(fetch, 2)]).toEqual([
      'America/New_York',
      'America/New_York',
      'America/New_York',
    ]);
    // A JSON body keeps its content type beside it.
    expect(new Headers(fetch.mock.calls[1]?.[1]?.headers).get('content-type')).toBe(
      'application/json',
    );
  });

  it('[RPT-002] a browser with no zone sends none, and the backend uses the profile’s', async () => {
    const fetch = stub();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: '',
    });
    await api('/dashboards');
    expect(sent(fetch, 0)).toBeNull();
  });

  it('[RPT-002] [IAM-008] carries the account’s zone when one is saved, whatever the device’s (T-280)', async () => {
    const fetch = stub();
    vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
      ...new Intl.DateTimeFormat().resolvedOptions(),
      timeZone: 'America/New_York',
    });
    setAccountTimeZone('Asia/Tokyo');
    await api('/dashboards');
    // A name the browser does not know falls back to the device's.
    setAccountTimeZone('Mars/Olympus');
    await api('/dashboards');
    // Automatic again: the device's.
    setAccountTimeZone(null);
    await api('/dashboards');
    // A caller that names a zone keeps it.
    setAccountTimeZone('Asia/Tokyo');
    await apiFetch(`${API_BASE}/dashboards`, { headers: { [TIME_ZONE_HEADER]: 'Europe/Madrid' } });
    expect([0, 1, 2, 3].map((i) => sent(fetch, i))).toEqual([
      'Asia/Tokyo',
      'America/New_York',
      'America/New_York',
      'Europe/Madrid',
    ]);
  });
});
