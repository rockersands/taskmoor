import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

/**
 * What a request handler's work may need to know about the request without having it passed
 * down: the client address and User-Agent, which every domain event emitted while handling the
 * request records (the audit log shows the address; security notices both). Outside a request (the CLI, jobs) there is no scope.
 */
export interface RequestScope {
  ip: string;
  /** The User-Agent header, cut to 400 characters (ADR-109): security notices name it. */
  userAgent: string | null;
}

/** A request's User-Agent as events and audit records keep it. */
export function userAgentOf(headers: {
  'user-agent'?: string | string[] | undefined;
}): string | null {
  const value = headers['user-agent'];
  const text = Array.isArray(value) ? value[0] : value;
  return text ? text.slice(0, 400) : null;
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
    storage.run({ ip: request.ip, userAgent: userAgentOf(request.headers) }, done);
  });
}
