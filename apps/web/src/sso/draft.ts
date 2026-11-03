import {
  type GroupMapping,
  type IdentityProvider,
  isSaml,
  type OidcProvider,
  type OidcProviderInput,
  type ProviderInput,
  type SamlProvider,
  type SamlProviderInput,
  type SsoProtocol,
} from './client';

/** One row of the group map editor; `key` keeps rows apart while they are edited. */
export interface MappingRow {
  key: number;
  claimValue: string;
  groupId: number | null;
}

/**
 * The provider form's values, as typed. One shape for both protocols, so switching the
 * protocol of a new provider keeps what both share.
 */
export interface ProviderDraft {
  protocol: SsoProtocol;
  name: string;
  // OpenID Connect
  issuer: string;
  clientId: string;
  /** Blank keeps the saved secret (or sends none for a new provider). */
  clientSecret: string;
  scopes: string;
  // SAML (M1-081)
  /** Pasted metadata; blank sends none, so the fields below stay as they are. */
  metadataXml: string;
  entityId: string;
  ssoUrl: string;
  /** PEM certificates, one after the other. */
  certificates: string;
  spEntityId: string;
  emailAttribute: string;
  idpInitiated: boolean;
  // Both
  groupClaim: string;
  domains: string[];
  enforceSso: boolean;
  jit: boolean;
  enabled: boolean;
  groupMap: MappingRow[];
}

export const DEFAULT_SCOPES = 'openid email profile';

let nextKey = 1;

export function mappingRow(claimValue = '', groupId: number | null = null): MappingRow {
  return { key: nextKey++, claimValue, groupId };
}

/** A new provider: enabled, creating accounts, enforcing nothing (the backend's defaults). */
export function emptyDraft(protocol: SsoProtocol = 'oidc'): ProviderDraft {
  return {
    protocol,
    name: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    scopes: DEFAULT_SCOPES,
    metadataXml: '',
    entityId: '',
    ssoUrl: '',
    certificates: '',
    spEntityId: '',
    emailAttribute: '',
    idpInitiated: false,
    groupClaim: '',
    domains: [],
    enforceSso: false,
    jit: true,
    enabled: true,
    groupMap: [],
  };
}

export function draftOf(provider: IdentityProvider): ProviderDraft {
  const common = {
    name: provider.name,
    groupClaim: provider.groupClaim ?? '',
    domains: [...provider.domains],
    enforceSso: provider.enforceSso,
    jit: provider.jit,
    enabled: provider.enabled,
    groupMap: provider.groupMap.map((m) => mappingRow(m.claimValue, m.groupId)),
  };
  if (isSaml(provider)) {
    return {
      ...emptyDraft('saml'),
      ...common,
      entityId: provider.entityId,
      ssoUrl: provider.ssoUrl,
      certificates: provider.certificates.map((c) => c.pem).join('\n'),
      spEntityId: provider.spEntityId ?? '',
      emailAttribute: provider.emailAttribute ?? '',
      idpInitiated: provider.idpInitiated,
    };
  }
  return {
    ...emptyDraft('oidc'),
    ...common,
    issuer: provider.issuer,
    clientId: provider.clientId,
    scopes: provider.scopes,
  };
}

/** Google's issuer; the guide says how an operator makes a client of their own there. */
export const GOOGLE_ISSUER = 'https://accounts.google.com';
export const GOOGLE_NAME = 'Google';
export const GOOGLE_DOMAIN = 'gmail.com';
export const GOOGLE_GUIDE_URL =
  'https://github.com/Rockersands/taskmoor/blob/main/docs/manual/admin/sso.md#signing-in-with-google';

export function isGoogleIssuer(issuer: string): boolean {
  try {
    return new URL(issuer.trim()).origin === GOOGLE_ISSUER;
  } catch {
    return false;
  }
}

/**
 * The Google choice (IAM-031, ADR-119): ordinary OpenID Connect settings, all still editable, set
 * so that only invited people and existing accounts get in and passwords keep working. Domains
 * already typed stay.
 */
