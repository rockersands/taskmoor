import type { Expr, FieldRef, Predicate, Query, Value } from './ast';

/** Writes a query back as text in a canonical form: keywords upper case, strings double-quoted. */
export function printQuery(query: Query): string {
  const parts: string[] = [];
  if (query.where) parts.push(printExpr(query.where, 'top'));
  if (query.orderBy.length > 0) {
    parts.push(
      `ORDER BY ${query.orderBy.map((o) => `${printField(o.field)} ${o.direction.toUpperCase()}`).join(', ')}`,
    );
  }
  return parts.join(' ');
}

/** Binding strength; `top` is the query itself, which never needs parentheses. */
const LEVEL = { top: -1, or: 0, and: 1, not: 2 } as const;

function printExpr(expr: Expr, parent: keyof typeof LEVEL): string {
  switch (expr.kind) {
    case 'or':
    case 'and': {
      const text = expr.items
        .map((e) => printExpr(e, expr.kind))
        .join(` ${expr.kind.toUpperCase()} `);
      return wrapIfNeeded(text, expr.kind, parent);
    }
    case 'not': {
      const inner = printExpr(expr.expr, 'not');
      return `NOT ${inner}`;
    }
    case 'compare':
      return `${printField(expr.field)} ${expr.op} ${printValue(expr.value)}`;
    case 'in':
      return `${printField(expr.field)} ${expr.negated ? 'NOT IN' : 'IN'} ${printList(expr.values)}`;
    case 'empty':
      return `${printField(expr.field)} ${expr.negated ? 'IS NOT EMPTY' : 'IS EMPTY'}`;
    case 'was': {
      const values =
        expr.values.length === 1 && expr.values[0]
          ? printValue(expr.values[0])
          : `IN ${printList(expr.values)}`;
      const head = expr.negated ? 'WAS NOT' : 'WAS';
      return [
        `${printField(expr.field)} ${head} ${values}`,
        ...expr.predicates.map(printPredicate),
      ].join(' ');
    }
    case 'changed':
      return [`${printField(expr.field)} CHANGED`, ...expr.predicates.map(printPredicate)].join(
        ' ',
      );
  }
}

/** A list, or a bare function call when the list comes from one (`IN openSprints()`). */
function printList(values: Value[]): string {
  const only = values.length === 1 ? values[0] : undefined;
  if (only?.kind === 'function') return printValue(only);
  return `(${values.map(printValue).join(', ')})`;
}

function wrapIfNeeded(text: string, kind: 'and' | 'or', parent: keyof typeof LEVEL): string {
  // AND binds tighter than OR; NOT tighter than both. Parenthesise when a looser operator sits
  // under a tighter one, or when the same operator nests (to keep the tree shape on re-parse).
  if (LEVEL[kind] < LEVEL[parent] || kind === parent) return `(${text})`;
  return text;
}

function printPredicate(p: Predicate): string {
  const values =
    p.values.length === 1 && p.values[0]
      ? printValue(p.values[0])
      : `(${p.values.map(printValue).join(', ')})`;
  return `${p.kind.toUpperCase()} ${values}`;
}

export function printField(field: FieldRef): string {
  if (field.custom !== undefined) return `cf[${field.custom}]`;
  if (field.property) {
    const { key, path } = field.property;
    const plainKey = /^[\p{L}\p{N}_-]+$/u.test(key) && !/^\d/.test(key) ? key : quote(key);
    return `${field.name}[${plainKey}]${path === '' ? '' : `.${path}`}`;
  }
  return /^[\p{L}_][\p{L}\p{N}_.]*$/u.test(field.name) && !isReservedWord(field.name)
    ? field.name
    : quote(field.name);
}

function isReservedWord(name: string): boolean {
  return /^(and|or|not|order|in|is|was|changed|from|to|by|before|after|on|during|empty|null)$/i.test(
    name,
  );
}

export function printValue(value: Value): string {
  switch (value.kind) {
    case 'string':
      return quote(value.value);
    case 'number':
      return String(value.value);
    case 'word':
    case 'duration':
      return value.value;
    case 'function':
      return `${value.name}(${value.args.map(printValue).join(', ')})`;
    case 'empty':
      return 'EMPTY';
  }
}

function quote(text: string): string {
  return `"${text.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}
