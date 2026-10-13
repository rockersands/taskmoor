/**
 * What an API token may reach (IAM-007, ADR-034). Every request made with a token is checked
 * here before any handler runs, by the route it matched:
 *
 * - public routes (setup, sign-in, password links) need no credential, so no scope applies;
 * - session-only routes need a person at a browser: their own tokens, password and sessions.
 *   A token can never mint, rotate or list tokens, so a leaked one cannot extend itself;
 * - administration routes (people, groups, roles, policies, grants, service accounts, tokens of
 *   others, instance status) need the admin scope, whatever the method;
 * - everything else needs read for GET and HEAD and write for other methods.
 *
 * The scope only narrows: authorization still runs through `request.authz` as the token's
 * owner, and a token without the admin scope also loses the owner's administrator rights there,
 * so an administration route missing from this list is still refused.
 */
export const API_TOKEN_SCOPES = ['read', 'write', 'admin'] as const;
export type ApiTokenScope = (typeof API_TOKEN_SCOPES)[number];

export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/setup',
  'POST /api/v1/setup',
  'POST /api/v1/session',
  'POST /api/v1/password-links/inspect',
  'POST /api/v1/password-links/redeem',
  'POST /api/v1/password-check',
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
]);

/** Paths under these (the path itself or below it) are administration. */
export const ADMIN_ROUTE_PREFIXES: readonly string[] = [
  '/api/v1/admin',
  '/api/v1/users',
  '/api/v1/groups',
  '/api/v1/roles',
  '/api/v1/access-policies',
  '/api/v1/global-grants',
  '/api/v1/service-accounts',
  '/api/v1/permissions/explain',
];

export type RouteAccess = 'public' | 'session' | ApiTokenScope;

/** What a token needs for a route, given as the method and the route's path pattern. */
export function routeAccess(method: string, routeUrl: string): RouteAccess {
  const key = `${method.toUpperCase()} ${routeUrl}`;
  if (PUBLIC_ROUTES.has(key)) return 'public';
  if (SESSION_ONLY_ROUTES.has(key)) return 'session';
  if (ADMIN_ROUTE_PREFIXES.some((p) => routeUrl === p || routeUrl.startsWith(`${p}/`))) {
    return 'admin';
  }
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
