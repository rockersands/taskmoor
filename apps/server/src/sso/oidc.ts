import type { Database } from '@taskmoor/db';
import { openSecret, type PepperRing } from '@taskmoor/iam';
import { type Kysely, sql, type Transaction } from 'kysely';
import * as client from 'openid-client';
import { type OutboundGuard, outboundGuard } from '../outbound/guard';

/**
 * OpenID Connect relying party (M1-080, IAM-003, ADR-019): authorization code with PKCE,
 * state and nonce, through `openid-client`. Providers are discovered from their issuer and the
 * configuration is cached for an hour (or until the provider is edited). Discovery, the key set,
 * the token endpoint and user info go through the outbound guard (ASVS 5.2.6; ADR-110): an issuer
 * on a private address needs the operator's `TASKMOOR_OUTBOUND_ALLOW`.
 */
type Db = Kysely<Database> | Transaction<Database>;

/**
 * An identity provider row, of either protocol (`kind`): OpenID Connect uses issuer, client and
 * scopes; SAML (M1-081, `saml.ts`) uses the issuer column for its entity ID and the saml_*
 * columns.
 */
export interface Provider {
  id: number;
  name: string;
  kind: 'oidc' | 'saml';
  issuer: string;
  client_id: string | null;
  client_secret_sealed: string | null;
  scopes: string;
  group_claim: string | null;
  domains: string[];
  enforce_sso: boolean;
  jit: boolean;
  enabled: boolean;
  saml_sso_url: string | null;
  saml_certificates: string[];
  saml_sp_entity_id: string | null;
  saml_email_attribute: string | null;
  saml_idp_initiated: boolean;
  updated_at: Date;
}

export const PROVIDER_COLUMNS = [
  'id',
  'name',
  'kind',
  'issuer',
  'client_id',
  'client_secret_sealed',
  'scopes',
  'group_claim',
  'domains',
  'enforce_sso',
  'jit',
  'enabled',
  'saml_sso_url',
  'saml_certificates',
  'saml_sp_entity_id',
  'saml_email_attribute',
  'saml_idp_initiated',
  'updated_at',
] as const;

/** Plain HTTP issuers are refused except on the loopback interface (development and tests). */
export function insecureIssuerAllowed(issuer: URL): boolean {
  if (issuer.protocol === 'https:') return true;
  return (
    (issuer.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(issuer.hostname)) ||
    process.env.TASKMOOR_OIDC_ALLOW_HTTP === 'true'
  );
}

const cache = new Map<
  number,
  { stamp: number; at: number; guard: OutboundGuard; config: client.Configuration }
>();
const TTL_MS = 60 * 60 * 1000;

export async function providerConfiguration(
  provider: Provider,
  peppers: PepperRing | undefined,
  guard: OutboundGuard = outboundGuard(),
): Promise<client.Configuration> {
  const stamp = provider.updated_at.getTime();
  const hit = cache.get(provider.id);
  if (hit && hit.stamp === stamp && hit.guard === guard && Date.now() - hit.at < TTL_MS) {
    return hit.config;
  }
  const issuer = new URL(provider.issuer);
  if (!insecureIssuerAllowed(issuer)) throw new Error('The issuer must use HTTPS');
  const secret = provider.client_secret_sealed
    ? (openSecret(provider.client_secret_sealed, peppers) ?? undefined)
    : undefined;
  const config = await client.discovery(issuer, provider.client_id ?? '', secret, undefined, {
    [client.customFetch]: guard.fetch as client.CustomFetch,
    ...(issuer.protocol === 'http:' ? { execute: [client.allowInsecureRequests] } : {}),
  });
  cache.set(provider.id, { stamp, at: Date.now(), guard, config });
  return config;
}

export interface AuthorizationStart {
  url: URL;
  state: string;
  nonce: string;
  verifier: string;
}

export async function startAuthorization(
  config: client.Configuration,
  provider: Provider,
  redirectUri: string,
): Promise<AuthorizationStart> {
  const verifier = client.randomPKCECodeVerifier();
  const state = client.randomState();
  const nonce = client.randomNonce();
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: provider.scopes,
    code_challenge: await client.calculatePKCECodeChallenge(verifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url, state, nonce, verifier };
}

/** The person a provider vouches for; `SsoIdentity` in `sign-in.ts` has the same shape. */
export interface Identity {
  subject: string;
  email: string | null;
  emailVerified: boolean;
  name: string | null;
  groups: string[];
}

