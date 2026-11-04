---
title: "Dashboards and reports"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/dashboards/DashboardsPage.tsx, apps/web/src/dashboards/DashboardPage.tsx, apps/web/src/dashboards/WidgetSettings.tsx, apps/web/src/dashboards/WidgetView.tsx, apps/web/src/sprints/SprintReportPage.tsx, apps/web/src/reports/BoardReportsPage.tsx, apps/web/src/tracks/TrackStatisticsPage.tsx, apps/web/src/tracks/BoardInTrack.tsx, apps/server/src/routes/track-summary.ts, apps/server/src/dashboards/widgets.ts, docs/adr/0116-one-place-per-track.md, apps/web/src/reports/ScopeReports.tsx, apps/web/src/i18n/messages.en.ts, apps/server/src/reports/scope-burndown.ts, apps/server/src/reports/general.ts, apps/server/src/routes/scope-reports.ts, docs/adr/0054-sprints.md, docs/adr/0057-sprint-charts.md, docs/adr/0058-flow-reports.md, docs/adr/0059-general-and-release-reports.md, docs/adr/0060-dashboards.md, docs/specs/00-terminology.md, docs/specs/01c-core-work-tracking.md, apps/web/src/dashboards/WidgetEditor.tsx, apps/web/src/shell/pointerDrag.ts, docs/adr/0114-glass-interface-and-clear-sections.md
accessed: 2026-11-03
attestation: own-words
---
# Dashboards and reports

Dashboards gather widgets on one page. Reports chart how a track's work moves, and all of them sit
in the track's **Statistics** section.
Both are computed for the person looking at them, so they never count a ticket that person may
not see.

## Dashboards

**Dashboards** in the navigation lists **Yours** and those **Shared with you**. To make one,
type a name under **New dashboard** and press **Create dashboard**.

A dashboard shows its widgets in columns (one column on a phone) and who owns it. Its owner and
site administrators see these buttons:

- **Edit dashboard** changes it in place (see below).
- **Who sees it**: **Only me**, **Everyone signed in** or **Anyone, signed in or not**. A
  dashboard shared with chosen people and groups through the [REST API](../admin/rest-api.md)
  shows **Chosen people and groups**.

Everyone who sees a dashboard can **Copy** it, which makes a dashboard of their own without its
sharing, and open it as a **Wallboard**. Site administrators can **Make it everyone's home**:
that dashboard is then marked as everyone's home dashboard and every signed-in person can see
it.

### Editing a dashboard

1. Press **Edit dashboard**.
2. Change the **Name** and the **Layout**: **One column**, **Two columns**, **Two columns, the
   left one wide**, **Two columns, the right one wide** or **Three columns**.
3. Pick a **Widget to add** and press **Add widget**. Each widget has **Settings**, **Up**,
   **Down**, **Left**, **Right** and **Remove**.
4. In a widget's settings, give it an optional title and fill in its fields, then **Apply**.
5. Press **Save dashboard**, or **Cancel**. **Delete dashboard** removes it after asking.

If someone else saved the dashboard meanwhile, reload it and make your change again.

#### Arranging widgets

While you edit, move a widget in any of these ways:

- Drag it by its grip (the six dots before its title), with a mouse or a finger, or by its title
  with a mouse, and let go at a place in any column. The column and the place are outlined on the
  way. An empty column says so and still takes a widget. **Escape** puts the widget back.
- Press **Up**, **Down**, **Left** or **Right** on the widget.
- On any of the widget's buttons, press Alt with an arrow key for the same move; the keyboard stays
  on the button of that arrow.

