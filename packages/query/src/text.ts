/**
 * The search syntax inside a `~` value (M1-040; QRY-007; spec 01b section 1.8, Taskmoor's own
 * design): what a person types after `summary ~` or `text ~`, read into terms the server turns
 * into a full-text query.
 *
 * - Words are ANDed, in any order: `login timeout`.
 * - A quoted phrase matches its words next to each other, in order: `"login failed"`. Inside a
 *   phrase `*`, `?`, `~` and `-` are ordinary characters.
 * - A trailing `*` matches words that start with the term: `log*`.
 * - `?` stands for exactly one character: `lo?in`, at most two in a word.
 * - A trailing `~` makes a word fuzzy: words one edit away (a letter added, removed, changed, or
 *   two neighbours swapped) match too, `login~` finds "logon" and "loign".
 * - A leading `-` excludes a word or phrase: `login -password`. A search cannot only exclude.
 * - A `*` anywhere but at the end makes the term a pattern, matched inside the text with `*`
 *   for any characters and `?` for one: `*Exception` finds "NullPointerException". Patterns
 *   need three letters or digits in a row, and only short texts (summaries and text fields)
 *   take them.
 * - A backslash makes the next character literal: `C\+\+`, `\-1`, `what\?`.
 * - Case does not matter, and words match their other forms (stemming): `logging` finds "logs".
 */
export type TextTerm =
  /** A word as typed; punctuation inside it (`foo.bar`, `e-mail`) is the database's to split. */
  | { kind: 'word'; text: string; prefix?: true }
  /** Words that must stand next to each other, in order. */
  | { kind: 'phrase'; text: string }
  /** A word with `?` wildcards: the text between them; `prefix` with a trailing `*` too. */
  | { kind: 'wildcard'; parts: string[]; prefix?: true }
  /** A word or one edit away from it. */
  | { kind: 'fuzzy'; text: string }
  /** Text inside the field: literal `parts` with `gaps` between them (`*` many, `?` one). */
  | { kind: 'pattern'; parts: string[]; gaps: ('many' | 'one')[] };

export interface TextSearch {
  /** Every one must match. */
  terms: TextTerm[];
  /** None may match. */
  excluded: TextTerm[];
}

/** A `?` stands for one character; more than this many in one word is refused. */
export const MAX_WILDCARDS = 2;

/** Why a search cannot be read, and where in the value. */
export class TextSearchError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

/** A character of a term and whether it was typed unescaped (so it may mean something). */
interface Char {
  c: string;
  special: boolean;
}

const searchable = /[\p{L}\p{N}]/u;

/** Whether a term has anything to search for: a letter or a digit. */
const hasWord = (chars: readonly Char[]) => chars.some((x) => searchable.test(x.c));

/** Reads a `~` value; throws TextSearchError for a search that cannot run. */
export function parseTextSearch(value: string): TextSearch {
  const terms: TextTerm[] = [];
  const excluded: TextTerm[] = [];
  const chars = [...value];
  let i = 0;
  while (i < chars.length) {
    const ch = chars[i] as string;
    if (/\s/u.test(ch)) {
      i++;
      continue;
    }
    const start = i;
    let negated = false;
    if (ch === '-' && i + 1 < chars.length && !/\s/u.test(chars[i + 1] as string)) {
      negated = true;
      i++;
    }
    let term: TextTerm | undefined;
    if (chars[i] === '"') {
      // A phrase runs to the next unescaped quote, or to the end.
      i++;
      let text = '';
      while (i < chars.length && chars[i] !== '"') {
        if (chars[i] === '\\' && i + 1 < chars.length) i++;
        text += chars[i];
        i++;
      }
      i++;
      if (searchable.test(text)) term = { kind: 'phrase', text };
    } else {
      const word: Char[] = [];
      while (i < chars.length && !/\s/u.test(chars[i] as string) && chars[i] !== '"') {
        if (chars[i] === '\\' && i + 1 < chars.length) {
          word.push({ c: chars[i + 1] as string, special: false });
          i += 2;
        } else {
          word.push({ c: chars[i] as string, special: true });
          i++;
        }
      }
      term = termOf(word, start);
    }
    if (term) (negated ? excluded : terms).push(term);
  }
  if (terms.length === 0) {
    throw new TextSearchError(
      excluded.length > 0
        ? 'A search needs a word to find; it cannot only exclude words'
        : 'The search has no words to look for',
      0,
    );
  }
  return { terms, excluded };
}

