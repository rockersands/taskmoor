import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { PEOPLE, person } from './dataset';
import type { Handle } from './model';
import { ratio } from './query-eval';
import type { EvalWorld } from './seed';
import {
  AUTOMATIC,
  type CriterionId,
  type GradedSummary,
  SUMMARY_CASES,
  type SummaryCase,
} from './summary-corpus';

/**
 * The summary eval (M1-133; AI-013; ADR-107): an automatic grader for what a summary can be
 * checked for without a model (`rubric.md`), its self-check against every graded example, and a
 * runner that asks a candidate summariser for each case's summary as the case's reader.
 *
 * The grader checks:
 * - length: 25 to 160 words, citation marks left out;
 * - status, assignee, blockers and next steps: a phrase of the case's facts is present;
 * - citations-resolve: at least one citation when the reader sees comments, and every citation
 *   names a comment of the ticket;
 * - no-restricted: no citation of a comment the reader may not see, and none of the marker
 *   phrases planted in those comments;
 * - grounded: every person, release number, date and ticket key the summary names appears in
 *   what the reader sees (the ticket's fields, description and visible comments).
 * Purpose, contributors, recent changes and faithfulness need judgement: `judge-prompt.md`.
 */
export interface Summary {
  text: string;
  /** The comments cited, by their names in the thread (c1, c2, ...). */
  cites: readonly string[];
}

export interface Grade {
  pass: boolean;
  failed: CriterionId[];
  details: string[];
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const mentions = (text: string, phrase: string) =>
  new RegExp(`(^|[^\\p{L}\\p{N}])${literal(phrase)}($|[^\\p{L}\\p{N}])`, 'iu').test(text);

/** Whether the case's reader may read a comment. */
export function readable(c: SummaryCase, ref: string): boolean {
  const comment = c.ticket.comments.find((x) => x.ref === ref);
  if (!comment) return false;
  return !comment.restrictedTo || person(c.asUser).groups.includes(comment.restrictedTo);
}

/** Everything the reader sees of the ticket, as text: what a summary may draw on. */
export function sourceText(c: SummaryCase): string {
  const t = c.ticket;
  const name = (h: Handle | null) => (h ? person(h).name : '');
  const due = t.due ? new Date(`${t.due}T00:00:00Z`) : null;
  return [
    t.summary,
    t.description,
    t.status,
    t.priority ?? '',
    name(t.creator),
    name(t.assignee),
    ...t.labels,
    ...t.areas,
    t.targetRelease ?? '',
    t.foundIn ?? '',
    t.due ?? '',
    due ? `${MONTHS[due.getUTCMonth()]} ${due.getUTCDate()}` : '',
    ...t.comments.filter((x) => readable(c, x.ref)).flatMap((x) => [name(x.author), x.text]),
  ].join('\n');
}

const words = (text: string) =>
  text
    .replace(/\[c\d+\]/g, ' ')
    .split(/\s+/)
    .filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

/** Grades a summary of a case on the automatic criteria. */
export function gradeSummary(c: SummaryCase, summary: Summary, ownKey?: string): Grade {
  const failed = new Set<CriterionId>();
  const details: string[] = [];
  const miss = (id: CriterionId, why: string) => {
    failed.add(id);
    details.push(`${id}: ${why}`);
  };
  const text = summary.text;

  const n = words(text);
  if (n < 25 || n > 160) miss('length', `${n} words, not 25 to 160`);
  const facts = c.facts;
  const present = (list: readonly string[]) => list.some((p) => mentions(text, p));
  if (!present(facts.status)) miss('status', `none of ${facts.status.join(', ')}`);
  if (!present(facts.assignee)) miss('assignee', `none of ${facts.assignee.join(', ')}`);
  if (facts.blocker && !present(facts.blocker))
    miss('blockers', `none of ${facts.blocker.join(', ')}`);
  if (!present(facts.nextSteps)) miss('next-steps', `none of ${facts.nextSteps.join(', ')}`);

  const visible = c.ticket.comments.filter((x) => readable(c, x.ref));
  if (visible.length > 0 && summary.cites.length === 0)
    miss('citations-resolve', 'cites no comment');
  for (const ref of summary.cites) {
    if (!c.ticket.comments.some((x) => x.ref === ref)) {
      miss('citations-resolve', `${ref} is not a comment of this ticket`);
    } else if (!readable(c, ref)) {
      miss('no-restricted', `cites ${ref}, which the reader may not see`);
    }
  }
  for (const marker of c.markers) {
    if (mentions(text, marker))
      miss('no-restricted', `shows "${marker}" from a restricted comment`);
  }

  const source = sourceText(c);
  const invented = (what: string, value: string) =>
    miss('grounded', `${what} ${value} is not in the ticket`);
  for (const p of PEOPLE) {
    const [first, ...rest] = p.name.split(' ');
    const forms = [p.name, first as string, rest.join(' ')].filter((f) => f.length > 0);
    const named = forms.some((f) => mentions(text, f));
    if (named && !forms.some((f) => mentions(source, f))) invented('person', p.name);
  }
  for (const m of text.matchAll(/\b\d+\.\d+(?:\.\d+)?\b/g)) {
    if (!mentions(source, m[0])) invented('number', m[0]);
  }
  for (const m of text.matchAll(/\b\d{4}-\d{2}-\d{2}\b/g)) {
    if (!source.includes(m[0])) invented('date', m[0]);
  }
  for (const m of text.matchAll(new RegExp(`\\b(${MONTHS.join('|')}) \\d{1,2}\\b`, 'g'))) {
    if (!source.includes(m[0])) invented('date', m[0]);
  }
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9]+-\d+\b/g)) {
    if (m[0] !== ownKey && !source.includes(m[0])) invented('ticket', m[0]);
  }
  const list = AUTOMATIC.filter((id) => failed.has(id));
  return { pass: list.length === 0, failed: list, details };
}

