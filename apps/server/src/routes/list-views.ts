import type { Database } from '@taskmoor/db';
import { QueryError } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { boardScope, compileQuery } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { SearchError } from '../search/bind';
import { DEFAULT_QUERY_TIMEOUT_MS, readOnly } from '../search/run';
import { isCalendarDay } from '../tickets/model';
import { trackParam, visibleTrack } from '../tracks/lookup';
import { searchRefusal } from './search';

/**
 * The reads behind a track's list and calendar views (M1-049; AGL-016, AGL-017; ADR-065):
 *
 * - `POST /api/v1/search/format-rules`: which of the tickets shown (at most 500) each format
 *   rule's condition matches, as the viewer. A rule is a condition in the query language, such
 *   as `due < now() AND stage != closed` (AGL-016 (1)); it is compiled through the search
 *   compiler with the viewer's ticket filter and tested against those ids only. A rule whose
 *   condition does not compile is answered with its error and matches nothing; the others
 *   still apply.
 * - `GET /api/v1/tracks/:keyOrId/calendar?from=&to=`: the viewer's tickets of the track with a
 *   start or due day in the range (at most 1,000, by due day), the sprints of boards in the
 *   track's space and the track's releases that overlap it.
 *
 * Moving a ticket on the calendar is the ticket's own change (`PATCH /tickets/:key`).
 */
const MAX_INT = 2_147_483_647;
const MAX_IDS = 500;
const MAX_RULES = 20;
const CALENDAR_CAP = 1000;
/** The longest range a calendar asks for: six weeks a month view shows, and some room. */
const MAX_DAYS = 100;

const formatBody = z
  .object({
    ids: z.array(z.number().int().positive().max(MAX_INT)).max(MAX_IDS),
    rules: z
      .array(
        z
          .object({ id: z.string().min(1).max(64), query: z.string().trim().min(1).max(2000) })
          .strict(),
      )
      .max(MAX_RULES),
  })
  .strict();
const day = z.string().refine(isCalendarDay, 'a calendar day as YYYY-MM-DD');
const calendarQuery = z.object({ from: day, to: day }).strict();

export interface ListViewOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

export function registerListViewRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: ListViewOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  app.post('/api/v1/search/format-rules', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const parsed = formatBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { ids, rules } = parsed.data;
    const scope = await boardScope(db, options.catalogs, request);
    const matches: Record<string, number[]> = {};
    const errors: Record<string, string> = {};
    for (const rule of rules) {
      matches[rule.id] = [];
      if (ids.length === 0) continue;
      try {
        const where = await compileQuery(db, scope, rule.query, new Date());
        matches[rule.id] = (
          await readOnly(db, timeoutMs, async (trx) =>
            (
              await sql<{ id: number }>`
                SELECT k.id FROM ticket k
                 WHERE k.id = ANY(${ids}::int[]) AND ${where}
                 ORDER BY k.id`.execute(trx)
            ).rows.map((r) => r.id),
          )
        ).filter((id) => ids.includes(id));
      } catch (error) {
        if (error instanceof QueryError || error instanceof SearchError) {
          errors[rule.id] = error.message;
          continue;
        }
        throw error;
      }
    }
    return { matches, errors };
  });

  app.get('/api/v1/tracks/:id/calendar', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const q = calendarQuery.safeParse(request.query ?? {});
    if (!q.success) return reply.code(400).send({ error: 'invalid_request' });
    const { from, to } = q.data;
    const span = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (span < 0 || span > MAX_DAYS) {
      return reply.code(400).send({ error: 'invalid_request', detail: 'range' });
    }
    const track = await visibleTrack(db, request, p.data.id);
    if (!track) return reply.code(404).send({ error: 'not_found' });
    try {
      const scope = await boardScope(db, options.catalogs, request);
      const where = await compileQuery(db, scope, `track = ${track.key}`, new Date());
      return await readOnly(db, timeoutMs, async (trx) => {
        const tickets = (
          await sql<{
            id: number;
            key: string;
            summary: string;
            type: string;
            stage: 'new' | 'active' | 'closed';
            start: string | null;
            due: string | null;
          }>`
            SELECT k.id, t.key || '-' || k.number AS key, k.summary, y.name AS type, s.stage,
                   k.start_date::text AS start, k.due_date::text AS due
              FROM ticket k
              JOIN track t ON t.id = k.track_id
              JOIN status s ON s.id = k.status_id
              JOIN ticket_type y ON y.id = k.ticket_type_id
             WHERE ${where}
               AND (k.due_date BETWEEN ${from}::date AND ${to}::date
                    OR k.start_date BETWEEN ${from}::date AND ${to}::date)
             ORDER BY COALESCE(k.due_date, k.start_date), k.rank
             LIMIT ${CALENDAR_CAP + 1}`.execute(trx)
        ).rows;
        const sprints = (
          await sql<{ id: number; name: string; state: string; start: string; end: string }>`
            SELECT s.id, s.name, s.state,
                   (s.start_at AT TIME ZONE 'UTC')::date::text AS start,
                   (s.end_at AT TIME ZONE 'UTC')::date::text AS end
              FROM sprint s JOIN board b ON b.id = s.board_id
             WHERE s.workspace_id = ${request.workspaceId}::int
               AND b.location_track_id = ${track.id}::int AND s.deleted_at IS NULL
               AND s.start_at IS NOT NULL AND s.end_at IS NOT NULL
               AND (s.start_at AT TIME ZONE 'UTC')::date <= ${to}::date
               AND (s.end_at AT TIME ZONE 'UTC')::date >= ${from}::date
             ORDER BY s.start_at, s.id`.execute(trx)
        ).rows;
        const releases = (
          await sql<{ id: number; name: string; date: string; shipped: boolean }>`
            SELECT r.id, r.name, r.release_date::text AS date, r.shipped_at IS NOT NULL AS shipped
              FROM release r
             WHERE r.track_id = ${track.id}::int AND r.archived_at IS NULL
               AND r.release_date BETWEEN ${from}::date AND ${to}::date
             ORDER BY r.release_date, r.sort_order`.execute(trx)
        ).rows;
        return {
          track,
          tickets: tickets.slice(0, CALENDAR_CAP),
          sprints,
          releases,
          truncated: tickets.length > CALENDAR_CAP,
        };
      });
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });
}
