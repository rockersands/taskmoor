import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import { readFrontendGrants } from './network/frontends';
import { defaultWorkspaceId } from './workspace';

/** The allowed origins at one moment: the environment's and the registered ones together. */
export class OriginSnapshot {
  constructor(
    /** This instance's own origin, from its public URL. */
    readonly own: string | null,
    /** Frontends on other origins: they get CORS answers. */
    readonly frontends: ReadonlySet<string>,
    /** The frontends that may open the WebSockets. */
    readonly sockets: ReadonlySet<string>,
    /** Where OAuth sign-in of the first-party client may return, exact URLs. */
    readonly redirectUris: ReadonlySet<string>,
    /** The frontends an administrator registered (their versions are written down). */
    readonly registered: ReadonlySet<string>,
  ) {}

  /** A listed frontend on another origin than this instance's own. */
  isFrontend(origin: string): boolean {
    return origin !== this.own && this.frontends.has(origin);
  }

  /** True for this instance's own origin, a listed frontend, or the very host asked. */
  allows(origin: string | undefined, host: string | undefined): boolean {
    return this.admits(origin, host, this.frontends);
  }

  /** The same for a WebSocket handshake: a registered frontend may be kept off the sockets. */
  allowsSocket(origin: string | undefined, host: string | undefined): boolean {
    return this.admits(origin, host, this.sockets);
  }

  private admits(
    origin: string | undefined,
    host: string | undefined,
    listed: ReadonlySet<string>,
  ): boolean {
    if (origin === undefined) return true;
    if (origin === this.own || listed.has(origin)) return true;
    try {
      return host !== undefined && new URL(origin).host === host;
    } catch {
      // `null` (sandboxed frames, some redirects) and anything else that is not an origin.
      return false;
    }
  }
}

export interface OriginPolicyOptions {
  publicUrl: string;
  /** TASKMOOR_ALLOWED_ORIGINS: always allowed, with the sockets. */
  allowedOrigins?: readonly string[];
  /** TASKMOOR_OAUTH_REDIRECT_URIS; each allowed origin's root unless given. */
  redirectUris?: readonly string[];
  /** Where the registered frontends are (M1-108); without one, the environment's alone. */
  db?: Kysely<Database>;
  /** How long a process trusts what it read before it reads again (other processes' changes). */
  ttlMs?: number;
}

/**
 * Which browser origins may use the API (M1-107, M1-108; IAM-025, ADR-080, ADR-087): this
 * instance's own (its public URL's, or the host a request came to), the frontends listed in
 * TASKMOOR_ALLOWED_ORIGINS, and the frontends a site administrator registered, each matched
 * exactly. Requests without an Origin header are not from a page script (programs, top-level
 * navigations of GET), so the check leaves them alone; they still need a session or a token.
 *
 * The registered list is read from the database at most every `ttlMs` (five seconds) per
 * process, and at once after a change made through this process (`changed()`), so a frontend
 * added or removed works or stops without a restart.
 */
export class OriginPolicy {
  readonly own: string | null;
  private readonly env: readonly string[];
  private readonly envRedirects: readonly string[];
  private readonly db: Kysely<Database> | undefined;
  private readonly ttlMs: number;
  private snapshot: OriginSnapshot;
  private until = 0;
  private loading: Promise<OriginSnapshot> | null = null;
  private generation = 0;

  constructor(options: OriginPolicyOptions) {
    let own: string | null = null;
    try {
      own = new URL(options.publicUrl).origin;
    } catch {
      own = null;
    }
    this.own = own;
    this.env = options.allowedOrigins ?? [];
    this.envRedirects = options.redirectUris ?? this.env.map((o) => `${o}/`);
    this.db = options.db;
    this.ttlMs = options.ttlMs ?? 5_000;
    this.snapshot = this.compose([]);
  }

  private compose(
    registered: readonly { origin: string; redirectUris: string[]; websocket: boolean }[],
  ): OriginSnapshot {
    const frontends = new Set([...this.env, ...registered.map((r) => r.origin)]);
    const sockets = new Set([
      ...this.env,
      ...registered.filter((r) => r.websocket).map((r) => r.origin),
    ]);
    const redirects = new Set([...this.envRedirects, ...registered.flatMap((r) => r.redirectUris)]);
    return new OriginSnapshot(
      this.own,
      frontends,
      sockets,
      redirects,
      new Set(registered.map((r) => r.origin)),
    );
  }

