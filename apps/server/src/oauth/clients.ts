import { randomBytes } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { newToken, tokenHash } from '@taskmoor/iam';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';

/**
 * Clients that register themselves (M1-072; RFC 7591; API-002, API-012; ADR-084): MCP clients
 * such as desktop assistants and editors, which find this server's OAuth endpoints from the
 * discovery documents and then ask the person to approve them.
 *
 * - Every registered client is public (no secret) and uses the code flow with PKCE.
 * - Redirect URIs are HTTPS, HTTP on the loopback interface (where a desktop client listens on a
 *   port it picks each time; RFC 8252 section 7.3 lets the port vary), or a private-use scheme
 *   of a native app (`cursor://...`). Schemes that run code or read files are refused.
 * - What a client may do is a scope: `read`, or `read write`. It never reaches administration
 *   or the session-only routes, and its tokens are good at the MCP endpoint alone (ADR-084).
 * - An authorization request is checked once, then waits under a random id for the person to
 *   sign in and approve it, ten minutes at most.
 */
type Db = Kysely<Database> | Transaction<Database>;

export const CLIENT_ID_PREFIX = 'tmc_';
export const REQUEST_TTL_MS = 10 * 60 * 1000;
/** Registered clients one instance keeps; unused ones go after a day (`pruneOAuth`). */
export const MAX_CLIENTS = 1000;
export const SCOPES = ['read', 'write'] as const;
export type ClientScope = 'read' | 'read write';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
/** Schemes a redirect may never use: they run code, read files or stay in the browser. */
const REFUSED_SCHEMES = new Set([
  'javascript:',
  'data:',
  'vbscript:',
  'file:',
  'blob:',
  'about:',
  'ftp:',
  'ws:',
  'wss:',
]);

/** Why a redirect URI cannot be registered, or null. */
export function redirectProblem(value: string): string | null {
  if (value.length > 2000) return 'too_long';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'not_a_url';
  }
  if (url.hash !== '' || value.includes('#')) return 'fragment';
  if (url.username !== '' || url.password !== '') return 'credentials';
  if (url.protocol === 'https:') return url.hostname === '' ? 'not_a_url' : null;
  if (url.protocol === 'http:')
    return LOOPBACK_HOSTS.has(url.hostname) ? null : 'http_not_loopback';
  if (REFUSED_SCHEMES.has(url.protocol)) return 'scheme_refused';
  // A native app's private-use scheme: RFC 8252 section 7.1.
  return /^[a-z][a-z0-9+.-]*:$/.test(url.protocol) ? null : 'scheme_refused';
}

/** Whether a redirect URI in a request is one the client registered. */
export function redirectMatches(registered: readonly string[], requested: string): boolean {
  if (registered.includes(requested)) return true;
  let wanted: URL;
  try {
    wanted = new URL(requested);
  } catch {
    return false;
  }
  if (wanted.protocol !== 'http:' || !LOOPBACK_HOSTS.has(wanted.hostname)) return false;
  return registered.some((r) => {
    try {
      const url = new URL(r);
      return (
        url.protocol === 'http:' &&
        url.hostname === wanted.hostname &&
        url.pathname === wanted.pathname &&
        url.search === wanted.search
      );
    } catch {
      return false;
    }
  });
}

/**
 * The scope a request asks for, as stored: `read` or `read write`; null when it names a scope
 * this server does not have. Asking for none means both, as `scopes_supported` lists.
 */
export function requestedScope(value: string | undefined): ClientScope | null {
  const words = (value ?? '').split(/\s+/).filter((w) => w !== '');
  if (words.length === 0) return 'read write';
  if (words.some((w) => !(SCOPES as readonly string[]).includes(w))) return null;
  return words.includes('write') ? 'read write' : 'read';
}

/** The registration document clients send (RFC 7591 section 2); unknown fields are ignored. */
export const registrationBody = z.object({
  redirect_uris: z.array(z.string().min(1).max(2000)).min(1).max(10),
  client_name: z.string().trim().min(1).max(200).optional(),
  client_uri: z.string().max(2000).optional(),
  software_id: z.string().min(1).max(200).optional(),
  software_version: z.string().min(1).max(100).optional(),
  token_endpoint_auth_method: z.string().max(100).optional(),
  grant_types: z.array(z.string().max(100)).max(10).optional(),
  response_types: z.array(z.string().max(100)).max(10).optional(),
  scope: z.string().max(500).optional(),
});
export type Registration = z.infer<typeof registrationBody>;

