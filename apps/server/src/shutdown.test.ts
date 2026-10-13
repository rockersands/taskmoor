import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { gracefulShutdown } from './shutdown';

describe('graceful shutdown (M1-099)', () => {
  it('[OPS-006] keep-alive clients lose no request while a pod drains and closes', async () => {
    // Two pods behind a Service: once the stopping pod has left the Service, a client's new
    // connections reach the other pod, while connections it already holds stay where they are.
    const stopping = Fastify();
    const staying = Fastify();
    for (const pod of [stopping, staying]) pod.get('/ping', async () => ({ ok: true }));
    const close = gracefulShutdown(stopping);
    const oldPod = await stopping.listen({ port: 0, host: '127.0.0.1' });
    const otherPod = await staying.listen({ port: 0, host: '127.0.0.1' });

    let done = false;
    let answered = 0;
    let closingAnswers = 0;
    const lost: string[] = [];
    async function client() {
      // The connection this client keeps alive; it moves only when the pod hangs up.
      let target = oldPod;
      while (!done) {
        try {
          const res = await fetch(`${target}/ping`);
          await res.text();
          answered++;
          if (res.headers.get('connection') === 'close') {
            closingAnswers++;
            target = otherPod;
          }
        } catch (error) {
          const code = (error as { cause?: { code?: string } }).cause?.code ?? String(error);
          // A refused connection reached nobody; it would go to the other pod. Anything else
          // lost a request the stopping pod had accepted.
          if (code === 'ECONNREFUSED') target = otherPod;
          else lost.push(code);
        }
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    }
    const clients = Array.from({ length: 8 }, client);
    await new Promise((resolve) => setTimeout(resolve, 200));
    await close(300);
    await new Promise((resolve) => setTimeout(resolve, 50));
    done = true;
    await Promise.all(clients);
    await staying.close();

    expect(lost).toEqual([]);
    expect(answered).toBeGreaterThan(50);
    // Every client was told to reconnect before the pod closed.
    expect(closingAnswers).toBe(8);
  });
});
