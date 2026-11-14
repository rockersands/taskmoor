import { api } from '../api/client';

/** What a token may do (IAM-007): read for GET, write for changes, admin for administration. */
/** `scim` belongs to service accounts of identity providers and is held alone (ADR-038). */
export type TokenScope = 'read' | 'write' | 'admin' | 'scim';
export const TOKEN_SCOPES: readonly TokenScope[] = ['read', 'write', 'admin', 'scim'];
export type TokenStatus = 'active' | 'expired' | 'revoked';

export interface TokenOwner {
  id: number;
  name: string;
  email: string;
  kind: 'person' | 'service';
  active: boolean;
}

/** A token as the backend lists it; the token itself is shown once, at creation. */
export interface ApiToken {
  id: number;
  name: string;
  scopes: TokenScope[];
  status: TokenStatus;
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
  revokedAt: string | null;
  /** Set when the token was rotated; it keeps working until it expires. */
  replacedBy: number | null;
  owner: TokenOwner;
}

export interface TokenPolicy {
  maxLifetimeDays: number;
  reminderDays: number;
}

export interface NewToken {
  name: string;
  scopes: TokenScope[];
  expiresInDays: number;
}

export interface CreatedToken {
  /** The token itself: shown once, never stored by the frontend. */
  token: string;
  apiToken: ApiToken;
}

export interface RotatedToken extends CreatedToken {
  previous: ApiToken;
}

/** The signed-in person's own tokens (`/api/v1/account/tokens`). */
export interface PersonalTokensClient {
  list: () => Promise<{ tokens: ApiToken[]; policy: TokenPolicy; adminScopeAllowed?: boolean }>;
  create: (token: NewToken) => Promise<CreatedToken>;
  revoke: (id: number) => Promise<void>;
}

export const personalTokensClient: PersonalTokensClient = {
  list: () =>
    api<{ tokens: ApiToken[]; policy: TokenPolicy; adminScopeAllowed?: boolean }>(
      '/account/tokens',
    ),
  create: (token) => api<CreatedToken>('/account/tokens', { method: 'POST', body: token }),
  revoke: async (id) => {
    await api<null>(`/account/tokens/${id}`, { method: 'DELETE' });
  },
};

export type TokenFilter = 'all' | 'active' | 'expiring' | 'expired' | 'revoked';

export interface OwnerSummary {
  id: number;
  name: string;
  email: string;
  kind: 'person' | 'service';
  activeTokens: number;
}

export interface TokenInventory {
  tokens: ApiToken[];
  total: number;
  owners: OwnerSummary[];
}

/** Which live tokens a bulk revocation ends: one owner's, those created before a day, or all. */
export type BulkCriteria = { ownerId: number } | { createdBefore: string } | { all: true };

export interface PolicyLimits {
  maxLifetimeDays: { min: number; max: number };
  reminderDays: { min: number; max: number };
}

/** Tokens the inventory asks for at a time; Show more reads the next page (T-308). */
export const TOKENS_PAGE = 500;

/** The administrator's token inventory (`/api/v1/admin/tokens`, site administrators only). */
export interface AdminTokensClient {
  /**
   * One page of every token, or of those of one status, from `offset` (0 when left out), with
   * how many there are in all (`total`). "expiring" lists every token due for rotation at once.
   */
  list: (filter: TokenFilter, offset?: number) => Promise<TokenInventory>;
  revoke: (id: number) => Promise<void>;
  /** Resolves to how many tokens it revoked, or would revoke when `dryRun` is set. */
  bulkRevoke: (criteria: BulkCriteria, dryRun: boolean) => Promise<number>;
  policy: () => Promise<{ policy: TokenPolicy; limits: PolicyLimits }>;
  savePolicy: (policy: TokenPolicy) => Promise<{ policy: TokenPolicy; limits: PolicyLimits }>;
}

export const adminTokensClient: AdminTokensClient = {
  list: async (filter, offset = 0) => {
    if (filter === 'expiring') {
      const [{ tokens }, all] = await Promise.all([
        api<{ tokens: ApiToken[] }>('/admin/tokens/expiring'),
        api<TokenInventory>('/admin/tokens?status=active&limit=1'),
      ]);
      return { tokens, total: tokens.length, owners: all.owners };
    }
    return api<TokenInventory>(
      `/admin/tokens?status=${filter}&limit=${TOKENS_PAGE}${offset ? `&offset=${offset}` : ''}`,
    );
  },
  revoke: async (id) => {
    await api<null>(`/admin/tokens/${id}`, { method: 'DELETE' });
  },
  bulkRevoke: async (criteria, dryRun) => {
    const answer = await api<{ revoked?: number; matched?: number }>('/admin/tokens/revoke', {
      method: 'POST',
      body: { ...criteria, dryRun },
    });
    return (dryRun ? answer.matched : answer.revoked) ?? 0;
  },
  policy: () => api('/admin/token-policy'),
  savePolicy: (policy) => api('/admin/token-policy', { method: 'PUT', body: policy }),
};

export interface ServiceAccount {
  id: number;
  name: string;
  email: string;
  description: string;
  active: boolean;
  createdAt: string;
  deactivatedAt: string | null;
  activeTokens: number;
}

/** Service accounts (`/api/v1/service-accounts`, site administrators only). */
export interface ServiceAccountsClient {
  list: () => Promise<ServiceAccount[]>;
  create: (account: { name: string; description: string }) => Promise<ServiceAccount>;
  tokens: (id: number) => Promise<ApiToken[]>;
  setActive: (id: number, active: boolean) => Promise<ServiceAccount>;
  issue: (id: number, token: NewToken) => Promise<CreatedToken>;
  rotate: (id: number, tokenId: number, overlapHours: number) => Promise<RotatedToken>;
  revoke: (tokenId: number) => Promise<void>;
  policy: () => Promise<TokenPolicy>;
}

export const serviceAccountsClient: ServiceAccountsClient = {
  list: async () =>
    (await api<{ serviceAccounts: ServiceAccount[] }>('/service-accounts?status=all'))
      .serviceAccounts,
  create: async (account) =>
    (
      await api<{ serviceAccount: ServiceAccount }>('/service-accounts', {
        method: 'POST',
        body: account,
      })
    ).serviceAccount,
  tokens: async (id) => (await api<{ tokens: ApiToken[] }>(`/service-accounts/${id}`)).tokens,
  setActive: async (id, active) =>
    (
      await api<{ serviceAccount: ServiceAccount }>(
        `/service-accounts/${id}/${active ? 'reactivate' : 'deactivate'}`,
        { method: 'POST' },
      )
    ).serviceAccount,
  issue: (id, token) =>
    api<CreatedToken>(`/service-accounts/${id}/tokens`, { method: 'POST', body: token }),
  rotate: (id, tokenId, overlapHours) =>
    api<RotatedToken>(`/service-accounts/${id}/tokens/${tokenId}/rotate`, {
      method: 'POST',
      body: { overlapHours },
    }),
  revoke: async (tokenId) => {
    await api<null>(`/admin/tokens/${tokenId}`, { method: 'DELETE' });
  },
  policy: async () => (await api<{ policy: TokenPolicy }>('/admin/token-policy')).policy,
};
