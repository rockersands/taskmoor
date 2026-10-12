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

export interface QueryErrorOptions {
  /** What the parser would have accepted at this point, for editor hints (QRY-001). */
  expected?: readonly string[];
  /** 1-based line and column; when given, the message names them instead of the position. */
  line?: number;
  column?: number;
}

/**
 * A query the parser or resolver refuses. `position` is the 0-based offset of the offending
 * text and `length` its extent; `detail` is the message without the location.
 */
export class QueryError extends Error {
  readonly detail: string;
  readonly position: number;
  readonly length: number;
  readonly expected: readonly string[];
  /** 1-based line of `position`. */
  readonly line: number;
  /** 1-based column of `position` on its line. */
  readonly column: number;

  constructor(message: string, position: number, length = 1, options: QueryErrorOptions = {}) {
    const where =
      options.line !== undefined
        ? `line ${options.line}, column ${options.column ?? 1}`
        : `position ${position + 1}`;
    super(`${message} at ${where}`);
    this.name = 'QueryError';
    this.detail = message;
    this.position = position;
    this.length = length;
    this.expected = options.expected ?? [];
    this.line = options.line ?? 1;
    this.column = options.column ?? position + 1;
  }
}

/** A problem found while reading a query, before line and column are attached. */
export interface RawDiagnostic {
  message: string;
  start: number;
  end: number;
  expected: string[];
}

const OPERATORS = ['!=', '!~', '<=', '>=', '=', '<', '>', '~'];
/** Characters that may start a word: `@` allows the relative sprint tokens (`@current`). */
const WORD_START = /[\p{L}\p{N}_.@-]/u;
/** Characters inside a word: `/` keeps slash dates (`2026/01/31`) whole. */
const WORD_CHAR = /[\p{L}\p{N}_.@/-]/u;

export interface ScanResult {
  tokens: Token[];
  /** Characters that cannot start a token and strings without a closing quote. */
  errors: RawDiagnostic[];
}

/**
 * Splits query text into tokens and never throws: an unexpected character is reported and
 * skipped, and an unterminated string runs to the end of the text and is reported. Words
 * include letters, digits, `_`, `.`, `-`, `@` and (inside a word) `/`, so item keys (`ABC-12`),
 * dates (`2026-01-31`, `2026/01/31`), durations (`-1w`), e-mail addresses and sprint tokens
 * stay whole. Keywords are plain words; the parser recognises them without regard to case.
 */
export function scan(text: string): ScanResult {
  const tokens: Token[] = [];
  const errors: RawDiagnostic[] = [];
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
      if (!closed) {
        errors.push({ message: 'Unterminated string', start, end: text.length, expected: [ch] });
      }
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
    if (WORD_START.test(ch) || signedNumber) {
      let j = i + 1;
      while (j < text.length && WORD_CHAR.test(text[j] as string)) j++;
      const word = text.slice(i, j);
      const type: TokenType =
        /^[+-]?\d+(\.\d+)?$/.test(word) && exactNumber(word) ? 'number' : 'word';
      tokens.push({ type, text: word, span: { start, end: j } });
      i = j;
      continue;
    }
    // One report for a run of characters that cannot start a token.
    let j = i + 1;
    while (j < text.length && !/\s/.test(text[j] as string) && !startsToken(text, j)) j++;
    errors.push({ message: `Unexpected character "${ch}"`, start, end: j, expected: [] });
    i = j;
  }
  tokens.push({ type: 'eof', text: '', span: { start: text.length, end: text.length } });
  return { tokens, errors };
}

/**
 * A numeral is a number only when a JavaScript number holds it exactly and prints it back
 * without an exponent; otherwise it stays a word, so `id = 10001100001100010000110001` keeps
 * every digit instead of turning into 1.0001100001100010e+25 (found by the fuzzer).
 */
function exactNumber(word: string): boolean {
  const n = Number(word);
  if (!Number.isFinite(n) || /e/i.test(String(n))) return false;
  return Number.isInteger(n) ? Number.isSafeInteger(n) : true;
}

function startsToken(text: string, i: number): boolean {
  const ch = text[i] as string;
  if ('()[],"\''.includes(ch)) return true;
  if (OPERATORS.some((o) => text.startsWith(o, i))) return true;
  return WORD_START.test(ch);
}

/** Like `scan`, but throws the first error. */
export function tokenize(text: string): Token[] {
  const { tokens, errors } = scan(text);
  const first = errors[0];
  if (first) {
    throw new QueryError(first.message, first.start, Math.max(1, first.end - first.start), {
      expected: first.expected,
    });
  }
  return tokens;
}

/** 1-based line and column of a 0-based offset; a CRLF counts as one line break. */
export function locate(text: string, offset: number): { line: number; column: number } {
  return lineIndex(text)(offset);
}

/** A reusable `locate` for one text: the line starts are found once, then binary-searched. */
export function lineIndex(text: string): (offset: number) => { line: number; column: number } {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: offset - (starts[lo] as number) + 1 };
  };
}
