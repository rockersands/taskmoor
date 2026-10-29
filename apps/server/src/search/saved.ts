import type { Database } from '@taskmoor/db';
import {
  type Expr,
  type FieldRef,
  parseQuery,
  type Query,
  QueryError,
  type Span,
  type Value,
} from '@taskmoor/query';
import { type Kysely, type RawBuilder, sql, type Transaction } from 'kysely';

/**
 * Saved searches in queries (M1-063; QRY-011; ADR-053).
 *
 * - Who sees a saved search (`savedSearchVisible`): its owner, and those its shares reach: a
 *   person, a group (nested groups count), a track's members (every role, or one), everyone
 *   signed in (`any_user`), or anyone, anonymous visitors included (`public`). Anonymous
 *   visitors see only public ones.
 * - References (`expandSavedSearches`): `savedSearch = "name"`, `savedSearch = 12`,
 *   `savedSearch IN (...)` and their negations (Jira-compatible `filter`, `request`,
 *   `savedFilter`, `searchRequest`) stand for the condition of the saved search they name,
 *   read again as the person running the query, recursively. A cycle is refused with the
 *   names along it; so is a chain deeper than `MAX_REFERENCE_DEPTH`. A saved search the
 *   person cannot see reads exactly as one that does not exist, so a reference never confirms
 *   that a hidden one exists. The referenced ORDER BY is ignored.
 */
type Db = Kysely<Database> | Transaction<Database>;

/** How deep references may nest (a search naming one naming another ... ). */
export const MAX_REFERENCE_DEPTH = 10;

const REFERENCE_NAMES = new Set([
  'savedsearch',
  'saved search',
  'filter',
  'request',
  'savedfilter',
  'searchrequest',
]);

export const isReference = (field: FieldRef): boolean =>
  field.custom === undefined && REFERENCE_NAMES.has(field.name.toLowerCase());

/** The groups of a person, nested ones included, as a sub-select of ids. */
const groupsOf = (ws: number, userId: number) => sql`(
  WITH RECURSIVE g(id) AS (
    SELECT group_id FROM group_member WHERE workspace_id = ${ws} AND user_id = ${userId}
    UNION
    SELECT n.parent_id FROM group_nesting n JOIN g ON n.child_id = g.id
     WHERE n.workspace_id = ${ws}
  ) SELECT id FROM g)`;

/** Whether the share row `sh` reaches the person. */
export function shareReaches(ws: number, userId: number | null): RawBuilder<boolean> {
  if (userId === null) return sql<boolean>`(sh.scope = 'public')`;
  const groups = groupsOf(ws, userId);
  return sql<boolean>`(
       sh.scope IN ('any_user', 'public')
    OR (sh.scope = 'user' AND sh.user_id = ${userId})
    OR (sh.scope = 'group' AND sh.group_id IN ${groups})
    OR (sh.scope = 'track' AND EXISTS (
          SELECT 1 FROM track_role_actor a
           WHERE a.track_id = sh.track_id
             AND (sh.role_id IS NULL OR a.role_id = sh.role_id)
             AND (a.user_id = ${userId} OR a.group_id IN ${groups}))))`;
}

/** Whether saved search `s` is visible to the person (null: an anonymous visitor). */
export function savedSearchVisible(ws: number, userId: number | null): RawBuilder<boolean> {
  const shared = sql<boolean>`EXISTS (
    SELECT 1 FROM saved_search_share sh
     WHERE sh.saved_search_id = s.id AND ${shareReaches(ws, userId)})`;
  if (userId === null) return shared;
  return sql<boolean>`(s.owner_id = ${userId} OR ${shared})`;
}

interface Found {
  id: number;
  name: string;
  query: string;
}

/** The text a reference names a saved search by. */
function referenceText(value: Value): string | undefined {
  if (value.kind === 'string' || value.kind === 'word') return value.value;
  if (value.kind === 'number') return String(value.value);
  return undefined;
}

/**
 * Finds the saved searches a person may see by name or id. A name wins over an id; of several
 * of one name, the person's own wins, and two others are ambiguous.
 */
export class SavedSearchLookup {
  private readonly cache = new Map<string, Promise<Found | 'ambiguous' | undefined>>();

  constructor(
    private readonly db: Db,
    private readonly ws: number,
    private readonly userId: number | null,
  ) {}

  find(text: string): Promise<Found | 'ambiguous' | undefined> {
    const key = text.toLowerCase();
    let hit = this.cache.get(key);
    if (!hit) {
      hit = this.load(text);
      this.cache.set(key, hit);
    }
    return hit;
  }

