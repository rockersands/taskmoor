import { describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { adminTokensClient, TOKENS_PAGE } from './client';

describe('the token inventory client (T-308)', () => {
  it('[IAM-007] asks for a page of tokens from where the shown ones end', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url.replace(/^\/api\/v1/, ''));
        return jsonResponse(200, { tokens: [], total: 900, owners: [] });
      }),
    );
    expect(await adminTokensClient.list('all')).toEqual({ tokens: [], total: 900, owners: [] });
    await adminTokensClient.list('revoked', TOKENS_PAGE);
    expect(asked).toEqual([
      `/admin/tokens?status=all&limit=${TOKENS_PAGE}`,
      `/admin/tokens?status=revoked&limit=${TOKENS_PAGE}&offset=${TOKENS_PAGE}`,
    ]);
  });
});
