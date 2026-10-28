import type { BinaryOp, Node } from './ast';
import { FormulaError } from './errors';
import { LIMITS, type Token, tokenize } from './lexer';

/**
 * The formula grammar (M1-013; CORE-011), lowest precedence first:
 *
 *     or       a or b, a || b
 *     and      a and b, a && b
 *     not      not a, !a
 *     compare  = == != <> < <= > >=
 *     join     a & b            (text)
 *     add      + -
 *     multiply * /
 *     sign     -a, +a
 *     power    a ^ b            (right to left: 2 ^ 3 ^ 2 is 2 ^ 9; -2 ^ 2 is -4)
 *     primary  12, 1.5e3, "text", 'text', true, false, null, {Field}, children,
 *              children.{Field}, name(arguments), (expression)
 *
 * Keywords and function names ignore case. A hand-written Pratt parser: no `eval`, no
 * generated code, and nesting is bounded (`LIMITS.depth`) before the stack could be.
 */
const INFIX: Record<string, { op: BinaryOp; power: number; right?: true }> = {
  or: { op: 'or', power: 10 },
  '||': { op: 'or', power: 10 },
  and: { op: 'and', power: 20 },
  '&&': { op: 'and', power: 20 },
  '=': { op: '=', power: 40 },
  '==': { op: '=', power: 40 },
  '!=': { op: '!=', power: 40 },
  '<>': { op: '!=', power: 40 },
  '<': { op: '<', power: 40 },
  '<=': { op: '<=', power: 40 },
  '>': { op: '>', power: 40 },
  '>=': { op: '>=', power: 40 },
  '&': { op: '&', power: 50 },
  '+': { op: '+', power: 60 },
  '-': { op: '-', power: 60 },
  '*': { op: '*', power: 70 },
  '/': { op: '/', power: 70 },
  '^': { op: '^', power: 90, right: true },
};
const NOT_POWER = 30;
const SIGN_POWER = 80;

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false', 'null', 'children']);

class Parser {
  private at = 0;
  private depth = 0;
  private nodes = 0;

  constructor(
    private readonly text: string,
    private readonly tokens: Token[],
  ) {}

  private peek(): Token {
    return this.tokens[this.at] as Token;
  }

  private next(): Token {
    const t = this.tokens[this.at] as Token;
    if (t.kind !== 'eof') this.at++;
    return t;
  }

  private fail(code: FormulaError['code'], message: string, start: number, end: number): never {
    throw new FormulaError(code, message, start, end, this.text);
  }

  private unexpected(t: Token): never {
    if (t.kind === 'eof') this.fail('unexpected_end', 'The formula ends too early', t.start, t.end);
    this.fail('unexpected_token', `Unexpected ${describe(t)}`, t.start, t.end);
  }

  private node<T extends Node>(n: T): T {
    if (++this.nodes > LIMITS.nodes) {
      // An operator points at itself, not at everything before it.
      const [start, end] = n.kind === 'binary' ? [n.opStart, n.opEnd] : [n.start, n.end];
      this.fail(
        'too_complex',
        `A formula has at most ${LIMITS.nodes} parts`,
        start,
        Math.max(end, start + 1),
      );
    }
    return n;
  }

  /** Infix operator of a token, keywords included. */
  private infix(t: Token) {
    if (t.kind === 'op') return INFIX[t.text];
    if (t.kind === 'ident') {
      const word = t.text.toLowerCase();
      return word === 'and' || word === 'or' ? INFIX[word] : undefined;
    }
    return undefined;
  }

  parse(): Node {
    if (this.peek().kind === 'eof') this.fail('empty', 'The formula is empty', 0, 0);
    const tree = this.expression(0);
    const rest = this.peek();
    if (rest.kind !== 'eof') this.unexpected(rest);
    return tree;
  }

  private expression(minPower: number): Node {
    const t = this.peek();
    if (++this.depth > LIMITS.depth) {
      this.fail(
        'too_deep',
        `A formula nests at most ${LIMITS.depth} levels`,
        t.start,
        Math.max(t.end, t.start + 1),
      );
    }
    let left = this.prefix();
    for (;;) {
      const t = this.peek();
      const op = this.infix(t);
      if (!op || op.power <= minPower) break;
      this.next();
      const right = this.expression(op.right ? op.power - 1 : op.power);
      left = this.node({
        kind: 'binary',
        op: op.op,
        left,
        right,
        opStart: t.start,
        opEnd: t.end,
        start: left.start,
        end: right.end,
      });
    }
    this.depth--;
    return left;
  }

