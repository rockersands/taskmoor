# ADR-058: Flow reports from status changes, cycle time over chosen columns

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-061

## Context

RPT-001 asks for the reports of any board: cumulative flow, the control chart (a cycle time
scatter with a rolling average and a choice of averaging method) and the cycle time report, from
the status history mapped to the board's columns. Its third acceptance check: the control chart
supports at least two rolling-average methods and excludes chosen columns. M1-061 adds time in
status (the data behind M1-064's "average time in status" and "average number of times in
status" widgets). Done-when: golden tests green, and 100,000 tickets computed in under 5 s.
M1-059 (ADR-056) made the change history the report store; M1-060 (ADR-057) set the chart form.

## Decision

- **Status changes only.** `readStatusChanges` (`reports/events.ts`) reads the `status` rows of
  `ticket_change` for the board's tickets, grouped per ticket in time order. The pure functions
  in `reports/flow.ts` compute every report from them and the board's columns, so a past window
  replays identically. The board's tickets are its query, sub-filter and the active board
  filters, as the viewer sees them, compiled by the search compiler (the board read of M1-043).
- **Days are the viewer's.** A window is local days on the viewer's zone (`from` and `to`, or
  `days` up to `to`; 30 by default, at most 731). A change at midnight belongs to the day it
  starts, as in the burndown.
- **Cumulative flow**: tickets per column at the end of each day, up to today. Each change adds
  one to its new column and takes one from its old one from the first day that ends after it;
  prefix sums make the days, so the cost follows the number of changes, not tickets times days.
  A status no column maps counts apart (unmapped) and is named under the chart.
- **Cycle time**: the person chooses the columns that count as work (by default those between
  the first and the last). A ticket finishes when it moves from a column at or left of the last
  chosen one to a column right of it; its cycle time is all the time it spent in chosen columns
  up to then, so time in a column left out (blocked, waiting) does not count. One point per
  ticket, at its last finish in the window. A ticket that never entered a chosen column has no
  cycle time.
- **Two rolling averages**, both centred so the line does not lag the points: over a number of
  neighbouring tickets (a fifth of the points by default), or over the tickets finished within a
  number of days around each point (7 by default). The standard deviation over the same window
  draws the band. Prefix sums keep both linear. Statistics: count, average, median, 85th and 95th
  percentile (nearest rank), minimum, maximum. The distribution uses the narrowest bin of 1, 2,
  4, 8 or 12 hours, or 1, 2, 3, 7, 14 or 30 days, that needs at most 20 bins.
- **Time in status**: per status, the time the board's tickets spent in it inside the window
  (clipped to it), the tickets that were in it, and how often they entered it (creation counts
  as an entry).
- **Routes**: `GET /api/v1/boards/:id/reports/cumulative-flow`, `/cycle-time` (one endpoint
  for the control chart and the distribution; `columns`, `average`, `window`; the newest 2,000
  points by default, up to 10,000, with the statistics over all) and `/time-in-status`.
  Durations in seconds. Read scope for tokens, like every GET.
- **Web**: `#/boards/<id>/reports/<report>`, linked from every board. Two new chart forms on
  ADR-057's base: stacked areas for ordered stages (one blue from light to dark by column order,
  an ordinal ramp mixed in oklab between `--color-flow-first` and `--color-flow-last`, validated
  per skin, a 2px surface line between stages, the last column at the bottom) and a scatter
  with the rolling average and its band (dots in the first hue, the average in the second).

## Options considered

| Option | For | Against |
|---|---|---|
| Compute in the server process from status changes (chosen) | One read, plain code, golden-testable; 100,000 tickets in about 2 s | Memory grows with the history read (a few hundred thousand rows here) |
| Compute in SQL (window functions per ticket) | Less data over the wire | Cycle time over chosen columns and centred rolling windows are awkward in SQL; harder to test by hand |
| Daily snapshots per column | Instant cumulative flow | Cannot answer cycle time or time in status; days are not moments; storage grows with days (ADR-056) |
| A hue per column | Familiar | Categorical palettes stop at about eight and say nothing about order; boards have up to 30 columns |
| Trailing rolling averages | Common | Lag behind the points by half a window |

## Consequences

- Measured at 100,000 tickets (about 370,000 status rows) over 90 days: each report in 1.2 to
  1.9 s on the development Mac over two runs (`board-reports.large.test.ts`,
  `TASKMOOR_LARGE_REPORTS=1`).
  Larger boards read more rows; a status-only index on `ticket_change`, or a rollup, can come
  when a budget needs it.
- The control chart lists at most 10,000 points; its statistics and averages always count all.
- Not yet: swimlane selection on reports, outcome and release selectors (M1-062), and export
  (RPT-009).
