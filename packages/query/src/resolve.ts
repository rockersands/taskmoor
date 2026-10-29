import type { Clause, Expr, FieldRef, Predicate, Query, Span, Value } from './ast';
import {
  addWall,
  boundary,
  instantOf,
  knownTimeZone,
  localDate,
  type Period,
  parseIncrement,
  wallClock,
} from './dates';
import { nativeFunctionName } from './dialect';
import { type Catalogue, type Field, findField, type OperatorFamily, takes } from './fields';
import {
  argumentAt,
  arity,
  type FunctionSpec,
  fieldTakes,
  findFunction,
  RESULT_NAMES,
} from './functions';
import { QueryError } from './lexer';

/** What the query needs from its surroundings. */
export interface ResolveContext {
  currentUserId: number | null;
  now: Date;
  /**
   * The person's time zone (an IANA name): absolute dates and date functions are read on its
   * wall clock (QRY-006). UTC when absent or unknown.
   */
  timeZone?: string | null;
  /** The first day of the week, 0 (Sunday, the default: weeks end on Saturday) to 6. */
  weekStart?: number;
  /** When the person signed in this time and the time before (`currentLogin()`, `lastLogin()`). */
  logins?: { current: Date | null; last: Date | null };
}

/** A value with a Postgres-ready type. */
export type Typed =
  | { type: 'text'; value: string }
  | { type: 'number'; value: number }
  | { type: 'datetime'; value: Date }
  | { type: 'date'; value: string }
  /**
   * A sprint relative to the board or team (QRY-013): `@current` the active sprint, `@next` the
   * first future one, `@previous` the last completed one. Only the sprint field takes these.
   */
  | { type: 'token'; value: SprintToken }
  /**
   * A function only the database can answer (M1-038): its native name and typed arguments.
   * People are numbers or text (as `user` values), dates `datetime`, the rest text or numbers.
   */
  | { type: 'call'; fn: string; args: Typed[] };

export type Comparison = '=' | '!=' | '<' | '<=' | '>' | '>=' | '~' | '!~';

/** The relative sprint tokens (QRY-013), without the `@`. */
export const SPRINT_TOKENS = ['current', 'next', 'previous'] as const;
export type SprintToken = (typeof SPRINT_TOKENS)[number];

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
      /** `WAS EMPTY`, alone or in a list: a time the field had no value counts. */
      empty?: boolean;
      /** In a fixed order (by kind), so the order they were written in does not matter. */
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

const DURATION = /^([+-]?)(\d+)([mhdwMy])$/;

/** Why a field does not take an operator, naming both (QRY-002 (1)). */
function refusal(field: Field, family: OperatorFamily, op: string): string {
  const name = field.kind === 'custom' ? `"${field.name}" (cf[${field.id}])` : `"${field.name}"`;
  if (field.type === 'attachments') return `${name} only takes IS EMPTY and IS NOT EMPTY`;
  switch (family) {
    case 'contains':
      return `${name} is not a text field; ${op} needs one`;
    case 'order':
      return `${name} cannot be compared with ${op}; its values have no order`;
    case 'history':
      return `${name} keeps no change history`;
    default:
      return field.type === 'text'
        ? `${name} is a text field: use ~ or !~ to search it, not ${op}`
        : `${name} does not take ${op}`;
  }
}

/** Checks every field and operator against the catalogue and types every value. */
export function resolveQuery(query: Query, catalogue: Catalogue, ctx: ResolveContext): Plan {
  const r = new Resolver(catalogue, ctx);
  return {
    where: query.where ? r.expr(query.where) : null,
    orderBy: query.orderBy.map((o) => ({ field: r.field(o.field), direction: o.direction })),
  };
}

type Call = Extract<Value, { kind: 'function' }>;

