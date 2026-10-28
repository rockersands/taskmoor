import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { auditSubscriber } from '../audit/subscriber';
import { notificationSubscriber } from '../notifications/subscriber';
import type { EventBus } from './bus';

/**
 * Every subscriber of the domain event bus, registered in one place so the worker role and
 * the tests see the same set. Webhooks, search indexing and automation register here as they
 * arrive.
 */
export function registerSubscribers(bus: EventBus, deps: { db: Kysely<Database> }): void {
  // The audit log (M1-003, ADR-034).
  bus.subscribe(auditSubscriber(deps.db));
  // Notifications (M1-056): who hears of a change, written for email and the inbox to deliver.
  bus.subscribe(notificationSubscriber(deps.db));
}
