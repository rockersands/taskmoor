import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyWebsocket from '@fastify/websocket';
import type { Tracer } from '@opentelemetry/api';
import type { Embedder } from '@taskmoor/ai';
import type { Database } from '@taskmoor/db';
import { type PasswordHasher, type PepperRing, passwordHasher } from '@taskmoor/iam';
import type { RoutingMode } from '@taskmoor/webconfig';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { AgentRuns } from './ai/agent-runs';
import { AiContext } from './ai/context';
import { type AiKeyRing, aiKeyRing } from './ai/keyring';
import { type AdapterFactory, AiService, type AiServiceOptions } from './ai/service';
import { purgeAiContent } from './ai/usage';
import { sweepStorage } from './attachments/cleanup';
import { type AttachmentStores, NO_STORAGE } from './attachments/stores';
import { presentedToken, resolveSession } from './auth';
import { Authorizer } from './authz/authorizer';
import { Collaboration } from './collab/server';
import { registerJiraCompat } from './compat/register';
import type { Role, ServerConfig } from './config';
import { EmbeddingService, sharedLocalEmbedder } from './embeddings/service';
import type { VectorSearch } from './embeddings/vector';
import { FieldCatalogs } from './fields/catalog';
import { serveFrontend } from './frontend';
import { GuardrailExceeded } from './guardrails/model';
import { DirectoryGateway } from './ldap/gateway';
import { Allowlists } from './network/allowlist';
import { isAccessToken, pruneOAuth, resolveAccessToken } from './oauth/tokens';
import { instrumentApp, type Metrics } from './observability';
import { OriginPolicy, registerCrossOrigin } from './origins';
import { type OutboundGuard, outboundGuard } from './outbound/guard';
import { RateLimiter, RateLimitPolicies } from './ratelimit/limiter';
import { UsageRecorder } from './ratelimit/usage';
import { registerRequestScope } from './request-scope';
import { registerAccountRoutes } from './routes/account';
import { registerActivityRoutes } from './routes/activity';
import { registerAdminRoutes } from './routes/admin';
import { registerAiRoutes } from './routes/ai';
import { registerAiFeatureRoutes } from './routes/ai-features';
import { registerAiUsageRoutes } from './routes/ai-usage';
import { registerAttachmentRoutes } from './routes/attachments';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthzRoutes } from './routes/authz';
import { registerBackupRoutes } from './routes/backups';
import { registerBoardRoutes } from './routes/boards';
import { registerBulkRoutes } from './routes/bulk';
import { registerCloneRoutes } from './routes/clone';
import { registerCommentRoutes } from './routes/comments';
import { registerDashboardRoutes } from './routes/dashboards';
import { registerDirectoryRoutes } from './routes/directories';
import { registerEmailRoutes } from './routes/email';
import { registerExportRoutes } from './routes/exports';
import { registerFieldRoutes } from './routes/fields';
import { registerFrontendRoutes } from './routes/frontends';
import { registerGroupRoutes } from './routes/groups';
import { registerGuardrailRoutes } from './routes/guardrails';
import { registerHomeRoutes } from './routes/home';
import { registerImportedLinkRoutes } from './routes/imported-links';
import { registerImportRoutes } from './routes/imports';
import { registerInboxRoutes } from './routes/inbox';
import { registerAllowlist, registerAllowlistRoutes } from './routes/ip-allowlist';
import { registerLayoutRoutes } from './routes/layouts';
import { registerLinkRoutes } from './routes/links';
import { registerListViewRoutes } from './routes/list-views';
import { INNER_CALL_HEADER, registerMcpRoutes } from './routes/mcp';
import { registerMetaRoutes } from './routes/meta';
import { registerNotificationRoutes } from './routes/notifications';
import { registerOAuthRoutes, resourceMetadataUrl } from './routes/oauth';
import { registerPasswordCheckRoute, registerPasswordLinkRoutes } from './routes/password-links';
import { registerPersonalDataRoutes } from './routes/personal-data';
import { registerPriorityRoutes } from './routes/priorities';
import { registerCorePropertyRoutes } from './routes/properties';
import { registerRateLimitRoutes, registerRateLimits } from './routes/rate-limits';
import { registerReleaseHubRoutes } from './routes/release-hub';
import { registerReleaseRoutes } from './routes/releases';
import { registerReportRoutes } from './routes/reports';
import { registerRichTextRoutes } from './routes/rich-text';
import { registerSamlRoutes } from './routes/saml';
import { registerSavedSearchRoutes } from './routes/saved-searches';
import { registerScimRoutes } from './routes/scim';
import { registerSearchRoutes } from './routes/search';
import { registerSearchExportRoutes } from './routes/search-export';
import { registerSecurityAlertRoutes } from './routes/security-alerts';
import { registerServiceAccountRoutes } from './routes/service-accounts';
import { registerSessionRoutes } from './routes/session';
import { registerSetupRoutes } from './routes/setup';
import { registerSimilarRoutes } from './routes/similar';
import { registerSsoRoutes } from './routes/sso';
import { registerSyncRoutes } from './routes/sync';
import { registerTeamRoutes } from './routes/teams';
import { registerTicketTypeRoutes } from './routes/ticket-types';
import { registerTicketRoutes } from './routes/tickets';
import { registerTimeRoutes } from './routes/time';
import { registerTimelineRoutes } from './routes/timeline';
import { registerTokenRoutes } from './routes/tokens';
import { registerTrackSummaryRoutes } from './routes/track-summary';
import { registerTrackRoutes, type TrackRouteHooks } from './routes/tracks';
import { registerTrashRoutes } from './routes/trash';
import { registerTutorialRoutes } from './routes/tutorial';
import { registerTwoFactorRoutes } from './routes/two-factor';
import { registerUserRoutes } from './routes/users';
import { registerVisibilityRoutes } from './routes/visibility';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerWorkflowMapRoutes } from './routes/workflow-maps';
import { registerWorkflowRoutes } from './routes/workflows';
import { pruneSecurityData } from './security/alerts';
import { registerRefusalAudit } from './security/refusals';
import { securityHeaders } from './security-headers';
import { registerMutationReceipts } from './sync/mutations';
import { registerSyncSocket } from './sync/socket';
import { pruneIdentityData } from './throttle';
import { bearerToken, pruneApiTokens } from './tokens/api-tokens';
import { authenticateBearer, refuseCompatCredentials } from './tokens/bearer';
import { type ApiTokenScope, scopeDenial } from './tokens/scopes';
import { defaultWorkspaceId } from './workspace';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every registered route as "METHOD /path". */
    routeTable: string[];
    /** Real-time co-editing (M1-017), when this process has the realtime role. */
    collaboration: Collaboration | null;
    /**
     * The way into AI (M1-075, M1-076): stored keys and settings, with spend limits, redaction
     * and the AI audit log (M1-077), tickets as prompts see them, and agent runs with budgets
     * (M1-131); null without the API role.
     */
    ai: { service: AiService; context: AiContext; agents: AgentRuns } | null;
  }
}

