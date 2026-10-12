import type { Clause, Expr, FieldRef, Predicate, Query, Span, Value } from './ast';
import {
  type Catalogue,
  type CustomType,
  type Field,
  lookupField,
  type SystemType,
} from './fields';
import { QueryError } from './lexer';

/** What the query needs from its surroundings. */
export interface ResolveContext {
  currentUserId: number | null;
  now: Date;
}

/** A value with a Postgres-ready type. */
export type Typed =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'datetime'; value: Date }
  | { type: 'date'; value: string };

export type Comparison = '=' | '!=' | '<' | '<=' | '>' | '>=' | '~' | '!~';

export type Pred =
  | { kind: 'and'; items: Pred[] }
  | { kind: 'or'; items: Pred[] }
  | { kind: 'not'; pred: Pred }
  | { kind: 'compare'; field: Field; op: Comparison; value: Typed }
  | { kind: 'in'; field: Field; negated: boolean; values: Typed[] }
  | { kind: 'empty'; field: Field; negated: boolean }
  | {
      kind: 'history';
      field: Field;
      op: 'was' | 'changed';
      negated: boolean;
      values: Typed[];
      predicates: HistoryPredicate[];
    };

export interface HistoryPredicate {
  kind: Predicate['kind'];
  values: Typed[];
}

export interface Plan {
  where: Pred | null;
  orderBy: { field: Field; direction: 'asc' | 'desc' }[];
}

type ValueType = SystemType | CustomType;

const COMPARABLE: ReadonlySet<ValueType> = new Set(['number', 'datetime', 'date']);
const TEXTUAL: ReadonlySet<ValueType> = new Set(['text']);
const DURATION = /^([+-]?)(\d+)([mhdwMy])$/;

/** Checks every field and operator against the catalogue and types every value. */
export function resolveQuery(query: Query, catalogue: Catalogue, ctx: ResolveContext): Plan {
  const r = new Resolver(catalogue, ctx);
  return {
    where: query.where ? r.expr(query.where) : null,
    orderBy: query.orderBy.map((o) => ({ field: r.field(o.field), direction: o.direction })),
  };
}

class Resolver {
  constructor(
    private readonly catalogue: Catalogue,
    private readonly ctx: ResolveContext,
  ) {}

  expr(e: Expr): Pred {
    switch (e.kind) {
      case 'and':
        return { kind: 'and', items: e.items.map((i) => this.expr(i)) };
      case 'or':
        return { kind: 'or', items: e.items.map((i) => this.expr(i)) };
      case 'not':
        return { kind: 'not', pred: this.expr(e.expr) };
      default:
        return this.clause(e);
    }
  }

  field(ref: FieldRef): Field {
    const field = lookupField(this.catalogue, ref);
    if (!field) {
      const label = ref.custom !== undefined ? `cf[${ref.custom}]` : `"${ref.name}"`;
      throw fail(`Unknown field ${label}`, ref.span);
    }
    return field;
  }

  private clause(c: Clause): Pred {
    const field = this.field(c.field);
    switch (c.kind) {
      case 'compare': {
        if (c.op === '~' || c.op === '!~') {
          if (!TEXTUAL.has(field.type))
            throw fail(`"${field.name}" is not a text field; ~ needs one`, c.span);
        } else if (c.op !== '=' && c.op !== '!=' && !COMPARABLE.has(field.type)) {
          throw fail(
            `"${field.name}" cannot be compared with ${c.op}; it is not a number or date`,
            c.span,
          );
        }
        if (c.value.kind === 'empty') {
          if (c.op !== '=' && c.op !== '!=') {
            throw fail('EMPTY is only allowed with =, != and IS', c.value.span);
          }
          return { kind: 'empty', field, negated: c.op === '!=' };
        }
        return { kind: 'compare', field, op: c.op, value: this.typed(field, c.value) };
      }
      case 'in':
        if (TEXTUAL.has(field.type))
          throw fail(`IN cannot be used on the text field "${field.name}"`, c.span);
        return {
          kind: 'in',
          field,
          negated: c.negated,
          values: c.values.map((v) => this.typed(field, v)),
        };
      case 'empty':
        return { kind: 'empty', field, negated: c.negated };
      case 'was':
      case 'changed': {
        if (field.kind === 'system' && !field.history) {
          throw fail(`"${field.name}" keeps no change history`, c.span);
        }
        const values = c.kind === 'was' ? c.values.map((v) => this.typed(field, v)) : [];
        return {
          kind: 'history',
          field,
          op: c.kind,
          negated: c.kind === 'was' ? c.negated : false,
          values,
          predicates: c.predicates.map((p) => this.predicate(field, p)),
        };
      }
    }
  }

  private predicate(field: Field, p: Predicate): HistoryPredicate {
    switch (p.kind) {
      case 'from':
      case 'to':
        return { kind: p.kind, values: p.values.map((v) => this.typed(field, v)) };
      case 'by':
        return { kind: 'by', values: p.values.map((v) => this.user(v)) };
      case 'before':
      case 'after':
      case 'on':
      case 'during':
        return { kind: p.kind, values: p.values.map((v) => this.datetime(v)) };
    }
  }

  /** Types a value for a field; the field's type decides how a bare word is read. */
  private typed(field: Field, v: Value): Typed {
    if (v.kind === 'empty') throw fail('EMPTY is only allowed with =, != and IS', v.span);
    switch (field.type) {
      case 'number':
        return { type: 'number', value: this.number(v) };
      case 'datetime':
        return { type: 'datetime', value: this.datetime(v).value };
      case 'date':
        return { type: 'date', value: this.datetime(v).value.toISOString().slice(0, 10) };
      case 'user':
        return this.user(v);
      case 'track': {
        if (v.kind === 'number') return { type: 'number', value: v.value };
        const key = this.text(v);
        const id = this.catalogue.trackKeys[key.toUpperCase()];
        if (id === undefined) throw fail(`Unknown track "${key}"`, v.span);
        return { type: 'number', value: id };
      }
      default:
        return { type: 'text', value: this.text(v) };
    }
  }

