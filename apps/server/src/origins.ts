import type { FastifyInstance, FastifyReply } from 'fastify';

/**
 * Which browser origins may use the API (M1-107; IAM-025, ADR-080): this instance's own (its
 * public URL's, or the host a request came to) and the frontends listed in
 * TASKMOOR_ALLOWED_ORIGINS, each matched exactly. Requests without an Origin header are not
 * from a page script (programs, top-level navigations of GET), so the check leaves them alone;
 * they still need a session or a token.
 */
export class OriginPolicy {
  /** This instance's own origin, from its public URL. */
  readonly own: string | null;
  /** Frontends on other origins: they get CORS answers. */
  readonly frontends: ReadonlySet<string>;

  constructor(options: { publicUrl: string; allowedOrigins?: readonly string[] }) {
    let own: string | null = null;
    try {
      own = new URL(options.publicUrl).origin;
    } catch {
      own = null;
    }
    this.own = own;
    this.frontends = new Set(options.allowedOrigins ?? []);
  }

  /** A listed frontend on another origin than this instance's own. */
  isFrontend(origin: string): boolean {
    return origin !== this.own && this.frontends.has(origin);
  }

  /** True for this instance's own origin, a listed frontend, or the very host asked. */
  allows(origin: string | undefined, host: string | undefined): boolean {
    if (origin === undefined) return true;
    if (origin === this.own || this.frontends.has(origin)) return true;
    try {
      return host !== undefined && new URL(origin).host === host;
    } catch {
      // `null` (sandboxed frames, some redirects) and anything else that is not an origin.
      return false;
    }
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

/** Request headers a frontend sends: JSON bodies, bearer tokens, the sync outbox's ids. */
const ALLOWED_HEADERS = [
  'authorization',
  'content-type',
  'taskmoor-client-id',
  'taskmoor-mutation-id',
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
 * - answers vary by Origin, so no cache hands one origin's answer to another.
 */
export function registerCrossOrigin(app: FastifyInstance, policy: OriginPolicy): void {
  app.addHook('onRequest', async (request, reply) => {
    if (!request.url.startsWith('/api/')) return;
    const origin = request.headers.origin;
    if (origin === undefined) return;
    reply.header('vary', 'Origin');
    if (policy.isFrontend(origin)) {
      approve(reply, origin);
    } else if (!policy.allows(origin, request.headers.host)) {
      if (OPEN_TO_ANY_ORIGIN.has(request.routeOptions.url ?? '')) return;
      // A refused WebSocket handshake: nothing more comes on that connection, and the
      // WebSocket plugin's own hooks, which would close it, do not run after this answer.
      if (request.headers.upgrade !== undefined) {
        reply.raw.once('finish', () => request.raw.socket?.destroy());
      }
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
