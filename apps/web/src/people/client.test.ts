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

describe('a group’s service accounts (T-320)', () => {
  it('[IAM-007] offers the active service accounts, by name and address', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        asked.push(url.replace(/^\/api\/v1/, ''));
        return jsonResponse(200, {
          serviceAccounts: [
            { id: 50, name: 'Release bot', email: 'bot@service.invalid', activeTokens: 2 },
          ],
        });
      }),
    );
    expect(await peopleClient.serviceAccounts()).toEqual([
      { id: 50, name: 'Release bot', email: 'bot@service.invalid' },
    ]);
    expect(asked).toEqual(['/service-accounts?status=active']);
  });
});
