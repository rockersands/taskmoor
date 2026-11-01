/**
 * What an API token may reach (IAM-007, ADR-035). Every request made with a token is checked
 * here before any handler runs, by the route it matched:
 *
 * - public routes (setup, sign-in and its second factor, single sign-on, password links) need
 *   no credential, so no scope applies;
 * - session-only routes need a person at a browser: their own tokens, password, second factors
 *   and sessions.
 *   A token can never mint, rotate or list tokens, so a leaked one cannot extend itself;
 * - administration routes (people, groups, roles, policies, grants, service accounts, tokens of
 *   others, sign-in security, identity providers, LDAP and Active Directory directories, the
 *   audit log, instance status, webhooks) need the admin scope, whatever the method;
 * - everything else needs read for GET and HEAD and write for other methods, except the
 *   POST routes that only read (a search too long for a URL, M1-037). That includes
 *   track configuration (track categories, hierarchy levels, ticket types, type sets):
 *   everyone reads the levels and a track's ticket types, and a local-mode track's
 *   administrators change the types and type set it owns with a write token; shared ones need
 *   configuration administrators, whose rights only the admin scope keeps (below).
 *
 * - the SCIM service (`/api/v1/scim/v2`, IAM-006, ADR-038) needs the scim scope, which a
 *   service account's token holds alone: it reaches SCIM and nothing else, and no other token,
 *   nor a browser session, reaches SCIM.
 *
 * The scope only narrows: authorization still runs through `request.authz` as the token's
 * owner, and a token without the admin scope also loses the owner's administrator rights there,
 * so an administration route missing from this list is still refused.
 */
export const API_TOKEN_SCOPES = ['read', 'write', 'admin', 'scim'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/setup',
  'POST /api/v1/setup',
  'POST /api/v1/session',
  'POST /api/v1/password-links/inspect',
  'POST /api/v1/password-links/redeem',
  'POST /api/v1/password-check',
  'POST /api/v1/session/second-factor',
  'POST /api/v1/session/second-factor/webauthn',
  'POST /api/v1/session/enroll/totp',
  'POST /api/v1/session/enroll/totp/confirm',
  'GET /api/v1/auth/providers',
  // What a frontend reads before it shows anything (M1-106): versions, sign-in, identity.
  'GET /api/meta',
  'POST /api/v1/auth/discover',
  'GET /api/v1/auth/oidc/:id/start',
  'GET /api/v1/auth/oidc/callback',
  'GET /api/v1/auth/saml/:id/metadata',
  'GET /api/v1/auth/saml/:id/start',
  'POST /api/v1/auth/saml/:id/acs',
  'GET /api/v1/auth/saml/continue',
  // A one-click unsubscribe link from a notification email (M1-057): its token is the proof.
  'GET /api/v1/unsubscribe',
  'POST /api/v1/unsubscribe',
  // OAuth for frontends on another site (M1-107): the code, verifier or token is the proof.
  'GET /api/v1/oauth/authorize',
  'POST /api/v1/oauth/token',
  'POST /api/v1/oauth/revoke',
  // MCP clients register themselves (M1-072): RFC 7591's open registration.
  'POST /api/v1/oauth/register',
]);

export const SESSION_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'DELETE /api/v1/session',
  'GET /api/v1/sessions',
  'DELETE /api/v1/sessions/others',
  'DELETE /api/v1/sessions/:id',
  'PUT /api/v1/account/password',
  'GET /api/v1/account/tokens',
  'POST /api/v1/account/tokens',
  'DELETE /api/v1/account/tokens/:id',
  'POST /api/v1/account/tokens/:id/rotate',
  'GET /api/v1/account/two-factor',
  'POST /api/v1/account/two-factor/recovery-codes',
  'POST /api/v1/account/two-factor/totp',
  'POST /api/v1/account/two-factor/totp/confirm',
  'POST /api/v1/account/two-factor/totp/disable',
  'POST /api/v1/account/two-factor/webauthn',
  'POST /api/v1/account/two-factor/webauthn/:id/remove',
  'POST /api/v1/account/two-factor/webauthn/options',
  // Approving an OAuth client is a person's answer at their browser (M1-072).
  'GET /api/v1/oauth/requests/:id',
  'POST /api/v1/oauth/requests/:id',
  // Reading the AI data-egress notice is a person's own answer at their browser (M1-077).
  'POST /api/v1/ai/notice',
]);

