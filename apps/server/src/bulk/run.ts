import type { Database, JsonValue } from '@taskmoor/db';
import { type Kysely, sql } from 'kysely';
import type { SessionUser } from '../auth';
import type { Authorizer } from '../authz/authorizer';
import { type Caller, callRoute, type TicketRoute } from '../tickets/caller';

/**
 * Runs a bulk operation (M1-021; CORE-024) for the person who asked: each pending ticket goes
 * through the ticket's own route handler with a caller built for that person, so a bulk change
 * meets exactly the checks, history, events and formula updates a request does, and a ticket
 * the person may not change fails alone with the answer its route gave (CORE-024 (1)).
 *
 * - Tickets run a few at a time, in the order given; each outcome is written as it finishes,
 *   so a worker that dies repeats at most the tickets it had in hand.
 * - The counts are recounted from the items after every batch; a cancel asked for is seen
 *   between batches and skips what is left.
 * - A run stops at `until` and says there is more: the job queues the next part, so one
 *   operation never holds a worker for long.
 */
export interface BulkDeps {
  db: Kysely<Database>;
  authorizer: Authorizer;
  routes: readonly TicketRoute[];
}

export interface RunOptions {
  /** Stop taking new batches after this time (ms since the epoch). */
  until: number;
  /** Tickets in flight at once. */
  concurrency?: number;
  batch?: number;
}

const ERROR_BYTES = 4000;

function routeOf(routes: readonly TicketRoute[], method: string, url: string): TicketRoute {
  const found = routes.find((r) => r.method === method && r.url === url);
  if (!found) throw new Error(`no ticket route ${method} ${url}`);
  return found;
}

/** The person as the routes know a signed-in user; null once they are deactivated. */
async function personOf(db: Kysely<Database>, workspaceId: number, userId: number) {
  const row = await db
    .selectFrom('app_user')
    .select(['id', 'email', 'name', 'is_site_admin', 'time_zone', 'locale', 'appearance'])
    .where('id', '=', userId)
    .where('workspace_id', '=', workspaceId)
    .where('deactivated_at', 'is', null)
    .executeTakeFirst();
  if (!row) return null;
  const user: SessionUser = {
    id: row.id,
    email: row.email,
    name: row.name,
    isSiteAdmin: row.is_site_admin,
    timeZone: row.time_zone,
    locale: row.locale,
    appearance: row.appearance,
  };
  return user;
}

/** Runs `work` over `items`, at most `limit` at a time. */
async function inParallel<T>(items: readonly T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(lanes);
}

async function recount(db: Kysely<Database>, operationId: string): Promise<void> {
  await sql`
    UPDATE bulk_operation o SET
      succeeded = c.done, failed = c.failed, skipped = c.skipped
      FROM (SELECT count(*) FILTER (WHERE outcome = 'done')::int AS done,
                   count(*) FILTER (WHERE outcome = 'failed')::int AS failed,
                   count(*) FILTER (WHERE outcome = 'skipped')::int AS skipped
              FROM bulk_item WHERE operation_id = ${Number(operationId)}) c
     WHERE o.id = ${Number(operationId)}`.execute(db);
}

async function finish(
  db: Kysely<Database>,
  operationId: string,
  status: 'done' | 'cancelled',
): Promise<void> {
  if (status === 'cancelled') {
    await db
      .updateTable('bulk_item')
      .set({ outcome: 'skipped', finished_at: new Date() })
      .where('operation_id', '=', operationId)
      .where('outcome', 'is', null)
      .execute();
  }
  await recount(db, operationId);
  await db
    .updateTable('bulk_operation')
    .set({ status, finished_at: new Date() })
    .where('id', '=', operationId)
    .execute();
}

/** Trims an answer for storage: the error and its details, never more than a few KB. */
function storedError(payload: unknown): string {
  const text = JSON.stringify(payload ?? null);
  if (text.length <= ERROR_BYTES) return text;
  const error = (payload as { error?: unknown } | null)?.error;
  return JSON.stringify({ error: typeof error === 'string' ? error : 'failed', truncated: true });
}

