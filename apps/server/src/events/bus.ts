import type { Database } from '@taskmoor/db';
import { type Kysely, sql, type Transaction } from 'kysely';
import { type DomainEvent, type DomainEventInput, EVENT_TYPES, type EventType } from './catalogue';

export { diff } from './catalogue';

import { enqueue, type JobRunner, releaseStale } from './queue';

/**
 * The domain event bus (M1-005, ADR-015). `emit` writes the event in the caller's transaction;
 * `EventBus.relayOnce` turns unpublished events into one job per interested subscriber (keyed
 * by subscriber and event, so a relay that crashes after enqueueing delivers nothing twice);
 * the job runner calls the subscriber. Delivery is at least once: subscribers are idempotent.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface EventContext {
  workspaceId: number;
  /** Who caused it; null for the system (the CLI, a job, first-run setup before an account). */
  actorId: number | null;
}

/**
 * Records one event as part of the caller's transaction. The payload is checked against the
 * catalogue, so a mutation cannot publish a malformed or unknown event.
 */
export async function emit(db: Db, context: EventContext, event: DomainEventInput): Promise<void> {
  const spec = EVENT_TYPES[event.type];
  const payload = spec.payload.parse(event.payload);
  await db
    .insertInto('domain_event')
    .values({
      workspace_id: context.workspaceId,
      type: event.type,
      actor_id: context.actorId,
      subject_type: spec.subject,
      subject_id: String(event.subjectId),
      payload: JSON.stringify(payload),
    })
    .execute();
}

/** Runs `work` in a transaction and emits its event there; `work` returns the result and event. */
export async function withEvent<T>(
  db: Kysely<Database>,
  context: EventContext,
  work: (trx: Transaction<Database>) => Promise<{ result: T; event: DomainEventInput | null }>,
): Promise<T> {
  return db.transaction().execute(async (trx) => {
    const { result, event } = await work(trx);
    if (event) await emit(trx, context, event);
    return result;
  });
}

export interface Subscriber {
  /** Stable name: it is part of every job key. */
  name: string;
  types: readonly EventType[] | '*';
  handle(event: DomainEvent): Promise<void>;
}

interface EventRow {
  id: string;
  workspace_id: number;
  type: EventType;
  version: number;
  actor_id: number | null;
  subject_type: string;
  subject_id: string;
  payload: unknown;
  occurred_at: Date;
}

function toEvent(row: EventRow): DomainEvent {
  return {
    id: String(row.id),
    workspaceId: row.workspace_id,
    type: row.type,
    version: row.version,
    actorId: row.actor_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    payload: row.payload,
    occurredAt: row.occurred_at,
  };
}

export const eventTask = (subscriber: string) => `event:${subscriber}`;

export class EventBus {
  private readonly subscribers = new Map<string, Subscriber>();

  constructor(private readonly db: Kysely<Database>) {}

  subscribe(subscriber: Subscriber): void {
    if (this.subscribers.has(subscriber.name)) {
      throw new Error(`subscriber ${subscriber.name} is already registered`);
    }
    this.subscribers.set(subscriber.name, subscriber);
  }

  /** Registers the job handler that delivers events to each subscriber. */
  attach(runner: JobRunner): void {
    for (const subscriber of this.subscribers.values()) {
      runner.handle(eventTask(subscriber.name), async (job) => {
        const { eventId } = job.payload as { eventId: string };
        const row = await this.db
          .selectFrom('domain_event')
          .selectAll()
          .where('id', '=', eventId)
          .executeTakeFirst();
        // An event pruned by retention has nothing left to deliver.
        if (row) await subscriber.handle(toEvent(row as unknown as EventRow));
      });
    }
  }

  /**
   * Moves one batch of unpublished events to the subscribers' queues and marks them
   * published, in one transaction. Several relays may run: SKIP LOCKED gives each event to one.
   * Returns how many events were published.
   */
  async relayOnce(batch = 200): Promise<number> {
    return this.db.transaction().execute(async (trx) => {
      const { rows } = await sql<{ id: string; workspace_id: number; type: EventType }>`
        SELECT id, workspace_id, type FROM domain_event
         WHERE published_at IS NULL
         ORDER BY id LIMIT ${batch}
         FOR UPDATE SKIP LOCKED`.execute(trx);
      if (rows.length === 0) return 0;
      const jobs = rows.flatMap((event) =>
        [...this.subscribers.values()]
          .filter((s) => s.types === '*' || s.types.includes(event.type))
          .map((s) => ({
            workspaceId: event.workspace_id,
            task: eventTask(s.name),
            payload: { eventId: String(event.id) },
            key: `${eventTask(s.name)}:${event.id}`,
          })),
      );
      await enqueue(trx, jobs);
      await sql`
        UPDATE domain_event SET published_at = clock_timestamp()
         WHERE id = ANY(${rows.map((r) => Number(r.id))}::bigint[])`.execute(trx);
      return rows.length;
    });
  }
}

/**
 * The worker loop (worker role): relay new events, run ready jobs, release jobs of dead
 * workers, then wait a little when there was nothing to do.
 */
export function startWorker(options: {
  bus: EventBus;
  runner: JobRunner;
  db: Kysely<Database>;
  idleMs?: number;
  onError?: (error: unknown) => void;
}): { stop: () => Promise<void> } {
  let stopped = false;
  let wake: (() => void) | undefined;
  let lastRelease = 0;
  const loop = (async () => {
    while (!stopped) {
      try {
        const relayed = await options.bus.relayOnce();
        const ran = await options.runner.runOnce();
        if (Date.now() - lastRelease > 60_000) {
          lastRelease = Date.now();
          await releaseStale(options.db, 10 * 60_000);
        }
        if (relayed > 0 || ran > 0) continue;
      } catch (error) {
        options.onError?.(error);
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, options.idleMs ?? 500).unref();
      });
    }
  })();
  return {
    stop: async () => {
      stopped = true;
      wake?.();
      await loop;
    },
  };
}
