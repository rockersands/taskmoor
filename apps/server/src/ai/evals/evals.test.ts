import { useMigratedDatabase } from '@taskmoor/db/testing';
import { stableJson } from '@taskmoor/testkit/golden';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { candidate as replay } from './candidates/replay';
import { QUERY_PAIRS } from './query-corpus';
import { type QueryCandidate, referenceCandidate, runAs, runQueryEval } from './query-eval';
import { FEATURES, formatRun, runEvals, THRESHOLDS } from './runner';
import { type EvalWorld, seedEvalDataset } from './seed';
import { SUMMARY_CASES } from './summary-corpus';
import { readable, runSummaryEval, type SummaryCandidate } from './summary-eval';

/**
 * The AI evals on the seeded dataset (M1-133; AI-013, AI-014, AI-016): the dataset as the API
 * wrote it, every query reference's result, and the runner proved with the references, the
 * baselines and candidates whose scores are known. No model is called.
 */
describe('AI evals on the seeded dataset (M1-133)', () => {
  const database = useMigratedDatabase();
  let world: EvalWorld;

  beforeAll(async () => {
    world = await seedEvalDataset(database.db);
  }, 300_000);
  afterAll(async () => {
    await replay.close?.();
    await world?.close();
  });

  const reference = referenceCandidate(QUERY_PAIRS);
  const keysOf = (ids: number[]) =>
    ids.map((id) => world.tickets[world.ticketName(id) ?? '']?.key ?? `?${id}`);

  it('[AI-014] every reference parses, resolves and finds a non-empty, deterministic set as its person', async () => {
    const expected: Record<string, string[]> = {};
    for (const p of QUERY_PAIRS) {
      const first = await runAs(world, p.asUser, p.reference);
      const again = await runAs(world, p.asUser, p.reference);
      if (!first.ok || !again.ok) throw new Error(`${p.id}: ${JSON.stringify(first)}`);
      expect(again.ids, p.id).toEqual(first.ids);
      if (p.expectEmpty) expect(first.ids, p.id).toEqual([]);
      else expect(first.ids.length, p.id).toBeGreaterThan(0);
      // Not everything: each reference narrows the person's tickets.
      expect(first.ids.length, p.id).toBeLessThan(Object.keys(world.tickets).length);
      const keys = keysOf(first.ids);
      expected[p.id] = p.ordered ? keys : [...keys].sort();
    }
    // The expected results, by ticket key: a dataset change shows here for review.
    await expect(stableJson(expected)).toMatchFileSnapshot('./__golden__/query-expected.json');
  }, 120_000);

  it('[AI-014] the references score 100% and the text-search baseline almost nothing', async () => {
    const run = await runEvals({ features: ['query'], world: async () => world });
    expect(run.broken).toEqual([]);
    const [refs, baseline] = run.query;
    expect(refs?.score).toBe(1);
    expect(refs?.byLanguage).toEqual({
      en: { total: 77, passed: 77, score: 1 },
      es: { total: 16, passed: 16, score: 1 },
      de: { total: 16, passed: 16, score: 1 },
      ja: { total: 16, passed: 16, score: 1 },
    });
    expect(baseline?.score).toBeLessThan(0.05);
    expect(baseline?.score).toBeLessThan(THRESHOLDS.query);
    expect(formatRun(run)).toContain('reference queries: 125/125 exact-result match, 100.0%');
  }, 120_000);

  it('[AI-014] a query that does not parse scores 0 and is never run; a wrong order fails where order is asked', async () => {
    const asked: string[] = [];
    const pairs = QUERY_PAIRS.filter((p) =>
      ['en-001', 'en-053', 'en-057', 'ja-001'].includes(p.id),
    );
    const candidate: QueryCandidate = (c) => {
      asked.push(c.prompt);
      if (c.language === 'ja') return 'assignee = = currentUser(';
      const ref = String(reference(c));
      // Reversed order on one ordered pair; extra sort keys within the reference's ties on the other.
      if (ref.endsWith('ORDER BY created DESC')) return ref.replace('DESC', 'ASC');
      if (ref.endsWith('ORDER BY priority DESC')) return `${ref}, created ASC`;
      return ref;
    };
    const report = await runQueryEval(world, candidate, 'probe', pairs);
    expect(asked).toHaveLength(4);
    const by = Object.fromEntries(report.outcomes.map((o) => [o.id, o]));
    expect(by['ja-001']?.pass).toBe(false);
    expect(by['ja-001']?.problem).toMatch(/^parse: /);
    expect(by['ja-001']?.found).toBeUndefined();
    expect(by['en-053']?.problem).toBe('a different result');
    expect(by['en-057']?.pass).toBe(true);
    expect(by['en-001']?.pass).toBe(true);
    expect(report.score).toBe(0.5);
  }, 60_000);

  it('[AI-014] a query runs as its person: Operations is there for its members only', async () => {
    const asChen = await runAs(world, 'chen', 'track = OPS');
    expect(asChen.ok && asChen.ids.length).toBeGreaterThan(20);
    // Others do not know the track: the query is refused, as the search API refuses it.
    const asBen = await runAs(world, 'ben', 'track = OPS');
    expect(asBen.ok).toBe(false);
    const urgentFarid = await runAs(world, 'farid', 'priority = Urgent');
    const urgentBen = await runAs(world, 'ben', 'priority = Urgent');
    if (!urgentFarid.ok || !urgentBen.ok) throw new Error('refused');
    expect(urgentFarid.ids.length).toBeGreaterThan(urgentBen.ids.length);
    // A comment restricted to a group is found only by its members.
    const marker = 'comment ~ "\\"ORCHID LANTERN\\""';
    const asMember = await runAs(world, 'chen', marker);
    const asOther = await runAs(world, 'grace', marker);
    expect(asMember.ok && keysOf(asMember.ids)).toEqual([world.tickets.S01?.key]);
    expect(asOther.ok && asOther.ids).toEqual([]);
  });

  it('[AI-013] each case thread is seeded as written: its reader sees exactly the comments the corpus says', async () => {
    for (const c of SUMMARY_CASES) {
      const t = world.tickets[c.ticket.name];
      if (!t) throw new Error(c.id);
      const res = await world.as(c.asUser, {
        method: 'GET',
        url: `/api/v1/tickets/${t.id}/comments?format=text`,
      });
      expect(res.statusCode).toBe(200);
      const seen = (res.json().comments as { id: number }[]).map((x) => x.id);
      const want = c.ticket.comments
        .filter((x) => readable(c, x.ref))
        .map((x) => t.comments[x.ref]);
      expect(seen, c.id).toEqual(want);
      const ticket = (
        await world.as(c.asUser, { method: 'GET', url: `/api/v1/tickets/${t.id}` })
      ).json().ticket;
      expect(ticket.status.name, c.id).toBe(c.ticket.status);
    }
  });

  it('[AI-013] the runner grades candidates: the baseline lacks next steps, a leaking one is caught, the references pass', async () => {
    const run = await runEvals({ features: ['summary'], world: async () => world });
    expect(run.broken).toEqual([]);
    const [baseline] = run.summary;
    expect(baseline?.grader.score).toBe(1);
    expect(baseline?.passed).toBe(0);
    expect(new Set(baseline?.failures.flatMap((f) => f.failed))).toEqual(
      new Set(['next-steps', 'blockers']),
    );
    expect(run.pending.join()).toContain('judged criteria');

    // Reads the ticket as a member of the restricted group, not as the reader, and cites it all.
    const leaking: SummaryCandidate = async (input) => {
      const res = await world.as('chen', {
        method: 'GET',
        url: `/api/v1/tickets/${input.ticketId}/comments?format=text`,
      });
      const comments = res.json().comments as { id: number; body: string }[];
      return { text: comments.map((x) => x.body).join(' '), citations: comments.map((x) => x.id) };
    };
    const leaks = await runSummaryEval(world, leaking, 'leaking');
    const restrictedCases = SUMMARY_CASES.filter((c) => c.markers.length > 0).map((c) => c.id);
    expect(
      leaks.failures.filter((f) => f.failed.includes('no-restricted')).map((f) => f.id),
    ).toEqual(restrictedCases);

    // The graded references, as a candidate would return them: comment ids, not names.
    const oracle: SummaryCandidate = (input) => {
      const c = SUMMARY_CASES.find((x) => x.id === input.caseId);
      const g = c?.graded.find((x) => x.expected === 'pass');
      const t = world.tickets[input.caseId];
      if (!g || !t) throw new Error(input.caseId);
      return { text: g.text, citations: g.cites.map((ref) => t.comments[ref] as number) };
    };
    const references = await runSummaryEval(world, oracle, 'references');
    expect(references.failures).toEqual([]);
    expect(references.score).toBe(THRESHOLDS.summary);
    // An id that is no comment of the ticket does not resolve.
    const ghost = await runSummaryEval(
      world,
      async (input) => ({ ...(await oracle(input)), citations: [999_999] }),
      'ghost',
    );
    expect(ghost.passed).toBe(0);
    expect(ghost.failures.every((f) => f.failed.includes('citations-resolve'))).toBe(true);
  }, 120_000);

  it('[AI-016] the runner scores every feature in one run and prints each with its pending parts', async () => {
    const run = await runEvals({ features: ['duplicates'], world: async () => world });
    expect(run.broken).toEqual([]);
    expect(run.duplicates[0]?.queries).toBeGreaterThanOrEqual(40);
    const text = formatRun(run);
    expect(text).toMatch(/^duplicates {2}stand-in: bag of words: recall@3 /m);
    expect(text).toContain(
      'pending     duplicates: the bundled model’s score waits for its runtime (M1-078)',
    );
    // A candidate is scored against M1-079's threshold.
    const scored = await runEvals({
      features: ['duplicates'],
      candidate: {
        name: 'scattered',
        embed: (texts) => texts.map((_, i) => [Math.cos(i * 7), Math.sin(i * 7)]),
      },
      world: async () => world,
    });
    expect(scored.pending).toEqual([]);
    expect(formatRun(scored, 0, 'scattered')).toContain('below M1-079');
  });
  // Last: the injection run adds tickets to the dataset.
  it('[AI-013] [AI-014] [AI-016] [IAM-023] the product’s features score through the runner with a provider replaying recorded answers (M1-079)', async () => {
    const run = await runEvals({
      features: [...FEATURES],
      candidate: replay,
      world: async () => world,
    });
    expect(run.broken).toEqual([]);
    // The route's answer is checked and returned as written: every reference comes back.
    expect(run.query[0]?.score).toBe(1);
    expect(run.query[0]?.byLanguage.de?.score).toBe(1);
    expect(run.query[0]?.byLanguage.ja?.score).toBe(1);
    // Streamed, with the references' citations mapped to comments the reader may read.
    expect(run.summary[0]?.failures).toEqual([]);
    expect(run.summary[0]?.score).toBe(THRESHOLDS.summary);
    // The bundled model with the feature's re-rank wiring (the replay keeps the order).
    expect(run.duplicates[0]?.queries).toBeGreaterThanOrEqual(40);
    // Every injection case holds through every feature, the replayed images screened out.
    expect(run.injection[0]?.failures).toEqual([]);
    expect(run.injection[0]?.score).toBe(THRESHOLDS.injection);
    expect(run.pending).toEqual([
      'summary: the judged criteria (judge-prompt.md) wait for a model (M1-079)',
    ]);
    const text = formatRun(run, 3, replay.name);
    expect(text).toContain('125/125 exact-result match, 100.0%');
    process.stdout.write(text);
  }, 900_000);
});
