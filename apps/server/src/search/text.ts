import type { Database } from '@taskmoor/db';
import type { TextSearch, TextTerm } from '@taskmoor/query';
import { type Kysely, sql, type Transaction } from 'kysely';

/**
 * Text search in SQL terms (M1-040; QRY-007; ADR-065): a search read by `parseTextSearch`
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
 *   stemmer like the indexed words did.
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
      const all = expansions(term);
      // Only the words that occur, when the server looked them up (`pruneExpansions`); none
      // left, and the first word stands in: it matches nothing, as the term does.
      const words = term.words
        ? term.words.length > 0
          ? term.words
          : all.words.slice(0, 1)
        : all.words;
      const suffix = all.prefix ? ':*' : '';
      return `(${words.map((w) => `${operand(w)}${suffix}`).join(' | ')})`;
    }
    case 'pattern':
      return undefined;
  }
}

/**
 * Keeps, for each wildcard and fuzzy term of `searches`, only the words it stands for that
 * occur in some searched text of the workspace: summaries, descriptions, environments,
 * comments and text fields, outside the trash. One lookup in the word indexes per word, all in
 * one statement; tens of words cost milliseconds. The planner then sees the few words that
 * exist, not dozens it cannot tell apart, and starts from the word indexes when they are rare.
 * Nothing about who may read what is decided here: the query's own filter still does that.
 */
export async function pruneExpansions(
  db: Kysely<Database> | Transaction<Database>,
  workspaceId: number,
  searches: readonly TextSearch[],
): Promise<void> {
  const terms = searches.flatMap((s) =>
    [...s.terms, ...s.excluded].filter(
      (t): t is Expanding => t.kind === 'wildcard' || t.kind === 'fuzzy',
    ),
  );
  if (terms.length === 0) return;
  const queries = new Map<string, string>();
  for (const t of terms) {
    const { words, prefix } = expansions(t);
    for (const w of words) queries.set(`${operand(w)}${prefix ? ':*' : ''}`, w);
  }
  const list = [...queries.keys()];
  const { rows } = await sql<{ q: string }>`
    SELECT x.q FROM unnest(${list}::text[]) AS x (q),
           LATERAL (SELECT to_tsquery('taskmoor_search'::regconfig, x.q) AS tq) q
     WHERE numnode(q.tq) > 0 AND (
       EXISTS (SELECT 1 FROM ticket t WHERE t.summary_words @@ q.tq AND t.deleted_at IS NULL
                 AND t.workspace_id = ${workspaceId})
       OR EXISTS (SELECT 1 FROM ticket t WHERE t.description_words @@ q.tq
                    AND t.deleted_at IS NULL AND t.workspace_id = ${workspaceId})
       OR EXISTS (SELECT 1 FROM ticket t WHERE t.environment_words @@ q.tq
                    AND t.deleted_at IS NULL AND t.workspace_id = ${workspaceId})
       OR EXISTS (SELECT 1 FROM ticket_comment c WHERE c.body_words @@ q.tq
                    AND c.deleted_at IS NULL AND c.workspace_id = ${workspaceId})
       OR EXISTS (SELECT 1 FROM v_text v
                   WHERE to_tsvector('taskmoor_search'::regconfig, v.value) @@ q.tq
                     AND v.workspace_id = ${workspaceId}))`.execute(db);
  const found = new Set(rows.map((r) => r.q));
  for (const t of terms) {
    const { words, prefix } = expansions(t);
    t.words = words.filter((w) => found.has(`${operand(w)}${prefix ? ':*' : ''}`));
  }
}

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
