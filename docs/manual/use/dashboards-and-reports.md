---
title: "Dashboards and reports"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/api/client.ts, apps/server/src/reports/zone.ts, apps/web/src/reports/DonutChart.tsx, apps/web/src/styles/dashboards.css, apps/web/src/tracks/client.ts, apps/web/src/dashboards/DashboardsPage.tsx, apps/web/src/dashboards/DashboardPage.tsx, apps/server/src/routes/dashboards.ts, apps/web/src/dashboards/WidgetSettings.tsx, apps/web/src/dashboards/WidgetView.tsx, apps/web/src/sprints/SprintReportPage.tsx, apps/web/src/reports/BoardReportsPage.tsx, apps/web/src/tracks/TrackStatisticsPage.tsx, apps/web/src/tracks/BoardInTrack.tsx, apps/server/src/routes/track-summary.ts, apps/server/src/dashboards/widgets.ts, docs/adr/0116-one-place-per-track.md, apps/web/src/reports/ScopeReports.tsx, apps/web/src/reports/client.ts, apps/web/src/reports/ReportTable.tsx, apps/web/src/reports/ColumnChart.tsx, apps/web/src/reports/LineChart.tsx, apps/web/src/styles/charts.css, apps/web/src/styles/boards.css, apps/web/src/shell/NotFoundPage.tsx, docs/plan/decisions.csv, apps/web/src/i18n/messages.en.ts, apps/server/src/reports/scope-burndown.ts, apps/server/src/reports/general.ts, apps/server/src/routes/scope-reports.ts, docs/adr/0054-sprints.md, docs/adr/0057-sprint-charts.md, docs/adr/0058-flow-reports.md, docs/adr/0059-general-and-release-reports.md, docs/adr/0060-dashboards.md, docs/specs/00-terminology.md, docs/specs/01c-core-work-tracking.md, apps/web/src/dashboards/WidgetEditor.tsx, apps/web/src/shell/pointerDrag.ts, docs/adr/0114-glass-interface-and-clear-sections.md, apps/web/src/i18n/days.ts, apps/web/src/i18n/zone.ts
accessed: 2026-11-22
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
it. A dashboard that only its owner saw is then shared with **Everyone signed in**, so **Who
sees it** says what is true.

### Editing a dashboard

1. Press **Edit dashboard**.
2. Change the **Name** and the **Layout**: **One column**, **Two columns**, **Two columns, the
   left one wide**, **Two columns, the right one wide** or **Three columns**.
3. Pick a **Widget to add** and press **Add widget**. Each widget has **Settings**, **Up**,
   **Down**, **Left**, **Right** and **Remove**.