export interface AppDeps {
  /** Absent only for a process that serves nothing but the frontend. */
  db?: Kysely<Database>;
  version: string;
  logLevel?: ServerConfig['logLevel'];
  /** Where log lines go instead of standard output; tests read them (M1-075). */
  logStream?: { write(line: string): void };
  /** Defaults to the API alone, which is what tests exercise. */
  roles?: readonly Role[];
  /** The frontend artefact to serve under `/` when the web role is on (M1-105). */
  webDir?: string;
  /** How the served frontend writes its addresses; hash routing unless told otherwise. */
  webRouting?: RoutingMode;
  /** Mark session cookies Secure (true behind HTTPS; tests and plain-HTTP trials say false). */
  secureCookies?: boolean;
  /** Where browsers reach this instance; one-time links point here. */
  publicUrl?: string;
  /** Serve the Jira-compatible API under /rest (M1-069; on unless false). */
  jiraCompat?: boolean;
  /**
   * Frontends on other origins (M1-107, ADR-080): CORS, WebSockets and OAuth sign-in are
   * open to these exact origins besides this instance's own.
   */
  allowedOrigins?: readonly string[];
  /** Where OAuth sign-in may return; each allowed origin's root unless given. */
  oauthRedirectUris?: readonly string[];
  /**
   * How long a process trusts its read of the registered frontends (M1-108) before reading
   * again; five seconds. A change made through this process applies at once regardless.
   */
  originsTtlMs?: number;
  /** How long OAuth access tokens live (ten minutes); tests shorten it. */
  accessTokenTtlMs?: number;
  /** Origins attachments are downloaded from besides this one (a bucket), for the CSP. */
  mediaOrigins?: readonly string[];
  /** The instance identity a Builder kit gives it (M1-109); otherwise one is made on first use. */
  instance?: { id: string; seed: string };
  /**
   * Proxies whose X-Forwarded-For is believed (Fastify's trustProxy: addresses, CIDRs or
   * "loopback", "linklocal", "uniquelocal"). Unset, the client is the socket's peer.
   */
  trustedProxies?: string;
  /** Password hashing with the install's pepper (ASVS 2.4.5); tests may leave it out. */
  passwords?: PasswordHasher;
  /** The authorization service (ADR-012); built from the database when left out. */
  authorizer?: Authorizer;
  /** The install's password peppers; they also seal second-factor secrets (M1-084). */
  peppers?: PepperRing;
  /**
   * Requests to addresses people typed (AI providers, OpenID Connect) go through it (ASVS 5.2.6;
   * ADR-110). The process's guard from `TASKMOOR_OUTBOUND_ALLOW` when left out; tests that run a
   * fake provider on loopback pass one that allows it.
   */
  outbound?: OutboundGuard;
  /**
   * Where AI credentials' data keys are wrapped (M1-075, ADR-098): the master key, a key
   * service, or the peppers. Built from `peppers` alone when left out.
   */
  aiKeys?: AiKeyRing;
  /** Builds AI provider clients; tests pass fakes. The gateway's own when left out. */
  aiAdapterFactory?: AdapterFactory;
  /** Request latency goes here (ADR-023). */
  metrics?: Metrics;
  /** Requests open server spans with it (ADR-023); absent when tracing is off. */
  tracer?: Tracer;
  /** Instance data directory, for the admin status page. */
  dataDir?: string;
  /** Where imports read files named by path (M1-098); none refuses paths. */
  importDir?: string;
  /** When the process started; defaults to when the app was built. */
  startedAt?: Date;
  /** Where attachments are stored (ADR-040); without one, uploads answer 503. */
  attachments?: AttachmentStores;
  /** Whether an SMTP server is configured for email notifications (M1-057). */
  smtpConfigured?: boolean;
  /** TASKMOOR_SMTP_PASSWORD, for the setup form's mail server when it names a user. */
  smtpPassword?: string;
  /** Quiet time before collaborative edits are saved (M1-017); tests shorten it. */
  collabDebounceMs?: number;
  /** How long a search statement may run, in milliseconds (QRY-010; default 30 s). */
  queryTimeoutMs?: number;
  /**
   * Rate limits and API usage (M1-066; ADR-075). The server turns them on; tests that make
   * thousands of requests leave them out, and the rate limit tests pass their own clock.
   */
  rateLimits?: { limiter?: RateLimiter; now?: () => number };
  /**
   * A provider that wins over the stored settings (tests), and test clocks and retry settings
   * (M1-077). Without a source the stored keys and settings decide (M1-075).
   */
  ai?: Pick<AiServiceOptions, 'source' | 'now' | 'gateway'>;
  /**
   * Embeddings for similar tickets (M1-078, ADR-106): the bundled local model unless given;
   * null turns them off (TASKMOOR_EMBEDDINGS=off). `vectorSearch: 'exact'` skips pgvector.
   */
  embedder?: Embedder | null;
  vectorSearch?: VectorSearch;
}