/** RFC 7591 section 3.2.2: why the metadata is refused, or null. */
export function registrationProblem(body: Registration): string | null {
  for (const uri of body.redirect_uris) {
    const problem = redirectProblem(uri);
    if (problem) return `redirect_uris: ${problem}`;
  }
  if (body.token_endpoint_auth_method && body.token_endpoint_auth_method !== 'none') {
    return 'token_endpoint_auth_method: only none (a public client with PKCE)';
  }
  const grants = body.grant_types ?? ['authorization_code'];
  if (grants.some((g) => g !== 'authorization_code' && g !== 'refresh_token')) {
    return 'grant_types: only authorization_code and refresh_token';
  }
  if ((body.response_types ?? ['code']).some((r) => r !== 'code')) {
    return 'response_types: only code';
  }
  if (body.client_uri !== undefined && !/^https:\/\/[^\s]+$/.test(body.client_uri)) {
    return 'client_uri: an https address';
  }
  if (requestedScope(body.scope) === null) return 'scope: read and write only';
  return null;
}

export interface RegisteredClient {
  id: string;
  name: string;
  redirectUris: string[];
  clientUri: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

export async function findClient(
  db: Db,
  workspaceId: number,
  clientId: string,
): Promise<RegisteredClient | null> {
  if (!clientId.startsWith(CLIENT_ID_PREFIX)) return null;
  const row = await db
    .selectFrom('oauth_client')
    .select(['id', 'name', 'redirect_uris', 'client_uri', 'created_at', 'last_used_at'])
    .where('workspace_id', '=', workspaceId)
    .where('id', '=', clientId)
    .executeTakeFirst();
  return row
    ? {
        id: row.id,
        name: row.name,
        redirectUris: row.redirect_uris,
        clientUri: row.client_uri,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
      }
    : null;
}

export async function clientCount(db: Db, workspaceId: number): Promise<number> {
  const row = await db
    .selectFrom('oauth_client')
    .select((eb) => eb.fn.countAll<string>().as('n'))
    .where('workspace_id', '=', workspaceId)
    .executeTakeFirstOrThrow();
  return Number(row.n);
}

export const newClientId = () => `${CLIENT_ID_PREFIX}${randomBytes(24).toString('base64url')}`;

export interface PendingRequest {
  clientId: string;
  redirectUri: string;
  challenge: string;
  state: string | null;
  scope: ClientScope;
}

/** Stores a checked request and returns its id for the sign-in and consent pages. */
export async function savePendingRequest(
  db: Db,
  workspaceId: number,
  request: PendingRequest,
  now = new Date(),
): Promise<string> {
  const id = newToken();
  await db
    .insertInto('oauth_request')
    .values({
      id_hash: tokenHash(id),
      workspace_id: workspaceId,
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      code_challenge: request.challenge,
      state: request.state,
      scope: request.scope,
      expires_at: new Date(now.getTime() + REQUEST_TTL_MS),
    })
    .execute();
  return id;
}

/** A live pending request by its id; `take` also deletes it, so a request is answered once. */
export async function pendingRequest(
  db: Db,
  workspaceId: number,
  id: string,
  options: { take?: boolean; now?: Date } = {},
): Promise<(PendingRequest & { client: RegisteredClient }) | null> {
  const now = options.now ?? new Date();
  const hash = tokenHash(id);
  const row = options.take
    ? await db
        .deleteFrom('oauth_request')
        .where('id_hash', '=', hash)
        .where('workspace_id', '=', workspaceId)
        .returningAll()
        .executeTakeFirst()
    : await db
        .selectFrom('oauth_request')
        .selectAll()
        .where('id_hash', '=', hash)
        .where('workspace_id', '=', workspaceId)
        .executeTakeFirst();
  if (!row || row.expires_at <= now) return null;
  const client = await findClient(db, workspaceId, row.client_id);
  if (!client) return null;
  return {
    clientId: row.client_id,
    redirectUri: row.redirect_uri,
    challenge: row.code_challenge,
    state: row.state,
    scope: row.scope as ClientScope,
    client,
  };
}
