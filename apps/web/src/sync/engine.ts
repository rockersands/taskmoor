import type { OutboxEntry, SyncMeta, SyncStore, SyncTrack, TicketSnapshot } from './store';

/**
 * The client side of ADR-013 (M1-032): bootstrap, follow, and an outbox.
 *
 * - **Bootstrap** reads the sync groups, then every track's tickets page by page, and keeps the
 *   earliest position it was given: what changed meanwhile comes again by following, and
 *   applying a change twice changes nothing.
 * - **Follow** reads `/sync/changes` from the stored position whenever the realtime socket says
 *   the log moved (and every 30 seconds when there is no socket). A ticket comes with its data or
 *   as a bare removal; an `authz` change or a `resync` answer starts a new bootstrap.
 * - **Outbox:** a mutation is stored first, applied to the local copy at once when it says how,
 *   then sent with this browser's client id and its mutation id, so a resend after a lost answer
 *   or an offline spell runs once on the server. A refusal drops it and reads the truth from the
 *   log; a network failure keeps it for the next attempt (on reconnect or when the browser comes
 *   back online).
 */
export interface SyncChange {
  seq: string;
  entity: 'ticket' | 'track' | 'authz';
  id: number;
  trackId: number | null;
  op: 'upsert' | 'delete';
  data?: Record<string, unknown>;
}

export interface SyncApi {
  groups(): Promise<{ position: string; tracks: SyncTrack[] }>;
  bootstrap(
    track: number,
    after: number,
  ): Promise<{ position: string; tickets: TicketSnapshot[]; next: number | null }>;
  changes(after: string): Promise<{ changes: SyncChange[]; position: string; resync: boolean }>;
  /** Sends one outbox entry; a network failure rejects. */
  send(entry: OutboxEntry, clientId: string): Promise<{ status: number; body: unknown }>;
}

/** What the engine needs of a websocket. */
export interface PositionSocket {
  onPosition: (handler: (position: string) => void) => void;
  onClose: (handler: () => void) => void;
  close(): void;
}

export interface EngineOptions {
  api: SyncApi;
  store: SyncStore;
  /** Opens the realtime socket; none in tests that drive the engine by hand. */
  connect?: () => PositionSocket;
  /** How often to read the log without a socket (ms). */
  pollMs?: number;
  newId?: () => string;
}

export type Refusal = { entry: OutboxEntry; status: number; body: unknown };

const later = (a: string, b: string) => BigInt(a) > BigInt(b);

export class SyncEngine {
  private meta: SyncMeta | null = null;
  private listeners = new Set<() => void>();
  private refusalListeners = new Set<(refusal: Refusal) => void>();
  private pulling: Promise<void> | null = null;
  private pullAgain = false;
  private flushing: Promise<void> | null = null;
  private socket: PositionSocket | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private stopped = false;
  private retry = 1000;
  private readonly newId: () => string;

