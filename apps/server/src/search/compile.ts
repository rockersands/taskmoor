import { type RawBuilder, sql } from 'kysely';
import type {
  Bound,
  Cond,
  KeyDomain,
  OrderKey,
  OrderSource,
  Quantifier,
  Related,
  RelationName,
  Scalar,
  Scalarish,
  SideRef,
  SqlType,
  TicketSet,
  ValueTest,
} from './model';
import { nullableOrder, orderType } from './model';

/**
 * The production query compiler (M1-037; QRY-008 to QRY-010; ADR-010 "Implementation
 * (M1-037)"): a bound query (`model.ts`) becomes one parameterised statement over `ticket`
 * (alias `k`) and the custom field side tables (ADR-008). Values are always parameters, cast to
 * the column's type so indexes apply; the only text the compiler writes is its own.
 *
 * - The viewer's filter (`request.authz.ticketFilter()`, ADR-012: track browsing, ticket-level
 *   grants and visibility levels) is part of the statement, never applied afterwards
 *   (QRY-008), with the workspace and "not in the trash".
 * - Results are ordered by the keys asked for, then by the ticket id in the direction of the
 *   last key, so the order is total and pages are cut by keyset (QRY-009): the next page is
 *   the rows after the last one's keys, which stays right while others edit.
 * - When the order is by creation date, or by a number or date custom field the query also
 *   filters on, the statement is driven from that field's side table (an "anchor"): side rows
 *   carry the ticket's track and creation time, so the side index yields the page in order and
 *   the walk stops after one page (ADR-010, measured at 10M in M0-017).
 * - When the first key takes few values through one column (priority, status, type, level,
 *   close reason, track key), the page is a UNION ALL of one branch per value, each ordered by
 *   the remaining keys and cut at the page size, merged by the outer ORDER BY ("value
 *   branches"): each branch can walk an index in the remaining order (`updated`, `created`,
 *   the track's ticket numbers), where one statement would sort every match.
 */

export interface CompileOptions {
  workspaceId: number;
  /** The viewer's predicate on ticket `k` (TicketFilter.sql). */
  filter: RawBuilder<boolean>;
  /** The tracks the viewer may see tickets in; 'all' for every track (TicketFilter.tracks). */
  tracks: readonly number[] | 'all';
  /**
   * The comments the viewer reads, as a condition on a `ticket_comment` row `c` of ticket `k`
   * (`commentReadableSql`, M1-018). Comment search and `text ~` see no other comment.
   */
  comments: RawBuilder<boolean>;
  /** Drive from a side table when the order allows (default true); tests compare both forms. */
  anchor?: boolean;
  /** Merge value branches when the first key allows (default true); tests compare both forms. */
  branches?: boolean;
}

/** A position in the results: the last row's order values and its id. */
export interface Cursor {
  values: (Scalar | null)[];
  id: number;
}

export interface PageRow {
  id: number;
  [key: `c${number}`]: Scalar | null;
}

export interface CompiledSearch {
  /** The keys results are ordered by, before the id. */
  keys: readonly OrderKey[];
  /** Whether pages come from a side table walk. */
  anchored: boolean;
  /** Whether pages are merged from one branch per value of the first key. */
  branched: boolean;
  /** Identifies the order, so a cursor is only read back by a query that orders alike. */
  signature: string;
  /** Up to `limit` ids after `after`, each with its order values (`c0`, `c1`, ...). */
  page(limit: number, after?: Cursor): RawBuilder<PageRow>;
  /** How many tickets match, counted up to `cap`. */
  count(cap: number): RawBuilder<{ n: number }>;
}

const raw = (text: string) => sql.raw(text);
const param = (value: Scalar, type: SqlType) => sql`${value}::${raw(type)}`;
const array = (values: readonly Scalar[], type: SqlType) => sql`${[...values]}::${raw(type)}[]`;
const TRUE = sql<boolean>`true`;
const FALSE = sql<boolean>`false`;
const join = (parts: RawBuilder<unknown>[], separator: string) =>
  sql<boolean>`${sql.join(parts, raw(separator))}`;

/** AND of the parts; `true` parts drop out and a `false` one decides. */
function and(given: RawBuilder<boolean>[]): RawBuilder<boolean> {
  if (given.includes(FALSE)) return FALSE;
  const parts = given.filter((p) => p !== TRUE);
  if (parts.length === 0) return TRUE;
  if (parts.length === 1) return parts[0] as RawBuilder<boolean>;
  return sql<boolean>`(${join(parts, ' AND ')})`;
}

/** OR of the parts; `false` parts drop out and a `true` one decides. */
function or(given: RawBuilder<boolean>[]): RawBuilder<boolean> {
  if (given.includes(TRUE)) return TRUE;
  const parts = given.filter((p) => p !== FALSE);
  if (parts.length === 0) return FALSE;
  if (parts.length === 1) return parts[0] as RawBuilder<boolean>;
  return sql<boolean>`(${join(parts, ' OR ')})`;
}

function not(part: RawBuilder<boolean>): RawBuilder<boolean> {
  if (part === TRUE) return FALSE;
  if (part === FALSE) return TRUE;
  return sql<boolean>`NOT (${part})`;
}

const words = (column: RawBuilder<unknown>, text: string) =>
  sql<boolean>`to_tsvector('simple'::regconfig, ${column}) @@ plainto_tsquery('simple'::regconfig, ${text})`;

