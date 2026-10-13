import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

/**
 * What a request handler's work may need to know about the request without having it passed
 * down: today the client address, which every domain event emitted while handling the request
 * records (and the audit log shows). Outside a request (the CLI, jobs) there is no scope.
 */
export interface RequestScope {
  ip: string;
}

const storage = new AsyncLocalStorage<RequestScope>();

export function currentRequestScope(): RequestScope | undefined {
  return storage.getStore();
}

/**
 * Opens the scope for every route handler. A preHandler hook in callback style runs the rest
 * of the chain (the handler included) inside the scope; body parsing is done by then, so the
 * stream callbacks of the request body cannot lose it.
 */
export function registerRequestScope(app: FastifyInstance): void {
  app.addHook('preHandler', (request, _reply, done) => {
    storage.run({ ip: request.ip }, done);
  });
}
