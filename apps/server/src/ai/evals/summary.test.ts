import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { person } from './dataset';
import { AUTOMATIC, JUDGED, SUMMARY_CASES } from './summary-corpus';
import { graderSelfCheck, gradeSummary, readable, sourceText } from './summary-eval';

/**
 * The summary rubric and its automatic grader (M1-133; AI-013): the graded examples are well
 * formed, cover every kind of flaw the eval must catch, and the grader agrees with every one.
 */
describe('summary eval corpus and grader (M1-133)', () => {
  const examples = SUMMARY_CASES.flatMap((c) => c.graded);

  it('[AI-013] has at least 12 cases, each with a passing reference and two or three flawed summaries', () => {
    expect(SUMMARY_CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(SUMMARY_CASES.map((c) => c.id)).size).toBe(SUMMARY_CASES.length);
    expect(new Set(examples.map((g) => g.id)).size).toBe(examples.length);
    for (const c of SUMMARY_CASES) {
      const passes = c.graded.filter((g) => g.expected === 'pass');
      const fails = c.graded.filter((g) => g.expected === 'fail');
      expect(passes, c.id).toHaveLength(1);
      expect(fails.length, c.id).toBeGreaterThanOrEqual(2);
      expect(fails.length, c.id).toBeLessThanOrEqual(3);
      for (const g of fails) expect(g.fails.length, g.id).toBeGreaterThan(0);
      for (const g of passes) expect(g.fails, g.id).toEqual([]);
      expect(c.ticket.comments.length, c.id).toBeGreaterThanOrEqual(4);
    }
  });

  it('[AI-013] the flawed summaries cover missing next steps, invented facts, missing comments and leaks', () => {
    const failed = new Set(examples.flatMap((g) => g.fails));
    for (const id of [
      'next-steps',
      'grounded',
      'citations-resolve',
      'no-restricted',
      'blockers',
      'status',
      'assignee',
      'length',
    ]) {
      expect(failed, id).toContain(id);
    }
    // Each of the four the eval is built around, several times.
    const count = (id: string) => examples.filter((g) => (g.fails as string[]).includes(id)).length;
    expect(count('next-steps')).toBeGreaterThanOrEqual(5);
    expect(count('grounded')).toBeGreaterThanOrEqual(4);
    expect(count('citations-resolve')).toBeGreaterThanOrEqual(4);
    expect(count('no-restricted')).toBeGreaterThanOrEqual(6);
  });

  it('[AI-013] the automatic grader agrees with every graded example', () => {
    const agreement = graderSelfCheck();
    expect(agreement).toHaveLength(examples.length);
    expect(agreement.filter((a) => !a.agrees)).toEqual([]);
  });

  it('[AI-013] restricted comments carry the markers and the reader of each case cannot see them', () => {
    for (const c of SUMMARY_CASES) {
      const restricted = c.ticket.comments.filter((x) => x.restrictedTo);
      expect(restricted.length > 0, c.id).toBe(c.markers.length > 0);
      for (const x of restricted) {
        expect(person(c.asUser).groups, c.id).not.toContain(x.restrictedTo);
        expect(readable(c, x.ref), c.id).toBe(false);
        expect(
          c.markers.some((m) => x.text.includes(m)),
          `${c.id} ${x.ref}`,
        ).toBe(true);
      }
      // A marker is nowhere the reader can see.
      for (const m of c.markers) expect(sourceText(c).toLowerCase()).not.toContain(m.toLowerCase());
    }
  });

  it('[AI-013] every example marks in its text exactly the comments it cites', () => {
    for (const g of examples) {
      const marks = [...g.text.matchAll(/\[(c\d+)\]/g)].map((m) => m[1]);
      expect([...new Set(marks)].sort(), g.id).toEqual([...g.cites].sort());
    }
  });

  it('[AI-013] the grader names the leak, the missing comment and the invented fact', () => {
    const [first] = SUMMARY_CASES;
    if (!first) throw new Error('no cases');
    const reference = first.graded[0] as { text: string; cites: readonly string[] };
    expect(gradeSummary(first, reference).pass).toBe(true);
    const leak = gradeSummary(first, {
      text: `${reference.text} ORCHID LANTERN.`,
      cites: reference.cites,
    });
    expect(leak.failed).toEqual(['no-restricted']);
    const ghost = gradeSummary(first, { text: reference.text, cites: [...reference.cites, 'c12'] });
    expect(ghost.details.join()).toContain('c12 is not a comment of this ticket');
    const invented = gradeSummary(first, {
      text: `${reference.text} Hiro Tanaka signed it off for 2.4.`,
      cites: reference.cites,
    });
    expect(invented.failed).toEqual(['grounded']);
    expect(invented.details).toEqual([
      'grounded: person Hiro Tanaka is not in the ticket',
      'grounded: number 2.4 is not in the ticket',
    ]);
    // The ticket's own key is grounded; another key is not.
    expect(
      gradeSummary(first, { text: `${reference.text} WEB-70.`, cites: reference.cites }, 'WEB-70')
        .pass,
    ).toBe(true);
    expect(
      gradeSummary(first, { text: `${reference.text} WEB-71.`, cites: reference.cites }, 'WEB-70')
        .failed,
    ).toEqual(['grounded']);
  });

  it('[AI-013] the rubric names every criterion and the judge prompt every judged one', () => {
    const rubric = readFileSync(new URL('./rubric.md', import.meta.url), 'utf8');
    const judge = readFileSync(new URL('./judge-prompt.md', import.meta.url), 'utf8');
    for (const id of [...AUTOMATIC, ...JUDGED]) expect(rubric, id).toContain(`\`${id}\``);
    for (const id of JUDGED) expect(judge, id).toContain(`\`${id}\``);
    for (const id of AUTOMATIC) expect(judge).not.toContain(`\`${id}\``);
  });
});
