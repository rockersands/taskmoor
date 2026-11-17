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

describe('people’s roles and their page (T-331)', () => {
  it('[IAM-009] asks the server for one role’s people, and reads a person with their roles', async () => {
    const asked: { url: string; method: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        asked.push({ url: url.replace(/^\/api\/v1/, ''), method: init?.method ?? 'GET' });
        if (url.endsWith('/users/3')) {
          return jsonResponse(200, {
            user: { id: 3, name: 'Grace Hopper', roles: ['ai_admin'], tracksRun: 0 },
            roles: [{ role: 'ai_admin', sources: [{ kind: 'user' }] }],
            tracks: [],
            hasSecondFactor: true,
            groups: [],
            effectiveGroupIds: [],
            directory: { id: 2, name: 'Corporate', dn: 'cn=grace', mode: 'read_only' },
          });
        }
        if (url.endsWith('/two-factor/reset')) return new Response(null, { status: 204 });
        return jsonResponse(200, { users: [], total: 0 });
      }),
    );
    await peopleClient.users('gr', 'all', 0, 'runs_tracks');
    await peopleClient.users('', 'active', 0, 'any');
    const person = await peopleClient.person(3);
    expect(person.roles).toEqual([{ role: 'ai_admin', sources: [{ kind: 'user' }] }]);
    expect(person.directory).toEqual({ id: 2, name: 'Corporate', mode: 'read_only' });
    expect(person.hasSecondFactor).toBe(true);
    await peopleClient.resetTwoFactor(3);
    expect(asked).toEqual([
      { url: `/users?status=all&limit=${USERS_PAGE}&role=runs_tracks&query=gr`, method: 'GET' },
      { url: `/users?status=active&limit=${USERS_PAGE}`, method: 'GET' },
      { url: '/users/3', method: 'GET' },
      { url: '/users/3/two-factor/reset', method: 'POST' },
    ]);
  });
});
