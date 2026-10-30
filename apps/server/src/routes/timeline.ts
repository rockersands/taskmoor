import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { boardScope, compileQuery } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { searchRefusal } from './search';

/**
 * A track's timeline (M1-048; AGL-015; ADR-064): `GET /api/v1/tracks/:keyOrId/timeline`.
 *
 * - **Items**: the track's tickets the viewer sees, in rank order (the first 5,000), each with
 *   its parent, level and stage. A ticket's **dates** are its own start and due dates; one
 *   without them that sits in a sprint takes the sprint's start and end (an open sprint first,
 *   else the latest), as Scrum children are dated by sprint.
 * - **Roll-ups** (AGL-015 (1), (3)): a ticket with children gets the span from the earliest
 *   start to the latest due date of all its descendants, and how many of them are closed. They
 *   are computed in one recursive statement over the whole track, never over the listed 5,000
 *   only, so they stay on however large the track is.
 * - **Dependencies**: links of the blocking kind (a link type whose outward phrase is
 *   "blocks") between listed tickets: `from` blocks `to`.
 * - **Markers**: the sprints of boards in the track's space that have dates, and the track's
 *   releases with a release date that are not archived.
 *
 * Rescheduling is the ticket routes' own change (`PATCH /tickets/:id` with `startDate` and
 * `dueDate`), with its permission ("Schedule tickets"), history and events.
 */
const MAX_INT = 2_147_483_647;
const LISTED = 5000;
const trackParam = z
  .object({
    id: z.union([
      z.coerce.number().int().positive().max(MAX_INT),
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/),
    ]),
  })
  .strict();

export interface TimelineOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

interface ItemRow {
  id: number;
  key: string;
  summary: string;
  type: string;
  level_rank: number;
  level_kind: string;
  parent_id: number | null;
  status: string;
  stage: 'new' | 'active' | 'closed';
  start_date: string | null;
  due_date: string | null;
  sprint_start: string | null;
  sprint_end: string | null;
}

interface RollupRow {
  id: number;
  start: string | null;
  due: string | null;
  total: number;
  closed: number;
}

