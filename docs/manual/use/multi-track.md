---
title: "Plans"
audience: users
sources: apps/web/src/plans/client.ts, apps/web/src/App.tsx, apps/web/src/plans/PlansPage.tsx, apps/web/src/plans/PlanPage.tsx, apps/web/src/plans/PlanSummaryPage.tsx, apps/web/src/plans/PlanTimelinePage.tsx, apps/web/src/plans/PlanListPage.tsx, apps/web/src/plans/PlanCalendarPage.tsx, apps/web/src/plans/PlanCapacityPage.tsx, apps/web/src/plans/CapacityDialog.tsx, apps/web/src/plans/PlanSettingsPage.tsx, apps/web/src/plans/SourcePicker.tsx, apps/web/src/plans/TeamPicker.tsx, apps/web/src/plans/address.ts, apps/web/src/plans/PlanShareActions.tsx, apps/web/src/plans/DuplicatePlanDialog.tsx, apps/web/src/plans/DownloadMenu.tsx, apps/web/src/plans/planExport.ts, apps/web/src/plans/planImage.ts, apps/server/src/routes/search-export.ts, apps/web/src/timeline/TimelineView.tsx, apps/web/src/styles/plans.css, apps/web/src/styles/releases.css, apps/web/src/timeline/DependencyList.tsx, apps/web/src/timeline/dependencies.ts, apps/web/src/calendar/CalendarView.tsx, apps/web/src/timeline/refusal.ts, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/plans.ts, apps/server/src/routes/plan-views.ts, apps/server/src/routes/plan-capacity.ts, apps/server/src/plans/query.ts, apps/server/src/plans/model.ts, apps/server/src/plans/periods.ts, apps/server/src/plans/cross-track.ts, apps/server/src/routes/cross-track-releases.ts, apps/server/src/search/cross-track.ts, apps/web/src/plans/PlanReleasesPage.tsx, apps/web/src/releases/CrossTrackReleasesPage.tsx, apps/web/src/releases/CrossTrackReleasePage.tsx, apps/web/src/releases/MoveDateDialog.tsx, apps/web/src/releases/NewCrossTrackDialog.tsx, apps/web/src/releases/ReleasePage.tsx, apps/web/src/releases/useCandidates.ts, apps/server/src/search/bind.ts, apps/web/src/timeline/markers.ts, docs/adr/0122-multi-track.md, docs/specs/03-planning-time-discovery-and-quality.md, docs/adr/0114-glass-interface-and-clear-sections.md, packages/webconfig/src/csv.ts, apps/web/src/plans/download.ts, apps/server/src/privacy/erase.ts, apps/server/src/audit/query.ts, apps/web/src/plans/ProgramBoardsPage.tsx, apps/web/src/plans/ProgramBoardPage.tsx, apps/web/src/plans/programBoardClient.ts, apps/server/src/routes/program-boards.ts, apps/server/src/plans/dependencies.ts, apps/web/src/shell/DangerAction.tsx, apps/web/src/shell/moreSides.ts, apps/web/src/plans/ScenarioBar.tsx, apps/web/src/plans/ScenarioDialogs.tsx, apps/web/src/plans/PlanChangesPage.tsx, apps/web/src/plans/PlanScenariosPage.tsx, apps/web/src/plans/ScenarioCompare.tsx, apps/web/src/plans/changeWords.ts, apps/web/src/plans/drafting.ts, apps/web/src/plans/scenarioClient.ts, apps/server/src/routes/plan-scenarios.ts, apps/server/src/plans/drafts.ts, apps/server/src/privacy/export.ts, apps/server/src/reports/zone.ts, apps/web/src/plans/AutoScheduleDialog.tsx, apps/web/src/plans/ScheduleResult.tsx, apps/web/src/plans/scheduleWords.ts, apps/server/src/routes/plan-schedule.ts, apps/server/src/plans/scheduler.ts, apps/server/src/plans/scheduleInputs.ts, apps/server/src/plans/capacity.ts, apps/server/src/plans/sprints.ts, apps/web/src/plans/PlanBaselinesPage.tsx, apps/web/src/plans/BaselineCompare.tsx, apps/web/src/plans/baselineClient.ts, apps/web/src/plans/baselineExport.ts, apps/server/src/routes/plan-baselines.ts, apps/web/src/timeline/CriticalPathList.tsx, apps/web/src/timeline/critical.ts, apps/server/src/plans/criticalPath.ts, apps/server/src/plans/evenOut.ts, apps/web/src/plans/PlanGridPage.tsx, apps/web/src/plans/StructureDialog.tsx, apps/web/src/plans/MoveUnderDialog.tsx, apps/web/src/plans/grid/client.ts, apps/web/src/plans/grid/compute.ts, apps/web/src/plans/grid/tree.ts, apps/web/src/plans/grid/rowWindow.ts, apps/web/src/plans/grid/words.ts, apps/web/src/styles/grid.css, apps/server/src/routes/plan-structures.ts, apps/server/src/plans/structures.ts, apps/server/src/plans/structureTree.ts, apps/server/src/routes/ticket-types.ts
accessed: 2026-11-16
attestation: own-words
---
# Plans

Plans bring the work of several tracks together in one place, without changing how those
tracks work. Each **plan** gathers the tickets of the tracks and saved searches you choose, and
shows them as a **Summary**, a **Timeline**, a **List**, a **Grid**, a **Calendar**, its teams'
**Capacity**, its tracks' **Releases** and its **Program boards**, and holds **scenarios** of draft
changes to try before they change anything and **baselines** of its days to compare with later.
Open **Plans** in the sidebar, under **Plan and track**. The help mark beside a plan's name says
in a few lines what each tab is for.

A plan never gives anyone access. Everyone who opens it sees only the tickets they may see
anyway, exactly as a search would show them.

## Making a plan

1. Open **Plans** and choose **New plan**.
2. Give it a name.
3. Tick its tracks and saved searches. The lists hold every track and saved search you can see,
   however many; **Find a track or saved search** narrows both.
4. Choose **Create plan**.

Its sources are listed in the order you ticked them. A board is not a source: each board belongs
to one track, so choosing the track brings the same tickets. A saved search brings the tickets
its condition finds, read again every time, so a plan changes when someone changes the saved
search. A plan has at most 500 sources and any number of tickets.

The **Plans** page lists **Your plans** and those **Shared with you**.

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
filter the plan to see the rest. The Grid stops at 100,000 rows instead.

On a wide screen, tabs that do not fit on one line, as can happen in Spanish, go on to a second
line, so none is ever hidden. On a phone, the tab bar scrolls sideways and starts with the open
tab in view. Where more tabs wait past an edge of the bar, that edge fades out.

- **Summary**: how many tickets the plan holds, how many are **Open**, **Overdue**, **Due within 7
  days**, **Open without dates** and **Closed in the last 7 days**, then the tickets by stage, by
  track and the ten people with most open tickets. Every number is a link to the search that
  finds exactly those tickets.
