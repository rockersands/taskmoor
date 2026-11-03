import type { DashboardLayout, Database } from '@taskmoor/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { boardScope, compileQuery, type Scope } from '../boards/data';
import {
  LAYOUTS,
  MAX_WIDGETS,
  readWidgets,
  storedWidgets,
  WIDGET_SETTINGS,
  type Widget,
  widgetInput,
} from '../dashboards/model';
import { widgetData } from '../dashboards/widgets';
import { emit } from '../events/bus';
import type { FieldCatalogs } from '../fields/catalog';
import { COUNT_CAP, DEFAULT_QUERY_TIMEOUT_MS, prepareSearch, readOnly } from '../search/run';
import { searchPerson, searchRefusal } from './search';

/**
 * A track's summary page (M1-064; RPT-006): how many of its tickets are open, created, closed,
 * updated and due soon, by stage, priority, type and assignee. Every number comes with the
 * query that finds those tickets, and is that query's count through the search runner as the
 * viewer, so a summary always equals the search it links to.
 *
 * Also the two other things one track's pages read (ADR-116; RPT-002, RPT-006):
 *
 * - `GET /api/v1/tracks/:id/statistics/:kind`: a general report of the track, computed like the
 *   dashboard widget of that kind with its query forced to the track. A caller cannot give a
 *   query, and the viewer's filter applies as in a search, so nothing widens what anyone sees.
 * - `GET`, `PUT` and `DELETE /api/v1/tracks/:id/summary-layout`: the track's customized Summary,
 *   at most one. Everyone who sees the track reads it; only the track's owner and those who may
 *   administer it change it. `PUT` saves it with the version it was read at (none for the first);
 *   `DELETE` goes back to the default. `GET .../summary-layout/widgets/:widgetId` is a widget's data
 *   as the viewer, an empty query meaning the track.
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
/** The general reports a track's Statistics reads; all take a query, which here is the track's. */
const STATISTIC_KINDS = [
  'created-vs-closed',
  'recently-created',
  'average-age',
  'time-to-close',
  'ticket-statistics',
  'two-dimensional',
  'pie',
  'time-since',
  'group-by',
  'workload',
  'time-tracking',
] as const;
const statisticParam = z
  .object({ id: trackParam.shape.id, kind: z.enum(STATISTIC_KINDS) })
  .strict();
const flag = z.enum(['true', 'false']).optional();
/** Everything but a query: the settings of the kinds above, checked per kind. */
const statisticQuery = z
  .object({
    days: z.coerce.number().int().optional(),
    period: z.string().max(10).optional(),
    cumulative: flag,
    field: z.string().max(60).optional(),
    x: z.string().max(60).optional(),
    y: z.string().max(60).optional(),
    sort: z.string().max(10).optional(),
    limit: z.coerce.number().int().optional(),
    statistic: z.string().max(30).optional(),
    open: flag,
    release: z.coerce.number().int().optional(),
    view: z.string().max(10).optional(),
  })
  .strict();
const layoutWidgetParam = z
  .object({ id: trackParam.shape.id, widgetId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/) })
  .strict();
const layoutBody = z
  .object({
    layout: z.enum(LAYOUTS),
    widgets: z.array(widgetInput).max(MAX_WIDGETS),
    /** The version read; left out only for a track with no customized Summary yet. */
    version: z.number().int().positive().optional(),
  })
  .strict();

function shapeErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join('.') || 'body';
    if (!(path in out)) out[path] = issue.message.length < 40 ? issue.message : 'invalid';
  }
  return out;
}

interface TrackRow {
  id: number;
  key: string;
  name: string;
  owner_id: number | null;
  archived_at: Date | null;
}

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

/** How many files and how many links the track's page lists, newest first. */
const FILES_SHOWN = 200;

