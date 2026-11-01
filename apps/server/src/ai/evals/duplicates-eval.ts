import { DUPLICATE_POOL, type DuplicateTicket } from './duplicates-corpus';
import { ratio } from './query-eval';

/**
 * The duplicate suggestion eval (M1-133; AI-016; ADR-107). Each cluster member is a new
 * ticket being written; the rest of the pool is ranked by cosine similarity of the embeddings
 * of summary and description (optionally re-ranked by a model, AI-016's second step). It scores
 * recall@3, how often a true duplicate is among the first three, the reciprocal rank of the
 * first true duplicate, and the share of queries where a near miss of the same cluster ranks
 * above every true duplicate.
 */
export type Embed = (texts: string[]) => Promise<number[][]> | number[][];
/** Re-orders the first candidates for a query (a model with reasons, when one is configured). */
export type Rerank = (
  query: DuplicateTicket,
  candidates: readonly DuplicateTicket[],
) => Promise<string[]> | string[];

export interface DuplicateQueryOutcome {
  id: string;
  top: string[];
  /** 1-based rank of the first true duplicate. */
  rank: number;
  hit: boolean;
  nearMissAbove: boolean;
}

export interface DuplicateReport {
  feature: 'duplicates';
  candidate: string;
  queries: number;
  pool: number;
  recallAt3: number;
  mrr: number;
  nearMissAbove: number;
  /** recall@3 is the score. */
  score: number;
  failures: DuplicateQueryOutcome[];
  outcomes: DuplicateQueryOutcome[];
}

export const ticketText = (t: DuplicateTicket) => `${t.summary}\n${t.description}`;

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export async function runDuplicateEval(
  embed: Embed,
  name: string,
  options: { rerank?: Rerank; rerankTop?: number; pool?: readonly DuplicateTicket[] } = {},
): Promise<DuplicateReport> {
  const pool = options.pool ?? DUPLICATE_POOL;
  const vectors = await embed(pool.map(ticketText));
  if (vectors.length !== pool.length)
    throw new Error(`embed returned ${vectors.length} vectors for ${pool.length} texts`);
  const outcomes: DuplicateQueryOutcome[] = [];
  for (const [qi, query] of pool.entries()) {
    if (!query.cluster) continue;
    const qv = vectors[qi] as number[];
    let ranked = pool
      .map((t, i) => ({
        t,
        score: i === qi ? Number.NEGATIVE_INFINITY : cosine(qv, vectors[i] as number[]),
      }))
      .filter((x) => x.t.id !== query.id)
      .sort((a, b) => b.score - a.score || a.t.id.localeCompare(b.t.id))
      .map((x) => x.t);
    if (options.rerank) {
      const n = options.rerankTop ?? 10;
      const head = ranked.slice(0, n);
      const order = await options.rerank(query, head);
      const byId = new Map(head.map((t) => [t.id, t]));
      const reordered = order.flatMap((id) =>
        byId.has(id) ? [byId.get(id) as DuplicateTicket] : [],
      );
      const rest = head.filter((t) => !order.includes(t.id));
      ranked = [...reordered, ...rest, ...ranked.slice(n)];
    }
    const rank = ranked.findIndex((t) => t.cluster === query.cluster) + 1;
    const miss = ranked.findIndex((t) => t.nearMissOf === query.cluster) + 1;
    outcomes.push({
      id: query.id,
      top: ranked.slice(0, 3).map((t) => t.id),
      rank,
      hit: rank > 0 && rank <= 3,
      nearMissAbove: miss > 0 && miss < rank,
    });
  }
  const hits = outcomes.filter((o) => o.hit).length;
  const recallAt3 = ratio(hits, outcomes.length);
  return {
    feature: 'duplicates',
    candidate: name,
    queries: outcomes.length,
    pool: pool.length,
    recallAt3,
    mrr: ratio(
      outcomes.reduce((s, o) => s + (o.rank > 0 ? 1 / o.rank : 0), 0),
      outcomes.length,
    ),
    nearMissAbove: ratio(outcomes.filter((o) => o.nearMissAbove).length, outcomes.length),
    score: recallAt3,
    failures: outcomes.filter((o) => !o.hit),
    outcomes,
  };
}

const STOP = new Set(
  'a an the and or but of to in on at for with by from is are was were be been it its this that these those i we you they my our your their me us them as not no do does did after before when once while into out up down over than then there here every each any all some only one two can cannot will would should could has have had'.split(
    ' ',
  ),
);

/** Lower-case words with a crude English stem, stop words left out. */
export function bagOfWords(text: string): string[] {
  return (text.toLowerCase().match(/\p{L}[\p{L}\p{N}]*|\p{N}+/gu) ?? [])
    .filter((w) => !STOP.has(w))
    .map((w) => w.replace(/(ing|ed|es|s)$/, '').replace(/(.)\1$/, '$1'))
    .filter((w) => w.length > 1);
}

/**
 * A stand-in embedder until the bundled model's runtime is on this branch (M1-078): word counts
 * hashed into 512 dimensions, unit length. It knows no synonyms, so it is a floor, not a target.
 */
export const bagOfWordsEmbed: Embed = (texts) =>
  texts.map((text) => {
    const v = new Array<number>(512).fill(0);
    for (const w of bagOfWords(text)) {
      let h = 0x811c9dc5;
      for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 0x01000193) >>> 0;
      v[h % 512] = (v[h % 512] ?? 0) + 1;
    }
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
    return v.map((x) => x / norm);
  });
