import { z } from 'zod';
import { bulkEditBody, bulkMoveBody } from '../routes/tickets';

/**
 * A bulk change (M1-021; CORE-024): an action and the tickets it applies to, as ids or keys in
 * the order given, or as a query (M1-037) whose results, in the query's order, are the tickets.
 * Exactly one of `tickets` and `query`. There is no fixed cap of 1,000 tickets (CORE-024 (2));
 * 100,000 bounds one request, and more go in several.
 */
export const MAX_BULK_TICKETS = 100_000;

const id = z.number().int().positive();
const ref = z.union([id, z.string().trim().min(1).max(300)]);
const tickets = z.array(ref).min(1).max(MAX_BULK_TICKETS).optional();
/** The query language (QRY), run as the person asking: only tickets they may see. */
const query = z.string().trim().min(1).max(100_000).optional();

export const bulkBody = z.discriminatedUnion('action', [
  z.object({ action: z.literal('edit'), tickets, query, edit: bulkEditBody }).strict(),
  z.object({ action: z.literal('move'), tickets, query, move: bulkMoveBody }).strict(),
  z
    .object({
      action: z.literal('transition'),
      tickets,
      query,
      transition: z
        .object({
          /** A transition of the tickets' workflow, or the status to reach by the one offered. */
          transitionId: id.optional(),
          statusId: id.optional(),
          fields: z.record(z.string().max(100), z.unknown()).optional(),
        })
        .strict()
        .refine(
          (t) => (t.transitionId === undefined) !== (t.statusId === undefined),
          'exactly one of transitionId and statusId',
        ),
    })
    .strict(),
  z.object({ action: z.literal('delete'), tickets, query }).strict(),
]);
export type BulkRequest = z.infer<typeof bulkBody>;
export type BulkAction = BulkRequest['action'];

/**
 * What the operation stores to run: the action's own part of the request, and the query that
 * chose the tickets, if one did (shown with the operation; the job does not read it).
 */
export function paramsOf(request: BulkRequest): Record<string, unknown> {
  const chosen = request.query === undefined ? {} : { query: request.query };
  switch (request.action) {
    case 'edit':
      return { edit: request.edit, ...chosen };
    case 'move':
      return { move: request.move, ...chosen };
    case 'transition':
      return { transition: request.transition, ...chosen };
    case 'delete':
      return chosen;
  }
}