export interface Agreement {
  example: string;
  expected: GradedSummary['expected'];
  got: 'pass' | 'fail';
  /** The automatic criteria the label names and the grader found, when they differ. */
  labelled: CriterionId[];
  found: CriterionId[];
  agrees: boolean;
}

/** The grader against every graded example: the verdict and the automatic criteria failed. */
export function graderSelfCheck(cases: readonly SummaryCase[] = SUMMARY_CASES): Agreement[] {
  return cases.flatMap((c) =>
    c.graded.map((g) => {
      const grade = gradeSummary(c, { text: g.text, cites: g.cites });
      const labelled = AUTOMATIC.filter((id) => g.fails.includes(id));
      const got = grade.pass ? 'pass' : 'fail';
      return {
        example: g.id,
        expected: g.expected,
        got,
        labelled,
        found: grade.failed,
        agrees: got === g.expected && labelled.join() === grade.failed.join(),
      };
    }),
  );
}

/** What a summariser is given: the ticket, and the app as the person who asked. */
export interface SummaryInput {
  caseId: string;
  ticketId: number;
  ticketKey: string;
  user: { handle: Handle; id: number; name: string };
  /** Requests to the app as that person: a summariser reads only what they may see. */
  request: (options: InjectOptions) => Promise<LightMyRequestResponse>;
  world: EvalWorld;
}
export interface SummaryOutput {
  text: string;
  /** The ids of the comments the summary cites. */
  citations: readonly number[];
}
export type SummaryCandidate = (input: SummaryInput) => Promise<SummaryOutput> | SummaryOutput;

export interface SummaryCaseOutcome {
  id: string;
  pass: boolean;
  failed: CriterionId[];
  details: string[];
  text: string;
}
export interface SummaryReport {
  feature: 'summary';
  candidate: string;
  /** The grader's agreement with the graded examples. */
  grader: { examples: number; agree: number; score: number; disagreements: Agreement[] };
  /** A candidate's summaries on the automatic criteria; judged criteria wait for M1-079. */
  total: number;
  passed: number;
  score: number;
  /** Whether a model graded the judged criteria too (`judge.ts`), or they wait for one. */
  judged: 'pending' | 'judged';
  failures: SummaryCaseOutcome[];
  outcomes: SummaryCaseOutcome[];
}

/**
 * A weak baseline: the ticket's summary, status and assignee, and the first comment the reader
 * sees, cited. It has no next steps or blockers, so it fails where those matter.
 */
export const firstCommentBaseline: SummaryCandidate = async (input) => {
  const ticket = (
    await input.request({ method: 'GET', url: `/api/v1/tickets/${input.ticketId}` })
  ).json().ticket as {
    summary: string;
    status: { name: string };
    assignee: { name: string } | null;
  };
  const comments = (
    await input.request({
      method: 'GET',
      url: `/api/v1/tickets/${input.ticketId}/comments?format=text`,
    })
  ).json().comments as { id: number; body: string }[];
  const first = comments[0];
  const text = [
    `${ticket.summary}.`,
    `Status: ${ticket.status.name}.`,
    ticket.assignee ? `Assigned to ${ticket.assignee.name}.` : 'Unassigned.',
    first ? `The first comment says: ${String(first.body).trim()}` : '',
  ].join(' ');
  return { text, citations: first ? [first.id] : [] };
};

export async function runSummaryEval(
  world: EvalWorld | null,
  candidate: SummaryCandidate | null,
  name: string,
  cases: readonly SummaryCase[] = SUMMARY_CASES,
): Promise<SummaryReport> {
  const agreement = graderSelfCheck(cases);
  const outcomes: SummaryCaseOutcome[] = [];
  if (world && candidate) {
    for (const c of cases) {
      const seeded = world.tickets[c.ticket.name];
      if (!seeded) throw new Error(`${c.id} is not in the dataset`);
      const refOf = new Map(Object.entries(seeded.comments).map(([ref, id]) => [id, ref]));
      const u = world.people[c.asUser];
      const out = await candidate({
        caseId: c.id,
        ticketId: seeded.id,
        ticketKey: seeded.key,
        user: { handle: c.asUser, id: u.id, name: u.name },
        request: (options) => world.as(c.asUser, options),
        world,
      });
      const cites = out.citations.map((id) => refOf.get(id) ?? `#${id}`);
      const grade = gradeSummary(c, { text: out.text, cites }, seeded.key);
      outcomes.push({
        id: c.id,
        pass: grade.pass,
        failed: grade.failed,
        details: grade.details,
        text: out.text,
      });
    }
  }
  const agree = agreement.filter((a) => a.agrees).length;
  const passed = outcomes.filter((o) => o.pass).length;
  return {
    feature: 'summary',
    candidate: name,
    grader: {
      examples: agreement.length,
      agree,
      score: ratio(agree, agreement.length),
      disagreements: agreement.filter((a) => !a.agrees),
    },
    total: outcomes.length,
    passed,
    score: ratio(passed, outcomes.length),
    judged: 'pending',
    failures: outcomes.filter((o) => !o.pass),
    outcomes,
  };
}
