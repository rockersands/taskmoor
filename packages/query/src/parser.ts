import type {
  Clause,
  CompareOp,
  Expr,
  FieldRef,
  OrderBy,
  Predicate,
  PredicateKind,
  Query,
  Span,
  Value,
} from './ast';
import { lineIndex, QueryError, type RawDiagnostic, scan, type Token } from './lexer';

const PREDICATES: readonly PredicateKind[] = [
  'from',
  'to',
  'by',
  'before',
  'after',
  'on',
  'during',
];
const DURATION = /^[+-]?\d+[mhdwMy]$/;
/** Words that cannot start a value because they belong to the grammar. */
const RESERVED = new Set([
  'and',
  'or',
  'not',
  'order',
  'in',
  'is',
  'was',
  'changed',
  ...PREDICATES,
]);

/** How deep parentheses and NOT may nest; deeper input is refused instead of exhausting the stack. */
export const MAX_DEPTH = 100;

const OPERATOR_HINTS = [
  '=',
  '!=',
  '<',
  '<=',
  '>',
  '>=',
  '~',
  '!~',
  'IN',
  'NOT IN',
  'IS',
  'IS NOT',
  'WAS',
  'WAS NOT',
  'CHANGED',
];
const AFTER_EXPRESSION = ['AND', 'OR', 'ORDER BY', 'end of the query'];

/** One problem in a query, located for an editor (QRY-001). */
export interface Diagnostic {
  message: string;
  /** 0-based offsets into the text. */
  start: number;
  end: number;
  /** 1-based line and column of `start`. */
  line: number;
  column: number;
  /** What would have been accepted here, such as `value`, `)` or `AND`. */
  expected: string[];
}

export interface ParseResult {
  /**
   * The tree of everything that parsed. When there are errors, clauses that could not be read
   * are left out, so the tree is partial but always prints as a valid query.
   */
  query: Query;
  /** Every error, in text order, at most one per position; empty for a valid query. */
  errors: Diagnostic[];
}

/**
 * Parses the native query language (grammar in docs/specs/06-query-language-grammar.md), which
 * also reads the Jira-compatible dialect. Throws the first error as a `QueryError` carrying the
 * position, the line and column (named in the message for multi-line text) and the expected
 * tokens.
 */
export function parseQuery(text: string): Query {
  const { query, errors } = parseWithDiagnostics(text);
  const first = errors[0];
  if (first) {
    const multiline = text.includes('\n');
    throw new QueryError(first.message, first.start, Math.max(1, first.end - first.start), {
      expected: first.expected,
      ...(multiline ? { line: first.line, column: first.column } : {}),
    });
  }
  return query;
}

/**
 * Parses with error recovery and never throws: a clause that cannot be read is reported and
 * skipped up to the next AND, OR, closing parenthesis or ORDER BY, so one pass finds every
 * independent mistake and an editor can underline them all.
 */
export function parseWithDiagnostics(text: string): ParseResult {
  const { tokens, errors: lexical } = scan(text);
  const parser = new Parser(tokens);
  const query = parser.parseQuery();
  const raw = [...lexical, ...parser.errors].sort((a, b) => a.start - b.start);
  const errors: Diagnostic[] = [];
  const seen = new Set<number>();
  const locate = lineIndex(text);
  for (const e of raw) {
    if (seen.has(e.start)) continue;
    seen.add(e.start);
    errors.push({ ...e, ...locate(e.start) });
  }
  return { query, errors };
}

/** A clause that was dropped because a part of it was already reported. */
class Dropped extends Error {}

class Parser {
  private pos = 0;
  private depth = 0;
  readonly errors: RawDiagnostic[] = [];
  /** For each "(" token, the index of its matching ")" token, or -1. */
  private readonly closes: Int32Array;

  constructor(private readonly tokens: Token[]) {
    this.closes = new Int32Array(tokens.length).fill(-1);
    const open: number[] = [];
    tokens.forEach((t, i) => {
      if (t.type === 'lparen') open.push(i);
      else if (t.type === 'rparen') {
        const o = open.pop();
        if (o !== undefined) this.closes[o] = i;
      }
    });
  }

  parseQuery(): Query {
    const where = this.parseWhere();
    const orderBy = this.isKeyword('order') ? this.parseOrderBy() : [];
    if (!this.atEnd()) {
      const t = this.peek();
      this.report(`Unexpected "${t.text}"`, t, ['end of the query']);
      this.pos = this.tokens.length - 1;
    }
    return { where, orderBy };
  }

