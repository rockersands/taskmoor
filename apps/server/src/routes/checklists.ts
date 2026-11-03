import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, Transaction } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { emit } from '../events/bus';
import {
  checklistsOf,
  checklistsView,
  ITEM_STATES,
  itemsOf,
  MAX_CHECKLISTS,
  MAX_ITEMS,
} from '../tickets/checklists';
import { autoFollow } from '../tickets/followers';
import { type FieldChange, recordChanges } from '../tickets/history';
import { ticketKey } from '../tickets/model';
import { loadTicket, resolveTicket, type TicketRow } from '../tickets/store';
import { type Lock, lockedBody, statusGate, statusLock } from '../workflows/locks';

/**
 * Checklists on a ticket (CORE-033; ADR-120).
 *
 * - Every ticket type has them: named lists separate from the description, of items in plain text
 *   that are open, in progress, done or rejected. Reading needs the ticket; every change needs
 *   "Edit tickets", and a status that reserves editing to some roles or groups holds here too
 *   (WF-007).
 * - Every write answers the whole of the ticket's checklists, with their progress
 *   (`checklistProgress`), so a client never has to work out what changed.
 * - A change is a history row on the ticket with the words it changed, emits exactly one
 *   `ticket.checklist_changed` event (ADR-015) with ids only, and touches the ticket's updated
 *   time, not its version, as comments do: open pages read again through the change log, and
 *   nobody's edit of another field is refused over a ticked box.
 */
const MAX_INT = 2_147_483_647;
const id = z.coerce.number().int().positive().max(MAX_INT);
const words = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    .refine((value) => !value.includes('\u0000'), 'no NUL');
const name = words(200);
const text = words(1000);
const order = z.array(z.number().int().positive().max(MAX_INT)).min(1).max(MAX_ITEMS);

export const createChecklistBody = z
  .object({ name, items: z.array(text).max(MAX_ITEMS).optional() })
  .strict();
export const updateChecklistBody = z.object({ name }).strict();
export const checklistOrderBody = z.object({ ids: order }).strict();
export const createItemBody = z.object({ text }).strict();
export const updateItemBody = z
  .object({ text: text.optional(), state: z.enum(ITEM_STATES).optional() })
  .strict()
  .refine((body) => body.text !== undefined || body.state !== undefined, 'text or state');

const ticketParams = z.object({ id: z.string().min(1).max(300) });
const listParams = ticketParams.extend({ checklistId: id });
const itemParams = listParams.extend({ itemId: id });

const CHANGES = [
  'added',
  'renamed',
  'removed',
  'reordered',
  'item_added',
  'item_edited',
  'item_state',
  'item_removed',
  'items_reordered',
] as const;
export type ChecklistChange = (typeof CHANGES)[number];

const invalid = (reply: FastifyReply) => reply.code(400).send({ error: 'invalid_request' });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

/** A list of words in history, cut so that one reorder never writes a long row. */
const shortList = (values: readonly string[]) => {
  const joined = values.join(', ');
  return joined.length > 300 ? `${joined.slice(0, 299)}…` : joined;
};

const change = (
  ticketId: number,
  field: string,
  from: string | null,
  to: string | null,
  display?: { from?: string | null; to?: string | null },
): FieldChange => ({
  ticketId,
  field,
  from,
  to,
  fromDisplay: display?.from ?? null,
  toDisplay: display?.to ?? null,
});

