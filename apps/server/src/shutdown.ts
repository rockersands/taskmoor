import type { FastifyInstance } from 'fastify';

/**
 * Graceful shutdown for keep-alive clients (M1-099). Closing the listener also closes idle
 * keep-alive connections, and a client that reuses one at that moment loses its request with
 * a reset. So shutdown first drains: for a short while every answer carries
 * `Connection: close`, each client hangs up after its next answer and reconnects (behind a
 * Service, to another pod), and only then does the server close.
 */
export function gracefulShutdown(app: FastifyInstance): (drainMs: number) => Promise<void> {
  let draining = false;
  app.addHook('onSend', async (_request, reply) => {
    if (draining) reply.header('connection', 'close');
  });
  return async (drainMs) => {
    draining = true;
    if (drainMs > 0) await new Promise((resolve) => setTimeout(resolve, drainMs));
    await app.close();
  };
}
