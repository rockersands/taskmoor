import { ApiError } from '../api/client';
import {
  type AdminTokensClient,
  type ApiToken,
  type BulkCriteria,
  type OwnerSummary,
  type PersonalTokensClient,
  type PolicyLimits,
  type ServiceAccount,
  type ServiceAccountsClient,
  TOKENS_PAGE,
  type TokenOwner,
  type TokenPolicy,
} from './client';

/** Synthetic tokens, owners and service accounts for stories and tests. */
const DAY = 86_400_000;
const iso = (offset: number, now: number) => new Date(now + offset).toISOString();

export const POLICY: TokenPolicy = { maxLifetimeDays: 365, reminderDays: 14 };
export const LIMITS: PolicyLimits = {
  maxLifetimeDays: { min: 1, max: 3650 },
  reminderDays: { min: 1, max: 90 },
};

export const KALO_OWNER: TokenOwner = {
  id: 1,
  name: 'Kalo Mendes',
  email: 'kalo@example.com',
  kind: 'person',
  active: true,
};
export const RIVER_OWNER: TokenOwner = {
  id: 2,
  name: 'River Stone',
  email: 'river@example.com',
  kind: 'person',
  active: true,
};
export const ROBOT_OWNER: TokenOwner = {
  id: 7,
  name: 'Release robot',
  email: 'release-robot@service.invalid',
  kind: 'service',
  active: true,
};

/** A token in the given state; the fields not named get plausible values. */
export function sampleToken(
  overrides: Partial<ApiToken> & { id: number; name: string },
  now = Date.now(),
): ApiToken {
  return {
    scopes: ['read'],
    status: 'active',
    createdAt: iso(-20 * DAY, now),
    expiresAt: iso(70 * DAY, now),
    lastUsedAt: iso(-2 * 60_000, now),
    lastUsedIp: '203.0.113.7',
    revokedAt: null,
    replacedBy: null,
    owner: KALO_OWNER,
    ...overrides,
  };
}

/** Kalo's tokens: one in use, one due for rotation, one never used, one revoked, one expired. */
export function personalTokens(now = Date.now()): ApiToken[] {
  return [
    sampleToken({ id: 41, name: 'Deploy script', scopes: ['read', 'write'] }, now),
    sampleToken({ id: 42, name: 'Weekly report', expiresAt: iso(5 * DAY + 3600_000, now) }, now),
    sampleToken({ id: 43, name: 'Editor plugin', lastUsedAt: null, lastUsedIp: null }, now),
    sampleToken(
      {
        id: 44,
        name: 'Old laptop',
        status: 'revoked',
        revokedAt: iso(-3 * DAY, now),
      },
      now,
    ),
    sampleToken(
      {
        id: 45,
        name: 'Trial import',
        status: 'expired',
        createdAt: iso(-60 * DAY, now),
        expiresAt: iso(-30 * DAY, now),
      },
      now,
    ),
  ];
}

/** Everyone's tokens, as the administrator's inventory lists them. */
export function inventoryTokens(now = Date.now()): ApiToken[] {
  return [
    ...personalTokens(now),
    sampleToken({ id: 51, name: 'Sync job', owner: RIVER_OWNER, scopes: ['read', 'write'] }, now),
    sampleToken(
      {
        id: 61,
        name: 'Release key',
        owner: ROBOT_OWNER,
        scopes: ['read', 'write', 'admin'],
        replacedBy: 62,
        expiresAt: iso(20 * 3600_000, now),
      },
      now,
    ),
    sampleToken(
      { id: 62, name: 'Release key', owner: ROBOT_OWNER, scopes: ['read', 'write', 'admin'] },
      now,
    ),
  ];
}

/** `count` live tokens of River's named Token 001, Token 002…, newest first (T-308). */
export function manyTokens(count: number, now = Date.now()): ApiToken[] {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return sampleToken(
      { id: 2000 + i, name: `Token ${n}`, owner: RIVER_OWNER, createdAt: iso(-i * 60_000, now) },
      now,
    );
  });
}

const live = (t: ApiToken) => t.status === 'active';

