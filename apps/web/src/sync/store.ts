/**
 * The client's local copy (M1-032; ADR-013): tickets as the change log snapshots them, the
 * tracks it syncs, where it stands in the log, and the outbox of mutations not yet confirmed.
 * In the browser it lives in IndexedDB, one database per person, deleted at sign-out; tests use
 * the in-memory store with the same interface.
 */
export type TicketSnapshot = Record<string, unknown> & {
  id: number;
  track_id: number;
  number: number;
  summary: string;
};
export interface SyncTrack {
  id: number;
  key: string;
  name: string;
}
export interface SyncMeta {
  /** The change log position everything stored reflects. */
  position: string;
  tracks: SyncTrack[];
  /** This browser's id for the outbox (ADR-013: client id, mutation id). */
  clientId: string;
}
export interface OutboxEntry {
  /** Order of sending; given by the store. */
  seq?: number;
  mutationId: string;
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
}

export interface SyncStore {
  meta(): Promise<SyncMeta | null>;
  setMeta(meta: SyncMeta): Promise<void>;
  ticket(id: number): Promise<TicketSnapshot | null>;
  ticketByNumber(trackId: number, number: number): Promise<TicketSnapshot | null>;
  tickets(): Promise<TicketSnapshot[]>;
  /** Writes and removes in one step. */
  apply(put: readonly TicketSnapshot[], remove: readonly number[]): Promise<void>;
  /** Everything but the outbox and the client id: before a new bootstrap. */
  clearTickets(): Promise<void>;
  outbox(): Promise<OutboxEntry[]>;
  enqueue(entry: OutboxEntry): Promise<void>;
  dequeue(mutationId: string): Promise<void>;
  /** Lets go of the database, so it can be deleted (at sign-out). */
  close(): void;
}

export function memoryStore(): SyncStore {
  let meta: SyncMeta | null = null;
  const tickets = new Map<number, TicketSnapshot>();
  const queue: OutboxEntry[] = [];
  let seq = 0;
  const copy = <T>(v: T): T => structuredClone(v);
  return {
    meta: async () => (meta ? copy(meta) : null),
    setMeta: async (next) => {
      meta = copy(next);
    },
    ticket: async (id) => copy(tickets.get(id) ?? null),
    ticketByNumber: async (trackId, number) =>
      copy(
        [...tickets.values()].find((t) => t.track_id === trackId && t.number === number) ?? null,
      ),
    tickets: async () => [...tickets.values()].map(copy),
    apply: async (put, remove) => {
      for (const id of remove) tickets.delete(id);
      for (const t of put) tickets.set(t.id, copy(t));
    },
    clearTickets: async () => {
      tickets.clear();
    },
    outbox: async () => queue.map(copy),
    enqueue: async (entry) => {
      queue.push({ ...copy(entry), seq: ++seq });
    },
    dequeue: async (mutationId) => {
      const i = queue.findIndex((e) => e.mutationId === mutationId);
      if (i >= 0) queue.splice(i, 1);
    },
    close: () => {},
  };
}

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });

/** The database of one person in this browser. */
export const syncDatabaseName = (userId: number) => `taskmoor-sync-${userId}`;

export async function indexedDbStore(
  name: string,
  factory: IDBFactory = indexedDB,
): Promise<SyncStore> {
  const open = factory.open(name, 1);
  open.onupgradeneeded = () => {
    const db = open.result;
    const tickets = db.createObjectStore('tickets', { keyPath: 'id' });
    tickets.createIndex('byTrackNumber', ['track_id', 'number'], { unique: false });
    db.createObjectStore('meta');
    db.createObjectStore('outbox', { keyPath: 'seq', autoIncrement: true });
  };
  const db = await request(open);
  const store = (name: 'tickets' | 'meta' | 'outbox', mode: IDBTransactionMode = 'readonly') =>
    db.transaction(name, mode).objectStore(name);
  return {
    meta: async () => ((await request(store('meta').get('meta'))) as SyncMeta | undefined) ?? null,
    setMeta: async (meta) => {
      const tx = db.transaction('meta', 'readwrite');
      tx.objectStore('meta').put(meta, 'meta');
      await done(tx);
    },
    ticket: async (id) =>
      ((await request(store('tickets').get(id))) as TicketSnapshot | undefined) ?? null,
    ticketByNumber: async (trackId, number) =>
      ((await request(store('tickets').index('byTrackNumber').get([trackId, number]))) as
        | TicketSnapshot
        | undefined) ?? null,
    tickets: async () => (await request(store('tickets').getAll())) as TicketSnapshot[],
    apply: async (put, remove) => {
      const tx = db.transaction('tickets', 'readwrite');
      const tickets = tx.objectStore('tickets');
      for (const id of remove) tickets.delete(id);
      for (const t of put) tickets.put(t);
      await done(tx);
    },
    clearTickets: async () => {
      const tx = db.transaction('tickets', 'readwrite');
      tx.objectStore('tickets').clear();
      await done(tx);
    },
    outbox: async () => (await request(store('outbox').getAll())) as OutboxEntry[],
    enqueue: async (entry) => {
      const tx = db.transaction('outbox', 'readwrite');
      tx.objectStore('outbox').add({ ...entry });
      await done(tx);
    },
    dequeue: async (mutationId) => {
      const tx = db.transaction('outbox', 'readwrite');
      const outbox = tx.objectStore('outbox');
      const all = (await request(outbox.getAll())) as OutboxEntry[];
      const entry = all.find((e) => e.mutationId === mutationId);
      if (entry?.seq !== undefined) outbox.delete(entry.seq);
      await done(tx);
    },
    close: () => db.close(),
  };
}

/** Deletes a person's local copy, at sign-out. */
export function deleteSyncDatabase(name: string, factory: IDBFactory = indexedDB): Promise<void> {
  return new Promise((resolve) => {
    const r = factory.deleteDatabase(name);
    r.onsuccess = () => resolve();
    r.onerror = () => resolve();
    r.onblocked = () => resolve();
  });
}
