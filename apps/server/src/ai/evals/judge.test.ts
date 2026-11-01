import { describe, expect, it } from 'vitest';
import { calibrateJudge, JUDGE_PROMPT, judgePrompt, judgeSummary } from './judge';
import { JUDGED, SUMMARY_CASES } from './summary-corpus';

/**
 * The summary judge's plumbing (M1-079; AI-013; ADR-108), without a model: the prompt it
 * fills, the verdicts it reads, and the calibration against the graded examples, here with an
 * oracle that answers what the labels say. With a model, `pnpm eval summary --candidate
 * candidates/live.ts` calibrates the real judge the same way.
 */
const verdicts = (fails: readonly string[]) =>
  JSON.stringify(
    Object.fromEntries(
      JUDGED.map((id) => [
        id,
        { verdict: fails.includes(id) ? 'fail' : 'pass', reason: 'Because.' },
      ]),
    ),
  );

describe('the summary judge (M1-079)', () => {
  const c = SUMMARY_CASES[0];
  if (!c) throw new Error('no summary case');

  it('[AI-013] fills the rubric prompt with the ticket as its reader sees it', () => {
    expect(JUDGE_PROMPT).toContain('{ticket}');
    const prompt = judgePrompt(c, 'The summary.');
    expect(prompt).not.toContain('{ticket}');
    expect(prompt).toContain(c.ticket.summary);
    expect(prompt).toContain('The summary.');
    // Comments the reader may not read are not in it.
    for (const marker of c.markers) expect(prompt).not.toContain(marker);
  });

  it('[AI-013] reads verdicts, also inside prose or a code block, and refuses an unreadable one', async () => {
    expect(await judgeSummary(async () => verdicts([]), c, 'x')).toEqual([]);
    expect(
      await judgeSummary(
        async () => `Here:\n\`\`\`json\n${verdicts(['faithful'])}\n\`\`\``,
        c,
        'x',
      ),
    ).toEqual(['faithful']);
    expect(await judgeSummary(async () => 'I cannot grade this.', c, 'x')).toBeNull();
  });

  it('[AI-013] calibrates against every graded example', async () => {
    const labelled = new Map(
      SUMMARY_CASES.flatMap((x) => x.graded.map((g) => [g.text, g.fails] as const)),
    );
    const oracle = await calibrateJudge(async (prompt) => {
      const text = [...labelled.keys()].find((t) => prompt.includes(t));
      return verdicts(text ? (labelled.get(text) ?? []) : []);
    });
    expect(oracle.disagreements).toEqual([]);
    expect(oracle.agree).toBe(oracle.examples);
    // A judge that passes everything disagrees on each flawed example with a judged label.
    const lenient = await calibrateJudge(async () => verdicts([]));
    const judgedFlaws = SUMMARY_CASES.flatMap((x) => x.graded).filter((g) =>
      g.fails.some((f) => (JUDGED as readonly string[]).includes(f)),
    );
    expect(lenient.disagreements.map((d) => d.example)).toEqual(judgedFlaws.map((g) => g.id));
  });

  it('[AI-014] the live candidate without a key says it cannot run instead of scoring', async () => {
    if (process.env.TASKMOOR_AI_EVAL_KEY || process.env.TASKMOOR_AI_TEST_KEY) return;
    const { candidate } = await import('./candidates/live');
    expect(candidate.unavailable).toMatch(/no AI key/);
    expect(candidate.query).toBeUndefined();
  });
});
