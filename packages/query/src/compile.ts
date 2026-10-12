import type { CustomField, Field, SystemField } from './fields';
import type { Comparison, HistoryPredicate, Plan, Pred, Typed } from './resolve';

export interface CompileOptions {
  /** Schema holding `item` and the side tables. */
  schema: string;
  /** Change history table with (item_id, at, actor_id, field, from_value, to_value). */
  historyTable: string;
  /** Tracks the caller may see; `null` means every track (admin or a public site). */
  allowedTrackIds: readonly number[] | null;
  limit: number;
  offset?: number;
  /**
   * Drive the statement from a custom field's side table when the order allows it (default
   * true); false keeps the plain item-table form, which tests compare against.
   */
  anchor?: boolean;
}

export interface CompiledQuery {
  text: string;
  params: unknown[];
}

/** The SQL type of each side table's value column, so comparisons can use its indexes. */
const SIDE_CAST: Record<CustomField['type'], string> = {
  text: 'text',
  number: 'numeric',
  date: 'date',
  user: 'int',
  option: 'text',
  multi: 'text',
  labels: 'text',
};

/** Types with at most one side row per item and field. */
const SINGLE_VALUED: ReadonlySet<CustomField['type']> = new Set([
  'text',
  'number',
  'date',
  'user',
  'option',
]);

const SIDE_TABLE: Record<CustomField['type'], string> = {
  text: 'v_text',
  number: 'v_number',
  date: 'v_date',
  user: 'v_user',
  option: 'v_option',
  multi: 'v_option',
  labels: 'v_option',
};

/**
 * Turns a resolved plan into one SQL statement over the typed side tables (ADR-008). System
 * fields filter the item table; each custom-field condition is an EXISTS on its side table, so
 * the planner can use the (field, value) indexes and intersect by item ID.
 */
export function compilePlan(plan: Plan, options: CompileOptions): CompiledQuery {
  const anchor = options.anchor === false ? undefined : findAnchor(plan);
  if (anchor) return compileAnchored(anchor, options);
  const c = new Compiler(options);
  const conditions: string[] = [];
  if (options.allowedTrackIds !== null) {
    conditions.push(`i.space_id = ANY(${c.param(options.allowedTrackIds)}::int[])`);
  }
  if (plan.where) conditions.push(c.pred(plan.where));
  const order = plan.orderBy.map(
    // NULLS LAST only where a value can be null: on a NOT NULL column it would stop the
    // planner from walking a plain DESC index, which sorts nulls first.
    (o) =>
      `${c.orderExpr(o.field)} ${o.direction.toUpperCase()}${
        o.field.kind === 'custom' || o.field.nullable ? ' NULLS LAST' : ''
      }`,
  );
  order.push('i.id DESC');
  const text =
    `SELECT i.id FROM ${options.schema}.item i` +
    (conditions.length ? `\nWHERE ${conditions.join('\n  AND ')}` : '') +
    `\nORDER BY ${order.join(', ')}` +
    `\nLIMIT ${c.param(options.limit)}` +
    (options.offset ? ` OFFSET ${c.param(options.offset)}` : '');
  return { text, params: c.params };
}

class Compiler {
  readonly params: unknown[] = [];

  constructor(private readonly options: CompileOptions) {}

