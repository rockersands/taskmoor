import { FormulaError } from './errors';

/**
 * The sandbox's limits (ADR-009, "Implementation (M1-013)"). The text and the tree are bounded
 * before anything runs, and evaluation counts its steps, so no formula can take more than a
 * bounded time or memory, whatever it says.
 */
export const LIMITS = {
  /** Characters of formula text. */
  length: 4000,
  /** Nesting of parentheses, calls, operators and branches. */
  depth: 64,
  /** Parts of the tree: values, field references, operators and calls. */
  nodes: 1000,
  /** Steps of one evaluation; every part evaluated and every child value read is a step. */
  steps: 1_000_000,
  /** Characters of any text a formula builds on the way. */
  text: 10_000,
} as const;

export type TokenKind =
  | 'number'
  | 'string'
  | 'field'
  | 'ident'
  | 'op'
  | 'lparen'
  | 'rparen'
  | 'comma'
  | 'dot'
  | 'eof';

export interface Token {
  kind: TokenKind;
  /** The operator, the word, the number's text, or a string's or field name's content. */
  text: string;
  start: number;
  end: number;
}

const OPERATORS = [
  '&&',
  '||',
  '==',
  '!=',
  '<>',
  '<=',
  '>=',
  '+',
  '-',
  '*',
  '/',
  '^',
  '&',
  '=',
  '<',
  '>',
  '!',
];

const NUMBER = /(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/y;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;

/**
 * Splits a formula into tokens. Strings take double or single quotes and fields braces; a
 * backslash in either takes the next character as it is (`"say \"hi\""`, `{a\}b}`).
 */
export function tokenize(text: string): Token[] {
  if (text.length > LIMITS.length) {
    throw new FormulaError(
      'too_long',
      `A formula has at most ${LIMITS.length} characters`,
      LIMITS.length,
      text.length,
      text,
    );
  }
  const out: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    const start = i;
    if ((c >= '0' && c <= '9') || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(text);
      const raw = m?.[0] ?? c;
      i += raw.length;
      // "2x" or "1.2.3": a number runs into something that is not a separator.
      if (/[A-Za-z0-9_.]/.test(text[i] ?? '')) {
        let end = i;
        while (/[A-Za-z0-9_.]/.test(text[end] ?? '')) end++;
        throw new FormulaError('invalid_number', 'Not a number', start, end, text);
      }
      if (!Number.isFinite(Number(raw)) || raw.length > 100) {
        throw new FormulaError('invalid_number', 'The number is too large', start, i, text);
      }
      out.push({ kind: 'number', text: raw, start, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      WORD.lastIndex = i;
      const raw = (WORD.exec(text)?.[0] ?? c) as string;
      i += raw.length;
      out.push({ kind: 'ident', text: raw, start, end: i });
      continue;
    }
    if (c === '"' || c === "'") {
      let value = '';
      i++;
      for (;;) {
        if (i >= text.length) {
          throw new FormulaError(
            'unterminated_string',
            'The text has no closing quote',
            start,
            text.length,
            text,
          );
        }
        const d = text[i] as string;
        if (d === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
        } else if (d === c) {
          i++;
          break;
        } else {
          value += d;
          i++;
        }
      }
      out.push({ kind: 'string', text: value, start, end: i });
      continue;
    }
    if (c === '{') {
      let name = '';
      i++;
      for (;;) {
        if (i >= text.length || text[i] === '\n') {
          throw new FormulaError(
            'unterminated_field',
            'The field name has no closing brace',
            start,
            i,
            text,
          );
        }
        const d = text[i] as string;
        if (d === '\\' && i + 1 < text.length) {
          name += text[i + 1];
          i += 2;
        } else if (d === '}') {
          i++;
          break;
        } else {
          name += d;
          i++;
        }
      }
      if (name.trim() === '') {
        throw new FormulaError('empty_field', 'A field name is missing', start, i, text);
      }
      out.push({ kind: 'field', text: name.trim(), start, end: i });
      continue;
    }
    if (c === '(') {
      out.push({ kind: 'lparen', text: c, start, end: ++i });
      continue;
    }
    if (c === ')') {
      out.push({ kind: 'rparen', text: c, start, end: ++i });
      continue;
    }
    if (c === ',') {
      out.push({ kind: 'comma', text: c, start, end: ++i });
      continue;
    }
    if (c === '.') {
      out.push({ kind: 'dot', text: c, start, end: ++i });
      continue;
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i));
    if (op) {
      i += op.length;
      out.push({ kind: 'op', text: op, start, end: i });
      continue;
    }
    const point = text.codePointAt(i) as number;
    const width = point > 0xffff ? 2 : 1;
    throw new FormulaError(
      'unexpected_character',
      `Unexpected character ${JSON.stringify(String.fromCodePoint(point))}`,
      start,
      start + width,
      text,
    );
  }
  out.push({ kind: 'eof', text: '', start: text.length, end: text.length });
  return out;
}

/** A field reference as a formula writes it, escaping what would end or open it. */
export function fieldToken(name: string): string {
  return `{${name.replace(/[\\{}]/g, (c) => `\\${c}`)}}`;
}

/** A text literal as a formula writes it. */
export function stringToken(value: string): string {
  return `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`;
}