After each move, a screen reader hears where the widget is now, such as "Alpha is now in column 2,
1 of 2". Nothing is kept until you press **Save dashboard**. A track's customized
[summary](views.md#customizing-the-summary) is arranged the same way.

### Widgets

Every widget takes an optional **Title**. A **Query** left empty means every ticket you can
see.

| Widget | Settings | Shows |
|---|---|---|
| **Introduction** | **Text** | A piece of text |
| **Quick links** | **Links**, each a **Label** and an **Address** | A list of links |
| **Search results** | **Query**, **Tickets to show** | The first tickets the query finds |
| **Assigned to me** | **Tickets to show** | Your tickets |
| **Followed tickets** | **Tickets to show** | Tickets you follow |
| **Created vs closed** | **Query**, **Days back**, **Group by**, **Running totals** | Tickets created and closed per day, week or month |
| **Recently created** | **Query**, **Days back**, **Group by** | Tickets created per period |
| **Average age** | **Query**, **Days back**, **Group by** | How old the open tickets were on average |
| **Time to close** | **Query**, **Days back**, **Group by** | How long tickets took to close on average |
| **Pie chart** | **Query**, **Field** | How tickets divide by a field's values |
| **Ticket statistics** | **Query**, **Field**, **Order** | Counts per value, in **The field's order** or **Most tickets first** |
| **Two-dimensional statistics** | **Query**, **Rows**, **Columns** | A table of counts by two fields |
| **Sprint burndown** | **Board** | The burndown of the board's active sprint |
| **Sprint health** | **Board** | **Time gone**, **Work done**, **Scope change** and **Remaining** |
| **Days remaining in the sprint** | **Board** | Days left in the active sprint |
| **Average time in status** | **Query**, **Days back** | Average time per ticket in each status |
| **Tickets by date** | **Query**, **Date**, **Days back**, **Group by**, **Running totals** | Tickets per period by the day they were created, updated, closed, are due or start |
| **Grouped tickets** | **Query**, **Field**, **Tickets to show** | The tickets of each value of a field: how many, how many are done, and the most recently updated |
| **Workload** | **Query**, **Field**, **Measure**, **Open tickets only**, **Show as** | The remaining or original estimate, or the time spent, added up per value, as a **Table** or a **Pie chart** |
| **Time tracking** | **Query**, **Tickets to show** | The original and remaining estimates and the time spent added up, against each other, with the tickets that have them |

Widgets group by status, priority, type, track, assignee, requester, creator, close reason,
labels, target and found-in release, area, or a custom field that groups. A field with more than
50 values keeps the most frequent and counts the rest as **Other**. A ticket with several values
counts under each.

In **Created vs closed**, a closing is the moment a close reason is set, so a ticket closed,
reopened and closed again counts twice. **Tickets by date** counts each ticket once, by the date
it has now. A ticket is done when its status is in the closed stage, the same rule progress uses
everywhere. **Workload** and **Time tracking** add up time in hours, and say so when time
tracking is turned off on the site. Sprint widgets need a Scrum board you can see; when the
board has no active sprint, the widget says so.

### Wallboards

A wallboard shows a dashboard filling the window, without the navigation, and reads its widgets
again every five minutes. **Full screen** takes the whole screen and **Leave the wallboard**
goes back. To show several dashboards in turn, tick them on the dashboards list (**Show … on the
wallboard**), set **Seconds per dashboard**, and press **Start the wallboard**.

## A track's statistics

**Statistics**, in a track's tab bar, holds every report of that track, in five groups:

| Group | Reports |
|---|---|
| **Flow** | **Cumulative flow**, **Control chart**, **Cycle time**, **Time in status** |
| **Sprints** | **Sprint report**, **Velocity** |
| **Releases** | **Release burndown**, **Outcome burndown**, **Release report**, **Outcome report** |
| **Tickets** | **Created vs closed**, **Recently created**, **Average age**, **Time to close**, **Tickets by date**, **Pie chart**, **Ticket statistics**, **Two-dimensional statistics**, **Grouped tickets** |
| **Time and workload** | **Time tracking**, **Workload by person**, **Release workload**, **Workload pie chart** |

The **Reports** link on a board opens this section, and moving between reports stays inside the
track's tabs. Each report counts only the tickets you can see in the track, so two people may read
different numbers. A report with nothing to chart says so and what to try, such as a longer period.

Sprint and release reports follow sprints, so only a track with a Scrum board lists them. A Kanban
track does not list them. An old link to one says it needs a Scrum board, and those who may change
the board get a link to its settings. Flow, ticket, time and workload reports work on any board. On a Kanban track, a
customized Summary also leaves out sprint widgets: they stay in its editor, to take away.

### Ticket reports

These read the whole track, with no query to write:

- **Created vs closed**, **Recently created**, **Average age** and **Time to close**: choose the
  **Period** and how to group it (by day, week or month). **Created vs closed** can show **Running
  totals**.
- **Tickets by date**: how many tickets have a chosen **Date** (created, updated, closed, due or
  start) in each period, or a running total.
- **Pie chart** and **Ticket statistics**: how many tickets have each value of one **Field**.
- **Two-dimensional statistics**: a table of two fields against each other, as **Rows** and
  **Columns**. Custom fields can be chosen too.
- **Grouped tickets**: each value of a **Field** with its tickets, how many of them are done, and
  the most recently updated ones, each a link to the ticket.

Every number in these reports is the count of a search you could run yourself, such as `track =
PAY AND status = "Active"`, so a report and the search never disagree.

### Time and workload

These add up the time on the track's tickets, in hours:

- **Time tracking**: the **Original estimate**, **Time spent** and **Remaining** of the whole track
  or of one **Release**, whether the work is under or over the estimate, and the tickets with the
  most time spent. Time spent is the sum of the tickets' time entries.
- **Workload by person**: the remaining estimate of the open tickets per assignee, with how many
  have no estimate.
- **Release workload**: the same for the open tickets that target a chosen **Release**.
- **Workload pie chart**: a **Measure** (remaining or original estimate, or time spent) by any
  **Field**, as a pie, for the open tickets or all of them.

To count something narrower or across tracks, use the [widget](#widgets) of the same name on a
dashboard, where you can write a query.

## Sprint reports

Under **Statistics**, **Sprint report** opens the running sprint, or the latest one, and **Sprint**
chooses another that has started. A Scrum board's backlog also links each active sprint's
report. **Velocity** has its own tab too. A sprint report shows three charts, each with **Show the
numbers** for a table:

- **Burndown**: the work **Remaining** each day, against a **Guideline** that reaches zero on
  the sprint's planned last day.
- **Burnup**: the work **Completed** against the **Scope**.
- **Velocity**: work **Committed** and **Completed** in the board's last completed sprints (up
  to seven), with the average completed. It appears once the board has completed a sprint.

Below the charts are the totals (**Committed at the start**, **Added after the start**,
**Removed**, **Completed** and, with time tracking on, **Remaining estimate**) and the lists of
**Completed tickets**, **Tickets not completed** and **Tickets removed from the sprint**. Tickets
added after the start are marked, and estimates that changed show their old and new value.

Work is counted by the board's estimation setting: tickets, the original estimate or a number
field (see [Sprint settings](boards.md#sprint-settings)). With time tracking on and the original
estimate chosen, the remaining estimate burns down, so logging time lowers the line. A ticket is
completed when it reaches the board's rightmost column. Days end at midnight in your time zone.

## Board reports

Every board has a **Reports** link, which opens its track's [Statistics](#a-tracks-statistics).
A board that an upgrade left outside a track keeps a page of its own with just these reports:

| Report | What it shows |
|---|---|
| **Cumulative flow** | How many tickets were in each column at the end of each day |
| **Control chart** | One dot per finished ticket at its cycle time, a rolling average and a standard deviation band |
| **Cycle time** | How cycle times spread, in bars, and how long 85% of tickets took at most |
| **Time in status** | Per status: its column, the tickets that were in it, the average and total time and how often it was entered |

The controls above the chart:

- **Period**: the last 14, 30, 90, 180 or 365 days, or **Choose dates** with **From** and **To**.
- **Board filters**: count only the tickets the chosen filters keep.
- **Columns that count as work** (control chart and cycle time). A ticket finishes when it moves
  past the last chosen column; its cycle time adds up only the time spent in chosen columns.
- **Rolling average**: **Over neighbouring tickets** or **Over days**, and how many.

The control chart and cycle time show **Tickets**, **Average**, **Median**, **85th percentile**
and **95th percentile**. Reports read the status history, so a past period always shows the
same numbers. Tickets in statuses no column shows are counted apart and named under the chart.

### Release and outcome reports

These follow a Scrum board's sprints, counted by the board's estimation setting:

- **Release burndown**: choose a **Release** of the board's track.
- **Outcome burndown**: enter an outcome's key under **Outcome** and press **Show**.

Both show the **Remaining work** at the start of each sprint and now, the **Work per sprint**
(**Completed**, **Added** and **Removed**), and a forecast of how many more sprints the work
needs at the board's velocity (the average of its last three completed sprints).

- **Release report**: **Release progress**, the scope and the completed work day by day from
  the release's start, its planned or shipped date, and the day the work would be done at the
  pace of the last 14 days.
- **Outcome report**: enter an outcome's key and press **Show**. The same chart for the tickets
  under the outcome, from the day the first one joined it, with how many are **Done**, **Still
  open** and **Open without an estimate**, and the list of its tickets.

A release's own page in the releases hub also shows its progress, warnings and release notes:
see [Releases](boards.md#releases).
