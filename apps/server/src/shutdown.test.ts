import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { gracefulShutdown } from './shutdown';

describe('graceful shutdown (M1-099)', () => {
  it('[OPS-006] keep-alive clients lose no request while the server drains and closes', async () => {
    const app = Fastify();
    app.get('/ping', async () => ({ ok: true }));
    const close = gracefulShutdown(app);
    let refusing = false;
    // From here on the listener refuses new connections; behind a Service, another pod takes
    // them.
    app.addHook('preClose', async () => {
      refusing = true;
    });
    const address = await app.listen({ port: 0, host: '127.0.0.1' });

    let closed = false;
    let answered = 0;
    let closingAnswers = 0;
    const lost: string[] = [];
    async function client() {
      while (!closed) {
        try {
          const res = await fetch(`${address}/ping`);
          await res.text();
          answered++;
          if (res.headers.get('connection') === 'close') closingAnswers++;
        } catch (error) {
          const code = (error as { cause?: { code?: string } }).cause?.code ?? String(error);
          // A refused connection never reached this server; anything else lost a request it
          // had accepted.
          if (!(refusing && code === 'ECONNREFUSED')) lost.push(code);
          if (refusing) return;
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    const clients = Array.from({ length: 8 }, client);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await close(300);
    closed = true;
    await Promise.all(clients);

    expect(lost).toEqual([]);
    expect(answered).toBeGreaterThan(50);
    expect(closingAnswers).toBeGreaterThan(0);
  });
});
