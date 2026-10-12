import type { Span } from './ast';

export type TokenType =
  | 'word'
  | 'string'
  | 'number'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'lbracket'
  | 'rbracket'
  | 'comma'
  | 'eof';

export interface Token {
  type: TokenType;
  /** For strings, the unescaped content; otherwise the source text. */
  text: string;
  span: Span;
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly position: number,
    readonly length = 1,
  ) {
    super(`${message} at position ${position + 1}`);
    this.name = 'QueryError';
  }
}

const OPERATORS = ['!=', '!~', '<=', '>=', '=', '<', '>', '~'];
const WORD_CHAR = /[\p{L}\p{N}_.-]/u;

/**
 * Splits query text into tokens. Words include letters, digits, `_`, `.` and `-`, so item keys
 * (`ABC-12`), dates (`2026-01-31`) and durations (`-1w`) stay whole. Keywords are plain words;
 * the parser recognises them without regard to case.
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    if (ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === ',') {
      const type: TokenType =
        ch === '('
          ? 'lparen'
          : ch === ')'
            ? 'rparen'
            : ch === '['
              ? 'lbracket'
              : ch === ']'
                ? 'rbracket'
                : 'comma';
      tokens.push({ type, text: ch, span: { start, end: start + 1 } });
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let value = '';
      i++;
      let closed = false;
      while (i < text.length) {
        const c = text[i] as string;
        if (c === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
          continue;
        }
        if (c === ch) {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) throw new QueryError('Unterminated string', start, text.length - start);
      tokens.push({ type: 'string', text: value, span: { start, end: i } });
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    // A sign directly followed by a digit starts a number or duration, not an operator.
    const signedNumber = (ch === '-' || ch === '+') && /\d/.test(text[i + 1] ?? '');
    if (op && !signedNumber) {
      tokens.push({ type: 'op', text: op, span: { start, end: start + op.length } });
      i += op.length;
      continue;
    }
    if (WORD_CHAR.test(ch) || signedNumber) {
      let j = i + 1;
      while (j < text.length && WORD_CHAR.test(text[j] as string)) j++;
      const word = text.slice(i, j);
      const type: TokenType = /^[+-]?\d+(\.\d+)?$/.test(word) ? 'number' : 'word';
      tokens.push({ type, text: word, span: { start, end: j } });
      i = j;
      continue;
    }
    throw new QueryError(`Unexpected character "${ch}"`, start);
  }
  tokens.push({ type: 'eof', text: '', span: { start: text.length, end: text.length } });
  return tokens;
}
