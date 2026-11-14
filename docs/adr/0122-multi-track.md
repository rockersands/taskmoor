# ADR-122: Multi-track: plans over several tracks and saved searches

- Status: Accepted
- Date: 2026-11-03
- Backlog: T-088 (`docs/plan/tickets.md`), tasks in `docs/plan/multi-track-tasks.md`

## Context

Someone who leads several teams needs their work in one place without changing how those teams
work. Spec 03 section 1 describes it (PLN-001 to PLN-011). The user decided on 2026-11-03
(`docs/plan/decisions.csv`, rows "Multi-track", "Multi-track scope" and "Multi-track first
rules"):

- The feature is called **Multi-track**; one of them is a **plan** over several tracks and saved
  searches. Changed on 2026-11-13 (`docs/plan/decisions.csv`, "The Multi-track section's name"):
  the section is named **Plans**, as its addresses (`/plans`) already were, and one of them stays a
  **plan**. This record keeps its old title and file name; the interface and the manual say Plans.
- All of Multi-track is in 1.0 except the hierarchy grid (PLN-010) and baselines (PLN-011). It is
  built in stages, one ticket each: this first one (T-088), then dependencies, teams and
  capacity, cross-track releases, the program board, draft changes and scenarios, the
  auto-scheduler, and duplicating or exporting (T-089 to T-089g).
- A plan holds any number of tickets; each view lists the first 10,000 and says so.
- No board sources: each board belongs to one track (ADR-116), so choosing the track does the
  same.
- One value per filter at first.
- A plan shows only what each viewer may see; a source they cannot see adds nothing for them, and
  a plan with no visible source finds nothing.

Nothing here was taken from another product: no competing product, its documentation or its
screens were opened (ADR-003). The views reuse Taskmoor's own track timeline (ADR-064), list and
calendar (ADR-065) and summary (ADR-116).

The terminology file first mapped the other product's "Plans" to "roadmaps". The user named the
feature Multi-track and calls one a plan; "plan" is ordinary English for it, the feature's name is
our own, and the terminology file then listed Multi-track. Since 2026-11-13 it lists Plans, with
one of them a plan and never a "roadmap". If the user prefers another word for one
plan, the rename is in the UI strings and the manual; the tables and routes can keep theirs.

## Decision

### Stage 1 (T-088): plans, sources, views, grouping, filtering and rescheduling

#### What a plan is

- Three tables (migration 0101): `plan` (owner, name, description, version), `plan_source` (a
  track or a saved search, in the order chosen) and `plan_share` (the scopes of dashboards,
  ADR-060, without `public`). A plan has at most 500 sources.
- A source is a track (either configuration mode) or a saved search. A board is not a source
  (PLN-001 reworded).
- Its owner and site administrators change and delete it. Others see it through its shares: a
  person, a group, a track's members (every role or one) or everyone signed in. Plans are never
  public, because every view needs a signed-in person. Sharing needs "Share dashboards and saved
  searches", the permission that already guards sharing, so no new permission is added.
- One plan an editor changes is protected by its `version`: a stale edit answers 409.

#### A plan gives no access

- **The plan's tickets are a query, composed for each viewer** (`apps/server/src/plans/query.ts`)
  from the sources that viewer may see: the tracks they may browse as `track IN ("A", "B")`, and
  the condition of each saved search they may see, in brackets, joined by `OR`. Every view
  compiles it through `compileQuery` (`boards/data.ts`), which adds the viewer's ticket filter
  (QRY-008), so a plan never shows, counts or groups a ticket its viewer may not see.
- **A source the viewer cannot see adds nothing for them**, and the plan's page says how many of
  its sources are hidden from them, never which. A track counts as seen only when the viewer
  browses the track itself (track-level "Browse track", as `visibleTrack` decides): a ticket-level
  grant (requester, assignee, a person or group field) shows single tickets, never the track. Such
  a track's name, sprints and releases stay out of every answer; a ticket it shows carries its
  track's key, which the ticket's own key holds anyway. A plan with no visible source finds nothing:
  views answer empty without running a query, and the plan's `query` is null.
- A saved search's condition is printed from its parsed query (`printQuery`, without its
  ORDER BY), never as `savedSearch = <id>`: a saved search named like another's id would be read
  instead (`search/saved.ts` reads names first). Its own references to other saved searches stay
  and are read as the viewer, as in a search.
- **A saved search whose query no longer runs is left out and flagged** (`broken`), so one bad
  source never takes a plan down. A track that was deleted reads as hidden.
- The composed text is the plan's `query` in every answer, so a number links to the search that
  finds exactly those tickets, and the List is that search.
- Editors see only the sources they may see. A change of sources replaces those and keeps the
  ones hidden from the editor, so nobody removes what they cannot see, and adding a source
  someone cannot see answers `not_found` for it, as for one that does not exist.

#### Filters and grouping

