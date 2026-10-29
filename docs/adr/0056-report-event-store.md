# ADR-056: The report event store reads the change history and sprint changes

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-059

## Context

RPT-003 asks for append-only status, field, sprint-scope, estimate and membership history, so
any report can be computed as of any past date and gives the same numbers before and after
later edits. M1-059's done-when: replay recomputes reports identically from events. The
reports that follow (M1-060 burndown, burnup, sprint report and velocity; M1-061 control chart,
cumulative flow, cycle time; M1-062 release and outcome reports) all read the same facts over
time. Two append-only logs already hold them: `ticket_change` (M1-009: one row per changed
field of every ticket mutation, creation included, with old and new values) and
`sprint_change` (M1-044: added, removed, committed, completed and carried over, with the
estimates at that moment).

## Decision

- **No new table.** `apps/server/src/reports/events.ts` reads both logs as one ordered stream
  of typed report events per ticket: field events for track, type, status, close reason,
  assignee, parent, original and remaining estimate, time spent, the trash and custom number
  fields (`cf[<id>]`, story points), and sprint events. Ordered by time, then by the row that
  wrote them.
- **A state is a fold.** `fold` applies events from nothing (creation writes every first value)
  to a `ReportState` per ticket; `stateAt` folds the events up to a moment, so later edits
  cannot change a past report. A ticket is in a sprint from `added` until `removed`, `completed`
  or `carried_over`; `committed` marks the start without changing membership.
- **Replay is the integrity check.** `replayCheck` folds every event of a workspace's tickets to
  now, in batches, and compares with the tickets and their open sprint memberships; it names the
  ticket and field of every difference. A write that skipped the history (a direct update, a new
  code path that forgot `recordChanges`) shows up here, and in `node cli.mjs report-verify` for
  operators (exit 1 on a difference).
- Reports built on it compute from events only, so they replay identically; M1-044's sprint
  report already does (the test recomputes it from the sprint events).

## Options considered

| Option | For | Against |
|---|---|---|
| Read the existing append-only logs (chosen) | One source of truth, nothing to keep in step; imports and every mutation already write them | Report reads span two tables and filter `ticket_change` by field |
| A `report_event` table filled by an event-bus subscriber | One narrow table for reports | Written after the transaction, at least once: a copy that can drift or lag; the replay would check the copy, not the truth |
| Snapshots per day per ticket | Fast past-date reads | Days are not moments (scope change mid-day); storage grows with tickets times days |

## Consequences

- Reads use `ticket_change`'s primary key (ticket, id) per partition and `sprint_change`'s
  ticket index; M1-061's 100k-ticket budget is measured there, and a field index or a
  materialised daily rollup can come then if the budget needs it.
- Tickets created before migration 0015 have no creation rows: the replay check reports them as
  without history.
