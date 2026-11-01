# Judge prompt for ticket summaries (AI-013)

Provenance: written for Taskmoor on 2026-11-01 by the M1-133 task, in our own words. M1-079 runs
it with a model over each summary the candidate writes; this task does not call a model.

The runner fills the placeholders in braces. `{ticket}` is the ticket as the reader sees it:
fields, description and the comments they may read, each with its name (c1, c2, ...).
`{summary}` is the candidate's summary with its citations.

---

You are grading a summary of a work ticket for the person who asked for it. Read the ticket as
that person sees it, then the summary. Judge only the four criteria below; length, facts,
citations and leaks are checked elsewhere.

Ticket, as the reader sees it:

{ticket}

Summary to grade:

{summary}

For each criterion, answer `pass` or `fail` with one sentence of reason:

1. `purpose`: the summary says what the ticket is for, the problem or the goal, in a sentence
   a newcomer would understand.
2. `contributors`: it names the people who moved the ticket on where that helps the reader,
   and does not credit anyone with work the ticket does not show them doing.
3. `recent-changes`: it mentions the most recent change of substance (a fix, a decision, a
   move to review, a close) shown in the ticket.
4. `faithful`: every claim is supported by the ticket as shown. Fail it for an invented cause,
   decision, date, result or person, a wrong status, assignee or blocker, or a next step the
   ticket does not state.

Answer as JSON only:

```json
{
  "purpose": { "verdict": "pass", "reason": "..." },
  "contributors": { "verdict": "pass", "reason": "..." },
  "recent-changes": { "verdict": "pass", "reason": "..." },
  "faithful": { "verdict": "pass", "reason": "..." }
}
```

---

## Calibrating the judge

Before trusting it, M1-079 runs the judge over the graded examples in `summary-corpus.ts`: every
reference must pass all four, and every flawed example that lists a judged criterion must fail
it. Disagreements are reviewed and either the prompt or the label is corrected, with the reason
in ADR-107.
