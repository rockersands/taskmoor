import type { Database } from '@taskmoor/db';
import {
  type Catalogue,
  type CustomField,
  type Field,
  nativePermissionName,
  type Plan,
  type Pred,
  type PropertyField,
  parseTextSearch,
  type SystemField,
  type TextSearch,
  TextSearchError,
  type Typed,
} from '@taskmoor/query';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';
import { isTrackPermission, type TrackPermission } from '../authz/permissions';
import { effectiveGroupIds, effectiveMemberIds } from '../directory';
import type { Catalog } from '../fields/catalog';
import { findTeam, teamMemberIds } from '../teams';
import { masterTextSet, RANKED_CAP, textSourceSet } from './compile';
import { COUNT_CAP } from './count';
import { type CrossTrackSight, seenCrossTrackReleases } from './cross-track';
import type {
  Bound,
  Cond,
  HistorySide,
  HistoryTest,
  KeyDomain,
  Op,
  OrderKey,
  OrderSource,
  Quantifier,
  RankedSearch,
  Scalar,
  Scalarish,
  SideOrder,
  SideRef,
  SideTable,
  SprintMatch,
  SqlType,
  TicketColumn,
  TicketSet,
  TimeEdge,
  ValueTest,
} from './model';
import { expands } from './text';

/**
 * From a resolved query to one the compiler takes (M1-037; ADR-010): names become ids (statuses,
 * priorities, types, people, groups, options, releases, areas, levels, link types, keys), `NOT`
 * is pushed down to the clauses, and each clause is matched with the table that answers it.
 * Clauses the product cannot answer yet are refused here with a message that says why.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** A query that cannot run: unsupported, or naming a value that does not exist. */
export class SearchError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'unknown_value' | 'not_sortable',
  ) {
    super(message);
    this.name = 'SearchError';
  }
}

export interface BindContext {
  db: Db;
  workspaceId: number;
  /** The workspace's custom fields (side tables, options, multiplicity). */
  catalog: Catalog;
  /** What the viewer's query could name (track keys among them). */
  catalogue: Catalogue;
  /** The person searching, for the functions about them (`followedTickets()` and so on). */
  currentUserId: number | null;
  /**
   * The viewer's predicate on ticket `k` (TicketFilter.sql): a ticket a function takes as its
   * argument (`linkedTickets(ABC-12)`) counts only when the viewer may see it.
   */
  filter: RawBuilder<boolean>;
  /** The tracks where the viewer holds a permission (`tracksWhereUserHasPermission()`). */
  allowedTracks?: (permission: TrackPermission) => Promise<readonly number[] | 'all'>;
  /**
   * Which releases across tracks the person sees (PLN-007). Without it none is named, so
   * `crossTrackRelease` answers `unknown_value`.
   */
  crossTrackSight?: CrossTrackSight;
  /**
   * The board whose query this is: `@current`, `@next` and `@previous` are its sprints. Without
   * a board (a search) every board counts on its own (QRY-013).
   */
  boardId?: number | null;
}

/** A function the database answers (M1-038): its native name and typed arguments. */
type CallValue = Extract<Typed, { type: 'call' }>;

const isCall = (t: Typed): t is CallValue => t.type === 'call';

/** Functions of modules this version does not have yet, and the module, as people know it. */
const LATER: Record<string, string> = {
  customerDetail: 'service tracks',
  customerGroupMembers: 'service tracks',
};

/** The sprint state each sprint function names (M1-045): open means started, not completed. */
const SPRINT_STATES: Record<string, 'future' | 'active' | 'closed'> = {
  openSprints: 'active',
  futureSprints: 'future',
  closedSprints: 'closed',
};

/** A function this version cannot answer yet. */
function later(call: CallValue): SearchError {
  const module = LATER[call.fn];
  return new SearchError(
    module
      ? `${call.fn}() belongs to ${module}, which this version does not have yet`
      : `${call.fn}() cannot be used with this field yet`,
    'unsupported',
  );
}

/** The modules some fields belong to, as people know them. */
const MODULES: Record<NonNullable<SystemField['module']>, string> = {
  agile: 'boards and sprints',
  service: 'service tracks',
  journeys: 'journeys',
  'saved-searches': 'saved searches',
};

const label = (field: Field) =>
  field.kind === 'custom'
    ? `"${field.name}" (cf[${field.id}])`
    : field.kind === 'property'
      ? field.name
      : `"${field.name}"`;

type Leaf = Exclude<Pred, { kind: 'and' | 'or' | 'not' }>;
type HistoryLeaf = Extract<Leaf, { kind: 'history' }>;

/**
 * A field's history as WAS and CHANGED read it (M1-039): its name in `ticket_change`, whether
 * each row holds the whole new value (`state`) or adds or removes one (`delta`: links), and the
 * test for the values a clause names.
 */
interface HistoryShape {
  name: string;
  rows: 'state' | 'delta';
  /** Every ticket is created with a value (track, key, type, status, summary). */
  startsSet?: boolean;
  test(values: Typed[]): Promise<HistoryTest>;
}

/** History fields every ticket is created with a value of (their columns are never empty). */
const SET_AT_CREATION = new Set(['track', 'key', 'type', 'status', 'summary']);

/** Names to match against the names values had when written: lower case, distinct, sorted. */
const names = (missing: readonly string[]) =>
  [...new Set(missing.map((n) => n.toLowerCase()))].sort();

/**
 * The window of a history clause's time predicates (spec 01b 1.3): AFTER a is after `a`,
 * BEFORE b before `b`, ON the day from its first instant up to the next day's, DURING (a, b)
 * from `a` to `b` inclusive. Several narrow it to their overlap; 'never' when that is empty.
 */
function timeWindow(
  predicates: readonly { kind: string; values: Typed[] }[],
): { after?: TimeEdge; before?: TimeEdge } | 'never' {
  let after: TimeEdge | undefined;
  let before: TimeEdge | undefined;
  // ISO instants compare as text; at the same instant an open edge is the narrower one.
  const later = (a: TimeEdge, b: TimeEdge | undefined) =>
    !b || a.at > b.at || (a.at === b.at && !a.inclusive) ? a : b;
  const earlier = (a: TimeEdge, b: TimeEdge | undefined) =>
    !b || a.at < b.at || (a.at === b.at && !a.inclusive) ? a : b;
  for (const p of predicates) {
    const at = (i: number) => {
      const v = p.values[i];
      if (v?.type !== 'datetime') throw new Error(`${p.kind} needs a date`);
      return v.value.toISOString();
    };
    switch (p.kind) {
      case 'after':
        after = later({ at: at(0), inclusive: false }, after);
        break;
      case 'before':
        before = earlier({ at: at(0), inclusive: false }, before);
        break;
      case 'on':
        after = later({ at: at(0), inclusive: true }, after);
        before = earlier({ at: at(1), inclusive: false }, before);
        break;
      case 'during':
        after = later({ at: at(0), inclusive: true }, after);
        before = earlier({ at: at(1), inclusive: true }, before);
        break;
    }
  }
  if (
    after &&
    before &&
    (after.at > before.at || (after.at === before.at && !(after.inclusive && before.inclusive)))
  ) {
    return 'never';
  }
  return { ...(after ? { after } : {}), ...(before ? { before } : {}) };
}
type Comparison = Extract<Pred, { kind: 'compare' }>['op'];

const NEGATE: Record<Comparison, Comparison> = {
  '=': '!=',
  '!=': '=',
  '<': '>=',
  '>=': '<',
  '>': '<=',
  '<=': '>',
  '~': '!~',
  '!~': '~',
};

/**
 * Pushes NOT down to the clauses (De Morgan), turning each clause around by its operator, so
 * `NOT (assignee = x)` reads as `assignee != x` and, like it, leaves out tickets without an
 * assignee (spec 01b section 1.1).
 */
export function pushNot(p: Pred, negate = false): Exclude<Pred, { kind: 'not' }> {
  switch (p.kind) {
    case 'not':
      return pushNot(p.pred, !negate);
    case 'and':
    case 'or': {
      const kind = negate ? (p.kind === 'and' ? 'or' : 'and') : p.kind;
      return { kind, items: p.items.map((i) => pushNot(i, negate)) };
    }
    case 'compare':
      return negate ? { ...p, op: NEGATE[p.op] } : p;
    case 'in':
    case 'empty':
    case 'history':
      return negate ? { ...p, negated: !p.negated } : p;
  }
}

/** A value's content; a function has none to give (the binder evaluates those itself). */
function content(t: Typed): Exclude<Typed, CallValue> {
  if (t.type === 'call') throw later(t);
  return t;
}

const ISO = (t: Typed): Scalar => {
  const v = content(t);
  return v.type === 'datetime' ? v.value.toISOString() : (v.value as Scalar);
};

const lower = (s: string) => s.toLowerCase();

/** Sorted, distinct ids. */
const idList = (values: Iterable<number>) => [...new Set(values)].sort((a, b) => a - b);

/** Stage names in both vocabularies (spec 00 terminology: stage = status category). */
const STAGES: Record<string, 'new' | 'active' | 'closed'> = {
  new: 'new',
  todo: 'new',
  'to do': 'new',
  active: 'active',
  indeterminate: 'active',
  'in progress': 'active',
  closed: 'closed',
  done: 'closed',
  complete: 'closed',
};

/** Track types; `service_desk` is the Jira-compatible name of a service track. */
const TRACK_TYPES: Record<string, string> = {
  software: 'software',
  business: 'business',
  service: 'service',
  service_desk: 'service',
  discovery: 'discovery',
};