/** The words of a rich-text document: every `text` member, at any depth (ADR-014). */
const documentText = (column: string) =>
  sql`jsonb_path_query_array(${raw(column)}, 'strict $.**.text', '{}', true)`;

/** `value` passes `test`; `type` is the SQL type of the value. */
function valueTest(value: RawBuilder<unknown>, test: ValueTest, type: SqlType) {
  switch (test.kind) {
    case 'cmp':
      return sql<boolean>`${value} ${raw(test.op)} ${param(test.value, type)}`;
    case 'in':
      // One value is an equality, so an index on (value, created_at) still yields its rows in
      // order (an ANY over an array does not, before Postgres 17).
      if (test.values.length === 1) {
        return sql<boolean>`${value} = ${param(test.values[0] as Scalar, type)}`;
      }
      return test.values.length === 0
        ? FALSE
        : sql<boolean>`${value} = ANY(${array(test.values, type)})`;
    case 'words':
      return words(value, test.text);
  }
}

function scalarExpr(on: Scalarish): RawBuilder<unknown> {
  switch (on.kind) {
    case 'column':
      return raw(`k.${on.column}`);
    case 'effortRatio':
      return sql`(CASE WHEN k.original_estimate > 0 THEN k.time_spent * 100.0 / k.original_estimate END)`;
    case 'count':
      return sql`(SELECT count(*) FROM ${raw(on.relation === 'follower' ? 'ticket_follower' : 'ticket_vote')} r WHERE r.ticket_id = k.id)`;
  }
}

const scalarType = (on: Scalarish): SqlType =>
  on.kind === 'column' ? on.type : on.kind === 'count' ? 'bigint' : 'numeric';
const scalarNullable = (on: Scalarish) =>
  on.kind === 'column' ? on.nullable : on.kind === 'effortRatio';

function sideRows(side: SideRef, alias: string, condition?: RawBuilder<boolean>) {
  const head = sql`SELECT 1 FROM ${raw(side.table)} ${raw(alias)} WHERE ${raw(alias)}.ticket_id = k.id AND ${raw(alias)}.field_id = ${param(side.fieldId, 'int')}`;
  return condition
    ? sql<boolean>`EXISTS (${head} AND ${condition})`
    : sql<boolean>`EXISTS (${head})`;
}

/** Rows of a relation that belong to ticket `k`, optionally only those matching. */
function relatedRows(relation: RelationName, related?: Related): RawBuilder<boolean> {
  const ids = (column: string, values: readonly number[]) =>
    values.length === 0 ? FALSE : sql<boolean>`${raw(column)} = ANY(${array(values, 'int')})`;
  const exists = (from: string, where: RawBuilder<boolean>) =>
    where === FALSE ? FALSE : sql<boolean>`EXISTS (SELECT 1 FROM ${raw(from)} WHERE ${where})`;
  switch (relation) {
    case 'follower':
    case 'voter': {
      const table = relation === 'follower' ? 'ticket_follower r' : 'ticket_vote r';
      const match = related && 'ids' in related ? ids('r.user_id', related.ids) : TRUE;
      return exists(table, and([sql<boolean>`r.ticket_id = k.id`, match]));
    }
    case 'area': {
      const match = related && 'ids' in related ? ids('r.area_id', related.ids) : TRUE;
      return exists('ticket_area r', and([sql<boolean>`r.ticket_id = k.id`, match]));
    }
    case 'targetRelease':
    case 'foundInRelease': {
      const role = relation === 'targetRelease' ? 'target' : 'found';
      const match = related && 'ids' in related ? ids('r.release_id', related.ids) : TRUE;
      return exists(
        'ticket_release r',
        and([sql<boolean>`r.ticket_id = k.id`, sql<boolean>`r.role = ${role}`, match]),
      );
    }
    case 'parentTrack':
      return related && 'ids' in related
        ? exists(
            'ticket p',
            and([sql<boolean>`p.id = k.parent_id`, ids('p.track_id', related.ids)]),
          )
        : sql<boolean>`k.parent_id IS NOT NULL`;
    case 'link': {
      const other = related && related.relation === 'link' ? related.ids : undefined;
      return or([
        exists(
          'ticket_link r',
          and([sql<boolean>`r.source_id = k.id`, other ? ids('r.target_id', other) : TRUE]),
        ),
        exists(
          'ticket_link r',
          and([sql<boolean>`r.target_id = k.id`, other ? ids('r.source_id', other) : TRUE]),
        ),
      ]);
    }
    case 'linkType': {
      if (related?.relation !== 'linkType') return relatedRows('link');
      const outward = [...new Set([...related.both, ...related.outward])].sort((a, b) => a - b);
      const inward = [...new Set([...related.both, ...related.inward])].sort((a, b) => a - b);
      return or([
        ...(outward.length > 0
          ? [
              exists(
                'ticket_link r',
                and([sql<boolean>`r.source_id = k.id`, ids('r.link_type_id', outward)]),
              ),
            ]
          : []),
        ...(inward.length > 0
          ? [
              exists(
                'ticket_link r',
                and([sql<boolean>`r.target_id = k.id`, ids('r.link_type_id', inward)]),
              ),
            ]
          : []),
      ]);
    }
    case 'timeEntry': {
      // Entries shown to a role or group only are left out for everyone: their comments and
      // dates are not the viewer's to search.
      const base = [
        sql<boolean>`r.ticket_id = k.id`,
        sql<boolean>`r.visible_role_id IS NULL`,
        sql<boolean>`r.visible_group_id IS NULL`,
      ];
      if (related && related.relation === 'timeEntry') {
        base.push(
          related.on === 'comment'
            ? valueTest(raw('r.description'), related.test, 'text')
            : valueTest(sql`(r.started_at AT TIME ZONE 'UTC')::date`, related.test, 'date'),
        );
      }
      return exists('time_entry r', and(base));
    }
    case 'attachment':
      return exists('attachment r', sql<boolean>`r.ticket_id = k.id`);
  }
}