  /** The allowed origins now: read again when older than the TTL or after a change. */
  async current(): Promise<OriginSnapshot> {
    const db = this.db;
    if (!db || Date.now() < this.until) return this.snapshot;
    if (!this.loading) {
      const generation = this.generation;
      this.loading = (async () => {
        try {
          const rows = await readFrontendGrants(db, await defaultWorkspaceId(db));
          const next = this.compose(rows);
          // A change made while this read ran waits for the next read.
          if (generation === this.generation) {
            this.snapshot = next;
            this.until = Date.now() + this.ttlMs;
          }
          return next;
        } finally {
          this.loading = null;
        }
      })();
    }
    return this.loading;
  }

  /** What was read last, without waiting: for code the origin check just ran before. */
  get latest(): OriginSnapshot {
    return this.snapshot;
  }

  /** The registered list changed: the next check reads it again. */
  changed(): void {
    this.generation += 1;
    this.until = 0;
    this.loading = null;
  }

  /** TASKMOOR_ALLOWED_ORIGINS, for the admin list. */
  get environment(): readonly string[] {
    return this.env;
  }

  /** TASKMOOR_OAUTH_REDIRECT_URIS (or each listed origin's root), for the admin list. */
  get environmentRedirectUris(): readonly string[] {
    return this.envRedirects;
  }
}

/**
 * Routes other sites post to by design, which authenticate the request themselves and never
 * read the browser's session: a SAML provider's form post (signed assertion) and one-click
 * unsubscribe (a token). They get no CORS answer, but the origin check lets them through.
 */
export const OPEN_TO_ANY_ORIGIN: ReadonlySet<string> = new Set([
  '/api/v1/auth/saml/:id/acs',
  '/api/v1/unsubscribe',
]);

/**
 * Request headers a frontend sends: JSON bodies, bearer tokens, the sync outbox's ids and the
 * browser's time zone, which reports count their days in (T-272).
 */
const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'taskmoor-client-id',
  'taskmoor-mutation-id',
  'taskmoor-time-zone',
].join(', ');
/** Response headers a frontend reads besides the CORS-safelisted ones. */
const EXPOSED_HEADERS = [
  'content-disposition',
  'retry-after',
  'www-authenticate',
  'ratelimit-limit',
  'ratelimit-remaining',
  'ratelimit-reset',
].join(', ');
const PREFLIGHT_MAX_AGE_SECONDS = 600;

function approve(reply: FastifyReply, origin: string): void {
  reply.header('access-control-allow-origin', origin);
  reply.header('access-control-allow-credentials', 'true');
  reply.header('access-control-expose-headers', EXPOSED_HEADERS);
}

/**
 * Strict CORS and the origin check for every `/api/` request, before authentication:
 *
 * - a listed frontend gets CORS approval for its exact origin, with credentials (sibling
 *   subdomains send the session cookie) and the headers bearer tokens need; preflights are
 *   answered here;
 * - a request whose Origin is neither allowed nor this instance's is refused with 403
 *   `origin_not_allowed`, whatever its method: that stops cross-site requests riding a
 *   SameSite=Lax cookie from a sibling subdomain, cross-site form posts, and the WebSocket
 *   handshakes of the sync socket (co-editing checks its own handshakes, `collab/server.ts`);
 *   a handshake also needs the frontend's socket grant (M1-108);
 * - answers vary by Origin, so no cache hands one origin's answer to another.
 */
export function registerCrossOrigin(app: FastifyInstance, policy: OriginPolicy): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (origin === undefined) return;
    reply.header('vary', 'Origin');
    const origins = await policy.current();
    // A WebSocket handshake needs the socket grant: a registered frontend may be kept off them.
    const socket = request.headers.upgrade !== undefined;
    const host = request.headers.host;
    const allowed = socket ? origins.allowsSocket(origin, host) : origins.allows(origin, host);
    if (allowed && origins.isFrontend(origin)) {
      approve(reply, origin);
    } else if (!allowed) {
      if (OPEN_TO_ANY_ORIGIN.has(request.routeOptions.url ?? '')) return;
      // A refused WebSocket handshake: nothing more comes on that connection, and the
      // WebSocket plugin's own hooks, which would close it, do not run after this answer.
      if (socket) reply.raw.once('finish', () => request.raw.socket?.destroy());
      return reply.code(403).send({ error: 'origin_not_allowed' });
    }
    if (request.method === 'OPTIONS' && request.headers['access-control-request-method']) {
      return reply
        .code(204)
        .header('access-control-allow-methods', 'GET, HEAD, POST, PUT, PATCH, DELETE')
        .header('access-control-allow-headers', ALLOWED_HEADERS)
        .header('access-control-max-age', String(PREFLIGHT_MAX_AGE_SECONDS))
        .send();
    }
  });
  // Preflights to any API path reach the hook above, which answers them; this route only
  // keeps them from being a 404 first. Without an Origin there is nothing to approve.
  app.options('/api/*', async (_request, reply) => reply.code(204).send());
}
