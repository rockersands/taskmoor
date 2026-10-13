import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import type { EventBus } from './bus';

/**
 * Every subscriber of the domain event bus, registered in one place so the worker role and
 * the tests see the same set. Audit (M1-003), notifications (M1-056), webhooks, search
 * indexing and automation register here as they arrive.
 */
export function registerSubscribers(_bus: EventBus, _deps: { db: Kysely<Database> }): void {
  // None yet: events are recorded and wait for their first consumers.
}
