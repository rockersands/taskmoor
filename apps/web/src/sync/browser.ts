import { API_BASE, api, apiFetch, openSocket } from '../api/client';
import type { PositionSocket, SyncApi, SyncChange } from './engine';
import type { OutboxEntry, SyncTrack, TicketSnapshot } from './store';

/** The sync endpoints of the server (M1-031, M1-032). */
export const browserSyncApi: SyncApi = {
  groups: () => api<{ position: string; tracks: SyncTrack[] }>('/sync/groups'),
  bootstrap: (track, after) =>
    api<{ position: string; tickets: TicketSnapshot[]; next: number | null }>(
      `/sync/bootstrap?track=${track}&after=${after}&limit=1000`,
    ),
  changes: (after) =>
    api<{ changes: SyncChange[]; position: string; resync: boolean }>(
      `/sync/changes?after=${after}&limit=1000`,
    ),
  send: async (entry: OutboxEntry, clientId: string) => {
    const response = await apiFetch(`${API_BASE}${entry.path}`, {
      method: entry.method,
      headers: {
        'taskmoor-client-id': clientId,
        'taskmoor-mutation-id': entry.mutationId,
        ...(entry.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(entry.body !== undefined ? { body: JSON.stringify(entry.body) } : {}),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { status: response.status, body };
  },
};

/** The realtime socket on the backend. */
export function browserSocket(): PositionSocket {
  const socket = openSocket('/sync/socket');
  const keepAlive = setInterval(() => {
    if (socket.readyState === WebSocket.OPEN) socket.send('ping');
  }, 25_000);
  return {
    onPosition: (handler) => {
      socket.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(String(event.data)) as { type?: string; position?: string };
          if (message.type === 'position' && message.position) handler(message.position);
        } catch {
          // Not ours: ignore.
        }
      });
    },
    onClose: (handler) => {
      socket.addEventListener('close', () => {
        clearInterval(keepAlive);
        handler();
      });
    },
    close: () => {
      clearInterval(keepAlive);
      socket.close();
    },
  };
}
