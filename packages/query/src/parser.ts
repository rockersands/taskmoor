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
import { QueryError, type Token, tokenize } from './lexer';

const COMPARE_OPS: readonly CompareOp[] = ['=', '!=', '<', '<=', '>', '>=', '~', '!~'];
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

/**
 * Parses the query language (grammar in docs/specs/01b, section 1.2) with a Jira-compatible
 * dialect. Errors carry the position so an editor can underline them.
 */
export function parseQuery(text: string): Query {
  return new Parser(tokenize(text)).parseQuery();
}

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parseQuery(): Query {
    let where: Expr | null = null;
    if (!this.atEnd() && !this.isKeyword('order')) where = this.parseOr();
    const orderBy = this.isKeyword('order') ? this.parseOrderBy() : [];
    if (!this.atEnd()) {
      const t = this.peek();
      throw new QueryError(`Unexpected "${t.text}"`, t.span.start, t.span.end - t.span.start);
    }
    return { where, orderBy };
  }

  private parseOr(): Expr {
    const items = [this.parseAnd()];
    while (this.isKeyword('or')) {
      this.next();
      items.push(this.parseAnd());
    }
    return items.length === 1 ? (items[0] as Expr) : { kind: 'or', items, span: spanOf(items) };
  }

  private parseAnd(): Expr {
    const items = [this.parseNot()];
    while (this.isKeyword('and')) {
      this.next();
      items.push(this.parseNot());
    }
    return items.length === 1 ? (items[0] as Expr) : { kind: 'and', items, span: spanOf(items) };
  }

  private parseNot(): Expr {
    if (this.isKeyword('not')) {
      const start = this.next().span.start;
      const expr = this.parseNot();
      return { kind: 'not', expr, span: { start, end: expr.span.end } };
    }
    if (this.peek().type === 'lparen') {
      this.next();
      const expr = this.parseOr();
      this.expect('rparen', 'Expected ")"');
      return expr;
    }
    return this.parseClause();
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
      throw this.error('Expected IN after NOT');
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
      throw this.error('Expected EMPTY or NULL after IS');
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

    throw this.error(`Expected an operator after "${field.name}"`);
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
    if (t.type !== 'word') throw this.error('Expected a field name');
    if (RESERVED.has(t.text.toLowerCase())) {
      throw new QueryError(
        `"${t.text}" cannot be used as a field name`,
        t.span.start,
        t.text.length,
      );
    }
    this.next();
    if (t.text.toLowerCase() === 'cf' && this.peek().type === 'lbracket') {
      this.next();
      const n = this.expect('number', 'Expected a custom field number');
      const close = this.expect('rbracket', 'Expected "]"');
      return {
        name: 'cf',
        custom: Number(n.text),
        span: { start: t.span.start, end: close.span.end },
      };
    }
    return { name: t.text, span: t.span };
  }

  /** `IN (a, b)`, or `IN someFunction()` for functions that return a list. */
  private parseList(): Value[] {
    const t = this.peek();
    if (t.type === 'word' && this.tokens[this.pos + 1]?.type === 'lparen') {
      return [this.parseValue()];
    }
    this.expect('lparen', 'Expected "("');
    const values: Value[] = [];
    if (this.peek().type === 'rparen') throw this.error('Expected at least one value');
    for (;;) {
      values.push(this.parseValue());
      if (this.peek().type === 'comma') {
        this.next();
        continue;
      }
      this.expect('rparen', 'Expected "," or ")"');
      return values;
    }
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
        if (RESERVED.has(t.text.toLowerCase())) throw this.error('Expected a value');
        this.next();
        const lower = t.text.toLowerCase();
        if (lower === 'empty' || lower === 'null') return { kind: 'empty', span: t.span };
        if (this.peek().type === 'lparen') {
          this.next();
          const args: Value[] = [];
          if (this.peek().type !== 'rparen') {
            for (;;) {
              args.push(this.parseValue());
              if (this.peek().type !== 'comma') break;
              this.next();
            }
          }
          const close = this.expect('rparen', 'Expected ")"');
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
        throw this.error('Expected a value');
    }
  }

  private parseOrderBy(): OrderBy[] {
    this.next(); // ORDER
    if (!this.isKeyword('by')) throw this.error('Expected BY after ORDER');
    this.next();
    const out: OrderBy[] = [];
    for (;;) {
      const field = this.parseField();
      let direction: 'asc' | 'desc' = 'asc';
      if (this.isKeyword('asc') || this.isKeyword('desc')) {
        direction = this.next().text.toLowerCase() as 'asc' | 'desc';
      }
      out.push({ field, direction, span: { start: field.span.start, end: this.lastEnd() } });
      if (this.peek().type !== 'comma') return out;
      this.next();
    }
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

  private expect(type: Token['type'], message: string): Token {
    const t = this.peek();
    if (t.type !== type) throw this.error(message);
    return this.next();
  }

  private lastEnd(): number {
    return (this.tokens[this.pos - 1] ?? this.peek()).span.end;
  }

  private error(message: string): QueryError {
    const t = this.peek();
    const found = t.type === 'eof' ? 'the end of the query' : `"${t.text}"`;
    return new QueryError(
      `${message}, found ${found}`,
      t.span.start,
      Math.max(1, t.span.end - t.span.start),
    );
  }
}

function spanOf(items: { span: Span }[]): Span {
  return { start: items[0]?.span.start ?? 0, end: items[items.length - 1]?.span.end ?? 0 };
}
