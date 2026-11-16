import type { Database, JsonValue } from '@taskmoor/db';
import { parseQuery, QueryError, resolveQuery } from '@taskmoor/query';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Kysely, RawBuilder } from 'kysely';
import { z } from 'zod';
import { requireSiteAdmin, requireUser } from '../auth';
import type { TrackPermission } from '../authz/permissions';
import type { FieldCatalogs } from '../fields/catalog';
import { customFieldViews } from '../fields/values';
import { viewerTimeZone } from '../reports/zone';
import { SearchError } from '../search/bind';
import { queryCatalogue } from '../search/catalogue';
import type { Total } from '../search/count';
import { requestSight } from '../search/cross-track';
import {
  CursorError,
  DEFAULT_QUERY_TIMEOUT_MS,
  decodeCursor,
  explainSearch,
  isQueryTimeout,
  prepareSearch,
  runPage,
} from '../search/run';
import { expandSavedSearches } from '../search/saved';
import { type TicketView, ticketQuery, ticketView } from '../tickets/store';

/**
 * Searching tickets with the query language (M1-036, M1-037; QRY-001 to QRY-010):
 *
 * - `GET /api/v1/search/check?q=` checks a query without running it: what it uses, or where and
 *   why it is wrong, for the query editor (M1-041).
 * - `GET` and `POST /api/v1/search` run one (`q`, `limit`, `cursor`, `fields`, `count`,
 *   `archived`): a page of tickets as `GET /api/v1/tickets` shows them, the cursor of the next
 *   page, and on the first page a count: `total: { count, exact }`, exact up to 10,000; beyond
 *   it an estimate within 10% (`approximate: true`, M1-040), or when none can be made in time
 *   a lower bound (both false). POST takes the same in its body,
 *   for queries too long for a URL; it changes nothing. Only tickets the person may see are
 *   ever read: the permission filter is part of the statement (QRY-008). A site administrator
 *   may search archived tracks too (`archived=true`).
 * - `GET /api/v1/admin/search/explain?q=` shows a site administrator the statement, its
 *   parameters and the planner's plan, run with `analyze=true` (QRY-010 (2)).
 *
 * Every statement runs read-only under the search timeout (`TASKMOOR_QUERY_TIMEOUT_MS`,
 * default 30 s); a query that runs out of time answers 503 `query_timeout` (QRY-010 (3)).
 */
export const checkQuery = z.object({ q: z.string().max(20_000) }).strict();

const flag = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

export const searchInput = z
  .object({
    q: z.string().max(100_000).default(''),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(4000).optional(),
    /** View properties to return (`summary,status,cf[10]`); id and key always come. */
    fields: z.union([z.string().max(4000), z.array(z.string().max(200)).max(500)]).optional(),
    /** Count the matches (capped); by default on the first page only. */
    count: flag.optional(),
    /** Site administrators: include archived tracks. */
    archived: flag.optional(),
  })
  .strict();

const explainInput = z
  .object({
    q: z.string().max(100_000).default(''),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    analyze: flag.optional(),
    archived: flag.optional(),
  })
  .strict();

export interface SearchRouteOptions {
  /** Milliseconds a search statement may run (QRY-010 (3)). */
  timeoutMs?: number;
}

function queryErrorBody(error: QueryError) {
  return {
    message: error.detail,
    position: error.position,
    length: error.length,
    line: error.line,
    column: error.column,
    expected: error.expected,
  };
}

/** Answers a refused query (also for bulk changes by query); rethrows anything else. */
/**
 * Said when relevance ranked only the most recently updated matches (`RANKED_CAP`, M1-040):
 * the first page counts every match and knows whether some were left unranked.
 */
export function rankedWarning(cap: number | undefined, total: Total | undefined): string[] {
  if (cap === undefined || !total || (total.exact && total.count <= cap)) return [];
  return [
    `Ordered by relevance among the ${cap.toLocaleString('en-US')} most recently updated matches`,
  ];
}

export function searchRefusal(reply: FastifyReply, error: unknown, timeoutMs: number) {
  if (error instanceof QueryError) {
    return reply.code(400).send({ error: 'invalid_query', ...queryErrorBody(error) });
  }
  if (error instanceof SearchError) {
    return reply.code(400).send({
      error: error.code === 'unsupported' ? 'unsupported_query' : 'invalid_query',
      message: error.message,
    });
  }
  if (error instanceof CursorError) {
    return reply.code(400).send({ error: 'invalid_cursor', message: error.message });
  }
  if (isQueryTimeout(error)) {
    return reply.code(503).send({
      error: 'query_timeout',
      message: `The query ran longer than ${Math.round(timeoutMs / 100) / 10} s and was stopped`,
      timeoutMs,
    });
  }
  throw error;
}