function termOf(typed: Char[], at: number): TextTerm | undefined {
  const is = (x: Char | undefined, c: string) => x?.special === true && x.c === c;
  // Stars side by side are one: `log**` is `log*`, a prefix.
  const word = typed.filter((x, i) => !(is(x, '*') && is(typed[i + 1], '*')));
  const last = word[word.length - 1];
  if (is(last, '~')) {
    const body = word.slice(0, -1);
    if (body.some((x) => is(x, '*') || is(x, '?'))) {
      throw new TextSearchError('A word cannot be both fuzzy (~) and a wildcard', at);
    }
    return hasWord(body) ? { kind: 'fuzzy', text: body.map((x) => x.c).join('') } : undefined;
  }
  const stars = word.flatMap((x, i) => (is(x, '*') ? [i] : []));
  if (stars.some((i) => i !== word.length - 1)) return pattern(word, at);
  const prefix = stars.length === 1;
  const body = prefix ? word.slice(0, -1) : word;
  if (!hasWord(body)) return undefined;
  if (!body.some((x) => is(x, '?'))) {
    return { kind: 'word', text: body.map((x) => x.c).join(''), ...(prefix ? { prefix } : {}) };
  }
  const parts = [''];
  for (const x of body) {
    if (is(x, '?')) parts.push('');
    else parts[parts.length - 1] += x.c;
  }
  if (parts.length - 1 > MAX_WILDCARDS) {
    throw new TextSearchError(`A word can hold at most ${MAX_WILDCARDS} ? wildcards`, at);
  }
  return { kind: 'wildcard', parts, ...(prefix ? { prefix } : {}) };
}

function pattern(word: Char[], at: number): TextTerm | undefined {
  const parts = [''];
  const gaps: ('many' | 'one')[] = [];
  for (const x of word) {
    if (x.special && (x.c === '*' || x.c === '?')) {
      // Stars side by side are one gap.
      if (x.c === '*' && parts[parts.length - 1] === '' && gaps[gaps.length - 1] === 'many') {
        continue;
      }
      gaps.push(x.c === '*' ? 'many' : 'one');
      parts.push('');
    } else {
      parts[parts.length - 1] += x.c;
    }
  }
  if (!hasWord(word)) return undefined;
  // The trigram index needs three characters together to narrow the search.
  if (!parts.some((p) => [...p].filter((c) => searchable.test(c)).length >= 3)) {
    throw new TextSearchError(
      'A search with * inside or in front needs three letters or digits in a row',
      at,
    );
  }
  return { kind: 'pattern', parts, gaps };
}

/** The search's text with its own syntax, for messages and warnings. */
export function printTextTerm(term: TextTerm): string {
  const literal = (s: string) => s.replace(/[\\"*?~\-\s]/gu, (c) => `\\${c}`);
  switch (term.kind) {
    case 'word':
      return `${literal(term.text)}${term.prefix ? '*' : ''}`;
    case 'phrase':
      return `"${term.text.replace(/["\\]/g, (c) => `\\${c}`)}"`;
    case 'wildcard':
      return `${term.parts.map(literal).join('?')}${term.prefix ? '*' : ''}`;
    case 'fuzzy':
      return `${literal(term.text)}~`;
    case 'pattern':
      return term.parts
        .map(
          (p, i) =>
            `${literal(p)}${i < term.gaps.length ? (term.gaps[i] === 'many' ? '*' : '?') : ''}`,
        )
        .join('');
  }
}