  /**
   * The condition part. A token that cannot continue the expression is reported and skipped;
   * what follows an AND or OR after it is still read and joined, so later mistakes are found.
   */
  private parseWhere(): Expr | null {
    let where = this.atEnd() || this.isKeyword('order') ? null : this.parseOr();
    while (!this.atEnd() && !this.isKeyword('order')) {
      const t = this.next();
      this.report(`Unexpected "${t.text}"`, t, where ? AFTER_EXPRESSION : ['field name']);
      if (where === null) {
        where = this.parseOr();
        continue;
      }
      this.skipUntil(['and', 'or', 'order']);
      if (this.isKeyword('and') || this.isKeyword('or')) {
        const kind = this.next().text.toLowerCase() as 'and' | 'or';
        const rest = this.parseOr();
        if (rest) where = { kind, items: [where, rest], span: spanOf([where, rest]) };
      }
    }
    return where;
  }

  private parseOr(): Expr | null {
    const items: Expr[] = [];
    const first = this.parseAnd();
    if (first) items.push(first);
    while (this.isKeyword('or')) {
      this.next();
      const item = this.parseAnd();
      if (item) items.push(item);
    }
    return combine('or', items);
  }

  private parseAnd(): Expr | null {
    const items: Expr[] = [];
    const first = this.parseUnit();
    if (first) items.push(first);
    while (this.isKeyword('and')) {
      this.next();
      const item = this.parseUnit();
      if (item) items.push(item);
    }
    return combine('and', items);
  }

  /** One operand of AND: on an error, report it and skip to where the next operand can start. */
  private parseUnit(): Expr | null {
    try {
      return this.parseNot();
    } catch (error) {
      if (error instanceof QueryError) this.record(error);
      else if (!(error instanceof Dropped)) throw error;
      this.skipUntil(['and', 'or', 'order'], true);
      return null;
    }
  }

  private parseNot(): Expr | null {
    if (this.isKeyword('not')) {
      const not = this.next();
      this.enter(not);
      try {
        const expr = this.parseNot();
        return expr
          ? { kind: 'not', expr, span: { start: not.span.start, end: expr.span.end } }
          : null;
      } finally {
        this.depth--;
      }
    }
    if (this.peek().type === 'lparen') {
      const open = this.next();
      this.enter(open);
      let expr: Expr | null;
      try {
        expr = this.parseOr();
      } finally {
        this.depth--;
      }
      if (this.peek().type === 'rparen') this.next();
      else this.record(this.error('Expected ")"', [')', ...(expr ? ['AND', 'OR'] : [])]));
      return expr;
    }
    return this.parseClause();
  }

  /** Counts one nesting level; the caller releases it in a `finally`. */
  private enter(t: Token): void {
    if (this.depth >= MAX_DEPTH) {
      throw new QueryError(
        `The query nests deeper than ${MAX_DEPTH} levels`,
        t.span.start,
        t.span.end - t.span.start,
      );
    }
    this.depth++;
  }

  private parseClause(): Clause {
    const field = this.parseField();
    const t = this.peek();

    if (t.type === 'op') {
      this.next();
      const value = this.parseValue();
      return {
        kind: 'compare',
        field,
        op: t.text as CompareOp,
        value,
        span: { start: field.span.start, end: value.span.end },
      };
    }

    if (this.isKeyword('in')) {
      this.next();
      const values = this.parseList();
      return {
        kind: 'in',
        field,
        negated: false,
        values,
        span: { start: field.span.start, end: this.lastEnd() },
      };
    }

    if (this.isKeyword('not')) {
      this.next();
      if (this.isKeyword('in')) {
        this.next();
        const values = this.parseList();
        return {
          kind: 'in',
          field,
          negated: true,
          values,
          span: { start: field.span.start, end: this.lastEnd() },
        };
      }
      throw this.error('Expected IN after NOT', ['IN']);
    }

    if (this.isKeyword('is')) {
      this.next();
      let negated = false;
      if (this.isKeyword('not')) {
        this.next();
        negated = true;
      }
      if (this.isKeyword('empty') || this.isKeyword('null')) {
        this.next();
        return {
          kind: 'empty',
          field,
          negated,
          span: { start: field.span.start, end: this.lastEnd() },
        };
      }
      throw this.error(
        'Expected EMPTY or NULL after IS',
        negated ? ['EMPTY', 'NULL'] : ['NOT', 'EMPTY', 'NULL'],
      );
    }

    if (this.isKeyword('was')) {
      this.next();
      let negated = false;
      if (this.isKeyword('not')) {
        this.next();
        negated = true;
      }
      let values: Value[];
      if (this.isKeyword('in')) {
        this.next();
        values = this.parseList();
      } else {
        values = [this.parseValue()];
      }
      const predicates = this.parsePredicates();
      return {
        kind: 'was',
        field,
        negated,
        values,
        predicates,
        span: { start: field.span.start, end: this.lastEnd() },
      };
    }

    if (this.isKeyword('changed')) {
      this.next();
      const predicates = this.parsePredicates();
      return {
        kind: 'changed',
        field,
        predicates,
        span: { start: field.span.start, end: this.lastEnd() },
      };
    }

    throw this.error(`Expected an operator after "${field.name}"`, OPERATOR_HINTS);
  }