  private async load(text: string): Promise<Found | 'ambiguous' | undefined> {
    const base = this.db
      .selectFrom('saved_search as s')
      .select(['s.id', 's.name', 's.query', 's.owner_id'])
      .where('s.workspace_id', '=', this.ws)
      .where(savedSearchVisible(this.ws, this.userId));
    const named = await base
      .where(sql<boolean>`lower(s.name) = lower(${text})`)
      .orderBy('s.id')
      .limit(50)
      .execute();
    const own = named.filter((r) => r.owner_id === this.userId);
    if (own.length === 1) return own[0];
    if (named.length === 1) return named[0];
    if (named.length > 1) return 'ambiguous';
    if (!/^\d{1,10}$/.test(text) || Number(text) > 2_147_483_647) return undefined;
    return base.where('s.id', '=', Number(text)).executeTakeFirst();
  }
}

const refusal = (message: string, span: Span) =>
  new QueryError(message, span.start, Math.max(1, span.end - span.start));

/** Every span in a copied subtree becomes `span`: errors point at the reference. */
function respan<T>(node: T, span: Span): T {
  if (Array.isArray(node)) return node.map((n) => respan(n, span)) as T;
  if (!node || typeof node !== 'object') return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = key === 'span' ? { start: span.start, end: span.end } : respan(value, span);
  }
  return out as T;
}

/** A condition every ticket meets: a saved search without a condition. */
const everything = (span: Span): Expr => ({
  kind: 'empty',
  field: { name: 'key', span },
  negated: true,
  span,
});

export interface ExpandOptions {
  /** The saved search being saved: a reference back to it is a cycle (QRY-011 (2)). */
  self?: { id: number; name: string };
}

/** Whether the query names a saved search anywhere. */
export function hasReferences(expr: Expr | null): boolean {
  if (!expr) return false;
  switch (expr.kind) {
    case 'and':
    case 'or':
      return expr.items.some(hasReferences);
    case 'not':
      return hasReferences(expr.expr);
    default:
      return isReference(expr.field);
  }
}

/**
 * The query with every saved-search reference replaced by the condition it names, as `userId`
 * sees saved searches. Throws QueryError at the reference for an unknown or hidden saved
 * search, a cycle or a chain too deep.
 */
export async function expandSavedSearches(
  db: Db,
  ws: number,
  userId: number | null,
  query: Query,
  options: ExpandOptions = {},
): Promise<Query> {
  if (!hasReferences(query.where)) return query;
  const lookup = new SavedSearchLookup(db, ws, userId);
  const start = options.self ? [options.self] : [];

  const expand = async (
    expr: Expr,
    stack: readonly { id: number; name: string }[],
  ): Promise<Expr> => {
    switch (expr.kind) {
      case 'and':
      case 'or': {
        const items: Expr[] = [];
        for (const item of expr.items) items.push(await expand(item, stack));
        return { ...expr, items } as Expr;
      }
      case 'not':
        return { ...expr, expr: await expand(expr.expr, stack) } as Expr;
      default:
        break;
    }
    if (!isReference(expr.field)) return expr;
    let values: Value[];
    let negate: boolean;
    if (expr.kind === 'compare' && (expr.op === '=' || expr.op === '!=')) {
      values = [expr.value];
      negate = expr.op === '!=';
    } else if (expr.kind === 'in') {
      values = expr.values;
      negate = expr.negated;
    } else {
      throw refusal(`${expr.field.name} takes =, !=, IN and NOT IN`, expr.span);
    }
    const parts: Expr[] = [];
    for (const value of values) {
      const text = referenceText(value);
      if (text === undefined) {
        throw refusal('A saved search is named by its name or id', value.span);
      }
      const found = await lookup.find(text);
      if (found === 'ambiguous') {
        throw refusal(`Several saved searches are named "${text}": name one by its id`, value.span);
      }
      if (!found) throw refusal(`Saved search "${text}" does not exist`, value.span);
      const at = stack.findIndex((s) => s.id === found.id);
      if (at >= 0) {
        const names = [...stack.slice(at), found].map((s) => `"${s.name}"`);
        throw refusal(
          `Saved searches refer to each other in a cycle: ${names.join(' → ')}`,
          value.span,
        );
      }
      if (stack.length >= MAX_REFERENCE_DEPTH) {
        throw refusal(
          `Saved searches nest more than ${MAX_REFERENCE_DEPTH} deep at "${found.name}"`,
          value.span,
        );
      }
      let inner: Query;
      try {
        inner = parseQuery(found.query);
      } catch (error) {
        if (!(error instanceof QueryError)) throw error;
        throw refusal(`Saved search "${found.name}" cannot be read: ${error.detail}`, value.span);
      }
      let where: Expr;
      try {
        where = inner.where
          ? await expand(inner.where, [...stack, { id: found.id, name: found.name }])
          : everything(expr.span);
      } catch (error) {
        // A refusal deeper down points at this reference, the text the person wrote.
        if (!(error instanceof QueryError)) throw error;
        throw refusal(error.detail, value.span);
      }
      parts.push(respan(where, expr.span));
    }
    const combined: Expr =
      parts.length === 1 ? (parts[0] as Expr) : { kind: 'or', items: parts, span: expr.span };
    return negate ? ({ kind: 'not', expr: combined, span: expr.span } as Expr) : combined;
  };

  return { ...query, where: query.where ? await expand(query.where, start) : null };
}
