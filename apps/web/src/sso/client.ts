import type { GroupSummary } from '../admin/SecurityPage';
import { API_BASE, api } from '../api/client';
import { runtimeConfig } from '../runtime/config';

/** The protocol a provider speaks: OpenID Connect (M1-080) or SAML 2.0 (M1-081). */
export type SsoProtocol = 'oidc' | 'saml';

/** A provider the sign-in page offers (M1-080, IAM-003): enabled ones only. */
export interface SsoProviderSummary {
  id: number;
  name: string;
  /** Which start address it uses; OpenID Connect when absent. */
  protocol?: SsoProtocol;
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
 * Where the sign-in page goes once someone is signed in, when a frontend on another site sent
 * the person here to approve its sign-in (M1-107): the backend's authorization, nowhere else.
 */
export function continuation(hash: string): string | null {
  const next = hashParam(hash, 'continue');
  return next !== null &&
    next.length <= RETURN_TO_MAX &&
    /^\/api\/v1\/oauth\/authorize\?[^#\s\\]*$/.test(next)
    ? next
    : null;
}

/**
 * The app's own address when its backend is another origin of the same site (sibling
 * subdomains, M1-107), so single sign-on comes back to the app rather than to the backend's
 * pages; empty when the backend serves this page's origin.
 */
export function appBase(): string {
  if (!runtimeConfig.apiUrl || typeof window === 'undefined') return '';
  const here = window.location.origin;
  return new URL(runtimeConfig.apiUrl).origin === here ? '' : `${here}${runtimeConfig.basePath}`;
}

/**
 * Where the browser comes back after signing in at the provider: the page the person was on
 * (`/#/settings`), the start page when they were on the sign-in page itself, or the
 * authorization a frontend on another site is waiting for. `base` is the app's own address
 * when the backend lives on another origin (`appBase`).
 */
export function returnTo(hash: string, base = ''): string {
  const route = hash.replace(/^#/, '');
  if (/^\/sign-in(?:[?/]|$)/.test(route)) {
    const next = continuation(hash);
    if (next) return next;
  }
  const start = base || '/';
  if (!route.startsWith('/') || route === '/' || /^\/sign-in(?:[?/]|$)/.test(route)) return start;
  const address = `${start}#${route}`;
  return address.length > RETURN_TO_MAX ? start : address;
}

/** The backend address that starts a sign-in with a provider, by its protocol. */
export function startUrl(provider: SsoProviderSummary, back: string): string {
  const protocol = provider.protocol === 'saml' ? 'saml' : 'oidc';
  return `${API_BASE}/auth/${protocol}/${provider.id}/start?returnTo=${encodeURIComponent(back)}`;
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

/** What every provider has, whatever its protocol. */
interface ProviderCommon {
  id: number;
  name: string;
  /** The claim (OpenID Connect) or attribute (SAML) that lists the person's groups. */
  groupClaim: string | null;
  domains: string[];
  enforceSso: boolean;
  jit: boolean;
  enabled: boolean;
  groupMap: GroupMapping[];
}

/** An OpenID Connect provider as administrators see it; the client secret is never returned. */
export interface OidcProvider extends ProviderCommon {
  protocol?: 'oidc';
  issuer: string;
  clientId: string;
  hasClientSecret: boolean;
  scopes: string;
}

/** A signing certificate of a SAML provider; the summary is null when it cannot be read. */
export interface SamlCertificate {
  fingerprint: string | null;
  subject: string | null;
  notAfter: string | null;
  pem: string;
}

/** Where a SAML provider reaches Taskmoor: what administrators register there. */
export interface SamlServiceProvider {
  spEntityId: string;
  acsUrl: string;
  metadataUrl: string;
}

/** A SAML 2.0 provider (M1-081, IAM-002). */
export interface SamlProvider extends ProviderCommon {
  protocol: 'saml';
  entityId: string;
  ssoUrl: string;
  certificates: SamlCertificate[];
  /** Taskmoor's entity ID when an administrator fixed one; the metadata address otherwise. */
  spEntityId: string | null;
  emailAttribute: string | null;
  idpInitiated: boolean;
  serviceProvider: SamlServiceProvider;
}

export type IdentityProvider = OidcProvider | SamlProvider;

export function isSaml(provider: IdentityProvider): provider is SamlProvider {
  return provider.protocol === 'saml';
}

interface InputCommon {
  name: string;
  groupClaim: string | null;
  domains: string[];
  enforceSso: boolean;
  jit: boolean;
  enabled: boolean;
  groupMap: GroupMapping[];
}

/** What creating or editing an OpenID Connect provider sends; an edit names only what changed. */
export interface OidcProviderInput extends InputCommon {
  issuer: string;
  clientId: string;
  /** Write-only: left out, the saved secret stays. */
  clientSecret?: string;
  scopes: string;
}

/**
 * What creating or editing a SAML provider sends. The metadata fills the entity ID, sign-in
 * address and certificates the input leaves out. `protocol` goes with a new provider only.
 */
export interface SamlProviderInput extends InputCommon {
  protocol?: 'saml';
  metadataXml?: string;
  entityId?: string;
  ssoUrl?: string;
  certificates?: string[];
  spEntityId: string | null;
  emailAttribute: string | null;
  idpInitiated: boolean;
}

export type ProviderInput = OidcProviderInput | SamlProviderInput;

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