export function registerChecklistRoutes(app: FastifyInstance, db: Kysely<Database>): void {
  const by = (request: FastifyRequest) => ({
    workspaceId: request.workspaceId,
    actorId: request.user?.id ?? null,
  });

  /** A ticket outside the trash that the caller may see, by id or key. */
  async function findTicket(request: FastifyRequest, reply: FastifyReply) {
    const params = ticketParams.safeParse(request.params);
    if (!params.success) {
      await invalid(reply);
      return null;
    }
    const found = await resolveTicket(db, request.workspaceId, params.data.id);
    const row = found ? await loadTicket(db, request.workspaceId, found.id) : undefined;
    if (!row || row.deleted_at || !(await request.authz.seesTicket(row))) {
      await notFound(reply);
      return null;
    }
    return row;
  }

  /** The lock of a status that reserves editing to some (WF-007). */
  async function editLock(request: FastifyRequest, ticket: TicketRow): Promise<Lock | null> {
    const allowed = (await statusGate(db, request, ticket.track_id, ticket.ticket_type_id)).check(
      ticket.status_id,
      'edit',
    );
    return allowed ? statusLock(db, request.workspaceId, ticket.status_id, allowed) : null;
  }

  /** The ticket of a write, or the refusal answered. */
  async function writableTicket(request: FastifyRequest, reply: FastifyReply) {
    if (!requireUser(request, reply)) return null;
    const ticket = await findTicket(request, reply);
    if (!ticket) return null;
    if (ticket.track_archived_at) {
      await reply.code(409).send({ error: 'track_archived' });
      return null;
    }
    if (!(await request.authz.canTicket('edit_tickets', ticket))) {
      await reply.code(403).send({ error: 'forbidden', permission: 'edit_tickets' });
      return null;
    }
    const lock = await editLock(request, ticket);
    if (lock) {
      await reply.code(403).send(lockedBody('edit', [lock]));
      return null;
    }
    return ticket;
  }

  /** What the page reads: the lists, and what this person may do with them. */
  async function view(request: FastifyRequest, ticket: TicketRow) {
    const lock = request.user && !ticket.track_archived_at ? await editLock(request, ticket) : null;
    const canEdit =
      Boolean(request.user) &&
      !ticket.track_archived_at &&
      lock === null &&
      (await request.authz.canTicket('edit_tickets', ticket));
    return { ...(await checklistsView(db, ticket.id)), canEdit, lock };
  }

  /**
   * The closing part of every write, in its transaction: the ticket's updated time, the change's
   * history rows, one event and the person's auto-follow (CORE-019).
   */
  async function record(
    trx: Transaction<Database>,
    request: FastifyRequest,
    ticket: TicketRow,
    what: { change: ChecklistChange; checklistId: number; itemId?: number },
    changes: FieldChange[],
  ) {
    const actor = request.user?.id as number;
    await trx
      .updateTable('ticket')
      .set({ updated_at: new Date() })
      .where('id', '=', ticket.id)
      .execute();
    await recordChanges(trx, request.workspaceId, actor, changes);
    await autoFollow(trx, request.workspaceId, ticket.id, actor);
    await emit(trx, by(request), {
      type: 'ticket.checklist_changed',
      subjectId: ticket.id,
      payload: {
        key: ticketKey(ticket.track_key, ticket.number),
        change: what.change,
        checklistId: what.checklistId,
        itemId: what.itemId ?? null,
      },
    });
  }

  /** Holds the ticket's row, so the positions of its lists are read and written by one writer. */
  async function holdTicket(trx: Transaction<Database>, ticketId: number): Promise<boolean> {
    const held = await trx
      .selectFrom('ticket')
      .select('id')
      .where('id', '=', ticketId)
      .where('deleted_at', 'is', null)
      .forNoKeyUpdate()
      .executeTakeFirst();
    return held !== undefined;
  }

  const listOf = (trx: Transaction<Database>, ticketId: number, checklistId: number) =>
    trx
      .selectFrom('ticket_checklist')
      .select(['id', 'name'])
      .where('id', '=', checklistId)
      .where('ticket_id', '=', ticketId)
      .executeTakeFirst();

  type Refused = { refuse: 'not_found' | 'stale' | 'too_many' };
  const answer = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ticket: TicketRow,
    result: Refused | { code: number },
  ) => {
    if ('refuse' in result) {
      if (result.refuse === 'not_found') return notFound(reply);
      return reply.code(409).send({
        error: result.refuse === 'stale' ? 'order_changed' : 'too_many',
        ...(result.refuse === 'too_many'
          ? { maxChecklists: MAX_CHECKLISTS, maxItems: MAX_ITEMS }
          : {}),
      });
    }
    return reply.code(result.code).send(await view(request, ticket));
  };

  app.get('/api/v1/tickets/:id/checklists', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const ticket = await findTicket(request, reply);
    if (!ticket) return reply;
    return view(request, ticket);
  });

  app.post('/api/v1/tickets/:id/checklists', async (request, reply) => {
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const parsed = createChecklistBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const lists = await checklistsOf(trx, ticket.id);
        if (lists.length >= MAX_CHECKLISTS) return { refuse: 'too_many' };
        const created = await trx
          .insertInto('ticket_checklist')
          .values({
            workspace_id: request.workspaceId,
            ticket_id: ticket.id,
            name: body.name,
            position: (lists[lists.length - 1]?.position ?? -1) + 1,
            created_by: request.user?.id ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        if (body.items && body.items.length > 0) {
          await trx
            .insertInto('ticket_checklist_item')
            .values(
              body.items.map((item, position) => ({
                workspace_id: request.workspaceId,
                checklist_id: created.id,
                text: item,
                position,
                created_by: request.user?.id ?? null,
              })),
            )
            .execute();
        }
        await record(trx, request, ticket, { change: 'added', checklistId: created.id }, [
          change(ticket.id, 'checklist', null, body.name),
        ]);
        return { code: 201 };
      });
    return answer(request, reply, ticket, result);
  });

  app.put('/api/v1/tickets/:id/checklists/order', async (request, reply) => {
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const parsed = checklistOrderBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ids = parsed.data.ids;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const lists = await checklistsOf(trx, ticket.id);
        const same =
          ids.length === lists.length &&
          new Set(ids).size === ids.length &&
          lists.every((list) => ids.includes(list.id));
        if (!same) return { refuse: 'stale' };
        if (lists.every((list, i) => list.id === ids[i])) return { code: 200 };
        for (const [position, listId] of ids.entries()) {
          await trx
            .updateTable('ticket_checklist')
            .set({ position, updated_at: new Date() })
            .where('id', '=', listId)
            .execute();
        }
        const nameOf = (listId: number) => lists.find((l) => l.id === listId)?.name ?? '';
        await record(trx, request, ticket, { change: 'reordered', checklistId: ids[0] as number }, [
          change(
            ticket.id,
            'checklistOrder',
            shortList(lists.map((l) => l.name)),
            shortList(ids.map(nameOf)),
          ),
        ]);
        return { code: 200 };
      });
    return answer(request, reply, ticket, result);
  });

  app.patch('/api/v1/tickets/:id/checklists/:checklistId', async (request, reply) => {
    const params = listParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const parsed = updateChecklistBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const checklistId = params.data.checklistId;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const list = await listOf(trx, ticket.id, checklistId);
        if (!list) return { refuse: 'not_found' };
        if (list.name === parsed.data.name) return { code: 200 };
        await trx
          .updateTable('ticket_checklist')
          .set({ name: parsed.data.name, updated_at: new Date() })
          .where('id', '=', checklistId)
          .execute();
        await record(trx, request, ticket, { change: 'renamed', checklistId }, [
          change(ticket.id, 'checklist', list.name, parsed.data.name),
        ]);
        return { code: 200 };
      });
    return answer(request, reply, ticket, result);
  });

  app.delete('/api/v1/tickets/:id/checklists/:checklistId', async (request, reply) => {
    const params = listParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const checklistId = params.data.checklistId;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const list = await listOf(trx, ticket.id, checklistId);
        if (!list) return { refuse: 'not_found' };
        await trx.deleteFrom('ticket_checklist').where('id', '=', checklistId).execute();
        await record(trx, request, ticket, { change: 'removed', checklistId }, [
          change(ticket.id, 'checklist', list.name, null),
        ]);
        return { code: 200 };
      });
    return answer(request, reply, ticket, result);
  });

  app.post('/api/v1/tickets/:id/checklists/:checklistId/items', async (request, reply) => {
    const params = listParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const parsed = createItemBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const checklistId = params.data.checklistId;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const list = await listOf(trx, ticket.id, checklistId);
        if (!list) return { refuse: 'not_found' };
        const items = (await itemsOf(trx, [checklistId])).get(checklistId) ?? [];
        if (items.length >= MAX_ITEMS) return { refuse: 'too_many' };
        const item = await trx
          .insertInto('ticket_checklist_item')
          .values({
            workspace_id: request.workspaceId,
            checklist_id: checklistId,
            text: parsed.data.text,
            position: (items[items.length - 1]?.position ?? -1) + 1,
            created_by: request.user?.id ?? null,
          })
          .returning('id')
          .executeTakeFirstOrThrow();
        await record(trx, request, ticket, { change: 'item_added', checklistId, itemId: item.id }, [
          change(ticket.id, 'checklistItem', null, parsed.data.text),
        ]);
        return { code: 201 };
      });
    return answer(request, reply, ticket, result);
  });

  app.put('/api/v1/tickets/:id/checklists/:checklistId/items/order', async (request, reply) => {
    const params = listParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const parsed = checklistOrderBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const ids = parsed.data.ids;
    const checklistId = params.data.checklistId;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const list = await listOf(trx, ticket.id, checklistId);
        if (!list) return { refuse: 'not_found' };
        const items = (await itemsOf(trx, [checklistId])).get(checklistId) ?? [];
        const same =
          ids.length === items.length &&
          new Set(ids).size === ids.length &&
          items.every((item) => ids.includes(item.id));
        if (!same) return { refuse: 'stale' };
        if (items.every((item, i) => item.id === ids[i])) return { code: 200 };
        for (const [position, itemId] of ids.entries()) {
          await trx
            .updateTable('ticket_checklist_item')
            .set({ position, updated_at: new Date() })
            .where('id', '=', itemId)
            .execute();
        }
        const textOf = (itemId: number) => items.find((i) => i.id === itemId)?.text ?? '';
        await record(trx, request, ticket, { change: 'items_reordered', checklistId }, [
          change(
            ticket.id,
            'checklistOrder',
            shortList(items.map((i) => i.text)),
            shortList(ids.map(textOf)),
          ),
        ]);
        return { code: 200 };
      });
    return answer(request, reply, ticket, result);
  });

  app.patch('/api/v1/tickets/:id/checklists/:checklistId/items/:itemId', async (request, reply) => {
    const params = itemParams.safeParse(request.params);
    if (!params.success) return invalid(reply);
    const ticket = await writableTicket(request, reply);
    if (!ticket) return reply;
    const parsed = updateItemBody.safeParse(request.body);
    if (!parsed.success) return invalid(reply);
    const body = parsed.data;
    const { checklistId, itemId } = params.data;
    const result = await db
      .transaction()
      .execute(async (trx): Promise<Refused | { code: number }> => {
        if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
        const list = await listOf(trx, ticket.id, checklistId);
        if (!list) return { refuse: 'not_found' };
        const item = await trx
          .selectFrom('ticket_checklist_item')
          .select(['id', 'text', 'state'])
          .where('id', '=', itemId)
          .where('checklist_id', '=', checklistId)
          .executeTakeFirst();
        if (!item) return { refuse: 'not_found' };
        const next = { text: body.text ?? item.text, state: body.state ?? item.state };
        const changes: FieldChange[] = [];
        if (next.text !== item.text) {
          changes.push(change(ticket.id, 'checklistItem', item.text, next.text));
        }
        if (next.state !== item.state) {
          // The states as words of the reader's language: the page names them from these values.
          changes.push(
            change(ticket.id, 'checklistItemState', item.state, next.state, {
              from: next.text,
              to: next.text,
            }),
          );
        }
        if (changes.length === 0) return { code: 200 };
        await trx
          .updateTable('ticket_checklist_item')
          .set({ ...next, updated_at: new Date() })
          .where('id', '=', itemId)
          .execute();
        const what: ChecklistChange = next.state !== item.state ? 'item_state' : 'item_edited';
        await record(trx, request, ticket, { change: what, checklistId, itemId }, changes);
        return { code: 200 };
      });
    return answer(request, reply, ticket, result);
  });

  app.delete(
    '/api/v1/tickets/:id/checklists/:checklistId/items/:itemId',
    async (request, reply) => {
      const params = itemParams.safeParse(request.params);
      if (!params.success) return invalid(reply);
      const ticket = await writableTicket(request, reply);
      if (!ticket) return reply;
      const { checklistId, itemId } = params.data;
      const result = await db
        .transaction()
        .execute(async (trx): Promise<Refused | { code: number }> => {
          if (!(await holdTicket(trx, ticket.id))) return { refuse: 'not_found' };
          const list = await listOf(trx, ticket.id, checklistId);
          if (!list) return { refuse: 'not_found' };
          const item = await trx
            .deleteFrom('ticket_checklist_item')
            .where('id', '=', itemId)
            .where('checklist_id', '=', checklistId)
            .returning(['id', 'text'])
            .executeTakeFirst();
          if (!item) return { refuse: 'not_found' };
          await record(trx, request, ticket, { change: 'item_removed', checklistId, itemId }, [
            change(ticket.id, 'checklistItem', item.text, null),
          ]);
          return { code: 200 };
        });
      return answer(request, reply, ticket, result);
    },
  );
}