- **Timeline**: the tickets as bars over the calendar, as on a track's
  [timeline](views.md#the-timeline), with the sprints and releases of their tracks. Parents sit
  above their children, and a parent without dates shows the span of all its children you may see,
  even those outside the plan. Lines join a ticket to the ones it blocks, across tracks too: see
  [Dependencies](#dependencies).
- **List**: the plan's tickets as a search, in your columns (**Columns** opens a panel over the
  page, as on search), sorted newest created first, by recent update, due date or priority. You
  edit cells in place, as in search results; on a phone each ticket is a stacked row of its key,
  summary, status, assignee and priority. It stops at 10,000 rows.
- **Grid**: the plan's tickets as a tree, with their children and linked tickets below them and
  columns that add up the rows below: see [The Grid](#the-grid).
- **Calendar**: a month of the tickets on their due and start days. A day shows six tickets and a
  button for the rest. A sprint named after its track puts what tells it apart first and its
  track after, so "Mobile apps Sprint 2" reads **Sprint 2 · Mobile apps**.

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

### Dependency options

A plan counts **Blocks** links always. Under **Settings**, **Dependencies**, its owner can tick
other link types to count as well, such as **Precedes**. Each is read the way the link reads:
for "A precedes B", B waits for A, so A is the blocker. A ticked type is drawn, badged, judged late
and listed exactly like a **Blocks** link, on the Timeline, in its files and on the plan's program
boards; in the list it shows its own phrase, such as "(precedes)". Two links between the same two
tickets are one dependency. Untick it and those links stop counting at once. If an administrator
later changes a ticked type to read "blocks", it counts as a **Blocks** link and leaves the list;
saving the settings then drops it.

**Flag dependencies within one sprint** marks each dependency whose two tickets are in the same
sprint now (one that has not been completed): its line on the Timeline is dotted, and the badge,
the list and the program board's cards say **Same sprint** in words. Only dependencies between
tickets you may see are marked, and the sprint is never named. A copy of the plan takes these
options with it.

## The critical path

The **critical path** is the chain of work that decides when the plan ends: the tickets that
cannot end any later without the plan ending later, or without a ticket they hold up having to
start on or before the day they end. Each other ticket has **slack**: how many days its end can
move later before either happens.

Turn it on with **Critical path**, beside the Timeline's zoom buttons; the page's link keeps it on.

- **On the bars:** a ticket on the path gets a heavy outline and a ▲, so it never depends on colour
  alone, and a screen reader hears "On the critical path" with the bar. Other bars say, for
  example, "5 days of slack". A dependency between two tickets of the path with no day to spare
  between them is drawn heavier, and the legend explains both marks.
- **In words:** **Critical path in words** takes you to the list below the Timeline. It says how
  many tickets are on the path and when the plan ends, then gives each chain from its first ticket
  to its last, for example "SPA-3 starts Dec 1, ends Dec 4, then SPA-7 starts Dec 5, ends Feb 12,
  the plan's end." A ticket whose slack is below 0 says a dependency before it is already late,
  and by how many days: the plan cannot end on time as things stand. The list names at most 500
  tickets and counts the rest.
- **In the files:** while it is on, the Timeline's CSV gains the columns **Slack (days)** and
  **Critical**, and its image draws the same outlines, marks and heavier lines, with a line of
  legend.

**What it covers:** the plan's open tickets that you may see, at every level, each by its own
days or else its sprint's, read in the scenario you chose. It goes through **Blocks** links and
the link types the plan's [dependency options](#dependency-options) count. Closed tickets are left
out and hold nothing up. A parent with no days of its own, whose bar is only its children's span,
is not on the path; its children are. Some things are only counted, never named:

- tickets in a circle of dependencies, which have no slack;
- work outside the plan or not shown to you that a ticket waits for. The tickets waiting are
  counted ("1 ticket waits for work outside this plan…") and stay on the path, named where they
  are on it, but the work they wait for is never named and holds nothing in their slack, so
  their slack can be shorter than it looks;
- open tickets without dates, which are left out.

**It is yours:** the path runs over the whole plan as it shows it to you, whatever the filters,
so a filter changes which bars you see marked, never the path or the plan's end. Two people who
may see different tickets can get a different path, a different end and different slack. Slack
and delays are in calendar days. Turning the path on changes nothing on any ticket. A plan with
more than 50,000 open tickets is too large for it: the list then says the path could not be read.

## Teams and capacity

**Capacity** shows how much work each team and person has due in each period, against how much
they can take on. It uses the site's [teams](../admin/people-and-groups.md#teams); a team gives
nobody access.

### Choosing the teams, the unit and the periods

In the plan's **Settings**, under **Teams and capacity**:

- **Teams**: tick the teams the plan plans with, in the order Capacity should list them.
- **Count work in**: **Points**, from the site's Points field, or **Hours of original estimate**.
- **Periods**: every 1 to 6 weeks from the day in **A period starts on** (periods repeat from it
  both ways, so any day of any period will do), or **Every calendar month**.

Changing the unit clears every capacity set in the plan, since amounts in one unit mean nothing in
another; changing the periods clears the capacity set for single periods. So **Save** asks first,
in its own place: it says what will be cleared and offers **Save and clear all capacity** (or **Save
and clear single periods’ capacity**) beside **Cancel**, which has the focus. **Cancel** or Escape
saves nothing and puts the focus back on **Save**; changing another setting meanwhile closes the
question, which was about the old ones, while typing in a list's search box leaves it open. If the
save gets no answer, say the connection dropped, the question closes, the page says the plan could
not be saved, and **Save** is there to try again. A
team that leaves the plan takes its capacity, and that of its people who are in none of the
remaining teams, with it.

### Reading Capacity

Each team has a row, followed by a row for each of its people; then **Unassigned** and **People in
none of these teams**. A plan without teams has no teams to be outside of, so that last row reads
**Assigned to someone** instead. Each column is a period, the one holding today marked **Now**, and
the last column, **Open, no due date**, is the open work without a due date; it stays in view at
the table's end even on a narrow window. **Earlier periods**, **Later periods** and **This period**
move through time: four periods at a time on a computer, so the whole table fits, and six on a
phone, where each row is a card. The dates of the periods shown come first, with the buttons
after them.

In each period:

- A ticket counts whole in the period that holds its due date, in the plan's unit, for the person
  it is assigned to and for each of the plan's teams that person is in. Tickets without an
  estimate are counted and shown as **without an estimate**.
- **"16 of 10 points"** is the work due against the capacity. Over capacity, the cell turns red
  and says **Over capacity by** how much in words.
- **"+13 points in 1 ticket elsewhere"** (explained above the table only when one shows) is the rest of that person's work due then: outside the
  plan, left out by your filters, or in tracks you may not see. It counts against their capacity,
  because they have to do it all, but it is never named, dated or linked. It is counted by whole
  weeks, Monday to Sunday, each in the period that holds most of the week, so however the
  periods are set it never tells which day hidden work is due. In periods that start on another
  day, or in months, work elsewhere due near a period's edge can count in the period next to it.
- **"3 tickets"** links to the search that finds exactly those tickets of the plan, as you may see
  them. The filters above narrow the plan's work as in every view.
- A team without a capacity of its own in a period has its people's, summed, marked **Its members'
  capacity**. A row without any says **No capacity set**, and is never over.

### Setting capacity

The plan's owner and site administrators see **Set capacity** on each team and person. In the
dialog, **Capacity for every period** is what they can take on in any period, with a note; below
it, each period in view can have its own capacity and note instead, for leave or a holiday. Leave
a field empty for none. A note goes with a capacity: a note typed where no capacity is typed is
not saved, and the dialog says so at that capacity. Emptying a capacity removes it with its note.
**Save capacity** saves only what changed. Each change is kept in the plan's history with its
note, so a note should say what planning needs ("Leave"), not why. When a person is erased, their
capacity goes, and the notes about them are emptied in that history too; the amounts stay. If someone changes the plan's
unit or periods while you type, nothing is saved and the dialog asks you to reload the page.

## Filtering and grouping

Above every view, choose one **Track**, one **Assignee** (**Me**, **Nobody** or a person), one
**Type** and one **Stage**. The Timeline and the List also **Group by** track, assignee, status,
type or priority; on the Timeline, a group's heading hides or shows its tickets. On a phone the
filters wait behind one **Filters** button, which says how many are set, for example **Filters
(2)**, so the plan's work shows first.

Filters and grouping are kept in the page's address. Copy the address to share the same view, and
the browser's back button undoes a change. **Clear filters** removes them all.

## Rescheduling

On the Timeline, drag a bar to move a ticket, or drag one of its ends to change its start or due
date. With the keyboard, focus a bar and press Alt with the left or right arrow to move it a day,
and add Shift for a week. Choosing a bar opens its days in a side panel, which is also the way on a
phone. On the Calendar, drag a ticket to another day (with a finger, by its grip), choose a move
from its grip's menu, or press Alt and an arrow, as on a
[track's calendar](views.md#the-calendar).

Each change is the ticket's own, so its track's **Set due dates** permission, its history and its
notifications apply. When a change is refused, the page says why: you may not schedule tickets in
that track, the ticket's status or dates are locked for you, the track is archived, the ticket was
deleted or is hidden from you, the dates are not valid, or someone changed the ticket meanwhile.

## Scenarios and draft changes

A **scenario** is a named set of **draft changes** to a plan's tickets: their start and due days and
their value in a Team field. A draft changes nothing about a ticket until it is **applied**, so you
can try a new schedule, see it on the plan's views and compare it with the tickets as they are.
Scenarios belong to their plan: everyone who sees the plan sees its scenarios, and a scenario gives
no access. [Auto-scheduling](#auto-scheduling) can fill a scenario with proposed days for you.

### Live and a scenario

Every tab but Settings has a **Scenario** select below the plan's name. **Live**, the first choice
and where a plan opens, is the tickets as they are: a change you make there changes the ticket at
once, and the sentence under the select says so. On a phone the label sits beside the select, and
under Live that sentence is read out only by a screen reader with the select, so the plan's work
starts higher. Choose a scenario to read the plan with its drafts.
The sentence then says how many changes it holds and that nothing changes until you apply them, and
**Review** opens its change list. The scenario you chose is in the page's address, so a link opens
the same one. A link to a scenario that was deleted opens the plan live, and says so.

### Drafting

In a scenario, the ways you reschedule on the Timeline and the Calendar make drafts instead: drag a
bar or a calendar entry, press Alt and an arrow, or use the side panel, whose button reads **Save
draft**. On a program board, dragging a card or its **Move** dialog (whose button reads **Draft the
move**) drafts its Team value and days. After each draft the page says, for example, "Draft: SPA-12
due 10 Dec in Faster. Nothing changed yet."

Drafts are marked in words, never by colour alone:

- A drafted bar has a **Draft** tag and a dashed edge, and a screen reader hears its days drafted
  and its days now. The side panel shows its days now and offers **Undo this draft**.
- A drafted calendar entry begins with "Draft", and a drafted card carries a **Draft** tag.
- A Capacity or board cell that a draft moved a ticket into or out of says "With 2 draft changes"
  or "includes drafts", and its count is not a link: a search finds tickets as they are, so no
  search could find that count. Cells no draft touches keep their links.
- Capacity's heading names the scenario. **Set capacity** still sets the plan's own capacity, live
  and in every scenario, and its dialog says so.

The **Summary**, the **List** and **Releases** show tickets as they are in a scenario too, and say
so; in a scenario the List's cells cannot be edited in place. Work outside the plan and blockers it
does not list stay live. Setting a field back to its live value removes its draft.

Files you download in a scenario hold the drafted values: their first line names the scenario, and
the Timeline's and the Calendar's files say which rows are drafts. The Timeline's image says so in
its title. The List's file is always live.

### The change list

The **Changes** tab lists the chosen scenario's drafts, a ticket at a time: its key and summary,
its track, each drafted field as "Due: 3 Dec → 10 Dec", who drafted it and when, and its state in
words:

- **Ready**: it can be applied.
- **Changed since drafted**: someone changed that field live since the draft was made, and the line
  says the value now. **Keep my draft** keeps your draft against the value now; nothing else does,
  so moving only a bar's end leaves its start marked if that is what changed. A ticket edited in
  other ways, a comment or a new summary for example, is not changed since drafted.
- **Already so**: the ticket already has the drafted value; applying it changes nothing.
- **You may not schedule tickets in SPA** (or edit them, for a Team value): you lack what applying
  it needs. **Only those I can apply** hides these.
- **Refused**, with why: the last attempt to apply it was refused.

On a phone each ticket is a card, and the actions for the chosen tickets stay in a bar at the
bottom. The list shows 100 tickets at a time; **Show more** brings the next ones.

### Applying

Only the **main** scenario is applied from. Choose tickets, or **Select all**, then **Apply**; the
page asks first: "Change 3 tickets as you, with your permissions?" Applying is each ticket's own
change, made by you: your permissions in its track, its locks, its form and required fields, its
history, its notifications and its followers all apply, as if you had changed it by hand, and
applying makes you follow the tickets you change. A ticket's drafted fields are applied together.
On a computer, **Apply all** applies every draft you see; on a phone, choose **Select all** and then
**Apply**. The page applies 100 tickets at a time and says how far it has got.

One ticket refused never stops the others. The result says, for example, "3 applied, 1 refused",
and each refused ticket stays chosen with its reason:

- you may not schedule tickets in its track, for days ("You may not schedule tickets in SPA"), or
  edit them, for a Team value ("You may not edit tickets in SPA"); a ticket that needs another
  permission says "you lack a permission it needs in SPA";
- it is locked, by its status or a field rule, and the lock is named;
- it is no longer in this plan for you (deleted, hidden from you, moved out of the plan, or its
  track archived); such a ticket is listed by this reason alone, without its key;
- its track is archived, when that happens in the moment it is applied;
- it changed since drafted, with its values now;
- the ticket does not take the value, for example a Team field that is not on its form;
- something else went wrong: try again.

Applied drafts leave the list; the others stay until applied or discarded. One apply runs at a time
for a plan.

### Discarding

**Discard** removes the chosen tickets' drafts, and **Discard all**, on a computer, every draft you
see in the scenario; both ask first, and no ticket changes. Drafts on tickets the plan does not show you stay:
you cannot remove what you cannot see.

### Scenarios and making one main

The **Scenarios** tab lists the plan's scenarios, the main one first, each with its number of
changes, who made it and when. From there you can **Open** a scenario on the Timeline, see its
**Changes**, **Rename** it, make it main or **Delete** it, and make a **New scenario**, empty or as a
copy of another's drafts. A plan holds up to 20 scenarios, and a scenario up to 10,000 drafted
tickets. The first scenario made is main.

**Make Faster main** asks first: Faster's drafts become the plan's drafts to apply, and the former
main stays a scenario under its own name, with its drafts, so nothing is lost. Deleting a scenario
asks first and says how many drafts go with it, those on tickets hidden from you counted; the main
scenario cannot be deleted while others exist.

### Comparing

Below the list, **Compare** sets two sides side by side, each **Live** or a scenario, and the link
keeps them. For each side it shows:

- **the plan's end**: the latest due day of its open tickets, with how many open tickets have no
  due day;
- **each team's end**, by the site's first Team field, and "Other or no team";
- how many draft changes it holds;
- how many tickets end later and how many earlier, and the tickets that differ, the first 200 named.

Each difference is said in words, such as "Ends 8 days later in Faster". On a phone each measure and
each team is a card. The numbers are of the tickets you see, so two people can see different ends.

### Who may do what

- **Everyone who sees the plan** can choose a scenario, see its drafts on the views, read its change
  list and compare.
- **The plan's owner and site administrators** draft, apply, discard and manage scenarios. Anyone
  else sees "Viewing Faster. Only the plan's owner and site administrators can draft."
- **Drafts on tickets the plan does not show you** are counted, never named, dated or valued: "4
  more changes are on tickets this plan does not show you."

Drafts do not appear in a ticket's history and send no notifications until they are applied. The
scenarios you made and the drafts you last changed are in your data download; a copy of a plan
takes no scenarios. To keep a schedule as it stands and see later what moved, capture a
[baseline](#baselines).

## Auto-scheduling

**Auto-schedule** proposes start and due days for a plan's open tickets: it takes them in rank
order, blockers first, and fills the plan's periods within the capacity set on the Capacity tab.
Or, when you choose **Even out load**, it moves only the work that puts a team or person over
capacity, later (see [Evening out load](#evening-out-load)). It changes no ticket. What it proposes are draft changes in a scenario, marked as the auto-scheduler's,
which you review, compare, apply or discard as you would your own (see
[Scenarios and draft changes](#scenarios-and-draft-changes)). It follows fixed rules, described
below, and says for each ticket why it went where it did, why it stayed, or why it could not be
placed.

### Starting a run

The plan's owner and site administrators see **Auto-schedule…** below the plan's name, after
**Review N changes**, on every tab, and beside **New scenario** on the Scenarios tab. Nobody else
sees it. The dialog, a sheet on a phone, first checks what the run would use, counting only the
tickets the plan shows you:

- which of the plan's teams have capacity, and which have none, so that their tickets will not be
  placed, with a link to the Capacity tab;
- the plan's unit: points from the Points field, or hours from each ticket's original estimate. When
  the plan counts points and no Points field exists, nothing can be sized;
- how many open tickets the plan shows you, how many people in its teams have capacity of their
  own, and how many tickets will not be placed for want of an estimate, an assignee, or an assignee
  in one of the plan's teams;
- how many periods of its teams and people are over capacity now, when any are, from the tickets'
  days and the drafts people made in the scenario, leaving out the auto-scheduler's own proposals.

**Run** is off, with the reason beside it, when the plan has no teams, no team has capacity, tickets
cannot be sized, or there is nowhere to write the result. It is also off while the dialog checks the
plan again for choices you changed, so a run never starts on what was said for other ones.

Then you choose:

- **What the run does:** **Place work in rank order** (the default), described here, or **Even
  out load**, described under [Evening out load](#evening-out-load).
- **Where the result goes:** **A new scenario** (the default), named "Auto-schedule" and today's
  date unless you rename it, with **Start from** empty or a copy of one of the plan's scenarios (the
  one open is chosen first); if the plan has no scenario yet, the new one becomes its main
  scenario. Or **This scenario: Faster**, when a scenario is open. A plan already holding 20
  scenarios cannot take a new one, and a scenario being applied cannot take a run; the dialog says
  so.
- **What it may move:** under **Kept tickets never move (fixed dates)**, **Keep tickets in
  progress** and **Keep tickets in an active sprint** (both ticked at first), **Also keep tickets matching** a query, **Leave out ticket types** and **Leave
  out releases** (up to 20 of each), and **Also leave out tickets matching** a query. The types
  offered are those of the open tickets the plan shows you; the releases, those they target that
  are neither shipped nor archived, in tracks you can browse. The queries are written as in
  search. One that does not read as a query is pointed out under its field, which takes the
  focus, and nothing runs.
- **When:** **Schedule from**, today at first, and **Look ahead**, 1 to 12 of the plan's periods
  (6 at first). The dialog names the span, for example "6 periods of 2 weeks: Nov 17 to Feb 8."

The dialog remembers your choices for this plan in this browser, what the run does among them,
apart from the first day and where the result goes; a type or release the plan no longer offers is forgotten. When you run again into a scenario that already holds proposals, it says how many
the run will replace and how many drafts people made there, which stay. While the run works,
**Run** reads "Scheduling…", a line says how many tickets it is scheduling, and the dialog stays
open until the run has answered.

### Which tickets it moves

Only open tickets at the lowest level of the hierarchy, the ones parents roll up from, are
scheduled, whether they have days already or not. Each one the plan shows you is:

- **Left out** when it is at a higher level, its type or one of its target releases is left out,
  or it matches the leave-out query. The run counts it and does not draft it.
- **Kept** where it is when a person drafted its start or due day in this scenario, you may not
  schedule tickets in its track, it matches the keep query, or it is in progress or in an active
  sprint and those boxes are ticked.
- **Moved** otherwise, if the run can place it.

Closed tickets never move. Tickets that are kept or left out still count where their days put them,
and still hold up the tickets they block. So does work already done: closed tickets due in a period
count against its capacity, as on the Capacity tab, and so does each person's work elsewhere, by
whole weeks.

### How it places work

- **Who carries a ticket:** its assignee and every plan team the assignee belongs to, the same
  rows that count it on the Capacity tab. A ticket fits a period when, for each of them with a
  capacity set in that period, what is already there plus the ticket's estimate is no more than
  that capacity. Someone with no capacity set in a period limits nothing there; a capacity of 0
  takes nothing.
- **Order:** tickets go by rank. A ticket that blocks a higher-ranked one goes as early as the
  ticket it holds up, so a low-ranked blocker is placed first.
- **Blockers:** a ticket starts the day after each of its blockers ends, never on or before it, so
  the run makes no late dependency between the tickets it places. A blocker that is kept or left
  out ends on its own last day, or its sprint's.
- **In rank order for each person and team:** a ticket never lands in an earlier period than the
  higher-ranked work of the same people and teams. Room left in an earlier period can stay unused.
- **Its days:** a placed ticket starts on the first day of its period, or later if a blocker ends
  later, and is due on the period's last day.

### Reading the result

After a run the page opens the scenario's **Changes** tab, with an **Auto-schedule** section on top,
for example "180 placed, 14 kept, 9 not placed, 22 earlier proposals removed. 3 drafts people
made stay." **Placed**, **Not placed** and **Kept** each show their tickets, the key a link, with the
reason in words; the section opens on Not placed when there are any. **Compare with main**, or
**Compare with Live** when this scenario is main or the plan has none, opens the comparison. **Run
again…** opens the dialog, and **Its choices** says what the run was asked, naming the ticket
types and releases it left out. The section stays while
the plan is open; it is not saved, so nobody else sees it.

In the change list, each change the run made says **Proposed by the auto-scheduler** and, while
the result is on the page, why. On the Timeline and the Calendar such a draft says "Draft,
auto-scheduled". Moving it, even only one of its ends, makes both its days your draft: the page
says "Your draft now: a re-run will plan around it." Capacity, opened in the scenario, shows how the run filled each period.

The reasons read, for example:

- **Placed:** "Placed in Dec 1 to Dec 14: Atlas had 8 of 20 points free after 4 higher-ranked
  tickets.", "Starts Dec 9, the day after SPA-10 ends; SPA-10 blocks it.", "Placed early because
  it blocks SPA-3.", or "Placed where it already is: nothing to change."
- **Kept:** "Kept: a person drafted its days in this scenario." (anyone's draft, as scenarios are
  shared), "Kept: you may not schedule tickets in OPS.",
  "Kept: it is in progress.", "Kept: it is in an active sprint." or "Kept: it matches the tickets to
  keep."
- **Not placed**, keeping its days: no estimate in the plan's unit; nobody assigned; an assignee in
  none of the plan's teams; no capacity set for them in any period of the run; bigger than every
  capacity set for them ("Not placed: bigger than Atlas's 20 points in any period."); in a circle
  of blockers ("Not placed: in a circle with SPA-3 and SPA-4."); waiting on a blocker with no
  dates, kept or itself not placed; waiting on a ticket the plan does not show you; or no room
  ("Not placed: no room for Atlas up to Feb 8.").

A **Note:** follows a reason when something is worth a look: a ticket due after its target
release's date ("Note: due 9 days after its release 2.1 (Dec 1)."), since a release date is a
warning here, never a limit; a ticket that blocks a kept ticket starting on or before its due day,
a late dependency the run cannot fix; or a ticket not placed whose days, where they are, take
someone over capacity in a period the run filled.

### Running again

A run in a scenario replaces only the auto-scheduler's own earlier proposals there, and only on
tickets the plan shows you. Drafts people made stay, and the run plans around them, after both
their days. An earlier proposal on a ticket the run no longer places is removed. Running again on
tickets that have not changed changes nothing. A ticket someone changed while the run was working is
left as it was, and so is every ticket the run placed after it; they are listed apart, never as
placed, and counted: "1 ticket was left as it was: it or a ticket blocking it changed while the run
worked. Run again."

### What a run sees

- The run reads only what the plan shows you. Tickets hidden from you are never moved, counted or
  named.
- A ticket blocked by a ticket that is outside the plan or hidden from you is not placed, with the
  reason "waits on a ticket this plan does not show you". The hidden ticket's days are never read,
  so no proposed day gives anything away. People's work elsewhere counts only as each person's
  weekly totals, as on the Capacity tab.
- Earlier proposals on tickets the plan does not show you stay as they were, and are counted: "2
  earlier proposals stay on tickets this plan does not show you."
- Others see the run's drafts as they see any draft: on the tickets the plan shows them, the rest
  counted.
- A run plans around every blocker its runner sees. When someone who sees more than you runs it,
  a site administrator for example, a ticket you see may be proposed to start the day after a
  blocker you cannot see ends, so its proposed start can hint at when that blocker ends. Your own
  run in the scenario withdraws such proposals.

A run stops before writing anything when it would move more than 10,000 tickets (leave some out and
run again), when the plan has more than 50,000 open tickets, or when the scenario would end up with
drafts on more than 10,000 tickets.

### Evening out load

Choose **Even out load** under **What the run does** when the plan's work is roughly where you want
it, but some teams or people have more due in a period than their capacity. Instead of placing
everything again, the run moves as little as it can: only work that puts someone over capacity,
only later, and each ticket by the fewest days, keeping its length. Its proposals are draft changes
in a scenario, as for any run.

- **Where it starts:** each period of the run as the Capacity tab counts it for the scenario: the
  tickets' days and the drafts people made there, closed work due then and each person's work
  elsewhere. A team or person is **over** in a period when a capacity is set there and the work due
  is more than it.
- **What can move:** the same tickets a run in rank order may move, at the lowest level, open,
  neither kept nor left out, and only those with a due day and an estimate, since only they count
  in a period. **Kept tickets never move**: those a person drafted, those you may not schedule,
  those in progress or in an active sprint when those boxes are ticked, and those matching the
  keep query are the plan's fixed dates. Nor do tickets in a circle of dependencies or waiting on a
  ticket the plan does not show you.
- **Which ticket moves first:** the periods are taken earliest first, teams before people. In each,
  the lowest-ranked ticket of that team or person due there moves first, then the next, until the
  period is within capacity.
- **How far:** to the first later period of the run where every team and person it counts for has
  room for it. Its start and due days move by the same number of days, the fewest that put its due
  day in that period, so it keeps its length.
- **What it blocks:** a ticket it blocks that would now start on or before its new end moves too,
  to start the day after it, keeping its length, and so on along the chain. When that would move a
  ticket that may not move (a kept or left-out one, one above the lowest level, one dated only by
  its sprint, one in a circle, one waiting on a ticket the plan does not show you) or take a ticket
  past the run's last day, the whole move is undone, the ticket stays, and the next one is tried.
  So the run makes no dependency late between the tickets it reads.
- **No room:** when no later period has room, the ticket stays. If the period is still over at the
  end, its tickets that could not move say "Still over" and the period is reported; if another
  ticket's move made it fit, they are simply left where they are.

The result, on the scenario's **Changes** tab, is titled **Even out load** and counts what moved,
for example "2 tickets moved later, 14 kept, 1 not moved, 3 earlier proposals removed."
**Moved**, **Not moved** and **Kept** list their tickets with the reason in words; the tickets
left where they were are not listed. The reasons read, for example:

- "Moved 2 weeks later, from Dec 1–Dec 14 to Dec 15–Dec 28: Atlas was 6 points over."
- "Moved 3 days later after SPA-10, which was moved."
- "Not moved: moving it would make kept SPA-4 late.", "Not moved: moving it would push SPA-9 past
  Feb 8, the run's last day." or "Still over: no room for Atlas up to Feb 8."

**Still over capacity** then lists every period of a team or person that is over after the run,
by how much and why: only tickets that do not move are there, or no later period of the run has
room. When none is, it says every team and person is within capacity in the run's periods. Work a
move pushes later can fill a later period in turn; the run works on that period when it gets there,
and lists it here if it stays over.

A run that evens out load and one in rank order **replace each other's proposals** in the same
scenario, and both start from the tickets' days and the drafts people made, never from an earlier
run's result; the dialog says so. Work moves by the plan's periods, counted in calendar days, never
earlier and never by part of a period's room. What a run sees is the same as above: moving a
ticket later never makes the link to its own blockers late, but a ticket hidden from you that it
blocks may start too early without you being told.

## Baselines

A **baseline** keeps the days of a plan's tickets as they are at one moment, so that later you can
see what moved. For each ticket the plan shows the person who captures it, at every level, open or
closed, with or without dates, it keeps the ticket's own start and due days, or its sprint's days
when it has none of its own, and which of the two. It keeps no keys, summaries or parents' spans,
and capturing one changes nothing on the tickets.

### Capturing one

The plan's owner and site administrators see **Capture baseline…** on the plan's **Baselines** tab,
after **Scenarios**. The dialog, a sheet on a phone, has the name ready, such as "Baseline 14 Nov",
and says where the days come from: **What the Timeline shows now: Live**, or the scenario open on
the page, drafts included. Names need not be unique. A plan holds up to 10 baselines: then the
button is off and the page says to delete one first. A plan of more than 50,000 tickets is too
large to capture.

The tab lists the plan's baselines, newest first, each with **From Live** or **From Faster** (the
scenario's name as it was, even after it is renamed or deleted), how many tickets it holds, and who
captured it when. Its editors can **Rename** and **Delete** each; deleting asks first, in the page,
and changes no ticket. Everyone else who sees the plan reads and compares them, and the page says
who may change them.

### Comparing with a baseline

**Compare** opens a baseline against the days now under the list; the page's address keeps it. The
days now are Live, or the scenario open on the page, and the plan's filters apply. First comes a
sentence, for example "12 tickets end later than in Kick-off, by up to 14 days; 3 earlier; 40 the
same. The plan ends 9 days later (Feb 21, was Feb 12).", then how many tickets are not in the
baseline, had no days then or have none now.

- **Delay** is a ticket's end now less its end in the baseline, in calendar days. A ticket's end is
  its due day, else its start day, else its sprint's end. Closed tickets count the same way and
  say "(closed)".
- **The plan's end**, then and now, is the latest end of the tickets that have days in both.
- **Later**, **Earlier**, **Not in the baseline** and **All** choose the list, each with its
  count. Each ticket shows its key and summary, a link, with its delay in words: "9 days later: due
  Feb 21, was Feb 12". The list shows 200 tickets at a time, by delay, largest first; **Show more**
  brings the next ones. On a phone it stays a list.
- **Download CSV** gives every ticket of the chosen list, with its start and due days then and now,
  where each came from, its delay and how many days its start moved.

**Who sees what:** a baseline holds what its capturer was shown, and you see its days only on the
tickets the plan shows you now. Its other tickets, hidden from you or gone from the plan, are one
number, "4 tickets in this baseline are not shown to you.", which never says which. Tickets the
filters leave out are not compared. So two people can read different numbers from one baseline.
A ticket the plan shows you that has no row in the baseline is listed as **Not in the baseline**:
it was added to the plan since, or its capturer was not shown it (when you see more than they did,
for example as a site administrator). The page cannot tell which, so it never says "added".

A copy of a plan takes no baselines, and deleting a plan deletes them. The baselines you captured
are in your data download by name, plan, source and time, without their days. Capturing, renaming
and deleting one are kept in the audit log.

## The Grid

The **Grid** tab, after **List**, shows the plan's tickets as a tree, with columns that edit tickets
in place and columns that add up the rows below each row. What it shows comes from a
**structure**: a named recipe of **steps**, which decide the rows, and **columns**. A structure holds
no tickets. Its rows are built for each person when they open it, from what that person may see,
so two people can read different rows from the same structure.

### Structures

A plan with no saved structure shows the **Default structure**, unsaved: the plan's tickets with
their children below them, and the columns key, summary, status and assignee, a count of the rows
below and their progress.

The plan's owner and site administrators, its editors, see **New structure…**, **Edit
structure…** and **Delete structure**; on the default, **Save as a structure…** saves it under a
name. Everyone else who sees the plan uses its structures as they are, and the page says that the
plan's editors can save others.

- **Structure** chooses among the saved ones, listed by name. The address keeps the choice, so a
  copied link opens the same structure. Once a plan has a saved structure, the default is no
  longer offered. If the structure a link names was deleted since, the page says so and shows the
  plan's first.
- A plan holds up to 20 structures. A name has 1 to 100 characters and is unique in the plan,
  whatever its capitals.
- **Delete structure** asks first, in the page, and deletes it for everyone who sees the plan; its
  tickets stay as they are.
- If someone changed a structure while you were editing it, saving says so and changes nothing:
  close it and open it again.

### Steps

The dialog lists the steps in the order they apply, whatever order you pick them in:

1. **Add tickets**: the plan's tickets, as the page's filters leave them. A query in the search
   language, up to 2,000 characters, narrows them further; it never brings tickets from outside the
   plan. Leave it empty to start from every ticket of the plan. A ticket whose parent is also added
   sits under it. A query that does not read is refused on save. When it names something you may
   not search, the structure adds nothing for you and says why, while the others who see the plan
   still get their rows.
2. **Group by** and **Then group by**: up to two fields, the second nesting inside the first.
   They take track, assignee, status, type and priority, or a custom select, person, team or
   release field that holds one value, so no ticket falls in two groups. Groups come in the order of
   their names, **No value** last. A group row reads, for example, "Status: Active", with how many
   rows it holds. Grouping applies to the top rows, and their rows below go with them.
3. **Add children, down every level**: under each row, its children, then theirs, down to the
   lowest level of the hierarchy, whether they are in the plan or not.
4. **Add linked tickets**: up to two steps, each a link type and its direction (tickets this one
   blocks, say, or tickets that block this one), and **How far**: one link away, or up to two or
   three. A ticket already on the way stops it, so links that go round never repeat.

Rows below a parent are in rank order, and in the order they were created where ranks are equal.

- **A ticket appears once,** where the steps first reach it. A row that reaches it again says so:
  "Also reached once more, shown elsewhere".
- **Not in this plan** marks a child or linked ticket from outside the plan.
- **Placed by a link** marks a row that an Add linked tickets step put there.
- **The Grid stops at 100,000 rows** and then says "Shows the first 100,000 rows."
- **A field or link type deleted since** breaks only the step or column that names it, which says
  why; the rest of the structure still works, and the picker marks the structure "(partly
  broken)".

The page's filters narrow only the Add tickets step: children and linked tickets are added
whatever the filters say. The plan's own grouping is not used here; Group by steps take its place.

### Columns

A structure has up to 30 columns, of which up to 10 totals and 5 formulas; the dialog counts them.
Each column in the dialog says in words what it does, and **Up**, **Down** and **Remove** order
them. **Add a column** adds one of three kinds:

- **Ticket column**: any column search results offer, or a custom field. Its cells edit in place
  as in search results, through the ticket's own checks; a field search results do not edit is
  only shown. The parent is never edited in a cell: move the row instead. The key always goes in
  the first column, **Ticket**, as a link to the ticket.
- **Total of rows below**: **Sum**, **Lowest**, **Highest**, **Count of rows below** or
  **Progress by closed tickets**. Sum takes the original and remaining estimates, time spent,
  number fields and formula fields that give a number, an amount, a percentage or a duration.
  Lowest and Highest also take the start and due dates, date fields and formula fields that give a
  date, and then read **Earliest** and **Latest**. Count and Progress take no field.
- **Formula**: a column name, an expression in the language of
  [formula fields](../admin/fields.md#formula-fields), what it gives and its decimals (0 to 3). It
  is checked when you leave the expression or choose **Check formula**, and again on save: a
  formula that does not check says where and why, and is not saved. Fields go in braces by name and
  must be fields every track shares. Once saved, the dialog shows them by id, such as `{cf[41]}`,
  so renaming a field never breaks the column. A new formula column starts as `count(children)`,
  named **Child rows**, ready to change.

### Totals and formulas

A total at a row adds up its **child rows**, not the row's own value. Sum adds the child rows'
totals, Lowest and Highest take theirs, and a row with nothing below gives its own value. So on
every row, a sum is the sum of the rows directly below it. The row's own value stays in its ticket
column beside the total, which is why the column's header says **Total of rows below**.

- **Count** is every ticket row below, at any depth.
- **Progress** is how many of those are in a status of the closed stage, out of how many: "3 of 8
  closed", with a bar, never a percentage.
- **Empty values** are skipped, and the total says so: "5 of 8 have a value".
- **A group row** totals its rows, and the last row, **All rows**, totals the top rows.
- Durations read in hours ("12 h") and dates as dates.

A **formula column** computes a value for each ticket row, as a formula field would, except that
`children` means the row's child rows in the Grid, whichever step put them there:
`sum(children.{Points})` adds their own values and `count(children)` counts them. `today` is your
day, in your time zone, and working days follow the time tracking setting. Group rows and the last
row show nothing in a formula column. `sum(children.{Points})` equals the Sum total of Points only
where no child row has rows of its own: the formula reads each child's own value, the total each
child's total.

Totals and formula columns are computed in your browser from the rows shown, and never stored, so
they cannot be searched or sorted. An edit changes the totals above it at once.

**A stored formula field can differ from a total over the same rows.** Shown as a ticket column, a
formula field keeps the value stored on the ticket, which counts every child of the ticket that is
not deleted, whether you may see it or not, and nothing else. A total counts only the rows the Grid
shows you, linked tickets included.

### Reading and editing

On a wide screen the Grid is a table whose rows open and close; the header row, the **Ticket**
column and the **All rows** row stay in view as you scroll. Every row opens expanded. **Expand
all** and **Collapse all** do every row at once, and the rows you closed are remembered in this
browser for each structure. Cells load as their rows come into view: a row not loaded yet shows
its key and a quiet line. If some cells cannot be read, the page says so, and **Try again** asks
for them again. **Refresh** reads the structure again, with other people's changes: the
Grid does not update by itself.

After you edit a cell, the totals above it change at once, and the rows above are read again,
since a formula field stored on them may have changed. A refusal shows on the cell, as in search
results.

**Keyboard:** the Grid is one stop for Tab. Up and Down move between rows. With a whole row in
focus, rather than one of its cells, Right opens it and Left closes it; Left on a closed row goes to
its parent, Right on an open row goes into its **Ticket** cell, and Enter opens or closes it. In a
cell, Right and Left move between cells, and Left from the **Ticket** cell goes back to the row.
Enter edits a cell and Escape cancels. Home and End go to the ends of a row, and Control
with Home or End to the first and last rows. Page Up and Page Down move ten rows. Shift and F10,
or the menu key, open a row's menu. If closing rows hides the row you were on, the Grid's stop for
Tab moves to the row shown above it.

**On a row:**

- "+4 not shown": tickets below the row that you may not see. They are counted, never named and
  never in a total.
- **Not in this plan**, **Placed by a link** and "shown elsewhere", as above.

If reading a structure takes too long, the page says so and shows nothing rather than part of it:
narrow it with the filters or a query, or choose **Try again**.

### Moving a row

A row moves under another parent with everything below it, one row at a time.

- **Drag** it by its grip, at the start of its row, onto the new parent. A label beside the pointer
  says "Move ABC-12 under DEF-3", or why it cannot go there, and the row under the pointer is
  outlined. Escape cancels. On a touch screen, rest a finger on the grip a moment, or move it
  sideways, to start dragging; a quick flick up or down scrolls.
- **Move under…**, in the row's menu (the grip, Shift and F10, or the menu key), lists the Grid's
  ticket rows that can be its parent, at most 50 with how many more match, and **Find the new
  parent by key or summary** narrows them. Once you type, the rows that cannot be its parent are listed too, each saying why.
- **Remove from parent**, in the same menu, takes its parent away.

Every move asks first: "Move ABC-12 under DEF-3? Its parent changes from GHI-1 to DEF-3. 6 rows
move with it." Nothing changes until you choose **Move**. The move is the ticket's own change,
with every check a change of parent has anywhere: you need permission to edit the moved ticket and
must see the new parent; the parent is a ticket exactly one level up, named by your administrators'
names for levels; a subticket stays in its parent's track and always needs a parent; and a status
that locks the ticket keeps it where it is. A refusal says why, and nothing moves. If someone
changed the ticket since the Grid read it, nothing moves either: it is read again, and you can
check and move it again. A parent you may not see is called "a ticket you may not see", never
named.

These never move: a group row, which is also never a parent ("A group is not a parent"); a row
placed by a link, whose place comes from the link; and any row in a scenario.

After a move the row and its rows go under the new parent at once, the totals above both places
follow, the new parent opens and the page reads the structure again. Until then, the moved row is
last among its new parent's rows.

### The Grid on a phone

The Grid is a list of cards, each with a 44-pixel button to open and close it. Cards step in a
little for each level, up to four, and deeper cards say their level's name instead. Each shows its
key, summary and the first two columns, with their names, and its marks, such as "+1 not shown";
when a card needs more room for them, or for larger text, every card grows to fit. Tapping a card opens a sheet with every
column, where cells edit, and **Move under…** and **Remove from parent**. There is no dragging on a
phone, and nothing scrolls sideways.

### In a scenario

With a scenario open, the Grid shows the tickets as they are, not their drafts, and its cells and
rows cannot be changed: the page says so. Its editors can still change the structures, which
belong to the plan.

### Who sees what in the Grid

- **Rows are only tickets you may see**: the Add tickets step through the plan, like every view,
  and the other steps through your own access to tickets, across tracks.
- **A parent you may not see breaks the path**: its children you may see become top rows.
- **Hidden tickets below a row** are only counted, as "+N not shown": children under the rows an
  Add children step opened, and linked tickets of the steps' link types. They are never keyed,
  valued or added into a total.
- **Group names** come only from the rows shown.
- **Formula fields** stored on tickets keep their stored value, which may count children you may
  not see, as anywhere else.

Making, changing and deleting a structure are kept in the audit log, by its name. Edits and moves
are the tickets' own changes, in their history. A copy of a plan takes its structures, as made by
whoever copies it, and deleting a plan deletes them. The structures you made are in your data
download by plan and name, without their steps or columns; if your account is erased, they stay.

## Changing and sharing a plan

The plan's owner and site administrators see **Settings**: its name, description, sources and
**Who sees it** (**Only me** or **Everyone signed in**). Sharing a plan needs the permission to
share dashboards and saved searches. The sources hidden from the person editing stay in the plan,
so nobody removes what they cannot see. Under **A period starts on**, the day chosen is also
written out in words. **Delete plan**, in the danger colour, asks first, in the page: whether to
delete the plan for everyone who sees it, its views and capacity with it; its tickets stay as they
are. **Delete** and the plan's name does it and takes you back to Plans; **Cancel**, which has the
focus, or Escape puts the button back. If the plan could not be deleted, the page says so and the
question stays, to try again or cancel. If someone else deleted the plan first, the page says so
instead and the question closes, as there is nothing left to delete.

Sharing a plan does not share its tracks or saved searches: someone who may not see a source sees
nothing from it. Share those as well when they should.

## Program boards

A **program board** lays a plan's work out by team and by period, so the teams that deliver it can
plan together. Open the plan's **Program boards** tab. A plan holds as many boards as you like,
one per increment, say, each read only when opened.

- **Rows** are the plan's teams (chosen under **Settings**, **Teams and capacity**), then **Other or
  no team** for work whose team is empty or a team the plan does not plan with; a card there says
  its team.
- **A card's team** is its value in the board's **Team field**. A site administrator adds that
  field (a shared field of the type Team) once; each board says which one it reads. Until one
  exists, the tab says so: to site and configuration administrators it says where fields are
  added, with an **Open Fields** link, and to everyone else to ask a site administrator.
- **Columns** are the plan's own periods, the same ones Capacity counts by, starting from the one
  that holds the board's first day, after **Not scheduled** for open work with no due date. The
  period holding today says **Now**.
- **Which work:** the plan's outcomes and the work under them (features, bugs, chores, to-dos);
  never subtickets. A ticket sits in the period that holds its own due date, so a board and
  Capacity always agree. Closed work stays in its period, marked **Closed**.
- **A cell** shows its first 20 cards, outcomes first, then in rank order; "and 14 more" opens the
  search that finds all of them, and its count is that search's.
- The plan's filters apply, and stay set as you go between the list of boards and a board. Each
  card shows its dependencies as a badge ("Blocked by 2 tickets, 1 late"), with **Dependencies**
  listed below the board as on the Timeline.

A board gives no access: you see only the cards you may see anyway. Work hidden from you is never
a card and is not counted in any cell; a blocker hidden from you is counted on the card it holds
up, never named.

### Moving a card

Drag a card to another cell, or use its **Move…** button, which asks for the team and the period
(the way for the keyboard, a screen reader and a phone). Moving a card changes the ticket itself,
as if you had edited it:

- **Another team** sets its Team value; **Other or no team** clears it.
- **Another period** moves its start and due dates by the same number of days, keeping the due date
  inside that period (a due date of 31 January moved a month becomes the end of February). From
  **Not scheduled**, the due date becomes the period's last day. To **Not scheduled**, the due date
  is cleared and the start stays.

So you need the right to change that ticket: "Schedule tickets" for its dates and the right to edit
its Team value, in its track. When the move is refused, the board says why in words, and the card
goes back. Closed cards do not move, and nothing moves on an archived board.

### Working on a board together

Several people can move cards on one board at once. Each move reaches everyone else who has the
board open within about a second, without reloading, as far as each of them may see that ticket. If
someone else moved or changed a card after your board last read it, your move is refused rather
than undoing theirs: the board says "SPA-12 changed while you moved it", shows the card where it is
now, and you can move it again if you still want to.

Changes to the board itself (its name or periods) show for others the next time their board
reads, which any moved card brings.

### Making and changing boards

The plan's owner and site administrators choose **New program board**: a name, the Team field,
the day its first period holds and how many periods it shows (1 to 12). **Edit** changes them;
**Archive** keeps a finished board readable and moves nothing on it, and **Restore** brings it
back; **Delete** first says what it does, and removes the board for everyone while its tickets stay
as they are. A copy of the plan leaves its boards behind.

### On a phone

A board shows one team at a time: choose it from **Team**, and each period is a list of its cards.
Cards move with their **Move…** button.

## Releases across tracks

A **release across tracks** lines up several tracks' own releases on one end, so that people can
see whether they will land together. It belongs to the site, not to a plan, and a plan only
shows it. It holds no tickets: its work is the target tickets of its linked releases. Each linked
release stays its track's own, with its approvals, shipping, notes and page, and its track's
administrators keep every right they have over it.

The link **Releases across tracks** leads to all of them. It is on a track's **Releases**, on the
**Plans** page, on a plan's **Releases** tab, and on the page of a release that is not in one
yet. A release that is in one links to it among its facts.

### Who sees what

- **Who sees one:** the person who made it, site and configuration administrators, and anyone who
  may see one of its linked tracks. Everyone else is told it does not exist. Seeing a few of a
  track's tickets, as their requester for example, is not seeing the track, so it shows you no
  release across tracks, and no ticket you see that way ever reads as part of one.
- **What you are told:** its name, description, end, state and owner, and of each linked release
  whose track you may see, its track, name, dates, state and how many tickets you see in it.
- **What is only counted:** how many linked releases you may not see and how many open tickets you
  may not see across all of it, as one number each, never per release and never named. Nothing lets
  anyone narrow that count: no filter or period applies, and only a track's administrators can link
  its releases.

### Its end and its state

Choose its end when you make it: **On a fixed date**, or **When its work completes**. Its state is
worked out each time it is read, from all its work, hidden work too, so it says the same to
everyone: **No releases**, **Upcoming**, **Ready to ship** (it has tickets and none is open),
**Overdue** (its date has passed and not all have shipped) or **Shipped** (all have). An archived
release, or a release of an archived track, stops counting towards it, and a track in the trash
drops out for everyone until it is restored. Its date, and each linked release's, has passed once
it has gone by on your device's clock: it turns overdue at your own midnight, on its page, in the
list and on a plan's **Releases** tab, as a track's own releases do.

**Nothing ships by itself.** **Ready to ship** is an announcement: each track's administrators still
ship their own release, with its approvals and its question about open tickets.

### Making one and linking releases

Someone who administers a track chooses **New release across tracks**, gives it a name and an end,
and ticks upcoming releases of tracks they administer: one per track, and a release can be in only
one. **Link a release** on its page, offered if you administer a track, and **Add to a release
across tracks…** on a release's page do the same later. Joining two tracks takes someone who
administers both, or a site administrator. The list stops at 500 releases and says so; type a word
of a track's or a release's name in the filter and the rest can be found too.

Linking moves no date. A release on another day reads as **Out of step** until someone moves it.
Its track's administrators, its owner and administrators can **Remove** it, which changes no date
either. **Remove**, in the danger colour, asks first, in the table, on the card or on the release's
own page (**Remove from** and the name): it names the release and its track, and says that its
tickets stop counting here, that its date no longer moves with this one, and that only that
track's administrators can link it again, while it is neither shipped nor archived. **Cancel**, which
has the focus, or Escape keeps it. Nobody removes a release they may not see. A release merged into another or deleted leaves
by itself.

### Changing or deleting it

Its owner and administrators see **Edit** and **Delete**. **Edit** changes its name and description,
and can make it end **When its work completes**, which clears its date and moves nothing. If someone
changed it while you typed, nothing is saved: what you typed stays in the dialog, the page behind it
reads itself again, and you check it and save again. **Delete**, in the danger colour, asks first, in
the page; **Delete** and its name removes the release across tracks and leaves all its releases as
they are, on their own days. **Cancel**, which has the focus, or Escape puts the button back.

### Moving its date

Its owner and administrators choose **Move date**, then a **New date** and **Show what changes**. The
list changes nothing: it says, line by line, what the move would do. **Move 3 releases** does it, and
the dialog stays open with what happened. **Move date** is also the only way to give a release across
tracks a date again after it was set to end when its work completes. Once all its releases have
shipped, its date no longer moves and the button is gone.

The field starts on the date it already has. That is how to bring back releases that are out of step:
**Show what changes** lists those that would come back, and the move does it. With none to bring back,
it says nothing changes, offers no move and records nothing.

A release moves only if you could have moved it yourself: it is upcoming, not archived, its track
is not archived, you administer that track, and it does not start after the new date. The others
stay on their day, each with the reason in words, and read as **Out of step**. Releases hidden from
you never move, and are only counted. If someone changed it while you read the list, it lists again,
so what you confirm is what happens. If the connection drops, the dialog says the move may not have
happened: check the page, then try again.

On a linked release's own page, its track's administrators get **Align to** the date, which is the
release's ordinary change. Nobody loses the right to move their own release away: it just reads as
out of step.

### Where it shows

- **A release's page** names it and warns when the release is out of step; **a track's Releases**
  labels each release that is in one.
- **Search:** `crossTrackRelease = 5` or `crossTrackRelease = "Spring launch"` finds its work, as the
  person searching sees it (see [Search](search.md)). A bare number is its id; to find one named with
  a number, put the name in quotes.
- **A plan's Releases tab:** the releases of the plan's tracks you may browse, those of a release
  across tracks gathered under it first with its own whole numbers, then the rest by track, each
  group in date order with releases without a date last, at most 200. A shipped release says when
  it shipped, an upcoming one when it is due. Each says how many of its tickets are closed, or
  **No tickets in it yet** when it has none. Only the **Track** filter applies here, and the tab
  says so.
- **The Timeline and the Calendar:** linked releases on its date become one marker, "Spring launch,
  3 releases"; those on another day keep their own, marked "out of step" in words. They are not
  dragged there.

Its name and description go in your data download when you own it. If your account is erased it
stays, owned by the placeholder account. Its changes are in the audit log; each release a move
changed also records its own change, so its track's trail and webhooks hear of it. Webhooks do not
hear of the release across tracks itself, and a full export leaves it out; a backup holds it.

## Copying a plan

Anyone who sees a plan may copy it, and the copy is theirs alone. Choose **Duplicate plan** at the top
of any of its tabs and give the copy a name.

- **What comes:** the description, the sources you may see, in their order, the unit, the periods,
  the teams and the Grid's structures. Saved searches come by reference, so the copy changes when they do. Sources that are
  archived or no longer run come too, and say so as usual.
- **What does not:** sources hidden from you, which are only counted ("2 sources you may not see
  were left out"), never named; who it is shared with, since a copy should not reach anyone by
  itself; and capacity, since the amounts and notes are about people.
- **Afterwards** the two plans have no tie: a change to one does not reach the other.

## Linking to a view

Choose **Copy link** at the top of any tab. The link holds the view as it stands: the tab, the
filters, the grouping, and where the view is, which means the Timeline's zoom, the Calendar's month,
the first period of Capacity, the order of the List and the Grid's structure. The rows you closed in
the Grid stay yours, in this browser. Columns stay yours, in this browser.

A link gives no access. It is only an address:

- Someone who may not see the plan gets the page that says it does not exist or they cannot see it.
- Someone who may sees it as they may see it, so two people can get different rows from one link.
- Someone signed out signs in first and comes back to it.
- The assignee **Me** means whoever opens the link, not whoever copied it.

Moving through a view does not fill your browser's history: the back button still undoes a change of
filters, not every month you stepped through. If your browser refuses the clipboard, as it may on a
plain `http` address, a field shows the link, selected, to copy by hand.

## Downloading a view

Each view has a **Download** menu. What you get is what you may see: nothing in a file names a ticket
hidden from you, and a cell that a spreadsheet would run as a formula starts with an apostrophe.

| View | File | What it holds |
|---|---|---|
| **Summary** | CSV | Each number, what it counts and the search that finds those tickets |
| **Timeline** | CSV | The first 10,000 tickets, as the view lists them, with their days, where the days come from, their children's span and their blockers. Blockers the view does not list stay two numbers. While the critical path is on, also each ticket's slack and whether it is on the path |
| **Timeline** | Image (PNG) | The picture of up to 400 rows, group headings among them. It says how many it holds of how many, and late dependencies are dashed and say "late" in words |
| **List** | CSV | **Every** ticket of the plan you may see, however many, in your columns and order. Grouping does not change it |
| **Calendar** | CSV | The tickets of the month shown, at most 10,000 |
| **Capacity** | CSV | One line per team or person and period, and one for open work with no due date. Other work due then stays a count and an amount, counted by whole weeks. Notes stay on the page |
| **Releases** | CSV | The tab's releases, each release across tracks before those linked to it. What is hidden stays two numbers |
| **Baselines** | CSV | **Download CSV** in a comparison: the tickets of the list chosen, with their days then and now and their delay. Tickets in the baseline not shown to you stay one number |

The Grid has no download yet. Past 400 rows, filter the plan to fit the image: the page says so beside the button. If your browser
cannot draw it, the page says that too and no file comes. Headers are in your language, and the image
is drawn in light colours whatever your skin.

Every CSV file is UTF-8 and starts with a byte-order mark, so Excel on Windows shows accented
headers such as "Versión" properly when you open the file with a double-click. Cells are separated
by commas: if your spreadsheet expects semicolons, as it may with Spanish settings, open the file
through its import from text and choose the comma.

Downloading the Timeline, the Calendar or the List counts as a bulk export for your administrators'
security alerts. Keep in mind that a saved file leaves Taskmoor's permissions: whoever
you send it to reads what it holds.

## Not yet in plans

Drafts hold start and due days and Team values only: the assignee, estimates, sprint, release,
rank, status and new tickets cannot be drafted yet. Only the main scenario is applied from, a whole
ticket at a time, and an apply cannot be undone (the ticket's history shows it). Scenarios are
shared, never private, and a scenario has no capacity of its own; the comparison does not compare late dependencies or team loads. A link cannot be
named and saved as a view, or made public; files come as CSV and PNG only, by hand, with no
schedule; and a copy cannot follow its original. A program board draws no lines between its cards
(its badges and list say the same), shows no one else's cursor, cannot take its columns from each
team's own sprints, and cannot be downloaded. Capacity counts work by its due date, in points or
hours: velocity from past sprints, capacity in days or as a percentage of a working week, time set
aside for leave as its own entry, and copying capacity between periods are not in plans yet.
Releases across tracks cannot yet be shipped together, have no combined notes, burndown or forecast
date, gather no approvals in one place and send no notifications.

Auto-scheduling fills the plan's periods, not sprints, with the capacity set for them, not velocity
from past sprints. It proposes days only, never a sprint, a Team value or an assignee. A run in
rank order does not go back to fill room an earlier ticket left or keep a ticket's own length, and
no run splits a ticket across periods or skips weekends and holidays. A release's date is a note,
not a limit. A run's choices and its result are not saved with the plan, and it never runs by
itself, for example when capacity changes. No single action discards only the auto-scheduler's
drafts. Evening out load moves work only later and by the plan's periods, never by day, never
above the lowest level and never a ticket dated by its sprint; it does not prefer the tickets with
the most slack, and a ticket's fixed dates come only from the run's keep choices, not from a mark
kept on the ticket.

Baselines are captured by hand, never by themselves when a scenario is made main or applied, and
keep start and due days only, not estimates, Team values, sprints or releases, nor parents' spans.
The Timeline does not draw a baseline's bars under today's, and the Scenarios comparison cannot
take a baseline as one of its sides. Delays, slack and the critical path count calendar days, not
working days, and the critical path does not count capacity or go through parents' spans.

The Grid moves one row at a time, never several at once, and never by dropping a row on a group to
set its field; it cannot draft changes in a scenario, sort rows by a column, show other people's
changes without **Refresh**, or be downloaded, and a total does not link to the search of its
rows. Grouping takes only fields with one value, never labels; linked tickets go at most three
links away; progress counts closed tickets, never a percentage or a weight of their estimates; and
a structure belongs to its plan, with no filters of its own beyond the plan's and its query.