/** Exchanges the code (PKCE, state, nonce checked by openid-client) and reads the person. */
export async function finishAuthorization(
  config: client.Configuration,
  provider: Provider,
  currentUrl: URL,
  expected: { state: string; nonce: string; verifier: string },
): Promise<Identity> {
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: expected.verifier,
    expectedState: expected.state,
    expectedNonce: expected.nonce,
    idTokenExpected: true,
  });
  const claims: Record<string, unknown> = { ...(tokens.claims() ?? {}) };
  const subject = String(claims.sub ?? '');
  // Group claims often live only in user info.
  if (provider.group_claim && claims[provider.group_claim] === undefined && tokens.access_token) {
    const info = await client.fetchUserInfo(config, tokens.access_token, subject);
    Object.assign(claims, info);
  }
  const rawGroups = provider.group_claim ? claims[provider.group_claim] : undefined;
  const groups = Array.isArray(rawGroups)
    ? rawGroups.map(String)
    : typeof rawGroups === 'string'
      ? [rawGroups]
      : [];
  return {
    subject,
    email: typeof claims.email === 'string' ? claims.email.toLowerCase() : null,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
    name: typeof claims.name === 'string' ? claims.name : null,
    groups,
  };
}

export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** The enabled provider that serves an email's domain, if any. */
export async function providerForDomain(
  db: Db,
  workspaceId: number,
  domain: string,
): Promise<{ id: number; name: string; kind: 'oidc' | 'saml'; enforce_sso: boolean } | undefined> {
  return db
    .selectFrom('identity_provider')
    .select(['id', 'name', 'kind', 'enforce_sso'])
    .where('workspace_id', '=', workspaceId)
    .where('enabled', '=', true)
    .where(sql<boolean>`${domain} = ANY(domains)`)
    .orderBy('id')
    .executeTakeFirst();
}

/**
 * Brings the person's memberships in the provider's mapped groups in line with their claims:
 * added where a claim maps to a group, removed from mapped groups whose claim is gone. Groups
 * the provider does not map are left alone.
 */
export async function syncGroups(
  db: Db,
  workspaceId: number,
  providerId: number,
  userId: number,
  claims: readonly string[],
): Promise<{ added: number[]; removed: number[] }> {
  const map = await db
    .selectFrom('identity_provider_group')
    .select(['claim_value', 'group_id'])
    .where('provider_id', '=', providerId)
    .execute();
  if (map.length === 0) return { added: [], removed: [] };
  const wanted = new Set(map.filter((m) => claims.includes(m.claim_value)).map((m) => m.group_id));
  const managed = new Set(map.map((m) => m.group_id));
  const current = new Set(
    (
      await db
        .selectFrom('group_member')
        .select('group_id')
        .where('user_id', '=', userId)
        .where('group_id', 'in', [...managed])
        .execute()
    ).map((r) => r.group_id),
  );
  const added = [...wanted].filter((g) => !current.has(g)).sort((a, b) => a - b);
  const removed = [...current].filter((g) => !wanted.has(g)).sort((a, b) => a - b);
  if (added.length > 0) {
    await db
      .insertInto('group_member')
      .values(added.map((g) => ({ workspace_id: workspaceId, group_id: g, user_id: userId })))
      .onConflict((oc) => oc.columns(['group_id', 'user_id']).doNothing())
      .execute();
  }
  if (removed.length > 0) {
    await db
      .deleteFrom('group_member')
      .where('user_id', '=', userId)
      .where('group_id', 'in', removed)
      .execute();
  }
  return { added, removed };
}

/**
 * Only same-origin paths are followed after sign-in, so the callback cannot redirect away; and
 * addresses on an allowed frontend origin (M1-107), so a frontend on a sibling subdomain gets
 * the person back.
 */
export function safeReturnTo(
  value: string | undefined,
  frontends: ReadonlySet<string> = new Set(),
): string {
  if (value && /^https?:\/\//.test(value) && value.length <= 500) {
    try {
      const url = new URL(value);
      if (frontends.has(url.origin) && !url.username && !url.password) return url.href;
    } catch {
      return '/';
    }
  }
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\'))
    return '/';
  return value.slice(0, 500);
}

/** Where a finished sign-in goes: a frontend's own address, or a path of this instance. */
export function returnAddress(base: string, returnTo: string): string {
  return /^https?:\/\//.test(returnTo) ? returnTo : `${base}${returnTo}`;
}
