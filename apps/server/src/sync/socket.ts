import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { WebSocket } from 'ws';
import { isAccessToken, resolveAccessToken } from '../oauth/tokens';
import type { OriginPolicy } from '../origins';
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
 * the session cookie is SameSite=Lax, and the Origin must be this instance's own or an allowed
 * frontend's (M1-107, ADR-080). A frontend on another site has no cookie here: it opens
 * `?auth=bearer` and sends `{"type":"auth","token":"<access token>"}` first, within ten seconds.
 *
 * The same poll tells each person's open inboxes when their inbox changed (M1-058, NTF-003):
 * `{"type":"inbox","version":"7"}` at once and whenever their `inbox_state` counter moves (a
 * new item, or one read or snoozed elsewhere); the client then reads `/api/v1/inbox`, which
 * judges every item by its permissions. One primary-key read per workspace and poll.
 */
const POLL_MS = 250;
const AUTH_WAIT_MS = 10_000;

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

/**
 * The person a bearer socket's first message signs in with its access token, or null. The
 * listener goes on at once, before any await, so the message cannot slip past.
 */
function signInByMessage(
  socket: WebSocket,
  db: Kysely<Database>,
  workspaceId: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const done = (userId: number | null) => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      resolve(userId);
    };
    const onClose = () => done(null);
    const onMessage = (data: unknown) => {
      let token: unknown;
      try {
        token = (JSON.parse(String(data)) as { type?: unknown; token?: unknown }).token;
      } catch {
        token = undefined;
      }
      if (typeof token !== 'string' || !isAccessToken(token)) {
        done(null);
        return;
      }
      resolveAccessToken(db, workspaceId, token).then(
        (family) => done(family?.user.id ?? null),
        () => done(null),
      );
    };
    const timer = setTimeout(() => done(null), AUTH_WAIT_MS);
    socket.on('message', onMessage);
    socket.on('close', onClose);
  });
}

export function registerSyncSocket(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: { origins: OriginPolicy },
): void {
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

  // The origin check before this handler read the list just now; the handler must not wait
  // before it listens, or the bearer socket's first message would be lost.
  const allowed = (request: FastifyRequest) =>
    options.origins.latest.allowsSocket(request.headers.origin, request.headers.host);
  const bearer = (request: FastifyRequest) =>
    (request.query as { auth?: unknown } | undefined)?.auth === 'bearer';

  app.get('/api/v1/sync/socket', { websocket: true }, async (socket, request) => {
    const workspaceId = request.workspaceId;
    const waiting =
      !request.user && bearer(request) && allowed(request)
        ? signInByMessage(socket, db, workspaceId)
        : null;
    if (!allowed(request)) {
      socket.close(4401, 'cross-site');
      return;
    }
    const userId = request.user?.id ?? (waiting ? await waiting : null);
    if (userId === null) {
      socket.close(4401, 'sign in');
      return;
    }
    const client: Client = { socket, position: '', userId, inbox: '' };
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