/** The view properties a search may return; `fields` names custom values. */
const VIEW_KEYS = new Set<string>(
  Object.keys({
    number: 0,
    track: 0,
    ticketType: 0,
    parent: 0,
    status: 0,
    summary: 0,
    description: 0,
    environment: 0,
    assignee: 0,
    requester: 0,
    creator: 0,
    startDate: 0,
    dueDate: 0,
    priority: 0,
    closeReason: 0,
    closedAt: 0,
    visibilityLevel: 0,
    labels: 0,
    targetReleases: 0,
    foundInReleases: 0,
    areas: 0,
    followerCount: 0,
    voteCount: 0,
    timeTracking: 0,
    fields: 0,
    rank: 0,
    version: 0,
    createdAt: 0,
    updatedAt: 0,
  } satisfies Partial<Record<keyof TicketView, 0>>),
);

export interface Projection {
  keys: Set<string>;
  /** Custom field ids to keep; all of them when `fields` itself is asked for. */
  custom: Set<string>;
}

/** The properties `fields` asks for, or the first name it does not know. */
export function projection(fields: string | string[] | undefined): Projection | string | undefined {
  if (fields === undefined) return undefined;
  const names = (Array.isArray(fields) ? fields : fields.split(','))
    .map((f) => f.trim())
    .filter((f) => f !== '');
  const out: Projection = { keys: new Set(), custom: new Set() };
  for (const name of names) {
    const custom = /^(?:cf\[(\d{1,10})\]|(\d{1,10}))$/.exec(name);
    if (custom) out.custom.add(custom[1] ?? (custom[2] as string));
    else if (VIEW_KEYS.has(name)) out.keys.add(name);
    else return name;
  }
  return out;
}

export function project(view: TicketView, p: Projection | undefined): Record<string, unknown> {
  if (!p) return view;
  const out: Record<string, unknown> = { id: view.id, key: view.key };
  for (const key of p.keys) out[key] = view[key as keyof TicketView];
  if (p.custom.size > 0 && !p.keys.has('fields')) {
    out.fields = Object.fromEntries(Object.entries(view.fields).filter(([id]) => p.custom.has(id)));
  }
  return out;
}

/**
 * The tickets of a page as the ticket list shows them, in the page's order (also the export,
 * M1-042).
 */
export async function searchViews(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
  ids: readonly number[],
  filter: RawBuilder<boolean>,
): Promise<TicketView[]> {
  if (ids.length === 0) return [];
  const ws = request.workspaceId;
  // The filter again: a ticket hidden between the two statements stays hidden.
  const rows = await ticketQuery(db, ws)
    .where('k.id', 'in', [...ids])
    .where('k.deleted_at', 'is', null)
    .where(filter)
    .execute();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [row] : [];
  });
  const parents = ordered.flatMap((r) => (r.parent_id === null ? [] : [r.parent_id]));
  const visible = await request.authz.visibleTickets(parents);
  const custom = await customFieldViews(db, ws, await catalogs.get(ws), ordered);
  return ordered.map((r) =>
    ticketView(
      r,
      r.parent_id !== null && visible.has(r.parent_id),
      (custom.get(r.id) ?? {}) as Record<string, JsonValue>,
    ),
  );
}

/**
 * What the person's query may name, and the filter on what they may see. Track keys and local
 * fields are those of the tracks they see tickets in.
 */
export async function searchScope(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
  archived: boolean,
) {
  const ws = request.workspaceId;
  const filter = await request.authz.ticketFilter({ includeArchived: archived });
  const catalog = await catalogs.get(ws);
  const catalogue = await queryCatalogue(db, ws, catalog, filter.tracks);
  return { ws, filter, catalog, catalogue };
}

/**
 * Who is searching, as a query's functions and dates need it (M1-038): the person, their time
 * zone (dates read on their clock, QRY-006: the account's zone, else the device's the app
 * sends, else UTC, as `viewerTimeZone` picks it, T-280), their session (`currentLogin()`) and
 * the tracks where they hold a permission (`tracksWhereUserHasPermission()`).
 */
export function searchPerson(request: FastifyRequest) {
  return {
    currentUserId: request.user?.id ?? null,
    // Null where no person reads (a worker's scope), so the type stays open to it.
    timeZone: viewerTimeZone(request) as string | null,
    sessionId: request.authSession?.id ?? null,
    allowedTracks: (permission: TrackPermission) => request.authz.allowedTracks(permission),
    crossTrackSight: requestSight(request),
  };
}