export function googleDraft(draft: ProviderDraft): ProviderDraft {
  return {
    ...draft,
    protocol: 'oidc',
    name: draft.name.trim() ? draft.name : GOOGLE_NAME,
    issuer: GOOGLE_ISSUER,
    scopes: DEFAULT_SCOPES,
    domains: draft.domains.length > 0 ? draft.domains : [GOOGLE_DOMAIN],
    jit: false,
    enforceSso: false,
  };
}

/** Back to a blank provider where the Google choice's values are still untouched. */
export function withoutGoogle(draft: ProviderDraft): ProviderDraft {
  const blank = emptyDraft(draft.protocol);
  return {
    ...draft,
    name: draft.name === GOOGLE_NAME ? '' : draft.name,
    issuer: draft.issuer === GOOGLE_ISSUER ? '' : draft.issuer,
    domains: draft.domains.join() === GOOGLE_DOMAIN ? [] : draft.domains,
    jit: blank.jit,
    enforceSso: blank.enforceSso,
  };
}

/** Where anyone can get an address, so that a domain says nothing about who someone is. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  'aol.com',
  'gmail.com',
  'gmx.com',
  'gmx.net',
  'googlemail.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'yandex.com',
  'zoho.com',
]);

/** The public email domains among these (IAM-031), for the warnings of the provider form. */
export function publicDomains(domains: readonly string[]): string[] {
  return domains.filter((domain) => PUBLIC_EMAIL_DOMAINS.has(domain.trim().toLowerCase()));
}