  private prefix(): Node {
    const t = this.next();
    switch (t.kind) {
      case 'number':
        return this.node({ kind: 'number', value: Number(t.text), start: t.start, end: t.end });
      case 'string':
        return this.node({ kind: 'text', value: t.text, start: t.start, end: t.end });
      case 'field':
        return this.node({ kind: 'field', name: t.text, start: t.start, end: t.end });
      case 'lparen': {
        const inner = this.expression(0);
        const close = this.next();
        if (close.kind !== 'rparen') {
          if (close.kind === 'eof') {
            this.fail('unexpected_end', 'A parenthesis is not closed', t.start, t.end);
          }
          this.unexpected(close);
        }
        return inner;
      }
      case 'op': {
        if (t.text === '-' || t.text === '+') {
          const operand = this.expression(SIGN_POWER);
          return this.node({
            kind: 'unary',
            op: t.text,
            operand,
            start: t.start,
            end: operand.end,
          });
        }
        if (t.text === '!') {
          const operand = this.expression(NOT_POWER);
          return this.node({ kind: 'unary', op: 'not', operand, start: t.start, end: operand.end });
        }
        return this.unexpected(t);
      }
      case 'ident':
        return this.word(t);
      default:
        return this.unexpected(t);
    }
  }

  private word(t: Token): Node {
    const word = t.text.toLowerCase();
    switch (word) {
      case 'true':
      case 'false':
        return this.node({ kind: 'boolean', value: word === 'true', start: t.start, end: t.end });
      case 'null':
        return this.node({ kind: 'empty', start: t.start, end: t.end });
      case 'not': {
        const operand = this.expression(NOT_POWER);
        return this.node({ kind: 'unary', op: 'not', operand, start: t.start, end: operand.end });
      }
      case 'and':
      case 'or':
        return this.unexpected(t);
      case 'children': {
        if (this.peek().kind !== 'dot') {
          return this.node({ kind: 'children', field: null, start: t.start, end: t.end });
        }
        this.next();
        const f = this.next();
        if (f.kind !== 'field') {
          if (f.kind === 'eof') this.unexpected(f);
          this.fail(
            'unexpected_token',
            'children. is followed by a field in braces, as in children.{Points}',
            f.start,
            f.end,
          );
        }
        return this.node({
          kind: 'children',
          field: { name: f.text, start: f.start, end: f.end },
          start: t.start,
          end: f.end,
        });
      }
    }
    if (this.peek().kind !== 'lparen') {
      this.fail(
        'unknown_name',
        `Unknown name ${t.text}: a field is written in braces, as {${t.text}}`,
        t.start,
        t.end,
      );
    }
    const open = this.next();
    const args: Node[] = [];
    if (this.peek().kind === 'rparen') {
      const close = this.next();
      return this.node({
        kind: 'call',
        name: word,
        args,
        nameEnd: t.end,
        start: t.start,
        end: close.end,
      });
    }
    for (;;) {
      args.push(this.expression(0));
      const sep = this.next();
      if (sep.kind === 'rparen') {
        return this.node({
          kind: 'call',
          name: word,
          args,
          nameEnd: t.end,
          start: t.start,
          end: sep.end,
        });
      }
      if (sep.kind === 'eof') {
        this.fail('unexpected_end', `The call to ${t.text} is not closed`, open.start, open.end);
      }
      if (sep.kind !== 'comma') this.unexpected(sep);
    }
  }
}

function describe(t: Token): string {
  switch (t.kind) {
    case 'number':
      return `number ${t.text}`;
    case 'string':
      return 'text';
    case 'field':
      return `field {${t.text}}`;
    case 'ident':
      return KEYWORDS.has(t.text.toLowerCase()) ? `keyword ${t.text}` : `name ${t.text}`;
    case 'eof':
      return 'end of formula';
    default:
      return JSON.stringify(t.text);
  }
}

/** Reads a formula into its tree, or throws a `FormulaError` at the first mistake. */
export function parseFormula(text: string): Node {
  return new Parser(text, tokenize(text)).parse();
}