- **Filters**, one value each (the user's decision): track (a key), assignee (`me`, `none` or a
  person's id), ticket type (a name) and stage (`new`, `active`, `closed`). They become clauses
  ANDed to the plan's query on the server: `track = "A"`, `assignee = currentUser()`,
  `assignee IS EMPTY`, `assignee = 12`, `type = "Feature"`, `stage = active`. The views send them
  as query parameters; the page keeps them in its address (`#/plans/12/timeline?assignee=me`), so
  a link opens the same view and the browser's back button undoes a change. The choices come
  from `GET /plans/:id/choices`: the plan's tracks, types and up to 50 assignees.
- **Grouping**, also in the address (`group=`): by track, assignee, status, ticket type or
  priority. The Timeline groups on the page from each item's fields, keeping parents above their
  children inside a group. The List groups through the two-dimensional report and the search,
  with the plan's query, as a track's list does (`list/client.ts`, `GROUP_FIELDS` plus `track`).
- No grouping by outcome yet: the Timeline already puts outcomes above their children, and the
  query language has no condition for "under this outcome" for the List to link to. It waits
  for that condition (the next stages, with dependencies).

#### The views

Each view answers the plan's query with the filters, as the viewer. Each lists at most the first
**10,000 tickets** and says so (`truncated`; PLN-012).

- **Summary** (`GET /plans/:id/summary`): how many tickets, open, overdue, due within 7 days,
  without dates, closed in the last 7 days; by stage, by track and the ten people with most open
  tickets. One statement with `GROUPING SETS` counts them all; each condition is compiled from
  the same text its link searches, so every number equals its search (a test checks each). The
  sources are listed with their state.
- **Timeline** (`GET /plans/:id/timeline`): the track timeline's answer (ADR-064) over the plan:
  items in rank order, roll-ups, blocking links between listed tickets, and the sprints and
  releases of the tracks it lists. Differences: the first 10,000 are chosen before anything else
  is read about them, so the cost follows the listed tickets, not the plan; roll-ups cover every
  descendant the viewer may see, in the plan or not, so a plan of outcomes still shows their span;
  a parent the viewer may not see reads as none (`parentId` null) instead of its id. Each item
  also carries its track, assignee and priority, for grouping. The page draws only the rows in
  view once there are more than 200 (rows are a fixed 44px), for the track's timeline too, taken
  from where the list stands whenever windowing switches on; the row holding focus and the chosen
  one stay drawn at their own place while scrolled away, so keyboard focus never drops.
- **List**: the search with the plan's query (`POST /api/v1/search`) in the person's columns,
  sorted and grouped, cells edited in place as in search results. It stops offering more rows
  at 10,000.
- **Calendar** (`GET /plans/:id/calendar?from=&to=`): the track calendar (ADR-065) over the plan;
  a day with more than six entries shows six and a button for the rest.
- `apps/web/src/timeline/TimelineView.tsx` and `apps/web/src/calendar/CalendarView.tsx` hold the
  drawing both a track and a plan use; the track pages keep only their header and data.

#### Rescheduling

- Dragging a bar, its ends or a calendar entry, the keyboard (Alt and the arrows) and the side
  panel change the ticket through its own route (`PATCH /tickets/:key`), so "Schedule tickets",
  the ticket's history and its events apply, ticket by ticket, across tracks. Nothing is held in
  the plan: draft changes arrive with scenarios (PLN-002, T-089e).
- A refusal says why in plain words, from the ticket route's codes and the permission it names:
  no "Set due dates", a status or field lock (WF-007, which answers `forbidden` with its locks), an
  archived track, a ticket gone or hidden, dates that are not valid, a change made meanwhile.
- Only the answer to the latest request is drawn, so a slow answer for filters or a month left
  behind never replaces the current one; when the plan for new filters fails to load, the page
  says so and no view runs with the old ones.

#### Routes, events and records

- `GET`, `POST /api/v1/plans`; `GET`, `PATCH`, `DELETE /api/v1/plans/:id`; `GET .../choices`,
  `.../summary`, `.../timeline`, `.../calendar`. They are internal routes in the API document
  (`x-taskmoor-stability: internal`) until the next stages settle their shape. Token scopes follow
  the method: read for GET, write for the others.
- One event per change, in its transaction: `plan.created` (name, sources and share scopes as
  `track:12`, `saved_search:3`), `plan.updated` (changes, old and new), `plan.deleted` (name).
  All three are audited, as dashboards are: a plan is configuration others may see.
- A person's data download lists the plans they own. Erasure keeps the plans, whose owner becomes
  the placeholder account, like dashboards and saved searches.
- The sidebar lists **Multi-track** under "Plan and track", after Dashboards.

#### Seams left for the next stages

- `plan_source.kind` takes new kinds without a new table; `plan` takes settings (working days,
  estimation units) as columns.
- The views answer through one function, `planWhere`, that later stages (dependencies, capacity,
  scenarios) read the plan's tickets through.
- Timeline items already carry links with their direction; a dependencies view reads them.
- Rescheduling is one function on the page (`reschedule` in the plan client); scenarios replace
  it with a draft change.

### Stage 2 (T-089): dependencies on the Timeline

PLN-006, reworded to what is built and moved to M1. Nothing new is stored: dependencies are the
blocking links tickets already have (CORE-018), so there is no migration, route, event or audit
decision; the Timeline's answer grows one field, read with the timeline's own scope.

#### What a dependency is

- A link whose type's outward phrase is "blocks", as on a track's timeline (ADR-064): its source
  is the **blocker**, its target the **blocked** ticket. Choosing other link types as
  dependencies, and flagging dependencies inside one sprint, are not in this stage. Both were in
  PLN-006's first wording, which the user put in 1.0 with the rest of Multi-track, so they moved
  to their own requirement, PLN-013, M2 in the spec until a stage builds them. Which stage, and
  whether blockers outside the plan that the viewer may see should be named with their track and
  status as that wording also said, is the user's question (`decisions.csv`, "Dependency
  options").
- **Late**: the blocker ends on or after the day the blocked ticket starts (the bars' days: their
  own, their sprint's, or a parent's roll-up), both still open. A closed blocker holds nothing
  up, and a closed blocked ticket is done, so neither is ever late. One function decides it
  (`dependencyState`, `apps/web/src/timeline/dependencies.ts`) for the lines, the badges and the
  list, on a track's timeline too, whose lines were late by days alone before.

#### What the viewer is told

- **Listed blockers** (both tickets among the Timeline's listed tickets): a line from the
  blocker's end to the blocked ticket's start, dashed in the danger colour when late; a line needs
  both bars, so a ticket without days has its badge and its entry in the list, but no line.
- **A badge beside each blocked bar** (or before "No dates") counts all its blockers, listed or
  not. When one is late it turns red and says "late" in words. The bar's description carries the
  full sentence ("Blocked by 3 tickets, 1 late"), so a screen reader hears it on the bar.
- **The list** below the Timeline (`DependencyList`) says the same for the keyboard and screen
  readers: each blocked ticket in the Timeline's order, its listed blockers each with "Late",
  "On time", "Closed" or "No dates" in words and the days that decide it, and the counts of the
  others. "Only late ones" narrows it; it shows 100 tickets at a time. A button beside the zoom,
  "List of dependencies", moves focus to its heading, past every row of the Timeline.
- **Blockers the Timeline does not list** are counted per blocked ticket
  (`blockersElsewhere: { id, outside, unlisted }` in `GET /plans/:id/timeline`):
  - `outside`: outside the plan, or hidden from the viewer, as one number ("blocked by 2 tickets
    outside this plan"). Never a key, summary, track, status or date, so the answer reads the same
    whether such a blocker is hidden or merely elsewhere. This is the rule for hidden sources
    (stage 1): a number, never which. A ticket's own page lists only the links its viewer may see
    and counts none; the plan's count adds no name to that, only that something outside the
    viewer's plan holds the ticket up, which is what someone planning needs to know.
  - `unlisted`: tickets of the plan for this viewer (they match its query without the filters,
    with the viewer's ticket filter) that the filters or the first 10,000 leave out, so "outside
    this plan" is never said of the plan's own tickets. They are tickets the viewer sees; they are
    counted, not drawn, because they have no row.
  - Blockers in the trash count for nobody, as a ticket's links leave them out.
- Rescheduling is unchanged: moving a bar is the ticket's own change, and the next read redraws
  the lines, badges and list, so a late dependency clears once the blocked ticket moves after its
  blocker. The side panel adds which blockers are late and the counts of the others.

#### How the server reads them

- One statement reads every blocking link whose target is listed (the target's index), with the
  blocker outside the trash; those whose blocker is listed are lines, the rest are counted. Only
  when a filter is set or the view is cut at 10,000 does a second statement ask which of the
  counted blockers are in the plan for the viewer (`planTickets` now also gives `unfiltered`, the
  plan's condition without the filters); without either, every ticket of the plan is listed, so
  none is.
- Measured with the size test, which now gives every outcome's features a chain of eight blocking
  links and each track's last feature one into the next track (`plans.large.test.ts`, medians of
  five reads, a Mac, 2026-11-03): at 100,000 tickets and about 80,000 links
  (`TASKMOOR_LARGE_PLANS=1`), the Timeline answers in 136 ms (126 ms without dependencies in
  stage 1) and filtered in 30 to 42 ms over two runs (28 ms); every gate reads 10,000 tickets
  and about 8,000 links (95 to 97 ms). Tickets rank track by track, so those links never run
  from a ticket the 10,000 leave out to a listed one; the plan's last ticket therefore also
  blocks its first, and a ticket of a track outside the plan blocks its second. Both reads, at
  both sizes, then ask which counted blockers are the plan's, and the test checks the answer:
  one counted as the plan's own (`unlisted`), one as outside.

### Stage 3 (T-089b): teams and capacity

PLN-005 and PLN-009, reworded to what is built and moved to M1. A plan plans with site teams
(ADR-076) and shows, per team and per person, the work due in each period against what they can
take on.

#### What is stored (migration 0102)

- `plan` gains its settings: `capacity_unit` (`points` or `hours`) and its periods,
  `period_kind` `weeks` (every `period_weeks`, 1 to 6, from `period_anchor`, any day; periods
  repeat from it both ways) or `month` (calendar months). Existing plans get two-week periods
  from Monday 2024-01-01, in points.
- `plan_team`: the teams a plan plans with, in order (at most 50). A team gives no access: it
  only says whose work the Capacity view lists. A deleted team leaves the plan.
- `plan_capacity`: a team's or a person's capacity in the plan's unit, `period_start` null for
  every period or one period's first day for that period alone, with a note of up to 200
  characters (leave, a holiday). One row per plan, subject and period. A person's capacity is
  the plan's, whichever of its teams they are in. Amounts are `numeric(8, 2)`, 0 to 100,000.
- Changing the unit clears every capacity of the plan (amounts in points mean nothing in hours);
  changing the periods clears the capacity set for single periods, unless the anchor only moved
  by whole periods, which makes the same periods. A team that leaves the plan takes its
  capacity, and that of people in none of the teams left. `plan.updated` says how many went
  (`capacityCleared`).

#### What is counted

- **Work** is the plan's tickets as the viewer sees them, with the filters (`planTickets`, so
  no ticket the viewer may not see is listed), in the plan's unit: points from the workspace's
  own Points field (the oldest shared number field named Points, as boards read it), hours from
  the original estimate. A ticket counts whole in the period that holds its due day, for its
  assignee and for every plan team that person is in. Spreading a ticket over the days between
  its start and due was considered: it gives fractions no search can show, so a number would
  no longer equal its search. Tickets without an estimate count in the ticket count and are
  shown as "without an estimate". Open tickets without a due day have a column of their own.
- **Every count equals a search:** each row has a `clause` (`assignee = 12`,
  `assignee IN membersOf("id:3")`, `assignee IS EMPTY`, or the plan's people in none of its
  teams as `assignee NOT IN membersOf(...)`), each period a `clause` (`due >= "..." AND due <=
  "..."`), and the open work `stage != closed AND due IS EMPTY`; the plan's `query` ANDed with
  them is the link, and the test checks the count and the sum of points of each against the
  search, for three viewers.
- **Work elsewhere** (`elsewhere`, per person and period): the rest of a team member's work due
  in the period, outside the plan, left out by the filters or in tracks the viewer may not see,
  outside the trash and archived tracks. It counts against their capacity, since they have to do
  it all, as one count and one amount, never a key, summary, track or day: the rule of hidden
  sources (stage 1) and blockers outside the plan (stage 2). So a viewer learns how much hidden
  work a person has due, but not what. Only the plan's team members have this number; unassigned
  work and people in none of the teams have no capacity, so nothing elsewhere is read for them.
- **Elsewhere goes by whole weeks**, Monday to Sunday, each counted in the period that holds its
  Thursday, which holds at least four of its days in periods of a week or more. Anyone may own a
  plan, choose its teams and move one-week periods a day at a time; counted by due day, the
  totals for two anchors a day apart told which day each hidden ticket falls due, with its
  points. By weeks on one grid that no setting moves, every total is a sum of whole weeks, so no
  choice of periods reads a hidden ticket's due date closer than its week. The price: in periods
  that do not start on a Monday, and in months, work elsewhere due in the days around a period's
  edge counts in the period next to it (up to three days off), and the page says it is counted
  by weeks. Elsewhere is never a link, so no search has to agree with it.
- **Capacity in a period** is that period's own row, else the row for every period. A team
  without either has its members' summed, when any member has one (`from: members`). Someone
  with no capacity is never over.
- **Over capacity**: the work here and elsewhere (`load`) is more than the capacity. The cell
  is red and says "Over capacity by 8 points" in words, so colour is never the only sign.

#### Routes, events and records

- `GET /api/v1/plans/:id/capacity?from=&periods=` with the views' filters: up to 12 periods
  from the one holding `from` (today by default), with `previous` and `next` for paging. A read,
  for everyone who sees the plan. It runs in the views' read-only transaction with their timeout,
  in two statements: the plan's work grouped by assignee and due day, and the members' work
  elsewhere the same way.
- `PUT /api/v1/plans/:id/capacity` with `entries` (at most 200): a team's or a member's capacity
  for every period (`period` null) or one period's first day, `amount` null to remove it. Only
  the plan's owner and site administrators (`forbidden` with `edit_plan` otherwise), only its
  teams and their members, only first days of its periods (`not_in_plan`,
  `not_a_period_start`). The plan row is locked first, and the settings, teams and members are
  read under that lock, so two editors never interleave and a change of the plan that commits
  meanwhile is seen: it never writes a row for someone whose team left, or for periods that are
  gone. The page also sends `unit` and `period`, the settings the amounts were typed for; when
  the plan's are no longer those (an anchor moved by whole periods is the same), nothing is set
  and the answer is 409 `settings_changed` with the plan's, since 30 points are not 30 hours. One `plan.capacity_set` event lists every change with its amount and note before
  and after; nothing changed records nothing. Audited, as `plan.updated` is: capacity is
  configuration others see. A note is in the event as typed, as a plan's description is.
- **An erased person's notes leave the history too** (T-089j, the user's decision of 2026-11-13).
  The erasure's scrub job (`ERASE_SCRUB_TASK`, ADR-111) finds the `plan.capacity_set` events
  that changed `user:<id>` and empties the notes of those changes, before and after; the amounts
  and other subjects' notes stay. The audit log is append-only and never rewritten (ADR-034), so
  it keeps the stored words but shows them empty when read or exported, with `masked: true`, as it
  masks an erased person's name (`audit/query.ts`), and in a personal data download's
  `audit.ndjson`, whoever downloads it; `audit-verify` still checks the stored
  records. Notes should still say "Leave", not why: until the erasure they are as typed.
- Teams, the unit and the periods are fields of `PATCH /api/v1/plans/:id` (`teams`,
  `capacityUnit`, `period`), in `plan.updated`.
- Both routes are internal in the API document, as the other plan routes. Token scopes: read for
  the GET, write for the PUT.
- A person's data download lists their capacity in plans with its notes, by the plan's id (the
  plan may be hidden from them); erasure deletes it (`PERSONAL_TABLES`), as notes may say why
  someone was away, and clears its notes from the events as above. The plan stays.

#### The page

- **Capacity** is a tab of the plan, after Calendar: a table of teams, each followed by its
  people, then unassigned work and people in none of the teams; a column per period (six in
  view, the one holding today marked "Now" in words) and one for open work without a due day.
  Each cell says "16 of 10 points" with a bar, "Over capacity by 6 points" when over,
  "+13 points in 1 ticket elsewhere", the period's note, and the count as a link to its search.
  On a phone each row is a card with the periods as a list. It reads again when a ticket changes.
- The plan's editors open **Set capacity** on a team or person: a dialog with the capacity and
  note for every period, and one for each period in view, which replace it there. It sends only
  what changed, in one request. A note goes with a capacity: one typed where no capacity is typed
  is refused at that capacity, which takes the focus, rather than dropped; emptying a capacity
  removes it with its note.
- **Settings** gains **Teams and capacity**: the teams, ticked in order, the unit and the
  periods; a new unit or new periods ask first, saying what will be cleared.

#### Kept, not built

The first wordings of PLN-005 and PLN-009 asked for more than this stage builds. These wait for a
requirement of their own (the coordinator's to number; not taken here, as this stage was given
only PLN-005 and PLN-009) and for the user's decision of when:

- velocity from history (the last three completed sprints) as a team's default capacity, and
  other teams' sprints as external iterations, which need the sprint as a period;
- capacity in days, percent allocations and a configurable working week (32 hours, say);
- allocating time to outcomes, level-2 tickets and free-text entries (leave as an entry rather
  than a period's note), people and work views of allocations, bulk copy, paste and fill, and
  CSV import;
- re-running scheduling previews when capacity changes, which belongs to the auto-scheduler
  (PLN-004, MT-07): it will read capacity from `plan_capacity`.

#### Measured

`plans.large.test.ts` now gives the plan a team of its member, with 30 points a period, and reads
the Capacity view over six periods five times, checking the team's first count against its
search. Medians of five reads, a Mac, 2026-11-03: 8 ms at 10,000 tickets (every gate) and
23 ms at 100,000 (`TASKMOOR_LARGE_PLANS=1`; the Timeline took 155 ms in the same run, the
machine being busier than for stage 2's 136 ms). Both statements answer counts grouped by
assignee and due day, so what reaches the server follows the people and days in view, never
the plan's tickets one by one.

### Stage 4 (T-089c): releases across tracks

**Built on 2026-11-04** to the design below; the questions at the end are still the user's, and the
design takes the first answer each time. PLN-007 moved to M1 with this stage, reworded to what is
built (the wording is under "Tests"). "As built" at the end says where the build went further than
this text, or corrected it.

A **release across tracks** (the spec's cross-track release; `cross_track_release` in code) lines
up several tracks' own releases on one end. It belongs to the workspace, not to a plan, so it is
there with no plan at all, and a plan only shows it. It holds no tickets: its work is the target
tickets of its linked releases. Each linked release stays the track's own, with its approvals,
shipping, notes and page (CORE-016, ADR-061), and the track's administrators keep every right
they have over it, so nothing changes in how a team works unless someone moves a date they could
have moved themselves.

#### What is stored (migration 0106)

- `cross_track_release`: `workspace_id`, `owner_id`, `name` (1 to 255), `description` (up to
  4,000), `end_rule` (`fixed_date` or `work_complete`), `release_date` (a day, or null),
  `version`, `created_at`, `updated_at`, with a check that the day is set exactly when the rule is
  `fixed_date`. Names are not unique: a unique name would answer `name_taken` for a release the
  person may not see, and so tell them it exists.
- `cross_track_release_member`: `workspace_id`, `cross_track_release_id`, `release_id`,
  `track_id`, `created_at`. `release_id` is the primary key, so **a release is in at most one**
  (two would pull it towards two dates); `(cross_track_release_id, track_id)` is unique, so **at
  most one release per track**; both can be dropped later without moving data. A foreign key on
  `(release_id, track_id)` (a new unique index on `release`) keeps the track right, and deleting a
  release or purging a track removes its row. At most 100 members.
- No change to `release` columns, `ticket_release` or tickets. The schema golden file, the type in
  `schema.ts` and an `upgrade-fixtures.ts` entry come with the migration.

#### Who sees what

- **Who sees one:** its owner, site and configuration administrators, and anyone who may see one of
  its linked tracks, by the same rule as a release's own page (`canSeeTrack`: browse or administer
  the track), not the plans' stricter `browsedTracks`, or a release page could name something the
  next page refuses. A track in the trash shows nobody anything. A ticket-level grant (requester,
  assignee) shows single tickets, never the track, so it shows no release across tracks. Everyone
  else gets the same 404 as for an id that does not exist, on every route.
- **What they are told:** its name, description, end, state and owner, and of each linked release
  whose track they may see: its track, name, dates, state and own counts.
- **What is only counted:** `hidden: { releases, open }`. How many linked releases they may not
  see, and how many open target tickets the viewer may not see across all linked releases (hidden
  tracks, and hidden tickets of visible tracks), as one number. Never a key, summary, track,
  release name, date or status, and never split per release. This is the rule of stages 1 to 3.
- **No setting narrows the count.** The route takes no filter and no period, and nobody can link a
  release of a track they do not administer, so nobody can build a release across tracks to
  isolate someone else's numbers. That is the attack stage 3 had to close with whole weeks; it has
  no way in here. With one hidden release the count is that release's, which tells only that much.
- **Why count at all:** "work complete" must be true for everyone or it says something false to
  those who see less, so the state is judged on all the work, and a viewer who sees none open while
  the state says otherwise needs the number to understand it. If the user answers T-089j by leaving
  hidden work out of the count, `hidden.open` goes (one field) and the state stays judged on all.
- **Numbers equal searches:** the stage counts, warnings and first 200 tickets read through the
  search runner as the viewer (`crossTrackRelease = 5 AND stage = new`), as the release hub does,
  so the viewer's ticket filter applies (QRY-008) and each number links to its search. One statement
  counts all open target tickets and those matching the viewer's filter, for `hidden.open`, under
  the same conditions as a search: outside the trash and archived tracks.

#### The end: a fixed date, or when its work completes

- **`fixed_date`:** it has a date, and the linked releases are meant to end that day.
- **`work_complete`:** it has no date, no release's date is judged, and it ends when its work does.
- **State**, computed on each read by one pure function, never stored, over the linked releases
  neither archived nor in the trash, hidden ones too: `empty` (none), `shipped` (all shipped),
  `overdue` (fixed date passed, not all shipped), `ready` (at least one ticket, none open, not all
  shipped), else `upcoming`. Always a word with its tone, as `ReleaseState` does.
- **Nothing ships by itself.** Shipping stays per release, by its track's administrators, with its
  approvals and open-ticket prompt (CORE-016 (1), (2)). `ready` is an announcement.

#### Moving the date

- Only the owner and site and configuration administrators, as anything else about it. Having
  the right over one linked release gives no say over the others.
- **PLN-007 (2) says "after commit".** Draft changes do not exist until T-089e, so for now commit
  means a change list the person confirms: `GET .../move?date=` changes nothing and lists each
  visible linked release with its old and new day and its outcome; `POST .../move` with
  `{ date, version }` does it. Both call one function, which T-089e can hold as a draft change.
- **A release moves only if the mover could move it through `PATCH /releases/:id`:** upcoming, not
  archived, its track not archived, the mover administers that track, and its start date not after
  the new day. Otherwise it stays, with a reason per release (`no_permission`, `shipped`,
  `archived`, `track_archived`, `start_after_date`), and the rest go on, as PLN-002 (3) asks of a
  commit. Hidden releases never move and are counted ("2 more releases you may not see stay as
  they are").
- A date that nothing could follow still moves the release across tracks: the list says so first.
- **Out of step:** an upcoming linked release whose day differs. It says so in words on both
  pages, and its track's administrators get **Align to 12 Nov** on the release page, which is the
  existing `PATCH`. Nobody loses the right to move their own release away: `PATCH /releases/:id`
  is unchanged and it just reads as out of step. Out-of-step hidden releases are not even counted.
- In one transaction: lock the row, compare `version` (stale answers 409, the page lists again),
  lock the releases by id, change them, then the day. `PATCH /releases/:id` locks only its release,
  so the two cannot deadlock. Any change of members bumps `version`, so a confirmed list always
  matches what happens. All shipped answers 409 `already_shipped`. The same day brings back the
  releases out of step the mover may change (see As built); with none, it changes nothing and
  records nothing. A move also makes the rule `fixed_date`; `PATCH` with `endRule: work_complete`
  clears the day and moves nothing.

#### Linking and unlinking

- **Creating** takes at least one release, so only someone who administers a track can make one.
  Any signed-in person who does may. **Linking** needs administering the release's track and seeing
  the release across tracks: an unseen release answers `not_found`, as a plan's unseen source does;
  one seen but not administered answers `forbidden`. Shipped or archived releases are refused
  (`release_shipped`, `release_archived`), as are `release_taken` and `track_taken`.
- **Linking never moves a date.** A release that differs reads as out of step until someone moves
  it.
- **Unlinking:** the track's administrators, or the owner and administrators for a release they
  can see. Nobody removes what they cannot see (stage 1). The release stays as it is.
- **The limit this sets:** two tracks with different administrators and no shared person cannot
  be joined except by a site administrator (question 2 below).
- **A release that goes:** merged or deleted, its row goes with it and a
  `cross_track_release.member_removed` event says why. Archived, it stays linked, reads as archived
  and stops counting towards the state. A track in the trash drops out for everyone until restored.
  Deleting the release across tracks frees its releases and changes none of them.

#### Where it shows

- **Release pages (CORE-016, ADR-061):** `GET /releases/:id` and `GET /tracks/:id/releases` gain
  `crossTrack: { id, name, endRule, date } | null` from a join on the unique `release_id`, a field
  added to the release's schema in the API document and its golden file. By the rule above, anyone
  who sees the release sees this. The release page shows a fact row with a link,
  a new warning `cross_track_out_of_step` with **Align**, and for the track's administrators
  **Add to a release across tracks** and **Remove**. The hub's rows carry a small label, and the
  hub links to the list. The overview's own numbers do not change.
- **Queries:** a new field `crossTrackRelease`, type `crossTrackRelease`, with `=`, `!=`, `IN` and
  `NOT IN`, by id or name. It binds to its linked releases' ids and compiles as `targetRelease`
  does (the `ticket_release` relation, target role), so the compiler gains no path and the viewer's
  filter applies as ever. **Binding reads only the ones the person sees:** another's id or name
  answers `unknown_value`, word for word as one that does not exist. A name shared by several means
  all of them the person sees. A bare number is an id before a name, and a quoted one a name before
  an id, and it binds only to linked releases of tracks the person sees (see As built). No `IS EMPTY` (it would mark a ticket seen through a grant as linked
  to something hidden), no ordering, no history, no column in results. The field goes in section
  1.5 of file 01b; it has no compatibility name.
- **A plan:** a **Releases** tab (`GET /plans/:id/releases?track=`), after Capacity: the releases
  of the plan's tracks the viewer browses, those of a release across tracks gathered under it
  first, then the rest by track, upcoming first; at most 200 rows, and it says so. A release across
  tracks is shown when one of its linked tracks is listed, with its own whole numbers, not the
  plan's share, and its hidden count. The plan's tracks are those `choices` reads. A ticket-level
  grant adds no row (stage 1). The other filters do not apply and the page says so.
- **Timeline and Calendar:** `markers` joins the same way; linked releases with the same day
  become one marker named for the release across tracks with "3 releases", and those out of step
  keep their own, marked in words. They are not dragged there (spec 03 section 1).
- **Its own pages** are reached from the release hub, a release's page, the Multi-track page and a
  plan's Releases tab. The sidebar does not change (question 8).

#### Routes and token scopes

All are internal in the API document, as the other plan routes, and scopes follow the method.

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/cross-track-releases?state=&cursor=` | read | Those the person sees, `upcoming` or `shipped`, 100 a page |
| `GET /api/v1/cross-track-releases/candidates` | read | Upcoming unlinked releases of tracks the person administers, up to 500 |
| `POST /api/v1/cross-track-releases` | write | `{ name, description?, endRule, date?, releaseIds }` |
| `GET /api/v1/cross-track-releases/:id` | read | `{ id, name, description, endRule, date, state, owner, version, stages, open, warnings, members, hidden, tickets, truncated, viewer }` |
| `PATCH /api/v1/cross-track-releases/:id` | write | `{ name?, description?, endRule?: 'work_complete', version }` |
| `DELETE /api/v1/cross-track-releases/:id` | write | Frees its releases |
| `GET /api/v1/cross-track-releases/:id/move?date=` | read | The change list; changes nothing |
| `POST /api/v1/cross-track-releases/:id/move` | write | `{ date, version }`; the list as it happened |
| `POST /api/v1/cross-track-releases/:id/members` | write | `{ releaseId }` |
| `DELETE /api/v1/cross-track-releases/:id/members/:releaseId` | write | |
| `GET /api/v1/plans/:id/releases?track=` | read | The plan's Releases tab |

#### Events, audit and records

- One event per change, in its transaction, all audited, as `plan.*` are:
  `cross_track_release.created` (name, rule, day, release ids), `.updated` (changes), `.moved`
  (from, to, `moved` with each release's old day, `refused` with reasons, `hidden` as a number),
  `.deleted` (name, release ids), `.member_added` and `.member_removed` (release, track, and a
  reason: `removed`, `release_merged`, `release_deleted`). A new subject kind in the catalogue.
- **Each moved release also emits its own `release.updated`** with `changes.releaseDate`, so its
  track's audit trail and webhooks hear of it whoever moved it. The contract test asked for exactly
  one event in all, so a scenario may now name the events it also emits on purpose (`also`), and
  must emit them. A merge or delete of a linked release likewise adds one `member_removed` to its
  usual event, in that transaction.
- Webhooks do not get `cross_track_release.*` at first, as they do not get `plan.*`. It stays out
  of the full export (IMP-014), as plans, dashboards and saved searches do; a backup holds it.
- A person's data download lists those they own. Erasure keeps them, and the owner's id reads as
  the placeholder, as for plans; nothing else in them is personal.

#### The pages, on a desktop and on a phone

- **`#/cross-track-releases`** lists **Upcoming** and **Shipped**: name, end ("12 Nov 2026" or "When
  its work completes"), state, closed share, linked tracks and hidden releases. On a phone each row
  is a card, its link 44px high. **New release across tracks** opens a dialog (a full-height sheet
  on a phone) with name, description, end and a filtered, ticked list from `candidates`.
- **`#/cross-track-releases/:id`** follows the release page: state in the header, facts, the one
  stage bar with numbers linking to searches, warnings, **Linked releases**, then the first 200
  tickets. The linked releases are a table on a desktop and cards on a phone, each with its track,
  a link to its release page, day, "Out of step" in words, state and closed share. Below, in words:
  "2 more releases are hidden from you, with 7 open tickets".
- **Move date** opens a dialog with the change list, one line per release, old and new day and
  outcome in words, then **Move 3 releases**. On a phone the lines stack and the button stays in
  view. The result stays open, focus on its heading, and it announces itself.
- **A plan's Releases tab** is the same rows, with a release across tracks as a group header. On a
  phone a group is a card with its releases as a list. The tab bar scrolls as now.
- Glass per ADR-114: each group is a card and tables and rows inside are wells, as the guard in
  `design.test.ts` checks. Strings in both catalogues; a story for each component and dialog, in
  both skins, with axe, including phone widths.

#### Performance

- PLN-012's bar: one second, median of five, by `expectWithinBudget` in `plans.large.test.ts`, at
  10,000 tickets in every gate and 100,000 with `TASKMOOR_LARGE_PLANS=1`, with a release in each of
  the 20 tracks, half the tickets as targets, all linked as one:
  - **its page:** one read of members, one of the hidden count, up to six through the search runner
    and one of tickets, as the hub's six or seven. `ticket_release_release_idx` serves it;
  - **the list:** one page of 100, with its counts in one grouped statement, not one each;
  - **a plan's Releases tab:** at most 200 rows through `releaseQuery` and a join;
  - **a move of 100 linked releases**, with its 101 events.
- The plan's Timeline and Calendar are read again against their budgets with the new join, which
  uses a primary key and runs over at most `MARKERS` rows.
- Nothing about a release across tracks is cached, and it adds no statement to a view that does not
  show it.
- **Measured at 10,000 tickets**, medians of five reads on Windows, 2026-11-04, with another
  workflow running on the machine: its page 56 ms, the list 18 ms, a plan's Releases tab 106 ms, the
  Timeline with its markers 291 ms, the Calendar with its markers 33 ms, a move of 100 linked
  releases with its 101 events 64 ms. The 100,000 bar (`TASKMOOR_LARGE_PLANS=1`) has not been run.

#### What the manual says

`docs/manual/use/multi-track.md` gains **Releases across tracks**: what one is, who sees it, what
is only counted, the two ends, moving the date and who it leaves out of step, and that nothing
ships by itself. `boards.md` (Releases) gains the fact row, the warning and Align. `search.md`
gains the field. "Not yet in Multi-track" loses the line. `sources` stay current.

#### Tests

PLN-007 as it should read when built: *Taskmoor shall show the releases of a plan's tracks and keep
releases across tracks as objects of their own, that line up the releases of several tracks on one
date or end when their work completes; a viewer sees only what they may see of the tracks linked,
and the rest only as a count.* Acceptance: (1) one is seen outside any plan, in queries and on
release pages. (2) Moving its date, after confirming the list of changes, moves each linked release
the mover may change, and says why of each it does not. (3) Its state is judged on all its work and
nothing ships by itself. (4) A viewer never sees or is told the name, date or status of a linked
release of a track they may not see; only how many, and its open tickets as one number.

- `routes/cross-track-releases.test.ts`, `[PLN-007]`: making one, and each refusal in linking;
  three viewers (administrator, browses one of three tracks, ticket-level grant only) over every
  route, with sentinel names of the hidden track, release and day that must appear nowhere in any
  answer; 404 bodies equal to a missing id's; (1) a release page and the hub name it; (2) the
  list changes nothing, then each outcome and reason, a stale `version`, `release.updated` per
  move; (3) the state table, with a hidden open ticket keeping `ready` off; a merge, a delete, the
  trash and back. `[PLN-007] [CORE-016]`: **Align**, and a move leaves shipping's rules alone.
- `[PLN-007] [QRY-008]`: every number equals its search for each viewer, and visible plus hidden
  equals all. `[PLN-007] [QRY-002]`: the field's operators, a hidden id and an absent one refused
  alike, a found-in release left out; conformance and compile golden cases.
- `routes/plans.test.ts`, `[PLN-007] [PLN-001]`: the Releases tab and markers, grant-only tracks
  adding no row. `plans.large.test.ts`: the budgets above. `scopes.test.ts`, `[IAM-007]`: every
  route's class. `contract.test.ts`, `[AUT-010]`: a scenario per mutating route. `privacy.test.ts`,
  `[PLN-007]`: download and erasure. An upgrade fixture for the migration.
- Web: `CrossTrackRelease.test.tsx`, `PlanReleases.test.tsx`, additions to `ReleasePage.test.tsx`
  and `setViewportWidth()` for cards; stories with axe. e2e `cross-track-releases.spec.ts`, desktop
  and phone: two tracks' administrators, make, link, move, one refused and out of step, Align.

#### Asked by the spec or the first plan, not built here

- Draft changes around a move (PLN-002, T-089e): the confirmed list stands in until then.
- Release dates as a scheduling input (PLN-004, T-089f), which reads `release_date` as it stands.
- Section 1's warning "ticket outside its release dates", and its exclusion rule that hides chosen
  releases. PLN-001 (3) still asks for each warning, and no stage has them yet.
- Shipping all together, combined notes, a combined burndown, approvals gathered in one place, a
  forecast date for `work_complete`, a start date, notifications, a results column, webhooks, the
  full export and importing them (IMP-016).

#### As built

- **Open means the stage, not `closed_at`:** every count reads `stage` from the ticket's status, as a
  search does, so a number equals its search whatever a status has done since.
- **An archived track counts as archived:** a release of an archived track stops counting towards
  the state, or one archived track would keep it from ever being shipped. `hidden.open` still counts
  every linked release outside the trash, archived ones too, because the search finds their tickets
  and visible plus hidden must equal all.
- **Who sees is one piece of code** (`search/cross-track.ts`): the routes and the query field's
  binding read the same sight, and a query run with no sight of it (an import's check) names none.
  A board's queries read with no viewer see every one, as they do every track.
- **A merge or a delete locks the release across tracks first,** before its release, the order a
  move takes, so they cannot deadlock with one. A purge of a track removes the row by the foreign
  key and does not move `version`; a move then simply has one release fewer.
- **The pages also edit and link:** **Edit** (name, description, ending when its work completes) and
  **Delete** for its owner and administrators, **Link a release** on its page, and **Add to a release
  across tracks…** and **Remove** on a release's page, since the routes exist and nothing else
  reaches them.
- **Dates read through the person's locale** ("Dec 1, 2026" in English), not always "1 Dec 2026".
- **An upgrade fixture corrected:** 0105's counted every close reason, which only showed once a
  migration came after it.

The first independent review (2026-11-05) changed these:

- **A ticket seen through a grant is never tied to it.** The field binds only to linked releases of
  tracks the person sees, and the page's seen counts add up only those releases. Otherwise someone
  who sees one linked track and holds a grant on a ticket of a hidden one finds that ticket under
  `=`, `!=`, `IN` and `NOT IN`, on the page's list and in its counts, which ties a hidden release to
  this one: the reason there is no `IS EMPTY`. Everyone who sees it is told the same numbers.
- **An id cannot be taken over by a name.** The page reads `crossTrackRelease = <id>`, and names are
  neither unique nor kept from being numbers, so a name read first let any track's administrator
  replace the stage bar, the warnings and the tickets on another's page. A bare number is now an id
  before a name, and a quoted one a name before an id. A saved query with a bare number that is both
  now means the id.
- **The same day brings back what is out of step.** The design said the same day changes nothing, but
  linking moves no date, so one made on a fixed day could start out of step with no way to bring its
  releases to that day from the dialog except by moving away and back. Now only a move with nothing
  to bring back changes nothing. **The list and the move agree:** the list said "moves" for a line the
  move would not touch.
- **A release of an archived track reads as archived on its own row**, not only in the state, and
  never overdue, so a row and the header cannot disagree.
- **What may be linked can be narrowed by a word on the server** (`candidates?q=`, track key, track
  name or release name, with `%` and `_` as plain text). The list stops at 500 ordered by track key,
  so a filter of what was loaded could never reach the rest. The dialogs ask the server only when the
  list said it stopped short, and keep what was already ticked.
- **Controls follow what they would do:** `viewer.mayLink` says whether someone has a track to link
  from, and **Move date** goes once all have shipped.
- **No answer is said in words.** The client's changes never reject: a dropped connection answers
  `unreachable`, and the page says the change may not have happened.
- **The formula guard also covers full-width marks and quotes a semicolon**, where a semicolon is the
  list separator, as in Spanish settings. Both exports and the importer's reading use the shared rule.
  Neither was tried in a spreadsheet.
- **File names keep letters of any language.**

#### Questions for the user (the design takes the first answer each time)

1. **A move and releases the mover may not change:** they stay and read as out of step; or nothing
   moves unless all can; or the owner's move overrides the tracks' administrators.
2. **Who joins tracks with different administrators:** only someone who administers both, or a site
   administrator; or the owner may invite another track's administrators, which needs sharing.
3. **Who sees one:** those who see a linked track; or everyone signed in, who would all read its
   name.
4. **Hidden work:** counted as one number (`hidden.open`); or left out. This is T-089j's question
   about "elsewhere" again, and the answer should be the same for both.
5. **"When its work completes":** says `ready` and ships nothing; or ships once approvals allow.
6. **Limits:** one release per track and one release across tracks per release; or looser.
7. **"After commit":** a confirmed list now, held as a draft once T-089e exists; or wait for T-089e.
8. **Its word and place:** "release across tracks", no sidebar entry; or another word, or an entry
   under "Plan and track".

### Stage 8 (T-089g): duplicate a plan, a link to a view, CSV and image

**Designed and built on 2026-11-04, not merged.** The spec had no requirement for this: the ticket and
the user's scope name it. **PLN-014**, M1 (in the spec now; the number is still the coordinator's to
change, and T-089j may want one too): *Taskmoor shall let anyone who sees a plan copy it, link to a
view as it stands, and download what a view shows as CSV, and the Timeline as an image; none of them
gives access, and hidden work stays only counted.* Acceptance: (1) a copy holds only the sources its
maker may see, says how many it left out, and is private to them. (2) A link opens the same view,
filters, grouping and position, for anyone who may see the plan, and for nobody else. (3) A view's
CSV equals what it shows; the List's holds every ticket of the plan the person may see. (4) No file
holds a ticket the person may not see, or names hidden work. (5) The image says how many rows it
holds of how many.

**No migration, no new permission.** One new event and two new routes; the rest is on the page.

#### Duplicating a plan

- `POST /api/v1/plans/:id/duplicate` with `{ name }`, scope write, internal:
  `201 { plan, left: { hiddenSources } }`. **Anyone who sees the plan may,** since anyone signed in
  may make one; a plan they do not see answers 404. The page offers "Copy of Spring" in the person's
  language, which they can change.
- **Copied:** name as given, description, the sources they may see, in order (saved searches by
  reference, so the copy changes with them; broken and archived ones too, flagged as ever), the
  capacity unit, the periods and the teams. The new plan is theirs, at version 1, with no tie to the
  original.
- **Not copied:**
  - **Sources hidden from them:** only counted, in the answer and on the page ("2 sources you may
    not see were left out"), never which. An owner who could not see them could neither use nor
    remove them.
  - **Shares:** private to its new owner, since a copy should not reach an audience by itself;
    sharing still needs its permission.
  - **Capacity:** `plan_capacity` holds people's amounts and notes that may say why someone was
    away, so a copy would spread them to a second plan under a new owner, and a new audit trail. It
    can come as `include: ['capacity']` if the user wants.
  - **Later stages' contents** (program boards, drafts and scenarios) unless their stages say so.
- One transaction, reading the original's rows under a share lock, writing through the routes'
  own `writeSources` and team writer, checking sources with `sourceErrors`, so a plan copied never
  holds what its maker could not add by hand. Up to 500 sources, 50 teams.
- **Event:** one `plan.duplicated` (name, `from`, sources, teams, `hiddenSources` as a number),
  audited, in the data download by ownership as any plan is. A new type rather than a changed
  `plan.created`, since a changed payload is a new version (ADR-015).

#### A link to a view

- **No server and no token.** The address already holds the filters and grouping (stage 1). This
  adds what is still kept in the page: `zoom` (Timeline), `month` (Calendar), `from` (Capacity) and
  `sort` (List); values that could not be meant are left out, as now. They stay out of `viewKey` so
  moving a month does not read the plan again, and they replace the address entry rather than add
  one, so the back button still undoes filters, not every step. Columns stay per person, in this
  browser, since they are a person's choice.
- **Copy link** in the plan's header, on every tab, copies the address from `appBase()`, with a
  status that says so; where the browser refuses the clipboard (plain http, say), a read-only field
  holds it, selected.
- **It gives no access.** It is only an address: a person who may not see the plan gets the plan's
  not-found page, and one who may sees it as they may see it, so two people can get different
  rows from one link. Signed out, sign-in returns to it (`continuation`). `assignee=me` means
  whoever opens it, and the manual says so. Nothing is stored or logged, so no audit.
- Not a public link: plans are never public (stage 1).

#### CSV

- **The List:** `GET /api/v1/plans/:id/export?format=csv&columns=&sort=` with the views' filters,
  scope read, internal. It composes the plan's query on the server (a plan's text can pass what an
  address holds, so the page cannot use `/search/export?q=`) and hands it to the same stream as the
  search export, moved into one function: same statement, keyset pages, viewer's filter on each
  page, custom columns only as the person may name them, formula guard, RFC 4180, no event, and
  `countBulkExport` (ADR-109). **Every ticket of the plan the person sees**, not the first 10,000:
  QRY-015 asks for no cap on exports, and a cap would guard nothing, as the same query can be
  exported from search. A plan with nothing visible gives the header row alone. Headers are column
  ids, as the search export's.
- **The other views:** built on the page by one pure function per view from the view's own answer,
  so the file is what the view shows (RPT-009 (1) is the same idea), including what only the view
  knows: sprint-derived days, roll-ups and blocker counts on the Timeline. Headers are in the
  person's language, each cell through the one `csvField` the server's exports use too
  (`@taskmoor/webconfig` `csv.ts`). RFC 4180, and a UTF-8 byte-order mark first, as on every CSV
  export (see the byte-order mark below).
  - **Timeline:** key, summary, type, track, status, start, due, where the days come from, roll-up,
    late, and `blockersElsewhere` as its two numbers. First 10,000, with a line beneath the button
    saying so when `truncated`.
  - **Calendar:** the month's entries. **Summary:** each measure, its number and its search.
    **Capacity:** one row per team or person and period, with work, capacity, over or not, and
    elsewhere as its count and amount, never named, headed as counted by whole weeks.
    **Releases:** the tab's rows, with `hidden` as its numbers.
  - **Timeline and Calendar read again with `export=true`:** it counts the export for the alert and
    gives a fresh file; the answer is otherwise the same, so the filter and hiding are the same
    code. Summary, Capacity and Releases hold counts, not tickets, and are not bulk exports.
- A file's name comes from the plan's name, reduced to safe characters, as release notes do, with
  the view and day; only the person's own download carries it.

#### The image

- **The Timeline only, as PNG.** Other views are tables or numbers, and CSV serves them.
- **Drawn, not captured:** past 200 rows the page holds only those in view, so a capture would miss
  rows and bring in glass and backgrounds. One pure function makes an SVG text from the same rows,
  `dependencyState` and markers as the page, then an `Image` from a blob URL and a canvas make the
  PNG. The content security policy already allows `blob:` images. No `foreignObject`, external font
  or link, so the canvas is never tainted and no new dependency comes in. Every text is escaped, so
  a summary of `</text><script>` reads as written, and `<img>` runs no script anyway.
- **What it holds:** the plan's name, the filters and grouping in words, the day it was made, month
  headers, today's line, group names, bars, lines (dashed and with "late" in words, never colour
  alone), badges, release markers, hidden sources and outside blockers as the page words them. Fixed
  light colours, chosen for print; the skin does not change the picture.
- **Its size:** at most **400 rows** (a constant), 1,600px wide, the whole span fitted to it, 2x
  when the area stays under 16 million pixels, which phones' canvases can draw. More rows and the
  image and the button's line both say "First 400 of 1,240 rows: filter the plan for the rest". If the
  browser still cannot draw it, a status says so in words and no file comes.
- **It holds nothing the Timeline does not:** the rows come from
  `GET /plans/:id/timeline?export=true`, as the CSV's do, so it counts for the alert. Nothing leaves the browser.

#### On a phone

- **Copy link** and **Duplicate plan** are in the header's actions, which wrap, 44px under a coarse
  pointer. **Duplicate plan** opens the same dialog, as a sheet.
- **Download** in each view's tools opens a short menu with **CSV** and, on the Timeline, **Image**,
  each 44px. Files arrive by the browser's download. No share sheet at first.
- Status messages are announced, and a slow image shows its progress in words.
- Glass per ADR-114 for the dialog and menu; strings in both catalogues.

#### Performance

The stream's cost and memory are the search export's (`search-export.large.test.ts` covers it at
size); `plans.large.test.ts` adds the route's first byte under a second at 100,000 tickets. Budgets
by `expectWithinBudget`: a duplicate of 500 sources and 50 teams under a second; on the page, a
10,000-row CSV under one second and a 400-row image under three (e2e, Chromium). Links cost nothing.
See **As built** for what has been run; the budgets on the page are still only targets.

#### What the manual says

`docs/manual/use/multi-track.md` gains **Copying a plan** (what comes and what does not), **Linking
to a view** (what it holds, that it gives no access, that `me` means whoever opens it) and
**Downloading a view** (what each file holds, the List's being every ticket, the 10,000 and 400
limits, and that files leave the system's permissions once saved). "Not yet in Multi-track" loses
the line.

#### Tests

- `routes/plans.test.ts`, `[PLN-014]`: (1) a copy's sources, settings and teams; hidden ones counted
  and named nowhere; shares and capacity not copied; a hidden plan 404; a viewer's copy is theirs
  and changes nothing in the original; `plan.duplicated`. `[PLN-014] [PLN-012]`: (3) the export over
  more than 10,000 tickets with the filters, for three viewers, each row a ticket that viewer's
  search finds; hidden custom columns refused; the formula guard; nothing visible. `[QRY-015]`: the
  alert counts it. `export=true` answers equal the plain ones and count once. `scopes.test.ts`,
  `[IAM-007]`, and `contract.test.ts`, `[AUT-010]`: both routes.
- Web, `planExport.test.ts`, `[PLN-014]`: each view's CSV against its fixture and a golden file, the
  guard's table, hidden work as numbers only; (5) the SVG's rows, cap and words, "late" in text, an
  escaping table. `address.test.ts`, `[PLN-014]`: (2) each new key read, written and refused, and no
  second read of the plan when only they change. `[PLN-005] [PLN-006]`: the Capacity and Timeline
  files say what the view does of hidden work. Stories, with axe, for the dialog and menu, in both
  skins and on a phone.
- e2e `plan-share-and-export.spec.ts`, desktop and phone: duplicate; copy a link, open it in a
  second signed-in person's context and signed out through sign-in; a person without access gets not-found;
  download each file, reading the CSV and checking the PNG's signature and decoded size.

**What these will not show:** a real phone's canvas limit (Chromium's simulated phone only, as for
touch drags), and how the image looks, which needs a person to look at it.

#### Asked in the first plan or nearby, not built here

- Saved views (spec 03 section 1, AGL-020, M2 in the spec): a link is an address, not a named view.
- A public or signed-out link: plans are never public; published views (DSC-006) are another
  feature.
- PDF, Excel, a Timeline image over 400 rows, SVG, an image of other views, scheduled or emailed
  exports (RPT-009, M2). Asynchronous jobs (QRY-015 (1) is about the search export).
- Copying capacity, shares or hidden sources; a copy that follows its original.

#### As built

- **`routeUrl`, not `appBase()`:** Copy link uses the router's own address for copying, which is
  right in both routing modes and on any origin; `appBase()` is empty when the backend serves the page.
- **The position goes through `redirect`, not `replace`:** the router's `replace` sends no change
  event, so the page would keep an old position in its tabs and links. `redirect` rewrites the same
  history entry and tells the page, which draws again from the address; the plan is not read again,
  as `viewKey` leaves the position out. Defaults say nothing in the address, so a plain link stays
  plain.
- **The List's file is `format=csv` only:** no JSON, since nothing asks for it and the search export
  has it. The stream is one function now, `sendTicketExport`, for both routes. A plan with no query
  still counts as a bulk export, as a search with nothing visible always has.
- **A copy decides its sources before its transaction:** permissions read on their own connections,
  so what the person sees is settled first; the transaction then takes the plan under a share lock
  and reads its sources again. A source added meanwhile stays behind and is counted, since nobody
  decided on it. Broken and archived sources the maker sees come along, flagged as ever. The answer
  is `{ plan, left: { hiddenSources } }`.
- **What was left out is said in the dialog:** the copy is a new page, and a notice carried across
  pages would need state, so the dialog stays with the number and **Open the copy**. With nothing
  left out it goes straight there.
- **Capacity's file has no notes and adds a line per row for what is unscheduled:** the view shows
  that column, so the file does. Notes stay on the page, as they may say why someone was away and a
  file travels. Hidden work is the count and amount the design asked for.
- **Row cap counts group headings:** both are rows in the picture, so "400" is what fits a phone's
  canvas whatever the grouping. The tree of rows moved to `timeline/rows.ts`, used by the page and
  the image, so the two cannot disagree on order.
- **The image draws no sprints:** the design lists release markers only. Summaries are cut to about 44
  characters beside their key, with an ellipsis; the file's CSV has them whole.
- **Text XML cannot hold is taken out, not escaped:** control characters and lone surrogates would
  stop the whole picture from loading, so a ticket's odd title cannot cost someone their image.
- **One CSV rule for every export** (T-252): `csvField`, `csvLine`, `csvFile`, `withBom` and
  `bomLength` live in `@taskmoor/webconfig` (`csv.ts`), which the server and the page both import,
  so the search export, the List, the audit log and the views' files cannot drift apart. Its cell
  guard is tested with one table (`csvGuardTable.json` beside it).
- **A UTF-8 byte-order mark on every CSV file** (question 7 below, the user's answer of
  2026-11-13): the three bytes EF BB BF come first, exactly once, so Excel on Windows opened by a
  double-click reads the file as UTF-8 and accented headers such as "Versión" come out whole.
  Streamed exports put it before the header in their first chunk (`withBom` leaves text that
  already has one as it is); the views' files get it from `csvFile`, and `csvBlob` makes sure of it
  again when the page hands the file over, typed `text/csv; charset=utf-8`. The separator stays a
  comma: a Spanish Excel that wants semicolons still needs its import from text, which the mark does
  not change. JSON and JSON Lines get no mark. The CSV importer (`records`) and the people file
  start reading after it, through `bomLength`, so an exported file imports as it is. Tests: each
  export's bytes start EF BB BF once (`search-export.test.ts`, `plans.test.ts`, `audit.test.ts`,
  `PlanShare.test.tsx`), and each reads back through the importer, the search export as a whole
  CSV import (`search-export.test.ts`) and the downloaded files in the e2e specs
  (`search-results`, `audit`, `plan-share-and-export`).
- **The picture's colours are listed in the design guard's ALLOWED list,** with the reason: a file
  must not change with the skin.
- **Tests by name:** the page's flows are in `plans/PlanShare.test.tsx`, and the file functions' in
  `plans/planExport.test.tsx`. Golden files are read from disk there, since the web project's jsdom
  setup has no snapshot state.
- **Measured (one run, on a machine under other work):** the List's file of 10,000 tickets, first byte
  152 ms and all of it 1.4 s; a copy of 20 track sources 110 ms; a copy of 500 saved searches and 50
  teams 813 ms, close to its budget of a second, since the check of sources asks about each. Not
  measured: the 100,000-ticket bar (`TASKMOOR_LARGE_PLANS=1`), a 10,000-row CSV on the page, and a
  400-row image's time.

#### Questions for the user (the design takes the first answer each time)

1. **A copy's capacity:** left out; or amounts without notes; or with notes.
2. **A copy's shares:** left out; or kept when the maker may share.
3. **The List's file:** every ticket; or the first 10,000, as the view lists.
4. **The image:** the Timeline as PNG, 400 rows; or more views, more rows, or SVG too.
5. **A link's `assignee=me`:** whoever opens it; or the person who copied it.
6. **The requirement number:** PLN-014, or the coordinator's choice.
7. **A byte-order mark on the CSV files:** none, like the existing exports; or one, so that Excel on
   Windows reads accented headers such as "Versión" when the file is opened by a double-click. A
   Spanish Excel may still want a semicolon between cells, which a mark does not change. Not tried in
   Excel. **Answered 2026-11-13: a mark on every CSV export, not only a plan's; separators as they
   are. Built in T-252** (above).

### Stage 5 (T-089d): the program board and dependency options

**Designed and built on 2026-11-13, not merged.** PLN-008 and PLN-013 move to M1 with this stage, reworded to what is
built (the wordings are under "Tests"). The user decided on 2026-11-13 (`decisions.csv`, rows on
T-089i and T-241) to build PLN-013 with the program board in 1.0, that blockers outside the plan
stay a count only, that the section is called **Plans** and that the interface says **site**. The
questions at the end are the user's; the design takes the first answer each time.

A **program board** lays a plan's work out by team and iteration: a row per team, a column per
period, and in each cell the outcomes and the work (levels 1 and 0, spec 00) that team has due in
that period, with their dependencies. Several people move cards on one board at the same time and
see each other's moves within a second. It belongs to a plan, as its views do: it gives no access,
holds no tickets, and moving a card is the ticket's own change.

#### What a cell is

- **Rows** are the plan's teams (stage 3), in the plan's order, then one row **Other or no team**
  for work whose Team value is empty or a team the plan does not plan with. A team gives no access
  (ADR-076), and everyone signed in reads teams, so naming them tells nobody anything new.
- **A card's team** is its value in the board's **Team field**: a shared, single-value field of type
  `team` (ADR-076), chosen per board; a new board takes the site's oldest one. A board without one
  (the field was deleted) puts every card in the last row and moves cards between periods only.
- **Columns** are the plan's own periods (stage 3: every 1 to 6 weeks from its anchor, or months):
  `periods` of them (1 to 12, 6 by default) from the period holding the board's `from` day, after a
  first column, **Not scheduled**, for open work with no due day. These are the plan's iterations:
  a plan spans tracks whose sprints differ or do not exist, and capacity already counts by these
  periods, so a cell's work is the same work stage 3 counts against that team (question 1).
- **A card's period** is the one holding its own due day, as capacity counts it: a ticket counts
  whole in the period of its due day. A day taken from a sprint (the Timeline's `dated: sprint`) is
  not used, so the board and Capacity never disagree (question 2).
- **Which tickets:** the plan's tickets as the viewer sees them, with the views' filters
  (`planTickets`), at levels 1 and 0 (`hierarchyLevel IN (0, 1)`), due in the board's periods or
  open with no due day. Closed work due in a period stays in its cell, marked closed in words.
- **Every count equals a search.** Each row has a `clause` (`cf[12] = 3`, and for the last row
  `cf[12] IS EMPTY OR cf[12] NOT IN (3, 4)`), each column a `clause` (stage 3's `due >= ... AND
  due <= ...`, or `stage != closed AND due IS EMPTY`), and the board a `clause`
  (`hierarchyLevel IN (0, 1)`). The plan's `query` ANDed with the three is the cell's link, and a
  test checks each count against its search for three viewers.
- **A cell shows its first 20 cards**, outcomes first, then by rank, and says "and 14 more" as a
  link to its search. With at most 51 rows and 13 columns no read can grow past that, so the board
  needs no cap of its own beside PLN-012's.

#### Hidden work

- A board lists only tickets the viewer may see, through the plan's query, so a hidden ticket is
  never a card, never counted in a cell and never named. Cells carry **no count of hidden work**:
  the periods are the plan's, which its owner sets a day at a time, so a count per team and period
  would give away due days, which stage 3 had to close with whole weeks. Capacity remains the place
  where a person's hidden load is counted, by those weeks.
- A card's blockers that the board does not show are counted per card as stage 2 counts them on the
  Timeline (`blockersElsewhere: { id, outside, unlisted }`): `outside` the plan or hidden from the
  viewer as one number, never a key, summary, track, team, sprint or day; `unlisted` the plan's own
  tickets for this viewer that the board leaves out (other periods, other levels, the filters, past a
  cell's 20). Outside blockers stay a count only (the user's answer on T-089i).
- A plan, or a board of a plan, the person may not see answers 404, word for word as an id that
  does not exist; so does a board id under another plan's id.

#### Dependency options (PLN-013)

- **Stored on the plan** (migration 0108): `plan_dependency_type` (`plan_id`, `link_type_id`, both
  cascading on delete; at most 20 a plan) and `plan.flag_same_sprint` (false by default).
- **Other link types as dependencies:** a chosen type counts beside blocking links, everywhere a
  plan shows dependencies: the Timeline's lines, badges and list (stage 2), its file and image (stage
  8), and the program board. A link's **source must finish first** and its target waits for it, as a
  blocking link reads ("A blocks B"): the settings show each type as "A *precedes* B: B waits for A"
  (question 9). A type whose outward phrase is "blocks" is always counted and cannot be chosen
  (`always_counted`). Two links between the same pair are one dependency, a blocking one first. A
  plan that chooses none shows only blocking links, as before; the track's own timeline is unchanged.
- **Late** is PLN-006's rule (`dependencyState`), whatever the type.
- **Same sprint:** with the flag on, a dependency whose two tickets are both in the same sprint now
  (in it, `sprint_ticket.open`, and the sprint neither closed nor deleted) is marked **Same sprint**
  in words beside its colour: on the line's description, the badge ("Blocked by 3 tickets, 1 late, 1
  in the same sprint"), the list and the board. Only dependencies between tickets the viewer sees are
  judged, and the sprint is never named, so the flag says nothing about hidden work. Without the
  flag nothing is marked and nothing is read.
- **Answers:** the Timeline's and the board's `links` items gain `linkTypeId` and, when flagged,
  `sameSprint: true`; both answers gain `linkTypes` (id, name and outward phrase of each type used)
  and `sameSprint` (whether the plan asks). `GET /plans/:id` gains `dependencies: { linkTypes,
  sameSprint }`, and `PATCH /plans/:id` takes `dependencies: { linkTypeIds, sameSprint }` from the
  plan's editors, in `plan.updated` as `dependencyTypes` and `sameSprint`. A copy of a plan (stage 8)
  copies them, as it copies its other settings.
- One function reads dependencies for both the Timeline and the board
  (`apps/server/src/plans/dependencies.ts`), and one decides their state on the page
  (`dependenciesOf`), so the two cannot disagree.

#### What is stored (migration 0108)

- `program_board`: `workspace_id`, `plan_id` (cascading), `name` (1 to 255), `team_field_id` (a
  field, set to null when it is deleted), `from_day` (any day; the first period is the one holding
  it), `periods` (1 to 12), `archived_at`, `version`, `created_at`, `updated_at`; an index on
  `(plan_id, id)` and one on `team_field_id`.
- `plan_dependency_type` and `plan.flag_same_sprint` above.
- Nothing about cards is stored: a card is a ticket, and where it stands is its Team value and due
  day. The schema golden file, the types in `schema.ts` and an `upgrade-fixtures.ts` entry come with
  the migration.
- **No limit per plan**, as PLN-008 says: a plan lists all its boards, active first. Boards are small
  rows and each reads only when opened.

#### Routes and token scopes

All are internal in the API document, as the other plan routes, and scopes follow the method.

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/plans/:id/program-boards` | read | The plan's boards, active then archived: `{ boards, editable, teamFields }` |
| `POST /api/v1/plans/:id/program-boards` | write | `{ name, teamFieldId?, from?, periods? }`; the plan's editors |
| `GET /api/v1/plans/:id/program-boards/:boardId` | read | The board with the views' filters: `{ board, plan, query, clause, editable, periods, unscheduledClause, rows, cards, links, linkTypes, sameSprint, blockersElsewhere }` |
| `PATCH /api/v1/plans/:id/program-boards/:boardId` | write | `{ name?, teamFieldId?, from?, periods?, archived?, version }`; a stale version answers 409 |
| `DELETE /api/v1/plans/:id/program-boards/:boardId` | write | Removes the board; no ticket changes |

Creating, changing, archiving and deleting a board is for the plan's owner and site administrators
(`forbidden` with `edit_plan`), as the plan's other settings. **Moving a card has no route of its
own:** it is `PATCH /tickets/:key`, so the mover's own permissions decide ("Schedule tickets" for the
day, "Edit tickets" or the field's own rule for the Team value), with the ticket's history, events,
locks (WF-007) and webhooks, ticket by ticket across tracks, as stage 1's rescheduling does.

#### Moving a card

- **To another row:** the Team value becomes that team; to **Other or no team** it is cleared.
- **To another period:** the start and due days move by the distance between the two periods' first
  days, the due day kept inside the new period (a 31 January due day moved a month lands on 28 or
  29 February), and a start after the new due day becomes that day. From **Not scheduled** the due
  day becomes the period's last day and a start after it moves to the period's first. To **Not
  scheduled** the due day is cleared and the start stays (question 3).
- One request carries both, with the `version` the board read: the card moves at once on the page,
  marked "Moving" in words, and the board reads again when the answer comes.
- **Conflicts:** a ticket changed meanwhile (someone else moved or edited it) answers 409
  `version_conflict`; nothing is changed, the board reads again, and the page says "SPA-12 changed
  while you moved it; it now shows where it is. Move it again if you still want to." So two people
  moving the same card never overwrite each other unseen; the first move stands (question 6). Two
  people moving different cards both succeed.
- A refusal says why in plain words from the ticket route's codes, as the Timeline does: no
  permission (naming it), a lock, an archived track, a field the ticket's track does not use, a
  ticket gone or hidden.
- **Closed cards do not move** on the board: closed work is done, and a closed card moved to Not
  scheduled would vanish from it.
- **On a desktop** a card is dragged to a cell (the browser's drag and drop) and every card has
  **Move…**, which opens a dialog with the team and the period: the way for the keyboard, screen
  readers and touch. Archived boards show their cards and move nothing.

#### Live edits

- **No new transport.** The app already keeps a local copy (ADR-013): every change to a ticket writes
  a row to the change log, the realtime socket tells each signed-in client within 250 ms that the log
  moved, and the client reads the rows it may see. A board subscribes to that copy, as a track's
  board does (NTF-008): when it moves, the board reads its cards again, at most once per 100 ms, not
  while a card is being dragged or a move is waiting for its answer. A move made here shows at once
  without waiting for the socket. Without a local copy (storage refused, private browsing) the board
  reads again every 15 seconds while it is open.
- **What travels:** only that the log moved. The board then reads its own answer as the viewer, so a
  move by someone else reaches each viewer only as far as they may see it: a ticket that becomes
  hidden simply leaves their board.
- **Budget:** two people on one board, one moves a card, the other sees it in its new cell within
  1 s (PLN-008 (1)): e2e, measured from the drop to the card in the second browser's cell, by
  `expectWithinBudget`.
- A board's own settings (name, periods, field) changed by an editor reach others on their next
  read, which any ticket change or reload brings; the change log carries tickets, not plans.

#### The pages, on a desktop and on a phone

- **A plan's Program boards tab** (`#/plans/12/boards`), after Releases: the boards, active first,
  each with its name, periods and Team field, and for its editors **New program board** (a dialog,
  a sheet on a phone: name, Team field, first period, number of periods), **Edit**, **Archive** or
  **Restore**, and **Delete** through the shared DangerAction (D13).
- **One board** (`#/plans/12/boards/5`), with the plan's filter bar: a table, teams as row headers
  and periods as column headers ("Now" in words on the current one), each cell a list of cards with
  its count; the team column stays in place while the table scrolls sideways, with a fade showing it
  goes on. A card shows its key, summary, type, status in words, "Closed" when closed, and its
  dependency badge ("Waits for 2, 1 late", "Same sprint"). Below the table, **Dependencies**: each
  card with blockers, its blockers on the board with their team, period and state in words, and the
  others counted.
- **On a phone** (`COMPACT_QUERY`) the table becomes one team at a time, chosen with a **Team**
  picker, and each period a section with its cards as a list; **Move…** is the only way to move,
  44 px under a coarse pointer, and its dialog is a sheet. No sideways scrolling.
- **Settings** gains **Dependencies**: the site's link types other than blocking ones, ticked, each
  read as "A *phrase* B: B waits for A", and **Flag dependencies within one sprint**.
- Glass per ADR-114; status messages announced; strings in both catalogues; a story for each
  component and dialog, with axe, at phone width too.

#### Events, audit and records

- `plan.program_board_created` (board id, name, team field, from, periods),
  `plan.program_board_updated` (board id, changes) and `plan.program_board_deleted` (board id,
  name), subject the plan, audited as `plan.*` are: configuration others see. `plan.updated` carries
  `dependencyTypes` and `sameSprint`. Webhooks get none of them, as for `plan.*`.
- A board holds nothing personal (no owner, no names), so the data download and erasure do not
  change. A copy of a plan leaves its boards out (stage 8, "later stages' contents"; question 12).

#### Performance

- PLN-012's bar, by `expectWithinBudget` in `plans.large.test.ts`: a board of six periods and the
  plan's team, read under a second, median of five, at 10,000 tickets in every gate and 100,000
  with `TASKMOOR_LARGE_PLANS=1`. The cells come from one statement over the plan's tickets in the
  board's window, each with its place, `row_number()` and `count()` per cell, so what reaches the
  server is at most 20 cards a cell; the cards' details, the dependencies and the same-sprint check
  each read only those cards.
- The Timeline with chosen link types and the flag, against its budget as before.
- The live move within 1 s (above), in the e2e on Chromium.

#### What the manual says

`docs/manual/use/multi-track.md` gains **Program boards** (rows, columns, which tickets, moving a
card and what it changes, who may, the live updates, conflicts, the phone) and **Dependency
options** (other link types and their direction, the same-sprint flag); "Not yet in Multi-track"
loses the program board. `sources` stay current.

#### Tests

PLN-008 as it should read when built: *Taskmoor shall provide program boards in a plan, showing its
level-1 and level-0 tickets by team (a Team field) and by the plan's periods, with their
dependencies, which several people edit at once, each seeing the others' moves as they happen; a plan
holds any number of them, and a viewer sees only what they may see.* Acceptance: (1) two people
moving cards see each other's moves within 1 s; (2) a plan holds 3 or more active program boards;
(3) moving a card changes the ticket's Team value and due day through the ticket's own rules, and a
stale move is refused, never applied over another's; (4) a hidden ticket is never a card, counted in
a cell or named, and its dependencies are only counted.

PLN-013 as it should read when built: *Taskmoor shall let a plan treat link types it chooses as
dependencies, beside blocking links, the source finishing first, drawn, counted and judged late as
PLN-006 says, on the Timeline and the program board; and, when asked, mark each dependency whose two
tickets are in the same sprint now.* Acceptance (1) and (2) as now.

- `routes/program-boards.test.ts`, `[PLN-008]`: making, changing, archiving and deleting boards,
  editors only; (2) three active boards and an archived one; 404 bodies for a hidden plan and for a
  board of another plan equal to a missing id's; rows, columns and cells for a fixture of two teams,
  other and no team, four periods and unscheduled work, levels 2 and -1 left out; (4) three viewers
  (site administrator, browses one of two tracks, ticket-level grant only) with sentinel summaries of
  hidden tickets that appear in no answer; `[PLN-008] [QRY-008]` every cell's count equals its
  search's for each viewer; (3) a move through `PATCH /tickets/:key` with a stale `version` answers
  409 and changes nothing; a deleted Team field; a stale board `version`; the events.
- `routes/plan-dependencies.test.ts`, `[PLN-013]`: (1) a chosen type drawn and counted, and none when
  not chosen; `always_counted`; the direction; hidden and outside blockers still only counted; (2)
  `sameSprint` with the flag and never without it; a closed sprint marks nothing.
- `plans.large.test.ts`: the board's budget. `scopes.test.ts`, `[IAM-007]`: each route's class.
  `contract.test.ts`, `[AUT-010]`: a scenario per mutating route. An upgrade fixture for 0108.
- Web: `ProgramBoardPage.test.tsx` (the table, the Move dialog's request, the conflict and refusal
  words, reading again when the local copy moves, the phone's team picker with
  `setViewportWidth()`), `ProgramBoardsPage.test.tsx`, `PlanDependencies.test.tsx` and
  `DependencyList.test.tsx` additions (type names, "Same sprint" in words), the settings section;
  stories with axe.
- e2e `program-board.spec.ts`: on a desktop, two people signed in in two browsers on one board, one
  drags a card to another team and period, the other sees it there within 1 s; then both move the
  same card and the second is told it changed; on a phone, a move through the Move dialog.

#### Asked by the spec or nearby, not built here

- Lines drawn between cards on the board (the badges and the list carry the same; question 7).
- Presence: who else has the board open, their cursors or a card someone is holding (question 5).
- Columns from each team's own sprints, and per-team iterations (question 1).
- Objectives, risks and milestones on the board; level-2 tickets; capacity in each cell.
- Copying boards with a plan, a board's file or image, webhooks for boards.

#### As built

- **The board reads again 30 ms after the local copy moves**, not 100 ms as a track's board does: the
  socket's poll (250 ms), the change read and the board's own read already take most of the second,
  and a burst of changes still comes as one read.
- **The live-edit e2e measures with `waitFor`**, not an assertion's polling steps, so the number is
  the page's: three single runs on Windows, 2026-11-13, with other work on the machine: 861 ms and
  840 ms (with a settle of 100 ms) and 354 ms (30 ms). One sample each; the margin under load is
  not known.
- **A move made from the Move dialog carries the version read when the dialog opened, and moves
  the card from where it stood then**, so a card moved by someone else while it was open is
  refused, which is how the e2e proves the conflict; the move is sent even when the card has left
  the board meanwhile, and the ticket route says what happened. A made move takes the version and
  days its answer gives, so moving the same card again before the board reads sends them.
- **Review fixes (2026-11-13):**
  - `PATCH .../program-boards/:boardId` requires `version`, as the route table says: one without it
    answers 400 `invalid_fields` and changes nothing, so a change made meanwhile is never
    overwritten unseen.
  - A read skipped while a card is held or a move waits is remembered and made once neither holds
    the board, so a drag let go without a move still shows others' moves. A read already on its way
    when a card moves is dropped, so its answer cannot put the card back; the board reads once
    after the last waiting move answers.
  - After a move from the dialog, focus goes to the card's link where it now stands, or the board's
    name when it left the view; after a refusal, to the card where the next read puts it. Cancel
    gives it back to the Move button. A dialog's first field may be a select (`ModalDialog`).
  - A board keeps its id when its filters change, and the filters travel from the list to a board
    and back. Deleting a board keeps the question open when refused and puts focus on the list's
    heading when done.
  - A link type the plan counts that an administrator has since made a blocking one is neither
    offered nor sent by the settings page, so the plan's settings still save.
  - Tests now cover the board with a chosen link type and the same-sprint flag (server and page),
    the Timeline's same-sprint words, colour and type phrase on the page, a closed status that is
    not named "Closed", three active boards on the list page, and the e2e's stale move checked
    against the server's board read afresh.
- **A badge says "Blocked by 2 tickets, 1 late"**, the Timeline's words, rather than a new
  "Waits for"; the list below the board is the Timeline's `DependencyList`, fed with the cards.
- **The routes refuse to delete a Team field in use** (`in_use`), so a board loses its field only
  when the field held no values, or was removed outside the routes; the test removes it in the
  database to check the board then shows one row.
- **Dependency options are read from `GET /link-types`** on the settings page, blocking types left
  out; a type the plan already counts still shows ticked if the list lacks it, unless it now reads
  "blocks".
- **A copy of a plan copies its dependency options**, as the design says; a test checks it.
- **Cells carry `data-cell="<team>:<column>"`**, for the e2e's drops; the cell's name says the team,
  the period and its count.
- **Measured** (`plans.large.test.ts`, medians of five, Windows, 2026-11-13): a board of six two-week
  periods over 10,000 tickets, half of them in the plan's team, 47 and 48 ms over two runs; its first
  cell equals its search. Not run: the 100,000 bar (`TASKMOOR_LARGE_PLANS=1`).
- **Tested viewers:** a site administrator, a member of one of the plan's two tracks, and someone
  who sees the plan and none of its tracks. A viewer with only a ticket-level grant is not in this
  stage's tests; the board reads the plan's tickets through `planTickets`, whose stage 1 tests cover
  that viewer.

#### Questions for the user (the design takes the first answer each time)

1. **Columns:** the plan's periods, the same for every team; or each team's own sprints (the sprints
   of boards that team owns), which differ by team.
2. **A card's period:** its own due day, as Capacity counts; or its sprint's days when it has no due
   day of its own, as the Timeline draws.
3. **Moving to another period:** the days shift by the periods' distance, kept in the new period;
   or the due day becomes the period's last day.
4. **Rows:** the plan's teams and one "Other or no team"; or only the plan's teams.
5. **Live edits:** the board reads again when the change log moves, with no presence; or presence
   too (who is looking, which card someone holds), which needs a channel of its own.
6. **Two people moving one card:** the second is refused and shown where it is now; or the last
   move wins.
7. **Dependencies on the board:** badges and a list; or lines between cards too.
8. **Hidden work in a cell:** not counted at all; or counted per board as one number.
9. **A chosen link type's direction:** the source finishes first ("A precedes B"); or chosen per
   type.
10. **Same sprint:** both tickets in the same sprint now, neither closed nor deleted; or also sprints
    already completed.
11. **How many boards a plan holds:** no limit, as PLN-008 says; or a limit (say 100).
12. **A copy of a plan:** leaves its boards out; or copies them.

### Stage 6 (T-089e): draft changes and scenarios

**Designed on 2026-11-14; the server and the web app built the same day (see the two "As built"
parts).**
PLN-002 and PLN-003 move to M1 with this stage, reworded to
what will be built (the wordings are under "Tests"). Two designs were made and judged against the
spec, privacy, the earlier stages and the code; this one is the server-first design with the
person-first one's safer pieces grafted in (a lock per scenario while applying, deleting only a
draft still holding the value applied, no editing in place in a scenario, counts that drafts touch
shown without a link, a two-sided comparison and no "baseline" in the interface). The questions at
the end are the user's; the design takes the first answer each time.

A **scenario** is a named set of **draft changes** to a plan's tickets. A draft changes nothing about
a ticket until it is **applied**, which is the ticket's own change (`PATCH /tickets/:key`) with the
applier's permissions, ticket by ticket, as rescheduling is today (stage 1). One scenario of a plan
is its **main** scenario, the only one applied from; the others are ideas to try and compare, and
any of them can be made main. A scenario belongs to its plan, as its views do: it gives no access
and holds no tickets, and a viewer sees a draft only on a ticket the plan shows them.

**On the words:** the interface says **scenario**, **main**, **draft change**, **Apply** and
**Discard**; the spec and the code say commit. It never says "baseline": PLN-011 uses that word for
saved snapshots of dates, another feature, so what PLN-003 first called "the baseline" is the main
scenario (question 16).

#### What a draft is

- **One field of one ticket in one scenario:** its start day, its due day, or its value in a Team
  field (a shared, single-value field of type `team`, as program boards use). These are what the
  Timeline, the Calendar and the program board already change; the assignee, estimates, sprint and
  the rest are left out of 1.0 (question 5).
- Each draft keeps the field's **value when drafted** (the live value the first time the field was
  drafted in that scenario), its **new value** (null clears the field), who changed it last and
  when, its `origin` (`person`, or `scheduler` for T-089f) and its last refusal.
- **A change**, the unit of the change list, of choosing and of applying, is **one ticket**: all its
  drafts in the scenario, applied together in one `PATCH`, so a start and a due day never land apart
  (the ticket route does not check that one comes before the other). "Apply 3 of 10" means 3 tickets
  (question 6).
- **Drafting never touches the ticket:** no history, no `ticket.updated`, no row in the change log,
  no follow, no webhook.
- **Setting a field back to its live value removes that draft**; moving a bar back where it was
  undoes it. Two editors drafting the same field: the last write wins (question 15).
- **Changed since drafted:** a field whose live value no longer equals its value when drafted. The
  change list shows the value now, the draft and the value when drafted. **Keep my draft** writes
  the same value again, saying so (`keep`), and takes the live value as the new value when drafted,
  so the person acts having seen it marked. The same value sent again without it (a bar's start
  sent with its moved end) leaves the draft as it was, still marked. A draft whose new value is already live reads as **already
  so** and goes on the next apply.
- **The ticket's `version` alone never makes a draft stale.** A comment or a new summary leaves every
  drafted field as drafted, and applying then uses the live `version`, so unrelated edits never block
  a plan (question 4).

#### What is stored (migration 0110)

- **`plan_scenario`**: `id`, `workspace_id`, `plan_id` (deleted with the plan), `name` (1 to 100),
  `main` (boolean, false by default), `created_by`, `applying_since` (a timestamp or null),
  `version`, `created_at`, `updated_at`; a partial unique index on `(plan_id) WHERE main`, so a plan
  has at most one main scenario, and an index on `(plan_id, id)`.
- **`plan_draft`**: `workspace_id`, `plan_id`, `scenario_id` (deleted with the scenario), `ticket_id`
  (deleted when the ticket is purged), `field` (`startDate`, `dueDate` or `cf:<id>`),
  `team_field_id` (set exactly when `field` is `cf:<id>`, by a check, and deleted with the field),
  `old_value` and `new_value` (JSON scalars: a day as text, a team's id, or null), `origin`
  (`person` or `scheduler`, checked, `person` by default), `updated_by`, `updated_at`, `refusal`
  (JSON or null) and `refused_at`. Primary key `(scenario_id, ticket_id, field)`; indexes on
  `ticket_id` and on `updated_by`.
- **One row per field, not per ticket,** so a later kind (sprint, say, for T-089f) is a new `field`
  value and not a new column.
- **The migration writes no rows.** A plan without scenarios has no drafts and works as now; the
  first scenario made is main. `POST /plans` and its copy are unchanged.
- The schema golden file, the types in `schema.ts` and an `upgrade-fixtures.ts` entry come with the
  migration.

#### Routes and token scopes

All are internal in the API document (`x-taskmoor-stability: internal`), as the other plan routes,
and scopes follow the method. Writes are for the plan's editors, its owner and site administrators;
anyone else gets `forbidden` with `edit_plan`, as capacity and program boards do (question 2). A plan
the person may not see, and a scenario of another plan, answer 404 word for word as a missing id.

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/plans/:id/scenarios` | read | `{ scenarios: [{ id, name, main, drafts, notShown, createdBy, updatedAt, version }], editable, limits }`, counted for this viewer |
| `POST /api/v1/plans/:id/scenarios` | write | `{ name, from? }`: 201 `{ scenario, left: { notShown } }`; copies the drafts of `from` its maker is shown and counts the rest; the first is main |
| `PATCH /api/v1/plans/:id/scenarios/:sid` | write | `{ name, version }`; a stale `version` answers 409 |
| `DELETE /api/v1/plans/:id/scenarios/:sid?version=` | write | It and all its drafts; main is refused (`main_scenario`) while other scenarios exist |
| `POST /api/v1/plans/:id/scenarios/:sid/promote` | write | `{ version }`: makes it main; refused while applying (`apply_in_progress`) |
| `GET /api/v1/plans/:id/scenarios/:sid/changes?cursor=&only=` | read | The change list, 100 tickets a page; `only=ready\|refused\|changed` |
| `PUT /api/v1/plans/:id/scenarios/:sid/drafts` | write | `{ changes: [{ ticketId, startDate?, dueDate?, fields?: { "<teamFieldId>": teamId \| null } }], keep?: true }`, 1 to 200 tickets, all or nothing; `keep` is Keep my draft |
| `POST /api/v1/plans/:id/scenarios/:sid/discard` | write | `{ tickets }` or `{ all: true }`: `{ discarded, notShown }` |
| `POST /api/v1/plans/:id/scenarios/:sid/apply` | write | `{ tickets }` (1 to 100) or `{ all: true, after? }`; main only (`not_main`; question 3) |
| `GET /api/v1/plans/:id/compare?a=&b=` and the views' filters | read | Two sides, each `live` or a scenario id (see Comparing) |
| `GET .../timeline`, `.../calendar`, `.../capacity`, `.../program-boards/:boardId` | read | Gain `scenario=<id>`; without it they answer live, as now |

**What `PUT .../drafts` checks, per ticket:**

- It must be a ticket of the plan for the editor (it matches `unfiltered`, the plan's condition
  without the filters, with their ticket filter). Otherwise `changes.N.ticketId: not_found`, word for
  word as a ticket that does not exist.
- Days are calendar days, and the drafted start is not after the drafted due day, each read with
  the live value where not drafted (`start_after_due`).
- The field is a shared single-value Team field (`not_a_team_field`) and the team exists
  (`not_found`).
- The scenario stays at 10,000 drafted tickets or fewer (`too_many_drafts`).
- **Track permissions are not checked:** a draft changes nothing, so an editor may draft any ticket
  of the plan; the change list says beforehand which ones the editor may not apply, from the track
  permissions they hold, and applying checks again.
- The answer is the written tickets' entries in the change list.

#### Applying, ticket by ticket

1. **Hold the scenario:** set `applying_since` on the main scenario if it is null or more than 10
   minutes old; otherwise answer 409 `apply_in_progress`. One apply runs at a time per plan, and
   promotion waits for it.
2. **Read the chosen tickets' drafts and live tickets as the applier**, in one statement: in the plan
   for them and outside the trash. A ticket that is not, or has no draft they are shown, is refused
   as `gone`, the same whether it was deleted, hidden, moved out of the plan or never drafted, so the
   answer never tells whether a draft is there.
3. **Compare each drafted field with its live value:** every field already at its new value is
   `already` and counts as applied; any field whose live value differs from its value when drafted
   refuses the ticket as `changed_meanwhile`, with the values now, and nothing is sent.
4. **Call the ticket's own `PATCH` in-process** through `callRoute` (`tickets/caller.ts`), with a
   `Caller` built from the request (the applier, their authorization and API token), and
   `{ startDate?, dueDate?, fields?, version }` with the `version` just read. Four at a time, in
   ticket id order, as bulk changes run. Permissions per field ("Schedule tickets" for days, "Edit
   tickets" or the field's own rule for the Team value), locks (WF-007, M1-029), layout and required
   fields, formulas, history, `ticket.updated`, webhooks and follows all apply, and the history names
   the applier (question 13).
5. **Finish in one transaction:** delete each applied ticket's drafts whose `new_value` is still the
   value applied (a draft changed meanwhile stays); write `refusal` and `refused_at` on refused ones,
   which stay pending; clear `applying_since`; emit `plan.drafts_committed`. A server that stops
   halfway leaves drafts whose value is now live: they read as already so and go on the next apply.
6. **The answer:** `{ applied: [{ ticketId, key }], refused: [{ ticketId, key, reason, permission?,
   locks?, fields?, now? }], next, notShown }`. With `all`, `next` is the cursor of the next 100
   drafts shown (refused ones passed over), so the page loops and says "Applied 300 of 1,240". One
   refusal never stops the others (PLN-002 (3)).

| Ticket route answer | Reason | The page says |
|---|---|---|
| 403 `forbidden` with a permission | `no_permission` | "You may not schedule tickets in SPA" |
| 403 with locks | `locked` | "Its status In review is locked" |
| 409 `track_archived` | `track_archived` | "Its track is archived" |
| 404, 409 `in_trash`, or step 2 | `gone` | "No longer in this plan for you" |
| 409 `version_conflict` or `moved_meanwhile`, or step 3 | `changed_meanwhile` | "Changed since drafted: due is now 3 Dec" |
| 400 `invalid_fields` | `invalid` | "Team is not on this ticket's form" |
| Anything else, or a throw | `failed` | "Not changed; try again" |

#### Discarding and scenarios

- **Discard** removes the chosen tickets' drafts the person is shown, in any scenario. Drafts on
  tickets the plan does not show them stay and are counted, so nobody removes what they cannot see,
  as with a plan's hidden sources (stage 1; question 14).
- **Scenarios are shared** with everyone who sees the plan; none is private (question 8).
- **A new scenario** starts empty or as a copy of another's drafts the maker is shown; the rest are
  counted (`left.notShown`). At most 20 per plan.
- **Make main** (`promote`) swaps `main` in one transaction under both rows' locks, the main one
  first. The chosen scenario's drafts become the plan's drafts to apply (PLN-003 (2)); the former main
  stays as a scenario under its own name with its drafts, so nothing is lost (question 11).
- **Deleting a scenario** takes all its drafts, those on tickets hidden from the deleter too, and the
  dialog counts them: a container goes with what it holds, as a plan's hidden sources go with the
  plan. Main cannot be deleted while other scenarios exist; it can be emptied with Discard.
- After an apply, other scenarios' drafts on the same fields read as changed since drafted, by the
  rule above.

#### How the views read a scenario (`apps/server/src/plans/drafts.ts`)

- **One function, `draftOverlay(scenarioId)`,** left-joins the scenario's drafts to `ticket k`,
  folded to one row per ticket, and gives the expressions `START`, `DUE` and `TEAM(fieldId)`: the
  drafted value where that field is drafted, the live column otherwise.
- **Which tickets a view lists never comes from drafts.** The plan's `where` from `planTickets`, with
  the viewer's ticket filter (QRY-008) and the views' filters, reads live columns, and no filter
  (track, assignee, type, stage) is a draftable field, so drafts can neither widen nor narrow what a
  viewer sees.
- **Timeline:** items, roll-ups and the days `dependencyState` reads use the drafted days. An item's
  own fields carry the drafted values, so the drawing code is unchanged, and a drafted item gains
  `draft: { startDate?: { now }, dueDate?: { now }, stale }`.
- **Calendar:** its month's range condition reads `START` and `DUE`, so a ticket drafted into the
  month shows and one drafted out leaves.
- **Capacity:** work counts in the period of its drafted due day. Teams' loads follow assignees,
  which are not drafted in 1.0, so a Team value drafted alone moves no load. Work elsewhere stays live
  (stage 3).
- **Program board:** each card stands in the cell of its drafted Team value and due day.
- **Counts that drafts touch.** A search finds live values, so such a count cannot equal its search.
  A Capacity or board cell that a draft moves a ticket into or out of carries `drafts: n` and
  `clause: null`; the page says "With 2 draft changes" and shows the count as text, not a link
  (question 7). Cells no draft touches keep their links. To find them the server reads the live and
  drafted places of the drafted tickets only. Without `scenario` every count equals its search as
  before (PLN-005 (1), PLN-008).
- **Summary, List and Releases stay live.** In a scenario the List says "The List shows tickets as
  they are, not drafts", and editing cells in place is off, so no edit made in a scenario changes a
  ticket (PLN-002 (1); question 10).
- **A scenario missing or of another plan** answers 400 `invalid_fields` `{ scenario: 'not_found' }`;
  the page then shows the plan live and says the scenario no longer exists.
- Every answer in a scenario gains `scenario: { id, name, main, drafts, notShown }`.

#### Comparing

`GET /plans/:id/compare?a=&b=` with the views' filters; each side is `live` or a scenario. Over the
plan's tickets the viewer is shown, for each side:

- **The plan's end:** the latest due day of open tickets, with the ticket that sets it, and how many
  open tickets have no due day, so an end is never shown without that number.
- **Each plan team's end** by its Team value in the site's oldest shared Team field, as a new board
  takes it (or `teamField=`), plus "Other or no team".
- **Draft changes:** shown, and not shown as a number.
- **How many tickets end later and earlier in B than in A,** and the first 200 tickets that differ,
  with both values.

It is one statement over the plan's tickets for the viewer, with both overlays, reading no ticket
one by one. The page says each difference in words ("Ends 8 days later in Faster"). PLN-003 (1)
holds when scenarios give work different teams and days; a Team change that moves days by itself
waits for the auto-scheduler (T-089f), which writes its result as drafts into a scenario. Late
dependencies and team loads per period are not compared in 1.0 (question 12).

#### Who sees what

- **A draft is shown to a viewer only when its ticket is in the plan for them** (`unfiltered`).
  Otherwise it is counted, never named, keyed, dated or valued ("4 draft changes are on tickets this
  plan does not show you": `notShown`), hidden, trashed, archived-track and left-the-plan tickets in
  one number, as hidden sources are counted in stage 1. A ticket seen through a grant on a track the
  plan does not show the viewer is not in their plan, so a draft never tells them a hidden source
  holds it.
- **The views apply only drafts on tickets the viewer is shown,** and work elsewhere and blockers
  outside the plan stay live, so drafts add nothing about hidden work.
- **Every viewer of the plan** can choose a scenario, see drafts on the views, read the change list
  and compare; only editors write.
- **An id the person is not shown** answers `not_found` on drafts and `gone` on apply, the same as a
  missing one or one without a draft.
- **Comparing** reads only the viewer's tickets, so two viewers can see different ends; the page says
  the numbers are of the tickets they see.

#### The pages, on a desktop and on a phone

- **Scenario bar** on every tab, below the plan's name: a native select labelled **Scenario** with
  **Live** first, then the scenarios ("Main" in words), then **New scenario…**; and a sentence:
  "Changes you make here change tickets now." live, "Drafting in Faster: 12 changes. Nothing changes
  tickets until you apply them." for an editor in a scenario, "Viewing Faster. Only the plan's owner
  and site administrators can draft." for others. **Review 12 changes** opens Changes. The choice is
  in the address (`scenario=4`, part of `viewKey`, so a link opens the same scenario and the views
  read again); a plan opens Live (question 1). A change of scenario is announced. On a phone the
  select is full width and 44 px high, the sentence under it.
- **Timeline and Calendar in a scenario:** dragging, Alt and the arrows, and the side panel make
  drafts through the stage 1 seam (`reschedule` becomes `scenario ? draft : the live call`). A
  drafted bar has a **Draft** tag in text and a dashed edge, never colour alone; its description says
  "Draft: 8 to 10 Dec. Now 1 to 3 Dec."; a stale one says "Changed since drafted". The side panel
  shows Now and Draft with **Undo this draft**. A calendar chip begins with "Draft". After each draft
  the status says "Draft: SPA-12 due 10 Dec in Faster. Nothing changed yet."
- **Program board in a scenario:** drag and **Move…** make drafts (the Team value and days from
  `cardChange`, without `version`), the dialog's button says **Draft the move**, cards carry a
  **Draft** tag, touched cells say "includes drafts" without a link. Others' drafts show when the
  board reads again: on a ticket change, after its own moves, and every 15 s while open, since drafts
  are not in the change log. Live, the board is unchanged (PLN-008).
- **Capacity in a scenario:** its heading names the scenario; **Set capacity** still sets the plan's
  capacity, and its dialog says so.
- **Changes tab** (`#/plans/12/changes?scenario=4`), after Program boards: the change list.
  - On a desktop, a table grouped by ticket: a check box ("Select SPA-12"), key and summary as a
    link, track, a line per field ("Due: 3 Dec → 10 Dec", "Team: Atlas → Borealis"), its state in
    words ("Ready", "Changed since drafted: now 5 Dec", "Already so", "You may not schedule tickets in
    SPA", "Refused: its status is locked", "Proposed by the auto-scheduler" once T-089f exists), who
    drafted it and when. **Only those I can apply**, and "Select all 12 shown". Below: "3 more
    changes are on tickets this plan does not show you."
  - **Apply 3 changes** and **Apply all** (main only; another scenario offers **Make Faster main**
    instead), **Discard 3 changes** and **Discard all** through the shared DangerAction (D13), and
    **Keep my draft** on changed rows. Apply asks first: "Change 3 tickets as you, with your
    permissions?", then shows progress in words. The result says "3 applied, 1 refused", each refused
    row with its reason, still selected; focus moves to the result's heading and it is announced.
  - On a phone each ticket is a card with a 44 px check box, and an action bar fixed at the bottom
    holds **Apply 3** and **Discard 3**, with no sideways scrolling. 100 at a time, with **Show
    more**.
- **Scenarios tab** (`#/plans/12/scenarios?a=live&b=4`): each scenario with its changes (shown, and
  not shown counted), who made it and when; **Open**, **Rename**, **Make main** (asks first: "Faster's
  8 changes become the plan's drafts to apply. Main keeps its 12 as a scenario."), **Delete**
  (DangerAction, naming its draft count, hidden ones counted) and **New scenario** (name, "Start from:
  empty / a scenario"). Below, **Compare**: two selects, then a table of measures with A, B and the
  difference in words, each team's end, and the tickets that differ; on a phone, a card per measure
  and per team. Every dialog is a sheet on a phone.
- **Files and the image (stage 8)** made in a scenario hold the drafted values, carry a "Draft"
  column and say "Scenario: Faster, drafts not applied" in their header line and the image's title.
  The List's file stays live.
- **Everywhere:** glass per ADR-114, strings in both catalogues (`site`, `Plans`), status messages
  announced, 44 px targets under a coarse pointer, no sideways scrolling at 360 px, and a story with
  axe for each new component and dialog, at phone width too. New web files: `plans/ScenarioBar.tsx`,
  `plans/PlanChangesPage.tsx`, `plans/PlanScenariosPage.tsx`, `plans/ScenarioCompare.tsx` and
  `plans/scenarioClient.ts`; `address.ts` gains `scenario`, `a` and `b` and the `changes` and
  `scenarios` sections.

#### Events, audit and records

Each event is emitted in its write's transaction with the plan as its subject and is audited, as
`plan.*` and `workflow.draft_saved` are: drafts are the plan's content others see (question 12).
Webhooks get none, as for `plan.*`. Payloads hold ids, days and team ids, never names.

- `plan.scenario_created`: scenario, name, `from`, drafts copied, `notShown`
- `plan.scenario_updated`: scenario, changes
- `plan.scenario_deleted`: scenario, name, drafts
- `plan.scenario_promoted`: scenario, former main
- `plan.drafts_set`: scenario, `[{ ticketId, field, from, to }]`, removed, origin
- `plan.drafts_discarded`: scenario, ticket ids, count
- `plan.drafts_committed`: scenario, applied ids and keys, refused ids with reasons, `notShown`; its
  own transaction after the tickets', each of which emits its `ticket.updated`. The contract scenario
  lists `also: ['ticket.updated']`, as stage 4 brought in.

**The data download** gains `planScenarios` (the scenarios a person made) and `planDrafts` (the
drafts they last changed), by plan, scenario and ticket id with field and values, no key or summary,
since the plan or ticket may be hidden from them now, as for capacity. **Erasure rewrites nothing:**
`created_by` and `updated_by` keep the account's id, which now names the placeholder, as a plan's
owner does. **A copy of a plan** (stage 8) takes no scenarios or drafts (question 18); a deleted plan
takes its scenarios and drafts with it.

#### Limits and performance

| Limit | Value | Refusal |
|---|---|---|
| Scenarios a plan holds, main included | 20 | `too_many_scenarios` |
| Drafted tickets a scenario holds (a scheduler preview of a whole listed plan fits) | 10,000 | `too_many_drafts` |
| Tickets a drafts request holds | 200 | |
| Tickets an apply request holds; the page loops | 100 | |
| Applies at once per plan; stale after 10 minutes | 1 | `apply_in_progress` |
| Change list page; tickets listed as differing | 100; 200 | |
| Scenario names | 1 to 100 characters | |

PLN-012's bar, by `expectWithinBudget` in `plans.large.test.ts` with a scenario of 2,000 drafts over
10,000 tickets in every gate (100,000 with `TASKMOOR_LARGE_PLANS=1`): the Timeline, Calendar,
Capacity and a board with `scenario=` each under 1 s; the comparison under 1 s; a change list page
under 1 s; applying 100 tickets under 6 s, a target to measure, since each ticket costs what a bulk
change's does. Enforcing them waits for the user's 2026-11-14 hold on benchmarking.

#### Seams left for T-089f (the auto-scheduler, PLN-004)

- `writeDrafts(trx, { scenarioId, updatedBy, origin, changes })` in `plans/drafts.ts` is the one
  writer, under the checks and limits above; the scheduler writes `origin: 'scheduler'` into a new or
  chosen scenario, which is then previewed, compared, made main and applied unchanged.
- `draftOverlay(scenarioId)` lets it start from a scenario's days; Capacity takes `scenario`, so it
  reads loads with drafts.
- `field` is text: a `sprint` kind would apply through the sprint route, and applying maps kinds to
  requests through one table.

#### What the manual says

When built, `docs/manual/use/multi-track.md` gains **Scenarios and draft changes**: Live against a
scenario, what can be drafted and how drafts are marked, the change list and its states, applying and
why a change can be refused, Keep my draft, discarding, scenarios, making one main, comparing, that
the List and work elsewhere stay live, what is only counted and who may do what. "Not yet in plans"
loses draft changes and scenarios, and `sources` stay current.

#### Tests

PLN-002 as it should read when built: *Taskmoor shall let a plan's editors hold changes to tickets'
start and due days and Team values as draft changes in a scenario of the plan, show them on the
Timeline, the Calendar, Capacity and program boards marked in words, list them with their values when
drafted, now and drafted, and apply or discard all or chosen tickets' drafts; applying is each
ticket's own change, with the applier's permissions, and a viewer sees drafts only on the plan's
tickets they may see.* Acceptance: (1) edits in a scenario do not change tickets until applied;
(2) applying 3 of 10 tickets' drafts changes only those 3, and the other 7 stay pending; (3) applying
refuses a ticket with a reason (permission, lock, archived track, changed meanwhile, gone, not valid)
without stopping the rest; (4) a viewer sees drafts only on tickets the plan shows them, and the rest
only as a count.

PLN-003 as it should read when built: *Taskmoor shall hold several scenarios per plan, each with its
own draft changes and one of them main, the only one applied from; compare two side by side, or one
with the tickets as they are, by the plan's end and each team's end; and make another scenario main.*
Acceptance: (1) two scenarios with different Team values and days show different end dates; (2) making
a scenario main makes its drafts the plan's drafts to apply, and keeps the former main's as a scenario.

- `routes/plan-scenarios.test.ts`, `[PLN-002]`: (1) drafts of days and Team leave
  `GET /tickets/:key`, its `version`, history and events unchanged and write nothing to the change
  log; the Timeline, Calendar, Capacity and a board with `scenario` show drafted values and without
  it live ones; touched cells carry no clause; a draft set back to live is removed; changed since
  drafted, already so and Keep my draft. (2) Ten drafted tickets, apply three: exactly those change,
  with history naming the applier and three `ticket.updated`; seven stay listed;
  `plan.drafts_committed`; `all` with `next`. (3) The applier lacks "Schedule tickets" in one of two
  tracks: those are `no_permission` with the permission and the rest apply; one case each for
  `locked` (status and field), `track_archived`, `gone` (trashed, hidden and never drafted answer
  alike), `changed_meanwhile` (a field changed live, and a version raced during the apply) and
  `invalid` (Team not on the form); refusals stored and listed later; `apply_in_progress` and
  `not_main`; a draft changed during an apply stays; an apply stopped halfway is finished by the next.
- `[PLN-002] [QRY-008]`, (4): four viewers (a site administrator, someone who browses one of two
  tracks, someone who sees the plan and none of its tracks, and someone whose only sight of a hidden
  track's ticket is a ticket-level grant), with sentinel summaries and days on hidden tickets that
  appear in no answer, only in `notShown`; non-editors get `edit_plan` on every write; 404 bodies equal a missing id's for a
  hidden plan and for another plan's scenario; every count with no clause is one a draft touched, and
  every other equals its search.
- `[PLN-003]`: (1) scenarios A and B give one outcome's work different Team values and days through
  `PUT .../drafts`; `compare` shows different plan and team ends, and their differing tickets; (2)
  promotion swaps `main`, the former main keeps its drafts, applying takes the promoted drafts and the
  former answers `not_main`. Also: a copy that counts `notShown`, rename and delete with a stale
  `version`, `main_scenario`, `too_many_scenarios`, `too_many_drafts`, `start_after_due`, 200 per
  write and 100 per apply.
- `scopes.test.ts`, `[IAM-007]`: each route's class. `contract.test.ts`, `[AUT-010]`: a scenario per
  mutating route, with `also` on apply. The audit catalogue test: each new type audited.
  `privacy.test.ts`: the download lists a person's scenarios and drafts; erasure keeps them with the
  placeholder. `plans.test.ts`: a copy takes no scenarios. An upgrade fixture for 0110 and the schema
  golden file. `plans.large.test.ts`: the budgets above.
- Web: `ScenarioBar.test.tsx` (address, sentences, announcement), `PlanChanges.test.tsx` (rows in
  words, choosing, applying in batches with the result and focus, refusal words, Keep my draft, cards
  at phone width with `setViewportWidth()`), `PlanScenarios.test.tsx` (new, rename, delete, make main,
  compare as a table and as cards), additions to `PlanViews.test.tsx` and `ProgramBoardPage.test.tsx`
  (in a scenario a drag calls the draft client and never `PATCH`, Draft tags and descriptions in
  words, the List's notice and no editing in place, touched cells without links), `address.test.ts`,
  `planExport.test.tsx`; stories with axe.
- e2e `plan-scenarios.spec.ts`, desktop and phone: make a scenario, drag a bar and see the ticket
  unchanged on its own page; move a card on the board; apply two of three, one refused for a lock,
  with its reason; make a second scenario, compare the ends, make it main; on a phone the same through
  the side panel and **Move…**, with the fixed action bar.

#### Asked by the spec or nearby, not built here

- Drafts of other fields (assignee, estimates, sprint, release, rank, status, parent) and of new
  tickets; drafts in the List and editing in place as drafts.
- A release across tracks' date as a draft: stage 4's confirmed change list stays, which departs from
  stage 4's question 7, whose first answer said "held as a draft once T-089e exists" (question 9).
- Applying from a scenario other than main, applying a single field, undoing an apply (the ticket's
  history shows it), applying as a background job.
- Capacity of a scenario's own, late dependencies and team loads in the comparison, comparing more
  than two, side-by-side timelines, merging scenarios.
- Private scenarios, permissions per scenario, live push of drafts and presence, notifications,
  comments and webhooks about drafts, expiry of old drafts.
- Saved snapshots of dates (PLN-011, T-089a).

#### As built (the server; T-089e)

Built on 2026-11-14 in `plans/drafts.ts` (the model, `writeDrafts`, `draftOverlay`, `draftMarks`,
`refusalOf`) and `routes/plan-scenarios.ts`; the views gained `scenario=` in `plan-views.ts`,
`plan-capacity.ts` and `program-boards.ts`. The web app and the manual's section followed (see
"As built (the web app)"); the budgets in `plans.large.test.ts` wait for the user's hold on
benchmarking. Where this differs from the design above:

- **Migration 0110** also has an index on `plan_scenario.created_by` (the data download) and on
  `plan_draft.team_field_id` (deleting a field). `(plan_id, id)` on `plan_scenario` is unique, so a
  draft names its scenario and plan together by a foreign key, and a scenario of another plan
  cannot hold a draft. Checks keep `team_field_id` equal to the id in `cf:<id>` and both values JSON
  strings, numbers or null; a cleared value is stored as SQL null.
- **Keep my draft is said, not inferred:** `writeDrafts` stores the live value as the value when
  drafted for a new value, and for a value sent again only with `keep: true` (the page's button).
  A drafted value sent again without it is left as it was, its value when drafted included, so a
  change made meanwhile stays marked and an apply refuses it: the Timeline sends both days when
  only the bar's end moves, and the start it sends is the drafted one. (Built first as "every write
  is Keep my draft", which let that start's draft lose its mark and apply over the other person's
  change; fixed after review.) A ticket with a field written or removed loses its refusal.
- **`start_after_due`** reads, for the day not in the request, the scenario's draft before the live
  value. Its error is on `changes.N.startDate`.
- **Answers.** The list: `{ plan, editable, scenarios: [{ id, name, main, drafts, notShown,
  applying, createdBy, createdAt, updatedAt, version }], limits }`; counts are tickets, not fields.
  The change list: `{ scenario, editable, applying, changes, counts: { ready, already, changed,
  refused }, drafts, notShown, teams, teamFields, next }`, each change `{ ticketId, key, summary,
  trackId, version, state, fields: [{ field, teamFieldId, was, now, draft, state }], mayApply,
  needs, refusal, refusedAt, origin, updatedBy, updatedAt }`, where `needs` names the permission the
  reader lacks ("Schedule tickets" for days, "Edit tickets" for a Team value) and `state` is
  `changed`, then `refused`, then `already`, then `ready`; `only=ready` lists `already` too. `PUT
  .../drafts` answers that list for the tickets it named. `DELETE` answers 204. Promotion answers
  the scenarios. The limits answer 409 with `limit`.
- **Deleting a scenario while an apply holds it** is refused (`apply_in_progress`), as promotion is.
- **The plan's row orders scenario writes.** Making, deleting and promoting a scenario each take the
  plan's row first (a no-key lock, so a draft's foreign keys never wait on it), then the scenarios'
  rows. Two promotions at once both succeed, the later one main; a main scenario deleted while
  another is being made is refused (`main_scenario`), so a plan never ends up without its main one.
  (Built first with only the scenarios' rows locked, which let the second promotion break the
  one-main index, a 500, and a delete race a make; fixed after review.)
- **Applying.** A `gone` refusal carries `key: null` and is never stored, so a hidden ticket's
  draft shows no refusal to anyone. A ticket refused by a version raced during the apply gets its
  values now from a second read, as the applier sees it. A throw anywhere clears the hold. The
  applier's permissions come from `request.authz`, an API token's included, through `callRoute`.
- **`track_archived`** is reachable only when a track is archived between the read and the ticket's
  change (archived tracks' tickets are not in a plan, so they are `gone` before that); the test
  covers it in `refusalOf`'s table, not with a race.
- **The views.** `scenario` appears in an answer only in a scenario. A drafted item, chip or card
  carries `draft: { startDate?: { now }, dueDate?: { now }, fields?: { "<id>": { now } }, stale }`.
  A Capacity or board cell is touched only when a draft moves a ticket from one cell to another
  (two days in one period touch nothing); touched cells carry `drafts` and `clause: null`. The
  overlay applies drafts only where the plan's `unfiltered` holds for the viewer, roll-ups of
  descendants included.
- **Comparing** answers `{ plan, query, teamField, teamFields, a, b, later, earlier, differing: {
  count, tickets } }`, each side `{ side, scenario, end: { due, ticket, undated }, teams: [{ team,
  due, ticket, undated }] }` with "other or no team" last (`team: null`), and each differing
  ticket `{ id, key, summary, a: { start, due, team }, b: { ... } }`. `teamField=` picks another
  Team field; one not found, and a side not found, answer `invalid_fields`.
- **Events:** `plan.drafts_set` is `{ scenarioId, changes: [{ ticketId, field, from, to }], removed:
  [{ ticketId, field }], origin }`, emitted only when something changed; `plan.drafts_discarded`
  only when something went; `plan.drafts_committed`'s `applied` is `[{ ticketId, key }]` and its
  `refused` `[{ ticketId, reason }]`.
- **The data download** says `planScenarios: [{ planId, scenarioId, name, main, createdAt }]` and
  `planDrafts: [{ planId, scenarioId, ticketId, field, was, draft, origin, updatedAt }]`.
- **Client types** stay in the web app (`apps/web/src/plans/*Client.ts`), as the other stages'
  do, so none were added on the server.
- **Tests:** `routes/plan-scenarios.test.ts` (18), additions to `plans.test.ts`,
  `privacy/privacy.test.ts`, `events/contract.test.ts`, `tokens/scopes.test.ts`, the upgrade
  fixture and the schema golden file. The locked case is a field lock (a field rule set); a
  status lock goes through the same refusal and is not tested here.

#### As built (the web app; T-089e)

Built on 2026-11-14 in `plans/scenarioClient.ts` (the calls and their types), `ScenarioBar.tsx`,
`ScenarioDialogs.tsx` (New scenario, Rename and `AskFirst`, Apply's and Make main's question in
place), `PlanChangesPage.tsx` with `changeWords.ts`, `PlanScenariosPage.tsx`, `ScenarioCompare.tsx`
and `drafting.ts` (the stage 1 seam: `reschedule` and `move` become a draft in a scenario); the
views, `TimelineView`, `CalendarView`, `ResultTable`, `planExport.ts` and `address.ts` gained their
parts, and the manual's page its section. Where this differs from the design above:

- **The scenario bar** is on every tab but Settings, between the plan's description and its tab
  bar. **New scenario…** opens the same dialog as the Scenarios tab and, once made, the page opens
  the new scenario. A change of scenario is announced in a status line of its own; opening a page
  on one is not.
- **The address** keeps `scenario=` on every tab and `a=` and `b=` only on the Scenarios tab. The
  page waits for the scenarios before a view reads one; a scenario not found, or a list that could
  not be read, leaves the views live and says so.
- **Drafting** on the Timeline, the Calendar and a board always asks the server; someone who may not
  draft is answered `edit_plan` and the page says "only the plan's owner and site administrators
  can draft in a scenario". **Undo this draft** writes the live values back, which removes the
  draft. The board reads again every 15 s only in a scenario; live it keeps the local copy, as
  before.
- **Summary and Releases** say they stay live in a scenario, as the List does.
- **The change list** reads pages of 100 with **Show more**; it does not offer `only=`, and **Only
  those I can apply** filters the pages read. **Keep my draft** writes all of the ticket's drafted
  fields again. **Apply all** and **Discard all** are on a desktop only; on a phone the bar holds
  **Apply N** and **Discard N** of the chosen tickets, and **Select all** chooses every one shown.
  Apply all counts its progress against the drafts shown less those refused. A `gone` ticket is
  listed in the result by its reason alone, without a key.
- **Make main** shows its scenario's name ("Make Faster main") wherever it is: axe's
  label-content-name rule refused a "Make main" button named otherwise.
- **The comparison** uses the server's Team field; it offers no choice of another (`teamField=`).
  A differing ticket says both sides' days, and its team where the sides differ in it.
- **Files made in a scenario** start with the line "Scenario: Faster, drafts not applied"; the
  Timeline's and the Calendar's add a Draft column (Yes, "Yes, changed since drafted" or No), and
  Capacity's has the line only. The Timeline's image says the scenario in its title. A file made
  live is as before.
- **For stories**, whose browser is not a phone, `PlanChangesPage`, `PlanScenariosPage` and
  `ScenarioCompare` take `phone` to draw the phone's layout.
- **Tests:** `ScenarioBar.test.tsx` (6), `PlanChanges.test.tsx` (9), `PlanScenarios.test.tsx` (6),
  additions to `PlanViews.test.tsx` (7), `ProgramBoardPage.test.tsx` (2), `address.test.ts` (3),
  `planExport.test.tsx` (1) and `PlanPage.test.tsx`; stories for the bar, the dialogs, the change
  list, the Scenarios tab, the comparison and PlanPage's Timeline and Calendar in a scenario, with
  phone-width ones on a real touch screen; and `e2e/plan-scenarios.spec.ts` on a desktop and a
  phone, whose refused ticket is a field lock, as on the server. The e2e departs from the plan
  above in three ways: on a desktop it moves bars with Alt and an arrow rather than a drag (stage
  1's e2e covers the drag itself); it reads the tickets' days through the API rather than on their
  pages; and the phone's test does everything the desktop's does (applies two of three with the
  refusal in words, makes a second scenario, compares it in cards and makes it main), through the
  side panel, **Move…** and the bar at the bottom. Its keys and names come from `uniqueRun`
  (T-244).

#### Questions for the user (the design takes the first answer each time)

1. **Opening a plan:** shows Live (edits change tickets at once, as now) until someone picks a
   scenario, kept in the address; or the main scenario when there is one; or the last choice in
   this browser.
2. **Who drafts and manages scenarios:** the plan's owner and site administrators; or everyone who
   sees the plan; or each person in a sandbox of their own.
3. **Applying from:** the main scenario only (make another main first); or any scenario.
4. **A ticket changed since drafted:** applied when the drafted fields are still as drafted; or
   refused whenever the ticket changed at all; or the draft overwrites.
5. **What can be drafted in 1.0:** start and due days and the Team value; or also the assignee
   (Capacity by person would then follow drafts); or sprint, release, estimate and rank too.
6. **What a change is:** one ticket, all its drafted fields together; or each field on its own.
7. **Counts that drafts touch:** "With 2 draft changes", as text with no link; or beside the live
   count, which keeps its link.
8. **Scenarios:** shared with everyone who sees the plan; or private to whoever made them.
9. **A release across tracks' date:** stays stage 4's confirmed list; or becomes a draft too.
10. **The List in a scenario:** live, with a notice and no editing in place; or editing in place
    makes drafts.
11. **Making a scenario main:** the former main stays as a scenario with its drafts; or its drafts
    are discarded; or the two merge.
12. **Events and the comparison:** every draft event audited, and the comparison by ends; or only
    scenarios, applying and discarding audited; or late dependencies and team loads compared too.
13. **Following:** applying makes you follow each ticket you change, as any edit and bulk change do;
    or an apply follows nothing.
14. **Drafts on tickets an editor is not shown:** they stay, counted, until someone who sees them
    discards them or the scenario is deleted; or editors may discard them too.
15. **Two editors drafting one field:** the last write wins; or a version per draft, the second
    refused.
16. **Words:** "scenario", "main", "draft change", "Apply" and "Discard"; or "Commit" as the spec
    says; or other words.
17. **Limits:** 20 scenarios, 10,000 drafted tickets each, 200 per draft request and 100 per apply;
    or other numbers.
18. **A copy of a plan:** no scenarios or drafts; or its scenarios with the drafts its maker is shown.

### Later stages

Each adds its section here when it starts: the auto-scheduler (T-089f; PLN-004), and the hierarchy
grid and baselines (T-089a; PLN-010, PLN-011), which the user brought into 1.0 on 2026-11-13.
Releases across tracks (stage 4), duplicating, linking and exporting (stage 8), the program board
with dependency options (stage 5) and draft changes and scenarios (stage 6) are designed above.
PLN-002 to PLN-011 move to M1 in the spec with their stage, so nothing lists them for 1.0 before
they exist; PLN-006 moved with stage 2, PLN-005 and PLN-009 with stage 3, PLN-007 with stage 4,
PLN-008 and PLN-013 with stage 5, which builds PLN-013 with the program board as the user decided on
2026-11-13 (T-089i), and PLN-002 and PLN-003 with stage 6.

## Options considered

| Option | For | Against |
|---|---|---|
| The plan's tickets as text composed per viewer (chosen) | One compiler and one permission filter for every view; numbers equal their searches; the List is the search | A long text for a plan of hundreds of tracks; each view binds it again |
| The plan's tickets as SQL joined from sources | No text to build | A second way to read saved searches, outside the search's checks; no link to a search |
| Board sources | As PLN-001 first said | Each board belongs to one track; the track does the same |
| Filters with several values each | Fewer clicks for some views | The user chose one value at first |
| Group by outcome in the List | Asked in the first plan | The query language cannot yet say "under this outcome", so a group could not link to its search |
| A stored list of the plan's tickets | Fast to read | Out of date at once, and the same for every viewer |
| Capacity: a ticket whole in the period of its due day (chosen, stage 3) | Every number is a search's count; the same rule for points and hours | A long ticket weighs on its last period only |
| Capacity: a ticket spread over its days from start to due | Closer to how work is done | Fractions no search can show; tickets without a start need a rule of their own |
| Capacity: periods as the tracks' sprints | Matches how teams plan | A plan spans tracks with different sprints, or none; kept for velocity and external iterations, later |
| Capacity: work elsewhere left out of the load | Nothing about hidden work reaches the viewer | A person looks free while their hidden work fills the period; the plan's leader plans wrong |
| Capacity: work elsewhere by whole weeks, Monday to Sunday (chosen) | No setting of the periods narrows hidden work below a week; periods may still start on any day | Up to three days off in periods that do not start on a Monday, and in months |
| Capacity: work elsewhere by due day | Exact in every period | Moving the anchor a day at a time gives away each hidden ticket's due day |
| Capacity: periods only from Mondays | Weeks exact | Sprints that start mid-week cannot be matched; months against weeks still single out days at a month's edge |
| Releases across tracks: an object of the workspace (chosen, stage 4) | Seen with no plan, in queries and on release pages, as PLN-007 (1) asks | One more kind of object, and a rule for who sees it |
| Releases across tracks: owned by a plan | No new visibility rule | Gone with the plan; not visible outside it, which PLN-007 rules out |
| A move: each linked release by the mover's own right (chosen, stage 4) | Nobody gains a right over another team's release; the rest still move, as a commit does | Some releases stay behind and read as out of step |
| A move: all or nothing | Never out of step | One release a person may not change, or one shipped, stops everyone |
| A move: the owner overrides the tracks' administrators | Always lined up | Someone outside a team changes its release without its administrators, against "without changing how those teams work" |
| A work-complete release ships by itself | No extra step | Passes over approvals and the open-ticket prompt (CORE-016), which stay a person's act |
| A hidden count over all linked releases as one number (chosen, stage 4) | The state stays true for everyone, and nothing can narrow it | A viewer learns how much hidden open work there is, not what |
| A plan's copy: only what its maker sees, private, no capacity (chosen, stage 8) | Spreads nothing, and every field is one they could have set by hand | Sources, shares and capacity to set again |
| The Timeline image drawn from its rows as SVG, then PNG in the browser (chosen, stage 8) | Every row, no dependency, no server, and hidden work as the page words it | A second drawing of the Timeline to keep in step |
| The Timeline image captured from the page | One drawing | Past 200 only the rows in view are in the document, and a capture library is a new dependency |
| The Timeline image on the server, in a headless browser | The same picture everywhere | A browser in every install, for one button |
| View CSVs on the page from the view's own answer (chosen, stage 8) | The file equals the view, derived days and hidden counts included | No CSV route of their own for API tokens; the answer's JSON already serves them |
| Drafts as rows per field over live tickets (chosen, stage 6) | Views swap a column; a ticket changed meanwhile is seen field by field; new kinds need no column | Every view joins the overlay |
| Drafts as a copy of the plan's tickets per scenario | Views read one table | Out of date at once; a copy per viewer, or one that shows hidden tickets |
| Applying through each ticket's own route, ticket by ticket (chosen, stage 6) | Exactly the checks, locks, history and events of an edit; one refusal stops nothing | Slower than one statement; a stop halfway leaves part applied, which the next apply finishes |
| Applying all or nothing | Never part applied | One ticket the applier may not change stops the plan, against PLN-002 (3) |
| Counts that drafts touch shown without a link (chosen, stage 6) | Every link still equals its search | A touched cell cannot be opened as a search |

## Consequences

- Every view of a plan costs one bind of its query; a plan of hundreds of sources pays for it on
  each view. Measured on the M1 bar (`plans.large.test.ts` with `TASKMOOR_LARGE_PLANS=1`, a Mac,
  2026-11-03): a plan of 20 tracks and 100,000 tickets, medians of five reads, answers its page in
  3 ms, Summary 53 ms, Timeline 126 ms, Calendar 40 ms, a filtered Timeline 28 ms, the filter
  choices 32 ms, the List's search 6 ms and its groups 66 ms. Every gate runs the same at 10,000
  tickets against a one-second budget.
- Past 200 rows a timeline holds only the rows in view in the page, so a screen reader or the
  browser's find reaches the others by scrolling, not at once.
- Saved searches change a plan as they change: someone who edits a shared saved search changes
  every plan built on it, as for boards built on saved searches.
- A plan someone may see but whose sources they cannot see is an empty plan for them. The page
  says so, so the owner knows to share the tracks or searches as well.
- Revisit grouping by outcome when the query language gains an "under this outcome" condition.
- A viewer learns how many blockers outside their view hold a ticket up, though not which: the
  same kind of number as the count of hidden sources. Should the user want hidden blockers left
  out of the count altogether, `outside` would count only blockers the viewer may see, one
  statement more.
- A viewer of a plan learns how much work a team member has due in a period outside their view
  (a count and a sum of points or hours), though not which, nor its day: as they may own a plan
  and set its periods, they can learn it week by week, Monday to Sunday, and no closer. Should
  the user want hidden work left out, `elsewhere` would count only work the viewer may see, and
  over-capacity would then differ between viewers.
- Capacity follows the plan's teams as they are now: someone who leaves a team drops out of the
  view at once, and their capacity rows stay until the team leaves the plan or they come back.
- When stage 6 is built, a viewer of a plan learns how many draft changes sit on tickets it does not
  show them, though not which. Drafts are the plan's content: they stay through an apply that
  refuses them and through erasure, until discarded or their scenario goes, and an applier's ticket
  history, not the plan, records what changed.
- When stage 4 is built, a viewer of a release across tracks learns how many linked releases and
  how many open tickets are hidden from them, though not which, nor where. Someone who moves its
  date can leave releases out of step, and they stay so until their tracks' administrators act.
- When stage 8 is built, a downloaded file or image leaves the system's permissions with whoever
  saved it, as search exports do. The Timeline has two drawings to keep in step, on the page and in
  the image, sharing their rows and the late rule.