/** What a condition needs from the viewer beyond the ticket filter. */
interface CondContext {
  comments: RawBuilder<boolean>;
  /** The viewer's predicate on ticket `k`, for tickets other than the row (a parent). */
  filter: RawBuilder<boolean>;
  workspaceId: number;
}

/**
 * Ticket `k` is in the set a function names (M1-038): a semi-join on its id, so the set is
 * never read into the query as a list.
 */
function inTicketSet(set: TicketSet, ctx: CondContext): RawBuilder<boolean> {
  const exists = (from: string, where: RawBuilder<boolean>[]) =>
    sql<boolean>`EXISTS (SELECT 1 FROM ${raw(from)} WHERE ${and(where)})`;
  const ids = (column: string, values: readonly number[]) =>
    values.length === 1
      ? sql<boolean>`${raw(column)} = ${param(values[0] as number, 'int')}`
      : sql<boolean>`${raw(column)} = ANY(${array(values, 'int')})`;
  switch (set.kind) {
    case 'followed':
    case 'voted':
      return exists(set.kind === 'followed' ? 'ticket_follower r' : 'ticket_vote r', [
        sql<boolean>`r.ticket_id = k.id`,
        sql<boolean>`r.user_id = ${param(set.userId, 'int')}`,
      ]);
    case 'visited':
      return exists('ticket_visit r', [
        sql<boolean>`r.user_id = ${param(set.userId, 'int')}`,
        sql<boolean>`r.ticket_id = k.id`,
      ]);
    case 'updatedBy': {
      if (set.userIds.length === 0) return FALSE;
      const within = (column: string) => [
        ...(set.from ? [sql<boolean>`${raw(column)} >= ${param(set.from, 'timestamptz')}`] : []),
        ...(set.to ? [sql<boolean>`${raw(column)} <= ${param(set.to, 'timestamptz')}`] : []),
      ];
      return or([
        exists('ticket_change r', [
          sql<boolean>`r.ticket_id = k.id`,
          ids('r.actor_id', set.userIds),
          ...within('r.at'),
        ]),
        and([ids('k.creator_id', set.userIds), ...within('k.created_at')]),
        // Comments count where the viewer reads them: a hidden comment tells nothing.
        commentRows(ctx, and([ids('c.author_id', set.userIds), ...within('c.created_at')])),
      ]);
    }
    case 'linked': {
      if (set.ticketIds.length === 0) return FALSE;
      const typed = (types: number[] | 'all') =>
        types === 'all' ? TRUE : types.length === 0 ? FALSE : ids('r.link_type_id', types);
      const out = typed(set.outward);
      const back = typed(set.inward);
      return or([
        out === FALSE
          ? FALSE
          : exists('ticket_link r', [
              sql<boolean>`r.target_id = k.id`,
              ids('r.source_id', set.ticketIds),
              out,
            ]),
        back === FALSE
          ? FALSE
          : exists('ticket_link r', [
              sql<boolean>`r.source_id = k.id`,
              ids('r.target_id', set.ticketIds),
              back,
            ]),
      ]);
    }
    case 'webLinks':
      if (set.globalIds.length === 0) return FALSE;
      return exists('ticket_web_link r', [
        sql<boolean>`r.ticket_id = k.id`,
        sql<boolean>`r.global_id = ANY(${array(set.globalIds, 'text')})`,
      ]);
  }
}

/**
 * A ticket-set condition on the row's own id, or on its parent: the parent must be one the
 * viewer may see, so its alias `k` is rebound inside the subquery (the filter reads `k`).
 */
function ticketSetCond(
  c: Extract<Cond, { kind: 'ticketSet' }>,
  ctx: CondContext,
): RawBuilder<boolean> {
  const member = inTicketSet(c.set, ctx);
  if (c.on === 'id') return c.negated ? not(member) : member;
  if (member === FALSE) return c.negated ? sql<boolean>`k.parent_id IS NOT NULL` : FALSE;
  const parents = sql<boolean>`k.parent_id IN (SELECT k.id FROM ticket k WHERE ${and([
    sql<boolean>`k.workspace_id = ${param(ctx.workspaceId, 'int')}`,
    sql<boolean>`k.deleted_at IS NULL`,
    ctx.filter,
    member,
  ])})`;
  return c.negated ? and([sql<boolean>`k.parent_id IS NOT NULL`, not(parents)]) : parents;
}

/** Comments of ticket `k` the viewer reads, optionally only those matching. */
function commentRows(ctx: CondContext, match?: RawBuilder<boolean>): RawBuilder<boolean> {
  const where = and([sql<boolean>`c.ticket_id = k.id`, ctx.comments, ...(match ? [match] : [])]);
  return sql<boolean>`EXISTS (SELECT 1 FROM ticket_comment c WHERE ${where})`;
}

