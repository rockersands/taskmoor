import type { GroupMapping, IdentityProvider, ProviderInput } from './client';

/** One row of the group map editor; `key` keeps rows apart while they are edited. */
export interface MappingRow {
  key: number;
  claimValue: string;
  groupId: number | null;
}

/** The provider form's values, as typed. */
export interface ProviderDraft {
  name: string;
  issuer: string;
  clientId: string;
  /** Blank keeps the saved secret (or sends none for a new provider). */
  clientSecret: string;
  scopes: string;
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
export function emptyDraft(): ProviderDraft {
  return {
    name: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    scopes: DEFAULT_SCOPES,
    groupClaim: '',
    domains: [],
    enforceSso: false,
    jit: true,
    enabled: true,
    groupMap: [],
  };
}

export function draftOf(provider: IdentityProvider): ProviderDraft {
  return {
    name: provider.name,
    issuer: provider.issuer,
    clientId: provider.clientId,
    clientSecret: '',
    scopes: provider.scopes,
    groupClaim: provider.groupClaim ?? '',
    domains: [...provider.domains],
    enforceSso: provider.enforceSso,
    jit: provider.jit,
    enabled: provider.enabled,
    groupMap: provider.groupMap.map((m) => mappingRow(m.claimValue, m.groupId)),
  };
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

/** Everything a new provider needs. */
export function inputOf(draft: ProviderDraft): ProviderInput {
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

/**
 * Only what an edit changed, so the audit log records real changes. A blank secret keeps the
 * saved one; `withGroupMap` is false when the groups could not be read and the map was not shown.
 */
export function changesOf(
  provider: IdentityProvider,
  draft: ProviderDraft,
  withGroupMap = true,
): Partial<ProviderInput> {
  const next = inputOf(draft);
  const changes: Partial<ProviderInput> = {};
  if (next.name !== provider.name) changes.name = next.name;
  if (next.issuer !== provider.issuer) changes.issuer = next.issuer;
  if (next.clientId !== provider.clientId) changes.clientId = next.clientId;
  if (next.clientSecret !== undefined) changes.clientSecret = next.clientSecret;
  if (next.scopes !== provider.scopes) changes.scopes = next.scopes;
  if (next.groupClaim !== provider.groupClaim) changes.groupClaim = next.groupClaim;
  if (next.domains.join(' ') !== provider.domains.join(' ')) changes.domains = next.domains;
  if (next.enforceSso !== provider.enforceSso) changes.enforceSso = next.enforceSso;
  if (next.jit !== provider.jit) changes.jit = next.jit;
  if (next.enabled !== provider.enabled) changes.enabled = next.enabled;
  if (
    withGroupMap &&
    JSON.stringify(next.groupMap) !== JSON.stringify(mappingsOf(provider.groupMap))
  ) {
    changes.groupMap = next.groupMap;
  }
  return changes;
}