  private parsePredicates(): Predicate[] {
    const out: Predicate[] = [];
    for (;;) {
      const t = this.peek();
      const kind = t.type === 'word' ? (t.text.toLowerCase() as PredicateKind) : undefined;
      if (!kind || !PREDICATES.includes(kind)) return out;
      this.next();
      const values = this.peek().type === 'lparen' ? this.parseList() : [this.parseValue()];
      out.push({ kind, values, span: { start: t.span.start, end: this.lastEnd() } });
    }
  }

  private parseField(): FieldRef {
    const t = this.peek();
    if (t.type === 'string') {
      this.next();
      return { name: t.text, span: t.span };
    }
    if (t.type !== 'word') throw this.error('Expected a field name', ['field name']);
    if (RESERVED.has(t.text.toLowerCase())) {
      throw new QueryError(
        `"${t.text}" cannot be used as a field name`,
        t.span.start,
        t.text.length,
        {
          expected: ['field name'],
        },
      );
    }
    this.next();
    const lower = t.text.toLowerCase();
    if (
      (lower === 'ticket.property' || lower === 'issue.property') &&
      this.peek().type === 'lbracket'
    ) {
      return this.propertyField(t);
    }
    if (lower === 'cf' && this.peek().type === 'lbracket') {
      this.next();
      const n = this.expect('number', 'Expected a custom field number', ['number']);
      const close = this.expect('rbracket', 'Expected "]"', [']']);
      return {
        name: 'cf',
        custom: Number(n.text),
        span: { start: t.span.start, end: close.span.end },
      };
    }
    return { name: t.text, span: t.span };
  }

  /**
   * `ticket.property[key].path` (M1-129): the key as a word, a number or a quoted string, then a
   * dot path written right after the bracket (`.a.b`), or none for the whole value.
   */
  private propertyField(t: Token): FieldRef {
    this.next();
    const key = this.peek();
    if (key.type !== 'word' && key.type !== 'string' && key.type !== 'number') {
      throw this.error('Expected a property key', ['property key']);
    }
    this.next();
    const close = this.expect('rbracket', 'Expected "]"', [']']);
    let end = close.span.end;
    let path = '';
    const after = this.peek();
    if (
      after.type === 'word' &&
      after.span.start === close.span.end &&
      after.text.startsWith('.')
    ) {
      this.next();
      path = after.text.slice(1);
      end = after.span.end;
      if (path === '' || path.split('.').some((s) => s === '')) {
        throw new QueryError(
          'Expected a property path such as .status.name',
          after.span.start,
          after.text.length,
          {
            expected: ['property path'],
          },
        );
      }
    }
    return {
      name: t.text.toLowerCase() === 'issue.property' ? 'issue.property' : 'ticket.property',
      property: { key: key.text, path },
      span: { start: t.span.start, end },
    };
  }

  /**
   * `IN (a, b)`, or `IN someFunction()` for functions that return a list. A mistake inside the
   * parentheses is reported and the rest of the list skipped, so the clause keeps the values
   * read so far; a list that ends up empty drops the clause.
   */
  private parseList(): Value[] {
    const t = this.peek();
    if (t.type === 'word' && this.tokens[this.pos + 1]?.type === 'lparen') {
      return [this.parseValue()];
    }
    const openAt = this.pos;
    this.expect('lparen', 'Expected "("', ['(', 'function']);
    const values: Value[] = [];
    if (this.peek().type === 'rparen') {
      this.record(this.error('Expected at least one value', ['value']));
      this.next();
      throw new Dropped();
    }
    for (;;) {
      try {
        values.push(this.parseValue());
      } catch (error) {
        if (!(error instanceof QueryError)) throw error;
        this.record(error);
        this.skipList(openAt);
        break;
      }
      if (this.peek().type === 'comma') {
        this.next();
        continue;
      }
      if (this.peek().type === 'rparen') {
        this.next();
        return values;
      }
      this.record(this.error('Expected "," or ")"', [',', ')']));
      this.skipList(openAt);
      break;
    }
    if (values.length === 0) throw new Dropped();
    return values;
  }

  /**
   * After a mistake in a list: continue after the list's own ")" when it has one; otherwise the
   * list was never closed, so stop before the next AND, OR or ORDER BY.
   */
  private skipList(openAt: number): void {
    const close = this.closes[openAt] ?? -1;
    if (close !== -1) {
      this.pos = close + 1;
      return;
    }
    this.skipUntil(['and', 'or', 'order'], true);
  }