const PERIODS: Record<string, { edge: 'start' | 'end'; period: Period }> = {
  startofday: { edge: 'start', period: 'day' },
  startofweek: { edge: 'start', period: 'week' },
  startofmonth: { edge: 'start', period: 'month' },
  startofyear: { edge: 'start', period: 'year' },
  endofday: { edge: 'end', period: 'day' },
  endofweek: { edge: 'end', period: 'week' },
  endofmonth: { edge: 'end', period: 'month' },
  endofyear: { edge: 'end', period: 'year' },
};

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** `first` to `fifth`, then `6th`, `21st`, `51st`, `112th`. */
function ordinal(n: number): string {
  const word = ['first', 'second', 'third', 'fourth', 'fifth'][n - 1];
  if (word) return word;
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${suffix}`;
}

class Resolver {
  private readonly timeZone: string;
  private readonly weekStart: number;

  constructor(
    private readonly catalogue: Catalogue,
    private readonly ctx: ResolveContext,
  ) {
    this.timeZone = ctx.timeZone && knownTimeZone(ctx.timeZone) ? ctx.timeZone : 'UTC';
    this.weekStart = ctx.weekStart ?? 0;
  }

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
    const found = findField(this.catalogue, ref);
    if ('field' in found) return found.field;
    if ('ambiguous' in found) {
      const ids = found.ambiguous.map((f) => `cf[${f.id}]`).join(', ');
      throw fail(
        `Several custom fields are called "${ref.name}" (${ids}); name one by its id`,
        ref.span,
      );
    }
    const label = ref.custom !== undefined ? `cf[${ref.custom}]` : `"${ref.name}"`;
    throw fail(`Unknown field ${label}`, ref.span);
  }

  /** Refuses an operator the field's type does not take. */
  private needs(field: Field, family: OperatorFamily, op: string, span: Span): void {
    if (!takes(field, family)) throw fail(refusal(field, family, op), span);
  }

  private clause(c: Clause): Pred {
    const field = this.field(c.field);
    switch (c.kind) {
      case 'compare': {
        if (c.value.kind === 'empty') {
          if (c.op !== '=' && c.op !== '!=') {
            throw fail('EMPTY is only allowed with =, != and IS', c.value.span);
          }
          this.needs(field, 'empty', c.op === '=' ? 'IS EMPTY' : 'IS NOT EMPTY', c.span);
          return { kind: 'empty', field, negated: c.op === '!=' };
        }
        const family: OperatorFamily =
          c.op === '~' || c.op === '!~'
            ? 'contains'
            : c.op === '=' || c.op === '!='
              ? 'equality'
              : 'order';
        this.needs(field, family, c.op, c.span);
        if (c.value.kind === 'function' && this.spec(c.value).many) {
          throw fail(
            `${c.value.name}() returns several values: use IN or NOT IN, not ${c.op}`,
            c.value.span,
          );
        }
        return { kind: 'compare', field, op: c.op, value: this.typed(field, c.value) };
      }
      case 'in':
        this.needs(field, 'list', c.negated ? 'NOT IN' : 'IN', c.span);
        return {
          kind: 'in',
          field,
          negated: c.negated,
          values: c.values.map((v) => this.typed(field, v)),
        };
      case 'empty':
        this.needs(field, 'empty', c.negated ? 'IS NOT' : 'IS', c.span);
        return { kind: 'empty', field, negated: c.negated };
      case 'was':
      case 'changed': {
        this.needs(field, 'history', c.kind === 'was' ? 'WAS' : 'CHANGED', c.span);
        const given = c.kind === 'was' ? c.values : [];
        const empty = given.some((v) => v.kind === 'empty');
        const values = given.filter((v) => v.kind !== 'empty').map((v) => this.typed(field, v));
        const order = ['from', 'to', 'by', 'after', 'before', 'on', 'during'];
        return {
          kind: 'history',
          field,
          op: c.kind,
          negated: c.kind === 'was' ? c.negated : false,
          values,
          ...(empty ? { empty: true } : {}),
          predicates: c.predicates
            .map((p) => this.predicate(field, p))
            .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind)),
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
    if (v.kind === 'function') {
      const spec = this.spec(v);
      if (!fieldTakes(field, spec.returns)) {
        const name =
          field.kind === 'custom' ? `"${field.name}" (cf[${field.id}])` : `"${field.name}"`;
        throw fail(
          `${v.name}() returns ${RESULT_NAMES[spec.returns]}, which ${name} does not take`,
          v.span,
        );
      }
      if (spec.returns === 'date') {
        const at = this.dateFunction(v, spec);
        return field.type === 'date'
          ? { type: 'date', value: localDate(at, this.timeZone) }
          : { type: 'datetime', value: at };
      }
      return this.call(v, spec);
    }
    // A bare word with an @ is a relative sprint token (QRY-013); quoted, it is a plain name.
    if (v.kind === 'word' && v.value.startsWith('@')) return this.token(field, v);
    switch (field.type) {
      case 'number':
        return { type: 'number', value: this.number(v) };
      case 'datetime':
        return { type: 'datetime', value: this.datetime(v).value };
      case 'date':
        return { type: 'date', value: localDate(this.datetime(v).value, this.timeZone) };
      case 'user':
        return this.user(v);
      case 'key':
        // A key (ABC-12) or a ticket id.
        if (v.kind === 'number') return { type: 'number', value: v.value };
        return { type: 'text', value: this.text(v).toUpperCase() };
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

  /** `@current`, `@next` or `@previous` for the sprint field; anything else is refused. */
  private token(field: Field, v: Extract<Value, { kind: 'word' }>): Typed {
    const name = v.value.slice(1).toLowerCase();
    const token = SPRINT_TOKENS.find((t) => t === name);
    if (!token) {
      throw fail(`Unknown sprint token "${v.value}": use @current, @next or @previous`, v.span);
    }
    if (field.type !== 'sprint') {
      const label =
        field.kind === 'custom' ? `"${field.name}" (cf[${field.id}])` : `"${field.name}"`;
      throw fail(`@${token} is a sprint, which ${label} does not take`, v.span);
    }
    return { type: 'token', value: token };
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
      const spec = this.spec(v);
      if (spec.returns !== 'user') throw fail(`${v.name}() does not return a user`, v.span);
      return this.call(v, spec);
    }
    if (v.kind === 'number') return { type: 'number', value: v.value };
    if (v.kind === 'word' && /^\d+$/.test(v.value))
      return { type: 'number', value: Number(v.value) };
    // A name or an email; the compiler finds the person.
    if (v.kind === 'word' || v.kind === 'string') return { type: 'text', value: v.value };
    throw fail('Expected a person, a user ID or currentUser()', v.span);
  }

  private datetime(v: Value): { type: 'datetime'; value: Date } {
    const now = this.ctx.now;
    switch (v.kind) {
      case 'duration':
        return { type: 'datetime', value: shift(now, v.value, v.span) };
      case 'string':
      case 'word': {
        // yyyy-MM-dd or yyyy/MM/dd, with an optional HH:mm (section 1.4).
        const m = /^(\d{4})[-/](\d{2})[-/](\d{2})(?:[ T](\d{2}):(\d{2}))?$/.exec(v.value);
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
          // Read on the person's wall clock (QRY-006).
          const at = instantOf({ year, month, day, hour, minute, second: 0, ms: 0 }, this.timeZone);
          return { type: 'datetime', value: at };
        }
        if (DURATION.test(v.value)) return { type: 'datetime', value: shift(now, v.value, v.span) };
        throw fail(
          `"${v.value}" is not a date (use YYYY-MM-DD, a duration like -1w, or a date function)`,
          v.span,
        );
      }
      case 'function': {
        const spec = this.spec(v);
        if (spec.returns !== 'date') throw fail(`${v.name}() does not return a date`, v.span);
        return { type: 'datetime', value: this.dateFunction(v, spec) };
      }
      default:
        throw fail('Expected a date', v.span);
    }
  }

  /** The function a call names, in either vocabulary, with its arguments counted (QRY-004 (3)). */
  private spec(v: Call): FunctionSpec {
    const spec = findFunction(nativeFunctionName(v.name) ?? v.name);
    if (!spec) throw fail(`Unknown function ${v.name}()`, v.span);
    const [min, max] = arity(spec);
    if (v.args.length < min) {
      const missing = argumentAt(spec, v.args.length);
      throw fail(
        `${v.name}() needs its ${missing.name} (the ${ordinal(v.args.length + 1)} argument)`,
        v.span,
      );
    }
    if (v.args.length > max) {
      const extra = v.args[max] as Value;
      throw fail(
        max === 0
          ? `${v.name}() takes no arguments`
          : `${v.name}() takes at most ${plural(max, 'argument')}; the ${ordinal(max + 1)} is one too many`,
        extra.span,
      );
    }
    return spec;
  }

  /** A function the database answers: its native name and its arguments typed. */
  private call(v: Call, spec: FunctionSpec): Typed {
    if (spec.name === 'currentUser') {
      if (this.ctx.currentUserId === null) {
        throw fail(`${v.name}() needs a signed-in user`, v.span);
      }
      return { type: 'number', value: this.ctx.currentUserId };
    }
    return {
      type: 'call',
      fn: spec.name,
      args: v.args.map((a, i) => this.argument(v, spec, i, a)),
    };
  }

  /** One argument, read as the function's signature says. */
  private argument(v: Call, spec: FunctionSpec, index: number, a: Value): Typed {
    const what = argumentAt(spec, index);
    if (a.kind === 'empty') throw fail(`${v.name}(): its ${what.name} cannot be EMPTY`, a.span);
    if (a.kind === 'function' && what.kind !== 'user' && what.kind !== 'date') {
      throw fail(`${v.name}(): its ${what.name} cannot be a function`, a.span);
    }
    switch (what.kind) {
      case 'user':
        return this.user(a);
      case 'date':
        return this.datetime(a);
      case 'increment': {
        const text = durationText(a);
        if (!parseIncrement(text)) {
          throw fail(`${v.name}(): its ${what.name} must be a duration such as -1d or +2w`, a.span);
        }
        return { type: 'text', value: text };
      }
      case 'ticket':
        if (a.kind === 'number') return { type: 'number', value: a.value };
        return { type: 'text', value: this.text(a).toUpperCase() };
      case 'track': {
        if (a.kind === 'number') return { type: 'number', value: a.value };
        const key = this.text(a);
        const id = this.catalogue.trackKeys[key.toUpperCase()];
        if (id === undefined) throw fail(`Unknown track "${key}"`, a.span);
        return { type: 'number', value: id };
      }
      case 'text':
        return { type: 'text', value: this.text(a) };
    }
  }

  /** A date function, on the person's wall clock (QRY-006). */
  private dateFunction(v: Call, spec: FunctionSpec): Date {
    const now = this.ctx.now;
    switch (spec.name) {
      case 'now': {
        const arg = v.args[0];
        if (!arg) return now;
        const increment = parseIncrement(durationText(arg));
        if (!increment) {
          throw fail(`${v.name}(): its increment must be a duration such as -1d or +2w`, arg.span);
        }
        const cal = this.timeZone;
        return instantOf(addWall(wallClock(now, cal), increment.n, increment.unit), cal);
      }
      case 'currentLogin':
        return this.ctx.logins?.current ?? now;
      case 'lastLogin':
        // Without an earlier sign-in, the one before is this one.
        return this.ctx.logins?.last ?? this.ctx.logins?.current ?? now;
    }
    const period = PERIODS[spec.name.toLowerCase()];
    if (!period) throw fail(`Unknown date function ${v.name}()`, v.span);
    const arg = v.args[0];
    const increment = arg ? parseIncrement(durationText(arg)) : undefined;
    if (arg && !increment) {
      throw fail(`${v.name}(): its increment must be a duration such as -1d or +2w`, arg.span);
    }
    return boundary(now, period.edge, period.period, increment, {
      timeZone: this.timeZone,
      weekStart: this.weekStart,
    });
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