/** How each system field's ticket column reads (fields the ticket table holds directly). */
const COLUMNS: Record<string, Extract<Scalarish, { kind: 'column' }>> = {
  id: { kind: 'column', column: 'id', type: 'int', nullable: false },
  created: { kind: 'column', column: 'created_at', type: 'timestamptz', nullable: false },
  updated: { kind: 'column', column: 'updated_at', type: 'timestamptz', nullable: false },
  closed: { kind: 'column', column: 'closed_at', type: 'timestamptz', nullable: true },
  firstResponse: {
    kind: 'column',
    column: 'first_response_at',
    type: 'timestamptz',
    nullable: true,
  },
  due: { kind: 'column', column: 'due_date', type: 'date', nullable: true },
  start: { kind: 'column', column: 'start_date', type: 'date', nullable: true },
  originalEstimate: { kind: 'column', column: 'original_estimate', type: 'int', nullable: true },
  remainingEstimate: {
    kind: 'column',
    column: 'remaining_estimate',
    type: 'int',
    nullable: true,
  },
  timeSpent: { kind: 'column', column: 'time_spent', type: 'int', nullable: false },
};

const column = (name: TicketColumn, type: SqlType, nullable: boolean) =>
  ({ kind: 'column', column: name, type, nullable }) as const;

/** The side table and value type of each custom field type (ADR-008, `fields/storage.ts`). */
/** Where a property index's values are (M1-129): `field_id` is the index's id. */
function propertySide(field: PropertyField): SideRef {
  const ref = (table: SideTable, type: SqlType, ordered: boolean): SideRef => ({
    table,
    fieldId: field.indexId,
    type,
    // An array in the document gives a row per element.
    multiple: true,
    ordered,
  });
  switch (field.type) {
    case 'number':
      return ref('p_number', 'numeric', true);
    case 'datetime':
      return ref('p_time', 'timestamptz', true);
    case 'user':
      return ref('p_user', 'int', false);
    case 'labels':
    case 'text':
      return ref('p_text', 'text', false);
  }
}

function sideOf(field: CustomField, catalog: Catalog): SideRef {
  const def = catalog.fields.get(field.id);
  const multiple = def?.multiple === true;
  const ref = (table: SideTable, type: SqlType, many: boolean, ordered = false): SideRef => ({
    table,
    fieldId: field.id,
    type,
    multiple: many,
    ordered,
  });
  switch (field.type) {
    case 'text':
      return ref('v_text', 'text', false);
    case 'labels':
      return ref('v_text', 'text', true);
    case 'number':
      return ref('v_number', 'numeric', false, true);
    case 'date':
      return ref('v_date', 'date', false, true);
    case 'datetime':
      return ref('v_time', 'timestamptz', false, true);
    case 'user':
      return ref('v_user', 'int', multiple);
    case 'option':
      return ref('v_option', 'int', false);
    case 'multi':
    case 'cascade':
      return ref('v_option', 'int', true);
    case 'group':
    case 'release':
    case 'area':
    case 'team':
      return ref('v_option', 'int', multiple);
  }
}

/** Binds a resolved plan: looks names up and matches each clause with its table. */
export async function bindPlan(plan: Plan, ctx: BindContext): Promise<Bound> {
  const binder = new Binder(ctx);
  const where = plan.where
    ? await binder.cond(pushNot(plan.where))
    : { kind: 'const', value: true };
  await textForms(
    ctx.db,
    ctx.workspaceId,
    where as Cond,
    plan.orderBy.some((o) => o.field.type === 'relevance'),
  );
  const orderBy: OrderKey[] = [];
  for (const o of plan.orderBy) {
    if (o.field.type === 'relevance') {
      orderBy.push({ source: relevance(where as Cond), direction: o.direction });
    } else {
      orderBy.push(...binder.order(o.field, o.direction));
    }
  }
  if (orderBy.length === 0) {
    orderBy.push({ source: COLUMNS.created as OrderSource, direction: 'desc' });
  }
  const domain = await binder.domain((orderBy[0] as OrderKey).source);
  return {
    where: where as Cond,
    orderBy,
    ...(domain ? { domain } : {}),
    warnings: binder.warnings,
  };
}

/**
 * When testing each ticket while walking the order beats starting from the word indexes for a
 * master text search, by the planner's estimate `m` of its matches among `n` tickets (M1-040).
 * Reading a match out of the set (the word indexes, a hash of the ids, a fetch by primary key)
 * costs about four times testing a row in the walk, which stops once it has what it needs:
 *
 * - a page needs 51 matches: from 5,000 matches and 0.3% of the tickets (at 10M a word in 0.3%
 *   of them fills a page within about 17,000 tickets walked; its 30,000 matches sort in about as
 *   long);
 * - a count needs one past its cap (10,000): from twice the cap and `sqrt(cap · n / 4)` matches,
 *   where walking to 10,001 of them costs less than reading all from the set (at 200,000 tickets
 *   22,000; at 10M 158,000). Below the cap walking would read the whole table;
 * - relevance ranks the 10,000 most recently updated matches (`RANKED_CAP`), walking the
 *   tickets by their update: like a count, from twice the cap and `sqrt(cap · n / 4)` matches.
 *
 * Measured at 200,000 tickets: a prefix with 28,000 matches counted in 917 ms from the set and
 * 101 ms walking.
 */
const perRowPage = (m: number, n: number) => m >= Math.max(5_000, 0.003 * n);
const perRowCount = (m: number, n: number) =>
  m >= Math.max(2 * COUNT_CAP, Math.sqrt((COUNT_CAP * n) / 4));
const perRowRanked = (m: number, n: number) =>
  m >= Math.max(2 * RANKED_CAP, Math.sqrt((RANKED_CAP * n) / 4));

/**
 * Chooses the form of each master text search (`compile.ts`, `masterText`) from the planner's
 * estimate of how many tickets it matches: the rows of the set form, planned with the search's
 * own words (one EXPLAIN, a millisecond or two).
 */
async function textForms(db: Db, workspaceId: number, where: Cond, ranked: boolean): Promise<void> {
  const texts: Extract<Cond, { kind: 'text' | 'words' }>[] = [];
  const visit = (c: Cond) => {
    if (c.kind === 'and' || c.kind === 'or') c.items.forEach(visit);
    else if (c.kind === 'text' || (c.kind === 'words' && !c.negated)) texts.push(c);
  };
  visit(where);
  if (texts.length === 0) return;
  const { rows } = await sql<{ n: number }>`
    SELECT greatest(reltuples, 0)::float8 AS n FROM pg_class
     WHERE oid = 'ticket'::regclass`.execute(db);
  const tickets = rows[0]?.n ?? 0;
  const page = Math.ceil(Math.max(5_000, 0.003 * tickets));
  for (const c of texts) {
    // Expanded words always start from the word indexes (`expands`).
    if (expands(c.search)) continue;
    const several = severalWords(c.search);
    if (c.kind === 'words') {
      // One word: the planner's statistics know it. Several: count them in the index.
      if (!several) continue;
      const set = textSourceSet(c.source, c.search, workspaceId);
      if (set && (await countInIndex(db, set, page)) < page) c.fromIndex = true;
      continue;
    }
    const set = masterTextSet(c, workspaceId);
    if (!set) continue;
    let estimate: number;
    if (several && (await countInIndex(db, set, page)) < page) {
      estimate = 0;
    } else {
      const plan = await sql<{
        'QUERY PLAN': { Plan: { 'Plan Rows': number } }[];
      }>`EXPLAIN (FORMAT JSON) ${set}`.execute(db);
      estimate = plan.rows[0]?.['QUERY PLAN'][0]?.Plan['Plan Rows'] ?? 0;
      // Counted in the index: at least a page's worth, whatever the planner thinks.
      if (several) estimate = Math.max(estimate, page);
    }
    c.perRow = {
      page: ranked ? perRowRanked(estimate, tickets) : perRowPage(estimate, tickets),
      count: perRowCount(estimate, tickets),
    };
  }
}

/**
 * Whether a search needs several words together (two terms, or a phrase): the planner takes
 * words for independent, so two that seldom meet look common, and a page walked for them can
 * read the whole table (929 ms at 1M tickets for two words no summary holds together).
 */
function severalWords(search: TextSearch): boolean {
  const words = search.terms;
  return words.length > 1 || words.some((t) => t.kind === 'phrase' && /\s/u.test(t.text.trim()));
}

/**
 * How many rows a set of matches has, up to `cap`, read from the word indexes only: table scans
 * are turned off for the statement (the planner might otherwise expect an early hit and scan).
 */
async function countInIndex(db: Db, set: RawBuilder<unknown>, cap: number): Promise<number> {
  const run = async (trx: Transaction<Database>) => {
    const before = await sql<{ v: string }>`SELECT current_setting('enable_seqscan') AS v`.execute(
      trx,
    );
    await sql`SELECT set_config('enable_seqscan', 'off', true)`.execute(trx);
    const { rows } = await sql<{ n: number }>`
      SELECT count(*)::int AS n FROM (${set} LIMIT ${cap}) x`.execute(trx);
    await sql`SELECT set_config('enable_seqscan', ${before.rows[0]?.v ?? 'on'}, true)`.execute(trx);
    return rows[0]?.n ?? 0;
  };
  return db.isTransaction
    ? run(db as Transaction<Database>)
    : (db as Kysely<Database>).transaction().execute(run);
}

/**
 * Relevance (M1-040): the text searches a matching ticket must pass, which rank it. Negated
 * ones (`!~`, `NOT ... ~`) rank nothing; the resolver refuses relevance without any other.
 */
function relevance(where: Cond): OrderSource {
  const searches: RankedSearch[] = [];
  const visit = (c: Cond) => {
    switch (c.kind) {
      case 'and':
      case 'or':
        for (const item of c.items) visit(item);
        return;
      case 'words':
        if (!c.negated) searches.push({ on: c.source, search: c.search });
        return;
      case 'text':
        if (!c.negated) searches.push({ on: 'text', search: c.search });
        return;
      case 'side':
        if (c.test.kind === 'words' && c.quantifier === 'some') {
          searches.push({ on: 'custom', fieldId: c.side.fieldId, search: c.test.search });
        }
        return;
      default:
        return;
    }
  };
  visit(where);
  if (searches.length === 0) {
    throw new SearchError('ORDER BY relevance needs a text search (~) in the query', 'unsupported');
  }
  return { kind: 'relevance', searches };
}

