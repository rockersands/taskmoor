---
title: "Multi-track"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/plans/PlansPage.tsx, apps/web/src/plans/PlanPage.tsx, apps/web/src/plans/PlanSummaryPage.tsx, apps/web/src/plans/PlanTimelinePage.tsx, apps/web/src/plans/PlanListPage.tsx, apps/web/src/plans/PlanCalendarPage.tsx, apps/web/src/plans/PlanSettingsPage.tsx, apps/web/src/plans/SourcePicker.tsx, apps/web/src/plans/address.ts, apps/web/src/timeline/TimelineView.tsx, apps/web/src/timeline/DependencyList.tsx, apps/web/src/timeline/dependencies.ts, apps/web/src/calendar/CalendarView.tsx, apps/web/src/timeline/refusal.ts, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/plans.ts, apps/server/src/routes/plan-views.ts, apps/server/src/plans/query.ts, apps/server/src/plans/model.ts, docs/adr/0122-multi-track.md, docs/specs/03-planning-time-discovery-and-quality.md
accessed: 2026-11-03
attestation: own-words
---
# Multi-track

Multi-track brings the work of several tracks together in one place, without changing how those
tracks work. Each **plan** gathers the tickets of the tracks and saved searches you choose, and
shows them as a **Summary**, a **Timeline**, a **List** and a **Calendar**. Open **Multi-track**
in the sidebar, under **Plan and track**.

A plan never gives anyone access. Everyone who opens it sees only the tickets they may see
anyway, exactly as a search would show them.

## Making a plan

1. Open **Multi-track** and choose **New plan**.
2. Give it a name.
3. Tick its tracks and saved searches. **Find a track or saved search** narrows both lists.
4. Choose **Create plan**.

Its sources are listed in the order you ticked them. A board is not a source: each board belongs
to one track, so choosing the track brings the same tickets. A saved search brings the tickets
its condition finds, read again every time, so a plan changes when someone changes the saved
search. A plan has at most 500 sources and any number of tickets.

The **Multi-track** page lists **Your plans** and those **Shared with you**.

## What each person sees

- **A track you may not see** adds nothing for you. Neither does a saved search you may not see.
  The plan says how many of its sources are hidden from you, never which. Seeing a few of a track's
  tickets, as their requester for example, is not seeing the track: the plan shows those tickets
  with the track's key, but not its name, sprints or releases.
- **A saved search that no longer runs for you**, for example because it names a track you cannot
  see, is left out, and the plan names it. The rest of the plan still shows.
- **An archived track** is named, and its tickets are not shown, as in a search.
- **When you may see none of its sources**, the plan shows nothing for you. When you see them but
  none can be searched (archived tracks, saved searches that no longer run), it says so.

## The views

Every view shows at most the first 10,000 tickets of the plan and says so when there are more:
filter the plan to see the rest.

- **Summary**: how many tickets the plan holds, how many are **Open**, **Overdue**, **Due within 7
  days**, **Open without dates** and **Closed in the last 7 days**, then the tickets by stage, by
  track and the ten people with most open tickets. Every number is a link to the search that
  finds exactly those tickets.
- **Timeline**: the tickets as bars over the calendar, as on a track's
  [timeline](views.md#the-timeline), with the sprints and releases of their tracks. Parents sit
  above their children, and a parent without dates shows the span of all its children you may see,
  even those outside the plan. Lines join a ticket to the ones it blocks, across tracks too: see
  [Dependencies](#dependencies).
- **List**: the plan's tickets as a search, in your columns, sorted by newest, recently updated,
  due date or priority. You edit cells in place, as in search results. It stops at 10,000 rows.
- **Calendar**: a month of the tickets on their due and start days. A day shows six tickets and a
  button for the rest.

## Dependencies

When one ticket blocks another (a **Blocks** link on the ticket), the Timeline shows the
dependency, across tracks too.

- **A line** runs from the end of the blocker's bar to the start of the bar it blocks. A ticket
  without dates has no bar, so no line, but it still has its badge and its place in the list.
- **A badge** beside each blocked bar counts its blockers. Point at it to read, for example,
  "Blocked by 3 tickets, 1 late"; a screen reader says the same with the bar.
- **Late**: a dependency is late when the blocker ends on or after the day the blocked ticket
  starts. Its line turns red and dashed, and the badge turns red and says **late** in words. A
  blocker that is closed holds nothing up, so it is never late, and neither is a dependency whose
  blocked ticket is already closed. Move the blocked ticket after its blocker, or the blocker
  earlier, and the warning goes.
- **Blockers you do not see on the Timeline** are only counted, on the ticket they block:
  - "Blocked by 2 tickets outside this plan" counts blockers that are not in the plan, and those you
    may not see. It never says which, so nothing hidden from you is named, dated or linked.
  - "Blocked by 1 ticket of this plan not shown here" counts blockers of the plan that your filters
    leave out, or that come after the first 10,000. Clear the filters to see them.
- Tickets in the trash block nothing.

Below the Timeline, **Dependencies** lists the same as text, for the keyboard and screen readers:
each blocked ticket with its blockers, each marked **Late**, **On time**, **Closed** or **No
dates**, with the days that decide it, and the counts of those not shown. **Only late ones**
narrows the list, and **List of dependencies**, beside the zoom buttons, takes you straight to
it. Choosing a bar also shows, in its side panel, which of its blockers are late and how many
are elsewhere.

## Filtering and grouping

Above every view, choose one **Track**, one **Assignee** (**Me**, **Nobody** or a person), one
**Type** and one **Stage**. The Timeline and the List also **Group by** track, assignee, status,
type or priority; on the Timeline, a group's heading hides or shows its tickets.

Filters and grouping are kept in the page's address. Copy the address to share the same view, and
the browser's back button undoes a change. **Clear filters** removes them all.

## Rescheduling

On the Timeline, drag a bar to move a ticket, or drag one of its ends to change its start or due
date. With the keyboard, focus a bar and press Alt with the left or right arrow to move it a day,
and add Shift for a week. Choosing a bar opens its days in a side panel, which is also the way on a
phone. On the Calendar, drag a ticket to another day, or press Alt and an arrow.

Each change is the ticket's own, so its track's **Set due dates** permission, its history and its
notifications apply. When a change is refused, the page says why: you may not schedule tickets in
that track, the ticket's status or dates are locked for you, the track is archived, the ticket was
deleted or is hidden from you, the dates are not valid, or someone changed the ticket meanwhile.

## Changing and sharing a plan

The plan's owner and site administrators see **Settings**: its name, description, sources and
**Who sees it** (**Only you** or **Everyone signed in**). Sharing a plan needs the permission to
share dashboards and saved searches. The sources hidden from the person editing stay in the plan,
so nobody removes what they cannot see. **Delete plan** removes the plan; its tickets stay as
they are.

Sharing a plan does not share its tracks or saved searches: someone who may not see a source sees
nothing from it. Share those as well when they should.

## Not yet in Multi-track

Teams and capacity, releases across tracks, the program board, draft changes and scenarios, the
auto-scheduler, and copying or exporting a plan come in later versions. Dependencies are the
**Blocks** links only: other link types do not count as dependencies.
