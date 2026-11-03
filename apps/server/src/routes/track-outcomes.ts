import type { Database } from '@taskmoor/db';
import type { FastifyInstance } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { childProgress } from '../tickets/progress';
import { searchRefusal } from './search';

/**
 * A track's Outcomes section (AGL-024; ADR-116): `GET /api/v1/tracks/:id/outcomes` lists the
 * track's outcomes, the tickets whose type sits at the outcome level, each with how many of the
 * tickets under it are done (`childProgress`: a closed stage, as subtickets count). Open outcomes
 * come first, then closed ones, each in rank order, the backlog's order. Pages of up to 100 with an
 * opaque cursor; each page is one statement, outcomes and their counts together.
 *
 * Only reads, and Scrum and Kanban tracks alike. The person's ticket filter, the one search uses
 * (QRY-008), is part of the statement twice: an outcome they may not see is not listed, and a
 * ticket under one that they may not see counts neither as done nor at all. A track they may not
 * see answers as if there were none. The answer also names the outcome-level types the track
 * offers, so an empty section can say which type makes one.
 */
const MAX_INT = 2_147_483_647;
const PAGE_SIZE = 100;
const trackParam = z
  .object({
    id: z.union([
      z.coerce.number().int().positive().max(MAX_INT),
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/),
    ]),
  })
  .strict();
const outcomesQuery = z
  .object({
    cursor: z.string().min(1).max(400).optional(),
    limit: z.coerce.number().int().min(1).max(PAGE_SIZE).default(PAGE_SIZE),
  })
  .strict();

/** Where a page ends: whether that outcome was closed, and its rank (unique in a workspace). */
interface Cursor {
  closed: boolean;
  rank: string;
}
const cursorShape = z.object({ c: z.boolean(), r: z.string().min(1).max(200) }).strict();
const encodeCursor = (c: Cursor) =>
  Buffer.from(JSON.stringify({ c: c.closed, r: c.rank })).toString('base64url');
function decodeCursor(text: string): Cursor | null {
  try {
    const parsed = cursorShape.safeParse(JSON.parse(Buffer.from(text, 'base64url').toString()));
    return parsed.success ? { closed: parsed.data.c, rank: parsed.data.r } : null;
  } catch {
    return null;
  }
}

interface OutcomeRow {
  id: number;
  number: number;
  summary: string;
  rank: string;
  type: string;
  status: string;
  stage: 'new' | 'active' | 'closed';
  start_date: string | null;
  due_date: string | null;
  total: number;
  closed: number;
}

export interface TrackOutcomesOptions {
  timeoutMs?: number;
}

export function registerTrackOutcomeRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: TrackOutcomesOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  app.get('/api/v1/tracks/:id/outcomes', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const q = outcomesQuery.safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const cursor = q.data.cursor === undefined ? null : decodeCursor(q.data.cursor);
    if (q.data.cursor !== undefined && !cursor) {
      return reply.code(400).send({ error: 'invalid_cursor' });
    }
    const ws = request.workspaceId;
    const lookup = db
      .selectFrom('track as t')
      .select([
        't.id',
        't.key',
        't.name',
        // The outcome-level types the track offers, in its type set's order.
        sql<string[]>`ARRAY(
          SELECT y.name FROM type_set_member m
            JOIN ticket_type y ON y.id = m.ticket_type_id
            JOIN hierarchy_level h ON h.id = y.level_id
           WHERE m.type_set_id = t.type_set_id AND h.kind = 'outcome'
           ORDER BY m.sort_order)`.as('types'),
      ])
      .where('t.workspace_id', '=', ws)
      .where('t.deleted_at', 'is', null);
    const track = await (typeof p.data.id === 'number'
      ? lookup.where('t.id', '=', p.data.id)
      : lookup.where(sql<boolean>`upper(t.key) = upper(${p.data.id})`)
    ).executeTakeFirst();
    const held = track ? await request.authz.track(track.id) : null;
    if (!track || !held || !(held.has('browse_track') || held.has('administer_track'))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const filter = (await request.authz.ticketFilter()).sql;
    const after = cursor
      ? sql`AND (st.stage = 'closed', k.rank) > (${cursor.closed}::boolean, ${cursor.rank}::text)`
      : sql``;
    const limit = q.data.limit;
    try {
      const rows = await readOnly(db, timeoutMs, async (trx) => {
        const { rows } = await sql<OutcomeRow>`
          WITH page AS (
            SELECT k.id, k.number, k.summary, k.rank, y.name AS type, st.name AS status, st.stage,
                   k.start_date::text AS start_date, k.due_date::text AS due_date
              FROM ticket k
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
              JOIN status st ON st.id = k.status_id
             WHERE k.workspace_id = ${ws}::int AND k.track_id = ${track.id}::int
               AND k.deleted_at IS NULL AND h.kind = 'outcome' AND ${filter} ${after}
             ORDER BY st.stage = 'closed', k.rank
             LIMIT ${limit + 1}
          ),
          progress AS (${childProgress(ws, sql`SELECT id FROM page`, filter)})
          SELECT page.*, coalesce(p.total, 0) AS total, coalesce(p.closed, 0) AS closed
            FROM page LEFT JOIN progress p ON p.parent_id = page.id
           ORDER BY page.stage = 'closed', page.rank`.execute(trx);
        return rows;
      });
      const shown = rows.slice(0, limit);
      const last = shown[shown.length - 1];
      return {
        track: { id: track.id, key: track.key, name: track.name },
        outcomeTypes: track.types,
        outcomes: shown.map((o) => ({
          id: o.id,
          key: `${track.key}-${o.number}`,
          summary: o.summary,
          type: o.type,
          status: { name: o.status, stage: o.stage },
          startDate: o.start_date,
          dueDate: o.due_date,
          progress: { total: o.total, closed: o.closed },
        })),
        next:
          rows.length > limit && last
            ? encodeCursor({ closed: last.stage === 'closed', rank: last.rank })
            : null,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}
