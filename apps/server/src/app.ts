import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { Database } from '@tracksmith/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import type { Role, ServerConfig } from './config';

export interface AppDeps {
  /** Absent only for a process that serves nothing but the frontend. */
  db?: Kysely<Database>;
  version: string;
  logLevel?: ServerConfig['logLevel'];
  /** Defaults to the API alone, which is what tests exercise. */
  roles?: readonly Role[];
  /** Built frontend to serve under `/` when the web role is on. */
  webDir?: string;
}

/** Builds the HTTP app without listening, so tests can call it in-process with app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const level = deps.logLevel ?? 'silent';
  const roles = deps.roles ?? ['api'];
  const app = Fastify({ logger: level === 'silent' ? false : { level } });

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
    throw new Error(`TRACKSMITH_WEB_DIR has no index.html: ${root}`);
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
