---
title: "Plans"
audience: users
sources: apps/web/src/App.tsx, apps/web/src/plans/PlansPage.tsx, apps/web/src/plans/PlanPage.tsx, apps/web/src/plans/PlanSummaryPage.tsx, apps/web/src/plans/PlanTimelinePage.tsx, apps/web/src/plans/PlanListPage.tsx, apps/web/src/plans/PlanCalendarPage.tsx, apps/web/src/plans/PlanCapacityPage.tsx, apps/web/src/plans/CapacityDialog.tsx, apps/web/src/plans/PlanSettingsPage.tsx, apps/web/src/plans/SourcePicker.tsx, apps/web/src/plans/TeamPicker.tsx, apps/web/src/plans/address.ts, apps/web/src/plans/PlanShareActions.tsx, apps/web/src/plans/DuplicatePlanDialog.tsx, apps/web/src/plans/DownloadMenu.tsx, apps/web/src/plans/planExport.ts, apps/web/src/plans/planImage.ts, apps/server/src/routes/search-export.ts, apps/web/src/timeline/TimelineView.tsx, apps/web/src/styles/plans.css, apps/web/src/timeline/DependencyList.tsx, apps/web/src/timeline/dependencies.ts, apps/web/src/calendar/CalendarView.tsx, apps/web/src/timeline/refusal.ts, apps/web/src/i18n/messages.en.ts, apps/server/src/routes/plans.ts, apps/server/src/routes/plan-views.ts, apps/server/src/routes/plan-capacity.ts, apps/server/src/plans/query.ts, apps/server/src/plans/model.ts, apps/server/src/plans/periods.ts, apps/server/src/plans/cross-track.ts, apps/server/src/routes/cross-track-releases.ts, apps/server/src/search/cross-track.ts, apps/web/src/plans/PlanReleasesPage.tsx, apps/web/src/releases/CrossTrackReleasesPage.tsx, apps/web/src/releases/CrossTrackReleasePage.tsx, apps/web/src/releases/MoveDateDialog.tsx, apps/web/src/releases/NewCrossTrackDialog.tsx, apps/web/src/releases/ReleasePage.tsx, apps/web/src/releases/useCandidates.ts, apps/server/src/search/bind.ts, apps/web/src/timeline/markers.ts, docs/adr/0122-multi-track.md, docs/specs/03-planning-time-discovery-and-quality.md, docs/adr/0114-glass-interface-and-clear-sections.md
accessed: 2026-11-13
attestation: own-words
---
# Plans

Plans bring the work of several tracks together in one place, without changing how those
tracks work. Each **plan** gathers the tickets of the tracks and saved searches you choose, and
shows them as a **Summary**, a **Timeline**, a **List**, a **Calendar**, its teams'
**Capacity** and its tracks' **Releases**. Open **Plans** in the sidebar, under **Plan and track**.

A plan never gives anyone access. Everyone who opens it sees only the tickets they may see
anyway, exactly as a search would show them.

## Making a plan

1. Open **Plans** and choose **New plan**.
2. Give it a name.
3. Tick its tracks and saved searches. **Find a track or saved search** narrows both lists.
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
filter the plan to see the rest.

On a phone, the tab bar scrolls sideways and starts with the open tab in view.

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
another; changing the periods clears the capacity set for single periods. Settings asks first. A
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
note, so a note should say what planning needs ("Leave"), not why. If someone changes the plan's
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

## Changing and sharing a plan

The plan's owner and site administrators see **Settings**: its name, description, sources and
**Who sees it** (**Only me** or **Everyone signed in**). Sharing a plan needs the permission to
share dashboards and saved searches. The sources hidden from the person editing stay in the plan,
so nobody removes what they cannot see. Under **A period starts on**, the day chosen is also
written out in words. **Delete plan**, in the danger colour, first asks whether to delete the plan
for everyone who sees it, its views and capacity with it; its tickets stay as they are.

Sharing a plan does not share its tracks or saved searches: someone who may not see a source sees
nothing from it. Share those as well when they should.

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
drops out for everyone until it is restored.

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
either. Nobody removes a release they may not see. A release merged into another or deleted leaves
by itself.

### Changing or deleting it

Its owner and administrators see **Edit** and **Delete**. **Edit** changes its name and description,
and can make it end **When its work completes**, which clears its date and moves nothing. If someone
changed it while you typed, nothing is saved: what you typed stays in the dialog, the page behind it
reads itself again, and you check it and save again. **Delete** removes the release across tracks and
leaves all its releases as they are, on their own days.

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
  it shipped, an upcoming one when it is due. Only the **Track** filter applies here, and the tab says so.
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

- **What comes:** the description, the sources you may see, in their order, the unit, the periods and
  the teams. Saved searches come by reference, so the copy changes when they do. Sources that are
  archived or no longer run come too, and say so as usual.
- **What does not:** sources hidden from you, which are only counted ("2 sources you may not see
  were left out"), never named; who it is shared with, since a copy should not reach anyone by
  itself; and capacity, since the amounts and notes are about people.
- **Afterwards** the two plans have no tie: a change to one does not reach the other.

## Linking to a view

Choose **Copy link** at the top of any tab. The link holds the view as it stands: the tab, the
filters, the grouping, and where the view is, which means the Timeline's zoom, the Calendar's month,
the first period of Capacity and the order of the List. Columns stay yours, in this browser.

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
| **Timeline** | CSV | The first 10,000 tickets, as the view lists them, with their days, where the days come from, their children's span and their blockers. Blockers the view does not list stay two numbers |
| **Timeline** | Image (PNG) | The picture of up to 400 rows, group headings among them. It says how many it holds of how many, and late dependencies are dashed and say "late" in words |
| **List** | CSV | **Every** ticket of the plan you may see, however many, in your columns and order. Grouping does not change it |
| **Calendar** | CSV | The tickets of the month shown, at most 10,000 |
| **Capacity** | CSV | One line per team or person and period, and one for open work with no due date. Other work due then stays a count and an amount, counted by whole weeks. Notes stay on the page |
| **Releases** | CSV | The tab's releases, each release across tracks before those linked to it. What is hidden stays two numbers |

Past 400 rows, filter the plan to fit the image: the page says so beside the button. If your browser
cannot draw it, the page says that too and no file comes. Headers are in your language, and the image
is drawn in light colours whatever your skin.

Downloading the Timeline, the Calendar or the List counts as a bulk export for your administrators'
security alerts. Keep in mind that a saved file leaves Taskmoor's permissions: whoever
you send it to reads what it holds.

## Not yet in plans

The program board, draft changes and scenarios, and the auto-scheduler come in later versions. A
link cannot be named and saved as a view, or made public; files come as CSV and PNG only, by hand,
with no schedule; and a copy cannot follow its original. Dependencies are the **Blocks** links only:
other link types do not count as dependencies. Capacity counts work by its due date, in points or
hours: velocity from past sprints, capacity in days or as a percentage of a working week, time set
aside for leave as its own entry, and copying capacity between periods are not in plans yet.
Releases across tracks cannot yet be shipped together, have no combined notes, burndown or forecast
date, gather no approvals in one place and send no notifications.
