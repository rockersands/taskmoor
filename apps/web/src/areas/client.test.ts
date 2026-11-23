import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { noContent, stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import { areaClient, areaQuery, ticketsInUse } from './client';
import { CHECKOUT } from './fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the areas client (CORE-015)', () => {
  it('[CORE-015] reads the track by key, its areas with the archived ones, and whether the reader may change them', async () => {
    const calls = stubBackend({
      'GET /tracks/SHOP': () =>
        jsonResponse(200, { track: { id: 1, key: 'SHOP', name: 'Shop', archived: false } }),
      'GET /tracks/1/areas?archived=include': () => jsonResponse(200, { areas: [CHECKOUT] }),
      'GET /tracks/1/releases?archived=only': () =>
        jsonResponse(200, { releases: [], mayManage: true }),
    });
    expect((await areaClient.track('SHOP')).id).toBe(1);
    expect(await areaClient.list(1)).toEqual([CHECKOUT]);
    // The releases list says it by the rule the area routes keep (routes/releases.ts mayManage).
    expect(await areaClient.mayManage(1)).toBe(true);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /tracks/SHOP',
      'GET /tracks/1/areas?archived=include',
      'GET /tracks/1/releases?archived=only',
    ]);
  });

  it('[CORE-015] sends a change, an archive, a restore and a delete as the area routes take them', async () => {
    const input = {
      name: 'Checkout',
      description: '',
      ownerId: 21,
      ownerTeamId: null,
      defaultAssignee: 'area_owner' as const,
    };
    const calls = stubBackend({
      'POST /tracks/1/areas': () => jsonResponse(201, { area: CHECKOUT }),
      'PATCH /areas/31': () => jsonResponse(200, { area: CHECKOUT }),
      'POST /areas/31/archive': () => jsonResponse(200, { area: CHECKOUT }),
      'POST /areas/31/restore': () => jsonResponse(200, { area: CHECKOUT }),
      'DELETE /areas/31': () => noContent(),
      'DELETE /areas/31?replacementId=32': () => noContent(),
      'DELETE /areas/31?removeFromTickets=true': () => noContent(),
    });
    await areaClient.create(1, input);
    await areaClient.update(31, input);
    await areaClient.archive(31);
    await areaClient.restore(31);
    await areaClient.remove(31);
    await areaClient.remove(31, { replacementId: 32 });
    await areaClient.remove(31, { removeFromTickets: true });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /tracks/1/areas',
      'PATCH /areas/31',
      'POST /areas/31/archive',
      'POST /areas/31/restore',
      'DELETE /areas/31',
      'DELETE /areas/31?replacementId=32',
      'DELETE /areas/31?removeFromTickets=true',
    ]);
    expect(calls[0]?.body).toEqual(input);
    expect(calls[1]?.body).toEqual(input);
  });

  it('[CORE-015] reads how many tickets hold an area from the refusal to delete it', () => {
    expect(ticketsInUse(new ApiError(409, { error: 'in_use', ticketCount: 4 }))).toBe(4);
    expect(ticketsInUse(new ApiError(409, { error: 'name_taken' }))).toBeNull();
    expect(ticketsInUse(new ApiError(403, { error: 'forbidden' }))).toBeNull();
    expect(ticketsInUse(new Error('offline'))).toBeNull();
  });

  it('[CORE-015] finds an area’s tickets by its name, quoted', () => {
    expect(areaQuery('SHOP', 'Checkout')).toBe('track = SHOP AND area = "Checkout"');
    expect(areaQuery('SHOP', 'The "new" app\\')).toBe(
      'track = SHOP AND area = "The \\"new\\" app\\\\"',
    );
  });
});
