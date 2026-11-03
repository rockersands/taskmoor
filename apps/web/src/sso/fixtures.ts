import type { GroupSummary } from '../admin/SecurityPage';
import { ApiError } from '../api/client';
import type {
  Discovery,
  IdentityProvider,
  IdentityProvidersClient,
  OidcProviderInput,
  ProviderInput,
  SamlCertificate,
  SamlProvider,
  SamlProviderInput,
  SignInSsoClient,
  SsoProviderSummary,
} from './client';

/** Synthetic providers and groups for stories (M1-080); every name and domain is made up. */
export const STAFF: SsoProviderSummary = { id: 1, name: 'Staff accounts' };
export const PARTNERS: SsoProviderSummary = { id: 2, name: 'Partners' };
export const UMBRELLA: SsoProviderSummary = { id: 3, name: 'Umbrella' };
export const CONTRACTORS: SsoProviderSummary = { id: 4, name: 'Contractors', protocol: 'saml' };

export const GROUPS: GroupSummary[] = [
  { id: 3, name: 'Finance' },
  { id: 7, name: 'Platform team' },
  { id: 9, name: 'Support' },
];

export const REDIRECT_URI = 'https://tasks.example/api/v1/auth/oidc/callback';

/** A made-up certificate: its text is a placeholder, only the summary is shown. */
export const CERTIFICATE: SamlCertificate = {
  fingerprint:
    '3F:A2:7C:19:88:0B:D4:5E:61:2A:9F:C3:07:B8:44:E2:5D:16:AA:93:0C:7E:F1:28:B5:69:D0:3A:84:1F:E6:57',
  subject: 'CN=id.contractors.example',
  notAfter: '2028-03-31T00:00:00.000Z',
  pem: '-----BEGIN CERTIFICATE-----\nMIIC...placeholder...\n-----END CERTIFICATE-----',
};

/** Where a SAML provider reaches Taskmoor, as the backend builds it from the public URL. */
export function serviceProviderOf(id: number, spEntityId: string | null = null) {
  const root = `https://tasks.example/api/v1/auth/saml/${id}`;
  return {
    spEntityId: spEntityId ?? `${root}/metadata`,
    acsUrl: `${root}/acs`,
    metadataUrl: `${root}/metadata`,
  };
}

export const SAML_PROVIDER: SamlProvider = {
  id: CONTRACTORS.id,
  name: CONTRACTORS.name,
  protocol: 'saml',
  entityId: 'https://id.contractors.example/saml',
  ssoUrl: 'https://id.contractors.example/saml/sso',
  certificates: [CERTIFICATE],
  spEntityId: null,
  emailAttribute: null,
  idpInitiated: false,
  serviceProvider: serviceProviderOf(CONTRACTORS.id),
  groupClaim: 'memberOf',
  domains: ['contractors.example'],
  enforceSso: false,
  jit: true,
  enabled: true,
  groupMap: [{ claimValue: 'support', groupId: 9 }],
};

/** A provider made with the Google choice (IAM-031). */
export const GOOGLE_PROVIDER: IdentityProvider = {
  id: 8,
  name: 'Google',
  issuer: 'https://accounts.google.com',
  clientId: 'an-operators-own-client',
  hasClientSecret: true,
  scopes: 'openid email profile',
  groupClaim: null,
  domains: ['gmail.com'],
  enforceSso: false,
  jit: false,
  enabled: true,
  groupMap: [],
};

export const PROVIDERS: IdentityProvider[] = [
  {
    id: STAFF.id,
    name: STAFF.name,
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
    id: PARTNERS.id,
    name: PARTNERS.name,
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
  SAML_PROVIDER,
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

/** What the backend would keep of a SAML provider; pasted metadata stands for a made-up one. */
function samlView(id: number, input: SamlProviderInput): SamlProvider {
  const pasted = input.metadataXml
    ? { entityId: 'https://id.pasted.example/saml', ssoUrl: 'https://id.pasted.example/sso' }
    : null;
  return {
    id,
    name: input.name,
    protocol: 'saml',
    entityId: input.entityId ?? pasted?.entityId ?? '',
    ssoUrl: input.ssoUrl ?? pasted?.ssoUrl ?? '',
    certificates: (input.certificates ?? [CERTIFICATE.pem]).map((pem) => ({ ...CERTIFICATE, pem })),
    spEntityId: input.spEntityId,
    emailAttribute: input.emailAttribute,
    idpInitiated: input.idpInitiated,
    serviceProvider: serviceProviderOf(id, input.spEntityId),
    groupClaim: input.groupClaim,
    domains: input.domains,
    enforceSso: input.enforceSso,
    jit: input.jit,
    enabled: input.enabled,
    groupMap: input.groupMap,
  };
}

function samlInputOf(provider: SamlProvider): SamlProviderInput {
  return {
    name: provider.name,
    entityId: provider.entityId,
    ssoUrl: provider.ssoUrl,
    certificates: provider.certificates.map((c) => c.pem),
    spEntityId: provider.spEntityId,
    emailAttribute: provider.emailAttribute,
    idpInitiated: provider.idpInitiated,
    groupClaim: provider.groupClaim,
    domains: provider.domains,
    enforceSso: provider.enforceSso,
    jit: provider.jit,
    enabled: provider.enabled,
    groupMap: provider.groupMap,
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
      const id = nextId++;
      let created: IdentityProvider;
      if ('protocol' in input && input.protocol === 'saml') {
        created = samlView(id, input);
      } else {
        const { clientSecret, ...rest } = input as OidcProviderInput;
        created = { ...rest, id, hasClientSecret: Boolean(clientSecret) };
      }
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
      let next: IdentityProvider;
      if (current.protocol === 'saml') {
        next = samlView(id, {
          ...samlInputOf(current),
          ...(changes as Partial<SamlProviderInput>),
        });
      } else {
        const { clientSecret, ...rest } = changes as Partial<OidcProviderInput>;
        next = {
          ...current,
          ...rest,
          hasClientSecret: current.hasClientSecret || Boolean(clientSecret),
        };
      }
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
