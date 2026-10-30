import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { requireUser } from '../auth';
import { boardScope, boardTracks, compileBoard } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { readOnly } from '../search/run';
import { searchRefusal } from './search';
import type { SprintBoard } from './sprints';

/**
 * Planning on a Scrum board's backlog (M1-047; AGL-008, AGL-009; ADR-054 "Planning"):
 *
 * - `GET /api/v1/boards/:id/backlog/panels`: the outcomes (tickets of the outcome level) and the
 *   unshipped releases of the board's tracks, with how many of their tickets the viewer sees.
 * - `POST /api/v1/boards/:id/backlog/rank`: a block of selected tickets, in the order given,
 *   before or after another ticket (or at the top or the bottom).
 * - `POST /api/v1/boards/:id/backlog/parent` and `/release`: selected tickets put under an
 *   outcome (or taken from it) or added to a release.
 *
 * Every change runs the ticket routes as the person (rank, change), one ticket at a time, with
 * their permission checks, refusals and events, as board moves and bulk changes do (ADR-043).
 * The answer lists each ticket's outcome; when none went through, it is the first refusal's
 * status and code, as for a single ticket.
 * Moving selected tickets into a sprint is already one operation (`/sprints/:id/tickets`).
 */
const MAX_INT = 2_147_483_647;
const MAX_SELECTED = 1000;
const id = z.number().int().positive().max(MAX_INT);
const idParam = z.object({ id: z.coerce.number().int().positive().max(MAX_INT) }).strict();
const selection = z
  .array(id)
  .min(1)
  .max(MAX_SELECTED)
  .refine((list) => new Set(list).size === list.length, 'duplicate');
const rankBody = z
  .object({
    tickets: selection,
    before: id.optional(),
    after: id.optional(),
    position: z.enum(['top', 'bottom']).optional(),
  })
  .strict()
  .refine(
    (b) => [b.before, b.after, b.position].filter((v) => v !== undefined).length === 1,
    'one of before, after or position',
  );
const parentBody = z
  .object({ tickets: selection, parent: z.union([id, z.string().min(1).max(64)]).nullable() })
  .strict();
const releaseBody = z.object({ tickets: selection, releaseId: id }).strict();

const invalidFields = (reply: FastifyReply, fields: Record<string, string>) =>
  reply.code(400).send({ error: 'invalid_fields', fields });
const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not_found' });

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

export type TicketCall = (
  request: FastifyRequest,
  route: 'rank' | 'update',
  ticketId: number,
  body: unknown,
) => Promise<{ statusCode: number; payload: unknown }>;

export interface BacklogPlanningDeps {
  catalogs: FieldCatalogs;
  timeoutMs: number;
  /** A board the caller sees, or null after answering 404. */
  board: (request: FastifyRequest, reply: FastifyReply, id: number) => Promise<SprintBoard | null>;
  /** Runs a ticket route as the caller. */
  ticket: TicketCall;
}

/** One ticket's outcome in a batch: done, or refused with the ticket route's answer. */
interface Result {
  ticket: number;
  ok: boolean;
  status: number;
  error?: string;
}

const errorOf = (payload: unknown) =>
  typeof (payload as { error?: unknown } | null)?.error === 'string'
    ? (payload as { error: string }).error
    : undefined;

/** A batch's answer: its results, or the first refusal when nothing went through. */
function answer(
  reply: FastifyReply,
  outcome: { done: number; results: Result[] },
  count: 'ranked' | 'updated',
) {
  const first = outcome.results[0];
  if (outcome.done === 0 && first && !first.ok) {
    return reply
      .code(first.status)
      .send({ error: first.error ?? 'refused', results: outcome.results });
  }
  return { [count]: outcome.done, results: outcome.results };
}

