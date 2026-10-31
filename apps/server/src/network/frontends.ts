import type { Database } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';

/**
 * Registered frontend origins (M1-108; IAM-025; ADR-087): frontends on other origins that a
 * site administrator adds, beside the ones TASKMOOR_ALLOWED_ORIGINS lists. The origin policy
 * (`origins.ts`) reads them; the admin routes (`routes/frontends.ts`) keep them.
 */

/** Plain http is for this machine only: localhost, names under it, and the loopback addresses. */
export function isLocalHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '127.0.0.1' ||
    hostname === '[::1]'
  );
}

/**
 * An origin as typed, in its normal form (lower case, default port dropped), or null when it is
 * not one: https, or http for this machine; scheme, host and port only (a trailing slash is
 * allowed), no user, path, query, fragment or wildcard.
 */
export function frontendOrigin(text: string): string | null {
  const value = text.trim();
  if (value === '' || value.length > 300 || value.includes('*')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const plain = !url.username && !url.password && !url.search && !url.hash && url.pathname === '/';
  // `https://host/?` and `https://host/#` parse with an empty query and fragment.
  const bare = !/[?#]/.test(value) && !/^[a-z]+:\/\/[^/]*\/./i.test(value);
  const secure =
    url.protocol === 'https:' || (url.protocol === 'http:' && isLocalHost(url.hostname));
  if (!plain || !bare || !secure || url.hostname === '' || url.hostname.includes('*')) return null;
  return url.origin;
}

/** A URL OAuth sign-in may return to: on the given origin, without a user or fragment. */
export function frontendRedirectUri(text: string, origin: string): string | null {
  const value = text.trim();
  if (value === '' || value.length > 2000 || value.includes('#')) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.username || url.password || url.origin !== origin) return null;
  return url.href;
}

/** What a frontend may report as its version: what `version.json` holds, within reason. */
export const FRONTEND_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,99}$/;

export interface FrontendGrant {
  origin: string;
  redirectUris: string[];
  websocket: boolean;
}

type Db = Pick<Kysely<Database>, 'selectFrom' | 'updateTable'>;

/** Every registered frontend's grant: what the origin policy needs. */
export async function readFrontendGrants(db: Db, workspaceId: number): Promise<FrontendGrant[]> {
  const rows = await db
    .selectFrom('frontend_origin')
    .select(['origin', 'redirect_uris', 'websocket'])
    .where('workspace_id', '=', workspaceId)
    .execute();
  return rows.map((r) => ({
    origin: r.origin,
    redirectUris: r.redirect_uris,
    websocket: r.websocket,
  }));
}

/** How often a frontend that keeps reporting the same version is written down again. */
const SEEN_AGAIN_AFTER = '1 hour';

/**
 * A registered frontend reported its version (it reads `/api/meta` on load and every half
 * hour). Bookkeeping like a token's last use: written when the version changes, otherwise at
 * most once an hour, and no event.
 */
export async function recordFrontendVersion(
  db: Db,
  workspaceId: number,
  origin: string,
  version: string,
): Promise<void> {
  await db
    .updateTable('frontend_origin')
    .set({ last_version: version, last_seen_at: sql<Date>`now()` })
    .where('workspace_id', '=', workspaceId)
    .where('origin', '=', origin)
    .where((eb) =>
      eb.or([
        eb('last_version', 'is', null),
        eb('last_version', '!=', version),
        eb('last_seen_at', 'is', null),
        eb('last_seen_at', '<', sql<Date>`now() - ${sql.lit(SEEN_AGAIN_AFTER)}::interval`),
      ]),
    )
    .execute();
}