function quantified(
  any: RawBuilder<boolean>,
  matching: RawBuilder<boolean>,
  quantifier: Quantifier,
): RawBuilder<boolean> {
  return quantifier === 'some' ? matching : and([any, not(matching)]);
}

/** The condition on ticket `k`. */
export function compileCond(c: Cond, ctx: CondContext): RawBuilder<boolean> {
  switch (c.kind) {
    case 'and':
      return and(c.items.map((i) => compileCond(i, ctx)));
    case 'or':
      return or(c.items.map((i) => compileCond(i, ctx)));
    case 'const':
      return c.value ? TRUE : FALSE;
    case 'scalar': {
      const expr = scalarExpr(c.on);
      const type = scalarType(c.on);
      if (!c.negated) return valueTest(expr, c.test, type);
      if (c.test.kind !== 'in') throw new Error('Only IN is negated in place');
      // NOT IN never matches an empty value (spec 01b section 1.1).
      if (c.test.values.length === 0) {
        return scalarNullable(c.on) ? sql<boolean>`${expr} IS NOT NULL` : TRUE;
      }
      return sql<boolean>`${expr} <> ALL(${array(c.test.values, type)})`;
    }
    case 'empty': {
      if (!scalarNullable(c.on)) return c.negated ? TRUE : FALSE;
      return sql<boolean>`${scalarExpr(c.on)} IS ${raw(c.negated ? 'NOT NULL' : 'NULL')}`;
    }
    case 'labels': {
      const match =
        c.values.length === 0 ? FALSE : sql<boolean>`k.labels && ${array(c.values, 'text')}`;
      return quantified(sql<boolean>`cardinality(k.labels) > 0`, match, c.quantifier);
    }
    case 'labelsEmpty':
      return sql<boolean>`cardinality(k.labels) ${raw(c.negated ? '>' : '=')} 0`;
    case 'words': {
      if (c.source === 'summary') {
        const match = words(raw('k.summary'), c.text);
        return c.negated ? not(match) : match;
      }
      if (c.source === 'comment') {
        // Several comments per ticket: `!~` means it has some the viewer reads, none matching.
        const match = commentRows(ctx, words(documentText('c.body'), c.text));
        return c.negated ? and([commentRows(ctx), not(match)]) : match;
      }
      const column = `k.${c.source}`;
      const match = words(documentText(column), c.text);
      return and([sql<boolean>`${raw(column)} IS NOT NULL`, c.negated ? not(match) : match]);
    }
    case 'wordsEmpty': {
      if (c.source === 'comment') {
        const any = commentRows(ctx);
        return c.negated ? any : not(any);
      }
      return sql<boolean>`k.${raw(c.source)} IS ${raw(c.negated ? 'NOT NULL' : 'NULL')}`;
    }
    case 'text': {
      const parts = [
        words(raw('k.summary'), c.text),
        words(documentText('k.description'), c.text),
        words(documentText('k.environment'), c.text),
        commentRows(ctx, words(documentText('c.body'), c.text)),
      ];
      if (c.fieldIds.length > 0) {
        parts.push(
          sql<boolean>`EXISTS (SELECT 1 FROM v_text v WHERE v.ticket_id = k.id AND v.field_id = ANY(${array(c.fieldIds, 'int')}) AND ${words(raw('v.value'), c.text)})`,
        );
      }
      const match = or(parts);
      return c.negated ? not(match) : match;
    }
    case 'side': {
      const test = valueTest(raw('v.value'), c.test, c.side.type);
      if (c.quantifier === 'some') return sideRows(c.side, 'v', test);
      // One value per ticket: it is there and fails the test. Several: there are some and
      // none passes.
      if (!c.side.multiple) return sideRows(c.side, 'v', not(test));
      return and([sideRows(c.side, 'v'), not(sideRows(c.side, 'v', test))]);
    }
    case 'sideEmpty': {
      const any = sideRows(c.side, 'v');
      return c.negated ? any : not(any);
    }
    case 'related':
      return quantified(
        relatedRows(c.related.relation),
        relatedRows(c.related.relation, c.related),
        c.quantifier,
      );
    case 'relatedEmpty': {
      const any = relatedRows(c.relation);
      return c.negated ? any : not(any);
    }
    case 'ticketSet':
      return ticketSetCond(c, ctx);
  }
}

