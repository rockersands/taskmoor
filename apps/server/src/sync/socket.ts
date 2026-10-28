import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { WebSocket } from 'ws';
import { logPosition } from './log';

/**
 * The realtime channel of ADR-013 (M1-032): `GET /api/v1/sync/socket` upgrades to a websocket
 * that tells a signed-in client where the change log stands, at once and whenever it moves
 * (`{"type":"position","position":"123"}`); the client then reads `/api/v1/sync/changes`, which
 * applies its permissions. The socket carries no data, so it needs no permission of its own.
 *
 * One poller per process reads the newest position of each workspace with clients every 250 ms
 * (an index-only read), well inside the one-second budget of NTF-008, instead of LISTEN/NOTIFY,
 * which would need a connection outside the pool. A handshake from another site is refused:
 * the session cookie is SameSite=Lax, and the Origin is checked against the host as well.
 */
const POLL_MS = 250;

interface Client {
  socket: WebSocket;
  position: string;
}

export function registerSyncSocket(app: FastifyInstance, db: Kysely<Database>): void {
  const clients = new Map<number, Set<Client>>();
  let timer: NodeJS.Timeout | undefined;
  let polling = false;

  const send = (client: Client, position: string) => {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.position = position;
    client.socket.send(JSON.stringify({ type: 'position', position }));
  };

  async function poll() {
    if (polling) return;
    polling = true;
    try {
      for (const [workspaceId, set] of clients) {
        const position = await logPosition(db, workspaceId);
        for (const client of set) {
          if (client.position !== position) send(client, position);
        }
      }
    } catch (error) {
      app.log.warn({ error }, 'sync socket poll failed');
    } finally {
      polling = false;
    }
  }

  const sameOrigin = (request: FastifyRequest) => {
    const origin = request.headers.origin;
    if (!origin) return true;
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  };

  app.get('/api/v1/sync/socket', { websocket: true }, async (socket, request) => {
    if (!request.user || !sameOrigin(request)) {
      socket.close(4401, request.user ? 'cross-site' : 'sign in');
      return;
    }
    const workspaceId = request.workspaceId;
    const client: Client = { socket, position: '' };
    const set = clients.get(workspaceId) ?? new Set();
    set.add(client);
    clients.set(workspaceId, set);
    timer ??= setInterval(() => void poll(), POLL_MS);
    socket.on('message', (data) => {
      if (String(data) === 'ping') socket.send(JSON.stringify({ type: 'pong' }));
    });
    socket.on('close', () => {
      set.delete(client);
      if (set.size === 0) clients.delete(workspaceId);
      if (clients.size === 0 && timer) {
        clearInterval(timer);
        timer = undefined;
      }
    });
    send(client, await logPosition(db, workspaceId));
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const set of clients.values()) for (const client of set) client.socket.close(1001);
    clients.clear();
  });
}
