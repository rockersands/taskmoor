import { parseQuery } from '@taskmoor/query';
import { describe, expect, it } from 'vitest';
import { datasetTickets, LABELS, PEOPLE, TRACKS } from './dataset';
import { type Coverage, QUERY_PAIRS } from './query-corpus';
import { sameResult, textSearchBaseline, vocabularyFor } from './query-eval';

/**
 * The natural-language-to-query corpus and the dataset behind it (M1-133; AI-014), without a
 * database: sizes, languages, coverage, and the scoring rule. The references run on the seeded
 * dataset in `evals.test.ts`.
 */
describe('natural language to query corpus (M1-133)', () => {
  it('[AI-014] has at least 120 pairs, 15 or more each in Spanish, German and Japanese', () => {
    expect(QUERY_PAIRS.length).toBeGreaterThanOrEqual(120);
    const by = (l: string) => QUERY_PAIRS.filter((p) => p.language === l).length;
    expect(by('en')).toBeGreaterThan(by('es') + by('de') + by('ja'));
    for (const l of ['es', 'de', 'ja']) expect(by(l), l).toBeGreaterThanOrEqual(15);
    expect(new Set(QUERY_PAIRS.map((p) => p.id)).size).toBe(QUERY_PAIRS.length);
    expect(new Set(QUERY_PAIRS.map((p) => `${p.language}:${p.asUser}:${p.prompt}`)).size).toBe(
      QUERY_PAIRS.length,
    );
  });

  it('[AI-014] covers fields, operators, dates, functions, text, order, empty, negation, my, this week, overdue and unassigned', () => {
    const count = (c: Coverage) => QUERY_PAIRS.filter((p) => p.covers.includes(c)).length;
    for (const c of [
      'fields',
      'operators',
      'dates',
      'functions',
      'text',
      'order',
      'empty',
      'negation',
      'my',
      'this-week',
      'overdue',
      'unassigned',
    ] as const) {
      expect(count(c), c).toBeGreaterThanOrEqual(5);
    }
    expect(count('history')).toBeGreaterThanOrEqual(2);
    expect(count('permissions')).toBeGreaterThanOrEqual(3);
    // Ordered pairs are exactly those whose reference orders.
    for (const p of QUERY_PAIRS)
      expect(/ORDER BY/.test(p.reference), p.id).toBe(p.ordered === true);
    // German and Japanese ask for "my", "this week", "overdue" and "unassigned" too (AI-014 (3)).
    for (const l of ['de', 'ja']) {
      for (const c of ['my', 'this-week', 'overdue', 'unassigned'] as const) {
        expect(
          QUERY_PAIRS.some((p) => p.language === l && p.covers.includes(c)),
          `${l} ${c}`,
        ).toBe(true);
      }
    }
  });

  it('[AI-014] every reference parses, and only a few expect nothing, each with its reason', () => {
    for (const p of QUERY_PAIRS) expect(() => parseQuery(p.reference), p.id).not.toThrow();
    const empty = QUERY_PAIRS.filter((p) => p.expectEmpty !== undefined);
    expect(empty.length).toBeLessThanOrEqual(3);
    for (const p of empty) expect(p.expectEmpty?.length, p.id).toBeGreaterThan(10);
  });

  it('[AI-014] the dataset has about 200 tickets across four tracks, eight people and comment threads', () => {
    const tickets = datasetTickets();
    expect(tickets.length).toBeGreaterThanOrEqual(190);
    expect(PEOPLE).toHaveLength(8);
    expect(new Set(tickets.map((t) => t.track))).toEqual(new Set(TRACKS.map((t) => t.key)));
    expect(new Set(tickets.map((t) => t.status))).toEqual(
      new Set(['New', 'Active', 'In Review', 'Closed']),
    );
    expect(tickets.filter((t) => t.comments.length > 0).length).toBeGreaterThan(80);
    expect(tickets.flatMap((t) => t.comments).filter((c) => c.restrictedTo).length).toBeGreaterThan(
      10,
    );
    expect(tickets.filter((t) => t.assignee === null).length).toBeGreaterThan(20);
    expect(tickets.filter((t) => t.due).length).toBeGreaterThan(50);
    for (const t of tickets)
      for (const l of t.labels) expect(LABELS as readonly string[]).toContain(l);
    // The generator is seeded: the same list every time.
    expect(datasetTickets().map((t) => t.summary)).toEqual(tickets.map((t) => t.summary));
    expect(new Set(tickets.map((t) => t.summary)).size).toBe(tickets.length);
  });

  it('[AI-014] a candidate sees only the tracks its person may browse', () => {
    expect(vocabularyFor('chen').tracks.map((t) => t.key)).toEqual(['WEB', 'API', 'MOB', 'OPS']);
    expect(vocabularyFor('ben').tracks.map((t) => t.key)).toEqual(['WEB', 'API', 'MOB']);
    expect(vocabularyFor('ben').areas.map((a) => a.track)).not.toContain('OPS');
  });

  it('[AI-014] scores the same set, and the same order only where asked, ties in any order', () => {
    const ref = { ok: true as const, ids: [1, 2, 3, 4], ties: [1, 2, 1] };
    const r = (ids: number[]) => ({ ok: true as const, ids, ties: [] });
    expect(sameResult(ref, r([4, 3, 2, 1]), false)).toBe(true);
    expect(sameResult(ref, r([4, 3, 2, 1]), true)).toBe(false);
    expect(sameResult(ref, r([1, 3, 2, 4]), true)).toBe(true);
    expect(sameResult(ref, r([1, 2, 3]), false)).toBe(false);
    expect(sameResult(ref, r([1, 2, 3, 3]), false)).toBe(false);
    expect(sameResult(ref, r([1, 2, 3, 5]), false)).toBe(false);
  });

  it('[AI-014] the text-search baseline quotes the prompt so it always parses', () => {
    for (const p of QUERY_PAIRS) {
      const q = textSearchBaseline({
        prompt: `${p.prompt} "quoted" \\`,
        language: p.language,
      } as never);
      expect(() => parseQuery(String(q)), p.id).not.toThrow();
    }
  });
});
