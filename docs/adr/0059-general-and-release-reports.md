# ADR-059: General reports counted in SQL; release and outcome burndowns from report events

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-062

## Context

M1-062 covers the rest of the agile reports in RPT-001 (release and outcome burndowns, the
release report) and two general ones (created vs closed, RPT-002 (1): "over a 90-day window
matches counts from history"; two-dimensional statistics, RPT-005 (2): "accepts any two fields
as axes"). Done-when: golden tests green. RPT-002 (3) wants each general report on 1M tickets in
under 3 s, and RPT-003 (1) that a past date gives the same numbers after later edits. The general
reports run over any query (a saved search, a track); the release and outcome reports over a
Scrum board's sprints. M1-064 turns several of them into dashboard widgets.

## Decision

- **General reports run over any query, counted in SQL.** `GET /api/v1/reports/created-vs-closed`
  and `/two-dimensional` take `query` (empty: every ticket the viewer sees; a saved search is
  `filter = "…"`), compiled with the viewer's ticket filter (`compileQuery` in `boards/data.ts`,
  the base `compileBoard` uses too). Each is a few `GROUP BY` statements, not a fold in the
  server process, so they scale with the database (`reports/general.ts`).
- **Created vs closed** counts per day, week (from Monday) or month on the viewer's calendar the
  tickets created and the closings: a close reason set where there was none, from the change
  history. Closings are events, so a ticket closed, reopened and closed again counts twice and a
  past period never changes when a ticket is reopened later.
- **Two-dimensional statistics** group by a system field (track, type, status, priority,
  assignee, requester, creator, close reason, labels, target and found-in release, area) or a
  custom field that groups (select, cascading select, user, group, release, area, labels). Each
  axis is the ticket's array of value ids, unnested, so a field with several values counts a
  ticket once under each and an empty one counts under "none"; row and column totals count
  tickets. Past 50 values an axis keeps the most frequent and gathers the rest as "other".
- **Release and outcome reports compute from report events** (ADR-056), like the burndown
  (ADR-057). The report events now follow `targetRelease` too (the replay check compares it with
  the live release rows). A release's tickets are those whose history ever names it; an
  outcome's, those ever under it; both as far as the viewer may see them now.
  `GET /api/v1/boards/:id/reports/release-burndown`, `/outcome-burndown` (by key or id) and
  `/release-report`, on Scrum boards (`routes/scope-reports.ts`), by the board's estimation
  statistic and done statuses.
- **Per sprint** (`reports/scope-burndown.ts`): the remaining work at each started sprint's start
  and end, and the work completed, added (tickets joining, estimates raised, done tickets
  reopened) and removed (tickets leaving, estimates lowered) during it. Each ticket's
  contribution is kept as it changes, so a step costs one ticket. Velocity is the average
  completed over the last three completed sprints; the forecast is the sprints still needed.
- **The release report** gives the scope and completed work at the end of each local day from
  the release's start (or the first day a ticket targeted it), the planned and shipped dates,
  and a forecast date at the pace of the last 14 days.
- **Web**: Scrum boards' reports page gains the three tabs (`ScopeReports.tsx`: the release from
  the board's track, the outcome by key). Created vs closed and two-dimensional statistics are
  API only until the M1-064 widgets.

## Options considered

| Option | For | Against |
|---|---|---|
| General reports in SQL over the compiled query (chosen) | One statement per count; the planner uses the indexes the search already has | Two-dimensional custom axes need a subquery per ticket on the side tables |
| Fold general reports from report events | One model for every report | Reads every ticket's history; does not meet 1M tickets in 3 s |
| Closings counted by the current close date | What a ticket field shows | Reopening a ticket later changes past periods (RPT-003 (1)) |
| Release burndown from sprint snapshots (`sprint_change`) | Already written per sprint | Sprints do not record release membership or tickets outside the sprint |

## Consequences

- `ticket_change` has no index on `(field, at)`: created vs closed reads the window's close
  reason rows through the ticket join. RPT-002 (3) (1M tickets in 3 s) is measured with M1-064;
  an index or a rollup comes then if needed.
- The forecast is a straight line at the recent velocity or pace, and the page says which.
- Not yet: release and outcome selectors on other reports, created vs closed and
  two-dimensional statistics in the web (M1-064 widgets), the outcome report.
- 2026-11-03 (T-076): the outcome report, time since, single level group by, time tracking and
  the three workload reports are built, and average age reads the history with one anti-join;
  see ADR-116, "Summary and Statistics finished".