  param(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  pred(p: Pred): string {
    switch (p.kind) {
      case 'and':
        return `(${p.items.map((i) => this.pred(i)).join(' AND ')})`;
      case 'or':
        return `(${p.items.map((i) => this.pred(i)).join(' OR ')})`;
      case 'not':
        return `NOT ${this.pred(p.pred)}`;
      case 'compare': {
        if (p.field.kind === 'system') return this.systemCompare(p.field, p.op, p.value);
        const field = p.field;
        return this.customExists(field, () => this.sideValue('v.value', field, p.op, p.value));
      }
      case 'in': {
        if (p.field.kind === 'system') {
          if (p.field.type === 'labels') {
            const expr = `i.labels && ${this.param(p.values.map((v) => v.value))}::text[]`;
            return p.negated ? `NOT (${expr})` : expr;
          }
          return `i.${p.field.column} ${p.negated ? '<> ALL' : '= ANY'}(${this.param(p.values.map((v) => v.value))}::${arrayType(p.values)})`;
        }
        const values = p.values;
        const field = p.field;
        const exists = this.customExists(
          field,
          () =>
            `v.value = ANY(${this.param(values.map((v) => v.value))}::${SIDE_CAST[field.type]}[])`,
        );
        return p.negated ? `NOT ${exists}` : exists;
      }
      case 'empty': {
        const expr =
          p.field.kind === 'system'
            ? p.field.type === 'labels'
              ? `cardinality(i.labels) = 0`
              : `i.${p.field.column} IS NULL`
            : `NOT ${this.customExists(p.field)}`;
        return p.negated ? `NOT (${expr})` : expr;
      }
      case 'history':
        return this.history(p);
    }
  }

  orderExpr(field: Field): string {
    if (field.kind === 'system') return `i.${field.column}`;
    return `(SELECT v.value FROM ${this.options.schema}.${SIDE_TABLE[field.type]} v WHERE v.item_id = i.id AND v.field_id = ${this.param(field.id)} LIMIT 1)`;
  }

  private systemCompare(field: SystemField, op: Comparison, value: Typed): string {
    const column = `i.${field.column}`;
    if (field.type === 'labels') {
      // Array containment, so a GIN index on labels serves it.
      const has = `i.labels @> ARRAY[${this.param(value.value)}::text]`;
      return op === '!=' ? `NOT (${has})` : has;
    }
    if (field.type === 'text' && (op === '~' || op === '!~')) {
      // Word search through the full-text index (ADR-011); custom text fields use ILIKE.
      const match = `to_tsvector('simple', ${column}) @@ plainto_tsquery('simple', ${this.param(String(value.value))})`;
      return op === '!~' ? `NOT (${match})` : match;
    }
    return this.valueCondition(column, field.type, op, value);
  }

  /** A condition on a side table's value column, cast to that column's type. */
  sideValue(column: string, field: CustomField, op: Comparison, value: Typed): string {
    if (op === '~' || op === '!~') return this.valueCondition(column, field.type, op, value);
    const v = value.type === 'datetime' ? value.value.toISOString() : value.value;
    return `${column} ${op} ${this.param(v)}::${SIDE_CAST[field.type]}`;
  }

  /** `column op value`: ILIKE for ~, and a cast that matches the column so indexes apply. */
  private valueCondition(column: string, _kind: string, op: string, value: Typed): string {
    if (op === '~' || op === '!~') {
      // Backslash, percent and underscore are LIKE metacharacters; escape them with a backslash.
      const escaped = String(value.value).replace(/[\\%_]/g, (c) => `\\${c}`);
      const pattern = `%${escaped}%`;
      return `${column} ${op === '~' ? 'ILIKE' : 'NOT ILIKE'} ${this.param(pattern)}`;
    }
    switch (value.type) {
      case 'number': {
        const cast =
          column === 'i.id' || column === 'i.parent_id'
            ? 'bigint'
            : column.endsWith('_id')
              ? 'int'
              : 'numeric';
        return `${column} ${op} ${this.param(value.value)}::${cast}`;
      }
      case 'datetime':
        return `${column} ${op} ${this.param(value.value.toISOString())}::timestamptz`;
      case 'date':
        return `${column} ${op} ${this.param(value.value)}::date`;
      case 'text':
        return `${column} ${op} ${this.param(value.value)}::text`;
    }
  }

  private customExists(field: CustomField, condition?: () => string): string {
    const head = `EXISTS (SELECT 1 FROM ${this.options.schema}.${SIDE_TABLE[field.type]} v WHERE v.item_id = i.id AND v.field_id = ${this.param(field.id)}`;
    return condition ? `${head} AND ${condition()})` : `${head})`;
  }

  /**
   * WAS x: some change set the value to or from x. CHANGED: a change exists. Predicates narrow
   * the change rows. The current value needs no extra clause because creating an item writes a
   * history row for each initial value, and a single EXISTS lets the planner start from the
   * history index when the value is rare. M1 refines WAS to a point-in-time reading.
   */
  private history(p: Extract<Pred, { kind: 'history' }>): string {
    const h = `${this.options.historyTable}`;
    const name = p.field.kind === 'system' ? (p.field.history ?? p.field.name) : `cf:${p.field.id}`;
    const conditions = [`h.item_id = i.id`, `h.field = ${this.param(name)}`];
    if (p.op === 'was' && p.values.length > 0) {
      const list = `ANY(${this.param(p.values.map((v) => String(v.value)))}::text[])`;
      conditions.push(`(h.to_value = ${list} OR h.from_value = ${list})`);
    }
    for (const pred of p.predicates) conditions.push(this.historyPredicate(pred));
    const expr = `EXISTS (SELECT 1 FROM ${h} h WHERE ${conditions.join(' AND ')})`;
    return p.negated ? `NOT ${expr}` : expr;
  }

  private historyPredicate(pred: HistoryPredicate): string {
    const texts = () => `ANY(${this.param(pred.values.map((v) => String(v.value)))}::text[])`;
    const at = (i: number) => {
      const v = pred.values[i];
      if (v?.type !== 'datetime') throw new Error(`${pred.kind} needs ${i + 1} date value(s)`);
      return `${this.param(v.value.toISOString())}::timestamptz`;
    };
    switch (pred.kind) {
      case 'from':
        return `h.from_value = ${texts()}`;
      case 'to':
        return `h.to_value = ${texts()}`;
      case 'by':
        return `h.actor_id = ANY(${this.param(pred.values.map((v) => v.value))}::int[])`;
      case 'before':
        return `h.at < ${at(0)}`;
      case 'after':
        return `h.at > ${at(0)}`;
      case 'on':
        return `h.at >= ${at(0)} AND h.at < ${at(0)} + interval '1 day'`;
      case 'during':
        return `h.at >= ${at(0)} AND h.at < ${at(1)}`;
    }
  }
}

function arrayType(values: Typed[]): string {
  const t = values[0]?.type;
  return t === 'number'
    ? 'numeric[]'
    : t === 'datetime'
      ? 'timestamptz[]'
      : t === 'date'
        ? 'date[]'
        : 'text[]';
}

type FieldPred = Extract<Pred, { kind: 'compare' }> | Extract<Pred, { kind: 'in' }>;
type CustomPred = FieldPred & { field: CustomField };

/** A custom-field condition that can drive the statement from its side table. */
interface Anchor {
  field: CustomField;
  /** Top-level conditions answered by the anchor row itself. */
  onValue: FieldPred[];
  /** Top-level `track = x` and `track IN (...)`, answered by the side row's copy of the track. */
  onTrack: FieldPred[];
  /** Everything else, evaluated on the joined item row. */
  rest: Pred[];
  order: 'created' | 'value';
  direction: 'asc' | 'desc';
  /**
   * The anchor condition can match several rows of one item (a multi-select or labels field
   * with several values), so only the item's lowest matching value is kept.
   */
  dedupe: boolean;
}

const POSITIVE_OPS: ReadonlySet<Comparison> = new Set(['=', '<', '<=', '>', '>=']);

function positive(p: Pred): p is FieldPred {
  if (p.kind === 'compare') return POSITIVE_OPS.has(p.op);
  return p.kind === 'in' && !p.negated;
}

function anchorable(p: Pred): p is CustomPred {
  return positive(p) && p.field.kind === 'custom';
}

/** At most one side row per item matches, so joining adds no duplicate rows. */
function oneRowPerItem(p: CustomPred): boolean {
  if (SINGLE_VALUED.has(p.field.type)) return true;
  return p.kind === 'compare' ? p.op === '=' : p.values.length === 1;
}

const isEquality = (p: CustomPred) => p.kind === 'in' || p.op === '=';

/**
 * Side rows carry the ticket's track (`space_id` in the spike schema) and `created_at` (ADR-008), so a query that filters a
 * custom field and sorts by creation date, or by that same field, can walk the side table's
 * `(field_id, value, created_at)` or `(field_id, created_at)` index in order and stop after one
 * page, instead of walking every item and probing the side table for each (M0-017 at 10M).
 */
function findAnchor(plan: Plan): Anchor | undefined {
  const sort = plan.orderBy[0];
  if (!plan.where || !sort || plan.orderBy.length !== 1) return undefined;
  const items = plan.where.kind === 'and' ? plan.where.items : [plan.where];
  let pick: CustomPred | undefined;
  let order: Anchor['order'];
  if (sort.field.kind === 'system' && sort.field.column === 'created_at') {
    order = 'created';
    // Prefer an equality, where one value's rows are already in creation order in the index,
    // then any condition with one row per item, then one that needs de-duplicating.
    const single = (p: Pred): p is CustomPred => anchorable(p) && oneRowPerItem(p);
    pick =
      items.find((p): p is CustomPred => single(p) && isEquality(p)) ??
      items.find(single) ??
      items.find(anchorable);
  } else if (sort.field.kind === 'custom' && SINGLE_VALUED.has(sort.field.type)) {
    order = 'value';
    const id = sort.field.id;
    pick = items.find((p): p is CustomPred => anchorable(p) && p.field.id === id);
  } else {
    return undefined;
  }
  if (!pick) return undefined;
  const field = pick.field;
  const anchor: Anchor = {
    field,
    onValue: [],
    onTrack: [],
    rest: [],
    order,
    direction: sort.direction,
    dedupe: !oneRowPerItem(pick),
  };
  for (const p of items) {
    const sameField = positive(p) && p.field.kind === 'custom' && p.field.id === field.id;
    if (p === pick || (SINGLE_VALUED.has(field.type) && sameField)) {
      anchor.onValue.push(p as FieldPred);
    } else if (
      positive(p) &&
      p.field.kind === 'system' &&
      p.field.column === 'space_id' &&
      (p.kind === 'in' || p.op === '=')
    ) {
      anchor.onTrack.push(p);
    } else {
      anchor.rest.push(p);
    }
  }
  return anchor;
}

function compileAnchored(a: Anchor, options: CompileOptions): CompiledQuery {
  const c = new Compiler(options);
  const cast = SIDE_CAST[a.field.type];
  const conditions = [`a.field_id = ${c.param(a.field.id)}`];
  for (const p of a.onValue) {
    conditions.push(
      p.kind === 'compare'
        ? c.sideValue('a.value', a.field, p.op, p.value)
        : `a.value = ANY(${c.param(p.values.map((v) => v.value))}::${cast}[])`,
    );
  }
  const first = a.onValue[0];
  if (a.dedupe && first) {
    // Keep one row per item: the one with the lowest matching value.
    const same =
      first.kind === 'compare'
        ? c.sideValue('b.value', a.field, first.op, first.value)
        : `b.value = ANY(${c.param(first.values.map((v) => v.value))}::${cast}[])`;
    conditions.push(
      `NOT EXISTS (SELECT 1 FROM ${options.schema}.${SIDE_TABLE[a.field.type]} b` +
        ` WHERE b.item_id = a.item_id AND b.field_id = a.field_id AND ${same} AND b.value < a.value)`,
    );
  }
  for (const p of a.onTrack) {
    conditions.push(
      p.kind === 'compare'
        ? `a.space_id = ${c.param(p.value.value)}::int`
        : `a.space_id = ANY(${c.param(p.values.map((v) => v.value))}::int[])`,
    );
  }
  if (options.allowedTrackIds !== null) {
    conditions.push(`a.space_id = ANY(${c.param(options.allowedTrackIds)}::int[])`);
  }
  const rest = a.rest.map((p) => c.pred(p));
  const dir = a.direction.toUpperCase();
  const order =
    a.order === 'created'
      ? `a.created_at ${dir}, a.item_id DESC`
      : `a.value ${dir}, a.item_id DESC`;
  const join = rest.length > 0 ? `\nJOIN ${options.schema}.item i ON i.id = a.item_id` : '';
  const text =
    `SELECT a.item_id AS id FROM ${options.schema}.${SIDE_TABLE[a.field.type]} a${join}` +
    `\nWHERE ${[...conditions, ...rest].join('\n  AND ')}` +
    `\nORDER BY ${order}` +
    `\nLIMIT ${c.param(options.limit)}` +
    (options.offset ? ` OFFSET ${c.param(options.offset)}` : '');
  return { text, params: c.params };
}