  private parseValue(): Value {
    const t = this.peek();
    switch (t.type) {
      case 'string':
        this.next();
        return { kind: 'string', value: t.text, span: t.span };
      case 'number':
        this.next();
        return { kind: 'number', value: Number(t.text), span: t.span };
      case 'word': {
        if (RESERVED.has(t.text.toLowerCase())) throw this.error('Expected a value', ['value']);
        this.next();
        const lower = t.text.toLowerCase();
        if (lower === 'empty' || lower === 'null') return { kind: 'empty', span: t.span };
        if (this.peek().type === 'lparen') {
          const open = this.next();
          this.enter(open);
          const args: Value[] = [];
          let close: Token;
          try {
            if (this.peek().type !== 'rparen') {
              for (;;) {
                args.push(this.parseValue());
                if (this.peek().type !== 'comma') break;
                this.next();
              }
            }
            close = this.expect('rparen', 'Expected ")"', [',', ')']);
          } finally {
            this.depth--;
          }
          return {
            kind: 'function',
            name: t.text,
            args,
            span: { start: t.span.start, end: close.span.end },
          };
        }
        if (DURATION.test(t.text)) return { kind: 'duration', value: t.text, span: t.span };
        return { kind: 'word', value: t.text, span: t.span };
      }
      default:
        throw this.error('Expected a value', ['value']);
    }
  }

  /** ORDER BY with recovery: a bad sort item is reported and the next one after a comma is read. */
  private parseOrderBy(): OrderBy[] {
    this.next(); // ORDER
    if (this.isKeyword('by')) this.next();
    else this.record(this.error('Expected BY after ORDER', ['BY']));
    const out: OrderBy[] = [];
    for (;;) {
      try {
        const field = this.parseField();
        let direction: 'asc' | 'desc' = 'asc';
        if (this.isKeyword('asc') || this.isKeyword('desc')) {
          direction = this.next().text.toLowerCase() as 'asc' | 'desc';
        }
        out.push({ field, direction, span: { start: field.span.start, end: this.lastEnd() } });
      } catch (error) {
        if (!(error instanceof QueryError)) throw error;
        this.record(error);
        while (!this.atEnd() && this.peek().type !== 'comma') this.next();
      }
      if (this.peek().type !== 'comma') return out;
      this.next();
    }
  }

  // --- recovery helpers

  /**
   * Skips tokens until one of the keywords, a closing parenthesis that belongs to an enclosing
   * group (left for it to consume), or the end. Parentheses opened while skipping are balanced.
   */
  private skipUntil(keywords: string[], stopAtClose = false): void {
    let depth = 0;
    while (!this.atEnd()) {
      const t = this.peek();
      if (t.type === 'lparen') depth++;
      else if (t.type === 'rparen') {
        if (depth === 0) {
          if (stopAtClose) return;
        } else depth--;
      } else if (depth === 0 && keywords.some((k) => this.isKeyword(k))) {
        return;
      }
      this.next();
    }
  }

  private record(error: QueryError): void {
    this.errors.push({
      message: error.detail,
      start: error.position,
      end: error.position + error.length,
      expected: [...error.expected],
    });
  }

  private report(message: string, t: Token, expected: string[]): void {
    this.errors.push({
      message,
      start: t.span.start,
      end: Math.max(t.span.end, t.span.start + 1),
      expected,
    });
  }

  // --- token helpers

  private peek(): Token {
    return this.tokens[this.pos] as Token;
  }

  private next(): Token {
    const t = this.peek();
    if (t.type !== 'eof') this.pos++;
    return t;
  }

  private atEnd(): boolean {
    return this.peek().type === 'eof';
  }

  private isKeyword(word: string): boolean {
    const t = this.peek();
    return t.type === 'word' && t.text.toLowerCase() === word;
  }

  private expect(type: Token['type'], message: string, expected: string[]): Token {
    const t = this.peek();
    if (t.type !== type) throw this.error(message, expected);
    return this.next();
  }

  private lastEnd(): number {
    return (this.tokens[this.pos - 1] ?? this.peek()).span.end;
  }

  private error(message: string, expected: string[]): QueryError {
    const t = this.peek();
    const found = t.type === 'eof' ? 'the end of the query' : `"${t.text}"`;
    return new QueryError(
      `${message}, found ${found}`,
      t.span.start,
      Math.max(1, t.span.end - t.span.start),
      {
        expected,
      },
    );
  }
}

function combine(kind: 'and' | 'or', items: Expr[]): Expr | null {
  if (items.length === 0) return null;
  if (items.length === 1) return items[0] as Expr;
  return { kind, items, span: spanOf(items) };
}

function spanOf(items: { span: Span }[]): Span {
  return { start: items[0]?.span.start ?? 0, end: items[items.length - 1]?.span.end ?? 0 };
}