export function registerSearchRoutes(
  app: FastifyInstance,
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  options: SearchRouteOptions = {},
): void {
  const timeoutMs = options.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;

  const scope = (request: FastifyRequest, archived: boolean) =>
    searchScope(db, catalogs, request, archived);

  app.get('/api/v1/search/check', async (request, reply) => {
    const user = requireUser(request, reply);
    if (!user) return reply;
    const parsed = checkQuery.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const { catalogue } = await scope(request, false);
    try {
      // Saved-search references read as the person sees them, so a missing one or a cycle
      // shows in the editor as typed (M1-063).
      const query = await expandSavedSearches(
        db,
        request.workspaceId,
        user.id,
        parseQuery(parsed.data.q),
      );
      const plan = resolveQuery(query, catalogue, {
        currentUserId: user.id,
        now: new Date(),
        timeZone: viewerTimeZone(request),
      });
      const fields = new Map<string, { name: string; custom: number | null }>();
      const visit = (pred: unknown) => {
        if (!pred || typeof pred !== 'object') return;
        const p = pred as {
          field?: { kind: string; name: string; id?: number };
          items?: unknown[];
          pred?: unknown;
        };
        if (p.field) {
          const custom = p.field.kind === 'custom' ? (p.field.id as number) : null;
          fields.set(custom === null ? p.field.name : `cf[${custom}]`, {
            name: p.field.name,
            custom,
          });
        }
        for (const item of p.items ?? []) visit(item);
        visit(p.pred);
      };
      visit(plan.where);
      for (const o of plan.orderBy) visit(o);
      return {
        ok: true,
        fields: [...fields.values()],
        orderBy: plan.orderBy.map((o) => ({ field: o.field.name, direction: o.direction })),
      };
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      return { ok: false, error: queryErrorBody(error) };
    }
  });

  const views = (request: FastifyRequest, ids: readonly number[], filter: RawBuilder<boolean>) =>
    searchViews(db, catalogs, request, ids, filter);

  async function search(request: FastifyRequest, reply: FastifyReply, input: unknown) {
    const parsed = searchInput.safeParse(input);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const q = parsed.data;
    const shape = projection(q.fields);
    if (typeof shape === 'string') {
      return reply
        .code(400)
        .send({ error: 'invalid_request', message: `Unknown field "${shape}"` });
    }
    const archived = q.archived === true && (await request.authz.isSiteAdmin());
    const { ws, filter, catalog, catalogue } = await scope(request, archived);
    try {
      const { bound, compiled } = await prepareSearch({
        db,
        workspaceId: ws,
        catalog,
        catalogue,
        filter,
        q: q.q,
        ...searchPerson(request),
      });
      const after = q.cursor === undefined ? undefined : decodeCursor(compiled, q.cursor);
      const count = q.count ?? after === undefined;
      const nothing = filter.tracks !== 'all' && filter.tracks.length === 0;
      const page = nothing
        ? { ids: [], next: null, ...(count ? { total: { count: 0, exact: true } } : {}) }
        : await runPage(db, compiled, {
            limit: q.limit,
            ...(after ? { after } : {}),
            count,
            timeoutMs,
          });
      const tickets = await views(request, page.ids, filter.sql);
      const warnings = [...bound.warnings, ...rankedWarning(compiled.rankedAmong, page.total)];
      return {
        tickets: tickets.map((t) => project(t, shape)),
        next: page.next,
        ...(page.total ? { total: page.total } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  }

  app.get('/api/v1/search', async (request, reply) => search(request, reply, request.query));
  app.post('/api/v1/search', async (request, reply) => search(request, reply, request.body ?? {}));

  app.get('/api/v1/admin/search/explain', async (request, reply) => {
    const admin = await requireSiteAdmin(request, reply);
    if (!admin) return reply;
    const parsed = explainInput.safeParse(request.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_request' });
    const q = parsed.data;
    const { ws, filter, catalog, catalogue } = await scope(request, q.archived === true);
    try {
      const { compiled, bound } = await prepareSearch({
        db,
        workspaceId: ws,
        catalog,
        catalogue,
        filter,
        q: q.q,
        ...searchPerson(request),
      });
      const explained = await explainSearch(db, compiled, {
        limit: q.limit,
        analyze: q.analyze === true,
        timeoutMs,
      });
      return {
        ...explained,
        ...(bound.warnings.length > 0 ? { warnings: bound.warnings } : {}),
      };
    } catch (error) {
      return searchRefusal(reply, error, timeoutMs);
    }
  });
}
