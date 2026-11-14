---
title: "List, calendar, timeline and outcomes"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/tracks/TrackOutcomesPage.tsx, apps/server/src/routes/track-outcomes.ts, apps/server/src/tickets/progress.ts, apps/web/src/tracks/TrackSummaryPage.tsx, apps/web/src/shell/DangerAction.tsx, apps/web/src/tracks/TrackNumbers.tsx, apps/web/src/tracks/TrackLayout.tsx, apps/server/src/routes/track-summary.ts, apps/server/src/dashboards/widgets.ts, docs/adr/0116-one-place-per-track.md, apps/web/src/list/ListPage.tsx, apps/web/src/list/GroupSection.tsx, apps/web/src/shell/seededNames.ts, apps/web/src/shell/priorityName.ts, apps/web/src/search/ColumnPicker.tsx, apps/web/src/search/ResultTable.tsx, apps/web/src/calendar/CalendarPage.tsx, apps/web/src/timeline/TimelinePage.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0060-dashboards.md, docs/adr/0064-timeline.md, docs/adr/0065-list-and-calendar-views.md, docs/specs/01b-core-work-tracking.md, apps/web/src/calendar/CalendarView.tsx, apps/web/src/timeline/TimelineView.tsx, apps/web/src/timeline/touch.ts, apps/web/src/styles/timeline.css, apps/web/src/styles/views.css, apps/web/src/timeline/dependencies.ts, apps/web/src/timeline/refusal.ts, apps/web/src/dashboards/WidgetEditor.tsx, apps/web/src/shell/MoveMenu.tsx, apps/web/src/shell/pointerDrag.ts, docs/adr/0114-glass-interface-and-clear-sections.md, docs/plan/page-review-findings.md, apps/web/src/shell/Popover.tsx, docs/plan/decisions.csv, apps/web/src/styles/dashboards.css, apps/web/src/tracks/outcomeManager.ts, apps/web/src/styles/surfaces.css, apps/server/src/routes/tickets.ts
accessed: 2026-11-14
attestation: own-words
---
# List, calendar, timeline and outcomes

Every track has three views of its tickets besides its board: a list, a calendar and a
timeline, and a list of its outcomes with their progress. Each shows only the tickets you may see.
You reach them from the track's summary.

## The track summary

A track's summary is at the address ending in `tracks/` and the track's key, for example
`tracks/PAY`. Like every page of the track it is titled by its section, **Summary**, with the
track's name above it. It shows:

- **Open**, **Created in the last 7 days**, **Closed in the last 7 days**, **Updated in the last
  7 days** and **Open and due within 7 days**;
- the tickets **By stage**, and the open ones **Open by priority**, **Open by type** and **Open
  by assignee** (the ten people with most).

