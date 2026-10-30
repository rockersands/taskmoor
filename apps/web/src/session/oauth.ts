import { runtimeConfig } from '../runtime/config';

/**
 * Signing in at a backend on another site (M1-107; IAM-024, ADR-080). The browser blocks the
 * backend's cookie in calls from this page, so the app is an OAuth 2.1 public client: it sends
 * the person to the backend's own sign-in (where the cookie is first-party) with a PKCE
 * challenge, comes back with a code, and trades it for a ten-minute access token and a refresh
 * token that changes with every use.
 *
 * Tokens live in this page's memory. The refresh token goes to sessionStorage only while the
 * page unloads, so a reload keeps the person signed in, and is taken out again as the next page
 * starts: a tab duplicated meanwhile finds nothing and signs in on its own, instead of spending
 * the same token twice, which the backend would take for theft and end the session
 * (IAM-024 (2)). Nothing goes to localStorage (IAM-024 (3)).
 */
export const CLIENT_ID = 'taskmoor-web';
const REFRESH_KEY = 'taskmoor.oauth.refresh';
const PENDING_KEY = 'taskmoor.oauth.pending';
/** A sign-in that came back without a code this soon is not started again on its own. */
const RETRY_AFTER_MS = 15_000;
/** Access tokens are refreshed this long before they run out. */
const EARLY_MS = 30_000;
const ANSWER_PARAMS = ['code', 'state', 'iss', 'error', 'error_description'];

interface Pending {
  state: string;
  verifier: string;
  /** The address the person was at, restored after the code is traded. */
  returnTo: string;
  startedAt: number;
}

export type Completion = 'none' | 'signed-in' | { error: string };

export interface OAuthEnvironment {
  location: Pick<Location, 'href' | 'origin' | 'assign'>;
  history: Pick<History, 'replaceState'>;
  storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;
  fetch: typeof fetch;
  crypto: Pick<Crypto, 'getRandomValues' | 'subtle'>;
  addEventListener: (type: 'pagehide' | 'pageshow', listener: () => void) => void;
  now: () => number;
}