/** Reads a `~` value (spec 01b section 1.8). */
function textSearch(value: Typed, field: string): TextSearch {
  try {
    return parseTextSearch(String(content(value).value));
  } catch (error) {
    if (!(error instanceof TextSearchError)) throw error;
    throw new SearchError(`${field}: ${error.message}`, 'unsupported');
  }
}

/** Groups (id, value) rows by value: each order value with the ids that have it. */
function grouped(rows: readonly { id: number; v: Scalar }[]): KeyDomain['values'] {
  const by = new Map<Scalar, number[]>();
  for (const r of rows) by.set(r.v, [...(by.get(r.v) ?? []), r.id]);
  return [...by].map(([value, ids]) => ({ value, ids: idList(ids) }));
}

interface Named {
  id: number;
  name: string;
}

/** Ids found by name, and the names (as written) that matched nothing. */
interface Found {
  ids: number[];
  missing: string[];
}

type NamedKind =
  | 'status'
  | 'priority'
  | 'type'
  | 'closeReason'
  | 'level'
  | 'group'
  | 'area'
  | 'release'
  | 'role'
  | 'team';

class Binder {
  readonly warnings: string[] = [];
  private readonly cache = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: BindContext) {}

  private once<T>(key: string, load: () => Promise<T>): Promise<T> {
    let hit = this.cache.get(key) as Promise<T> | undefined;
    if (!hit) {
      hit = load();
      this.cache.set(key, hit);
    }
    return hit;
  }

  async cond(p: Exclude<Pred, { kind: 'not' }>): Promise<Cond> {
    switch (p.kind) {
      case 'and':
      case 'or': {
        const items: Cond[] = [];
        for (const item of p.items)
          items.push(await this.cond(item as Exclude<Pred, { kind: 'not' }>));
        return { kind: p.kind, items };
      }
      default:
        return this.leaf(p);
    }
  }

  order(field: Field, direction: 'asc' | 'desc'): OrderKey[] {
    const key = (source: OrderSource): OrderKey => ({ source, direction });
    if (field.kind === 'property') {
      const by: Record<PropertyField['type'], SideOrder> = {
        number: 'value',
        datetime: 'value',
        labels: 'sortKey',
        text: 'sortKey',
        user: 'personName',
      };
      return [key({ kind: 'side', side: propertySide(field), by: by[field.type] })];
    }
    if (field.kind === 'custom') {
      const side = sideOf(field, this.ctx.catalog);
      const by: Record<CustomField['type'], SideOrder> = {
        text: 'sortKey',
        labels: 'sortKey',
        number: 'value',
        date: 'value',
        datetime: 'value',
        user: 'personName',
        group: 'groupName',
        option: 'optionOrder',
        multi: 'optionOrder',
        cascade: 'optionOrder',
        release: 'releaseOrder',
        area: 'areaName',
        team: 'teamName',
      };
      const keys = [key({ kind: 'side', side, by: by[field.type] })];
      if (field.type === 'cascade') keys.push(key({ kind: 'side', side, by: 'cascadeChildOrder' }));
      return keys;
    }
    this.supported(field);
    if (!field.sortable) {
      throw new SearchError(`Results cannot be ordered by ${label(field)}`, 'not_sortable');
    }
    const plain = COLUMNS[field.name];
    if (plain) return [key(plain)];
    switch (field.name) {
      case 'key':
        return [key({ kind: 'trackKey' }), key(column('number', 'int', false))];
      case 'type':
        return [key({ kind: 'typeName' })];
      case 'hierarchyLevel':
        return [key({ kind: 'levelRank' })];
      case 'status':
        return [key({ kind: 'statusOrder' })];
      case 'priority':
        return [key({ kind: 'priorityRank' })];
      case 'closeReason':
        return [key({ kind: 'closeReasonOrder' })];
      case 'summary':
        return [key({ kind: 'lowerSummary' })];
      case 'assignee':
        return [key({ kind: 'personName', column: 'assignee_id' })];
      case 'requester':
        return [key({ kind: 'personName', column: 'requester_id' })];
      case 'creator':
        return [key({ kind: 'personName', column: 'creator_id' })];
      case 'followers':
        return [key({ kind: 'count', relation: 'follower' })];
      case 'votes':
        return [key({ kind: 'count', relation: 'voter' })];
      case 'area':
        return [key({ kind: 'areaName' })];
      case 'targetRelease':
        return [key({ kind: 'releaseOrder', role: 'target' })];
      case 'foundInRelease':
        return [key({ kind: 'releaseOrder', role: 'found' })];
      case 'effortRatio':
        return [key({ kind: 'effortRatio' })];
      // More days since the last comment is an earlier comment; without one, last either way.
      case 'daysSinceLastComment':
        return [
          {
            source: column('last_comment_at', 'timestamptz', true),
            direction: direction === 'asc' ? 'desc' : 'asc',
          },
        ];
      case 'sprint':
        return [key({ kind: 'sprintOrder' })];
      default:
        throw new SearchError(`Results cannot be ordered by ${label(field)} yet`, 'unsupported');
    }
  }

  /** Refuses fields the product does not hold yet. */
  private supported(field: SystemField): void {
    if (field.module) {
      throw new SearchError(
        `${label(field)} belongs to ${MODULES[field.module]}, which this version does not have yet`,
        'unsupported',
      );
    }
    if (field.name === 'lastViewed') {
      throw new SearchError(`${label(field)} is not recorded yet`, 'unsupported');
    }
  }

  private async leaf(p: Leaf): Promise<Cond> {
    if (p.kind === 'history') return this.history(p);
    if (p.field.kind === 'custom') return this.custom(p, p.field);
    if (p.field.kind === 'property') return this.property(p, p.field);
    this.supported(p.field);
    return this.system(p, p.field);
  }

  /**
   * The values a first order key takes, when it reads one ticket column holding few ids. Read
   * with the query, so a priority or status added a moment later is the only thing it misses.
   */
  async domain(source: OrderSource): Promise<KeyDomain | undefined> {
    const ws = this.ws;
    const load = async (
      column: KeyDomain['column'],
      type: KeyDomain['type'],
      nullable: boolean,
      query: ReturnType<typeof sql<{ id: number; v: Scalar }>>,
    ): Promise<KeyDomain> => ({
      column,
      type,
      nullable,
      values: grouped((await query.execute(this.db)).rows),
    });
    switch (source.kind) {
      case 'priorityRank':
        return load(
          'priority_id',
          'int',
          true,
          sql`SELECT id, -sort_order AS v FROM priority WHERE workspace_id = ${ws}`,
        );
      case 'statusOrder':
        return load(
          'status_id',
          'int',
          false,
          sql`SELECT id, sort_order AS v FROM status WHERE workspace_id = ${ws}`,
        );
      case 'closeReasonOrder':
        return load(
          'close_reason_id',
          'int',
          true,
          sql`SELECT id, sort_order AS v FROM close_reason WHERE workspace_id = ${ws}`,
        );
      case 'typeName':
        return load(
          'ticket_type_id',
          'text',
          false,
          sql`SELECT id, lower(name) AS v FROM ticket_type WHERE workspace_id = ${ws}`,
        );
      case 'levelRank':
        return load(
          'ticket_type_id',
          'int',
          false,
          sql`SELECT ty.id, l.rank AS v FROM ticket_type ty JOIN hierarchy_level l ON l.id = ty.level_id
               WHERE ty.workspace_id = ${ws}`,
        );
      case 'trackKey':
        return load(
          'track_id',
          'text',
          false,
          sql`SELECT id, key AS v FROM track WHERE workspace_id = ${ws}`,
        );
      default:
        return undefined;
    }
  }

  // --- history (M1-039) -------------------------------------------------------------------

  /**
   * WAS and CHANGED (QRY-005; spec 01b 1.3) over `ticket_change`, which records every field a
   * mutation changes and every value a ticket starts with. Values become what history stores
   * (ids, numbers, days and instants as text); a name no value has now is matched against the
   * names values had when each change was written, so a renamed status or a removed option
   * still matches by its old name. Fields derived from another (stage, hierarchy level, track
   * type and category) read that field's history; creator and created never change.
   */
  private async history(p: HistoryLeaf): Promise<Cond> {
    const field = p.field;
    if (field.kind === 'system') {
      this.supported(field);
      if (field.name === 'created' || field.name === 'creator') return this.held(p, field.name);
    }
    const shape = this.historyShape(field);
    const predicate = (kind: HistoryLeaf['predicates'][number]['kind']) =>
      p.predicates.find((x) => x.kind === kind);
    const from = predicate('from');
    const to = predicate('to');
    if (shape.rows === 'delta' && (p.empty || from?.empty || to?.empty)) {
      throw new SearchError(
        `${label(field)}: EMPTY in WAS and CHANGED is not available for links yet`,
        'unsupported',
      );
    }
    const window = timeWindow(p.predicates);
    if (window === 'never') return { kind: 'const', value: p.negated };
    const side = async (values: Typed[], empty: boolean | undefined): Promise<HistorySide> => ({
      test: values.length > 0 ? await shape.test(values) : null,
      empty: empty === true,
    });
    const by = predicate('by');
    return {
      kind: 'history',
      field: shape.name,
      op: p.op,
      negated: p.negated,
      rows: shape.rows,
      ...(shape.startsSet ? { startsSet: true } : {}),
      ...(p.op === 'was' ? { held: await side(p.values, p.empty) } : {}),
      ...(from ? { from: await side(from.values, from.empty) } : {}),
      ...(to ? { to: await side(to.values, to.empty) } : {}),
      ...(by ? { by: await this.people(by.values) } : {}),
      ...window,
    };
  }

  /**
   * WAS on creator and created: set once, when the ticket is created, so held from then on and
   * set by the creator. Neither ever CHANGED.
   */
  private async held(p: HistoryLeaf, name: 'created' | 'creator'): Promise<Cond> {
    const window = timeWindow(p.predicates);
    if (p.op === 'changed' || window === 'never') return { kind: 'const', value: p.negated };
    const values = name === 'creator' ? await this.people(p.values) : p.values.map(ISO);
    const by = p.predicates.find((x) => x.kind === 'by');
    return {
      kind: 'held',
      on: name === 'creator' ? 'creator_id' : 'created_at',
      test: values.length > 0 ? { kind: 'in', values } : null,
      empty: p.empty === true,
      ...(by ? { by: await this.people(by.values) } : {}),
      ...(window.before ? { before: window.before } : {}),
      negated: p.negated,
    };
  }

  /** Where a field's history is and how its values read. */
  private historyShape(field: Field): HistoryShape {
    // Property values keep no history; the resolver refuses WAS and CHANGED on them.
    if (field.kind === 'property') throw new Error('unreachable');
    const state = (name: string, test: HistoryShape['test']): HistoryShape => ({
      name,
      rows: 'state',
      ...(SET_AT_CREATION.has(name) ? { startsSet: true } : {}),
      test,
    });
    // Ids, with the names nothing has now matched as the values were called then.
    const one =
      (find: (values: Typed[]) => Promise<Found>) =>
      async (values: Typed[]): Promise<HistoryTest> => {
        const { ids, missing } = await find(values);
        return { kind: 'values', values: ids.map(String), names: names(missing) };
      };
    const many =
      (
        separator: ' ' | ',' | ':',
        find: (values: Typed[]) => Promise<Found>,
        nameSeparator: ', ' | ' / ' = ', ',
      ) =>
      async (values: Typed[]): Promise<HistoryTest> => {
        const { ids, missing } = await find(values);
        return {
          kind: 'items',
          separator,
          nameSeparator,
          values: ids.map(String),
          names: names(missing),
        };
      };
    const ids =
      (find: (values: Typed[]) => Promise<number[]>) =>
      async (values: Typed[]): Promise<Found> => ({ ids: await find(values), missing: [] });
    // Numbers, days and instants as history writes them (`String(n)`, ISO).
    const exact = async (values: Typed[]): Promise<HistoryTest> => ({
      kind: 'values',
      values: values.map((v) => String(ISO(v))),
      names: [],
    });
    // Text matches by its words, as `~` does; history holds no index for patterns.
    const words =
      (document: boolean) =>
      async (values: Typed[]): Promise<HistoryTest> => ({
        kind: 'words',
        searches: values.map((v) => textSearch(v, label(field))),
        document,
      });
    const labels = async (values: Typed[]): Promise<HistoryTest> => ({
      kind: 'items',
      separator: ' ',
      nameSeparator: ', ',
      values: values.map((v) => String(content(v).value)),
      names: [],
    });
    if (field.kind === 'custom') {
      const def = this.ctx.catalog.fields.get(field.id);
      const name = `cf[${field.id}]`;
      const multiple = def?.multiple === true;
      const named = (kind: NamedKind) => (values: Typed[]) => this.findNamed(kind, values);
      const options = async (values: Typed[]) => this.findOptions(field, values);
      switch (field.type) {
        case 'text':
          return state(name, words(def?.type === 'paragraph'));
        case 'number':
        case 'date':
        case 'datetime':
          return state(name, exact);
        case 'labels':
          return state(name, labels);
        case 'option':
          return state(name, one(options));
        case 'multi':
          return state(name, many(',', options));
        case 'cascade':
          return state(name, many(':', options, ' / '));
        case 'user': {
          const people = (values: Typed[]) => this.findPeople(values);
          return state(name, multiple ? many(',', people) : one(people));
        }
        case 'group':
        case 'release':
        case 'area':
        case 'team':
          return state(name, multiple ? many(',', named(field.type)) : one(named(field.type)));
      }
    }
    const kinds: Partial<Record<string, NamedKind>> = {
      status: 'status',
      priority: 'priority',
      closeReason: 'closeReason',
      visibilityLevel: 'level',
      type: 'type',
    };
    const kind = kinds[field.name];
    if (kind)
      return state(
        field.name,
        one((values) => this.findNamed(kind, values)),
      );
    switch (field.name) {
      case 'track':
        return state('track', one(ids((values) => this.trackIds(values))));
      case 'assignee':
      case 'requester':
        return state(
          field.name,
          one((values) => this.findPeople(values)),
        );
      case 'parent':
        // Tickets the viewer sees only, as `parent = KEY` (a hidden one reads as unknown).
        return state('parent', one(ids((values) => this.keys(this.noTicketSets(field, values)))));
      case 'key':
        return state('key', async (values) => ({
          kind: 'values',
          values: this.noTicketSets(field, values).map((v) => String(v.value).toUpperCase()),
          names: [],
        }));
      case 'summary':
        return state('summary', words(false));
      case 'description':
      case 'environment':
        return state(field.name, words(true));
      case 'labels':
        return state('labels', labels);
      case 'area':
        return state(
          'area',
          many(',', (values) => this.findNamed('area', values)),
        );
      case 'targetRelease':
      case 'foundInRelease':
        return state(
          field.name,
          many(',', (values) => this.findNamed('release', values)),
        );
      case 'due':
        return state('dueDate', exact);
      case 'start':
        return state('startDate', exact);
      case 'originalEstimate':
      case 'remainingEstimate':
      case 'timeSpent':
        return state(field.name, exact);
      case 'stage':
        return state('status', one(ids((values) => this.statusesOf(values))));
      case 'hierarchyLevel':
        return state('type', one(ids((values) => this.derivedIds(field, values))));
      case 'trackType':
      case 'trackCategory':
        return state('track', one(ids((values) => this.derivedIds(field, values))));
      case 'ticketLink':
        return {
          name: 'link',
          rows: 'delta',
          test: async (values) => ({
            kind: 'linkTo',
            tickets: await this.keys(this.noTicketSets(field, values)),
          }),
        };
      case 'ticketLinkType':
        return {
          name: 'link',
          rows: 'delta',
          test: async (values) => ({ kind: 'linkType', ...(await this.linkTypes(values)) }),
        };
      case 'sprint':
        throw new SearchError(
          `${label(field)}: WAS and CHANGED do not read sprint changes yet; sprint = <sprint> matches every sprint a ticket is or was in`,
          'unsupported',
        );
      default:
        throw new SearchError(`${label(field)} keeps no change history`, 'unsupported');
    }
  }

  /** Key values without ticket functions, which history clauses cannot take yet. */
  private noTicketSets(field: Field, values: Typed[]): Exclude<Typed, CallValue>[] {
    for (const v of values) {
      if (isCall(v)) {
        throw new SearchError(
          `${v.fn}() cannot be used in WAS or CHANGED on ${label(field)} yet`,
          'unsupported',
        );
      }
    }
    return values as Exclude<Typed, CallValue>[];
  }

  /** The ids an `IN` on a derived field names: ticket types by level, tracks by type or category. */
  private async derivedIds(field: SystemField, values: Typed[]): Promise<number[]> {
    const p: Leaf = { kind: 'in', field, negated: false, values };
    const cond =
      field.name === 'hierarchyLevel' ? await this.hierarchy(p) : await this.trackSet(p, field);
    return cond.kind === 'scalar' && cond.test.kind === 'in' ? (cond.test.values as number[]) : [];
  }

  // --- custom fields ---------------------------------------------------------------------

  /**
   * A ticket property's indexed value (M1-129; ADR-083): compared as a custom field of its type
   * is, in its own side table. Several values (an array) match when one does; `!=` and `NOT IN`
   * when none does.
   */
  private async property(p: Leaf, field: PropertyField): Promise<Cond> {
    const side = propertySide(field);
    if (p.kind === 'empty') return { kind: 'sideEmpty', side, negated: p.negated };
    if (p.kind === 'history') throw new Error('unreachable');
    const values = p.kind === 'compare' ? [p.value] : p.values;
    const scalars: Scalar[] = field.type === 'user' ? await this.people(values) : values.map(ISO);
    if (p.kind === 'compare') {
      if (p.op === '~' || p.op === '!~') {
        return {
          kind: 'side',
          side,
          test: { kind: 'words', search: textSearch(p.value, label(field)) },
          quantifier: p.op === '~' ? 'some' : 'none',
        };
      }
      if (field.type !== 'user') {
        const op: Op = p.op === '!=' ? '=' : (p.op as Op);
        return {
          kind: 'side',
          side,
          test: { kind: 'cmp', op, value: scalars[0] as Scalar },
          quantifier: p.op === '!=' ? 'none' : 'some',
        };
      }
      return {
        kind: 'side',
        side,
        test: { kind: 'in', values: scalars },
        quantifier: p.op === '!=' ? 'none' : 'some',
      };
    }
    return {
      kind: 'side',
      side,
      test: { kind: 'in', values: scalars },
      quantifier: p.negated ? 'none' : 'some',
    };
  }

  private async custom(p: Leaf, field: CustomField): Promise<Cond> {
    const side = sideOf(field, this.ctx.catalog);
    if (p.kind === 'empty') return { kind: 'sideEmpty', side, negated: p.negated };
    if (p.kind === 'history') throw new Error('unreachable');
    const values = p.kind === 'compare' ? [p.value] : p.values;
    // Words, numbers, dates and labels compare as they are; the rest are ids.
    let scalars: Scalar[];
    switch (field.type) {
      case 'text':
      case 'labels':
      case 'number':
      case 'date':
      case 'datetime':
        scalars = values.map(ISO);
        break;
      case 'user':
        scalars = await this.people(values);
        break;
      case 'group':
        scalars = await this.named('group', values, label(field));
        break;
      case 'option':
      case 'multi':
      case 'cascade':
        scalars = this.options(field, values);
        break;
      case 'release':
        if (p.kind === 'compare' && p.op !== '=' && p.op !== '!=') {
          return {
            kind: 'side',
            side,
            test: { kind: 'in', values: await this.releasesBeyond(p.op, p.value, label(field)) },
            quantifier: 'some',
          };
        }
        scalars = await this.named('release', values, label(field));
        break;
      case 'area':
        scalars = await this.named('area', values, label(field));
        break;
      case 'team':
        scalars = await this.named('team', values, label(field));
        break;
    }
    if (p.kind === 'compare') {
      if (p.op === '~' || p.op === '!~') {
        return {
          kind: 'side',
          side,
          test: { kind: 'words', search: textSearch(p.value, label(field)) },
          quantifier: p.op === '~' ? 'some' : 'none',
        };
      }
      const byValue = field.type === 'number' || field.type === 'date' || field.type === 'datetime';
      if (byValue || field.type === 'text' || field.type === 'labels') {
        const op: Op = p.op === '!=' ? '=' : (p.op as Op);
        return {
          kind: 'side',
          side,
          test: { kind: 'cmp', op, value: scalars[0] as Scalar },
          quantifier: p.op === '!=' ? 'none' : 'some',
        };
      }
      // A name can stand for several ids (an option in several contexts, two people called alike).
      return {
        kind: 'side',
        side,
        test: { kind: 'in', values: scalars },
        quantifier: p.op === '!=' ? 'none' : 'some',
      };
    }
    return {
      kind: 'side',
      side,
      test: { kind: 'in', values: scalars },
      quantifier: p.negated ? 'none' : 'some',
    };
  }

  /** Options of a select, multiple select or cascade by value (either level of a cascade). */
  private options(field: CustomField, values: Typed[]): number[] {
    const { ids, missing } = this.findOptions(field, values);
    if (missing[0] !== undefined) {
      throw new SearchError(`${label(field)} has no option "${missing[0]}"`, 'unknown_value');
    }
    return ids;
  }

  /** Options by value or id, and the values no option has. */
  private findOptions(field: CustomField, values: Typed[]): Found {
    const ids: number[] = [];
    const missing: string[] = [];
    for (const v of values) {
      if (isCall(v)) {
        ids.push(...this.optionFunction(field, v));
        continue;
      }
      const wanted = lower(String(v.value));
      const found = [...this.ctx.catalog.options.values()].filter(
        (o) => o.fieldId === field.id && (lower(o.value) === wanted || String(o.id) === wanted),
      );
      if (found.length === 0) missing.push(String(v.value));
      ids.push(...found.map((o) => o.id));
    }
    return { ids: idList(ids), missing };
  }

  /**
   * `choiceOption(ids...)`: options of the field by id or value. `cascadeOption(parent,
   * child?)`: a cascade's top-level option, or the child of it named.
   */
  private optionFunction(field: CustomField, call: CallValue): number[] {
    const options = [...this.ctx.catalog.options.values()].filter((o) => o.fieldId === field.id);
    const pick = (value: Typed, among: typeof options) => {
      const wanted = lower(String(content(value).value));
      const found = among.filter((o) => lower(o.value) === wanted || String(o.id) === wanted);
      if (found.length === 0) {
        throw new SearchError(
          `${label(field)} has no option "${String(content(value).value)}"`,
          'unknown_value',
        );
      }
      return found;
    };
    switch (call.fn) {
      case 'choiceOption':
        return call.args.flatMap((a) => pick(a, options).map((o) => o.id));
      case 'cascadeOption': {
        if (field.type !== 'cascade') {
          throw new SearchError(
            `cascadeOption() takes a cascading select field; ${label(field)} is not one`,
            'unknown_value',
          );
        }
        const [parent, child] = call.args as [Typed, Typed | undefined];
        const parents = pick(
          parent,
          options.filter((o) => o.parentId === null),
        );
        if (!child) return parents.map((o) => o.id);
        if (lower(String(content(child).value)) === 'none') {
          throw new SearchError(
            'cascadeOption(parent, none) is not available here yet',
            'unsupported',
          );
        }
        const ids = new Set(parents.map((o) => o.id));
        return pick(
          child,
          options.filter((o) => o.parentId !== null && ids.has(o.parentId)),
        ).map((o) => o.id);
      }
      default:
        throw later(call);
    }
  }

  // --- system fields ---------------------------------------------------------------------

  private async system(p: Leaf, field: SystemField): Promise<Cond> {
    if (p.kind === 'history') throw new Error('unreachable');
    const plain = COLUMNS[field.name];
    if (plain) return this.onScalar(p, plain, p.kind === 'empty' ? [] : this.typed(p).map(ISO));
    switch (field.name) {
      case 'key':
        return this.tickets(p, 'id');
      case 'parent':
        return this.tickets(p, 'parent_id');
      case 'track':
        return this.onIds(p, column('track_id', 'int', false), await this.trackIds(this.typed(p)));
      case 'parentTrack':
        if (p.kind === 'empty') {
          return { kind: 'relatedEmpty', relation: 'parentTrack', negated: p.negated };
        }
        return this.related(p, {
          relation: 'parentTrack',
          ids: await this.trackIds(this.typed(p)),
        });
      case 'trackCategory':
      case 'trackType':
        return this.trackSet(p, field);
      case 'type':
        return this.onIds(
          p,
          column('ticket_type_id', 'int', false),
          await this.named('type', this.typed(p), label(field)),
        );
      case 'hierarchyLevel':
        return this.hierarchy(p);
      case 'sprint':
        if (p.kind === 'empty')
          return { kind: 'relatedEmpty', relation: 'sprint', negated: p.negated };
        return this.related(p, {
          relation: 'sprint',
          matches: await this.sprints(this.typed(p), label(field)),
        });
      case 'status':
        return this.onIds(
          p,
          column('status_id', 'int', false),
          await this.named('status', this.typed(p), label(field)),
        );
      case 'stage':
        return this.onIds(p, column('status_id', 'int', false), await this.stages(p));
      case 'priority':
        if (p.kind === 'compare' && p.op !== '=' && p.op !== '!=') {
          return {
            kind: 'scalar',
            on: column('priority_id', 'int', true),
            test: { kind: 'in', values: await this.prioritiesBeyond(p.op, p.value) },
            negated: false,
          };
        }
        return this.onIds(
          p,
          column('priority_id', 'int', true),
          await this.named('priority', this.typed(p), label(field)),
        );
      case 'closeReason':
        return this.onIds(
          p,
          column('close_reason_id', 'int', true),
          await this.named('closeReason', this.typed(p), label(field)),
        );
      case 'visibilityLevel':
        return this.onIds(
          p,
          column('visibility_level_id', 'int', true),
          await this.named('level', this.typed(p), label(field)),
        );
      case 'summary':
      case 'description':
      case 'environment':
      case 'comment': {
        if (p.kind === 'empty') {
          if (field.name === 'summary') return { kind: 'const', value: p.negated };
          return { kind: 'wordsEmpty', source: field.name, negated: p.negated };
        }
        const c = p as Extract<Leaf, { kind: 'compare' }>;
        return {
          kind: 'words',
          source: field.name,
          search: textSearch(c.value, label(field)),
          negated: c.op === '!~',
        };
      }
      case 'text': {
        if (p.kind === 'empty') return { kind: 'const', value: p.negated };
        const c = p as Extract<Leaf, { kind: 'compare' }>;
        const fieldIds = this.ctx.catalogue.customs
          .filter((f) => f.type === 'text')
          .map((f) => f.id);
        return {
          kind: 'text',
          search: textSearch(c.value, label(field)),
          fieldIds: idList(fieldIds),
          negated: c.op === '!~',
        };
      }
      case 'assignee':
      case 'requester':
      case 'creator': {
        const col = `${field.name}_id` as TicketColumn;
        if (p.kind === 'empty')
          return { kind: 'empty', on: column(col, 'int', true), negated: p.negated };
        return this.onIds(p, column(col, 'int', true), await this.people(this.typed(p)));
      }
      case 'follower':
      case 'voter':
        if (p.kind === 'empty') {
          return { kind: 'relatedEmpty', relation: field.name, negated: p.negated };
        }
        return this.related(p, { relation: field.name, ids: await this.people(this.typed(p)) });
      case 'followers':
      case 'votes':
        return this.onScalar(
          p,
          { kind: 'count', relation: field.name === 'followers' ? 'follower' : 'voter' },
          p.kind === 'empty' ? [] : this.typed(p).map(ISO),
        );
      case 'effortRatio':
        return this.onScalar(
          p,
          { kind: 'effortRatio' },
          p.kind === 'empty' ? [] : this.typed(p).map(ISO),
        );
      case 'daysSinceLastComment':
        return this.onScalar(
          p,
          { kind: 'daysSinceLastComment' },
          p.kind === 'empty' ? [] : this.typed(p).map(ISO),
        );
      case 'participants':
        if (p.kind === 'empty') {
          return { kind: 'relatedEmpty', relation: 'participant', negated: p.negated };
        }
        return this.related(p, { relation: 'participant', ids: await this.people(this.typed(p)) });
      case 'labels': {
        if (p.kind === 'empty') return { kind: 'labelsEmpty', negated: p.negated };
        const values = this.typed(p).map((t) => String(content(t).value));
        const quantifier: Quantifier =
          (p.kind === 'compare' && p.op === '!=') || (p.kind === 'in' && p.negated)
            ? 'none'
            : 'some';
        return { kind: 'labels', values, quantifier };
      }
      case 'area':
        if (p.kind === 'empty')
          return { kind: 'relatedEmpty', relation: 'area', negated: p.negated };
        return this.related(p, {
          relation: 'area',
          ids: await this.named('area', this.typed(p), label(field)),
        });
      case 'targetRelease':
      case 'foundInRelease': {
        const relation = field.name;
        if (p.kind === 'empty') return { kind: 'relatedEmpty', relation, negated: p.negated };
        if (p.kind === 'compare' && p.op !== '=' && p.op !== '!=') {
          return {
            kind: 'related',
            related: { relation, ids: await this.releasesBeyond(p.op, p.value, label(field)) },
            quantifier: 'some',
          };
        }
        return this.related(p, {
          relation,
          ids: await this.named('release', this.typed(p), label(field)),
        });
      }
      case 'crossTrackRelease':
        return this.related(p, {
          relation: 'targetRelease',
          ids: await this.crossTrackMembers(this.typed(p), label(field)),
        });
      case 'attachments':
        if (p.kind !== 'empty') throw new Error('unreachable');
        return { kind: 'relatedEmpty', relation: 'attachment', negated: p.negated };
      case 'ticketLink':
        if (p.kind === 'empty')
          return { kind: 'relatedEmpty', relation: 'link', negated: p.negated };
        return this.related(p, { relation: 'link', ids: await this.keys(this.typed(p)) });
      case 'ticketLinkType':
        if (p.kind === 'empty')
          return { kind: 'relatedEmpty', relation: 'link', negated: p.negated };
        return this.related(p, { relation: 'linkType', ...(await this.linkTypes(this.typed(p))) });
      case 'timeEntryComment': {
        if (p.kind === 'empty') {
          return { kind: 'relatedEmpty', relation: 'timeEntry', negated: p.negated };
        }
        const c = p as Extract<Leaf, { kind: 'compare' }>;
        return {
          kind: 'related',
          related: {
            relation: 'timeEntry',
            on: 'comment',
            test: { kind: 'words', search: textSearch(c.value, label(field)) },
          },
          quantifier: c.op === '!~' ? 'none' : 'some',
        };
      }
      case 'timeEntryDate': {
        if (p.kind === 'empty') {
          return { kind: 'relatedEmpty', relation: 'timeEntry', negated: p.negated };
        }
        const values = this.typed(p).map(ISO);
        let test: ValueTest;
        let quantifier: Quantifier = 'some';
        if (p.kind === 'compare') {
          test = {
            kind: 'cmp',
            op: p.op === '!=' ? '=' : (p.op as Op),
            value: values[0] as Scalar,
          };
          if (p.op === '!=') quantifier = 'none';
        } else {
          test = { kind: 'in', values };
          if (p.negated) quantifier = 'none';
        }
        return {
          kind: 'related',
          related: { relation: 'timeEntry', on: 'date', test },
          quantifier,
        };
      }
      default:
        throw new SearchError(`${label(field)} cannot be searched yet`, 'unsupported');
    }
  }

  private typed(p: Leaf): Typed[] {
    if (p.kind === 'compare') return [p.value];
    if (p.kind === 'in') return p.values;
    return [];
  }

  /** A clause on one value of the ticket: comparisons, lists and emptiness. */
  private onScalar(p: Leaf, on: Scalarish, values: Scalar[]): Cond {
    if (p.kind === 'empty') return { kind: 'empty', on, negated: p.negated };
    if (p.kind === 'compare') {
      const op = (p.op === '!=' ? '<>' : p.op) as Op;
      return {
        kind: 'scalar',
        on,
        test: { kind: 'cmp', op, value: values[0] as Scalar },
        negated: false,
      };
    }
    if (p.kind === 'in')
      return { kind: 'scalar', on, test: { kind: 'in', values }, negated: p.negated };
    throw new Error('unreachable');
  }

  /** A clause on a column holding one id, given the ids its values name. */
  private onIds(p: Leaf, on: Scalarish, ids: number[]): Cond {
    if (p.kind === 'empty') return { kind: 'empty', on, negated: p.negated };
    const negated = (p.kind === 'compare' && p.op === '!=') || (p.kind === 'in' && p.negated);
    if (!negated && ids.length === 1) {
      return {
        kind: 'scalar',
        on,
        test: { kind: 'cmp', op: '=', value: ids[0] as number },
        negated: false,
      };
    }
    return { kind: 'scalar', on, test: { kind: 'in', values: idList(ids) }, negated };
  }

  /**
   * `key` or `parent` against keys, ids and functions naming tickets (M1-038): keys become ids,
   * each function a ticket set the statement joins; `IN` matches any of them, `NOT IN` none.
   */
  private async tickets(p: Leaf, on: 'id' | 'parent_id'): Promise<Cond> {
    const col = on === 'id' ? column('id', 'int', false) : column('parent_id', 'int', true);
    if (p.kind === 'empty') return { kind: 'empty', on: col, negated: p.negated };
    const values = this.typed(p);
    const calls = values.filter(isCall);
    if (calls.length === 0) return this.onIds(p, col, await this.keys(values));
    const negated = (p.kind === 'compare' && p.op === '!=') || (p.kind === 'in' && p.negated);
    const items: Cond[] = [];
    const rest = values.filter((v) => !isCall(v));
    if (rest.length > 0) items.push(this.onIds(p, col, await this.keys(rest)));
    for (const call of calls) {
      items.push({ kind: 'ticketSet', on, set: await this.ticketSet(call), negated });
    }
    return items.length === 1 ? (items[0] as Cond) : { kind: negated ? 'and' : 'or', items };
  }

  /** The person searching; functions about "me" need one. */
  private me(call: CallValue): number {
    const me = this.ctx.currentUserId;
    if (me === null) {
      throw new SearchError(`${call.fn}() needs a signed-in person`, 'unsupported');
    }
    return me;
  }

  /** The tickets a function names, as a set the statement joins (never widened: QRY-008). */
  private async ticketSet(call: CallValue): Promise<TicketSet> {
    switch (call.fn) {
      case 'followedTickets':
        return { kind: 'followed', userId: this.me(call) };
      case 'votedTickets':
        return { kind: 'voted', userId: this.me(call) };
      case 'ticketHistory':
        return { kind: 'visited', userId: this.me(call) };
      case 'updatedBy': {
        const [user, from, to] = call.args as [Typed, Typed | undefined, Typed | undefined];
        return {
          kind: 'updatedBy',
          userIds: await this.people([user]),
          ...(from ? { from: String(ISO(from)) } : {}),
          ...(to ? { to: String(ISO(to)) } : {}),
        };
      }
      case 'linkedTickets': {
        const [ticket, ...types] = call.args as [Typed, ...Typed[]];
        // A ticket the viewer may not see links to nothing they can learn of (`keys` drops it).
        const ticketIds = await this.keys([ticket]);
        if (types.length === 0) return { kind: 'linked', ticketIds, outward: 'all', inward: 'all' };
        return { kind: 'linked', ticketIds, ...(await this.linkDirections(types)) };
      }
      case 'ticketsWithWebLinksByGlobalId':
        return {
          kind: 'webLinks',
          globalIds: [...new Set(call.args.map((a) => String(content(a).value)))].sort(),
        };
      default:
        throw later(call);
    }
  }

  /**
   * Link types as `linkedTickets()` reads them, from the given ticket's side: a description
   * ("blocks", "is blocked by") picks links where the given ticket reads it; a type's name
   * (or id), when no description matches, picks its links either way.
   */
  private async linkDirections(values: Typed[]): Promise<{ outward: number[]; inward: number[] }> {
    const rows = await this.db
      .selectFrom('link_type')
      .select(['id', 'name', 'outward', 'inward'])
      .where('workspace_id', '=', this.ws)
      .execute();
    const outward: number[] = [];
    const inward: number[] = [];
    for (const v of values.map(content)) {
      const wanted = lower(String(v.value));
      const out = rows.filter((r) => lower(r.outward) === wanted).map((r) => r.id);
      const back = rows.filter((r) => lower(r.inward) === wanted).map((r) => r.id);
      if (out.length + back.length > 0) {
        outward.push(...out);
        inward.push(...back);
        continue;
      }
      const named = rows
        .filter((r) => lower(r.name) === wanted || String(r.id) === wanted)
        .map((r) => r.id);
      if (named.length === 0) {
        throw new SearchError(`No link type "${String(v.value)}"`, 'unknown_value');
      }
      outward.push(...named);
      inward.push(...named);
    }
    return { outward: idList(outward), inward: idList(inward) };
  }

  /** The tickets among `ids` the viewer may see (the statement's own filter). */
  private async visible(ids: readonly number[]): Promise<number[]> {
    if (ids.length === 0) return [];
    const { rows } = await sql<{ id: number }>`
      SELECT k.id FROM ticket k
       WHERE k.workspace_id = ${this.ws} AND k.deleted_at IS NULL
         AND k.id = ANY(${[...ids]}::int[]) AND ${this.ctx.filter}`.execute(this.db);
    return idList(rows.map((r) => r.id));
  }

  /** Track ids, keys already read as ids by the resolver, and the track functions' tracks. */
  private async trackIds(values: Typed[]): Promise<number[]> {
    const ids: number[] = [];
    for (const v of values) {
      if (isCall(v)) ids.push(...(await this.trackFunction(v)));
      else ids.push(Number(v.value));
    }
    return idList(ids);
  }

  private async liveTracks(): Promise<number[]> {
    const rows = await this.db
      .selectFrom('track')
      .select('id')
      .where('workspace_id', '=', this.ws)
      .where('deleted_at', 'is', null)
      .execute();
    return rows.map((r) => r.id);
  }

  /** `tracksOwnedByUser()`, `tracksWhereUserHasPermission()`, `tracksWhereUserHasRole()`. */
  private async trackFunction(call: CallValue): Promise<number[]> {
    switch (call.fn) {
      case 'tracksOwnedByUser': {
        const owners = call.args.length > 0 ? await this.people(call.args) : [this.me(call)];
        if (owners.length === 0) return [];
        const rows = await this.db
          .selectFrom('track')
          .select('id')
          .where('workspace_id', '=', this.ws)
          .where('deleted_at', 'is', null)
          .where('owner_id', 'in', owners)
          .execute();
        return rows.map((r) => r.id);
      }
      case 'tracksWhereUserHasPermission': {
        const name = String(content(call.args[0] as Typed).value);
        const code = nativePermissionName(name);
        if (!code || !isTrackPermission(code)) {
          throw new SearchError(`No track permission "${name}"`, 'unknown_value');
        }
        this.me(call);
        if (!this.ctx.allowedTracks) {
          throw new SearchError(`${call.fn}() needs the person's permissions`, 'unsupported');
        }
        const tracks = await this.ctx.allowedTracks(code);
        return tracks === 'all' ? this.liveTracks() : [...tracks];
      }
      case 'tracksWhereUserHasRole': {
        const roles = await this.named('role', [call.args[0] as Typed], '"role"');
        const me = this.me(call);
        const groups = await effectiveGroupIds(this.db, this.ws, me);
        const rows = await this.db
          .selectFrom('track_role_actor as a')
          .innerJoin('track as t', 't.id', 'a.track_id')
          .select('a.track_id')
          .distinct()
          .where('a.workspace_id', '=', this.ws)
          .where('t.deleted_at', 'is', null)
          .where('a.role_id', 'in', roles)
          .where((eb) =>
            groups.length > 0
              ? eb.or([eb('a.user_id', '=', me), eb('a.group_id', 'in', groups)])
              : eb('a.user_id', '=', me),
          )
          .execute();
        return rows.map((r) => r.track_id);
      }
      default:
        throw later(call);
    }
  }

  /**
   * People a function names: `membersOf(group)`, nested groups' members included, and
   * `membersOf("id:<teamId>")`, a team's members (M1-123, CORE-027 (1)).
   */
  private async userFunction(call: CallValue): Promise<number[]> {
    if (call.fn !== 'membersOf') throw later(call);
    const name = String(content(call.args[0] as Typed).value);
    const team = /^id:\s*(.*)$/i.exec(name);
    if (team) {
      const id = /^[1-9][0-9]{0,9}$/.test(team[1] as string) ? Number(team[1]) : 0;
      const found = id > 0 && id <= 2_147_483_647 && (await findTeam(this.db, this.ws, id));
      if (!found) throw new SearchError(`No team "${team[1]}"`, 'unknown_value');
      return teamMemberIds(this.db, this.ws, id);
    }
    const groups = await this.named('group', [{ type: 'text', value: name }], '"group"');
    const ids: number[] = [];
    for (const g of groups) ids.push(...(await effectiveMemberIds(this.db, this.ws, g)));
    return ids;
  }

  /** Ticket types and areas a function names. */
  private async namedFunction(kind: NamedKind, call: CallValue): Promise<number[]> {
    switch (call.fn) {
      case 'standardTicketTypes':
      case 'subticketTypes': {
        if (kind !== 'type') break;
        const rows = await this.db
          .selectFrom('ticket_type as ty')
          .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
          .select('ty.id')
          .where('ty.workspace_id', '=', this.ws)
          .where('l.kind', call.fn === 'subticketTypes' ? '=' : '<>', 'subticket')
          .execute();
        return rows.map((r) => r.id);
      }
      case 'shippedReleases':
      case 'upcomingReleases': {
        if (kind !== 'release') break;
        const tracks = call.args.length > 0 ? await this.trackIds(call.args) : null;
        if (tracks?.length === 0) return [];
        let query = this.db.selectFrom('release').select('id').where('workspace_id', '=', this.ws);
        // Shipped ones stay shipped when archived; an archived release is upcoming no more.
        query =
          call.fn === 'shippedReleases'
            ? query.where('shipped_at', 'is not', null)
            : query.where('shipped_at', 'is', null).where('archived_at', 'is', null);
        if (tracks) query = query.where('track_id', 'in', tracks);
        return (await query.execute()).map((r) => r.id);
      }
      case 'latestShippedRelease':
      case 'earliestUpcomingRelease': {
        if (kind !== 'release') break;
        // The track's own release order, as people arranged it, never the dates (spec 01b 1.6).
        const tracks = await this.trackIds(call.args);
        if (tracks.length === 0) return [];
        const latest = call.fn === 'latestShippedRelease';
        const rows = await sql<{ id: number }>`
          SELECT DISTINCT ON (track_id) id FROM release
           WHERE workspace_id = ${this.ws}::int AND track_id = ANY(${tracks}::int[])
             AND ${latest ? sql`shipped_at IS NOT NULL` : sql`shipped_at IS NULL AND archived_at IS NULL`}
           ORDER BY track_id, sort_order ${latest ? sql`DESC` : sql`ASC`}`.execute(this.db);
        return rows.rows.map((r) => r.id);
      }
      case 'areasOwnedByUser': {
        if (kind !== 'area') break;
        const owners = call.args.length > 0 ? await this.people(call.args) : [this.me(call)];
        if (owners.length === 0) return [];
        const rows = await this.db
          .selectFrom('area')
          .select('id')
          .where('workspace_id', '=', this.ws)
          .where('owner_id', 'in', owners)
          .execute();
        return rows.map((r) => r.id);
      }
    }
    throw later(call);
  }

  /**
   * The sprints a clause names (M1-045): functions by state, tokens relative to the board, and
   * names (any case) or ids looked up. A name or id no sprint has is refused.
   */
  private async sprints(values: Typed[], field: string): Promise<SprintMatch[]> {
    const matches: SprintMatch[] = [];
    const wanted: string[] = [];
    for (const v of values) {
      if (isCall(v)) {
        const state = SPRINT_STATES[v.fn];
        if (!state) throw later(v);
        matches.push({ kind: 'state', state });
      } else if (v.type === 'token') {
        matches.push({ kind: 'relative', token: v.value, boardId: this.ctx.boardId ?? null });
      } else {
        wanted.push(String(v.value).trim());
      }
    }
    if (wanted.length === 0) return matches;
    const names = [...new Set(wanted.map(lower))];
    const numbers = [...new Set(wanted.filter((w) => /^\d{1,9}$/.test(w)).map(Number))];
    const rows = await this.db
      .selectFrom('sprint')
      .select(['id', 'name'])
      .where('workspace_id', '=', this.ws)
      .where('deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          eb(sql<string>`lower(name)`, 'in', names),
          ...(numbers.length > 0 ? [eb('id', 'in', numbers)] : []),
        ]),
      )
      .execute();
    const ids: number[] = [];
    for (const w of wanted) {
      const found = rows.filter((r) => lower(r.name) === lower(w) || String(r.id) === w);
      if (found.length === 0) {
        throw new SearchError(`${field} has no value "${w}"`, 'unknown_value');
      }
      ids.push(...found.map((r) => r.id));
    }
    matches.push({ kind: 'ids', ids: idList(ids) });
    return matches;
  }

  /** A clause on rows of another table. */
  private related(p: Leaf, related: Extract<Cond, { kind: 'related' }>['related']): Cond {
    const negated = (p.kind === 'compare' && p.op === '!=') || (p.kind === 'in' && p.negated);
    return { kind: 'related', related, quantifier: negated ? 'none' : 'some' };
  }

  // --- lookups ---------------------------------------------------------------------------

  private get db() {
    return this.ctx.db;
  }

  private get ws() {
    return this.ctx.workspaceId;
  }

  /** Rows of a small named table of the workspace, loaded once per query. */
  private table(kind: NamedKind) {
    return this.once(`table:${kind}`, async () => {
      const ws = this.ws;
      switch (kind) {
        case 'status':
          return (await this.db
            .selectFrom('status')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'priority':
          return (await this.db
            .selectFrom('priority')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'type':
          return (await this.db
            .selectFrom('ticket_type')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'closeReason':
          return (await this.db
            .selectFrom('close_reason')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'level':
          return (await this.db
            .selectFrom('visibility_level')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'group':
          return (await this.db
            .selectFrom('user_group')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'area':
          return (await this.db
            .selectFrom('area')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'release':
          return (await this.db
            .selectFrom('release')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'role':
          return (await this.db
            .selectFrom('role')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
        case 'team':
          return (await this.db
            .selectFrom('team')
            .select(['id', 'name'])
            .where('workspace_id', '=', ws)
            .execute()) as Named[];
      }
    });
  }

  /**
   * The releases linked to the releases across tracks named, by name (any case) or id, reading only
   * those the person sees: another's answers `unknown_value`, word for word as one that does not
   * exist. A name shared by several means all of them the person sees (PLN-007).
   *
   * Two rules keep what this says true. A bare number is an id before it is a name, and a quoted
   * one a name before an id, so naming a release across tracks "5" cannot take over the page of
   * number 5, which reads `crossTrackRelease = 5`. And it binds only to linked releases of tracks
   * the person sees: a ticket seen through a grant, in a track they do not see, never shows that
   * its release is linked to this one.
   */
  private async crossTrackMembers(values: Typed[], field: string): Promise<number[]> {
    const seen = await this.once('crossTrackReleases', () =>
      seenCrossTrackReleases(this.db, this.ws, this.ctx.currentUserId, this.ctx.crossTrackSight),
    );
    const found: number[] = [];
    for (const value of values) {
      const typed = content(value);
      const given = String(typed.value);
      const wanted = lower(given);
      const byName = seen.filter((r) => lower(r.name) === wanted);
      const byId = seen.filter((r) => String(r.id) === wanted);
      const [first, second] = typed.type === 'number' ? [byId, byName] : [byName, byId];
      const named = first.length > 0 ? first : second;
      if (named.length === 0) {
        throw new SearchError(`${field} has no value "${given}"`, 'unknown_value');
      }
      for (const r of named) found.push(...r.releaseIds);
    }
    return idList(found);
  }

  /** Ids by name (any case) or by id; a name nobody uses is refused. */
  private async named(kind: NamedKind, values: Typed[], field: string): Promise<number[]> {
    const { ids, missing } = await this.findNamed(kind, values);
    if (missing[0] !== undefined) {
      throw new SearchError(`${field} has no value "${missing[0]}"`, 'unknown_value');
    }
    return ids;
  }

  /** Ids by name (any case) or by id, and the names nothing is called now. */
  private async findNamed(kind: NamedKind, values: Typed[]): Promise<Found> {
    const rows = await this.table(kind);
    const ids: number[] = [];
    const missing: string[] = [];
    for (const v of values) {
      if (isCall(v)) {
        ids.push(...(await this.namedFunction(kind, v)));
        continue;
      }
      const wanted = lower(String(v.value));
      let found = rows.filter((r) => lower(r.name) === wanted);
      if (found.length === 0 && /^\d+$/.test(wanted))
        found = rows.filter((r) => String(r.id) === wanted);
      if (found.length === 0) missing.push(String(v.value));
      ids.push(...found.map((r) => r.id));
    }
    return { ids: idList(ids), missing };
  }

  /** Statuses in the stages named. */
  private async stages(p: Leaf): Promise<number[]> {
    return this.statusesOf(this.typed(p));
  }

  private async statusesOf(values: Typed[]): Promise<number[]> {
    const stages = new Set<'new' | 'active' | 'closed'>();
    for (const v of values.map(content)) {
      const stage = STAGES[lower(String(v.value))];
      if (!stage) {
        throw new SearchError(
          `"stage" has no value "${String(v.value)}" (new, active or closed)`,
          'unknown_value',
        );
      }
      stages.add(stage);
    }
    const rows = await this.db
      .selectFrom('status')
      .select('id')
      .where('workspace_id', '=', this.ws)
      .where('stage', 'in', [...stages])
      .execute();
    return idList(rows.map((r) => r.id));
  }

  /** Priorities above or below one (`priority > High`: the more urgent ones). */
  private async prioritiesBeyond(op: Comparison, given: Typed): Promise<number[]> {
    const value = content(given);
    const rows = await this.db
      .selectFrom('priority')
      .select(['id', 'name', 'sort_order'])
      .where('workspace_id', '=', this.ws)
      .execute();
    const wanted = lower(String(value.value));
    const pivot = rows.find((r) => lower(r.name) === wanted || String(r.id) === wanted);
    if (!pivot) {
      throw new SearchError(`"priority" has no value "${String(value.value)}"`, 'unknown_value');
    }
    // A smaller sort order is a higher priority.
    const rank = (r: { sort_order: number }) => -r.sort_order;
    const test = (r: { sort_order: number }) => {
      const a = rank(r);
      const b = rank(pivot);
      return op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b;
    };
    return idList(rows.filter(test).map((r) => r.id));
  }

  /** Releases after or before one in its track's order (`fixVersion > "1.0"`). */
  private async releasesBeyond(op: Comparison, given: Typed, field: string): Promise<number[]> {
    const value = content(given);
    const rows = await this.db
      .selectFrom('release')
      .select(['id', 'track_id', 'name', 'sort_order'])
      .where('workspace_id', '=', this.ws)
      .execute();
    const wanted = lower(String(value.value));
    const pivots = rows.filter((r) => lower(r.name) === wanted || String(r.id) === wanted);
    if (pivots.length === 0) {
      throw new SearchError(`${field} has no value "${String(value.value)}"`, 'unknown_value');
    }
    const ids: number[] = [];
    for (const pivot of pivots) {
      for (const r of rows) {
        if (r.track_id !== pivot.track_id) continue;
        const a = r.sort_order;
        const b = pivot.sort_order;
        if (op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : a >= b) ids.push(r.id);
      }
    }
    return idList(ids);
  }

  /** Ticket types whose level compares as asked with a level number (-1, 0, 1, ...). */
  private async hierarchy(p: Leaf): Promise<Cond> {
    const on = column('ticket_type_id', 'int', false);
    if (p.kind === 'empty') return { kind: 'const', value: p.negated };
    const rows = await this.db
      .selectFrom('ticket_type as ty')
      .innerJoin('hierarchy_level as l', 'l.id', 'ty.level_id')
      .select(['ty.id', 'l.rank'])
      .where('ty.workspace_id', '=', this.ws)
      .execute();
    const numbers = this.typed(p).map((t) => Number(content(t).value));
    let match: (rank: number) => boolean;
    if (p.kind === 'compare') {
      const n = numbers[0] as number;
      const ops: Record<string, (r: number) => boolean> = {
        '=': (r) => r === n,
        '!=': (r) => r !== n,
        '<': (r) => r < n,
        '<=': (r) => r <= n,
        '>': (r) => r > n,
        '>=': (r) => r >= n,
      };
      match = ops[p.op] ?? (() => false);
    } else {
      match = p.negated ? (r) => !numbers.includes(r) : (r) => numbers.includes(r);
    }
    return {
      kind: 'scalar',
      on,
      test: { kind: 'in', values: idList(rows.filter((r) => match(r.rank)).map((r) => r.id)) },
      negated: false,
    };
  }

  /** `trackCategory` and `trackType`: the tracks whose category or type passes. */
  private async trackSet(p: Leaf, field: SystemField): Promise<Cond> {
    const rows = await this.once('tracks', () =>
      this.db
        .selectFrom('track as t')
        .leftJoin('track_category as c', 'c.id', 't.category_id')
        .select(['t.id', 't.type', 'c.name as category'])
        .where('t.workspace_id', '=', this.ws)
        .execute(),
    );
    const of = (r: (typeof rows)[number]) =>
      field.name === 'trackType' ? r.type : r.category === null ? null : lower(r.category);
    let pass: (value: string | null) => boolean;
    if (p.kind === 'empty') {
      pass = (v) => (p.negated ? v !== null : v === null);
    } else {
      const wanted = this.typed(p).map((t) => {
        const name = lower(String(content(t).value));
        if (field.name !== 'trackType') return name;
        const type = TRACK_TYPES[name];
        if (!type) {
          throw new SearchError(
            `${label(field)} has no value "${String(content(t).value)}" (${Object.keys(TRACK_TYPES).join(', ')})`,
            'unknown_value',
          );
        }
        return type;
      });
      const negated = (p.kind === 'compare' && p.op === '!=') || (p.kind === 'in' && p.negated);
      pass = (v) => v !== null && (negated ? !wanted.includes(v) : wanted.includes(v));
    }
    return {
      kind: 'scalar',
      on: column('track_id', 'int', false),
      test: { kind: 'in', values: idList(rows.filter((r) => pass(of(r))).map((r) => r.id)) },
      negated: false,
    };
  }

  /** People by id, `currentUser()` (already an id), email or name (any case). */
  private async people(values: Typed[]): Promise<number[]> {
    const { ids, missing } = await this.findPeople(values);
    if (missing[0] !== undefined) {
      throw new SearchError(`No person "${lower(missing[0])}"`, 'unknown_value');
    }
    return ids;
  }

  /** People by id, `currentUser()`, email or name, and the names nobody has now. */
  private async findPeople(values: Typed[]): Promise<Found> {
    const ids: number[] = [];
    const names: string[] = [];
    for (const v of values) {
      if (isCall(v)) ids.push(...(await this.userFunction(v)));
      else if (v.type === 'number') ids.push(v.value);
      else names.push(String(v.value));
    }
    const missing: string[] = [];
    if (names.length > 0) {
      const wanted = names.map(lower);
      const rows = await this.db
        .selectFrom('app_user')
        .select(['id', 'email', 'name'])
        .where('workspace_id', '=', this.ws)
        .where((eb) =>
          eb.or([eb(sql`lower(email)`, 'in', wanted), eb(sql`lower(name)`, 'in', wanted)]),
        )
        .execute();
      for (const name of names) {
        const found = rows.filter(
          (r) => lower(r.email) === lower(name) || lower(r.name) === lower(name),
        );
        if (found.length === 0) missing.push(name);
        ids.push(...found.map((r) => r.id));
      }
    }
    return { ids: idList(ids), missing };
  }

  /** Tickets by id or key (old keys too); keys of tickets the viewer cannot see match nothing. */
  private async keys(values: Typed[]): Promise<number[]> {
    const numbers: number[] = [];
    const pairs: { track: number; number: number; key: string }[] = [];
    for (const v of values.map(content)) {
      if (v.type === 'number') {
        numbers.push(v.value);
        continue;
      }
      const key = String(v.value).toUpperCase();
      const m = /^(.+)-(\d{1,9})$/.exec(key);
      const track = m ? this.ctx.catalogue.trackKeys[m[1] as string] : undefined;
      if (!m || track === undefined) {
        this.warnings.push(`No ticket ${key}`);
        continue;
      }
      pairs.push({ track, number: Number(m[2]), key });
    }
    // Ids name tickets too: only those the viewer sees match.
    const ids = await this.visible(numbers);
    if (pairs.length > 0) {
      const rows = await sql<{ ticket_id: number; track_id: number; number: number }>`
        SELECT h.ticket_id, h.track_id, h.number FROM ticket_key_history h
         WHERE h.workspace_id = ${this.ws}
           AND (h.track_id, h.number) IN (
             SELECT * FROM unnest(${pairs.map((x) => x.track)}::int[], ${pairs.map((x) => x.number)}::int[]))`.execute(
        this.db,
      );
      // A ticket the viewer may not see reads exactly like one that does not exist: no match
      // and the same warning, so `parent`, `ticketLink` or the warning itself cannot confirm
      // that a hidden ticket exists or show what hangs off it.
      const seen = new Set(await this.visible(rows.rows.map((r) => r.ticket_id)));
      for (const pair of pairs) {
        const row = rows.rows.find((r) => r.track_id === pair.track && r.number === pair.number);
        if (row && seen.has(row.ticket_id)) ids.push(row.ticket_id);
        else this.warnings.push(`No ticket ${pair.key}`);
      }
    }
    return idList(ids);
  }

  /** Link types by name (either end), outward or inward description. */
  private async linkTypes(values: Typed[]) {
    const rows = await this.db
      .selectFrom('link_type')
      .select(['id', 'name', 'outward', 'inward'])
      .where('workspace_id', '=', this.ws)
      .execute();
    const both: number[] = [];
    const outward: number[] = [];
    const inward: number[] = [];
    for (const v of values.map(content)) {
      const wanted = lower(String(v.value));
      let found = false;
      for (const r of rows) {
        if (lower(r.name) === wanted || String(r.id) === wanted) {
          both.push(r.id);
          found = true;
        } else {
          if (lower(r.outward) === wanted) {
            outward.push(r.id);
            found = true;
          }
          if (lower(r.inward) === wanted) {
            inward.push(r.id);
            found = true;
          }
        }
      }
      if (!found) {
        throw new SearchError(
          `"ticketLinkType" has no value "${String(v.value)}"`,
          'unknown_value',
        );
      }
    }
    return { both: idList(both), outward: idList(outward), inward: idList(inward) };
  }
}
