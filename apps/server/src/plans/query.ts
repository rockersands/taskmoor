import type { Database, PlanSourceKind } from '@taskmoor/db';
import { parseQuery, printQuery, printValue, QueryError } from '@taskmoor/query';
import type { FastifyRequest } from 'fastify';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { bindCondition, compileCondition, compileQuery, type Scope } from '../boards/data';
import type { FieldCatalogs } from '../fields/catalog';
import { searchPerson, searchScope } from '../routes/search';
import { SearchError } from '../search/bind';
import { savedSearchVisible } from '../search/saved';
import type { PlanFilters } from './model';

/**
 * A plan's tickets for one viewer (ADR-122): a plan gives no access.
 *
 * The plan's query is text composed from the sources the viewer may see: the tracks they may
 * search as `track IN ("A", "B")`, and each saved search they may see as its printed condition in
 * brackets, joined by OR. It compiles through `compileQuery` with the viewer's ticket filter, so
 * every view shows, counts and groups only what the viewer may see, and its text links to the
 * search that finds the same tickets. A source the viewer cannot see adds nothing; a saved
 * search whose query no longer reads or runs for them is left out and flagged `broken`; with no
 * visible source the plan finds nothing (`where` null) and nothing is run.
 */
type Db = Kysely<Database> | Transaction<Database>;

export interface SourceRow {
  plan_id: number;
  id: number;
  kind: PlanSourceKind;
  position: number;
  track_id: number | null;
  track_key: string | null;
  track_name: string | null;
  track_archived: boolean | null;
  track_deleted: boolean | null;
  saved_search_id: number | null;
  saved_search_name: string | null;
  saved_search_query: string | null;
  saved_search_problem: string | null;
}

/** A source as one viewer sees it; those hidden from them are only counted. */
export type ViewerSource =
  | {
      kind: 'track';
      id: number;
      key: string;
      name: string;
      /** `archived`: they may see it, but an archived track's tickets are not searched. */
      state: 'visible' | 'archived';
    }
  | { kind: 'savedSearch'; id: number; name: string; state: 'visible' | 'broken' };

export interface PlanTickets {
  scope: Scope;
  sources: ViewerSource[];
  /** How many sources the viewer may not see. */
  hidden: number;
  /** The plan's query with the filters, for links; null when nothing is visible. */
  query: string | null;
  /** The same as a condition on ticket `k`, with the viewer's filter; null finds nothing. */
  where: RawBuilder<boolean> | null;
}

/** The sources of these plans, in their order. */
export async function sourceRows(db: Db, planIds: readonly number[]): Promise<SourceRow[]> {
  if (planIds.length === 0) return [];
  return (
    await sql<SourceRow>`
      SELECT ps.plan_id, ps.id, ps.kind, ps.position, ps.track_id, t.key AS track_key,
             t.name AS track_name, t.archived_at IS NOT NULL AS track_archived,
             t.deleted_at IS NOT NULL AS track_deleted, ps.saved_search_id,
             s.name AS saved_search_name, s.query AS saved_search_query,
             s.import_problem AS saved_search_problem
        FROM plan_source ps
        LEFT JOIN track t ON t.id = ps.track_id
        LEFT JOIN saved_search s ON s.id = ps.saved_search_id
       WHERE ps.plan_id = ANY(${[...planIds]}::int[])
       ORDER BY ps.plan_id, ps.position, ps.id`.execute(db)
  ).rows;
}

/** What a plan's query may name, and the viewer's filter: exactly a search's (`searchScope`). */
export async function planScope(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
): Promise<Scope> {
  const { ws, filter, catalog, catalogue } = await searchScope(db, catalogs, request, false);
  return {
    ws,
    filter,
    catalog,
    catalogue,
    userId: request.user?.id ?? null,
    person: searchPerson(request),
  };
}

/** A value as the query language reads it, quoted. */
const quoted = (text: string) =>
  printValue({ kind: 'string', value: text, span: { start: 0, end: 0 } });

/** The filters as clauses of the query language, ANDed; null for none. */
export function filterText(filters: PlanFilters): string | null {
  const parts: string[] = [];
  if (filters.track) parts.push(`track = ${quoted(filters.track)}`);
  if (filters.assignee === 'me') parts.push('assignee = currentUser()');
  else if (filters.assignee === 'none') parts.push('assignee IS EMPTY');
  else if (filters.assignee) parts.push(`assignee = ${filters.assignee}`);
  if (filters.type) parts.push(`type = ${quoted(filters.type)}`);
  if (filters.stage) parts.push(`stage = ${filters.stage}`);
  return parts.length === 0 ? null : parts.join(' AND ');
}

/** The sources as one condition: tracks first, then each saved search in brackets; null for none. */
export function sourcesText(trackKeys: readonly string[], conditions: readonly string[]) {
  const parts = [
    ...(trackKeys.length > 0 ? [`track IN (${trackKeys.map(quoted).join(', ')})`] : []),
    ...conditions.map((c) => `(${c})`),
  ];
  return parts.length === 0 ? null : parts.join(' OR ');
}

