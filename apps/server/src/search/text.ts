import type { TextSearch, TextTerm } from '@taskmoor/query';

/**
 * Text search in SQL terms (M1-040; QRY-007; ADR-069): a search read by `parseTextSearch`
 * (spec 01b section 1.8) becomes the input of `to_tsquery` over the `taskmoor_search`
 * configuration of migration 0057 (English stemming, no stop words), and patterns become
 * `ILIKE` patterns the trigram indexes serve.
 *
 * - Words and phrases are quoted operands, so the database's own parser splits and stems them
 *   exactly as it split and stemmed the indexed text (`'login failed'` reads as
 *   `'login' <-> 'fail'`).
 * - A trailing `*` is a prefix operand (`'log':*`).
 * - `?` and fuzzy words expand into the words they stand for, each an operand of one OR: a `?`
 *   by every letter and digit, a fuzzy word by every word one edit away. Each expansion is an
 *   exact lexeme the word index looks up, so neither reads text, and each goes through the
 *   stemmer like the indexed words did. The planner cannot weigh an OR of hundreds of words, so
 *   searches with them start from the word indexes (`expands`; `compile.ts`).
 * - Values are never written into SQL: the tsquery text is one parameter, its operands quoted
 *   and escaped here.
 */

/** The text search configuration the word indexes were built with (migration 0057). */
export const SEARCH_CONFIG = 'taskmoor_search';

export interface TextQuery {
  /** The input of `to_tsquery`; null when the search has only patterns. */
  tsquery: string | null;
  /** `ILIKE` patterns that must match. */
  patterns: string[];
  /** `ILIKE` patterns that must not match. */
  excludedPatterns: string[];
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const LATIN = 'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþÿß';
/** More expansions than this for one `?` word, and Latin letters are left out. */
const MAX_EXPANSIONS = 2_000;
/** A fuzzy word longer than this is matched as written (its expansions would be thousands). */
export const MAX_FUZZY_LENGTH = 24;
/** A fuzzy word shorter than this is matched as written: one edit would make another word. */
export const MIN_FUZZY_LENGTH = 3;

const searchable = /[\p{L}\p{N}]/u;

/** The characters a `?` or an edit may bring: letters and digits, the word's own, and accents. */
function alphabet(word: string, accents: boolean): string[] {
  const own = [...word.toLowerCase()].filter((c) => searchable.test(c));
  return [...new Set([...LETTERS, ...(accents ? LATIN : ''), ...own])];
}

/** A tsquery operand: the text between quotes, quotes doubled and backslashes escaped. */
export function operand(text: string): string {
  return `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;
}

/** Every word `?` stands for: one character of the alphabet at each `?`. */
export function wildcardWords(parts: readonly string[]): string[] {
  const holes = parts.length - 1;
  const joined = parts.join('');
  let letters = alphabet(joined, true);
  if (letters.length ** holes > MAX_EXPANSIONS) letters = alphabet(joined, false);
  let words = [(parts[0] ?? '').toLowerCase()];
  for (const part of parts.slice(1)) {
    words = words.flatMap((w) => letters.map((c) => `${w}${c}${part.toLowerCase()}`));
  }
  return words;
}

/**
 * The word and every word one edit away (Damerau: a character removed, added or changed, or
 * two neighbours swapped), lower case, without repeats.
 */
export function fuzzyWords(word: string): string[] {
  const w = [...word.toLowerCase()];
  const text = w.join('');
  if (w.length < MIN_FUZZY_LENGTH || w.length > MAX_FUZZY_LENGTH) return [text];
  // Accented letters for short words and words that have some; long ASCII words would expand
  // into thousands of words for the rare accent.
  const letters = alphabet(text, w.length <= 12 || w.some((c) => c > '\u007f'));
  const out = new Set<string>([text]);
  const at = (i: number, j: number) => w.slice(i, j).join('');
  for (let i = 0; i <= w.length; i++) {
    if (i < w.length) out.add(at(0, i) + at(i + 1, w.length));
    if (i < w.length - 1) out.add(at(0, i) + w[i + 1] + w[i] + at(i + 2, w.length));
    for (const c of letters) {
      if (i < w.length && c !== w[i]) out.add(at(0, i) + c + at(i + 1, w.length));
      out.add(at(0, i) + c + at(i, w.length));
    }
  }
  return [...out].filter((x) => searchable.test(x));
}

type Expanding = Extract<TextTerm, { kind: 'wildcard' | 'fuzzy' }>;

/** Every word a wildcard or fuzzy term stands for, and whether they are prefixes. */
export function expansions(term: Expanding): { words: string[]; prefix: boolean } {
  return term.kind === 'wildcard'
    ? { words: wildcardWords(term.parts), prefix: term.prefix === true }
    : { words: fuzzyWords(term.text), prefix: false };
}

/** One term as a tsquery expression; undefined for a pattern. */
function tsTerm(term: TextTerm): string | undefined {
  switch (term.kind) {
    case 'word':
      return `${operand(term.text)}${term.prefix ? ':*' : ''}`;
    case 'phrase':
      return operand(term.text);
    case 'wildcard':
    case 'fuzzy': {
      const { words, prefix } = expansions(term);
      const suffix = prefix ? ':*' : '';
      return `(${words.map((w) => `${operand(w)}${suffix}`).join(' | ')})`;
    }
    case 'pattern':
      return undefined;
  }
}

/**
 * Whether a search must match a `?` or fuzzy word, which expands into many words: the planner
 * would think it matches nearly everything and walk the whole order, so it starts from the
 * word indexes instead (the typical one is a typo or a rare word).
 */
export const expands = (search: TextSearch) =>
  search.terms.some((t) => t.kind === 'wildcard' || t.kind === 'fuzzy');

/** A pattern as `ILIKE` reads it: literal text escaped, `*` as `%`, `?` as `_`, anywhere. */
export function likePattern(term: Extract<TextTerm, { kind: 'pattern' }>): string {
  const literal = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
  const parts = [...term.parts];
  const gaps = [...term.gaps];
  // A pattern matches anywhere already: a `*` at either end adds nothing.
  if (parts[0] === '' && gaps[0] === 'many') {
    parts.shift();
    gaps.shift();
  }
  if (parts[parts.length - 1] === '' && gaps[gaps.length - 1] === 'many') {
    parts.pop();
    gaps.pop();
  }
  const body = parts
    .map((p, i) => `${literal(p)}${i < gaps.length ? (gaps[i] === 'many' ? '%' : '_') : ''}`)
    .join('');
  return `%${body}%`;
}

const isPattern = (t: TextTerm): t is Extract<TextTerm, { kind: 'pattern' }> =>
  t.kind === 'pattern';

/** Whether a search holds a pattern (`*` inside or in front of a word). */
export const hasPattern = (search: TextSearch) =>
  search.terms.some(isPattern) || search.excluded.some(isPattern);

/** The tsquery input and the patterns of a search. */
export function textQuery(search: TextSearch): TextQuery {
  const must = search.terms.flatMap((t) => tsTerm(t) ?? []);
  const not = search.excluded.flatMap((t) => {
    const x = tsTerm(t);
    return x === undefined ? [] : [`!${x}`];
  });
  const parts = [...must, ...not];
  return {
    tsquery: parts.length === 0 ? null : parts.join(' & '),
    patterns: search.terms.filter(isPattern).map(likePattern),
    excludedPatterns: search.excluded.filter(isPattern).map(likePattern),
  };
}
