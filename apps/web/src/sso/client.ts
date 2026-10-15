import type { GroupSummary } from '../admin/SecurityPage';
import { API_BASE, api } from '../api/client';

/** A provider the sign-in page offers (M1-080, IAM-003): enabled ones only. */
export interface SsoProviderSummary {
  id: number;
  name: string;
}

/** Which sign-in methods an email's domain uses; the backend decides by the domain alone. */
export interface Discovery {
  provider: SsoProviderSummary | null;
  /** False where the domain's provider enforces single sign-on (IAM-004). */
  password: boolean;
}

/** What the sign-in page asks the backend about single sign-on. */
export interface SignInSsoClient {
  providers: () => Promise<SsoProviderSummary[]>;
  discover: (email: string) => Promise<Discovery>;
  /** Leaves the app for the provider's sign-in page. */
  go: (url: string) => void;
}

export const signInSsoClient: SignInSsoClient = {
  providers: async () =>
    (await api<{ providers: SsoProviderSummary[] }>('/auth/providers')).providers,
  discover: (email) => api<Discovery>('/auth/discover', { method: 'POST', body: { email } }),
  go: (url) => window.location.assign(url),
};

/** The longest return address the backend accepts. */
const RETURN_TO_MAX = 500;

/**
 * Where the browser comes back after signing in at the provider: the page the person was on
 * (`/#/settings`), or the start page when they were on the sign-in page itself.
 */
export function returnTo(hash: string): string {
  const route = hash.replace(/^#/, '');
  if (!route.startsWith('/') || route === '/' || /^\/sign-in(?:[?/]|$)/.test(route)) return '/';
  const address = `/#${route}`;
  return address.length > RETURN_TO_MAX ? '/' : address;
}

/** The backend address that starts a sign-in with a provider. */
export function startUrl(providerId: number, back: string): string {
  return `${API_BASE}/auth/oidc/${providerId}/start?returnTo=${encodeURIComponent(back)}`;
}

/** A parameter of the hash route's query (`#/sign-in?sso_error=no_account`). */
export function hashParam(hash: string, name: string): string | null {
  const query = hash.split('?')[1];
  return query ? new URLSearchParams(query).get(name) : null;
}

/** The hash without one query parameter, keeping the route and any other parameters. */
export function withoutHashParam(hash: string, name: string): string {
  const [route = '', query] = hash.split('?');
  if (query === undefined) return route;
  const params = new URLSearchParams(query);
  params.delete(name);
  const rest = params.toString();
  return rest ? `${route}?${rest}` : route;
}

/** The backend's rule: a host name with a top-level domain, never the reserved `.invalid`. */
const DOMAIN = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A typed domain as the backend stores it (lower case, no `@`), or null when it is not one. */
export function normalizeDomain(input: string): string | null {
  const domain = input.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
  if (!DOMAIN.test(domain) || domain.endsWith('.invalid')) return null;
  return domain;
}

/** Maps a value of the provider's group claim to a Taskmoor group. */
export interface GroupMapping {
  claimValue: string;
  groupId: number;
}

/** An identity provider as administrators see it; the client secret is never returned. */
export interface IdentityProvider {
  id: number;
  name: string;
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
  groupClaim: string | null;
  domains: string[];
  enforceSso: boolean;
  jit: boolean;
  enabled: boolean;
  groupMap: GroupMapping[];
}

/** What creating or editing a provider sends; an edit names only what changed. */
export interface ProviderInput {
  name: string;
  issuer: string;
  clientId: string;
  /** Write-only: left out, the saved secret stays. */
  clientSecret?: string;
  scopes: string;
  groupClaim: string | null;
  domains: string[];
  enforceSso: boolean;
  jit: boolean;
  enabled: boolean;
  groupMap: GroupMapping[];
}

/** The providers, and the backend's callback address that administrators register at each. */
export interface ProviderList {
  providers: IdentityProvider[];
  redirectUri: string;
}

/** Identity providers (`/api/v1/identity-providers`, site administrators only). */
export interface IdentityProvidersClient {
  list: () => Promise<ProviderList>;
  create: (input: ProviderInput) => Promise<IdentityProvider>;
  update: (id: number, changes: Partial<ProviderInput>) => Promise<IdentityProvider>;
  remove: (id: number) => Promise<void>;
  /** The groups a claim value can map to. */
  groups: () => Promise<GroupSummary[]>;
}

export const identityProvidersClient: IdentityProvidersClient = {
  list: () => api<ProviderList>('/identity-providers'),
  create: async (input) =>
    (
      await api<{ provider: IdentityProvider }>('/identity-providers', {
        method: 'POST',
        body: input,
      })
    ).provider,
  update: async (id, changes) =>
    (
      await api<{ provider: IdentityProvider }>(`/identity-providers/${id}`, {
        method: 'PATCH',
        body: changes,
      })
    ).provider,
  remove: async (id) => {
    await api<null>(`/identity-providers/${id}`, { method: 'DELETE' });
  },
  groups: async () =>
    (await api<{ groups: GroupSummary[] }>('/groups')).groups.map(({ id, name }) => ({
      id,
      name,
    })),
};