/** Owners with how many live tokens each holds, as the inventory reports them. */
export function ownersOf(tokens: ApiToken[]): OwnerSummary[] {
  const owners = new Map<number, OwnerSummary>();
  for (const t of tokens) {
    const known = owners.get(t.owner.id) ?? {
      id: t.owner.id,
      name: t.owner.name,
      email: t.owner.email,
      kind: t.owner.kind,
      activeTokens: 0,
    };
    if (live(t)) known.activeTokens++;
    owners.set(t.owner.id, known);
  }
  return [...owners.values()].sort((a, b) => a.name.localeCompare(b.name));
}

let nextId = 1000;
/** Shaped like a token for the eye, but the underscores keep it from passing as a real one. */
const secret = () => `tmk_EXAMPLE_ONLY_not_a_real_token_${String(nextId).padStart(6, '0')}`;

/** An in-memory backend for the Account page's tokens. Overrides make a call fail or hang. */
export function fakePersonalTokensClient(
  overrides: Partial<PersonalTokensClient> = {},
  options: { tokens?: ApiToken[]; policy?: TokenPolicy } = {},
): PersonalTokensClient {
  let tokens = options.tokens ?? personalTokens();
  const policy = options.policy ?? POLICY;
  return {
    list: async () => ({ tokens, policy }),
    create: async (input) => {
      if (input.expiresInDays > policy.maxLifetimeDays) {
        throw new ApiError(400, {
          error: 'expiry_too_long',
          maxLifetimeDays: policy.maxLifetimeDays,
        });
      }
      const id = ++nextId;
      const now = Date.now();
      const apiToken = sampleToken({
        id,
        name: input.name,
        scopes: input.scopes,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.expiresInDays * DAY).toISOString(),
        lastUsedAt: null,
        lastUsedIp: null,
      });
      tokens = [apiToken, ...tokens];
      return { token: secret(), apiToken };
    },
    revoke: async (id) => {
      tokens = tokens.map((t) =>
        t.id === id ? { ...t, status: 'revoked', revokedAt: new Date().toISOString() } : t,
      );
    },
    ...overrides,
  };
}

function matches(t: ApiToken, criteria: BulkCriteria): boolean {
  if (!live(t)) return false;
  if ('all' in criteria) return true;
  if ('ownerId' in criteria) return t.owner.id === criteria.ownerId;
  return Date.parse(t.createdAt) < Date.parse(criteria.createdBefore);
}

/**
 * An in-memory administrator backend: the inventory, `pageSize` tokens a page (as many as the
 * page asks for, unless a story wants to show paging), bulk revocation and the policy.
 */
export function fakeAdminTokensClient(
  overrides: Partial<AdminTokensClient> = {},
  options: { tokens?: ApiToken[]; policy?: TokenPolicy; pageSize?: number } = {},
): AdminTokensClient {
  const pageSize = options.pageSize ?? TOKENS_PAGE;
  let tokens = options.tokens ?? inventoryTokens();
  let policy = options.policy ?? POLICY;
  const revoke = (t: ApiToken): ApiToken => ({
    ...t,
    status: 'revoked',
    revokedAt: new Date().toISOString(),
  });
  return {
    list: async (filter, offset = 0) => {
      const now = Date.now();
      const shown = tokens.filter((t) => {
        if (filter === 'all') return true;
        if (filter === 'expiring') {
          return (
            live(t) &&
            t.replacedBy === null &&
            Date.parse(t.expiresAt) - now <= policy.reminderDays * DAY
          );
        }
        return t.status === filter;
      });
      // "Expiring" is one list, unpaged, as the API answers it.
      const page = filter === 'expiring' ? shown : shown.slice(offset, offset + pageSize);
      return { tokens: page, total: shown.length, owners: ownersOf(tokens) };
    },
    revoke: async (id) => {
      tokens = tokens.map((t) => (t.id === id ? revoke(t) : t));
    },
    bulkRevoke: async (criteria, dryRun) => {
      const hit = tokens.filter((t) => matches(t, criteria));
      if (!dryRun) tokens = tokens.map((t) => (matches(t, criteria) ? revoke(t) : t));
      return hit.length;
    },
    policy: async () => ({ policy, limits: LIMITS }),
    savePolicy: async (next) => {
      policy = next;
      return { policy, limits: LIMITS };
    },
    ...overrides,
  };
}

