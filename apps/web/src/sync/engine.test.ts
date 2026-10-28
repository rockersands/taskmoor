import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { PositionSocket, SyncApi, SyncChange } from './engine';
import { SyncEngine } from './engine';
import {
  deleteSyncDatabase,
  indexedDbStore,
  memoryStore,
  type OutboxEntry,
  type SyncStore,
  type TicketSnapshot,
} from './store';

/**
 * A server as the engine sees it: tickets, a change log with positions, mutations applied at
 * most once per (client, mutation) pair, and a network that can fail before or after the server
 * has done its work.
 */
class FakeServer {
  tickets = new Map<number, TicketSnapshot>();
  log: SyncChange[] = [];
  seq = 0;
  receipts = new Map<string, { status: number; body: unknown }>();
  applied = 0;
  network: 'up' | 'down' | 'lose-answers' = 'up';
  trimmedBelow = 0;

  write(ticket: TicketSnapshot) {
    this.tickets.set(ticket.id, ticket);
    this.log.push({
      seq: String(++this.seq),
      entity: 'ticket',
      id: ticket.id,
      trackId: ticket.track_id,
      op: 'upsert',
      data: { ...ticket },
    });
  }
  remove(id: number) {
    const t = this.tickets.get(id);
    this.tickets.delete(id);
    this.log.push({
      seq: String(++this.seq),
      entity: 'ticket',
      id,
      trackId: t?.track_id ?? 1,
      op: 'delete',
    });
  }
  authz() {
    this.log.push({ seq: String(++this.seq), entity: 'authz', id: 1, trackId: null, op: 'upsert' });
  }

  api(): SyncApi {
    return {
      groups: async () => ({
        position: String(this.seq),
        tracks: [{ id: 1, key: 'ABC', name: 'ABC' }],
      }),
      bootstrap: async (_track, after) => {
        const all = [...this.tickets.values()]
          .filter((t) => t.id > after)
          .sort((a, b) => a.id - b.id);
        const page = all.slice(0, 2);
        return {
          position: String(this.seq),
          tickets: page.map((t) => ({ ...t })),
          next: all.length > 2 ? (page[1]?.id ?? null) : null,
        };
      },
      changes: async (after) => {
        if (Number(after) < this.trimmedBelow)
          return { changes: [], position: after, resync: true };
        const rows = this.log.filter((c) => Number(c.seq) > Number(after)).slice(0, 3);
        return {
          changes: rows.map((c) => ({ ...c })),
          position: rows.length === 3 ? (rows[2]?.seq as string) : String(this.seq),
          resync: false,
        };
      },
      send: async (entry: OutboxEntry, clientId: string) => {
        if (this.network === 'down') throw new TypeError('Failed to fetch');
        const key = `${clientId}/${entry.mutationId}`;
        let answer = this.receipts.get(key);
        if (!answer) {
          const body = entry.body as { summary?: string };
          const id = Number(entry.path.split('/').pop());
          const ticket = this.tickets.get(id);
          if (!ticket || body.summary === '') {
            answer = { status: 400, body: { error: 'invalid_fields' } };
          } else {
            this.applied++;
            this.write({ ...ticket, summary: body.summary ?? ticket.summary });
            answer = { status: 200, body: { ok: true } };
          }
          this.receipts.set(key, answer);
        }
        if (this.network === 'lose-answers') throw new TypeError('connection reset');
        return answer;
      },
    };
  }
}

const ticket = (id: number, summary = `Ticket ${id}`): TicketSnapshot => ({
  id,
  track_id: 1,
  number: id,
  summary,
  deleted_at: null,
});

async function contents(store: SyncStore) {
  return (await store.tickets()).map((t) => `${t.id}:${t.summary}`).sort();
}
const truth = (server: FakeServer) =>
  [...server.tickets.values()].map((t) => `${t.id}:${t.summary}`).sort();