/** Routes other than GET that change nothing anyone else sees: a read token reaches them. */
export const READ_ONLY_ROUTES: ReadonlySet<string> = new Set([
  'POST /api/v1/search',
  // Which shown tickets format rules match (M1-049): a read.
  'POST /api/v1/search/format-rules',
  // Tickets similar to a text being written (M1-078): a read, with the text in the body.
  'POST /api/v1/tickets/similar',
  // The AI features (M1-079): each answers text or proposals and changes no ticket; drafts and
  // breakdowns are created afterwards through the ticket routes, which need write.
  'POST /api/v1/tickets/:id/ai/summary',
  'POST /api/v1/ai/query',
  'POST /api/v1/ai/drafts',
  'POST /api/v1/tickets/:id/ai/breakdown',
  // The MCP server (M1-072): its read tools need only read; its other tools call the REST API
  // with the same token, where write routes still need write.
  'POST /api/v1/mcp',
  // Ending the caller's own MCP session, so a read-only client can close what it opened.
  'DELETE /api/v1/mcp',
]);

/** Paths under these (the path itself or below it) are administration. */
export const ADMIN_ROUTE_PREFIXES: readonly string[] = [
  '/api/v1/admin',
  '/api/v1/users',
  '/api/v1/groups',
  '/api/v1/roles',
  '/api/v1/access-policies',
  '/api/v1/visibility-policies',
  '/api/v1/global-grants',
  '/api/v1/service-accounts',
  '/api/v1/permissions/explain',
  '/api/v1/security',
  '/api/v1/identity-providers',
  '/api/v1/directories',
  '/api/v1/audit',
  // Webhooks send the instance's data to another host (M1-067).
  '/api/v1/webhooks',
];

const USER_PROPERTY_ROUTES: ReadonlySet<string> = new Set([
  '/api/v1/users/:id/properties',
  '/api/v1/users/:id/properties/:key',
]);

/** The SCIM service: identity providers provision people and groups here (IAM-006). */
export const SCIM_ROUTE_PREFIX = '/api/v1/scim/v2';

/** Scopes that go together; `scim` is held alone. */
export function scopesConflict(scopes: readonly ApiTokenScope[]): boolean {
  return scopes.includes('scim') && scopes.length > 1;
}

export type RouteAccess = 'public' | 'session' | ApiTokenScope;

/** What a token needs for a route, given as the method and the route's path pattern. */
export function routeAccess(method: string, routeUrl: string): RouteAccess {
  const key = `${method.toUpperCase()} ${routeUrl}`;
  if (routeUrl === SCIM_ROUTE_PREFIX || routeUrl.startsWith(`${SCIM_ROUTE_PREFIX}/`)) {
    return 'scim';
  }
  if (PUBLIC_ROUTES.has(key)) return 'public';
  if (SESSION_ONLY_ROUTES.has(key)) return 'session';
  // A person's own properties (M1-129) are data, not administration: the route checks that
  // only the person or a site administrator reaches them.
  if (
    !USER_PROPERTY_ROUTES.has(routeUrl) &&
    ADMIN_ROUTE_PREFIXES.some((p) => routeUrl === p || routeUrl.startsWith(`${p}/`))
  ) {
    return 'admin';
  }
  if (READ_ONLY_ROUTES.has(key)) return 'read';
  return ['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase()) ? 'read' : 'write';
}

export type ScopeDenial =
  | { error: 'session_required' }
  | { error: 'insufficient_scope'; requiredScope: ApiTokenScope };

/** Null when a token with these scopes may call the route; the 403 body otherwise. */
export function scopeDenial(
  method: string,
  routeUrl: string | undefined,
  scopes: readonly ApiTokenScope[],
): ScopeDenial | null {
  // No route matched: the not-found handler answers, and it reveals nothing.
  if (routeUrl === undefined) return null;
  const access = routeAccess(method, routeUrl);
  if (access === 'public') return null;
  if (access === 'session') return { error: 'session_required' };
  return scopes.includes(access) ? null : { error: 'insufficient_scope', requiredScope: access };
}

export function isApiTokenScope(value: string): value is ApiTokenScope {
  return (API_TOKEN_SCOPES as readonly string[]).includes(value);
}

/** Scopes in their canonical order, without repeats. */
export function normalizeScopes(scopes: readonly ApiTokenScope[]): ApiTokenScope[] {
  return API_TOKEN_SCOPES.filter((s) => scopes.includes(s));
}