The five numbers sit on one line however their labels wrap; on a phone they go two to a row with
the last across the row, and the four lists one or two to a row, never three and a lone fourth,
each card as tall as its own list.
Every number is a link to the search that finds exactly those tickets. The tab bar above it holds
the track's other sections, such as its [**Releases**](boards.md#releases),
[**Statistics**](dashboards-and-reports.md#a-tracks-statistics), **Timeline**,
[**Outcomes**](#outcomes), **List** and **Calendar**.

### Filtering the summary for yourself

Anyone who can see the track can narrow its summary to the tickets they care about, without
changing it for anyone else. Under the title, **Only tickets that match** takes a condition in the
[search language](search.md), for example `assignee = currentUser()` or `type = Bug`. **Filter**
checks it as a search would and then applies it; **My tickets** fills in and applies
`assignee = currentUser()`; **Clear the filter** takes it away. A filter that does not read as a
search is refused with a message, and the summary stays as it was.

With a filter on, every number and every widget counts only the tickets that also match it, and
the page says which filter is on. Each number still opens the search that finds exactly its
tickets, with your filter in it. Sprint widgets (burndown, sprint health, days remaining) read a
whole sprint rather than a query, so they stay as they are, and the page says so.

The filter is yours alone. It is kept in the page's address (`tracks/PAY?filter=...`), so it
survives a reload and you can bookmark the filtered summary or send yourself the link; anyone who
opens that link sees the summary filtered the same way, as far as they may see. Nothing is saved
on the server, and the summary the owner set up does not change. Pressing **Customise** shows the
widgets unfiltered, as everyone will see them.

### Customising the summary

The track's owner and its administrators see **Customise**. It starts from the numbers above, as
one widget called **This track’s numbers**, so nothing is lost. They can then choose a **Layout**
of one to three columns, add any [widget](dashboards-and-reports.md#widgets) with **Widget to
add**, set each one up, move them (by drag, by their buttons or with Alt and the arrow keys, as
on a [dashboard](dashboards-and-reports.md#arranging-widgets)) and remove them, and press **Save the
summary**. The numbers can be
removed and added back. Nobody has to set this up: a track shows its default summary until someone
does.

Everyone else who can see the track reads the same widgets, filtered for themselves if they wish,
and has no controls to change them: only the owner and administrators customize it for everyone.
Each widget is read as the person looking at it, through the same permission filter as a search,
so two people can read different numbers and nobody sees a ticket they could not find themselves.

On a track's summary:

- a widget with an empty query counts the track, not every ticket;
- **Assigned to me** and **Followed tickets** list only the viewer's tickets in this track;
- a widget's query that you do write is used as written, so it can count another track, for those
  who may see that track;
- the sprint widgets read the track's board, and need it to be a Scrum board; a Kanban track's
  editor offers every other widget, the time and workload ones included.

**Back to the default** removes the customization for everyone, so it asks first. Its button has the
danger colour of an action that removes something; pressing it does nothing yet, and in its place
the page says that the track's summary returns to the default for everyone, that the widgets chosen
for it are removed, and that this cannot be undone. **Reset the summary of** and the track's name
does it; **Cancel** or Escape leaves everything as it was. Afterwards the page says the track shows
its default summary again. If you may not change the summary, it says so and the question stays
open. If someone else saved a change while you were editing, saving says so, and nothing is
overwritten. An archived track's summary cannot be changed until the track is restored.

A customized summary is not a dashboard: it belongs to the track, and it does not appear under
**Dashboards**.

## The list view

**List** is titled **List**, with the track's name above it, and its help mark explains the page.
It shows the track's tickets in a table, fifty at a time; **Show more** adds the next fifty. It
is the search results table, so cells such as the summary, assignee, priority, labels and dates
can be edited in place (see [search results](search.md#search-results)). The summary takes the
width the other columns leave, and short values and dates stay on one line. A ticket with
subtickets shows how many are closed under its key, for example **1/3 subtickets closed**, with a
small bar. The column the rows are sorted by carries an arrow in its heading.

On a phone the table becomes stacked rows: each ticket shows its key, its summary, and then its
status, assignee and priority. Open the ticket to change it.

| Control | What it does |
|---|---|
| **Group by** | **Nothing**, **Status**, **Assignee**, **Priority**, **Type**, **Target release** or **Labels**. Each group shows its exact count. The types and priorities a site starts with are named in your language, as in search's filters |
| **Sort by** | **Newest created first**, **Recently updated**, **Due date** or **Priority** |
| **Filter** | A condition in [the query language](search.md#the-query-language), such as `assignee = currentUser()`; press **Apply filter** |
| **Columns** | A button that opens a panel over the page: choose, order and remove columns, as on the search page |
| **Format rules** | A button that opens a panel over the page: colour the rows or cells of tickets that match a condition. The button is marked while rules apply |

When a field has more than fifty values, the rarest are counted together under **Other values**
and not listed; search for them to see them all.

A list with nothing to show says so and what to try: change the filter, or make the first ticket
at the end of the list.

### Format rules

A format rule has a **Name**, a **Condition** in the query language (for example
`due < now() AND stage != closed`), a **Colour** target (**The whole row** or one column) and a
**Tone**: **Red**, **Amber**, **Green** or **Blue**. Press **Add rule**. Up to twenty rules
apply at once. The rule's name shows beside the key of every ticket it matches, so colour is
never the only sign. A condition the server cannot read shows its error under the rule; the
other rules still apply.

The list's columns and rules are kept in this browser, per track. They do not follow you to
another browser and are not shared with others.

### Adding a ticket from the list

Type a summary in **New ticket…** at the end of the list and press **Add ticket**. The ticket is
created in the track with that summary; open it to fill in the rest.

## The calendar

**Calendar** shows a month in weeks starting on Monday, with today marked. Like the timeline, it is
titled by its section, with the track's name above; the tab bar leads back to the summary, and
**What is Calendar for?** beside the title says what it shows.

Start and due dates are calendar days, so "today" on the calendar and the timeline is the day on
your own device's clock: in the evening in the Americas, when it is already tomorrow in UTC, the
calendar still opens on your month and marks your day.

- Each ticket appears on its due day, and also on its start day when that is different (marked
  **Starts:**, which a screen reader reads first too).
- Sprints of the track's boards show as bands, named on their first day and on Mondays. Since the
  calendar is the track's, a sprint named after the track drops the track's name: "Mobile apps
  Sprint 2" reads **Sprint 2**.
- Releases with a date show on their day, with a diamond before the name.

**Previous month**, **Next month** and **This month** move between months. A day lists six
tickets and a button for the rest. The calendar shows up to 1,000 tickets for the weeks on screen
and says when there are more.

To reschedule a ticket, drag it to another day:

- dragging the due entry moves the due day there and the start day along with it, keeping the
  same length;
- dragging the start entry moves the start day, and the due day along if it would otherwise come
  first.

With a mouse, drag the entry itself. Each entry also has a grip, six dots at its end, which shows
when the pointer or the keyboard is on the entry and always on a touch screen, where it sits under
the entry on a day too narrow to hold both: with a finger, drag the entry by its grip, since a
finger elsewhere scrolls the page. Touch and hold the grip a moment, then drag it anywhere; a
finger that moves sideways first drags at once, and a quick flick up or down that happens to start
on a grip scrolls the page as it would anywhere else. A pen, like a mouse, drags at once in any
direction. While you drag, the day it would land on is
outlined and a label with the ticket follows the pointer; near the top or bottom of the screen the
page scrolls. **Escape** puts it back, and so does letting go on its own day or outside the
calendar. If the grip's menu is open when you start a drag, it closes.

Pressing or tapping the grip, **Move the due day of PAY-42** (or **Move the start of PAY-42**),
opens a menu with **One day earlier**, **One day later**, **One week earlier** and **One week
later**: a way to reschedule with one finger and no drag. In the open menu the arrow keys move
between its choices, with Alt or without; they never move the ticket themselves. With the
keyboard, focus an entry or its grip and press Alt with the left or right arrow to move it a day,
or with the up or down arrow to move it a week; the keyboard stays with the entry on its new day.
When that day is in a month the calendar is not showing (on a phone, any day outside the month
listed), the calendar turns to that month; when the ticket lands beyond the six a day shows, the
day opens to show them all. If the moved ticket is no longer on the calendar at all, the keyboard goes to its
day, or to the line under the month that says what happened. Clicking an entry, or Enter,
opens the ticket over the calendar, where **Start date** and **Due date** are among its details.
Rescheduling needs the **Set due dates** permission. When a change is refused, the calendar says
why: you may not schedule tickets in the track, its status or dates are locked for you, the track
is archived, the ticket is gone, the dates are not valid, or the ticket changed meanwhile.

On a phone, the month's name has a line of its own above **Previous month** and **Next month**,
and the calendar becomes a list of only the days that have something on them (a ticket, a
release, or the first day of a sprint), each named by its weekday and date, such as "Thu, Nov 5".
A month with nothing on it says so. A drag reaches only the days in the list; to move a ticket to
a day the list does not show, use its grip's menu, which moves it a day or a week at a time. On a
phone or a touch screen, the hint under the month speaks of fingers and grips instead of the
keyboard (touch and hold a grip, then drag), and on a phone it says that a drag reaches the days listed and the grip's menu any day.

## The timeline

**Timeline** shows the track's tickets as bars over time, in rank order, with children under
their parents. Each row starts with the ticket's key, always whole, and its summary, cut short when
it is long; on a phone the summary sits under the key.

- **Bars** run from a ticket's start day to its due day. A ticket without days of its own that is
  in a sprint takes the sprint's days; its bar is hatched.
- **Parents** show a roll-up from the earliest start to the latest due day of all their
  children, outlined, with the closed share filled in, and "3 of 5 closed" in the ticket column.
  **Show the children** and **Hide the children** fold them.
- **Sprints** show as bands, **releases** with a date as dashed lines, and today as a line.
- **Dependencies**: "blocks" links between listed tickets show as lines. A line turns dashed
  and red when the blocked ticket starts on or before the day its blocker is due, unless one of
  the two is already closed.
- **No dates** marks a ticket without any, just after today's line.

Under the chart, **What the bars mean** explains each of these styles, listing only those the
timeline draws.

The **Zoom** buttons switch between **Weeks**, **Months** and **Quarters**. **Today** scrolls
to the current day. The month's name stays in view at the left of the days while you scroll. When
a ticket's bar lies wholly before or after the days in view, its row shows **Earlier** or
**Later** at that edge instead of looking empty; choose it to scroll to the bar. These markers are
solid, so today's line passes behind their words. On a phone the ticket's key sits over its
summary, and a tap anywhere on the two opens the ticket. When more rows
wait below the chart's lower edge, the last ones fade out: scroll the chart, which you can also
reach with Tab and scroll with the arrow keys.

### Rescheduling on the timeline

- Drag a bar to move it, or drag one of its ends to change only the start or the due day. On a
  touch screen a bar narrower than a finger still takes one: press just past its ends to move it
  whole.
- With the keyboard, focus a bar and press Alt with the left or right arrow to move it a day, or
  with Shift as well to move it a week.
- Press Enter on a bar, or choose **No dates** on a ticket without any, to open the panel
  **Days of PAY-42**. It shows the **Start date** and **Due date**, where the days come from (its
  own, its sprint, or its children), and the tickets it **Blocks** or is **Blocked by**. Press
  **Save dates** to keep a change. The start date must not be after the due date.

On a phone or a touch screen, the hint above the chart says what a finger can do instead of
listing keys.

A bar moved keeps the days it had: a ticket with only a due day keeps only that. A ticket dated
by its sprint gets days of its own once you save. As in the calendar, rescheduling needs the
**Set due dates** permission and is recorded in the ticket's history.

The timeline lists the first 5,000 tickets of the track; roll-ups still count them all. A
refused change says why, as on the calendar. A [plan](multi-track.md) shows the same
timeline and calendar over several tracks.

## Outcomes

An outcome is a result that several tickets deliver together: a ticket whose type sits at the
outcome level, such as the seeded **Outcome** type, with the tickets that work towards it under it.
**Outcomes** in a track's tab bar lists the track's outcomes, on Scrum and Kanban tracks alike,
with a **What is Outcomes for?** button beside its title.
Each row shows:

- the outcome's type, key and summary, and its status; the key never breaks across lines, and on a
  phone the summary wraps beside the type's icon;
- its progress: how many of the tickets directly under it are closed, of all of them, as a bar like
  the Releases list's and as "5 of 8". An outcome with nothing under it yet says so;
- its start and due dates, when they are set.

Open outcomes come first, in their planned (ranked) order, the order the backlog shows them in;
closed ones follow. The list shows 100 at a time: **Show more outcomes** adds the next 100.
Choosing an outcome opens it over the list, where its page shows the tickets under it.

As everywhere, the list holds only what you may see. An outcome you may not see is left out, and so
is a ticket under an outcome that you may not see: it counts neither as closed nor in the total. Two
people can therefore read different progress for the same outcome. A ticket counts as closed when its
status is in the closed stage, as subticket progress and the backlog's outcome panel count it.

### Managing outcomes

Every track manages its outcomes here, Kanban tracks as well as Scrum ones. **Manage outcomes**,
beside the title, opens the manage panel for anyone whose role in the track lets them change
outcomes; it is not offered to someone who may only read them, nor on an archived track.

- **New outcome**: type a **Summary** and press **Create outcome**. When the track has more than
  one type at the outcome level, choose its **Type** first. The new outcome joins the open ones at
  the end of the planned order. On an empty list, **New outcome** opens the panel with the
  summary field ready.
- Under each outcome, **Edit** changes its summary and its start and due dates, then **Save**.
- **Move up** and **Move down** change its place among the open outcomes, the same planned order
  the backlog shows on a Scrum track. Closed outcomes keep their place after the open ones.
- **Close** moves it to a closed status by its workflow, as the status control on its page does.
  When the workflow offers more than one way to close it, the panel asks which; when that way asks
  for a close reason or a priority, the panel asks for it. When its workflow offers no way to a
  closed status from where it is, or asks for more than the panel can fill in, it says so, and
  you can close it from its own page.

Each change is the same as making it on the outcome's own page: the same permissions apply, so the
panel offers only what your role allows (creating needs the right to create tickets, editing the
summary the right to edit them, dates and order the right to schedule them, and closing the right
to move them through the workflow), and the change shows in the outcome's history. If the server
refuses one, the panel says why and the list stays as it was.

To make an outcome without the panel, create a ticket of a type at the outcome level, then add
the tickets that work towards it from its page. When none of the track's ticket types is at the
outcome level, the empty list says so; an administrator can add one to the track's
[ticket types](../admin/tracks.md#configuration-sets).