export async function runBulkOperation(
  deps: BulkDeps,
  operationId: string,
  options: RunOptions,
): Promise<'finished' | 'more'> {
  const { db, authorizer, routes } = deps;
  const op = await db
    .selectFrom('bulk_operation')
    .selectAll()
    .where('id', '=', operationId)
    .executeTakeFirst();
  if (!op || op.status === 'done' || op.status === 'cancelled') return 'finished';
  if (op.status === 'queued') {
    await db
      .updateTable('bulk_operation')
      .set({ status: 'running', started_at: new Date() })
      .where('id', '=', operationId)
      .where('status', '=', 'queued')
      .execute();
  }
  const params = op.params as Record<string, JsonValue>;
  const edit = routeOf(routes, 'PATCH', '/api/v1/tickets/:id');
  const move = routeOf(routes, 'POST', '/api/v1/tickets/:id/move');
  const trash = routeOf(routes, 'DELETE', '/api/v1/tickets/:id');
  const transitions = routeOf(routes, 'GET', '/api/v1/tickets/:id/transitions');
  const transition = routeOf(routes, 'POST', '/api/v1/tickets/:id/transitions');

  for (;;) {
    const state = await db
      .selectFrom('bulk_operation')
      .select('cancel_requested')
      .where('id', '=', operationId)
      .executeTakeFirstOrThrow();
    if (state.cancel_requested) {
      await finish(db, operationId, 'cancelled');
      return 'finished';
    }
    const items = await db
      .selectFrom('bulk_item')
      .select(['position', 'ticket_id'])
      .where('operation_id', '=', operationId)
      .where('outcome', 'is', null)
      .orderBy('position')
      .limit(options.batch ?? 50)
      .execute();
    if (items.length === 0) {
      await finish(db, operationId, 'done');
      return 'finished';
    }
    // Who asks, read again for every batch: a person deactivated meanwhile changes no more.
    const user = await personOf(db, op.workspace_id, op.user_id);
    if (!user) {
      await db
        .updateTable('bulk_item')
        .set({
          outcome: 'failed',
          status_code: 403,
          error: JSON.stringify({ error: 'requester_deactivated' }),
          finished_at: new Date(),
        })
        .where('operation_id', '=', operationId)
        .where('outcome', 'is', null)
        .execute();
      await finish(db, operationId, 'done');
      return 'finished';
    }
    const authz = authorizer.context(op.workspace_id, { userId: user.id });
    const call = (route: TicketRoute, ticketId: number, body: unknown) => {
      const caller: Caller = {
        workspaceId: op.workspace_id,
        user,
        authz,
        apiToken: null,
        params: { id: String(ticketId) },
        query: {},
        body,
      };
      return callRoute(route, caller);
    };
    const runOne = async (ticketId: number): Promise<{ statusCode: number; payload: unknown }> => {
      switch (op.action) {
        case 'edit':
          return call(edit, ticketId, params.edit);
        case 'move':
          return call(move, ticketId, params.move);
        case 'delete':
          return call(trash, ticketId, undefined);
        case 'transition': {
          const wanted = params.transition as {
            transitionId?: number;
            statusId?: number;
            fields?: Record<string, unknown>;
          };
          let transitionId = wanted.transitionId;
          if (transitionId === undefined) {
            // The transition offered from here to the status asked for, in this ticket's workflow.
            const offered = await call(transitions, ticketId, undefined);
            if (offered.statusCode >= 300) return offered;
            const list = (offered.payload as { transitions: { id: number; to: { id: number } }[] })
              .transitions;
            transitionId = list.find((t) => t.to.id === wanted.statusId)?.id;
            if (transitionId === undefined) {
              return {
                statusCode: 409,
                payload: { error: 'no_transition_to_status', statusId: wanted.statusId },
              };
            }
          }
          return call(transition, ticketId, {
            transitionId,
            ...(wanted.fields ? { fields: wanted.fields } : {}),
          });
        }
      }
    };
    await inParallel(items, options.concurrency ?? 4, async (item) => {
      let answer: { statusCode: number; payload: unknown };
      if (item.ticket_id === null) {
        answer = { statusCode: 404, payload: { error: 'not_found' } };
      } else {
        try {
          answer = await runOne(item.ticket_id);
        } catch {
          // A fault in one ticket's write (a bug, a lost connection) fails that ticket only.
          answer = { statusCode: 500, payload: { error: 'internal' } };
        }
      }
      const ok = answer.statusCode < 300;
      await db
        .updateTable('bulk_item')
        .set({
          outcome: ok ? 'done' : 'failed',
          status_code: answer.statusCode,
          error: ok ? null : storedError(answer.payload),
          finished_at: new Date(),
        })
        .where('operation_id', '=', operationId)
        .where('position', '=', item.position)
        .execute();
    });
    await recount(db, operationId);
    if (Date.now() >= options.until) return 'more';
  }
}
