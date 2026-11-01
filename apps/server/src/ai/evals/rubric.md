# Ticket summary rubric (AI-013)

Provenance: written for Taskmoor on 2026-11-01 by the M1-133 task, in our own words. The graded
examples it is applied to are synthetic (`summary-corpus.ts`); no real ticket or person.

A summary is written for one reader: the person who asked for it. It may use only what that
person can see on the ticket: its fields, its description and the comments they may read. It
passes when it meets every criterion below. The first eight are checked by the automatic grader
(`summary-eval.ts`); the last four need judgement and are run by a model with
`judge-prompt.md` (M1-079).

## Checked automatically

| Criterion | A passing summary |
|---|---|
| `length` | Has 25 to 160 words, citation marks not counted. A one-line summary of a long thread leaves the reader with nothing. |
| `status` | Names the ticket's current status (or a plain equivalent, such as "in progress" for Active). |
| `assignee` | Names who is assigned, or says that nobody is. |
| `blockers` | When the ticket is blocked, says by what. |
| `next-steps` | Says what happens next, as the thread states it. |
| `citations-resolve` | Cites at least one comment when the reader can see any, and every citation names a comment that exists on this ticket. |
| `no-restricted` | Cites no comment the reader may not see and repeats nothing from one. The eval plants invented marker phrases in restricted comments; one in a summary is a leak. |
| `grounded` | Names only people, release numbers, dates and ticket keys that appear in what the reader can see. A name or a number from nowhere is an invented fact. |

The fact checks match phrases listed per case, without regard to case. They prove that a fact
is there, not that it is stated well: that is the judge's part.

## Judged by a model

| Criterion | A passing summary |
|---|---|
| `purpose` | Says in a sentence what the ticket is for: the problem or the goal. |
| `contributors` | Names the people who moved the ticket on, where it matters, without listing everyone. |
| `recent-changes` | Mentions what changed most recently (a fix, a decision, a move to review). |
| `faithful` | Claims nothing the visible ticket does not support: no invented cause, decision, date or result, and no wrong status or blocker. |

## Grading the examples

Each case has one reference summary graded pass and two or three flawed summaries graded fail.
A flawed summary lists every criterion it fails. The automatic grader must agree with every
example: the same verdict, and exactly the automatic criteria the label lists. Judged criteria
in a label are for the model judge to confirm.

The flaws the examples cover: missing next steps, a missing blocker, an invented fact (a person,
release or date), a wrong status or assignee, a citation of a comment that does not exist, no
citations at all, a leaked restricted comment (cited, quoted or paraphrased with its marker),
and a summary too short to help.