/** The plan's query with filters: the sources in brackets when there is more to AND. */
export function withFilters(sources: string, filters: string | null): string {
  return filters ? `(${sources}) AND ${filters}` : sources;
}

const unreadable = (error: unknown) => error instanceof QueryError || error instanceof SearchError;

/** The sources one viewer sees, and what of them composes the plan's query. */
export interface SeenSources {
  sources: ViewerSource[];
  hidden: number;
  /** The keys of the tracks they may search. */
  keys: string[];
  /** Each readable saved search's condition, by its index in `sources`. */
  conditions: Map<number, string>;
}

/** Which sources the viewer sees, without running anything. */
export async function viewerSources(
  db: Db,
  request: FastifyRequest,
  scope: Scope,
  rows: readonly SourceRow[],
): Promise<SeenSources> {
  const ws = request.workspaceId;
  const userId = request.user?.id ?? null;
  const searchable = (trackId: number) =>
    scope.filter.tracks === 'all' || scope.filter.tracks.includes(trackId);
  const savedIds = rows.flatMap((r) => (r.saved_search_id === null ? [] : [r.saved_search_id]));
  const seen = new Set(
    savedIds.length === 0
      ? []
      : (
          await db
            .selectFrom('saved_search as s')
            .select('s.id')
            .where('s.workspace_id', '=', ws)
            .where('s.id', 'in', savedIds)
            .where(savedSearchVisible(ws, userId))
            .execute()
        ).map((r) => r.id),
  );
  const out: SeenSources = { sources: [], hidden: 0, keys: [], conditions: new Map() };
  for (const r of rows) {
    if (r.kind === 'track') {
      const id = r.track_id as number;
      const named = {
        kind: 'track' as const,
        id,
        key: r.track_key ?? '',
        name: r.track_name ?? '',
      };
      if (r.track_deleted || r.track_key === null) {
        out.hidden++;
      } else if (searchable(id)) {
        out.sources.push({ ...named, state: 'visible' });
        out.keys.push(r.track_key);
      } else if (r.track_archived && (await request.authz.track(id)).has('browse_track')) {
        out.sources.push({ ...named, state: 'archived' });
      } else {
        out.hidden++;
      }
      continue;
    }
    const id = r.saved_search_id as number;
    if (!seen.has(id)) {
      out.hidden++;
      continue;
    }
    const source: ViewerSource = {
      kind: 'savedSearch',
      id,
      name: r.saved_search_name ?? '',
      state: 'visible',
    };
    out.sources.push(source);
    if (r.saved_search_problem !== null) {
      source.state = 'broken';
      continue;
    }
    try {
      const parsed = parseQuery(r.saved_search_query ?? '');
      // A saved search without a condition is every ticket the viewer sees, as in a reference.
      out.conditions.set(
        out.sources.length - 1,
        parsed.where ? printQuery({ where: parsed.where, orderBy: [] }) : 'key IS NOT EMPTY',
      );
    } catch (error) {
      if (!(error instanceof QueryError)) throw error;
      source.state = 'broken';
    }
  }
  return out;
}

/**
 * A plan's tickets for the viewer making the request, with the filters. Throws QueryError or
 * SearchError for a filter that does not read (a track key nobody may search, say), as a search
 * would: a source never does, since one that does not run is left out.
 */
export async function planTickets(
  db: Kysely<Database>,
  catalogs: FieldCatalogs,
  request: FastifyRequest,
  rows: readonly SourceRow[],
  filters: PlanFilters = {},
): Promise<PlanTickets> {
  const scope = await planScope(db, catalogs, request);
  const { sources, hidden, keys, conditions } = await viewerSources(db, request, scope, rows);
  const now = new Date();
  const compose = () => sourcesText(keys, [...conditions.values()]);
  let text = compose();
  if (text === null) return { scope, sources, hidden, query: null, where: null };
  let base: RawBuilder<boolean>;
  try {
    base = await compileQuery(db, scope, text, now);
  } catch (error) {
    if (!unreadable(error)) throw error;
    // Find the saved searches that do not run for this viewer and leave them out.
    for (const [at, condition] of [...conditions]) {
      try {
        await bindCondition(db, scope, condition, now);
      } catch (inner) {
        if (!unreadable(inner)) throw inner;
        conditions.delete(at);
        (sources[at] as ViewerSource).state = 'broken';
      }
    }
    text = compose();
    if (text === null) return { scope, sources, hidden, query: null, where: null };
    base = await compileQuery(db, scope, text, now);
  }
  const extra = filterText(filters);
  const where = extra
    ? sql<boolean>`(${base} AND ${await compileCondition(db, scope, extra, now)})`
    : base;
  return { scope, sources, hidden, query: withFilters(text, extra), where };
}