export function registerTrackSummaryRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  options: TrackSummaryOptions,
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  /** The track when the person sees it; those who do not get the same answer as for no track. */
  async function seenTrack(request: FastifyRequest, id: number | string) {
    const lookup = db
      .selectFrom('track')
      .select(['id', 'key', 'name', 'owner_id', 'archived_at'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deleted_at', 'is', null);
    const track = (await (typeof id === 'number'
      ? lookup.where('id', '=', id)
      : lookup.where(sql<boolean>`upper(key) = upper(${id})`)
    ).executeTakeFirst()) as TrackRow | undefined;
    if (!track) return null;
    const held = await request.authz.track(track.id);
    if (!held.has('browse_track') && !held.has('administer_track')) return null;
    const mayCustomize =
      track.archived_at === null &&
      (track.owner_id === request.user?.id || held.has('administer_track'));
    return { track, mayCustomize };
  }

  const widgetContext = (request: FastifyRequest, track: TrackRow) => ({
    db,
    catalogs: options.catalogs,
    timeoutMs,
    request,
    track: { key: track.key },
  });

  /** The customized Summary as the API says it, or null for the default. */
  async function customLayout(trackId: number) {
    const row = await db
      .selectFrom('track_summary_layout')
      .select(['layout', 'widgets', 'version', 'updated_at'])
      .where('track_id', '=', trackId)
      .executeTakeFirst();
    return row
      ? {
          layout: row.layout,
          widgets: storedWidgets(row.widgets),
          version: row.version,
          updatedAt: row.updated_at,
        }
      : null;
  }

  // A general report of the track (ADR-116; RPT-002): always the track, as the viewer sees it.
  app.get('/api/v1/tracks/:id/statistics/:kind', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = statisticParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const q = statisticQuery.safeParse(request.query);
    if (!q.success) {
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(q.error) });
    }
    const found = await seenTrack(request, p.data.id);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const { cumulative, open, ...settings } = q.data;
    const config = WIDGET_SETTINGS[p.data.kind].safeParse({
      ...settings,
      ...(cumulative === undefined ? {} : { cumulative: cumulative === 'true' }),
      ...(open === undefined ? {} : { open: open === 'true' }),
    });
    if (!config.success) {
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(config.error) });
    }
    const widget: Widget = {
      id: p.data.kind,
      kind: p.data.kind,
      column: 0,
      title: '',
      config: { ...config.data, query: '' },
    };
    try {
      return { data: await widgetData(widgetContext(request, found.track), widget) };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });

  // A track's customized Summary (ADR-116; RPT-006).
  app.get('/api/v1/tracks/:id/summary-layout', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const found = await seenTrack(request, p.data.id);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const { id, key, name } = found.track;
    return {
      track: { id, key, name },
      mayCustomize: found.mayCustomize,
      custom: await customLayout(id),
    };
  });

  app.put('/api/v1/tracks/:id/summary-layout', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const found = await seenTrack(request, p.data.id);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    if (!found.mayCustomize) {
      return reply.code(403).send({ error: 'forbidden', permission: 'administer_track' });
    }
    const parsed = layoutBody.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_fields', fields: shapeErrors(parsed.error) });
    }
    const body = parsed.data;
    const layout: DashboardLayout = body.layout;
    const read = readWidgets(body.widgets, layout, { onTrack: true });
    if ('fields' in read) {
      return reply.code(400).send({ error: 'invalid_fields', fields: read.fields });
    }
    const { track } = found;
    const by = { workspaceId: request.workspaceId, actorId: request.user.id };
    const widgets = JSON.stringify(read.widgets);
    const outcome = await db.transaction().execute(async (trx) => {
      const current = await trx
        .selectFrom('track_summary_layout')
        .select(['layout', 'widgets', 'version'])
        .where('track_id', '=', track.id)
        .forUpdate()
        .executeTakeFirst();
      // Someone else customized it, changed it or went back to the default meanwhile.
      if (current?.version !== body.version) return { conflict: current?.version ?? null };
      if (current) {
        if (
          current.layout === layout &&
          JSON.stringify(storedWidgets(current.widgets)) === widgets
        ) {
          return { unchanged: true as const };
        }
        await trx
          .updateTable('track_summary_layout')
          .set({ layout, widgets, version: current.version + 1, updated_at: new Date() })
          .where('track_id', '=', track.id)
          .execute();
      } else {
        const made = await trx
          .insertInto('track_summary_layout')
          .values({ track_id: track.id, workspace_id: request.workspaceId, layout, widgets })
          .onConflict((c) => c.column('track_id').doNothing())
          .returning('track_id')
          .executeTakeFirst();
        if (!made) return { conflict: null };
      }
      await emit(trx, by, {
        type: 'track.summary_layout_set',
        subjectId: track.id,
        payload: {
          trackKey: track.key,
          layout,
          widgets: read.widgets.map((w) => w.kind),
          created: current === undefined,
        },
      });
      return { saved: true as const };
    });
    if ('conflict' in outcome) {
      return reply.code(409).send({ error: 'version_conflict', version: outcome.conflict });
    }
    return {
      track: { id: track.id, key: track.key, name: track.name },
      mayCustomize: true,
      custom: await customLayout(track.id),
    };
  });

  app.delete('/api/v1/tracks/:id/summary-layout', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const found = await seenTrack(request, p.data.id);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    if (!found.mayCustomize) {
      return reply.code(403).send({ error: 'forbidden', permission: 'administer_track' });
    }
    const { track } = found;
    const by = { workspaceId: request.workspaceId, actorId: request.user.id };
    await db.transaction().execute(async (trx) => {
      const gone = await trx
        .deleteFrom('track_summary_layout')
        .where('track_id', '=', track.id)
        .returning('track_id')
        .executeTakeFirst();
      if (!gone) return;
      await emit(trx, by, {
        type: 'track.summary_layout_removed',
        subjectId: track.id,
        payload: { trackKey: track.key },
      });
    });
    return reply.code(204).send();
  });

  app.get('/api/v1/tracks/:id/summary-layout/widgets/:widgetId', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = layoutWidgetParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const found = await seenTrack(request, p.data.id);
    if (!found) return reply.code(404).send({ error: 'not_found' });
    const custom = await customLayout(found.track.id);
    const widget = custom?.widgets.find((w) => w.id === p.data.widgetId);
    if (!widget) return reply.code(404).send({ error: 'not_found' });
    try {
      return {
        widget: { id: widget.id, kind: widget.kind },
        data: await widgetData(widgetContext(request, found.track), widget),
      };
    } catch (error) {
      return searchRefusal(reply as FastifyReply, error, timeoutMs);
    }
  });

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

  // The files and web links on a track's tickets (ADR-116), through the same permission filter as
  // a search of the track: a ticket the person may not see brings nothing here.
  app.get('/api/v1/tracks/:id/files', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: 'unauthenticated' });
    const p = trackParam.safeParse(request.params);
    if (!p.success) return reply.code(404).send({ error: 'not_found' });
    const lookup = db
      .selectFrom('track')
      .select(['id', 'key'])
      .where('workspace_id', '=', request.workspaceId)
      .where('deleted_at', 'is', null);
    const track = await (typeof p.data.id === 'number'
      ? lookup.where('id', '=', p.data.id)
      : lookup.where(sql<boolean>`upper(key) = upper(${p.data.id})`)
    ).executeTakeFirst();
    const held = track ? await request.authz.track(track.id) : null;
    if (!track || !held || !(held.has('browse_track') || held.has('administer_track'))) {
      return reply.code(404).send({ error: 'not_found' });
    }
    try {
      const scope = await boardScope(db, options.catalogs, request);
      const where = await compileQuery(db, scope, `track = "${track.key}"`, new Date());
      const { attachments, links } = await readOnly(db, timeoutMs, async (trx) => {
        const files = await sql<{
          id: number;
          name: string;
          size: string;
          created_at: Date;
          key: string;
          summary: string;
        }>`
          SELECT a.id, a.name, a.size, a.created_at, ${track.key}::text || '-' || k.number AS key,
                 k.summary
            FROM attachment a
            JOIN ticket k ON k.id = a.ticket_id
           WHERE a.scan_state <> 'infected' AND ${where}
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT ${FILES_SHOWN + 1}`.execute(trx);
        const webLinks = await sql<{
          id: number;
          url: string;
          title: string;
          key: string;
          summary: string;
        }>`
          SELECT w.id, w.url, w.title, ${track.key}::text || '-' || k.number AS key, k.summary
            FROM ticket_web_link w
            JOIN ticket k ON k.id = w.ticket_id
           WHERE ${where}
           ORDER BY w.created_at DESC, w.id DESC
           LIMIT ${FILES_SHOWN + 1}`.execute(trx);
        return { attachments: files.rows, links: webLinks.rows };
      });
      return {
        attachments: attachments.slice(0, FILES_SHOWN).map((a) => ({
          id: a.id,
          name: a.name,
          size: Number(a.size),
          createdAt: new Date(a.created_at).toISOString(),
          ticket: { key: a.key, summary: a.summary },
        })),
        links: links.slice(0, FILES_SHOWN).map((l) => ({
          id: l.id,
          url: l.url,
          title: l.title,
          ticket: { key: l.key, summary: l.summary },
        })),
        truncated: attachments.length > FILES_SHOWN || links.length > FILES_SHOWN,
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });

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
