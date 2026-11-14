import { describe, expect, it, vi } from 'vitest';
import { jsonResponse } from '../test/setup';
import { peopleClient, USERS_PAGE } from './client';

describe('the people client (T-307)', () => {
  it('[IAM-008] asks for a page of people from where the shown ones end', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url.replace(/^\/api\/v1/, ''));
        return jsonResponse(200, { users: [], total: 450 });
      }),
    );
    expect(await peopleClient.users('', 'active')).toEqual({ users: [], total: 450 });
    await peopleClient.users('ada lo', 'all', USERS_PAGE);
    expect(asked).toEqual([
      `/users?status=active&limit=${USERS_PAGE}`,
      `/users?status=all&limit=${USERS_PAGE}&offset=${USERS_PAGE}&query=ada%20lo`,
    ]);
  });
});