4. In a widget's settings, give it an optional title and fill in its fields, then **Apply**.
5. Press **Save dashboard**, or **Cancel**. **Delete dashboard**, in the danger colour,
   removes it after asking: whoever it is shared with loses it too. Everyone's home dashboard
   has no **Delete dashboard**: make another dashboard everyone's home first.

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
[summary](views.md#customising-the-summary) is arranged the same way.

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

A pie chart widget with no title of its own is named by what it counts, such as **Tickets by
Status**. A table of counts heads its first column with the field it counts by, such as
**Priority**, and its share bars are as long as their shares. **Time to close** says **No ticket
was closed in this period** rather than drawing a line on zero hours, and a **Workload** pie with
no time to add up says which measure no ticket has, such as **No ticket here has a remaining
estimate**. Empty progress tracks keep a visible edge in both skins.

A dashboard that does not exist, or that is not shared with you, shows **Dashboard not found**
with the way to **Home** and to **Search**. One that cannot be read for another reason keeps its
header, **Dashboard**, and says so under it.

### Wallboards

A wallboard is a dashboard laid out for a TV or a wall screen, read from across a room: it fills
the window without the navigation, in large type, and reads its widgets again every five minutes.
Each card's title sits at its top with its content right under it, and a pie chart's ring grows
with the screen. It shows no controls: charts have no **Show the numbers**, and **Full screen**
and **Leave the wallboard** stay hidden in the screen's top corner, taking no room, until you
point at them or reach them with the keyboard. To show several
dashboards in turn, tick **On the wallboard** beside each on the dashboards list, set **Seconds
per dashboard** under **Wallboard**, and press **Start the wallboard**, which appears once one is
ticked.

## A track's statistics

**Statistics**, in a track's tab bar, holds every report of that track, titled **Statistics**
under the track's name. On a wide screen the reports are links in five groups, each group's label
in a column of its own; on a phone they are one **Report** picker, so the report itself shows on
the first screen:

| Group | Reports |
|---|---|
| **Flow** | **Cumulative flow**, **Control chart**, **Cycle time**, **Time in status** |
| **Sprints** | **Sprint report**, **Velocity** |
| **Releases** | **Release burndown**, **Outcome burndown**, **Release report**, **Outcome report** |
| **Tickets** | **Created vs closed**, **Recently created**, **Average age**, **Time to close**, **Tickets by date**, **Pie chart**, **Ticket statistics**, **Two-dimensional statistics**, **Grouped tickets** |
| **Time and workload** | **Time tracking**, **Workload by person**, **Release workload**, **Workload pie chart** |

Moving between reports stays inside the track's tabs. Each report counts only the tickets you can see in the track, so two people may read
different numbers. Reports and dashboard widgets count days on [your clock](account.md#your-time-zone)
(the time zone saved in your account, else your device's), the same days the calendar shows, so a
ticket created late in the evening counts on that day. A report with nothing to chart says so and what to try, such as a longer period.

Sprint and release reports follow sprints, so only a track with a Scrum board lists them. A Kanban
track does not list them, and the line under its title names only what it has: how its work
flows, its tickets and the time spent on them. An old link to one says it needs a Scrum board, and those who may change
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
  **Columns**, its corner naming the field of the rows. Its numbers align at their end. On a phone
  its cells draw closer so a handful of columns fits the card, **Total** included; a table wider
  than that scrolls sideways inside its card, the edge past which more columns wait faded.
- **Grouped tickets**: each value of a **Field** with its tickets, how many of them are done, and
  the most recently updated ones, each a link to the ticket. Keys, summaries and statuses sit in
  columns shared by every group. A group with more tickets than it lists says how many it shows
  and links to the search that finds all of them (**See all 20 in Search**). That search lists them
  in the report's order, most recently updated first, so it starts with the ones the group shows.
  It names a release, an area, a team or a ticket type by its number, so two of the same name,
  such as a track's own **Bug** type and the shared one, stay apart.

Wherever a report asks for a **Field**, **Rows** or **Columns**, the list also offers the custom
fields used in the track whose values group: select lists, people, groups, releases, areas, teams
and labels.

Every number in these reports is the count of a search you could run yourself, such as `track =
PAY AND status = "Active"`, so a report and the search never disagree.

### Time and workload

These add up the time on the track's tickets, in hours:

- **Time tracking**: the **Original estimate**, **Time spent** and **Remaining** of the whole track
  or of one **Release**, whether the work is under or over the estimate, and the tickets with the
  most time spent. Time spent is the sum of the tickets' time entries. With no original estimate
  on any ticket there is nothing to be under or over: the verdict reads **Nothing estimated to
  compare**, and when nothing is estimated or logged at all the report says **Nothing estimated or
  logged yet** instead of totals of zero. On a phone the three figures share a row and the
  verdict takes the next one.
- **Workload by person**: the remaining estimate of the open tickets per assignee, with how many
  have no estimate.
- **Release workload**: the same for the open tickets that target a chosen **Release**. It starts
  on the next release to ship, the first in the track's order that has not shipped, or, when all
  have shipped, the one that shipped last. A release with no open tickets, such as one that
  shipped, says **No open tickets target this release** and why.
- **Workload pie chart**: a **Measure** (remaining or original estimate, or time spent) by any
  **Field**, as a pie, for the open tickets or all of them.

To count something narrower or across tracks, use the [widget](#widgets) of the same name on a
dashboard, where you can write a query.

## Sprint reports

Under **Statistics**, **Sprint report** opens the running sprint, or the latest one, and **Sprint**
chooses another that has started. A Scrum board's backlog also links each active sprint's
report. **Velocity** has its own tab too. The track's **Backlog** tab leads back to the backlog. A
sprint report shows three charts, each with **Show the numbers** for a table:

- **Burndown**: the work **Remaining** each day, against a **Guideline** that reaches zero on
  the sprint's planned last day.
- **Burnup**: the work **Completed** against the **Scope**.
- **Velocity**: work **Committed** and **Completed** in the board's last completed sprints (up
  to seven), with the average completed. It appears once the board has completed a sprint.

Under its title the report says whether the sprint is **In progress** or when it finished, with
its planned dates, so a finished sprint's report never reads like the running one's. Below the
charts are the totals, on a card of their own (**Committed at the start**, **Added after
the start**, **Removed**, **Completed** and, with time tracking on, **Remaining estimate**), and the
tables of **Completed tickets**, **Tickets not completed** and **Tickets removed from the sprint**,
with a column each for **Key**, **Summary**, **Status** and **Estimate**; the status and estimate
columns have one width in every table, so the stacked tables line up. On a phone each row
takes two lines: the key and summary, then the status and the estimate. Tickets added after the
start are marked, and estimates that changed show their old and new value.

When the board estimates in time or with a number field and none of the sprint's tickets has an
estimate, the charts and the totals would only show zeros: the report says **No estimates to add
up** instead, and still lists the tickets. Velocity says the same when the completed sprints had
no estimates; when both have none, one card across the row says it for all the charts.

Work is counted by the board's estimation setting: tickets, the original estimate or a number
field (see [Sprint settings](boards.md#sprint-settings)). With time tracking on and the original
estimate chosen, the remaining estimate burns down, so logging time lowers the line. A ticket is
completed when it reaches the board's rightmost column. Days end at midnight on your clock.

## Board reports

A track's board reports are in its [Statistics](#a-tracks-statistics). A board that an upgrade left
outside a track has a **Reports** link and keeps a page of its own with just these reports:

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

Time in status shows its numbers in its table, with no second **Show the numbers** above it. A
report's table that is wider than the card scrolls sideways inside it, never cutting a word or a
number: its first column keeps room for a name, the edge past which more columns wait fades, and
the keyboard reaches the table to scroll it. **Show the numbers** has a chevron that turns once the
numbers show.

The control chart and cycle time show **Tickets**, **Average**, **Median**, **85th percentile**
and **95th percentile**. Reports read the status history, so a past period always shows the
same numbers. Tickets in statuses no column shows are counted apart and named under the chart.

### Release and outcome reports

These follow a Scrum board's sprints, counted by the board's estimation setting:

- **Release burndown**: choose a **Release** of the board's track. It starts on the next release
  to ship, else the one that shipped last; the **Release report** starts the same way.
- **Outcome burndown**: choose one of the track's outcomes under **Outcome**; the first is
  chosen to start with. A board outside any track asks for an outcome's key instead, with
  **Show**.

Both show the **Remaining work** at the start of each sprint and now, the **Work per sprint**
(**Completed**, **Added** and **Removed**), and a forecast of how many more sprints the work
needs at the board's velocity (the average of its last three completed sprints). Work done, added
or removed while no sprint ran has a column of its own, **Outside the sprints**, so the columns
add up to the sentence above them, and a sprint with nothing in it shows an empty slot rather than
zeros over it. When the estimates add up to nothing, the burndown says **No estimates to add up**
instead of charting zeros.

- **Release report**: **Release progress**, the scope and the completed work day by day from
  the release's start (without one, from the earliest of the day it was made, its first ticket
  and its release date), its planned date and the day the work would be done at the pace of the
  last 14 days. Its legend names what the lines add up, such as **Estimate in scope** and
  **Estimate completed** (or **Hours** or **Tickets**). Where the completed line runs along the
  scope line, as once all the work is done, the scope is drawn as a wider band beneath it, so
  both stay in sight. Once the release has shipped it says the day it shipped on, as its page does, and no
  forecast. These days carry their year, as the Releases list writes them (**Planned for
  Nov 30, 2026.**); the chart's axis keeps the short **Nov 30**.
- **Outcome report**: choose an outcome as for its burndown. **Outcome progress**: the same chart
  for the tickets under the outcome, from the day the first one joined it, its axis and legend
  naming what the lines add up (such as **Hours in scope**). Above it, counted in tickets: **Tickets
  done**, **Tickets still open** and **Open tickets without an estimate**; below it, the list of
  its tickets.

A release's own page in the releases hub also shows its progress, warnings and release notes:
see [Releases](boards.md#releases).