/** Complete rows, trimmed, without duplicates, in a stable order. */
function mappingsOf(rows: readonly (MappingRow | GroupMapping)[]): GroupMapping[] {
  const seen = new Set<string>();
  const out: GroupMapping[] = [];
  for (const row of rows) {
    const claimValue = row.claimValue.trim();
    if (!claimValue || row.groupId === null) continue;
    const id = `${row.groupId}\u0000${claimValue}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ claimValue, groupId: row.groupId });
  }
  return out.sort((a, b) =>
    a.claimValue === b.claimValue ? a.groupId - b.groupId : a.claimValue < b.claimValue ? -1 : 1,
  );
}

const scopesOf = (scopes: string) => scopes.trim().split(/\s+/).filter(Boolean).join(' ');

/**
 * The certificates in a text box: each PEM block, or the whole text as one bare base64
 * certificate (as metadata holds them). The backend checks that each is one.
 */
export function certificatesOf(text: string): string[] {
  const blocks = text.match(/-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g);
  if (blocks) return blocks.map((b) => b.trim());
  const bare = text.replace(/\s+/g, '');
  return bare ? [bare] : [];
}

function commonInput(draft: ProviderDraft) {
  return {
    name: draft.name.trim(),
    groupClaim: draft.groupClaim.trim() || null,
    domains: draft.domains,
    enforceSso: draft.enforceSso,
    jit: draft.jit,
    enabled: draft.enabled,
    groupMap: mappingsOf(draft.groupMap),
  };
}

function samlInput(draft: ProviderDraft): SamlProviderInput {
  const metadataXml = draft.metadataXml.trim();
  const entityId = draft.entityId.trim();
  const ssoUrl = draft.ssoUrl.trim();
  const certificates = certificatesOf(draft.certificates);
  return {
    ...commonInput(draft),
    ...(metadataXml ? { metadataXml } : {}),
    ...(entityId ? { entityId } : {}),
    ...(ssoUrl ? { ssoUrl } : {}),
    ...(certificates.length > 0 ? { certificates } : {}),
    spEntityId: draft.spEntityId.trim() || null,
    emailAttribute: draft.emailAttribute.trim() || null,
    idpInitiated: draft.idpInitiated,
  };
}

function oidcInput(draft: ProviderDraft): OidcProviderInput {
  return {
    name: draft.name.trim(),
    issuer: draft.issuer.trim(),
    clientId: draft.clientId.trim(),
    ...(draft.clientSecret ? { clientSecret: draft.clientSecret } : {}),
    scopes: scopesOf(draft.scopes) || DEFAULT_SCOPES,
    groupClaim: draft.groupClaim.trim() || null,
    domains: draft.domains,
    enforceSso: draft.enforceSso,
    jit: draft.jit,
    enabled: draft.enabled,
    groupMap: mappingsOf(draft.groupMap),
  };
}

/** Everything a new provider needs; a SAML one says so. */
export function inputOf(draft: ProviderDraft): ProviderInput {
  return draft.protocol === 'saml' ? { protocol: 'saml', ...samlInput(draft) } : oidcInput(draft);
}

/**
 * Whether a new SAML provider names where its settings come from: metadata, or its entity ID,
 * sign-in address and at least one certificate.
 */
export function samlComplete(draft: ProviderDraft): boolean {
  const input = samlInput(draft);
  return Boolean(input.metadataXml || (input.entityId && input.ssoUrl && input.certificates));
}

/** The common fields an edit changed. */
function commonChanges(provider: IdentityProvider, next: ReturnType<typeof commonInput>) {
  const changes: Partial<ReturnType<typeof commonInput>> = {};
  if (next.name !== provider.name) changes.name = next.name;
  if (next.groupClaim !== provider.groupClaim) changes.groupClaim = next.groupClaim;
  if (next.domains.join(' ') !== provider.domains.join(' ')) changes.domains = next.domains;
  if (next.enforceSso !== provider.enforceSso) changes.enforceSso = next.enforceSso;
  if (next.jit !== provider.jit) changes.jit = next.jit;
  if (next.enabled !== provider.enabled) changes.enabled = next.enabled;
  return changes;
}

function samlChanges(provider: SamlProvider, draft: ProviderDraft): Partial<SamlProviderInput> {
  const next = samlInput(draft);
  const changes: Partial<SamlProviderInput> = commonChanges(provider, commonInput(draft));
  // New metadata is sent as pasted; the fields it would fill go along only where edited.
  if (next.metadataXml) changes.metadataXml = next.metadataXml;
  if (next.entityId !== undefined && next.entityId !== provider.entityId) {
    changes.entityId = next.entityId;
  }
  if (next.ssoUrl !== undefined && next.ssoUrl !== provider.ssoUrl) changes.ssoUrl = next.ssoUrl;
  const saved = certificatesOf(provider.certificates.map((c) => c.pem).join('\n'));
  if (next.certificates && next.certificates.join('\n') !== saved.join('\n')) {
    changes.certificates = next.certificates;
  }
  if (next.spEntityId !== provider.spEntityId) changes.spEntityId = next.spEntityId;
  if (next.emailAttribute !== provider.emailAttribute) {
    changes.emailAttribute = next.emailAttribute;
  }
  if (next.idpInitiated !== provider.idpInitiated) changes.idpInitiated = next.idpInitiated;
  return changes;
}

function oidcChanges(provider: OidcProvider, draft: ProviderDraft): Partial<OidcProviderInput> {
  const next = oidcInput(draft);
  const changes: Partial<OidcProviderInput> = commonChanges(provider, commonInput(draft));
  if (next.issuer !== provider.issuer) changes.issuer = next.issuer;
  if (next.clientId !== provider.clientId) changes.clientId = next.clientId;
  if (next.clientSecret !== undefined) changes.clientSecret = next.clientSecret;
  if (next.scopes !== provider.scopes) changes.scopes = next.scopes;
  return changes;
}

/**
 * Only what an edit changed, so the audit log records real changes. A blank secret keeps the
 * saved one; `withGroupMap` is false when the groups could not be read and the map was not shown.
 * The protocol of a saved provider never changes, so it is not sent.
 */
export function changesOf(
  provider: IdentityProvider,
  draft: ProviderDraft,
  withGroupMap = true,
): Partial<ProviderInput> {
  const changes: Partial<OidcProviderInput> | Partial<SamlProviderInput> = isSaml(provider)
    ? samlChanges(provider, draft)
    : oidcChanges(provider, draft);
  const groupMap = mappingsOf(draft.groupMap);
  if (withGroupMap && JSON.stringify(groupMap) !== JSON.stringify(mappingsOf(provider.groupMap))) {
    changes.groupMap = groupMap;
  }
  return changes;
}
