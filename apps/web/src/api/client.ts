import { runtimeConfig } from '../runtime/config';
import { oauthClient } from '../session/oauth';
import { announceApiChange, changedPath } from './changes';

/**
 * The frontend's one way to call the backend. Same origin by default (the backend serves the
 * app, or a proxy sits in front); a split deployment names the backend in the runtime
 * configuration's `apiUrl` (M1-105). How a request carries the person depends on the layout
 * (M1-107, ADR-080): the session cookie on the same origin, the backend's cookie across
 * sibling subdomains of one site (credentials included, the backend approving this origin), or
 * an OAuth access token for a backend on another site (`auth: "oauth"`).
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`API ${status}`);
    this.name = 'ApiError';
  }

  /** The backend's short error code, such as "invalid_setup_token", when it sent one. */
  get code(): string | undefined {
    const body = this.body as { error?: unknown } | null;
    return typeof body?.error === 'string' ? body.error : undefined;
  }
}

export const API_BASE = `${runtimeConfig.apiUrl}/api/v1`;

/** The backend's cookie goes along when it is another origin of this site (sibling subdomains). */
function credentialsFor(apiUrl: string): RequestCredentials {
  if (oauthClient) return 'omit';
  if (apiUrl === '' || typeof window === 'undefined') return 'same-origin';
  return new URL(apiUrl).origin === window.location.origin ? 'same-origin' : 'include';
}
const CREDENTIALS = credentialsFor(runtimeConfig.apiUrl);

/**
 * `fetch` for backend addresses: with the layout's credentials, and in OAuth mode the access
 * token, refreshed once and the request sent again when the backend refuses it.
 */
export async function apiFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const response = await authorizedFetch(url, init);
  // A change the backend took, for the guided tutorial's steps that wait for one (ADR-115).
  const method = (init.method ?? 'GET').toUpperCase();
  if (response.ok && method !== 'GET' && method !== 'HEAD') {
    announceApiChange({ method, path: changedPath(url, API_BASE) });
  }
  return response;
}

/** The header that carries the browser's time zone; the server's `viewerTimeZone` reads it. */
export const TIME_ZONE_HEADER = 'taskmoor-time-zone';

/**
 * The time zone of this browser, the clock `localDay()` reads, so the server counts a report's
 * days on the same calendar as the person's own "today" (T-272); null when the browser has none.
 */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

/** The request's headers with the browser's time zone added, unless the caller set one. */
export function withTimeZone(headers: HeadersInit | undefined): Headers {
  const out = new Headers(headers);
  const zone = browserTimeZone();
  if (zone && !out.has(TIME_ZONE_HEADER)) out.set(TIME_ZONE_HEADER, zone);
  return out;
}

async function authorizedFetch(url: string, init: RequestInit): Promise<Response> {
  const client = oauthClient;
  if (!client) {
    return fetch(url, { ...init, headers: withTimeZone(init.headers), credentials: CREDENTIALS });
  }
  const send = (token: string | null) => {
    const headers = withTimeZone(init.headers);
    if (token) headers.set('authorization', `Bearer ${token}`);
    return fetch(url, { ...init, headers, credentials: 'omit' });
  };
  // A request kept alive past the page (keepalive) is sent with the token in hand while it is
  // still good: the early refresh is a round trip the closing page may never finish (T-245).
  const token = (init.keepalive ? client.currentToken() : null) ?? (await client.accessToken());
  const response = await send(token);
  if (response.status !== 401 || token === null) return response;
  const fresh = await client.forceRefresh();
  return fresh ? send(fresh) : response;
}

/**
 * A WebSocket address on the backend (`/sync/socket`): the API's host, else the page's own. In
 * OAuth mode it asks for bearer sign-in, since no cookie travels to another site.
 */
export function socketUrl(
  path: string,
  location: Pick<Location, 'protocol' | 'host'> = window.location,
): string {
  const url = new URL(`${API_BASE}${path}`, `${location.protocol}//${location.host}`);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (oauthClient) url.searchParams.set('auth', 'bearer');
  return url.href;
}

/** The realtime socket at a path; in OAuth mode its first message is the access token. */
export function openSocket(path: string): WebSocket {
  const socket = new WebSocket(socketUrl(path));
  const client = oauthClient;
  if (client) {
    socket.addEventListener(
      'open',
      () => {
        void client.accessToken().then((token) => {
          if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ type: 'auth', token: token ?? '' }));
          }
        });
      },
      { once: true },
    );
  }
  return socket;
}

/** What co-editing signs a document in with: the access token in OAuth mode, else the cookie. */
export const socketToken: (() => Promise<string>) | null = oauthClient
  ? async () => (await oauthClient?.accessToken()) ?? ''
  : null;

export async function api<T>(
  path: string,
  init: {
    method?: string;
    body?: unknown;
    /** The request goes on even if the page closes meanwhile (a small save made on the way out). */
    keepalive?: boolean;
  } = {},
): Promise<T> {
  const request: RequestInit = { method: init.method ?? 'GET' };
  if (init.keepalive) request.keepalive = true;
  if (init.body !== undefined) {
    request.headers = { 'content-type': 'application/json' };
    request.body = JSON.stringify(init.body);
  }
  const response = await apiFetch(`${API_BASE}${path}`, request);
  const text = await response.text();
  const body: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) throw new ApiError(response.status, body);
  return body as T;
}