/** The expression a key orders by, on ticket `k`. */
export function orderExpr(source: OrderSource): RawBuilder<unknown> {
  const one = (text: string) => sql`(${raw(text)})`;
  switch (source.kind) {
    case 'column':
      return raw(`k.${source.column}`);
    case 'lowerSummary':
      return raw('lower(k.summary)');
    case 'trackKey':
      return one('SELECT o.key FROM track o WHERE o.id = k.track_id');
    case 'typeName':
      return one('SELECT lower(o.name) FROM ticket_type o WHERE o.id = k.ticket_type_id');
    case 'levelRank':
      return one(
        'SELECT l.rank FROM ticket_type o JOIN hierarchy_level l ON l.id = o.level_id WHERE o.id = k.ticket_type_id',
      );
    case 'statusOrder':
      return one('SELECT o.sort_order FROM status o WHERE o.id = k.status_id');
    case 'priorityRank':
      return one('SELECT -o.sort_order FROM priority o WHERE o.id = k.priority_id');
    case 'closeReasonOrder':
      return one('SELECT o.sort_order FROM close_reason o WHERE o.id = k.close_reason_id');
    case 'personName':
      return one(`SELECT lower(o.name) FROM app_user o WHERE o.id = k.${source.column}`);
    case 'count':
      return one(
        `SELECT count(*) FROM ${source.relation === 'follower' ? 'ticket_follower' : 'ticket_vote'} o WHERE o.ticket_id = k.id`,
      );
    case 'areaName':
      return one(
        'SELECT min(lower(a.name)) FROM ticket_area o JOIN area a ON a.id = o.area_id WHERE o.ticket_id = k.id',
      );
    case 'releaseOrder':
      return one(
        `SELECT min(r.sort_order) FROM ticket_release o JOIN release r ON r.id = o.release_id WHERE o.ticket_id = k.id AND o.role = '${source.role}'`,
      );
    case 'effortRatio':
      return scalarExpr({ kind: 'effortRatio' });
    case 'side': {
      const s = source.side;
      const rows = (select: string, joins = '') =>
        sql`(SELECT ${raw(select)} FROM ${raw(s.table)} o${raw(joins)} WHERE o.ticket_id = k.id AND o.field_id = ${param(s.fieldId, 'int')})`;
      switch (source.by) {
        case 'value':
          return rows('min(o.value)');
        case 'sortKey':
          return rows('min(o.sort_key)');
        case 'optionOrder':
          return rows(
            'min(f.sort_order)',
            ' JOIN field_option f ON f.id = o.value AND f.parent_id IS NULL',
          );
        case 'cascadeChildOrder':
          return rows(
            'min(f.sort_order)',
            ' JOIN field_option f ON f.id = o.value AND f.parent_id IS NOT NULL',
          );
        case 'personName':
          return rows('min(lower(u.name))', ' JOIN app_user u ON u.id = o.value');
        case 'groupName':
          return rows('min(lower(g.name))', ' JOIN user_group g ON g.id = o.value');
        case 'releaseOrder':
          return rows('min(r.sort_order)', ' JOIN release r ON r.id = o.value');
        case 'areaName':
          return rows('min(lower(a.name))', ' JOIN area a ON a.id = o.value');
      }
    }
  }
}

/** A key's value as the page returns it: instants as text, so a cursor keeps microseconds. */
function output(expr: RawBuilder<unknown>, type: SqlType): RawBuilder<unknown> {
  return type === 'timestamptz' ? sql`(${expr})::text` : expr;
}

interface Walk {
  /** FROM and its joins. */
  from: RawBuilder<unknown>;
  /** The id column of the walk. */
  id: string;
  /** The expressions of the keys. */
  exprs: RawBuilder<unknown>[];
  conditions: RawBuilder<boolean>[];
  /** The key expressions are never empty (a side table's value column). */
  notNull?: boolean;
}

/** The id breaks ties in the direction of the last key. */
const idDirectionOf = (keys: readonly OrderKey[]) => keys[keys.length - 1]?.direction ?? 'desc';

/** Rows after `after` in the order of `keys` then the id (keyset pagination, QRY-009). */
function afterCursor(
  keys: readonly OrderKey[],
  walk: Walk,
  after: Cursor,
  idDirection: 'asc' | 'desc' = idDirectionOf(keys),
): RawBuilder<boolean> {
  const { exprs, id } = walk;
  const canBeEmpty = (k: OrderKey) => !walk.notNull && nullableOrder(k.source);
  const sameDirection = keys.every((k) => k.direction === idDirection);
  const nullable = keys.some(canBeEmpty);
  const typed = keys.map((k, i) => {
    const v = after.values[i];
    return v === null || v === undefined ? null : param(v, orderType(k.source));
  });
  const idValue = param(after.id, 'int');
  // One direction and no empty values: a row comparison, which a matching index serves.
  if (sameDirection && !nullable) {
    const op = idDirection === 'desc' ? '<' : '>';
    return sql<boolean>`(${sql.join([...exprs, raw(id)])}) ${raw(op)} (${sql.join([...(typed as RawBuilder<unknown>[]), idValue])})`;
  }
  // Otherwise: equal on the first i keys and after on key i, for each i, then the id.
  const alternatives: RawBuilder<boolean>[] = [];
  const equal: RawBuilder<boolean>[] = [];
  keys.forEach((key, i) => {
    const expr = exprs[i] as RawBuilder<unknown>;
    const value = typed[i];
    if (value === null || value === undefined) {
      // Empties sort last: nothing but other empties comes after an empty value.
      equal.push(sql<boolean>`${expr} IS NULL`);
      return;
    }
    const op = key.direction === 'desc' ? '<' : '>';
    const later = canBeEmpty(key)
      ? sql<boolean>`(${expr} ${raw(op)} ${value} OR ${expr} IS NULL)`
      : sql<boolean>`${expr} ${raw(op)} ${value}`;
    alternatives.push(and([...equal, later]));
    equal.push(sql<boolean>`${expr} = ${value}`);
  });
  alternatives.push(
    and([...equal, sql<boolean>`${raw(id)} ${raw(idDirection === 'desc' ? '<' : '>')} ${idValue}`]),
  );
  return or(alternatives);
}

