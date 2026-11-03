---
title: "List, calendar and timeline"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/tracks/TrackSummaryPage.tsx, apps/web/src/tracks/TrackNumbers.tsx, apps/web/src/tracks/TrackLayout.tsx, apps/server/src/routes/track-summary.ts, apps/server/src/dashboards/widgets.ts, docs/adr/0116-one-place-per-track.md, apps/web/src/list/ListPage.tsx, apps/web/src/search/ColumnPicker.tsx, apps/web/src/search/ResultTable.tsx, apps/web/src/calendar/CalendarPage.tsx, apps/web/src/timeline/TimelinePage.tsx, apps/web/src/i18n/messages.en.ts, docs/adr/0060-dashboards.md, docs/adr/0064-timeline.md, docs/adr/0065-list-and-calendar-views.md, docs/specs/01b-core-work-tracking.md
accessed: 2026-11-03
attestation: own-words
---
# List, calendar and timeline

Every track has three views of its tickets besides its boards: a list, a calendar and a
timeline. Each shows only the tickets you may see. You reach them from the track's summary.

## The track summary

A track's summary is at the address ending in `tracks/` and the track's key, for example
`tracks/PAY`. Its title is the track's name and key. It shows:

- **Open**, **Created in the last 7 days**, **Closed in the last 7 days**, **Updated in the last
  7 days** and **Open and due within 7 days**;
- the tickets **By stage**, and the open ones **Open by priority**, **Open by type** and **Open
  by assignee** (the ten people with most).

Every number is a link to the search that finds exactly those tickets. The tab bar above it holds
the track's other sections, such as its [**Releases**](boards.md#releases),
[**Statistics**](dashboards-and-reports.md#a-tracks-statistics), **Timeline**, **List** and
**Calendar**.

### Customizing the summary

The track's owner and its administrators see **Customize**. It starts from the numbers above, as
one widget called **This track's numbers**, so nothing is lost. They can then choose a **Layout**
of one to three columns, add any [widget](dashboards-and-reports.md#widgets) with **Widget to
add**, set each one up, move and remove them, and press **Save the summary**. The numbers can be
removed and added back. Nobody has to set this up: a track shows its default summary until someone
does.

Everyone else who can see the track reads the same widgets and has no controls to change them.
Each widget is read as the person looking at it, through the same permission filter as a search,
so two people can read different numbers and nobody sees a ticket they could not find themselves.

On a track's summary:

- a widget with an empty query counts the track, not every ticket;
- **Assigned to me** and **Followed tickets** list only the viewer's tickets in this track;
- a widget's query that you do write is used as written, so it can count another track, for those
  who may see that track;
- the sprint widgets read the track's board, and need it to be a Scrum board.

**Back to the default** removes the customization for everyone, after asking. If someone else saved
a change while you were editing, saving says so, and nothing is overwritten. An archived track's
summary cannot be changed until the track is restored.

A customized summary is not a dashboard: it belongs to the track, and it does not appear under
**Dashboards**.

## The list view

**List** shows the track's tickets in a table, fifty at a time; **Show more** adds the next
fifty. It is the search results table, so cells such as the summary, assignee, priority, labels
and dates can be edited in place (see [search results](search.md#search-results)). A ticket with
subtickets shows how many are closed under its key, with a small bar.

| Control | What it does |
|---|---|
| **Group by** | **Nothing**, **Status**, **Assignee**, **Priority**, **Type**, **Target release** or **Labels**. Each group shows its exact count |
| **Sort by** | **Newest first**, **Recently updated**, **Due date** or **Priority** |
| **Filter** | A condition in [the query language](search.md#the-query-language), such as `assignee = currentUser()`; press **Apply filter** |
| **Columns** | Choose, order and remove columns, as on the search page |
| **Format rules** | Colour the rows or cells of tickets that match a condition |

When a field has more than fifty values, the rarest are counted together under **Other values**
and not listed; search for them to see them all.

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

**Calendar** shows a month in weeks starting on Monday, with today marked.

- Each ticket appears on its due day, and also on its start day when that is different (marked
  **Starts:**).
- Sprints of the track's boards show as bands, named on their first day and on Mondays.
- Releases with a date show on their day, with a diamond before the name.

**Previous month**, **Next month** and **This month** move between months. The calendar shows
up to 1,000 tickets for the weeks on screen and says when there are more.

To reschedule a ticket, drag it to another day:

- dragging the due entry moves the due day there and the start day along with it, keeping the
  same length;
- dragging the start entry moves the start day, and the due day along if it would otherwise come
  first.

With the keyboard, focus an entry and press Alt with the left or right arrow to move it a day,
or with the up or down arrow to move it a week. Enter opens a panel with **Start date** and **Due
date**; change them and press **Save dates**. Rescheduling needs the **Set due dates**
permission; without it the calendar says the ticket could not be moved.

On a phone, the calendar becomes a list of the month's days.

## The timeline

**Timeline** shows the track's tickets as bars over time, in rank order, with children under
their parents.

- **Bars** run from a ticket's start day to its due day. A ticket without days of its own that is
  in a sprint takes the sprint's days; its bar is hatched.
- **Parents** show a roll-up from the earliest start to the latest due day of all their
  children, outlined, with the closed share filled in, and "3 of 5 closed" in the ticket column.
  **Show the children** and **Hide the children** fold them.
- **Sprints** show as bands, **releases** with a date as dashed lines, and today as a line.
- **Dependencies**: "blocks" links between listed tickets show as lines. A line turns dashed
  and is highlighted when the blocked ticket starts before its blocker is due.

The **Zoom** buttons switch between **Weeks**, **Months** and **Quarters**. **Today** scrolls
to the current day.

### Rescheduling on the timeline

- Drag a bar to move it, or drag one of its ends to change only the start or the due day.
- With the keyboard, focus a bar and press Alt with the left or right arrow to move it a day, or
  with Shift as well to move it a week.
- Press Enter on a bar, or choose **No dates** on a ticket without any, to open the panel
  **Days of PAY-42**. It shows the **Start date** and **Due date**, where the days come from (its
  own, its sprint, or its children), and the tickets it **Blocks** or is **Blocked by**. Press
  **Save dates** to keep a change. The start date must not be after the due date.

A bar moved keeps the days it had: a ticket with only a due day keeps only that. A ticket dated
by its sprint gets days of its own once you save. As in the calendar, rescheduling needs the
**Set due dates** permission and is recorded in the ticket's history.

The timeline lists the first 5,000 tickets of the track; roll-ups still count them all.
