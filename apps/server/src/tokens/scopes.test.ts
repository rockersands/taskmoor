import { useMigratedDatabase } from '@taskmoor/db/testing';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app';
import { bearerToken } from './api-tokens';
import {
  ADMIN_ROUTE_PREFIXES,
  PUBLIC_ROUTES,
  READ_ONLY_ROUTES,
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
    const missing = [...PUBLIC_ROUTES, ...SESSION_ONLY_ROUTES, ...READ_ONLY_ROUTES].filter(
      (r) => !api.includes(r),
    );
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
    expect(classes['PUT /api/v1/account/tutorial/:section']).toBe('session');
    expect(classes['POST /api/v1/session']).toBe('public');
    expect(classes['POST /api/v1/session/second-factor']).toBe('public');
    expect(classes['GET /api/v1/auth/oidc/callback']).toBe('public');
    expect(classes['POST /api/v1/auth/saml/:id/acs']).toBe('public');
    expect(classes['GET /api/v1/auth/saml/continue']).toBe('public');
    expect(classes['GET /api/v1/auth/saml/:id/metadata']).toBe('public');
    expect(classes['POST /api/v1/account/two-factor/totp/disable']).toBe('session');
    expect(classes['PUT /api/v1/security/two-factor']).toBe('admin');
    // The security alert rules (ADR-109).
    expect(classes['GET /api/v1/security/alerts']).toBe('admin');
    expect(classes['PUT /api/v1/security/alerts']).toBe('admin');
    expect(classes['GET /api/v1/audit/export']).toBe('admin');
    expect(classes['PATCH /api/v1/identity-providers/:id']).toBe('admin');
    // LDAP and Active Directory administration (M1-082), reads included.
    expect(classes['GET /api/v1/directories']).toBe('admin');
    expect(classes['POST /api/v1/directories/:id/sync']).toBe('admin');
    expect(classes['POST /api/v1/directories/test']).toBe('admin');
    expect(classes['POST /api/v1/tracks']).toBe('write');
    // Ticket templates (ADR-113): track configuration and ticket creation, read and write.
    expect(classes['GET /api/v1/ticket-templates']).toBe('read');
    expect(classes['GET /api/v1/ticket-templates/:id']).toBe('read');
    expect(classes['POST /api/v1/ticket-templates']).toBe('write');
    expect(classes['PATCH /api/v1/ticket-templates/:id']).toBe('write');
    expect(classes['DELETE /api/v1/ticket-templates/:id']).toBe('write');
    expect(classes['POST /api/v1/ticket-templates/:id/tickets']).toBe('write');
    // Searching (M1-037): POST carries long queries and changes nothing; explain is admin.
    expect(classes['GET /api/v1/search']).toBe('read');
    expect(classes['POST /api/v1/search']).toBe('read');
    expect(classes['GET /api/v1/admin/search/explain']).toBe('admin');
    // Similar tickets (M1-078): both reads, the text being written in a POST body.
    expect(classes['GET /api/v1/tickets/:id/similar']).toBe('read');
    expect(classes['POST /api/v1/tickets/similar']).toBe('read');
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
    // Layout sets (CORE-013): track configuration, read and write; the layout editor's preview
    // of a draft is a read, its save a write (UI-T15).
    expect(classes['GET /api/v1/layout-sets']).toBe('read');
    expect(classes['PATCH /api/v1/layout-sets/:id']).toBe('write');
    expect(classes['POST /api/v1/layout-sets/:id/preview']).toBe('read');
    expect(classes['GET /api/v1/tracks/:id/workflow-map/impact']).toBe('read');
    expect(classes['GET /api/v1/workflow-migrations/:id']).toBe('read');
    // Imports (M1-086): administration, reads of progress and reports included.
    expect(classes['POST /api/v1/admin/imports']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports/:id']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports/:id/report']).toBe('admin');
    expect(classes['POST /api/v1/admin/imports/:id/cancel']).toBe('admin');
    expect(classes['GET /api/v1/admin/imports/:id/records']).toBe('admin');
    // Personal track groups (CORE-034): read and write. Sharing one gives roles only where the
    // person could give them track by track, which is a write there too (IAM-034).
    expect(classes['GET /api/v1/track-groups']).toBe('read');
    expect(classes['GET /api/v1/track-groups/people']).toBe('read');
    expect(classes['GET /api/v1/track-groups/:id/shares']).toBe('read');
    expect(classes['POST /api/v1/track-groups']).toBe('write');
    expect(classes['PATCH /api/v1/track-groups/:id']).toBe('write');
    expect(classes['PUT /api/v1/track-groups/order']).toBe('write');
    expect(classes['PUT /api/v1/track-groups/:id/tracks/:trackId']).toBe('write');
    expect(classes['POST /api/v1/track-groups/:id/shares']).toBe('write');
    expect(classes['DELETE /api/v1/track-groups/:id/shares/:userId']).toBe('write');
    // Leaving a group shared with one takes back what it gave, as a write (T-204).
    expect(classes['POST /api/v1/track-groups/:id/leave']).toBe('write');
    expect(classes['POST /api/v1/track-groups/:id/copies']).toBe('write');
    // The SCIM service answers only its own scope, whatever the method (ADR-038).
    expect(classes['GET /api/v1/scim/v2/Users']).toBe('scim');
    expect(classes['PATCH /api/v1/scim/v2/Groups/:id']).toBe('scim');
    expect(classes['GET /api/v1/scim/v2/ServiceProviderConfig']).toBe('scim');
    // Every route that only site administrators may use is in the admin class.
    // A person's own properties (M1-129) are data: read and write, the route checks who.
    expect(classes['GET /api/v1/users/:id/properties']).toBe('read');
    expect(classes['PUT /api/v1/users/:id/properties/:key']).toBe('write');
    expect(classes['DELETE /api/v1/users/:id/properties/:key']).toBe('write');
    // OAuth for MCP clients (M1-072): registration is open, consent takes the person's browser.
    expect(classes['POST /api/v1/oauth/register']).toBe('public');
    expect(classes['POST /api/v1/oauth/requests/:id']).toBe('session');
    expect(classes['GET /api/v1/admin/oauth-clients']).toBe('admin');
    // Registered frontend origins (M1-108).
    expect(classes['GET /api/v1/admin/frontends']).toBe('admin');
    expect(classes['POST /api/v1/admin/frontends']).toBe('admin');
    expect(classes['PATCH /api/v1/admin/frontends/:id']).toBe('admin');
    expect(classes['DELETE /api/v1/admin/frontends/:id']).toBe('admin');
    // The new-version notice (OPS-026).
    expect(classes['GET /api/v1/admin/update-check']).toBe('admin');
    expect(classes['PUT /api/v1/admin/update-check']).toBe('admin');
    // AI provider settings and write-only credentials (M1-075).
    expect(classes['GET /api/v1/admin/ai']).toBe('admin');
    expect(classes['PUT /api/v1/admin/ai/credentials/:slot']).toBe('admin');
    expect(classes['DELETE /api/v1/admin/ai/credentials/:slot']).toBe('admin');
    // The AI settings page (M1-076); which features someone may use is a read for anyone.
    expect(classes['PUT /api/v1/admin/ai']).toBe('admin');
    expect(classes['PUT /api/v1/admin/ai/tracks/:id']).toBe('admin');
    expect(classes['POST /api/v1/admin/ai/test']).toBe('admin');
    expect(classes['GET /api/v1/ai/features']).toBe('read');
    // The AI features (M1-079): answers and proposals only, so a read token reaches them.
    expect(classes['POST /api/v1/tickets/:id/ai/summary']).toBe('read');
    expect(classes['POST /api/v1/ai/query']).toBe('read');
    expect(classes['POST /api/v1/ai/drafts']).toBe('read');
    expect(classes['POST /api/v1/tickets/:id/ai/breakdown']).toBe('read');
    // Multi-track plans (ADR-122): reads and writes like dashboards.
    expect(classes['GET /api/v1/plans']).toBe('read');
    expect(classes['POST /api/v1/plans']).toBe('write');
    expect(classes['GET /api/v1/plans/:id']).toBe('read');
    expect(classes['PATCH /api/v1/plans/:id']).toBe('write');
    expect(classes['DELETE /api/v1/plans/:id']).toBe('write');
    expect(classes['GET /api/v1/plans/:id/choices']).toBe('read');
    expect(classes['GET /api/v1/plans/:id/summary']).toBe('read');
    expect(classes['GET /api/v1/plans/:id/timeline']).toBe('read');
    expect(classes['GET /api/v1/plans/:id/calendar']).toBe('read');
    // Teams and capacity (PLN-005, PLN-009): the view reads, setting capacity writes.
    expect(classes['GET /api/v1/plans/:id/capacity']).toBe('read');
    expect(classes['PUT /api/v1/plans/:id/capacity']).toBe('write');
    const adminOnly = api.filter(
      (r) =>
        /^(GET|POST|PUT|PATCH|DELETE) \/api\/v1\/(users|groups|roles|access-policies|global-grants|admin|service-accounts|security|identity-providers|directories|audit)/.test(
          r,
        ) && !r.includes('/properties'),
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
    // A read-only MCP client may end the session it opened (M1-072).
    expect(scopeDenial('DELETE', '/api/v1/mcp', ['read'])).toBeNull();
  });

  it('[IAM-007] reads only the Bearer scheme of the Authorization header', () => {
    expect(bearerToken('Bearer tmk_abc')).toBe('tmk_abc');
    expect(bearerToken('bearer   tmk_abc  ')).toBe('tmk_abc');
    expect(bearerToken('Basic dXNlcjpwYXNz')).toBeUndefined();
    expect(bearerToken('Bearer a b')).toBeUndefined();
    expect(bearerToken(undefined)).toBeUndefined();
  });
});