function orderClause(keys: readonly OrderKey[], walk: Walk) {
  const idDirection = idDirectionOf(keys);
  const parts = keys.map((k, i) => {
    // NULLS LAST only where a value can be empty: on a NOT NULL column it would keep the
    // planner from walking a plain index (ADR-010).
    const nulls = !walk.notNull && nullableOrder(k.source) ? ' NULLS LAST' : '';
    // By the output column, so a subquery is not evaluated twice; instants are output as
    // text (for the cursor), so those order by their expression.
    const by =
      orderType(k.source) === 'timestamptz' ? (walk.exprs[i] as RawBuilder<unknown>) : raw(`c${i}`);
    return sql`${by} ${raw(k.direction.toUpperCase())}${raw(nulls)}`;
  });
  parts.push(sql`${raw(walk.id)} ${raw(idDirection.toUpperCase())}`);
  return sql.join(parts);
}

function statement(walk: Walk, keys: readonly OrderKey[], limit: number, after?: Cursor) {
  const conditions = [...walk.conditions];
  if (after) conditions.push(afterCursor(keys, walk, after));
  const columns = [
    sql`${raw(walk.id)} AS id`,
    ...keys.map(
      (k, i) =>
        sql`${output(walk.exprs[i] as RawBuilder<unknown>, orderType(k.source))} AS ${raw(`c${i}`)}`,
    ),
  ];
  return sql<PageRow>`SELECT ${sql.join(columns)} FROM ${walk.from} WHERE ${join(conditions, ' AND ')} ORDER BY ${orderClause(keys, walk)} LIMIT ${param(limit, 'int')}`;
}

/** The conditions every statement starts with: workspace, trash, the viewer's filter. */
function baseConditions(options: CompileOptions): RawBuilder<boolean>[] {
  return [
    sql<boolean>`k.workspace_id = ${param(options.workspaceId, 'int')}`,
    sql<boolean>`k.deleted_at IS NULL`,
    options.filter,
  ];
}

export function compileSearch(bound: Bound, options: CompileOptions): CompiledSearch {
  const keys = bound.orderBy;
  const signature = keys.map((k) => `${JSON.stringify(k.source)}:${k.direction}`).join('|');
  const ctx: CondContext = {
    comments: options.comments,
    filter: options.filter,
    workspaceId: options.workspaceId,
  };
  const where = compileCond(bound.where, ctx);
  const plainWhere = [...baseConditions(options), ...(where === TRUE ? [] : [where])];
  const anchor = options.anchor === false ? undefined : findAnchor(bound);
  const plain: Walk = {
    from: raw('ticket k'),
    id: 'k.id',
    exprs: keys.map((k) => orderExpr(k.source)),
    conditions: plainWhere,
  };
  const walk = anchor ? anchoredWalk(anchor, options, ctx) : plain;
  const branches =
    anchor || !bound.domain || options.branches === false
      ? undefined
      : valueBranches(bound, bound.domain, options);
  return {
    keys,
    anchored: anchor !== undefined,
    branched: branches !== undefined,
    signature,
    page: (limit, after) =>
      branches
        ? branchStatement(
            branches,
            keys,
            [
              ...baseConditions(options),
              compileCond({ kind: 'and', items: branches.rest }, ctx),
            ].filter((c) => c !== TRUE),
            limit,
            after,
          )
        : statement(walk, keys, limit, after),
    count: (cap) =>
      sql<{
        n: number;
      }>`SELECT count(*)::int AS n FROM (SELECT 1 FROM ticket k WHERE ${join(plainWhere, ' AND ')} LIMIT ${param(cap, 'int')}) c`,
  };
}

type SideCond = Extract<Cond, { kind: 'side' }>;

/** A positive condition on a custom field that a side-table walk can start from. */
function anchorable(c: Cond): c is SideCond {
  if (c.kind !== 'side' || c.quantifier !== 'some') return false;
  return c.test.kind === 'in' || (c.test.kind === 'cmp' && c.test.op !== '<>');
}

/** At most one side row per ticket passes it, so walking the side table repeats no ticket. */
function oneRowPerTicket(c: SideCond): boolean {
  if (!c.side.multiple) return true;
  return c.test.kind === 'cmp'
    ? c.test.op === '='
    : c.test.kind === 'in' && c.test.values.length === 1;
}

const isEquality = (c: SideCond) =>
  c.test.kind === 'in' || (c.test.kind === 'cmp' && c.test.op === '=');

/** `track = x` or `track IN (...)`, which the side row's copy of the track answers. */
function trackCond(c: Cond): c is Extract<Cond, { kind: 'scalar' }> {
  return (
    c.kind === 'scalar' &&
    !c.negated &&
    c.on.kind === 'column' &&
    c.on.column === 'track_id' &&
    (c.test.kind === 'in' || (c.test.kind === 'cmp' && c.test.op === '='))
  );
}

interface Anchor {
  pick: SideCond;
  /** Conditions the anchor row answers: the pick and others on a single-valued field. */
  onValue: SideCond[];
  onTrack: Extract<Cond, { kind: 'scalar' }>[];
  rest: Cond[];
  order: 'created' | 'value';
  dedupe: boolean;
}

/**
 * Whether to drive from a side table: the order is one key, by creation date or by a number or
 * date custom field, and a top-level condition filters a custom field positively (the ordered
 * field itself when ordering by value). Equalities go first: one value's rows are already in
 * creation order in the side index.
 */