export function sampleServiceAccounts(now = Date.now()): ServiceAccount[] {
  return [
    {
      id: 7,
      name: 'Release robot',
      email: 'release-robot@service.invalid',
      description: 'Tags releases and publishes notes',
      active: true,
      createdAt: iso(-90 * DAY, now),
      deactivatedAt: null,
      activeTokens: 2,
    },
    {
      id: 8,
      name: 'Backup exporter',
      email: 'backup-exporter@service.invalid',
      description: '',
      active: false,
      createdAt: iso(-200 * DAY, now),
      deactivatedAt: iso(-10 * DAY, now),
      activeTokens: 0,
    },
  ];
}

/** An in-memory service-account backend with the Release robot's tokens. */
export function fakeServiceAccountsClient(
  overrides: Partial<ServiceAccountsClient> = {},
  options: { accounts?: ServiceAccount[]; tokens?: ApiToken[] } = {},
): ServiceAccountsClient {
  let accounts = options.accounts ?? sampleServiceAccounts();
  let tokens = options.tokens ?? inventoryTokens().filter((t) => t.owner.kind === 'service');
  const count = (id: number) => tokens.filter((t) => t.owner.id === id && live(t)).length;
  const refresh = () => {
    accounts = accounts.map((a) => ({ ...a, activeTokens: count(a.id) }));
  };
  const ownerOf = (id: number): TokenOwner => {
    const a = accounts.find((x) => x.id === id);
    return {
      id,
      name: a?.name ?? '',
      email: a?.email ?? '',
      kind: 'service',
      active: a?.active ?? false,
    };
  };
  return {
    list: async () => accounts,
    create: async ({ name, description }) => {
      const id = ++nextId;
      const account: ServiceAccount = {
        id,
        name,
        description,
        email: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}@service.invalid`,
        active: true,
        createdAt: new Date().toISOString(),
        deactivatedAt: null,
        activeTokens: 0,
      };
      accounts = [...accounts, account];
      return account;
    },
    tokens: async (id) => tokens.filter((t) => t.owner.id === id),
    setActive: async (id, active) => {
      accounts = accounts.map((a) =>
        a.id === id ? { ...a, active, deactivatedAt: active ? null : new Date().toISOString() } : a,
      );
      return accounts.find((a) => a.id === id) as ServiceAccount;
    },
    issue: async (id, input) => {
      const tokenId = ++nextId;
      const now = Date.now();
      const apiToken = sampleToken({
        id: tokenId,
        name: input.name,
        scopes: input.scopes,
        owner: ownerOf(id),
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + input.expiresInDays * DAY).toISOString(),
        lastUsedAt: null,
        lastUsedIp: null,
      });
      tokens = [apiToken, ...tokens];
      refresh();
      return { token: secret(), apiToken };
    },
    rotate: async (id, tokenId, overlapHours) => {
      const old = tokens.find((t) => t.id === tokenId);
      if (!old) throw new ApiError(404, { error: 'not_found' });
      const now = Date.now();
      const apiToken = sampleToken({
        ...old,
        id: ++nextId,
        owner: ownerOf(id),
        createdAt: new Date(now).toISOString(),
        lastUsedAt: null,
        lastUsedIp: null,
      });
      const previous: ApiToken =
        overlapHours === 0
          ? {
              ...old,
              status: 'revoked',
              revokedAt: new Date(now).toISOString(),
              replacedBy: apiToken.id,
            }
          : {
              ...old,
              replacedBy: apiToken.id,
              expiresAt: new Date(now + overlapHours * 3600_000).toISOString(),
            };
      tokens = [apiToken, ...tokens.map((t) => (t.id === tokenId ? previous : t))];
      refresh();
      return { token: secret(), apiToken, previous };
    },
    revoke: async (tokenId) => {
      tokens = tokens.map((t) =>
        t.id === tokenId ? { ...t, status: 'revoked', revokedAt: new Date().toISOString() } : t,
      );
      refresh();
    },
    policy: async () => POLICY,
    ...overrides,
  };
}
