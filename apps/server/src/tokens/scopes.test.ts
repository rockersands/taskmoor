import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { bearerToken } from './api-tokens';
import {
  ADMIN_ROUTE_PREFIXES,
  PUBLIC_ROUTES,
  routeAccess,
  SESSION_ONLY_ROUTES,
  scopeDenial,
} from './scopes';

describe('token scopes per route (IAM-007)', () => {
  const database = useMigratedDatabase();
  let app: FastifyInstance;
  let api: string[];

  beforeAll(async () => {
    app = await buildApp({ db: database.db, version: 'test', roles: ['api'] });
    api = app.routeTable.filter((r) => r.split(' ')[1]?.startsWith('/api/'));
  });
  afterAll(async () => {
    await app.close();
  });

  it('[IAM-007] names only routes that exist, so a renamed route cannot slip out of its class', () => {
    const missing = [...PUBLIC_ROUTES, ...SESSION_ONLY_ROUTES].filter((r) => !api.includes(r));
    expect(missing).toEqual([]);
    for (const prefix of ADMIN_ROUTE_PREFIXES) {
      expect(
        api.some((r) => {
          const url = r.split(' ')[1] ?? '';
          return url === prefix || url.startsWith(`${prefix}/`);
        }),
        prefix,
      ).toBe(true);
    }
  });

  it('[IAM-007] classes every API route: public, session only, admin, or read and write by method', () => {
    const classes = Object.fromEntries(
      api.map((r) => {
        const [method = '', url = ''] = r.split(' ');
        return [r, routeAccess(method, url)];
      }),
    );
    expect(classes['GET /api/v1/session']).toBe('read');
    expect(classes['PATCH /api/v1/account']).toBe('write');
    expect(classes['GET /api/v1/me/permissions']).toBe('read');
    expect(classes['PUT /api/v1/tracks/:id/roles/:roleId/users/:actorId']).toBe('write');
    expect(classes['GET /api/v1/users/:id']).toBe('admin');
    expect(classes['POST /api/v1/admin/tokens/revoke']).toBe('admin');
    expect(classes['POST /api/v1/service-accounts/:id/tokens/:tokenId/rotate']).toBe('admin');
    expect(classes['POST /api/v1/account/tokens']).toBe('session');
    expect(classes['POST /api/v1/session']).toBe('public');
    // Every route that only site administrators may use is in the admin class.
    const adminOnly = api.filter((r) =>
      /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/(users|groups|roles|access-policies|global-grants|admin|service-accounts)/.test(
        r,
      ),
    );
    expect(adminOnly.length).toBeGreaterThan(30);
    for (const r of adminOnly) expect(classes[r], r).toBe('admin');
  });

  it('[IAM-007] reports the scope a route needs', () => {
    expect(scopeDenial('GET', '/api/v1/session', ['read'])).toBeNull();
    expect(scopeDenial('GET', '/api/v1/session', ['write'])).toEqual({
      error: 'insufficient_scope',
      requiredScope: 'read',
    });
    expect(scopeDenial('DELETE', '/api/v1/groups/:id', ['read', 'write'])).toEqual({
      error: 'insufficient_scope',
      requiredScope: 'admin',
    });
    expect(scopeDenial('GET', '/api/v1/sessions', ['read', 'write', 'admin'])).toEqual({
      error: 'session_required',
    });
    expect(scopeDenial('POST', '/api/v1/password-check', ['read'])).toBeNull();
    expect(scopeDenial('GET', undefined, ['read'])).toBeNull();
    // A path that merely starts like an administration path is not one.
    expect(routeAccess('GET', '/api/v1/usersettings')).toBe('read');
  });

  it('[IAM-007] reads only the Bearer scheme of the Authorization header', () => {
    expect(bearerToken('Bearer tmk_abc')).toBe('tmk_abc');
    expect(bearerToken('bearer   tmk_abc  ')).toBe('tmk_abc');
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(bearerToken('Bearer a b')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
