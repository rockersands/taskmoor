import type { GroupSummary } from '../admin/SecurityPage';
import { ApiError } from '../api/client';
import type {
  Discovery,
  IdentityProvider,
  IdentityProvidersClient,
  ProviderInput,
  SignInSsoClient,
  SsoProviderSummary,
} from './client';

/** Synthetic providers and groups for stories (M1-080); every name and domain is made up. */
export const STAFF: SsoProviderSummary = { id: 1, name: 'Staff accounts' };
export const PARTNERS: SsoProviderSummary = { id: 2, name: 'Partners' };
export const UMBRELLA: SsoProviderSummary = { id: 3, name: 'Umbrella' };

export const GROUPS: GroupSummary[] = [
  { id: 3, name: 'Finance' },
  { id: 7, name: 'Platform team' },
  { id: 9, name: 'Support' },
];

export const REDIRECT_URI = 'https://tasks.example/api/v1/auth/oidc/callback';

export const PROVIDERS: IdentityProvider[] = [
  {
    ...STAFF,
    issuer: 'https://id.example/realms/staff',
    clientId: 'taskmoor',
    hasClientSecret: true,
    scopes: 'openid email profile',
    groupClaim: 'groups',
    domains: ['corp.example', 'corp.example.org'],
    enforceSso: true,
    jit: true,
    enabled: true,
    groupMap: [
      { claimValue: 'finance', groupId: 3 },
      { claimValue: 'platform', groupId: 7 },
    ],
  },
  {
    ...PARTNERS,
    issuer: 'https://partners.example',
    clientId: 'tm-partners',
    hasClientSecret: false,
    scopes: 'openid email',
    groupClaim: null,
    domains: [],
    enforceSso: false,
    jit: false,
    enabled: false,
    groupMap: [],
  },
];

/**
 * The sign-in page's endpoints: the given providers, and per domain which methods it uses.
 * Going to a provider does nothing, so a story stays on the page.
 */
export function fakeSignInSso(
  providers: SsoProviderSummary[] = [],
  domains: Record<string, Discovery> = {},
): SignInSsoClient {
  return {
    providers: async () => providers,
    discover: async (email) =>
      domains[email.split('@')[1] ?? ''] ?? { provider: null, password: true },
    go: () => {},
  };
}

/** An in-memory provider store, so adding, editing and deleting behave like the real page. */
export function fakeIdentityProvidersClient(
  initial: IdentityProvider[] = PROVIDERS,
  overrides: Partial<IdentityProvidersClient> = {},
): IdentityProvidersClient {
  let providers = initial.map((p) => ({ ...p }));
  let nextId = 100;
  const taken = (domains: string[], except?: number) =>
    domains.filter((d) =>
      providers.some((p) => p.id !== except && p.enabled && p.domains.includes(d)),
    );
  return {
    list: async () => ({ providers: [...providers], redirectUri: REDIRECT_URI }),
    create: async (input: ProviderInput) => {
      const clash = taken(input.domains);
      if (clash.length > 0) throw new ApiError(409, { error: 'domain_taken', domains: clash });
      const { clientSecret, ...rest } = input;
      const created = { ...rest, id: nextId++, hasClientSecret: Boolean(clientSecret) };
      providers = [...providers, created];
      return created;
    },
    update: async (id, changes) => {
      const current = providers.find((p) => p.id === id);
      if (!current) throw new ApiError(404, { error: 'not_found' });
      const clash = taken(changes.domains ?? current.domains, id);
      if ((changes.enabled ?? current.enabled) && clash.length > 0) {
        throw new ApiError(409, { error: 'domain_taken', domains: clash });
      }
      const { clientSecret, ...rest } = changes;
      const next = {
        ...current,
        ...rest,
        hasClientSecret: current.hasClientSecret || Boolean(clientSecret),
      };
      providers = providers.map((p) => (p.id === id ? next : p));
      return next;
    },
    remove: async (id) => {
      providers = providers.filter((p) => p.id !== id);
    },
    groups: async () => GROUPS,
    ...overrides,
  };
}
