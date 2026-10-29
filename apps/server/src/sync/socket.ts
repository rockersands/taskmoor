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
 *
 * The same poll tells each person's open inboxes when their inbox changed (M1-058, NTF-003):
 * `{"type":"inbox","version":"7"}` at once and whenever their `inbox_state` counter moves (a
 * new item, or one read or snoozed elsewhere); the client then reads `/api/v1/inbox`, which
 * judges every item by its permissions. One primary-key read per workspace and poll.
 */
const POLL_MS = 250;

interface Client {
  socket: WebSocket;
  position: string;
  userId: number;
  inbox: string;
}

/** The inbox counters of these people; absent for one whose inbox never changed. */
async function inboxVersions(
  db: Kysely<Database>,
  userIds: readonly number[],
): Promise<Map<number, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db
    .selectFrom('inbox_state')
    .select(['user_id', 'version'])
    .where('user_id', 'in', [...userIds])
    .execute();
  return new Map(rows.map((r) => [r.user_id, String(r.version)]));
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
  const sendInbox = (client: Client, version: string) => {
    if (client.socket.readyState !== client.socket.OPEN) return;
    client.inbox = version;
    client.socket.send(JSON.stringify({ type: 'inbox', version }));
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
        const versions = await inboxVersions(db, [...new Set([...set].map((c) => c.userId))]);
        for (const client of set) {
          const version = versions.get(client.userId) ?? '0';
          if (client.inbox !== version) sendInbox(client, version);
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
    const client: Client = { socket, position: '', userId: request.user.id, inbox: '' };
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
    sendInbox(client, (await inboxVersions(db, [client.userId])).get(client.userId) ?? '0');
  });

  app.addHook('onClose', async () => {
    if (timer) clearInterval(timer);
    timer = undefined;
    for (const set of clients.values()) for (const client of set) client.socket.close(1001);
    clients.clear();
  });
}
