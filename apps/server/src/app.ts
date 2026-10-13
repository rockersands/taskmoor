import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import type { Tracer } from '@opentelemetry/api';
import type { Database } from '@taskmoor/db';
import { type PasswordHasher, passwordHasher } from '@taskmoor/iam';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { presentedToken, resolveSession } from './auth';
import { Authorizer } from './authz/authorizer';
import type { Role, ServerConfig } from './config';
import { instrumentApp, type Metrics } from './observability';
import { registerAccountRoutes } from './routes/account';
import { registerAdminRoutes } from './routes/admin';
import { registerAuthzRoutes } from './routes/authz';
import { registerGroupRoutes } from './routes/groups';
import { registerPasswordCheckRoute, registerPasswordLinkRoutes } from './routes/password-links';
import { registerSessionRoutes } from './routes/session';
import { registerSetupRoutes } from './routes/setup';
import { registerUserRoutes } from './routes/users';
import { pruneIdentityData } from './throttle';
import { defaultWorkspaceId } from './workspace';

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
  /** Request latency goes here (ADR-023). */
  metrics?: Metrics;
  /** Requests open server spans with it (ADR-023); absent when tracing is off. */
  tracer?: Tracer;
  /** Instance data directory, for the admin status page. */
  dataDir?: string;
  /** When the process started; defaults to when the app was built. */
  startedAt?: Date;
}

/** Builds the HTTP app without listening, so tests can call it in-process with app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const level = deps.logLevel ?? 'silent';
  const roles = deps.roles ?? ['api'];
  const app = Fastify({
    logger: level === 'silent' ? false : { level },
    ...(deps.trustedProxies ? { trustProxy: deps.trustedProxies } : {}),
  });
  instrumentApp(app, {
    ...(deps.metrics ? { metrics: deps.metrics } : {}),
    ...(deps.tracer ? { tracer: deps.tracer } : {}),
  });
  await app.register(fastifyCookie);

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

  if (roles.includes('api') && deps.db) {
    const db = deps.db;
    app.decorateRequest('user', null);
    app.decorateRequest('authSession', null);
    app.decorateRequest('workspaceId', 0);
    app.decorateRequest('authz', null as unknown as never);
    const authorizer = deps.authorizer ?? new Authorizer(db);
    app.addHook('onRequest', async (request) => {
      if (!request.url.startsWith('/api/')) return;
      request.workspaceId = await defaultWorkspaceId(db);
      request.authSession = await resolveSession(db, request.workspaceId, presentedToken(request));
      request.user = request.authSession?.user ?? null;
      request.authz = authorizer.context(request.workspaceId, { userId: request.user?.id ?? null });
    });
    const passwords = deps.passwords ?? passwordHasher();
    const cookieOptions = { secureCookies: deps.secureCookies ?? false, passwords };
    registerSetupRoutes(app, db, cookieOptions);
    registerSessionRoutes(app, db, cookieOptions);
    registerAccountRoutes(app, db, { passwords });
    registerUserRoutes(app, db, {
      publicUrl: deps.publicUrl ?? 'http://localhost:8080',
      passwords,
    });
    registerGroupRoutes(app, db);
    registerPasswordLinkRoutes(app, db, cookieOptions);
    registerPasswordCheckRoute(app);
    registerAuthzRoutes(app, db, authorizer);
    // Expired sessions, used links and stale counters go at start and every six hours.
    const prune = () =>
      pruneIdentityData(db).catch((error) => app.log.warn({ error }, 'prune failed'));
    let pruneTimer: NodeJS.Timeout | undefined;
    app.addHook('onReady', async () => {
      void prune();
      pruneTimer = setInterval(prune, 6 * 60 * 60 * 1000);
      pruneTimer.unref();
    });
    app.addHook('onClose', async () => clearInterval(pruneTimer));
    registerAdminRoutes(app, db, {
      version: deps.version,
      roles,
      startedAt: deps.startedAt ?? new Date(),
      ...(deps.dataDir ? { dataDir: deps.dataDir } : {}),
    });
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
