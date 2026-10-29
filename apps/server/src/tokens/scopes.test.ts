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
    expect(classes['POST /api/v1/session/second-factor']).toBe('public');
    expect(classes['GET /api/v1/auth/oidc/callback']).toBe('public');
    expect(classes['POST /api/v1/auth/saml/:id/acs']).toBe('public');
    expect(classes['GET /api/v1/auth/saml/continue']).toBe('public');
    expect(classes['GET /api/v1/auth/saml/:id/metadata']).toBe('public');
    expect(classes['POST /api/v1/account/two-factor/totp/disable']).toBe('session');
    expect(classes['PUT /api/v1/security/two-factor']).toBe('admin');
    expect(classes['GET /api/v1/audit/export']).toBe('admin');
    expect(classes['PATCH /api/v1/identity-providers/:id']).toBe('admin');
    // LDAP and Active Directory administration (M1-082), reads included.
    expect(classes['GET /api/v1/directories']).toBe('admin');
    expect(classes['POST /api/v1/directories/:id/sync']).toBe('admin');
    expect(classes['POST /api/v1/directories/test']).toBe('admin');
    expect(classes['POST /api/v1/tracks']).toBe('write');
    // Track configuration: read and write, so local-mode track administrators keep theirs.
    expect(classes['GET /api/v1/hierarchy-levels']).toBe('read');
    expect(classes['GET /api/v1/hierarchy-levels/impact']).toBe('read');
    expect(classes['POST /api/v1/hierarchy-levels']).toBe('write');
    expect(classes['PATCH /api/v1/hierarchy-levels/:id']).toBe('write');
    expect(classes['DELETE /api/v1/hierarchy-levels/:id']).toBe('write');
    expect(classes['GET /api/v1/ticket-types']).toBe('read');
    expect(classes['GET /api/v1/ticket-types/:id']).toBe('read');
    expect(classes['POST /api/v1/ticket-types']).toBe('write');
    expect(classes['PATCH /api/v1/ticket-types/:id']).toBe('write');
    expect(classes['DELETE /api/v1/ticket-types/:id']).toBe('write');
    expect(classes['GET /api/v1/type-sets']).toBe('read');
    expect(classes['GET /api/v1/type-sets/:id']).toBe('read');
    expect(classes['POST /api/v1/type-sets']).toBe('write');
    expect(classes['PATCH /api/v1/type-sets/:id']).toBe('write');
    expect(classes['DELETE /api/v1/type-sets/:id']).toBe('write');
    expect(classes['GET /api/v1/tracks/:id/ticket-types']).toBe('read');
    // Workflow maps (M1-028): track configuration too, so a local-mode track's administrators
    // change its own map with a write token.
    expect(classes['GET /api/v1/workflow-maps']).toBe('read');
    expect(classes['GET /api/v1/workflow-maps/:id']).toBe('read');
    expect(classes['POST /api/v1/workflow-maps']).toBe('write');
    expect(classes['PATCH /api/v1/workflow-maps/:id']).toBe('write');
    expect(classes['DELETE /api/v1/workflow-maps/:id']).toBe('write');
    expect(classes['POST /api/v1/workflow-maps/:id/impact']).toBe('write');
    expect(classes['GET /api/v1/tracks/:id/workflow-map']).toBe('read');
    expect(classes['GET /api/v1/tracks/:id/workflow-map/impact']).toBe('read');
    expect(classes['GET /api/v1/workflow-migrations/:id']).toBe('read');
    // Imports (M1-086): administration, reads of progress and reports included.
    expect(classes['POST /api/v1/admin/imports']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports/:id']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports/:id/report']).toBe('admin');
    expect(classes['POST /api/v1/admin/imports/:id/cancel']).toBe('admin');
    // The SCIM service answers only its own scope, whatever the method (ADR-038).
    expect(classes['GET /api/v1/scim/v2/Users']).toBe('scim');
    expect(classes['PATCH /api/v1/scim/v2/Groups/:id']).toBe('scim');
    expect(classes['GET /api/v1/scim/v2/ServiceProviderConfig']).toBe('scim');
    // Every route that only site administrators may use is in the admin class.
    const adminOnly = api.filter((r) =>
      /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/(users|groups|roles|access-policies|global-grants|admin|service-accounts|security|identity-providers|directories|audit)/.test(
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