export function registerBacklogPlanningRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  deps: BacklogPlanningDeps,
): void {
  const { catalogs, timeoutMs } = deps;

  async function scrumBoard(request: FastifyRequest, reply: FastifyReply) {
    const p = idParam.safeParse(request.params);
    if (!p.success) {
      await notFound(reply);
      return null;
    }
    const board = await deps.board(request, reply, p.data.id);
    if (!board) return null;
    if (board.kind !== 'scrum') {
      await reply.code(409).send({ error: 'not_scrum' });
      return null;
    }
    return board;
  }

  /** Runs one change per ticket; the batch's answer says which went through. */
  async function each(
    tickets: readonly number[],
    call: (ticketId: number, index: number) => Promise<{ statusCode: number; payload: unknown }>,
    stopOnFailure: boolean,
  ) {
    const results: Result[] = [];
    for (const [i, ticket] of tickets.entries()) {
      const answer = await call(ticket, i);
      const ok = answer.statusCode >= 200 && answer.statusCode < 300;
      const error = errorOf(answer.payload);
      results.push({ ticket, ok, status: answer.statusCode, ...(error ? { error } : {}) });
      if (!ok && stopOnFailure) break;
    }
    return { done: results.filter((r) => r.ok).length, results };
  }

  app.get('/api/v1/boards/:id/backlog/panels', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    try {
      const scope = await boardScope(db, catalogs, request);
      const compiled = await compileBoard(db, scope, board.record, [], new Date());
      const tracks = await boardTracks(db, compiled, board.record.locationTrackId, timeoutMs);
      const ws = request.workspaceId;
      return await readOnly(db, timeoutMs, async (trx) => {
        const outcomes = (
          await sql<{ id: number; key: string; summary: string; status: string }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, s.name AS status
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
             WHERE k.workspace_id = ${ws}::int AND k.deleted_at IS NULL AND ${scope.filter.sql}
               AND k.track_id = ANY(${tracks}::int[]) AND h.kind = 'outcome'
               AND s.stage <> 'closed'
             ORDER BY k.rank
             LIMIT 200`.execute(trx)
        ).rows;
        const children =
          outcomes.length === 0
            ? []
            : (
                await sql<{ parent_id: number; total: number; closed: number }>`
                  SELECT k.parent_id, count(*)::int AS total,
                         count(*) FILTER (WHERE k.close_reason_id IS NOT NULL)::int AS closed
                    FROM ticket k
                   WHERE k.workspace_id = ${ws}::int AND k.deleted_at IS NULL
                     AND k.parent_id = ANY(${outcomes.map((o) => o.id)}::int[]) AND ${scope.filter.sql}
                   GROUP BY k.parent_id`.execute(trx)
              ).rows;
        const childrenOf = new Map(children.map((c) => [c.parent_id, c]));
        const releases = (
          await sql<{
            id: number;
            name: string;
            track_id: number;
            release_date: string | null;
            tickets: number;
          }>`
            SELECT r.id, r.name, r.track_id, r.release_date::text AS release_date,
                   (SELECT count(*)::int FROM ticket_release tr JOIN ticket k ON k.id = tr.ticket_id
                     WHERE tr.release_id = r.id AND tr.role = 'target' AND k.deleted_at IS NULL
                       AND ${scope.filter.sql}) AS tickets
              FROM release r
             WHERE r.workspace_id = ${ws}::int AND r.track_id = ANY(${tracks}::int[])
               AND r.shipped_at IS NULL AND r.archived_at IS NULL
             ORDER BY r.track_id, r.sort_order, r.id`.execute(trx)
        ).rows;
        return {
          outcomes: outcomes.map((o) => ({
            ...o,
            tickets: childrenOf.get(o.id)?.total ?? 0,
            closed: childrenOf.get(o.id)?.closed ?? 0,
          })),
          releases: releases.map((r) => ({
            id: r.id,
            name: r.name,
            trackId: r.track_id,
            releaseDate: r.release_date,
            tickets: r.tickets,
          })),
        };
      });
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

  // A block of tickets ranked together: the first one at the place asked for, each next one
  // right after the one before, so the block keeps the order given (AGL-009).
  app.post('/api/v1/boards/:id/backlog/rank', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = rankBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const body = parsed.data;
    const anchor = body.before ?? body.after;
    if (anchor !== undefined && body.tickets.includes(anchor)) {
      return invalidFields(reply, { [body.before !== undefined ? 'before' : 'after']: 'selected' });
    }
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const outcome = await each(
      body.tickets,
      (ticket, i) => {
        const prior = body.tickets[i - 1];
        const place =
          prior !== undefined
            ? { after: prior }
            : body.before !== undefined
              ? { before: body.before }
              : body.after !== undefined
                ? { after: body.after }
                : { position: body.position };
        return deps.ticket(request, 'rank', ticket, place);
      },
      true,
    );
    return answer(reply, outcome, 'ranked');
  });

  // Selected tickets under an outcome, or taken from their parent (AGL-008 (2)).
  app.post('/api/v1/boards/:id/backlog/parent', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = parentBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const parent = parsed.data.parent === null ? null : String(parsed.data.parent);
    const outcome = await each(
      parsed.data.tickets,
      (ticket) => deps.ticket(request, 'update', ticket, { parent }),
      false,
    );
    return answer(reply, outcome, 'updated');
  });

  // Selected tickets added to a release, keeping the releases they already target.
  app.post('/api/v1/boards/:id/backlog/release', async (request, reply) => {
    if (!requireUser(request, reply)) return reply;
    const parsed = releaseBody.safeParse(request.body ?? {});
    if (!parsed.success) return invalidFields(reply, shapeErrors(parsed.error));
    const board = await scrumBoard(request, reply);
    if (!board) return reply;
    const { tickets, releaseId } = parsed.data;
    const current = await db
      .selectFrom('ticket_release')
      .select(['ticket_id', 'release_id'])
      .where('ticket_id', 'in', [...tickets])
      .where('role', '=', 'target')
      .execute();
    const targets = new Map<number, number[]>();
    for (const r of current)
      targets.set(r.ticket_id, [...(targets.get(r.ticket_id) ?? []), r.release_id]);
    const outcome = await each(
      tickets,
      async (ticket) => {
        const now = targets.get(ticket) ?? [];
        // Already there: nothing to change, and it counts as done.
        if (now.includes(releaseId)) return { statusCode: 200, payload: {} };
        return deps.ticket(request, 'update', ticket, { targetReleaseIds: [...now, releaseId] });
      },
      false,
    );
    return answer(reply, outcome, 'updated');
  });
}