  constructor(private readonly options: EngineOptions) {
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  /**
   * Loads the local copy, then follows. Without one it bootstraps first and rejects when the
   * server cannot be reached, so the caller tries again later; with one it starts offline too
   * and catches up when the server answers.
   */
  async start(): Promise<void> {
    this.meta = await this.options.store.meta();
    if (!this.meta?.position) await this.bootstrap();
    else await this.pull().catch(() => {});
    this.connect();
    const poll = () => {
      if (this.stopped) return;
      if (!this.socket) this.pullQuietly();
      this.timers.push(setTimeout(poll, this.options.pollMs ?? 30_000));
    };
    this.timers.push(setTimeout(poll, this.options.pollMs ?? 30_000));
    void this.flush();
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.socket?.close();
    this.socket = null;
    this.options.store.close();
  }

  /** Called after every change to the local copy. */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called when the server refuses a mutation from the outbox. */
  onRefusal(listener: (refusal: Refusal) => void): () => void {
    this.refusalListeners.add(listener);
    return () => this.refusalListeners.delete(listener);
  }

  get position(): string {
    return this.meta?.position ?? '';
  }

  get tracks(): SyncTrack[] {
    return this.meta?.tracks ?? [];
  }

  /** A ticket by its key (KEY-12) from the local copy; null when it is not there. */
  async ticketByKey(key: string): Promise<TicketSnapshot | null> {
    const m = /^(.+)-(\d+)$/.exec(key);
    if (!m) return null;
    const track = this.tracks.find((t) => t.key === m[1]);
    if (!track) return null;
    return this.options.store.ticketByNumber(track.id, Number(m[2]));
  }

  private notify() {
    for (const listener of this.listeners) listener();
  }

  private async bootstrap(): Promise<void> {
    const { api, store } = this.options;
    const clientId = this.meta?.clientId ?? this.newId();
    const groups = await api.groups();
    let position = groups.position;
    const tickets: TicketSnapshot[] = [];
    for (const track of groups.tracks) {
      let after = 0;
      for (;;) {
        const page = await api.bootstrap(track.id, after);
        if (later(position, page.position)) position = page.position;
        tickets.push(...page.tickets);
        if (page.next === null) break;
        after = page.next;
      }
    }
    await store.clearTickets();
    await store.apply(
      tickets.filter((t) => t.deleted_at == null),
      [],
    );
    this.meta = { position, tracks: groups.tracks, clientId };
    await store.setMeta(this.meta);
    this.notify();
  }

  /** A pull whose failure waits for the next push, poll or reconnect. */
  private pullQuietly() {
    this.pull().catch(() => {});
  }

  /** Reads the log up to its end; concurrent calls share one run and one more after it. */
  pull(): Promise<void> {
    if (this.pulling) {
      this.pullAgain = true;
      return this.pulling;
    }
    this.pulling = (async () => {
      try {
        do {
          this.pullAgain = false;
          await this.pullOnce();
        } while (this.pullAgain);
      } finally {
        this.pulling = null;
      }
    })();
    return this.pulling;
  }

  private async pullOnce(): Promise<void> {
    const { api, store } = this.options;
    if (!this.meta) return this.bootstrap();
    for (;;) {
      const got = await api.changes(this.meta.position);
      if (got.resync || got.changes.some((c) => c.entity === 'authz')) return this.bootstrap();
      const put: TicketSnapshot[] = [];
      const remove: number[] = [];
      let tracks: SyncTrack[] = this.meta.tracks;
      for (const change of got.changes) {
        if (change.entity === 'ticket') {
          const data = change.data as TicketSnapshot | undefined;
          // Later rows for the same ticket win: drop what an earlier row of this page did.
          const at = put.findIndex((t) => t.id === change.id);
          if (at >= 0) put.splice(at, 1);
          if (change.op === 'upsert' && data && data.deleted_at == null) put.push(data);
          else remove.push(change.id);
        } else if (change.entity === 'track') {
          tracks = tracks.filter((t) => t.id !== change.id);
          const data = change.data as Record<string, unknown> | undefined;
          if (change.op === 'upsert' && data && data.deleted_at == null) {
            tracks = [
              ...tracks,
              { id: change.id, key: String(data.key), name: String(data.name) },
            ].sort((a, b) => a.key.localeCompare(b.key));
          }
        }
      }
      const done = got.position === this.meta.position || got.changes.length === 0;
      await store.apply(
        put,
        remove.filter((id) => !put.some((t) => t.id === id)),
      );
      this.meta = { ...this.meta, position: got.position, tracks };
      await store.setMeta(this.meta);
      if (got.changes.length > 0) this.notify();
      if (done) return;
    }
  }

  /** The socket says where the log stands; read on when it moved past the local copy. */
  private onPosition(position: string) {
    this.retry = 1000;
    if (!this.meta || later(position, this.meta.position)) this.pullQuietly();
  }

  private connect() {
    if (this.stopped || !this.options.connect) return;
    try {
      const socket = this.options.connect();
      this.socket = socket;
      socket.onPosition((position) => this.onPosition(position));
      socket.onClose(() => {
        this.socket = null;
        if (this.stopped) return;
        // Back again after a pause that doubles up to 30 seconds.
        this.timers.push(
          setTimeout(() => {
            this.connect();
            void this.flush();
          }, this.retry),
        );
        this.retry = Math.min(this.retry * 2, 30_000);
      });
    } catch {
      this.socket = null;
    }
  }

  /**
   * Queues a mutation: stored first, applied locally at once by `optimistic` when given, then
   * sent. Resolves when it has been sent or kept for later.
   */
  async mutate(
    entry: Omit<OutboxEntry, 'mutationId' | 'seq'>,
    optimistic?: (ticket: TicketSnapshot) => TicketSnapshot,
    ticketId?: number,
  ): Promise<void> {
    const { store } = this.options;
    await store.enqueue({ ...entry, mutationId: this.newId() });
    if (optimistic && ticketId !== undefined) {
      const current = await store.ticket(ticketId);
      if (current) {
        await store.apply([optimistic(current)], []);
        this.notify();
      }
    }
    await this.flush();
  }

  /** Sends the outbox in order; stops at the first entry the network does not take. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        const { api, store } = this.options;
        const clientId = this.meta?.clientId;
        if (!clientId) return;
        for (const entry of await store.outbox()) {
          let answer: { status: number; body: unknown };
          try {
            answer = await api.send(entry, clientId);
          } catch {
            return;
          }
          const error = (answer.body as { error?: string } | null)?.error;
          // Still running elsewhere: try again later.
          if (answer.status === 409 && error === 'mutation_in_progress') return;
          await store.dequeue(entry.mutationId);
          if (answer.status >= 400) {
            for (const listener of this.refusalListeners) {
              listener({ entry, status: answer.status, body: answer.body });
            }
          }
          // The truth (ours or the refusal's) comes back through the log.
          await this.pull().catch(() => {});
        }
      } catch {
        // The browser's database failed (storage cleared, quota): what is left waits for the
        // next flush, so callers and the timers never see a rejection.
      } finally {
        this.flushing = null;
      }
    })();
    return this.flushing;
  }
}
