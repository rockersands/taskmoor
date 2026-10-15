import { describe, expect, it } from 'vitest';
import { stubBackend } from '../test/backend';
import { jsonResponse } from '../test/setup';
import {
  hashParam,
  identityProvidersClient,
  normalizeDomain,
  returnTo,
  signInSsoClient,
  startUrl,
  withoutHashParam,
} from './client';

describe('single sign-on client helpers (M1-080)', () => {
  it('[IAM-003] returns to the page the person was on, never to the sign-in page', () => {
    expect(returnTo('#/settings')).toBe('/#/settings');
    expect(returnTo('#/tracks/ACME?view=list')).toBe('/#/tracks/ACME?view=list');
    expect(returnTo('#/sign-in')).toBe('/');
    expect(returnTo('#/sign-in?sso_error=no_account')).toBe('/');
    expect(returnTo('#/sign-in/anything')).toBe('/');
    expect(returnTo('')).toBe('/');
    expect(returnTo('#/')).toBe('/');
    // Only paths: whatever does not start with a slash goes to the start page.
    expect(returnTo('#evil.example')).toBe('/');
    // The backend keeps at most 500 characters; a longer address would be cut, so start over.
    expect(returnTo(`#/${'a'.repeat(600)}`)).toBe('/');
    // A route that only starts like the sign-in page is a page of its own.
    expect(returnTo('#/sign-inside')).toBe('/#/sign-inside');
  });

  it('[IAM-003] starts a sign-in at the backend with the return address encoded', () => {
    expect(startUrl(7, '/#/settings')).toBe('/api/v1/auth/oidc/7/start?returnTo=%2F%23%2Fsettings');
  });

  it('[IAM-003] reads and removes one parameter of the hash route', () => {
    const hash = '#/sign-in?sso_error=no_account&method=password';
    expect(hashParam(hash, 'sso_error')).toBe('no_account');
    expect(hashParam(hash, 'method')).toBe('password');
    expect(hashParam('#/sign-in', 'method')).toBeNull();
    expect(withoutHashParam(hash, 'sso_error')).toBe('#/sign-in?method=password');
    expect(withoutHashParam('#/sign-in?sso_error=x', 'sso_error')).toBe('#/sign-in');
    expect(withoutHashParam('#/sign-in', 'sso_error')).toBe('#/sign-in');
  });

  it('[IAM-003] stores domains as the backend does and refuses what is not one', () => {
    expect(normalizeDomain('  Corp.Example.COM ')).toBe('corp.example.com');
    expect(normalizeDomain('@corp.example')).toBe('corp.example');
    expect(normalizeDomain('corp.example.')).toBe('corp.example');
    expect(normalizeDomain('localhost')).toBeNull();
    expect(normalizeDomain('corp_example.com')).toBeNull();
    expect(normalizeDomain('-corp.example')).toBeNull();
    expect(normalizeDomain('a@b.example')).toBeNull();
    // Service accounts live under .invalid; no provider may claim it.
    expect(normalizeDomain('service.invalid')).toBeNull();
    expect(normalizeDomain(`${'a'.repeat(250)}.com`)).toBeNull();
  });

  it('[IAM-003] the sign-in page reads the providers and asks about a domain', async () => {
    const calls = stubBackend({
      'GET /auth/providers': () => jsonResponse(200, { providers: [{ id: 1, name: 'Staff' }] }),
      'POST /auth/discover': () =>
        jsonResponse(200, { provider: { id: 1, name: 'Staff' }, password: false }),
    });
    expect(await signInSsoClient.providers()).toEqual([{ id: 1, name: 'Staff' }]);
    expect(await signInSsoClient.discover('sam@corp.example')).toEqual({
      provider: { id: 1, name: 'Staff' },
      password: false,
    });
    expect(calls).toEqual([
      { method: 'GET', path: '/auth/providers', body: undefined },
      { method: 'POST', path: '/auth/discover', body: { email: 'sam@corp.example' } },
    ]);
  });

  it('[IAM-003] administration reads, creates, edits and deletes providers', async () => {
    const provider = { id: 5, name: 'Staff' };
    const calls = stubBackend({
      'GET /identity-providers': () =>
        jsonResponse(200, { providers: [provider], redirectUri: 'https://t.example/cb' }),
      'POST /identity-providers': () => jsonResponse(201, { provider }),
      'PATCH /identity-providers/5': () => jsonResponse(200, { provider }),
      'DELETE /identity-providers/5': () => new Response(null, { status: 204 }),
      'GET /groups': () =>
        jsonResponse(200, { groups: [{ id: 3, name: 'Finance', memberCount: 4, childCount: 0 }] }),
    });
    expect(await identityProvidersClient.list()).toEqual({
      providers: [provider],
      redirectUri: 'https://t.example/cb',
    });
    const input = {
      name: 'Staff',
      issuer: 'https://id.example',
      clientId: 'taskmoor',
      scopes: 'openid email profile',
      groupClaim: null,
      domains: [],
      enforceSso: false,
      jit: true,
      enabled: true,
      groupMap: [],
    };
    expect(await identityProvidersClient.create(input)).toEqual(provider);
    expect(await identityProvidersClient.update(5, { enabled: false })).toEqual(provider);
    await identityProvidersClient.remove(5);
    // Only what the mapping editor needs.
    expect(await identityProvidersClient.groups()).toEqual([{ id: 3, name: 'Finance' }]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'GET /identity-providers',
      'POST /identity-providers',
      'PATCH /identity-providers/5',
      'DELETE /identity-providers/5',
      'GET /groups',
    ]);
    expect(calls[2]?.body).toEqual({ enabled: false });
  });
});
