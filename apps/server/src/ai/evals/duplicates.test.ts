import { stableJson } from '@taskmoor/testkit/golden';
import { describe, expect, it } from 'vitest';
import { DUPLICATE_POOL } from './duplicates-corpus';
import {
  bagOfWords,
  bagOfWordsEmbed,
  cosine,
  runDuplicateEval,
  ticketText,
} from './duplicates-eval';
import { THRESHOLDS } from './runner';

/**
 * The duplicate suggestion eval (M1-133; AI-016): its corpus, and the runner proved with
 * embedders whose scores are known (a perfect one, a useless one) and the bag-of-words stand-in
 * that serves until the bundled model's runtime arrives (M1-078).
 */
describe('duplicate suggestion eval (M1-133)', () => {
  const clusters = new Map<string, string[]>();
  for (const t of DUPLICATE_POOL)
    if (t.cluster) clusters.set(t.cluster, [...(clusters.get(t.cluster) ?? []), t.id]);

  it('[AI-016] has at least 40 queries, clusters of two or three and a near miss for every cluster', () => {
    expect(new Set(DUPLICATE_POOL.map((t) => t.id)).size).toBe(DUPLICATE_POOL.length);
    expect([...clusters.values()].flat().length).toBeGreaterThanOrEqual(40);
    for (const [id, members] of clusters) {
      expect(members.length, id).toBeGreaterThanOrEqual(2);
      expect(members.length, id).toBeLessThanOrEqual(3);
      expect(
        DUPLICATE_POOL.some((t) => t.nearMissOf === id),
        id,
      ).toBe(true);
    }
    for (const t of DUPLICATE_POOL) {
      expect(t.cluster && t.nearMissOf, t.id).toBeFalsy();
      expect(new Set(DUPLICATE_POOL.map(ticketText)).size).toBe(DUPLICATE_POOL.length);
    }
  });

  it('[AI-016] an embedder that knows the clusters scores recall@3 of 1 and no near miss above', async () => {
    const ids = [...clusters.keys()];
    const oracle = (texts: string[]) =>
      texts.map((text) => {
        const t = DUPLICATE_POOL.find((x) => ticketText(x) === text);
        const v = new Array<number>(ids.length + 1).fill(0);
        const at = t?.cluster ? ids.indexOf(t.cluster) : ids.length;
        v[at] = 1;
        return v;
      });
    const report = await runDuplicateEval(oracle, 'oracle');
    expect(report.queries).toBe([...clusters.values()].flat().length);
    expect(report.recallAt3).toBe(1);
    expect(report.mrr).toBe(1);
    expect(report.nearMissAbove).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it('[AI-016] an embedder that ranks near misses first is caught', async () => {
    // Every ticket of a cluster has the cluster's direction plus one of its own; a near miss
    // has the cluster's direction only, so it sits closer to each member than they do.
    const ids = [...clusters.keys()];
    const size = ids.length + DUPLICATE_POOL.length + 1;
    const misleading = (texts: string[]) =>
      texts.map((text) => {
        const p = DUPLICATE_POOL.findIndex((x) => ticketText(x) === text);
        const t = DUPLICATE_POOL[p];
        const v = new Array<number>(size).fill(0);
        const c = t?.cluster ?? t?.nearMissOf;
        if (c === undefined) v[size - 1] = 1;
        else v[ids.indexOf(c)] = 1;
        if (t?.cluster) v[ids.length + p] = 1;
        return v;
      });
    const report = await runDuplicateEval(misleading, 'misleading');
    expect(report.nearMissAbove).toBe(1);
    // A re-ranker that moves true duplicates first repairs it (AI-016's model step).
    const reranked = await runDuplicateEval(misleading, 'reranked', {
      rerank: (query, candidates) => [
        ...candidates.filter((c) => c.cluster === query.cluster).map((c) => c.id),
        ...candidates.filter((c) => c.cluster !== query.cluster).map((c) => c.id),
      ],
    });
    expect(reranked.recallAt3).toBe(1);
    expect(reranked.nearMissAbove).toBe(0);
  });

  it('[AI-016] the bag-of-words stand-in scores what the golden file says, below the threshold', async () => {
    expect(bagOfWords('Logging in fails after resetting passwords')).toEqual([
      'log',
      'fail',
      'reset',
      'password',
    ]);
    const [a, b] = bagOfWordsEmbed([
      'Webhook deliveries sent twice',
      'WEBHOOK deliveries, sent twice!',
    ]) as [number[], number[]];
    expect(cosine(a, b)).toBeCloseTo(1, 5);
    const report = await runDuplicateEval(bagOfWordsEmbed, 'bag of words');
    expect(report.recallAt3).toBeLessThan(THRESHOLDS.duplicates);
    await expect(
      stableJson({
        recallAt3: report.recallAt3,
        mrr: report.mrr,
        nearMissAbove: report.nearMissAbove,
        failures: report.failures.map((f) => `${f.id} at ${f.rank}`),
      }),
    ).toMatchFileSnapshot('./__golden__/duplicates-bag-of-words.json');
  });
});