export function findAnchor(bound: Bound): Anchor | undefined {
  const [sort, ...more] = bound.orderBy;
  if (!sort || more.length > 0) return undefined;
  const items = bound.where.kind === 'and' ? bound.where.items : [bound.where];
  let pick: SideCond | undefined;
  let order: Anchor['order'];
  if (sort.source.kind === 'column' && sort.source.column === 'created_at') {
    order = 'created';
    const single = (c: Cond): c is SideCond => anchorable(c) && oneRowPerTicket(c);
    pick =
      items.find((c): c is SideCond => single(c) && isEquality(c)) ??
      items.find(single) ??
      items.find(anchorable);
  } else if (
    sort.source.kind === 'side' &&
    sort.source.by === 'value' &&
    sort.source.side.ordered &&
    !sort.source.side.multiple
  ) {
    order = 'value';
    const fieldId = sort.source.side.fieldId;
    pick = items.find((c): c is SideCond => anchorable(c) && c.side.fieldId === fieldId);
  } else {
    return undefined;
  }
  if (!pick) return undefined;
  const anchor: Anchor = {
    pick,
    onValue: [],
    onTrack: [],
    rest: [],
    order,
    dedupe: !oneRowPerTicket(pick),
  };
  for (const c of items) {
    if (
      c === pick ||
      (!pick.side.multiple && anchorable(c) && c.side.fieldId === pick.side.fieldId)
    ) {
      anchor.onValue.push(c as SideCond);
    } else if (trackCond(c)) {
      anchor.onTrack.push(c);
    } else {
      anchor.rest.push(c);
    }
  }
  return anchor;
}

function anchoredWalk(a: Anchor, options: CompileOptions, ctx: CondContext): Walk {
  const side = a.pick.side;
  const conditions: RawBuilder<boolean>[] = [
    sql<boolean>`a.field_id = ${param(side.fieldId, 'int')}`,
  ];
  for (const c of a.onValue) conditions.push(valueTest(raw('a.value'), c.test, side.type));
  if (a.dedupe) {
    // Keep one row per ticket: its lowest matching value.
    conditions.push(
      sql<boolean>`NOT EXISTS (SELECT 1 FROM ${raw(side.table)} b WHERE b.ticket_id = a.ticket_id AND b.field_id = a.field_id AND ${valueTest(raw('b.value'), a.pick.test, side.type)} AND b.value < a.value)`,
    );
  }
  for (const c of a.onTrack) conditions.push(valueTest(raw('a.track_id'), c.test, 'int'));
  if (options.tracks !== 'all')
    conditions.push(
      valueTest(raw('a.track_id'), { kind: 'in', values: [...options.tracks] }, 'int'),
    );
  conditions.push(
    ...baseConditions(options),
    ...a.rest.map((c) => compileCond(c, ctx)).filter((c) => c !== TRUE),
  );
  return {
    from: sql`${raw(side.table)} a JOIN ticket k ON k.id = a.ticket_id`,
    id: 'a.ticket_id',
    exprs: [raw(a.order === 'created' ? 'a.created_at' : 'a.value')],
    conditions,
    notNull: true,
  };
}

/** More branches than this, and one statement sorts instead (planning grows with branches). */
const MAX_BRANCHES = 40;

interface Branches {
  domain: KeyDomain;
  /** The values left after the query's own conditions on the column, in no particular order. */
  values: KeyDomain['values'];
  /** Whether tickets with the column empty can match (they sort last). */
  empty: boolean;
  /**
   * The top-level conditions the branches do not already answer: those on the column are left
   * out, so the planner does not count them twice when it estimates a branch's rows.
   */
  rest: Cond[];
}

/**
 * The values of the first key's column that the query can match: top-level conditions on the
 * column (`priority > Normal`, `track IN (A, B)`, `status != Done`) and, for tracks, the
 * viewer's tracks leave the others out. Undefined when there are too many to merge.
 */
function valueBranches(
  bound: Bound,
  domain: KeyDomain,
  options: CompileOptions,
): Branches | undefined {
  const items = bound.where.kind === 'and' ? bound.where.items : [bound.where];
  let allowed: Set<number> | undefined;
  const refused = new Set<number>();
  let empty = domain.nullable;
  let some = true;
  const rest: Cond[] = [];
  const allow = (ids: Iterable<number>) => {
    const next = new Set(ids);
    allowed = allowed ? new Set([...allowed].filter((id) => next.has(id))) : next;
  };
  for (const c of items) {
    if (c.kind === 'empty' && c.on.kind === 'column' && c.on.column === domain.column) {
      if (c.negated) empty = false;
      else some = false;
      continue;
    }
    let values: Scalar[] | undefined;
    if (c.kind === 'scalar' && c.on.kind === 'column' && c.on.column === domain.column) {
      if (c.test.kind === 'in') values = c.test.values;
      else if (c.test.kind === 'cmp' && c.test.op === '=') values = [c.test.value];
    }
    if (c.kind !== 'scalar' || values === undefined) {
      if (!(c.kind === 'const' && c.value)) rest.push(c);
      continue;
    }
    // A test on a value never matches an empty column (spec 01b section 1.1).
    empty = false;
    if (c.negated) for (const v of values) refused.add(Number(v));
    else allow(values.map(Number));
  }
  if (domain.column === 'track_id' && options.tracks !== 'all') allow(options.tracks);
  const values = some
    ? domain.values
        .map((v) => ({
          value: v.value,
          ids: v.ids.filter((id) => !refused.has(id) && (!allowed || allowed.has(id))),
        }))
        .filter((v) => v.ids.length > 0)
    : [];
  if (values.length + (empty ? 1 : 0) > MAX_BRANCHES) return undefined;
  if (values.length === 0 && !empty) return undefined;
  return { domain, values, empty, rest };
}