function base64url(bytes: Uint8Array): string {
  let text = '';
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** sessionStorage can be missing or refuse (private windows, blocked site data). */
function safely<T>(work: () => T, fallback: T): T {
  try {
    return work();
  } catch {
    return fallback;
  }
}

export class OAuthClient {
  private access: { token: string; expiresAt: number } | null = null;
  private refreshToken: string | null;
  private refreshing: Promise<string | null> | null = null;
  /** Why the last sign-in came back without a session, until the next one starts. */
  private lastFailure: string | null = null;
  private readonly signedOut = new Set<() => void>();
  private readonly api: string;

  constructor(
    apiUrl: string,
    private readonly basePath: string,
    private readonly env: OAuthEnvironment,
  ) {
    this.api = new URL(apiUrl).origin;
    const storage = env.storage;
    this.refreshToken = safely(() => storage?.getItem(REFRESH_KEY) ?? null, null);
    safely(() => storage?.removeItem(REFRESH_KEY), undefined);
    env.addEventListener('pagehide', () => {
      if (this.refreshToken) {
        const token = this.refreshToken;
        safely(() => storage?.setItem(REFRESH_KEY, token), undefined);
      }
    });
    // Back from the cache with this page's memory intact: take the token out again.
    env.addEventListener('pageshow', () =>
      safely(() => storage?.removeItem(REFRESH_KEY), undefined),
    );
  }

  /** Where the backend sends the browser back: the app's own address on this host. */
  redirectUri(): string {
    return `${this.env.location.origin}${this.basePath}`;
  }

  /** Why the sign-in that brought the page here failed, or null. */
  failure(): string | null {
    return this.lastFailure;
  }

  /** True while the page holds a token that may still sign it in. */
  hasTokens(): boolean {
    return this.access !== null || this.refreshToken !== null;
  }

  /**
   * Sends the browser to the backend's sign-in. With `auto`, only when no sign-in came back
   * empty-handed in the last seconds, so a failing backend cannot bounce the page forever;
   * answers false then.
   */
  async begin(options: { auto?: boolean } = {}): Promise<boolean> {
    const storage = this.env.storage;
    const last = safely(
      () => JSON.parse(storage?.getItem(PENDING_KEY) ?? 'null') as Pending | null,
      null,
    );
    if (options.auto && last && this.env.now() - last.startedAt < RETRY_AFTER_MS) return false;
    this.lastFailure = null;
    const random = (n: number) => base64url(this.env.crypto.getRandomValues(new Uint8Array(n)));
    const verifier = random(32);
    const digest = await this.env.crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier),
    );
    const pending: Pending = {
      state: random(16),
      verifier,
      returnTo: this.env.location.href,
      startedAt: this.env.now(),
    };
    safely(() => storage?.setItem(PENDING_KEY, JSON.stringify(pending)), undefined);
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CLIENT_ID,
      redirect_uri: this.redirectUri(),
      code_challenge: base64url(new Uint8Array(digest)),
      code_challenge_method: 'S256',
      state: pending.state,
    });
    this.env.location.assign(`${this.api}/api/v1/oauth/authorize?${params}`);
    return true;
  }

  /**
   * At start-up: when the address carries the backend's answer, takes it out of the address
   * (and the history), checks it belongs to the sign-in this tab started, and trades the code.
   */
  async complete(): Promise<Completion> {
    const outcome = await this.trade();
    if (typeof outcome === 'object') this.lastFailure = outcome.error;
    return outcome;
  }

  private async trade(): Promise<Completion> {
    const url = new URL(this.env.location.href);
    const answer = url.searchParams;
    if (!answer.has('code') && !answer.has('error')) return 'none';
    const storage = this.env.storage;
    const pending = safely(
      () => JSON.parse(storage?.getItem(PENDING_KEY) ?? 'null') as Pending | null,
      null,
    );
    const { code, state, iss, error } = Object.fromEntries(
      ANSWER_PARAMS.map((name) => [name, answer.get(name)]),
    ) as Record<string, string | null>;
    for (const name of ANSWER_PARAMS) answer.delete(name);
    this.env.history.replaceState(null, '', url.href);
    if (!pending || pending.state !== state) return { error: 'state_mismatch' };
    if (error) return { error };
    // RFC 9207: the answer must come from the backend this app talks to.
    if (iss !== null && iss !== this.api) return { error: 'issuer_mismatch' };
    const tokens = await this.post({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: this.redirectUri(),
      code_verifier: pending.verifier,
    });
    if (!tokens.ok) return { error: tokens.error };
    safely(() => storage?.removeItem(PENDING_KEY), undefined);
    if (new URL(pending.returnTo).origin === this.env.location.origin) {
      this.env.history.replaceState(null, '', pending.returnTo);
    }
    return 'signed-in';
  }

  /** A live access token, refreshed first when it is about to run out; null when signed out. */
  async accessToken(): Promise<string | null> {
    if (this.access && this.access.expiresAt - EARLY_MS > this.env.now()) return this.access.token;
    return this.refresh();
  }

  /** A new access token now: the backend refused the one this page had. */
  forceRefresh(): Promise<string | null> {
    this.access = null;
    return this.refresh();
  }

  /** Forgets every token (after signing out at the backend, or when the session ended). */
  clear(): void {
    this.access = null;
    this.refreshToken = null;
    safely(() => this.env.storage?.removeItem(REFRESH_KEY), undefined);
  }

  /** Hears when the backend ended the session: a refresh it refused. Returns the unsubscribe. */
  onSignedOut(listener: () => void): () => void {
    this.signedOut.add(listener);
    return () => this.signedOut.delete(listener);
  }

  private refresh(): Promise<string | null> {
    if (!this.refreshToken) return Promise.resolve(null);
    this.refreshing ??= (async () => {
      try {
        const tokens = await this.post({
          grant_type: 'refresh_token',
          refresh_token: this.refreshToken as string,
        });
        if (tokens.ok) return tokens.access;
        if (tokens.error !== 'network') {
          this.clear();
          for (const listener of this.signedOut) listener();
        }
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  private async post(
    form: Record<string, string>,
  ): Promise<{ ok: true; access: string } | { ok: false; error: string }> {
    let response: Response;
    try {
      response = await this.env.fetch(`${this.api}/api/v1/oauth/token`, {
        method: 'POST',
        credentials: 'omit',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: CLIENT_ID, ...form }).toString(),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    const body = (await response.json().catch(() => null)) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    } | null;
    if (!response.ok || !body?.access_token || !body.refresh_token) {
      return { ok: false, error: body?.error ?? `http_${response.status}` };
    }
    this.access = {
      token: body.access_token,
      expiresAt: this.env.now() + (body.expires_in ?? 60) * 1000,
    };
    this.refreshToken = body.refresh_token;
    return { ok: true, access: body.access_token };
  }
}

/** The page's client when the app signs in through OAuth (runtime config `auth: "oauth"`). */
export const oauthClient: OAuthClient | null =
  runtimeConfig.auth === 'oauth' && typeof window !== 'undefined'
    ? new OAuthClient(runtimeConfig.apiUrl, runtimeConfig.basePath, {
        location: window.location,
        history: window.history,
        storage: safely(() => window.sessionStorage, null),
        fetch: (input, init) => window.fetch(input, init),
        crypto: window.crypto,
        addEventListener: (type, listener) => window.addEventListener(type, listener),
        now: () => Date.now(),
      })
    : null;
