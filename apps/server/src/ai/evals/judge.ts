import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { person } from './dataset';
import { type CriterionId, JUDGED, SUMMARY_CASES, type SummaryCase } from './summary-corpus';
import { readable } from './summary-eval';

/**
 * The summary judge (M1-079; AI-013; ADR-107, ADR-108): `judge-prompt.md` filled with a case's
 * ticket as its reader sees it and a summary, sent to a model, its JSON verdict read back. It
 * runs only when a candidate brings a model (`EvalCandidate.judge`); the runner calibrates it on
 * the graded examples first and reports where it disagrees with their labels.
 */
export type Judge = (prompt: string) => Promise<string>;

const verdict = z.object({ verdict: z.enum(['pass', 'fail']), reason: z.string() }).loose();
export const judgeAnswer = z
  .object({
    purpose: verdict,
    contributors: verdict,
    'recent-changes': verdict,
    faithful: verdict,
  })
  .loose();

/** The prompt between the two rules of `judge-prompt.md`. */
export const JUDGE_PROMPT = (() => {
  const text = readFileSync(new URL('./judge-prompt.md', import.meta.url), 'utf8');
  const parts = text.split(/^---$/m);
  if (parts.length < 3) throw new Error('judge-prompt.md lost its rules');
  return (parts[1] as string).trim();
})();

/** The case's ticket as its reader sees it, with each comment's name. */
export function judgeTicket(c: SummaryCase): string {
  const t = c.ticket;
  const name = (h: string | null) => (h ? person(h as never).name : 'nobody');
  return [
    `Summary: ${t.summary}`,
    `Type: ${t.type}. Status: ${t.status}. Priority: ${t.priority ?? 'none'}.`,
    `Assignee: ${name(t.assignee)}. Created by: ${name(t.creator)}.`,
    t.targetRelease ? `Target release: ${t.targetRelease}.` : '',
    t.due ? `Due: ${t.due}.` : '',
    `Description: ${t.description}`,
    'Comments:',
    ...t.comments
      .filter((x) => readable(c, x.ref))
      .map((x) => `[${x.ref}] ${name(x.author)}, ${x.daysAgo} days ago: ${x.text}`),
  ]
    .filter(Boolean)
    .join('\n');
}

export function judgePrompt(c: SummaryCase, summary: string): string {
  return JUDGE_PROMPT.replace('{ticket}', judgeTicket(c)).replace('{summary}', summary);
}

/**
 * The judged criteria a summary fails, or null when there is no readable verdict: an answer
 * that is not the verdict's JSON, or a call that failed (an outage that outlasted the retries).
 * A failed call costs one verdict, never the run and the measurements already paid for (T-333).
 */
export async function judgeSummary(
  judge: Judge,
  c: SummaryCase,
  summary: string,
): Promise<CriterionId[] | null> {
  let raw: string;
  try {
    raw = await judge(judgePrompt(c, summary));
  } catch {
    return null;
  }
  const json = /\{[\s\S]*\}/.exec(raw)?.[0];
  if (!json) return null;
  let parsed: z.infer<typeof judgeAnswer>;
  try {
    parsed = judgeAnswer.parse(JSON.parse(json));
  } catch {
    return null;
  }
  return JUDGED.filter(
    (id) => (parsed as Record<string, { verdict: string } | undefined>)[id]?.verdict === 'fail',
  );
}

export interface JudgeCalibration {
  examples: number;
  agree: number;
  disagreements: { example: string; labelled: CriterionId[]; judged: CriterionId[] | null }[];
}

/** The judge over every graded example: references pass all four, flaws fail what they name. */
export async function calibrateJudge(
  judge: Judge,
  cases: readonly SummaryCase[] = SUMMARY_CASES,
): Promise<JudgeCalibration> {
  const disagreements: JudgeCalibration['disagreements'] = [];
  let examples = 0;
  for (const c of cases) {
    for (const g of c.graded) {
      examples++;
      const labelled = JUDGED.filter((id) => g.fails.includes(id));
      const judged = await judgeSummary(judge, c, g.text);
      const agrees =
        judged !== null &&
        labelled.every((id) => judged.includes(id)) &&
        (g.expected === 'fail' || judged.length === 0);
      if (!agrees) disagreements.push({ example: g.id, labelled, judged });
    }
  }
  return { examples, agree: examples - disagreements.length, disagreements };
}
