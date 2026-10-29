import { randomUUID } from 'node:crypto';
import type { Database } from '@taskmoor/db';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { Authorizer } from '../authz/authorizer';
import { bindCondition, type Scope } from '../boards/data';
import type { Subscriber } from '../events/bus';
import type { DomainEvent } from '../events/catalogue';
import { enqueue } from '../events/queue';
import { FieldCatalogs } from '../fields/catalog';
import { queryCatalogue } from '../search/catalogue';
import { compileCond } from '../search/compile';
import { commentReadableSql } from '../tickets/comments';
import { ticketKey } from '../tickets/model';
import { eventMatches, MAX_ATTEMPTS, ticketOf, WEBHOOK_EVENTS, type WebhookFormat } from './model';
import { bodyFor, type TicketSummary } from './payload';

/**
 * Webhooks on the event bus (M1-067; API-009; ADR-055). For each offered event, every enabled
 * webhook of the workspace that takes its type gets one delivery: recorded with the body it
 * will send and queued in one transaction, keyed by webhook and event, so the bus delivering an
 * event twice records nothing twice.
 *
 * An event about a ticket goes only to webhooks whose owner sees the ticket, and that match
 * the webhook's query as the owner reads it. A trashed ticket is judged as it was; a purged one
 * reaches only webhooks without a query. A query that no longer reads (a field deleted since)
 * records a failed delivery that says so, rather than dropping events silently.
 */
export const DELIVER_TASK = 'webhook:deliver';

type Hook = {
  id: number;
  name: string;
  format: WebhookFormat;
  events: string[];
  filter_query: string | null;
  owner_id: number;
};

/** The job key of a delivery's `round`th sending (0 the first, then one per replay). */
export const deliverKey = (deliveryId: string, round: number) =>
  `${DELIVER_TASK}:${deliveryId}:${round}`;

export function webhookSubscriber(
  db: Kysely<Database>,
  deps: { publicUrl?: string; authorizer?: Authorizer; catalogs?: FieldCatalogs } = {},
): Subscriber {
  const authorizer = deps.authorizer ?? new Authorizer(db);
  const catalogs = deps.catalogs ?? new FieldCatalogs(db);
  const publicUrl = deps.publicUrl ?? 'http://localhost:8080';

  /** The owner's view of the ticket, or why it does not go out. */
  async function ticketFor(
    hook: Hook,
    event: DomainEvent,
    ticketId: number,
  ): Promise<{ ticket: TicketSummary | null } | { skip: true } | { error: string }> {
    const ws = event.workspaceId;
    const principal = { userId: hook.owner_id };
    const owner = await db
      .selectFrom('app_user')
      .select(['time_zone', 'deactivated_at'])
      .where('id', '=', hook.owner_id)
      .executeTakeFirst();
    if (!owner || owner.deactivated_at !== null) return { skip: true };
    const filter = await authorizer.ticketFilter(ws, principal);
    let match: RawBuilder<boolean> = sql<boolean>`true`;
    if (hook.filter_query !== null) {
      const catalog = await catalogs.get(ws);
      const scope: Scope = {
        ws,
        filter,
        catalog,
        catalogue: await queryCatalogue(db, ws, catalog, filter.tracks),
        userId: hook.owner_id,
        person: {
          currentUserId: hook.owner_id,
          timeZone: owner.time_zone,
          sessionId: null,
          allowedTracks: (permission) => authorizer.allowedTracks(ws, principal, permission),
        },
      };
      try {
        const cond = await bindCondition(db, scope, hook.filter_query, event.occurredAt);
        match = compileCond(cond, {
          comments: commentReadableSql(ws, hook.owner_id),
          filter: filter.sql,
          workspaceId: ws,
        });
      } catch (error) {
        return { error: `The webhook's query cannot run: ${(error as Error).message}` };
      }
    }
    const row = await db
      .selectFrom('ticket as k')
      .innerJoin('track as t', 't.id', 'k.track_id')
      .innerJoin('status as st', 'st.id', 'k.status_id')
      .innerJoin('ticket_type as ty', 'ty.id', 'k.ticket_type_id')
      .select([
        'k.id',
        'k.number',
        'k.summary',
        't.id as track_id',
        't.key as track_key',
        'st.name as status',
        'ty.name as type',
      ])
      .where('k.id', '=', ticketId)
      .where('k.workspace_id', '=', ws)
      .where(filter.sql)
      .where(match)
      .executeTakeFirst();
    if (!row) {
      // A purged ticket is gone: only a webhook without a query takes its event.
      if (event.type === 'ticket.purged' && hook.filter_query === null) return { ticket: null };
      return { skip: true };
    }
    return {
      ticket: {
        id: row.id,
        key: ticketKey(row.track_key, row.number),
        summary: row.summary,
        status: row.status,
        type: row.type,
        track: { id: row.track_id, key: row.track_key },
      },
    };
  }

  return {
    name: 'webhooks',
    types: WEBHOOK_EVENTS,
    async handle(event: DomainEvent): Promise<void> {
      const hooks = (await db
        .selectFrom('webhook')
        .select(['id', 'name', 'format', 'events', 'filter_query', 'owner_id'])
        .where('workspace_id', '=', event.workspaceId)
        .where('enabled', '=', true)
        .orderBy('id')
        .execute()) as Hook[];
      const taking = hooks.filter((h) => eventMatches(h.events, event.type));
      if (taking.length === 0) return;
      const actor =
        event.actorId === null
          ? null
          : ((await db
              .selectFrom('app_user')
              .select(['id', 'name'])
              .where('id', '=', event.actorId)
              .executeTakeFirst()) ?? null);
      const ticketId = ticketOf(event);
      for (const hook of taking) {
        let ticket: TicketSummary | null = null;
        let problem: string | null = null;
        if (ticketId !== null) {
          const judged = await ticketFor(hook, event, ticketId);
          if ('skip' in judged) continue;
          if ('error' in judged) problem = judged.error;
          else ticket = judged.ticket;
        }
        const deliveryId = randomUUID();
        const body = bodyFor(hook.format, {
          deliveryId,
          webhook: { id: hook.id, name: hook.name },
          event: {
            id: event.id,
            type: event.type,
            occurredAt: event.occurredAt,
            subjectType: event.subjectType,
            subjectId: event.subjectId,
            payload: event.payload,
          },
          actor,
          ticket,
          publicUrl,
        });
        await db.transaction().execute(async (trx) => {
          const inserted = await trx
            .insertInto('webhook_delivery')
            .values({
              id: deliveryId,
              workspace_id: event.workspaceId,
              webhook_id: hook.id,
              event_id: event.id,
              event_type: event.type,
              body: JSON.stringify(body),
              ...(problem ? { state: 'failed' as const, last_error: problem } : {}),
            })
            .onConflict((oc) => oc.columns(['webhook_id', 'event_id']).doNothing())
            .returning('id')
            .executeTakeFirst();
          if (!inserted || problem) return;
          await enqueue(trx, [
            {
              workspaceId: event.workspaceId,
              task: DELIVER_TASK,
              payload: { deliveryId },
              key: deliverKey(deliveryId, 0),
              maxAttempts: MAX_ATTEMPTS,
            },
          ]);
        });
      }
    },
  };
}