/**
 * A page merged from value branches: each branch holds the tickets with one value of the first
 * key, ordered by the other keys and the id and cut at the page size; the outer ORDER BY merges
 * them. A cursor's first value decides each branch in SQL (so text compares by the database's
 * collation, as the plain form sorts): branches before it are out, its own continues after the
 * cursor's other values, later ones start from their top.
 */
function branchStatement(
  b: Branches,
  keys: readonly OrderKey[],
  where: readonly RawBuilder<boolean>[],
  limit: number,
  after?: Cursor,
) {
  const [first, ...rest] = keys as [OrderKey, ...OrderKey[]];
  const idDirection = idDirectionOf(keys);
  const type = b.domain.type;
  const column = raw(`k.${b.domain.column}`);
  const restWalk: Walk = {
    from: raw('ticket k'),
    id: 'k.id',
    exprs: rest.map((k) => orderExpr(k.source)),
    conditions: [],
  };
  const op = first.direction === 'desc' ? '<' : '>';
  const cursorValue = after?.values[0];
  const continued = (value: RawBuilder<unknown> | null): RawBuilder<boolean> => {
    if (!after) return TRUE;
    const tail = afterCursor(
      rest,
      restWalk,
      { values: after.values.slice(1), id: after.id },
      idDirection,
    );
    if (cursorValue === null || cursorValue === undefined) {
      // The cursor is among the empties, which come last: only that branch goes on.
      return value === null ? tail : FALSE;
    }
    if (value === null) return TRUE;
    const at = param(cursorValue, type);
    return or([
      sql<boolean>`${value} ${raw(op)} ${at}`,
      and([sql<boolean>`${value} = ${at}`, tail]),
    ]);
  };
  const branch = (value: RawBuilder<unknown> | null, match: RawBuilder<boolean>) => {
    const conditions = [...where, match, continued(value)].filter((c) => c !== TRUE);
    if (conditions.includes(FALSE)) return undefined;
    const columns = [
      sql`k.id AS id`,
      sql`${value ?? sql`NULL::${raw(type)}`} AS c0`,
      ...rest.flatMap((k, i) => {
        const expr = restWalk.exprs[i] as RawBuilder<unknown>;
        const out = [sql`${output(expr, orderType(k.source))} AS ${raw(`c${i + 1}`)}`];
        // Instants travel as text; the merge orders by the instant itself.
        if (orderType(k.source) === 'timestamptz') out.push(sql`${expr} AS ${raw(`o${i + 1}`)}`);
        return out;
      }),
    ];
    const order = rest.map((k, i) => {
      const nulls = nullableOrder(k.source) ? ' NULLS LAST' : '';
      const by =
        orderType(k.source) === 'timestamptz'
          ? (restWalk.exprs[i] as RawBuilder<unknown>)
          : raw(`c${i + 1}`);
      return sql`${by} ${raw(k.direction.toUpperCase())}${raw(nulls)}`;
    });
    order.push(sql`k.id ${raw(idDirection.toUpperCase())}`);
    return sql`(SELECT ${sql.join(columns)} FROM ticket k WHERE ${join(conditions, ' AND ')} ORDER BY ${sql.join(order)} LIMIT ${param(limit, 'int')})`;
  };
  const parts = b.values.flatMap((v) => {
    const value = param(v.value, type);
    const match =
      v.ids.length === 1
        ? sql<boolean>`${column} = ${param(v.ids[0] as number, 'int')}`
        : sql<boolean>`${column} = ANY(${array(v.ids, 'int')})`;
    return branch(value, match) ?? [];
  });
  if (b.empty) {
    const part = branch(null, sql<boolean>`${column} IS NULL`);
    if (part) parts.push(part);
  }
  const names = [sql`id`, ...keys.map((_, i) => raw(`c${i}`))];
  if (parts.length === 0) {
    // The cursor is past every branch: an empty page.
    return sql<PageRow>`SELECT ${sql.join(names)} FROM (SELECT NULL::int AS id, ${sql.join(
      keys.map((_, i) => sql`NULL AS ${raw(`c${i}`)}`),
    )}) s WHERE false`;
  }
  const outer = [
    sql`c0 ${raw(first.direction.toUpperCase())}${raw(b.empty ? ' NULLS LAST' : '')}`,
    ...rest.map((k, i) => {
      const name = orderType(k.source) === 'timestamptz' ? `o${i + 1}` : `c${i + 1}`;
      const nulls = nullableOrder(k.source) ? ' NULLS LAST' : '';
      return sql`${raw(name)} ${raw(k.direction.toUpperCase())}${raw(nulls)}`;
    }),
    sql`id ${raw(idDirection.toUpperCase())}`,
  ];
  return sql<PageRow>`SELECT ${sql.join(names)} FROM (${sql.join(parts, raw(' UNION ALL '))}) s ORDER BY ${sql.join(outer)} LIMIT ${param(limit, 'int')}`;
}