export function registerTimelineRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: TimelineOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  app.get('/api/v1/tracks/:id/timeline', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const ws = request.workspaceId;
    let lookup = db
      .selectFrom('track')
      .select(['id', 'key', 'name'])
      .where('workspace_id', '=', ws)
      .where('deleted_at', 'is', null);
    lookup =
      typeof p.data.id === 'number'
        ? lookup.where('id', '=', p.data.id)
        : lookup.where(sql<boolean>`upper(key) = upper(${p.data.id})`);
    const track = await lookup.executeTakeFirst();
    const held = track ? await request.authz.track(track.id) : null;
    if (!track || !held || !(held.has('browse_track') || held.has('administer_track'))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const scope = await boardScope(db, options.catalogs, request);
      // The viewer's tickets of the track, as the search finds them.
      const where = await compileQuery(db, scope, `track = ${track.key}`, new Date());
      return await readOnly(db, timeoutMs, async (trx) => {
        // A ticket's sprint dates: an open sprint it is in, else the latest it was in.
        const dated = sql`
          SELECT k.id, k.parent_id, k.closed_at,
                 COALESCE(k.start_date, (sp.start_at AT TIME ZONE 'UTC')::date) AS s,
                 COALESCE(k.due_date, (sp.end_at AT TIME ZONE 'UTC')::date) AS d,
                 k.start_date, k.due_date,
                 (sp.start_at AT TIME ZONE 'UTC')::date AS sprint_start,
                 (sp.end_at AT TIME ZONE 'UTC')::date AS sprint_end
            FROM ticket k
            LEFT JOIN LATERAL (
              SELECT s.start_at, s.end_at FROM sprint_ticket st JOIN sprint s ON s.id = st.sprint_id
               WHERE st.ticket_id = k.id AND s.deleted_at IS NULL
               ORDER BY st.open DESC, s.sequence DESC LIMIT 1) sp ON true
           WHERE ${where}`;
        const items = (
          await sql<ItemRow>`
            WITH v AS (${dated})
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type,
                   h.rank AS level_rank, h.kind AS level_kind, k.parent_id, s.name AS status,
                   s.stage, v.start_date::text, v.due_date::text,
                   v.sprint_start::text, v.sprint_end::text
              FROM v
              JOIN ticket k ON k.id = v.id
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
              JOIN hierarchy_level h ON h.id = y.level_id
             ORDER BY k.rank
             LIMIT ${LISTED + 1}`.execute(trx)
        ).rows;
        const listed = items.slice(0, LISTED);
        // Roll-ups over every descendant the viewer sees in the track, however many.
        const rollups = (
          await sql<RollupRow>`
            WITH RECURSIVE v AS (${dated}),
            tree AS (
              SELECT v.id AS root, v.id, v.s, v.d, v.closed_at, 0 AS depth FROM v
               WHERE EXISTS (SELECT 1 FROM v c WHERE c.parent_id = v.id)
              UNION ALL
              SELECT tree.root, c.id, c.s, c.d, c.closed_at, tree.depth + 1
                FROM tree JOIN v c ON c.parent_id = tree.id
               WHERE tree.depth < 10
            )
            SELECT root AS id, min(s)::text AS start, max(d)::text AS due,
                   count(*)::int AS total,
                   count(*) FILTER (WHERE closed_at IS NOT NULL)::int AS closed
              FROM tree WHERE depth > 0
             GROUP BY root`.execute(trx)
        ).rows;
        const rollupOf = new Map(rollups.map((r) => [r.id, r]));
        const ids = listed.map((i) => i.id);
        const links =
          ids.length === 0
            ? []
            : (
                await sql<{ from: number; to: number }>`
                  SELECT l.source_id AS from, l.target_id AS to
                    FROM ticket_link l JOIN link_type lt ON lt.id = l.link_type_id
                   WHERE l.workspace_id = ${ws}::int AND lower(lt.outward) = 'blocks'
                     AND l.source_id = ANY(${ids}::int[]) AND l.target_id = ANY(${ids}::int[])
                   ORDER BY l.source_id, l.target_id`.execute(trx)
              ).rows;
        const sprints = (
          await sql<{ id: number; name: string; state: string; start: string; end: string }>`
            SELECT s.id, s.name, s.state,
                   (s.start_at AT TIME ZONE 'UTC')::date::text AS start,
                   (s.end_at AT TIME ZONE 'UTC')::date::text AS end
              FROM sprint s JOIN board b ON b.id = s.board_id
             WHERE s.workspace_id = ${ws}::int AND b.location_track_id = ${track.id}::int
               AND s.deleted_at IS NULL AND s.start_at IS NOT NULL AND s.end_at IS NOT NULL
             ORDER BY s.start_at, s.id`.execute(trx)
        ).rows;
        const releases = (
          await sql<{ id: number; name: string; date: string; shipped: boolean }>`
            SELECT r.id, r.name, r.release_date::text AS date, r.shipped_at IS NOT NULL AS shipped
              FROM release r
             WHERE r.track_id = ${track.id}::int AND r.archived_at IS NULL
               AND r.release_date IS NOT NULL
             ORDER BY r.release_date, r.sort_order`.execute(trx)
        ).rows;
        return {
          track,
          items: listed.map((i) => {
            const own = i.start_date !== null || i.due_date !== null;
            const bySprint = !own && i.sprint_start !== null;
            const rollup = rollupOf.get(i.id);
            return {
              id: i.id,
              key: i.key,
              summary: i.summary,
              type: i.type,
              level: { rank: i.level_rank, kind: i.level_kind },
              parentId: i.parent_id,
              status: { name: i.status, stage: i.stage },
              start: own ? i.start_date : bySprint ? i.sprint_start : null,
              due: own ? i.due_date : bySprint ? i.sprint_end : null,
              /** Where the dates come from: the ticket itself or its sprint; null for none. */
              dated: own ? 'own' : bySprint ? 'sprint' : null,
              rollup: rollup
                ? {
                    start: rollup.start,
                    due: rollup.due,
                    total: rollup.total,
                    closed: rollup.closed,
                  }
                : null,
            };
          }),
          links,
          markers: { sprints, releases },
          truncated: items.length > LISTED,
        };
      });
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });
}
