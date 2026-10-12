/** Character range in the query text, for error messages and editor highlighting. */
export interface Span {
  start: number;
  end: number;
}

/** A field reference: a plain name, a quoted name, or a custom field by number (`cf[123]`). */
export interface FieldRef {
  name: string;
  /** Set for `cf[n]`; `name` is then "cf". */
  custom?: number;
  span: Span;
}

export type Value =
  | { kind: 'string'; value: string; span: Span }
  | { kind: 'number'; value: number; span: Span }
  /** A bare word such as `Done`, `kalo`, `ABC-12` or `2026-01-31`; typed by the resolver. */
  | { kind: 'word'; value: string; span: Span }
  /** A relative duration such as `-1w` or `3d`. */
  | { kind: 'duration'; value: string; span: Span }
  | { kind: 'function'; name: string; args: Value[]; span: Span }
  | { kind: 'empty'; span: Span };

export type CompareOp = '=' | '!=' | '<' | '<=' | '>' | '>=' | '~' | '!~';

export type PredicateKind = 'from' | 'to' | 'by' | 'before' | 'after' | 'on' | 'during';

/** Qualifier on a history clause: `CHANGED FROM x TO y BY u AFTER d`. */
export interface Predicate {
  kind: PredicateKind;
  values: Value[];
  span: Span;
}

export type Clause =
  | { kind: 'compare'; field: FieldRef; op: CompareOp; value: Value; span: Span }
  | { kind: 'in'; field: FieldRef; negated: boolean; values: Value[]; span: Span }
  | { kind: 'empty'; field: FieldRef; negated: boolean; span: Span }
  | {
      kind: 'was';
      field: FieldRef;
      negated: boolean;
      values: Value[];
      predicates: Predicate[];
      span: Span;
    }
  | { kind: 'changed'; field: FieldRef; predicates: Predicate[]; span: Span };

export type Expr =
  | { kind: 'and'; items: Expr[]; span: Span }
  | { kind: 'or'; items: Expr[]; span: Span }
  | { kind: 'not'; expr: Expr; span: Span }
  | Clause;

export interface OrderBy {
  field: FieldRef;
  direction: 'asc' | 'desc';
  span: Span;
}

export interface Query {
  where: Expr | null;
  orderBy: OrderBy[];
}

/** Walks every clause in an expression, depth first. */
export function* clauses(expr: Expr | null): Generator<Clause> {
  if (!expr) return;
  switch (expr.kind) {
    case 'and':
    case 'or':
      for (const item of expr.items) yield* clauses(item);
      break;
    case 'not':
      yield* clauses(expr.expr);
      break;
    default:
      yield expr;
  }
}
