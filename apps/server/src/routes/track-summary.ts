import type { Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { boardScope, compileQuery, type Scope } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { COUNT_CAP, DEFAULT_QUERY_TIMEOUT_MS, prepareSearch, readOnly } from '../search/run';
import { searchPerson, searchRefusal } from './search';

/**
 * A track's summary page (M1-064; RPT-006): how many of its tickets are open, created, closed,
 * updated and due soon, by stage, priority, type and assignee. Every number comes with the
 * query that finds those tickets, and is that query's count through the search runner as the
 * viewer, so a summary always equals the search it links to.
 */
const MAX_INT = 2_147_483_647;
const trackParam = z
  .object({
    id: z.union([
      z.coerce.number().int().positive().max(MAX_INT),
      z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,29}$/),
    ]),
  })
  .strict();
/** How many assignees a summary names; the rest stay in the open count. */
const ASSIGNEES = 10;

export interface SummaryItem {
  id: string;
  /** What the item counts: a stage, a priority, a type or a person's name; null for none. */
  name: string | null;
  query: string;
  count: number;
  exact: boolean;
}

/** A value as the query language reads it: a quoted string with its quotes escaped. */
const quoted = (text: string) => `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

export interface TrackSummaryOptions {
  catalogs: FieldCatalogs;
  timeoutMs?: number;
}

export function registerTrackSummaryRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: TrackSummaryOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  /** A query's count as the search page would say it (capped like it). */
  async function count(request: FastifyRequest, scope: Scope, q: string) {
    const { compiled } = await prepareSearch({
      db,
      workspaceId: scope.ws,
      catalog: scope.catalog,
      catalogue: scope.catalogue,
      filter: scope.filter,
      q,
      ...searchPerson(request),
    });
    const n = await readOnly(db, timeoutMs, async (trx) => {
      const { rows } = await compiled.count(COUNT_CAP + 1).execute(trx);
      return rows[0]?.n ?? 0;
    });
    return { count: Math.min(n, COUNT_CAP), exact: n <= COUNT_CAP };
  }

  app.get('/api/v1/tracks/:id/summary', async (request, reply) => {
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
      const base = `track = ${track.key}`;
      const open = `${base} AND closeReason IS EMPTY`;
      // The values to name: those the viewer's open tickets in the track have.
      const openWhere = await compileQuery(db, scope, open, new Date());
      const groups = await readOnly(db, timeoutMs, async (trx) => {
        const priorities = await sql<{ name: string | null; sort: number | null }>`
          SELECT DISTINCT p.name, p.sort_order AS sort
            FROM ticket k LEFT JOIN priority p ON p.id = k.priority_id
           WHERE ${openWhere}
           ORDER BY p.sort_order NULLS LAST`.execute(trx);
        const types = await sql<{ name: string }>`
          SELECT DISTINCT tt.name FROM ticket k JOIN ticket_type tt ON tt.id = k.ticket_type_id
           WHERE ${openWhere} ORDER BY tt.name`.execute(trx);
        const assignees = await sql<{ id: number | null; name: string | null; n: number }>`
          SELECT k.assignee_id AS id, u.name, count(*)::int AS n
            FROM ticket k LEFT JOIN app_user u ON u.id = k.assignee_id
           WHERE ${openWhere}
           GROUP BY k.assignee_id, u.name
           ORDER BY count(*) DESC, u.name NULLS LAST
           LIMIT ${ASSIGNEES + 1}`.execute(trx);
        return {
          priorities: priorities.rows,
          types: types.rows,
          assignees: assignees.rows,
        };
      });
      const item = async (
        id: string,
        name: string | null,
        query: string,
      ): Promise<SummaryItem> => ({
        id,
        name,
        query,
        ...(await count(request, scope, query)),
      });
      const overview = await Promise.all([
        item('open', null, open),
        item('created', null, `${base} AND created >= -7d`),
        item('closed', null, `${base} AND closed >= -7d`),
        item('updated', null, `${base} AND updated >= -7d`),
        item('due', null, `${open} AND due <= 7d`),
      ]);
      const stages = await Promise.all(
        ['new', 'active', 'closed'].map((s) => item(s, s, `${base} AND stage = ${s}`)),
      );
      const priorities = await Promise.all(
        groups.priorities.map((g) =>
          g.name === null
            ? item('none', null, `${open} AND priority IS EMPTY`)
            : item(g.name, g.name, `${open} AND priority = ${quoted(g.name)}`),
        ),
      );
      const types = await Promise.all(
        groups.types.map((g) => item(g.name, g.name, `${open} AND type = ${quoted(g.name)}`)),
      );
      const assignees = await Promise.all(
        groups.assignees
          .slice(0, ASSIGNEES)
          .map((g) =>
            g.id === null
              ? item('unassigned', null, `${open} AND assignee IS EMPTY`)
              : item(String(g.id), g.name, `${open} AND assignee = ${g.id}`),
          ),
      );
      return {
        track: { id: track.id, key: track.key, name: track.name },
        overview,
        stages,
        priorities,
        types,
        assignees,
      };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });
}
