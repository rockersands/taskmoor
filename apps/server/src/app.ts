import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import type { IncomingMessage, Server } from 'node:http';
import { resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import type { Tracer } from '@opentelemetry/api';
import type { Database } from '@taskmoor/db';
import { type PasswordHasher, type PepperRing, passwordHasher } from '@taskmoor/iam';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { sweepStorage } from './attachments/cleanup';
import { type AttachmentStores, NO_STORAGE } from './attachments/stores';
import { presentedToken, resolveSession } from './auth';
import { Authorizer } from './authz/authorizer';
import { Collaboration } from './collab/server';
import type { Role, ServerConfig } from './config';
import { FieldCatalogs } from './fields/catalog';
import { GuardrailExceeded } from './guardrails/model';
import { DirectoryGateway } from './ldap/gateway';
import { instrumentApp, type Metrics } from './observability';
import { registerRequestScope } from './request-scope';
import { registerAccountRoutes } from './routes/account';
import { registerActivityRoutes } from './routes/activity';
import { registerAdminRoutes } from './routes/admin';
import { registerAttachmentRoutes } from './routes/attachments';
import { registerAuditRoutes } from './routes/audit';
import { registerAuthzRoutes } from './routes/authz';
import { registerBackupRoutes } from './routes/backups';
import { registerBoardRoutes } from './routes/boards';
import { registerBulkRoutes } from './routes/bulk';
import { registerCommentRoutes } from './routes/comments';
import { registerDashboardRoutes } from './routes/dashboards';
import { registerDirectoryRoutes } from './routes/directories';
import { registerEmailRoutes } from './routes/email';
import { registerFieldRoutes } from './routes/fields';
import { registerGroupRoutes } from './routes/groups';
import { registerGuardrailRoutes } from './routes/guardrails';
import { registerHomeRoutes } from './routes/home';
import { registerImportRoutes } from './routes/imports';
import { registerInboxRoutes } from './routes/inbox';
import { registerLayoutRoutes } from './routes/layouts';
import { registerLinkRoutes } from './routes/links';
import { registerNotificationRoutes } from './routes/notifications';
import { registerPasswordCheckRoute, registerPasswordLinkRoutes } from './routes/password-links';
import { registerPriorityRoutes } from './routes/priorities';
import { registerReleaseHubRoutes } from './routes/release-hub';
import { registerReleaseRoutes } from './routes/releases';
import { registerReportRoutes } from './routes/reports';
import { registerRichTextRoutes } from './routes/rich-text';
import { registerSamlRoutes } from './routes/saml';
import { registerSavedSearchRoutes } from './routes/saved-searches';
import { registerScimRoutes } from './routes/scim';
import { registerSearchRoutes } from './routes/search';
import { registerSearchExportRoutes } from './routes/search-export';
import { registerServiceAccountRoutes } from './routes/service-accounts';
import { registerSessionRoutes } from './routes/session';
import { registerSetupRoutes } from './routes/setup';
import { registerSsoRoutes } from './routes/sso';
import { registerSyncRoutes } from './routes/sync';
import { registerTicketTypeRoutes } from './routes/ticket-types';
import { registerTicketRoutes } from './routes/tickets';
import { registerTimeRoutes } from './routes/time';
import { registerTokenRoutes } from './routes/tokens';
import { registerTrackSummaryRoutes } from './routes/track-summary';
import { registerTrackRoutes } from './routes/tracks';
import { registerTrashRoutes } from './routes/trash';
import { registerTwoFactorRoutes } from './routes/two-factor';
import { registerUserRoutes } from './routes/users';
import { registerVisibilityRoutes } from './routes/visibility';
import { registerWebhookRoutes } from './routes/webhooks';
import { registerWorkflowMapRoutes } from './routes/workflow-maps';
import { registerWorkflowRoutes } from './routes/workflows';
import { registerMutationReceipts } from './sync/mutations';
import { registerSyncSocket } from './sync/socket';
import { pruneIdentityData } from './throttle';
import { bearerToken, pruneApiTokens } from './tokens/api-tokens';
import { authenticateBearer } from './tokens/bearer';
import { defaultWorkspaceId } from './workspace';

declare module 'fastify' {
  interface FastifyInstance {
    /** Every registered route as "METHOD /path". */
    routeTable: string[];
    /** Real-time co-editing (M1-017), when this process has the realtime role. */
    collaboration: Collaboration | null;
  }
}

export interface AppDeps {
  /** Absent only for a process that serves nothing but the frontend. */
  db?: Kysely<Database>;
  version: string;
  logLevel?: ServerConfig['logLevel'];
  /** Defaults to the API alone, which is what tests exercise. */
  roles?: readonly Role[];
  /** Built frontend to serve under `/` when the web role is on. */
  webDir?: string;
  /** Mark session cookies Secure (true behind HTTPS; tests and plain-HTTP trials say false). */
  secureCookies?: boolean;
  /** Where browsers reach this instance; one-time links point here. */
  publicUrl?: string;
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
  /** Request latency goes here (ADR-023). */
  metrics?: Metrics;
  /** Requests open server spans with it (ADR-023); absent when tracing is off. */
  tracer?: Tracer;
  /** Instance data directory, for the admin status page. */
  dataDir?: string;
  /** When the process started; defaults to when the app was built. */
  startedAt?: Date;
  /** Where attachments are stored (ADR-040); without one, uploads answer 503. */
  attachments?: AttachmentStores;
  /** Whether an SMTP server is configured for email notifications (M1-057). */
  smtpConfigured?: boolean;
  /** Quiet time before collaborative edits are saved (M1-017); tests shorten it. */
  collabDebounceMs?: number;
  /** How long a search statement may run, in milliseconds (QRY-010; default 30 s). */
  queryTimeoutMs?: number;
}

/** Builds the HTTP app without listening, so tests can call it in-process with app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const level = deps.logLevel ?? 'silent';
  const roles = deps.roles ?? ['api'];
  const app = Fastify({
    logger: level === 'silent' ? false : { level },
    ...(deps.trustedProxies ? { trustProxy: deps.trustedProxies } : {}),
  });
  // Every route as "METHOD /path", for fitness tests (every mutation emits one event).
  const routes: string[] = [];
  app.decorate('routeTable', routes);
  app.addHook('onRoute', (route) => {
    for (const method of [route.method].flat()) routes.push(`${method} ${route.url}`);
  });
  instrumentApp(app, {
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
  });
  await app.register(fastifyCookie);
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

  if (roles.includes('api') && deps.db && authorizer && fieldCatalogs) {
    const db = deps.db;
    app.decorateRequest('user', null);
    app.decorateRequest('authSession', null);
    app.decorateRequest('apiToken', null);
    app.decorateRequest('workspaceId', 0);
    app.decorateRequest('authz', null as unknown as never);
    app.addHook('onRequest', async (request, reply) => {
      if (!request.url.startsWith('/api/')) return;
      request.workspaceId = await defaultWorkspaceId(db);
      // A bearer token (IAM-007) speaks for itself; the cookie is not looked at then.
      const bearer = bearerToken(request.headers.authorization);
      if (bearer !== undefined) {
        if (!(await authenticateBearer(db, authorizer, request, reply, bearer))) return reply;
        return;
      }
      request.authSession = await resolveSession(db, request.workspaceId, presentedToken(request));
      request.user = request.authSession?.user ?? null;
      request.authz = authorizer.context(request.workspaceId, { userId: request.user?.id ?? null });
    });
    // Events emitted while handling a request record its client address.
    registerRequestScope(app);
    // Mutations an outbox sends with a client and mutation id run at most once (M1-032).
    registerMutationReceipts(app, db);
    // The realtime channel: where the change log stands, pushed to signed-in clients (M1-032).
    // Fastify's WebSocket routes take the upgrades co-editing passes on (below).
    if (roles.includes('realtime')) {
      await app.register(fastifyWebsocket, {
        options: { server: upgrades as unknown as Server },
      });
      registerSyncSocket(app, db);
    }
    const passwords = deps.passwords ?? passwordHasher(deps.peppers);
    const cookieOptions = { secureCookies: deps.secureCookies ?? false, passwords };
    // LDAP and Active Directory (M1-082): sign-in against them and read-write write-back.
    const directories = new DirectoryGateway(db, deps.peppers);
    registerSetupRoutes(app, db, cookieOptions);
    registerSessionRoutes(app, db, { ...cookieOptions, authorizer, directories });
    registerAccountRoutes(app, db, { passwords, directories });
    registerUserRoutes(app, db, {
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      passwords,
      directories,
    });
    registerGroupRoutes(app, db, { directories });
    registerPasswordLinkRoutes(app, db, cookieOptions);
    registerPasswordCheckRoute(app);
    registerAuthzRoutes(app, db, authorizer);
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
    });
    await registerSamlRoutes(app, db, {
      secureCookies: cookieOptions.secureCookies,
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
    });
    registerTrackRoutes(app, db, fieldCatalogs);
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
    await registerEmailRoutes(app, db, { smtpConfigured: deps.smtpConfigured ?? false });
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
    registerTimeRoutes(app, db, fieldCatalogs);
    registerCommentRoutes(app, db, authorizer);
    await registerAttachmentRoutes(app, db, deps.attachments ?? NO_STORAGE);
    registerWorkflowRoutes(app, db);
    registerWorkflowMapRoutes(app, db, fieldCatalogs);
    registerTrashRoutes(app, db);
    registerBulkRoutes(app, db, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { queryTimeoutMs: deps.queryTimeoutMs } : {}),
    });
    registerImportRoutes(app, db);
    registerHomeRoutes(app, db, fieldCatalogs);
    registerGuardrailRoutes(app, db);
    // Boards (M1-043): reads go through the search compiler, moves through the ticket routes.
    registerBoardRoutes(app, db, authorizer, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
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
    // The releases hub (M1-050): a release's progress, warnings and generated notes.
    registerReleaseHubRoutes(app, db, {
      catalogs: fieldCatalogs,
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    // Saved searches (M1-063): sharing, stars and subscriptions; queries checked on save.
    registerSavedSearchRoutes(app, db, fieldCatalogs, {
      ...(deps.queryTimeoutMs !== undefined ? { timeoutMs: deps.queryTimeoutMs } : {}),
    });
    registerAuditRoutes(app, db);
    registerBackupRoutes(app, db);
    registerTokenRoutes(app, db);
    registerServiceAccountRoutes(app, db);
    await registerScimRoutes(app, db, { publicUrl: deps.publicUrl ?? 'http://localhost:8080' });
    registerDirectoryRoutes(app, db, { peppers: deps.peppers });
    // Webhooks (M1-067): registered by site administrators, delivered by the worker.
    registerWebhookRoutes(app, db, fieldCatalogs, { peppers: deps.peppers });
    // Expired sessions, used links, stale counters and long-dead tokens go at start and every
    // six hours.
    const prune = () =>
      Promise.all([pruneIdentityData(db), pruneApiTokens(db)]).catch((error) =>
        app.log.warn({ error }, 'prune failed'),
      );
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
      ...(deps.collabDebounceMs !== undefined ? { debounceMs: deps.collabDebounceMs } : {}),
    });
    collaboration.attach(app, passOn);
    app.collaboration = collaboration;
  } else if (roles.includes('realtime')) {
    app.server.on('upgrade', passOn);
  }

  if (roles.includes('web') && deps.webDir) {
    await serveFrontend(app, deps.webDir);
  }

  return app;
}

/**
 * The static frontend (ADR-021, single-server mode): files from the build, and the app shell
 * for every other GET that is not an API or probe path, so deep links such as /browse/ABC-1
 * load. API paths keep their JSON 404 so a client never mistakes HTML for a missing resource.
 */
async function serveFrontend(app: FastifyInstance, webDir: string): Promise<void> {
  const root = resolve(webDir);
  if (!existsSync(resolve(root, 'index.html'))) {
    throw new Error(`TASKMOOR_WEB_DIR has no index.html: ${root}`);
  }
  await app.register(fastifyStatic, { root, wildcard: false, index: ['index.html'] });
  app.setNotFoundHandler((request, reply) => {
    const path = request.url.split('?')[0] ?? '';
    const isApp =
      request.method === 'GET' &&
      !path.startsWith('/api/') &&
      path !== '/health' &&
      path !== '/ready' &&
      (request.headers.accept ?? '').includes('text/html');
    if (isApp) return reply.type('text/html').sendFile('index.html');
    return reply.code(404).send({
      message: `Route ${request.method}:${path} not found`,
      error: 'Not Found',
      statusCode: 404,
    });
  });
}