describe('sync engine (M1-032)', () => {
  it('[NTF-008] bootstraps in pages, then follows the log to the same state as the server', async () => {
    const server = new FakeServer();
    for (let i = 1; i <= 5; i++) server.write(ticket(i));
    const store = memoryStore();
    const engine = new SyncEngine({ api: server.api(), store, newId: () => 'client' });
    await engine.start();
    expect(await contents(store)).toEqual(truth(server));
    server.write(ticket(2, 'Renamed'));
    server.remove(4);
    server.write(ticket(6));
    server.write(ticket(6, 'Six, renamed'));
    await engine.pull();
    expect(await contents(store)).toEqual(truth(server));
    expect(engine.position).toBe(String(server.seq));
    expect(await engine.ticketByKey('ABC-6')).toMatchObject({ summary: 'Six, renamed' });
    expect(await engine.ticketByKey('XYZ-6')).toBeNull();
    engine.stop();
  });

  it('[NTF-008] reads on when the socket says the log moved', async () => {
    const server = new FakeServer();
    server.write(ticket(1));
    let push: (position: string) => void = () => {};
    const socket: PositionSocket = {
      onPosition: (handler) => {
        push = handler;
      },
      onClose: () => {},
      close: () => {},
    };
    const store = memoryStore();
    const engine = new SyncEngine({ api: server.api(), store, connect: () => socket });
    await engine.start();
    const changed = new Promise<void>((resolve) => engine.subscribe(resolve));
    server.write(ticket(1, 'Pushed'));
    push(String(server.seq));
    await changed;
    expect(await contents(store)).toEqual(['1:Pushed']);
    engine.stop();
  });

  it('[NTF-008] an authorization change or a trimmed log starts a new bootstrap', async () => {
    const server = new FakeServer();
    server.write(ticket(1));
    server.write(ticket(2));
    const store = memoryStore();
    const engine = new SyncEngine({ api: server.api(), store });
    await engine.start();
    // The person lost ticket 2 through a permission change, which writes no ticket row.
    server.tickets.delete(2);
    server.authz();
    await engine.pull();
    expect(await contents(store)).toEqual(['1:Ticket 1']);
    server.write(ticket(3));
    server.trimmedBelow = server.seq + 1;
    await engine.pull();
    expect(await contents(store)).toEqual(truth(server));
    engine.stop();
  });

  it('[NTF-008] queues edits offline, shows them at once, and sends each exactly once', async () => {
    const server = new FakeServer();
    server.write(ticket(1));
    const store = memoryStore();
    let n = 0;
    const engine = new SyncEngine({ api: server.api(), store, newId: () => `id-${++n}` });
    await engine.start();
    server.network = 'down';
    for (const summary of ['First', 'Second', 'Third']) {
      await engine.mutate(
        { method: 'PATCH', path: '/tickets/1', body: { summary } },
        (t) => ({ ...t, summary }),
        1,
      );
    }
    // Shown at once, kept in order for later.
    expect(await contents(store)).toEqual(['1:Third']);
    expect((await store.outbox()).map((e) => (e.body as { summary: string }).summary)).toEqual([
      'First',
      'Second',
      'Third',
    ]);
    // The server does the work but the answers are lost: the next attempt replays, not reruns.
    server.network = 'lose-answers';
    await engine.flush();
    expect(server.applied).toBe(1);
    server.network = 'up';
    await engine.flush();
    expect(server.applied).toBe(3);
    expect(await store.outbox()).toEqual([]);
    expect(await contents(store)).toEqual(['1:Third']);
    expect(truth(server)).toEqual(['1:Third']);
    engine.stop();
  });

  it('[NTF-008] a refused edit leaves the outbox, is reported, and the truth comes back', async () => {
    const server = new FakeServer();
    server.write(ticket(1, 'Kept'));
    const store = memoryStore();
    const engine = new SyncEngine({ api: server.api(), store });
    await engine.start();
    const refusals: number[] = [];
    engine.onRefusal((r) => refusals.push(r.status));
    // Nothing changes on the server, so the log has nothing to send back: the truth is the
    // last snapshot, which a new write makes the engine read.
    await engine.mutate(
      { method: 'PATCH', path: '/tickets/1', body: { summary: '' } },
      (t) => ({ ...t, summary: '' }),
      1,
    );
    expect(refusals).toEqual([400]);
    expect(await store.outbox()).toEqual([]);
    server.write(ticket(1, 'Kept'));
    await engine.pull();
    expect(await contents(store)).toEqual(['1:Kept']);
    engine.stop();
  });

  it('[NTF-008] keeps the local copy in IndexedDB, one database per person', async () => {
    const name = 'taskmoor-sync-test';
    const store = await indexedDbStore(name);
    await store.setMeta({
      position: '7',
      tracks: [{ id: 1, key: 'ABC', name: 'ABC' }],
      clientId: 'c',
    });
    await store.apply([ticket(1), ticket(2)], []);
    await store.apply([ticket(2, 'Two')], [1]);
    await store.enqueue({ mutationId: 'a', method: 'PATCH', path: '/tickets/2', body: {} });
    await store.enqueue({ mutationId: 'b', method: 'DELETE', path: '/tickets/2' });
    // A new connection sees what the first wrote.
    const again = await indexedDbStore(name);
    expect(await again.meta()).toMatchObject({ position: '7', clientId: 'c' });
    expect(await contents(again)).toEqual(['2:Two']);
    expect(await again.ticketByNumber(1, 2)).toMatchObject({ summary: 'Two' });
    expect((await again.outbox()).map((e) => e.mutationId)).toEqual(['a', 'b']);
    await again.dequeue('a');
    expect((await again.outbox()).map((e) => e.mutationId)).toEqual(['b']);
    store.close();
    again.close();
    await deleteSyncDatabase(name);
    const fresh = await indexedDbStore(name);
    expect(await fresh.meta()).toBeNull();
    fresh.close();
  });
});
