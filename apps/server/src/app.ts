import type { Database } from '@tracksmith/db';
import Fastify, { type FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import type { ServerConfig } from './config';

export interface AppDeps {
  db: Kysely<Database>;
  version: string;
  logLevel?: ServerConfig['logLevel'];
}

/** Builds the HTTP app without listening, so tests can call it in-process with app.inject(). */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const level = deps.logLevel ?? 'silent';
  const app = Fastify({ logger: level === 'silent' ? false : { level } });

  // Liveness: the process is up. Never touches dependencies, so restarts are not triggered by
  // a slow database.
  app.get('/health', async () => ({ status: 'ok', version: deps.version }));

  // Readiness: the process can serve traffic. Load balancers stop routing here on 503.
  app.get('/ready', async (_request, reply) => {
    try {
      await sql`SELECT 1`.execute(deps.db);
      return { status: 'ready' };
    } catch {
      return reply.code(503).send({ status: 'unavailable', reason: 'database' });
    }
  });

  return app;
}
