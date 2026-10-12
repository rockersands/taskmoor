import type { CustomField, Field, SystemField } from './fields';
import type { Comparison, HistoryPredicate, Plan, Pred, Typed } from './resolve';

export interface CompileOptions {
  /** Schema holding `item` and the side tables. */
  schema: string;
  /** Change history table with (item_id, at, actor_id, field, from_value, to_value). */
  historyTable: string;
  /** Spaces the caller may see; `null` means every space (admin or a public site). */
  allowedSpaceIds: readonly number[] | null;
  limit: number;
  offset?: number;
}

export interface CompiledQuery {
  text: string;
  params: unknown[];
}

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
  const c = new Compiler(options);
  const conditions: string[] = [];
  if (options.allowedSpaceIds !== null) {
    conditions.push(`i.space_id = ANY(${c.param(options.allowedSpaceIds)}::int[])`);
  }
  if (plan.where) conditions.push(c.pred(plan.where));
  const order = plan.orderBy.map(
    (o) => `${c.orderExpr(o.field)} ${o.direction.toUpperCase()} NULLS LAST`,
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
        return this.customExists(field, () =>
          this.valueCondition('v.value', field.type, p.op, p.value),
        );
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
        const exists = this.customExists(
          p.field,
          () => `v.value = ANY(${this.param(values.map((v) => v.value))}::${arrayType(values)})`,
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
      const has = `${this.param(value.value)}::text = ANY(i.labels)`;
      return op === '!=' ? `NOT (${has})` : has;
    }
    return this.valueCondition(column, field.type, op, value);
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
   * WAS x: the value is x now, or some change set it to or from x. CHANGED: a change exists.
   * Predicates narrow the change rows. Good enough for the prototype; M1 refines WAS to a
   * point-in-time reading of the history.
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
    let expr = `EXISTS (SELECT 1 FROM ${h} h WHERE ${conditions.join(' AND ')})`;
    if (p.op === 'was' && p.values.length > 0 && p.predicates.length === 0) {
      // The current value counts as well.
      const current =
        p.field.kind === 'system'
          ? `i.${p.field.column}::text = ANY(${this.param(p.values.map((v) => String(v.value)))}::text[])`
          : this.customExists(
              p.field,
              () =>
                `v.value::text = ANY(${this.param(p.values.map((v) => String(v.value)))}::text[])`,
            );
      expr = `(${expr} OR ${current})`;
    }
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