/** Builds the HTTP app without listening, so tests can call it in-process with app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const level = deps.logLevel ?? 'silent';
  const roles = deps.roles ?? ['api'];
  const outbound = deps.outbound ?? outboundGuard();
  const app = Fastify({
    logger:
      level === 'silent' ? false : { level, ...(deps.logStream ? { stream: deps.logStream } : {}) },
    // A property key is up to 255 characters (M1-129), percent-encoded in the path: up to 12
    // characters each for a 4-byte character.
    routerOptions: { maxParamLength: 3072 },
    ...(deps.trustedProxies ? { trustProxy: deps.trustedProxies } : {}),
  });
  // Every route as "METHOD /path", for fitness tests (every mutation emits one event).
  const routes: string[] = [];
  app.decorate('routeTable', routes);
  app.decorate('ai', null);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`);
  });
  instrumentApp(app, {
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
  });
  await app.register(fastifyCookie);
  securityHeaders(app, { https: deps.secureCookies ?? false });
  // A guardrail refusal thrown inside a route's transaction (M1-055): the transaction has rolled
  // back; the answer names the guardrail and its limit. Everything else goes on as before.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof GuardrailExceeded) return reply.code(409).send(error.body);
    throw error;
  });

  // Liveness: the process is up. Never touches dependencies, so restarts are not triggered by
  // a slow database. Every role answers it, which is what the image's health check calls.
  app.get('/health', async () => ({ status: 'ok', version: deps.version, roles }));

  // Readiness: the process can serve traffic. Load balancers stop routing here on 503.
  app.get('/ready', async (_request, reply) => {
    if (!deps.db) return { status: 'ready' };
    try {
      await sql`SELECT 1`.execute(deps.db);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', reason: 'database' });
    }
  });

  // One authorizer and field catalogue per process, shared by the API and realtime roles.
  // The realtime role's WebSockets share the HTTP server: co-editing takes /api/v1/collab
  // (M1-017) and passes every other upgrade to Fastify's WebSocket routes (M1-032), which
  // would otherwise answer 404 to co-editing's upgrades, as it would to theirs.
  const upgrades = new EventEmitter();
  const passOn = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (upgrades.listenerCount('upgrade') > 0) upgrades.emit('upgrade', request, socket, head);
    else socket.destroy();
  };
  const authorizer = deps.db ? (deps.authorizer ?? new Authorizer(deps.db)) : null;
  const fieldCatalogs = deps.db ? new FieldCatalogs(deps.db) : null;
  // Which browser origins may call the API and open its sockets (M1-107, ADR-080): the
  // environment's list and the frontends site administrators register (M1-108, ADR-087).
  const origins = new OriginPolicy({
    publicUrl: deps.publicUrl ?? 'http://localhost:8080',
    allowedOrigins: deps.allowedOrigins ?? [],
    ...(deps.oauthRedirectUris ? { redirectUris: deps.oauthRedirectUris } : {}),
    ...(deps.db ? { db: deps.db } : {}),
    ...(deps.originsTtlMs !== undefined ? { ttlMs: deps.originsTtlMs } : {}),
  });

  if (roles.includes('api') && deps.db && authorizer && fieldCatalogs) {
    const db = deps.db;
    app.decorateRequest('user', null);
    app.decorateRequest('authSession', null);
    app.decorateRequest('apiToken', null);
    app.decorateRequest('tokenFamily', null);
    app.decorateRequest('workspaceId', 0);
    app.decorateRequest('authz', null as unknown as never);
    // Strict CORS and the origin check come first: a refused origin costs no database work.
    registerCrossOrigin(app, origins);
    // The MCP tools' own REST calls carry this, so a registered client's token, good at the MCP
    // endpoint alone, still reaches what the tools call (M1-072). It never leaves the process.
    const innerCallSecret = randomBytes(32).toString('base64url');
    const metadataUrl = resourceMetadataUrl(deps.publicUrl ?? 'http://localhost:8080');
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      request.workspaceId = await defaultWorkspaceId(db);
      // A bearer token (IAM-007) speaks for itself; the cookie is not looked at then.
      const bearer = bearerToken(request.headers.authorization);
      // An OAuth access token (M1-107): a frontend on another site acting as its person, with
      // everything a session may do. Expired ones are routine (the client refreshes), so they
      // do not count as failed attempts the way unknown API tokens do.
      if (bearer !== undefined && isAccessToken(bearer)) {
        const family = await resolveAccessToken(db, request.workspaceId, bearer);
        const mcp = request.routeOptions.url === '/api/v1/mcp';
        // MCP clients find the authorization server from here (RFC 9728 section 5.1).
        const metadata = mcp ? `, resource_metadata="${metadataUrl}"` : '';
        if (!family) {
          return reply
            .code(401)
            .header(
              'www-authenticate',
              `Bearer realm="taskmoor", error="invalid_token", error_description="The access token has expired or was revoked"${metadata}`,
            )
            .send({ error: 'invalid_token', reason: 'expired' });
        }
        request.authSession = { id: family.id, user: family.user };
        request.tokenFamily = { parentId: family.parentId };
        request.user = family.user;
        if (family.scope === null) {
          request.authz = authorizer.context(request.workspaceId, { userId: family.user.id });
          return;
        }
        // A registered client (M1-072; ADR-084): its scope, no administrator rights, and only
        // the MCP endpoint, besides the REST calls the MCP tools make for it.
        if (!mcp && request.headers[INNER_CALL_HEADER] !== innerCallSecret) {
          return reply
            .code(401)
            .header(
              'www-authenticate',
              'Bearer realm="taskmoor", error="invalid_token", error_description="This token is for the MCP endpoint only"',
            )
            .send({ error: 'invalid_token', reason: 'wrong_resource' });
        }
        request.authz = authorizer.context(request.workspaceId, {
          userId: family.user.id,
          withoutAdminRights: true,
        });
        const scopes = family.scope.split(' ') as ApiTokenScope[];
        const denial = scopeDenial(request.method, request.routeOptions.url, scopes);
        if (denial) {
          if (denial.error === 'insufficient_scope') {
            reply.header(
              'www-authenticate',
              `Bearer realm="taskmoor", error="insufficient_scope", scope="${denial.requiredScope}"`,
            );
          }
          return reply.code(403).send(denial);
        }
        return;
      }
      if (bearer !== undefined) {
        if (!(await authenticateBearer(db, authorizer, request, reply, bearer))) return reply;
        return;
      }
      request.authSession = await resolveSession(db, request.workspaceId, presentedToken(request));
      request.user = request.authSession?.user ?? null;
      request.authz = authorizer.context(request.workspaceId, { userId: request.user?.id ?? null });
    });
    // The IP allowlist after authentication, so members of exempt groups get in (M1-085).
    const allowlists = new Allowlists(db);
    registerAllowlist(app, db, allowlists);
    // Rate limits after authentication, so a token or a person is limited as itself (M1-066).
    const usage = new UsageRecorder(db, deps.rateLimits?.now);
    const policies = new RateLimitPolicies(db);
    if (deps.rateLimits) {
      registerRateLimits(app, {
        limiter: deps.rateLimits.limiter ?? new RateLimiter(),
        policies,
        usage,
      });
      let usageTimer: NodeJS.Timeout | undefined;
      app.addHook('onReady', async () => {
        usageTimer = setInterval(() => void usage.flush(), 10_000);
        usageTimer.unref();
      });
      app.addHook('onClose', async () => {
        clearInterval(usageTimer);
        await usage.flush();
      });
    }
    // Events emitted while handling a request record its client address.
    registerRequestScope(app);
    // Refused requests of people and tokens, audited in aggregate and alerted on (ADR-109).
    registerRefusalAudit(app, db);
    // Mutations an outbox sends with a client and mutation id run at most once (M1-032).
    registerMutationReceipts(app, db);
    // The realtime channel: where the change log stands, pushed to signed-in clients (M1-032).
    // Fastify's WebSocket routes take the upgrades co-editing passes on (below).
    if (roles.includes('realtime')) {
      await app.register(fastifyWebsocket, {
        options: { server: upgrades as unknown as Server },
      });
      registerSyncSocket(app, db, { origins });
    }
    const passwords = deps.passwords ?? passwordHasher(deps.peppers);
    const cookieOptions = { secureCookies: deps.secureCookies ?? false, passwords };
    // LDAP and Active Directory (M1-082): sign-in against them and read-write write-back.
    const directories = new DirectoryGateway(db, deps.peppers);
    registerSetupRoutes(app, db, cookieOptions);
    registerSessionRoutes(app, db, { ...cookieOptions, authorizer, directories });
    // OAuth 2.1 with PKCE for frontends on another site (M1-107, ADR-080).
    await registerOAuthRoutes(app, db, {
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      origins,
      ...(deps.accessTokenTtlMs ? { accessTtlMs: deps.accessTokenTtlMs } : {}),
    });
    registerAccountRoutes(app, db, { passwords, directories });
    registerTutorialRoutes(app, db);
    registerUserRoutes(app, db, {
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      passwords,
      directories,
    });
    registerGroupRoutes(app, db, { directories });
    registerTeamRoutes(app, db);
    registerPasswordLinkRoutes(app, db, cookieOptions);
    registerPasswordCheckRoute(app);
    registerAuthzRoutes(app, db, authorizer);
    registerSecurityAlertRoutes(app, db);
    registerTwoFactorRoutes(app, db, {
      ...cookieOptions,
      peppers: deps.peppers,
      authorizer,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
    });
    registerSsoRoutes(app, db, {
      secureCookies: cookieOptions.secureCookies,
      peppers: deps.peppers,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      origins,
      outbound,
    });
    await registerSamlRoutes(app, db, {
      secureCookies: cookieOptions.secureCookies,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      origins,
    });
    // Filled in once the boards are registered: the board a track template makes (M1-054).
    const trackHooks: TrackRouteHooks = {};
    registerTrackRoutes(app, db, fieldCatalogs, trackHooks);
    registerTicketTypeRoutes(app, db);
    registerTicketRoutes(app, db, authorizer, fieldCatalogs);
    registerRichTextRoutes(app, db, authorizer);
    registerFieldRoutes(app, db, fieldCatalogs);
    registerLayoutRoutes(app, db, fieldCatalogs);
    registerVisibilityRoutes(app, db);
    registerNotificationRoutes(app, db);
    // The in-app inbox and activity streams (M1-058).
    registerInboxRoutes(app, db);
    registerActivityRoutes(app, db);
    await registerEmailRoutes(app, db, {
      smtpConfigured: deps.smtpConfigured ?? false,
      ...(deps.smtpPassword ? { smtpPassword: deps.smtpPassword } : {}),
    });
    registerSyncRoutes(app, db, authorizer);
    registerSearchRoutes(app, db, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // Streaming export of search results (M1-042).
    registerSearchExportRoutes(app, db, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    registerPriorityRoutes(app, db);
    registerReleaseRoutes(app, db, authorizer);
    registerLinkRoutes(app, db, authorizer);
    // Entity properties (M1-129); boards and sprints register theirs with the board routes.
    registerCorePropertyRoutes(app, db);
    registerTimeRoutes(app, db, fieldCatalogs);
    registerCommentRoutes(app, db, authorizer);
    await registerAttachmentRoutes(app, db, deps.attachments ?? NO_STORAGE);
    registerWorkflowRoutes(app, db);
    registerWorkflowMapRoutes(app, db, fieldCatalogs);
    registerTrashRoutes(app, db);
    registerBulkRoutes(app, db, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { queryTimeoutMs: deps.queryTimeoutMs } : {}),
    });
    registerCloneRoutes(app, db);
    registerImportRoutes(app, db, {
      peppers: deps.peppers,
      ...(deps.importDir !== undefined ? { importDir: deps.importDir } : {}),
    });
    // The full export (M1-098): the workspace as NDJSON and files, a streamed ZIP.
    registerExportRoutes(app, db, fieldCatalogs, deps.attachments ?? NO_STORAGE);
    registerHomeRoutes(app, db, fieldCatalogs);
    // Similar tickets and duplicate suggestions from the local model (M1-078): no AI key needed.
    const embedder = deps.embedder === undefined ? sharedLocalEmbedder() : deps.embedder;
    registerSimilarRoutes(
      app,
      db,
      fieldCatalogs,
      embedder
        ? new EmbeddingService(db, embedder, {
            ...(deps.vectorSearch ? { search: deps.vectorSearch } : {}),
          })
        : null,
      // Re-ranking with reasons when a model is set up (M1-079): read at request time.
      () => app.ai,
    );
    registerGuardrailRoutes(app, db);
    // Boards (M1-043): reads go through the search compiler, moves through the ticket routes.
    const boardRoutes = registerBoardRoutes(app, db, authorizer, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    trackHooks.createBoard = boardRoutes.createBoard;
    // General reports over any query (M1-062): created vs closed, two-dimensional statistics.
    registerReportRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // Dashboards (M1-064): shared like saved searches; widgets read as the viewer.
    registerDashboardRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // A track's summary (M1-064): every number with the query it counts.
    registerTrackSummaryRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // A track's timeline (M1-048): dated tickets, roll-ups, dependencies and markers.
    registerTimelineRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // The built-in MCP server (M1-072): tools over the REST API, as the caller.
    registerMcpRoutes(app, db, {
      version: deps.version,
      innerCallSecret,
      resourceMetadataUrl: metadataUrl,
    });
    // The Jira-compatible API (M1-069, ADR-086): /rest/api/2 and /3 over the native API.
    if (deps.jiraCompat !== false) {
      await registerJiraCompat(app, {
        publicUrl: deps.publicUrl ?? 'http://localhost:8080',
        refused: (request, failure) => refuseCompatCredentials(db, request, failure),
      });
    }
    // The public meta endpoint (M1-106): versions, sign-in methods and the instance's identity.
    registerMetaRoutes(app, db, {
      version: deps.version,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      peppers: deps.peppers,
      origins,
      ...(deps.instance ? { instance: deps.instance } : {}),
    });
    // A track's list and calendar views (M1-049): format rules and dated tickets.
    registerListViewRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // The releases hub (M1-050): a release's progress, warnings and generated notes.
    registerReleaseHubRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // Saved searches (M1-063): sharing, stars and subscriptions; queries checked on save.
    registerSavedSearchRoutes(app, db, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // Links from the tracker an import came from, through its external ids (M1-128).
    registerImportedLinkRoutes(app, db);
    registerAuditRoutes(app, db, {
      hostname: new URL(deps.publicUrl ?? 'http://localhost:8080').hostname,
    });
    registerAllowlistRoutes(app, db, allowlists);
    // Frontends on other origins, registered without a restart (M1-108, ADR-087).
    registerFrontendRoutes(app, db, {
      origins,
      version: deps.version,
      servesFrontend: roles.includes('web') && deps.webDir !== undefined,
    });
    registerBackupRoutes(app, db);
    // AI provider settings and sealed credentials (M1-075; IAM-020; ADR-098), with spend
    // limits, the usage dashboard, the AI audit log and data controls (M1-077; ADR-100).
    const aiKeys = deps.aiKeys ?? aiKeyRing({ peppers: deps.peppers });
    const ai = new AiService(db, {
      ring: aiKeys.ring,
      ...(deps.aiAdapterFactory ? { adapterFactory: deps.aiAdapterFactory } : {}),
      // A provider's address is typed by an administrator: the outbound guard (ADR-110).
      adapterOptions: { fetch: outbound.fetch },
      logger: { warn: (data, message) => app.log.warn(data, message) },
      ...deps.ai,
    });
    app.ai = {
      service: ai,
      context: new AiContext(db, authorizer, fieldCatalogs, ai.settings),
      // Agent runs with budgets (M1-131), for the AI features to use.
      agents: new AgentRuns(db, ai),
    };
    registerAiRoutes(app, db, { ai, keyStorage: aiKeys.storage });
    // The AI features of v1 (M1-079): summaries, query from text, drafts and breakdown.
    registerAiFeatureRoutes(app, db, {
      ai: app.ai,
      catalogs: fieldCatalogs,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      origins: deps.allowedOrigins ?? [],
      ...(deps.ai?.now ? { now: deps.ai.now } : {}),
    });
    registerTokenRoutes(app, db);
    registerAiUsageRoutes(app, db, {
      ai,
      ...(deps.ai?.now ? { now: deps.ai.now } : {}),
    });
    registerRateLimitRoutes(app, db, {
      policies,
      usage,
      ...(deps.rateLimits?.now ? { now: deps.rateLimits.now } : {}),
    });
    registerServiceAccountRoutes(app, db);
    // A person's own data (ASVS 8.3.2, ADR-111): downloads made by the worker, and erasure.
    registerPersonalDataRoutes(app, db, deps.attachments ?? NO_STORAGE);
    await registerScimRoutes(app, db, { publicUrl: deps.publicUrl ?? 'http://localhost:8080' });
    registerDirectoryRoutes(app, db, { peppers: deps.peppers });
    // Webhooks (M1-067): registered by site administrators, delivered by the worker.
    registerWebhookRoutes(app, db, fieldCatalogs, { peppers: deps.peppers });
    // Expired sessions, used links, stale counters and long-dead tokens go at start and every
    // six hours.
    const prune = () =>
      Promise.all([
        pruneIdentityData(db),
        pruneApiTokens(db),
        pruneOAuth(db),
        purgeAiContent(db),
        pruneSecurityData(db),
      ]).catch((error) => app.log.warn({ error }, 'prune failed'));
    let pruneTimer: NodeJS.Timeout | undefined;
    // Files of deleted attachments leave this process's stores every ten minutes too, so a
    // store only the API can see (local disk on its own volume) is cleaned as well (ADR-040).
    const attachments = deps.attachments ?? NO_STORAGE;
    const sweep = () =>
      sweepStorage(db, attachments).catch((error) =>
        app.log.warn({ error }, 'attachment storage sweep failed'),
      );
    let sweepTimer: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => {
      void prune();
      pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);
      pruneTimer.unref();
      if (Object.keys(attachments.stores).length > 0) {
        sweepTimer = setInterval(sweep, 10 * 60 * 1000);
        sweepTimer.unref();
      }
    });
    app.addHook('onClose', async () => {
      clearInterval(pruneTimer);
      clearInterval(sweepTimer);
    });
    registerAdminRoutes(app, db, {
      version: deps.version,
      roles,
      startedAt: deps.startedAt ?? new Date(),
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    });
  }

  // Co-editing rich text over WebSockets (M1-017, ADR-014): the realtime role.
  app.decorate('collaboration', null);
  if (roles.includes('realtime') && deps.db && authorizer && fieldCatalogs) {
    const collaboration = new Collaboration({
      db: deps.db,
      authorizer,
      catalogs: fieldCatalogs,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      origins,
      ...(deps.collabDebounceMs !== undefined ? { debounceMs: deps.collabDebounceMs } : {}),
    });
    collaboration.attach(app, passOn);
    app.collaboration = collaboration;
  } else if (roles.includes('realtime')) {
    app.server.on('upgrade', passOn);
  }

  if (roles.includes('web') && deps.webDir) {
    await serveFrontend(app, {
      webDir: deps.webDir,
      version: deps.version,
      routing: deps.webRouting ?? 'hash',
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      mediaOrigins: deps.mediaOrigins ?? [],
      ...(deps.db ? { db: deps.db } : {}),
    });
  }

  return app;
}
