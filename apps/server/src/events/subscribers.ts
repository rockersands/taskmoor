import type { Database } from '@taskmoor/db';
import type { Kysely } from 'kysely';
import { auditSubscriber } from '../audit/subscriber';
import type { EmbeddingIndexer } from '../embeddings/indexer';
import { embeddingSubscriber } from '../embeddings/jobs';
import { notificationSubscriber } from '../notifications/subscriber';
import { webhookSubscriber } from '../webhooks/subscriber';
import type { EventBus } from './bus';

/**
 * Every subscriber of the domain event bus, registered in one place so the worker role and
 * the tests see the same set. Webhooks, search indexing and automation register here as they
 * arrive.
 */
export function registerSubscribers(
  bus: EventBus,
  deps: { db: Kysely<Database>; publicUrl?: string; embeddings?: EmbeddingIndexer },
): void {
  // Notifications (M1-056): who hears of a change, written for email and the inbox to deliver.
  // First, so a worker runs an event's notification job before its audit job: an open inbox
  // waits for it (M1-058, NTF-003).
  bus.subscribe(notificationSubscriber(deps.db));
  // The audit log (M1-003, ADR-034).
  bus.subscribe(auditSubscriber(deps.db));
  // Webhooks (M1-067, ADR-055): a delivery per webhook that takes the event, sent by a job.
  bus.subscribe(
    webhookSubscriber(deps.db, deps.publicUrl !== undefined ? { publicUrl: deps.publicUrl } : {}),
  );
  // Embeddings (M1-078, ADR-106): tickets and comments embedded after they change. Only where
  // the process has an embedder: tests that do not look at similar tickets skip the model.
  if (deps.embeddings) bus.subscribe(embeddingSubscriber(deps.db, deps.embeddings));
}