  private text(v: Value): string {
    switch (v.kind) {
      case 'string':
      case 'word':
      case 'duration':
        return v.value;
      case 'number':
        return String(v.value);
      case 'function':
        throw fail(`${v.name}() does not return text`, v.span);
      case 'empty':
        throw fail('EMPTY is not a text value', v.span);
    }
  }

  private number(v: Value): number {
    if (v.kind === 'number') return v.value;
    if (v.kind === 'word' && /^[+-]?\d+(\.\d+)?$/.test(v.value)) return Number(v.value);
    throw fail('Expected a number', v.span);
  }

  private user(v: Value): Typed {
    if (v.kind === 'function') {
      if (v.name.toLowerCase() === 'currentuser') {
        if (this.ctx.currentUserId === null)
          throw fail('currentUser() needs a signed-in user', v.span);
        return { type: 'number', value: this.ctx.currentUserId };
      }
      throw fail(`${v.name}() does not return a user`, v.span);
    }
    if (v.kind === 'number') return { type: 'number', value: v.value };
    if (v.kind === 'word' && /^\d+$/.test(v.value))
      return { type: 'number', value: Number(v.value) };
    throw fail('Expected a user ID or currentUser()', v.span);
  }

  private datetime(v: Value): { type: 'datetime'; value: Date } {
    const now = this.ctx.now;
    switch (v.kind) {
      case 'duration':
        return { type: 'datetime', value: shift(now, v.value, v.span) };
      case 'string':
      case 'word': {
        const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v.value);
        if (m) {
          const [year, month, day, hour, minute] = [m[1], m[2], m[3], m[4] ?? '0', m[5] ?? '0'].map(
            Number,
          ) as [number, number, number, number, number];
          const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
          // JavaScript rolls an invalid day or month into the next period; refuse that.
          const valid =
            date.getUTCFullYear() === year &&
            date.getUTCMonth() + 1 === month &&
            date.getUTCDate() === day &&
            date.getUTCHours() === hour &&
            date.getUTCMinutes() === minute;
          if (!valid) throw fail(`"${v.value}" is not a valid date`, v.span);
          return { type: 'datetime', value: date };
        }
        if (DURATION.test(v.value)) return { type: 'datetime', value: shift(now, v.value, v.span) };
        throw fail(
          `"${v.value}" is not a date (use YYYY-MM-DD, a duration like -1w, or a date function)`,
          v.span,
        );
      }
      case 'function':
        return { type: 'datetime', value: this.dateFunction(v) };
      default:
        throw fail('Expected a date', v.span);
    }
  }

  private dateFunction(v: Extract<Value, { kind: 'function' }>): Date {
    const name = v.name.toLowerCase();
    const arg = v.args[0];
    const offset = arg ? shift(new Date(0), durationText(arg), arg.span).getTime() : 0;
    const now = this.ctx.now;
    const base = (d: Date) => new Date(d.getTime() + offset);
    switch (name) {
      case 'now':
        return base(now);
      case 'startofday':
        return base(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())));
      case 'endofday':
        return base(
          new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1) - 1),
        );
      case 'startofweek': {
        const day = (now.getUTCDay() + 6) % 7; // Monday first
        return base(
          new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day)),
        );
      }
      case 'endofweek': {
        const day = (now.getUTCDay() + 6) % 7;
        return base(
          new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - day + 7) - 1,
          ),
        );
      }
      case 'startofmonth':
        return base(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
      case 'endofmonth':
        return base(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1) - 1));
      case 'startofyear':
        return base(new Date(Date.UTC(now.getUTCFullYear(), 0, 1)));
      case 'endofyear':
        return base(new Date(Date.UTC(now.getUTCFullYear() + 1, 0, 1) - 1));
      default:
        throw fail(`Unknown date function ${v.name}()`, v.span);
    }
  }
}

function durationText(v: Value): string {
  if (v.kind === 'duration') return v.value;
  if (v.kind === 'string' || v.kind === 'word') return v.value;
  if (v.kind === 'number') return `${v.value}d`;
  throw fail('Expected a duration such as -1d', v.span);
}

/** Applies a duration such as -1w, +3d, 2h, 30m, 1M (month) or 1y to a date. */
function shift(from: Date, duration: string, span: Span): Date {
  const m = DURATION.exec(duration);
  if (!m) throw fail(`"${duration}" is not a duration (examples: -1w, 3d, 2h, 30m)`, span);
  const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
  const d = new Date(from.getTime());
  switch (m[3]) {
    case 'm':
      d.setUTCMinutes(d.getUTCMinutes() + n);
      break;
    case 'h':
      d.setUTCHours(d.getUTCHours() + n);
      break;
    case 'd':
      d.setUTCDate(d.getUTCDate() + n);
      break;
    case 'w':
      d.setUTCDate(d.getUTCDate() + 7 * n);
      break;
    case 'M':
      d.setUTCMonth(d.getUTCMonth() + n);
      break;
    case 'y':
      d.setUTCFullYear(d.getUTCFullYear() + n);
      break;
  }
  return d;
}

function fail(message: string, span: Span): QueryError {
  return new QueryError(message, span.start, Math.max(1, span.end - span.start));
}
