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
- All of Multi-track is in 1.0: the hierarchy grid (PLN-010) and baselines (PLN-011) joined it on
  2026-11-13 (`docs/plan/decisions.csv`, "Hierarchy grid and baselines"). It is built in stages,
  one ticket each: this first one (T-088), then dependencies, teams and capacity, cross-track
  releases, the program board, draft changes and scenarios, the auto-scheduler, and duplicating or
  exporting (T-089 to T-089g), then baselines and the hierarchy grid (T-089a, stages 9 and 10).
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

**Designed and built on 2026-11-13; on `main` at `443b2dcd` (2026-11-14).** PLN-008 and PLN-013 move to M1 with this stage, reworded to what is
built (the wordings are under "Tests"). The user decided on 2026-11-13 (`decisions.csv`, rows on
T-089i and T-241) to build PLN-013 with the program board in 1.0, that blockers outside the plan
stay a count only, that the section is called **Plans** and that the interface says **site**. The
questions at the end are the user's; the design takes the first answer each time. **Answered on 2026-11-14 (T-300): the user kept all twelve as built.**

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

- `writeDrafts(trx, { workspaceId, planId, scenarioId, updatedBy, origin, changes, keep? })` in
  `plans/drafts.ts` is the one writer; each change carries the field's live value, and the caller
  holds the scenario's row lock and makes the checks and limits above (corrected by stage 7). The
  scheduler writes `origin: 'scheduler'` into a new or chosen scenario, which is then previewed,
  compared, made main and applied unchanged.
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
  values now from a second read, as the applier sees it. A throw anywhere clears the hold, as the
  finish does, and both let go only of the apply's own hold (the time it set): an apply that ran
  past ten minutes, whose hold another apply then took as stale, leaves that other one's hold in
  place. (Built first clearing any hold; fixed after review.) The
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
  can draft in a scenario". **Undo this draft** writes the live values back, every drafted
  field's (a Team value drafted on a board included), which removes the draft; a ticket whose team
  alone is drafted keeps its bar's plain name and its panel says its team is drafted. The side
  panel stays while its ticket is chosen, so a save or an undo keeps focus in it (Save, once Undo
  goes), and its fields follow the days read again. (Built first redrawing the panel on every
  change of days, which dropped focus to the page, and undoing only days, which a team-only draft
  refused; fixed after review.) The board reads again every 15 s only in a scenario; live it keeps the local copy, as
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

#### After review (T-089e)

A review of the branch found these, each fixed with a test that fails without the fix (the server
and the page notes above say what changed where they belong):

- **Server:** Keep my draft is said with `keep: true`, so a drafted day the Timeline sends again
  beside a moved one keeps its mark; making, deleting and promoting scenarios take the plan's row
  first; an apply lets go only of its own hold; a scenario's id in `compare` and a Team field's id
  in a draft beyond an int4 answer `invalid_fields` (`too_large`), not a 500. New tests pin what
  was untested: the overlay's guard on a roll-up's descendants outside the plan, all or nothing
  with one bad change among good ones, `start_after_due` against a drafted day, every Capacity
  cell with a search equal to it in a scenario, an archived track's ticket refused as `gone`, and
  `apply_in_progress` on delete and promotion. `routes/plan-scenarios.test.ts` holds 29 tests.
- **The change list** is drawn afresh for each scenario (choices, a result and pages stay with
  theirs), and **Show more** drops a page that answers after the list was read again. Focus never
  falls to the page: AskFirst's answer gives it back to its button, and Keep, Make main, a running
  Apply and, on the Scenarios tab, Make main and Delete give it to the list's heading.
- **The comparison** shows a pair's numbers only under that pair's names, and is read again when
  a scenario's version, drafts or hidden drafts change.
- **The scenario bar** no longer says the scenario asked for is gone when the list could not be
  read; that list's own alert says so.
- **On a touch screen** a change card's ticket link and a differing ticket's link are 44 px high.
- **Spanish** agrees a scenario's counts with their number ("1 aplicado, 1 rechazado").
- **The manual** gives the permission refusals in the page's words and counts an archived track's
  ticket as no longer in the plan; the multi-track task plan has PLN-002 and PLN-003 in M1.

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

### Stage 7 (T-089f): the auto-scheduler

**Designed on 2026-11-14; built the same day (see "As built (T-089f)" below for where the build
differs).**
PLN-004 moves to M1 with this stage, reworded to what will be built (the wording is under
"Tests"). The new wording narrows the spec's: the run fills the plan's periods, not sprints; it
uses capacity, not velocity; and a release's date is a warning, not a limit (questions 1, 2 and
15). Three designs were made and judged against the spec, privacy, the earlier stages and the
code; this one is the smallest (no migration, stage 6's writer, preview and apply unchanged) with
the others' safer pieces grafted in (a diff under the scenario's lock so a second run changes
nothing, writes in chunks under Postgres's limit on bound values, blockers first in rank order,
cycles found, tickets the runner may not schedule kept, work elsewhere counted as Capacity counts
it, a readiness check before the run and a reason in words for every ticket). The questions at
the end are the user's; the design takes the first answer each time.

The **auto-scheduler** proposes start and due days for a plan's open tickets. A **run** places
them in rank order, blockers first, into the plan's **periods** (stage 3), within the capacity set
for each person and team, and never starts a ticket on or before the day one of its blockers ends.
It changes no ticket. Its only output is **draft changes** of start and due days with origin
`scheduler`, written into a **scenario** through stage 6's writer. From there stage 6's views,
change list, comparison, making main, applying and discarding work unchanged. A run follows rules a
person can read, with no AI, and says of each ticket why it landed where it did, why it was kept, or
why it was not placed.

**On the words:** the interface says **Auto-schedule**, **run**, **proposed**, **kept** (a ticket
whose days a rule keeps) and **not placed** (a ticket the run could not place, which keeps its
days too) (question 23). It never says "optimise", "AI", "level" or "commit". The buckets are the
plan's periods, never "sprints", which belong to boards (question 1).

#### What a run is

- **One run writes into one scenario,** a new one or the one open, chosen in the dialog
  (question 16). It runs in the request, as the editor who started it, and stores nothing but
  drafts.
- **It drafts start and due days only** (question 3), so `plan_draft`'s field check, apply's
  mapping of fields to the ticket's `PATCH` and the change list need no change.
- **A re-run in the same scenario replaces the auto-scheduler's own earlier proposal** on the
  tickets the runner is shown. Drafts a person made stay, and the run keeps those tickets where the
  person put them (question 17). A person who drags a proposed bar turns that draft into theirs,
  since `writeDrafts` writes the origin of the last writer.
- **The same tickets, capacity and choices give the same drafts and reasons,** whatever order the
  rows come in. A second run on unchanged tickets changes no draft and emits no `plan.drafts_set`.
- **Its report** (counts, and each ticket's outcome and reason) is in the run's answer. The page
  keeps it while the plan stays open; it is not stored (question 18).

#### What is stored

Nothing new, and **no migration**: `docs/plan/multi-track-tasks.md`'s "Migration: none expected"
for MT-07 stays true.

- The output is `plan_draft` rows with `origin = 'scheduler'` and `field` `startDate` or `dueDate`,
  all of which migration 0110's checks already allow (`0110_plan_scenarios.ts:43` and `:47`).
- A run's choices travel in its request. The dialog starts from the last ones used in this browser
  (a per-viewer convenience in `localStorage`, read and written in `try`, never needed).
- The schema golden file, `upgrade-fixtures.ts`, the data download and erasure do not change:
  drafts are already covered by stage 6.

#### Routes and token scopes

Both are internal in the API document (`x-taskmoor-stability: internal`), as the other plan
routes, and scopes follow the method. A plan the person may not see, and a scenario of another
plan, answer 404 word for word as a missing id. The run is for the plan's editors, its owner and
site administrators; anyone else gets `forbidden` with `edit_plan`, the rule of `opened()` in
`routes/plan-scenarios.ts:230` (question 22). They live in a new
`apps/server/src/routes/plan-schedule.ts`, registered beside `registerPlanScenarioRoutes`
(`app.ts:611`), with its own `visiblePlan`, as `plan-capacity.ts` has.

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/plans/:id/schedule?scenario=&from=&periods=` | read | **Readiness**, for anyone who sees the plan: `{ plan: { id, name }, unit, pointsField, periods: [{ start, end }], period, teams: [{ id, name, withCapacity }], people: { withCapacity, without }, tickets: { open, unestimated, unassigned, noTeam }, scenarios, editable, limits }`, and with `scenario=` also `scenario: { id, name, main, version, applying, proposals, drafts, notShown }`; counted over the tickets the reader is shown; no ticket is named |
| `POST /api/v1/plans/:id/schedule` | write | Runs. Body below; 200 with the run's answer, or 201 when it made the scenario |

**The body** (zod `scheduleBody`, new, in `apps/server/src/plans/scheduler.ts`):

- `into`: `{ scenarioId }`, or `{ newScenario: { name, from? } }` where `from` is a scenario to
  copy, as `POST /scenarios` takes it. A name is 1 to 100 characters.
- `from`: the first day, `YYYY-MM-DD`. The page sends the person's own today; without it the server
  takes today in UTC.
- `periods`: 1 to 12, 6 by default: exactly one Capacity view (`MAX_PERIODS`, `plans/model.ts:165`),
  so the person can check the whole run on the Capacity tab (question 20).
- `leaveOut`: `{ typeIds?: ≤ 20, releaseIds?: ≤ 20, query?: text ≤ 2,000 characters }`.
- `keep`: `{ inProgress?: true, inActiveSprint?: true, query?: text ≤ 2,000 characters }`;
  the two flags are on by default.

**The answer:** `{ scenario: { id, name, main, version }, created, from, periods, counts, tickets,
more }`.

- `counts`: `placed`, `unchanged`, `withdrawn` (earlier proposals removed), `changedMeanwhile`,
  `kept` by reason, `notPlaced` by reason, `leftOut` by reason, `warnings` by kind, and
  `notShown` (earlier proposals on tickets the runner is not shown, left as they were).
- `tickets`: at most 2,000 entries `{ id, key, outcome: 'placed' | 'kept' | 'not_placed', reason,
  args, warnings }`, in this order: not placed, placed with a warning, kept, placed; `more` counts
  the rest. `args` holds ids, days and amounts only; a blocker's id is there only when the runner is
  shown that ticket.

**Refusals:** 400 `invalid_fields` (bad body; `leaveOut.query` or `keep.query` that does not
compile: `invalid_query`); 409 `too_many_scenarios`, `apply_in_progress`, `too_many_to_schedule`
`{ limit, count }`, `plan_too_large` `{ limit }` and `too_many_drafts` `{ limit }`; 404 as above; a
search that runs too long answers as `searchRefusal` (`routes/search.ts:102`) does.

#### What a run reads

Everything is read as the runner sees it, outside the write's transaction, through `readOnly`
(`search/run.ts:208`) with the plan views' statement timeout.

- **Tickets:** `planTickets(db, catalogs, request, await sourceRows(db, [planId]))`
  (`plans/query.ts:244`) and its `unfiltered` condition: the whole plan for the runner, never the
  views' filters, never the trash. One statement reads the plan's open tickets (`status.stage <>
  'closed'`): id, key, rank, track, type, hierarchy level rank (`ticket_type.level_id` →
  `hierarchy_level.rank`, as the Timeline reads it at `plan-views.ts:440`), stage, assignee, the
  estimate, the days, the sprint days and the fields a permission check needs.
- **Days:** through `draftOverlay(scenarioId, unfiltered, 'so', { origin: 'person' })`. The fourth
  argument is new and optional: it folds only people's drafts, so the run starts from live days
  plus people's drafts and ignores its own earlier proposal, which it replaces. Without it the
  overlay is unchanged. For a new scenario the overlay is the copied scenario's (or none).
- **Rank:** `ticket.rank` compared by UTF-16 code unit (`a < b`), never `localeCompare`, so it
  agrees with the "C" collation (`tickets/rank.ts`), then by id.
- **Estimates and capacity:** the plan's unit; points from the Points field (`pointsField`) or
  hours from the original estimate (`estimate`), and `plan_capacity` resolved as Capacity resolves
  it: a person's period row, else their every-period row; a team's own, else its every-period row,
  else the sum of its members' where any has one. These are closures in
  `routes/plan-capacity.ts:141-185` and `:354-430` today and move to a new
  `apps/server/src/plans/capacity.ts` (see "Shared code"). Amounts are whole hundredths: an
  estimate is rounded half up to hundredths, as Capacity rounds (`plan-capacity.ts:84`), so no
  floating point decides a fit.
- **Load already there**, per person and plan team and period, exactly as `GET .../capacity`
  counts it for this scenario, less the tickets the run may move:
  - the plan's tickets due in the period, closed ones included (Capacity's `planned` query,
    `plan-capacity.ts:240-253`, counts them), except those the run may move;
  - the person's work elsewhere, by whole weeks in the period that holds each week's Thursday
    (`weekThursday`), as Capacity's `elsewhere` and `away` do (question 10).
  A team's load is the sum of its members', and a person in two plan teams loads both, as on the
  Capacity tab.
- **Dependencies:** every link whose target is one of the open tickets read, by the predicate of
  `readDependencies` (`plans/dependencies.ts:86`): `lower(outward) = 'blocks'` or a type the plan
  chose (`dependencyOptions`, `:47`), one link per pair with the blocking one first, blockers in the
  trash left out. The source finishes first. A blocker outside the open tickets read is either in
  the plan for the runner (`unfiltered`), and so closed, or not, and so outside the plan or hidden.
- **Sprints:** the sprint a ticket is dated by, as `SPRINT_OF` (`plan-views.ts:102`) takes it, for
  a blocker without days of its own; and whether the ticket is in an active sprint
  (`sprint_ticket.open`, `sprint.state = 'active'`, not deleted, on a Scrum board).
- **Target releases:** for each ticket, the earliest `release.release_date` among its
  `ticket_release` rows with role `target` whose release is neither shipped nor archived. A
  release across tracks with a fixed date already moves its members' `release_date`
  (stage 4), so only `release.release_date` is read, as it stands.
- **May the runner set its days:** `request.authz.ticket(row)` per ticket, as the change list asks
  it (`plan-scenarios.ts:424`). Without `schedule_tickets` (an archived track grants none) the
  ticket is kept, so applying never refuses what the preview proposed for that reason.

#### Sorting the tickets

Each open ticket of the plan the runner is shown falls in exactly one class, by the first rule
that matches, in this order. Closed tickets are never moved and hold nothing up as blockers,
which agrees with the Timeline: a closed blocker is never late (PLN-006 (1)).

1. **Left out** (never drafted): its level is not 0 (question 6), its type is in
   `leaveOut.typeIds`, it targets a release in `leaveOut.releaseIds`, or it matches
   `leaveOut.query`. Its load still counts where its days put it, and it still holds up what it
   blocks, through its days.
2. **Kept** (its days stay; question 4): a person drafted its start or due day in this scenario
   (`person_draft`); the runner may not set its days (`may_not_schedule`); it matches `keep.query`
   (`kept_by_query`); it is in progress, stage `active`, and `keep.inProgress` is on
   (`in_progress`); it is in an active sprint and `keep.inActiveSprint` is on (`in_sprint`). Its
   load counts where its days put it, and it holds up what it blocks.
3. **Movable:** every other open level-0 ticket, dated or not (question 5).

`leaveOut.query` and `keep.query` are compiled by `compileCondition(db, tickets.scope, text, now)`
(`boards/data.ts:261`), as the plans' filters are, in the runner's scope. They replace any word
people would have to spell, such as a label (question 4).

More than 10,000 movable tickets refuse the run with `too_many_to_schedule`; more than 50,000 open
tickets read (PLN-001's plan size) refuse it with `plan_too_large`. Nothing is written.

#### The rules, in the order a person can follow

The engine is a new pure function, `schedule(input): ScheduleOutput`, in
`apps/server/src/plans/scheduler.ts`, with no database. Days are whole numbers from `dayNumber`
(`plans/periods.ts:17`); periods come from `periodsFrom(periodOf(plan), from, periods)`
(`plans/periods.ts:41`, `routes/plans.ts:88`).

1. **Who carries a ticket:** its **subjects** are its assignee and every plan team the assignee
   is in (`planTeams`, `routes/plans.ts:129`, and `team_member`), the people and teams whose rows
   on the Capacity tab count it (question 7).
2. **Not placed before placing**, with the reason; the ticket keeps its days, and its load counts
   there from the start:
   - `no_estimate`: no estimate in the plan's unit (question 8);
   - `no_assignee`: nobody is assigned (question 9);
   - `no_team`: the assignee is in none of the plan's teams;
   - `no_capacity`: no subject has a capacity set in any period of the run;
   - `too_big`: in every period where a subject has a capacity, the estimate is more than one of
     them (the reason gives the largest capacity seen);
   - `cycle`: the ticket is in a circle of dependencies, found with Tarjan's strongly connected
     components (a component of two or more, or a link to itself); the reason names up to five of
     its keys, only those the reader is shown;
   - `hidden_blocker`: an open or closed blocker outside the plan or hidden from the runner. Its
     days are never read and it is never named, keyed or counted beyond what the Timeline already
     counts, so no drafted day says anything about it (question 14);
   - `blocker_undated`: a blocker that is open, not movable and has no days of its own or of its
     sprint.
3. **Order:** each movable ticket gets an **effective rank**, the best rank among itself and every
   movable ticket it blocks, directly or not, computed in one pass over the reverse topological
   order. Tickets are visited in Kahn's order with a heap on (effective rank, rank, id), so a ticket
   is visited only after all its movable blockers. A low-ranked blocker therefore goes ahead of what
   it holds up (question 11).
4. **Earliest day:** the latest of `from` and the day after each blocker's **end**. A placed
   blocker ends on its drafted due day; any other ends on its later day, a single day counting as
   both start and end (as `barOf` reads a bar, `apps/web/src/timeline/dependencies.ts:9`), else on
   its sprint's end. A blocker the run could not place keeps its days and ends where they do; one
   with no days makes the ticket `blocker_not_placed`, naming it.
5. **Rank order per person and team** (question 12): each subject has a cursor, the last period
   it took a ticket in. A ticket is tried from the latest of the period holding its earliest day
   and its subjects' cursors. So for one team, lower-ranked work never lands before higher-ranked
   work, and room can stay unused.
6. **Fit:** the first period `p` from there to the end of the run where at least one subject has a
   capacity set in `p`, and every subject with one has **load + estimate ≤ capacity** (Capacity's
   `over` is `load > limit`, `plan-capacity.ts:383-387`), and the ticket's start fits in `p`. A
   subject with no capacity in `p` limits nothing, as a person with no capacity is never over
   (PLN-009 (2)). A capacity of 0 holds nothing.
7. **Days** (question 13): **start** = the latest of `p`'s first day and the earliest day; **due**
   = `p`'s last day. The start is never after the due, so `start_after_due` cannot arise.
8. **Take it:** add the estimate to every subject's load in `p` and move their cursors to `p`.
9. **Nothing fits** before the run's last period: `no_room`, naming the fullest subject and the
   run's last day. The ticket keeps its days, and its load is added where they fall; if a period
   there was already filled by placed work, the ticket gets the warning `over_where_kept`.
10. **Warnings on a placed ticket:** `after_release` (its due day is after its target release's
    date: the days late and the release; question 15); `late_against_kept` (it blocks a kept or
    left-out ticket that starts on or before its due day: that dependency stays late and the run
    cannot help it).
11. **Reasons for a placed ticket:** `fits` (the first period with room), `after_blocker` (pushed
    by a blocker's end, naming it), `after_higher_ranked` (pushed by its subjects' cursors),
    `first_for_blocked` (pulled forward because it blocks a higher-ranked ticket, naming it), and
    `already` (the proposal equals its days now, so nothing is drafted).

**What the rules promise** (the property tests):

- (a) No placed ticket starts on or before the end of a blocker that is placed, kept or left out
  and dated. Read by `dependencyState` (`apps/web/src/timeline/dependencies.ts:34`: late when the
  blocked ticket's start is on or before the blocker's due), no such link is late. The server's
  twin is `isLate(blockerEnd, blockedStart)` in `scheduler.ts`, tested against the same table of
  cases as the web's rule.
- (b) No placed ticket takes a subject's load in a period over its capacity. A cell can go over
  only through a ticket kept where it was, and that ticket carries `over_where_kept`.
- (c) Kept, left-out and closed tickets get no draft.
- (d) Every movable ticket is placed or not placed exactly once, with one reason.
- (e) The output does not depend on the order of the input; a second run on unchanged tickets
  changes no draft.

#### Writing the result

One transaction, after the reads and the engine, so the scenario's lock is held only while
writing:

1. **The scenario:** for `newScenario`, the plan's row is locked and the scenario made by
   `createScenario` (lifted from `POST /scenarios`, `plan-scenarios.ts:517-593`): the 20-scenario
   limit, the first made is main, a copy of `from`'s drafts the maker is shown with their origin,
   and `plan.scenario_created`.
2. **Lock the scenario** (`lockScenario`, lifted from `plan-scenarios.ts:864-872`). An apply
   holding it (`applying`, `drafts.ts:485`) refuses with `apply_in_progress`. This check is new:
   `PUT .../drafts` does not make it, but a run rewrites many drafts an apply may be reading.
3. **Read again under the lock**, for the tickets the run would touch: their live days and the
   scenario's people's drafts on days. A ticket whose live days or people's drafts changed since
   the run read them is left out of the write and counted `changedMeanwhile` ("changed while the
   run worked; run again").
4. **Diff against the auto-scheduler's drafts there** (only on tickets the runner is shown):
   - a proposal equal to the live day writes nothing, and removes an earlier proposal on that
     field;
   - a proposal equal to an earlier proposal whose value when drafted is still the live one is left
     as it is;
   - any other proposal is written with `keep: true`, so its value when drafted is the live one
     now and never a stale one from an earlier run;
   - an earlier proposal on a ticket the run did not place is removed, except on a ticket kept for
     a person's draft, where it stays: removing it alone could put that ticket's start after its
     due.
   Removal is by a new `clearSchedulerDrafts(trx, scenarioId, pairs)`, which deletes only rows
   whose origin is still `scheduler`.
5. **Write** through `writeDrafts(trx, { workspaceId, planId, scenarioId, updatedBy, origin:
   'scheduler', changes, keep: true })` (`drafts.ts:267`), in calls of at most 2,000 changes. Its
   insert binds 13 values a row, and one statement takes at most 65,535, so 20,000 rows at once
   would fail. Each change carries `live` from step 3.
6. **The limit:** more than 10,000 drafted tickets in the scenario (`draftedTickets`, lifted from
   `plan-scenarios.ts:275`) throws `TooManyDrafts` (lifted from `:1434`); the whole run rolls back
   and answers `too_many_drafts`.
7. **Events,** through `emitMany` (`events/bus.ts:62`): `plan.drafts_set` with origin
   `scheduler`, at most 1,000 entries (changes plus removals) each, none when nothing changed; then
   one `plan.schedule_ran`.

#### Shared code (moved, not changed)

These moves keep behaviour as it is; the existing tests and golden files of Capacity and
scenarios prove it by passing unchanged.

- **`apps/server/src/plans/capacity.ts` (new):** `pointsField(db, ws)`, `estimateSql(unit,
  fieldId)`, `membersOf(q, ws, teamIds)`, `capacityRows(db, planId)`, `capacityOf(rows, periods,
  subject)`, `teamCapacity(own, members)` and `elsewhereWork(trx, { ws, people, where, value,
  periods })` with the weeks rule, from `routes/plan-capacity.ts`. The Capacity route imports them.
- **`apps/server/src/plans/drafts.ts`:** exports `lockPlan`, `lockScenario`, `draftedTickets`,
  `TooManyDrafts` and `createScenario`, from `routes/plan-scenarios.ts`, which then uses them; adds
  `clearSchedulerDrafts`, the `origin` option of `draftOverlay`, and `origin` on `DraftMark`
  (`'scheduler'` when any drafted day of the ticket is, as the change list says it, `:466`).
- **`apps/server/src/plans/dependencies.ts`:** `blockingLinks(trx, ws, targetIds, options)`, the
  first statement of `readDependencies`, which then calls it.
- **`apps/server/src/plans/sprints.ts` (new):** `sprintDay(column)` (today's `SPRINT_OF`, which
  `plan-views.ts` then imports) and `inActiveSprint`.
- **`apps/server/src/plans/scheduleInputs.ts` (new):** reads everything above for one run and
  builds the engine's input.
- **Stage 6's seam text is corrected** above: `writeDrafts` also takes `workspaceId`, `planId`, a
  live value per change and `keep`, and the caller holds the scenario's row lock.

#### Who sees what

- **A run reads only what its runner is shown:** hidden tickets are never moved, drafted,
  counted by reason or named in its answer.
- **A blocker outside the plan or hidden from the runner** keeps the ticket it blocks where it
  is, with a reason that names nothing ("waits on a ticket this plan does not show you"). Its days
  are never read, so no drafted day reveals them.
- **Work elsewhere** enters only as each person's weekly totals, the figure the Capacity tab
  already shows; a drafted day reveals nothing finer than a week about hidden work.
- **Readiness** gives counts only, over the reader's tickets.
- **Other viewers** see the run's drafts only on tickets the plan shows them, and the rest as a
  count, by stage 6's rules (`draftOverlay`'s `shown`, `draftCounts`). A second editor who sees less
  replaces only the proposals on tickets they are shown; the rest stay and are counted in
  `notShown` ("2 earlier proposals stay on tickets this plan does not show you"), as stage 6's
  question 14 keeps drafts.
- **What a run's drafts say to others** (found in review, 2026-11-14): "no drafted day says
  anything about it" holds for the runner only. A run plans around every blocker its runner sees,
  so when a site administrator runs it, a ticket other viewers are shown can be proposed to start
  the day after a blocker hidden from them ends, and that drafted start bounds the hidden
  blocker's end (exactly, when nothing else held the ticket back). A person drafting by hand can
  say as much, and a run by someone who sees less withdraws such proposals as `hidden_blocker`.
  The build leaves it so and the manual says it; question 24 asks the user.

#### The pages, on a desktop and on a phone

- **Scenario bar** (`ScenarioBar.tsx`): editors get **Auto-schedule…** after **Review N
  changes**, on every tab. The Scenarios tab (`PlanScenariosPage.tsx`) has it beside **New
  scenario**. Others never see it.
- **The dialog** (`AutoScheduleDialog.tsx`, new), a sheet on a phone. It reads readiness first, so
  problems show before the run:
  - "Atlas and Borealis have capacity. Cirrus has none, so its tickets will not be placed.", with
    a link to the Capacity tab; "Capacity is in points, from the field Story points."; "No Points
    field exists, so tickets cannot be sized. Switch the plan to hours or add a shared number field
    named Points." When no team has capacity, **Run** is off and the reason is beside it in words.
  - **Where the result goes** (a radio group): **A new scenario** (default; name prefilled
    "Auto-schedule 14 Nov"; "Start from": the scenario open, or empty in Live), or **This
    scenario: Faster** when one is open. At 20 scenarios the first is off, with the reason in words.
    If the plan has none, the dialog says the new one becomes main. While an apply holds the open
    one, the second is off: "Faster is being applied."
  - **What it may move:** "Closed tickets never move." **Keep tickets in progress** and **Keep
    tickets in an active sprint** (checked); **Also keep tickets matching** (a query field, empty);
    **Leave out ticket types** and **Leave out releases** (multi-selects); **Also leave out
    tickets matching** (a query field). Query errors show under their field in words.
  - **When:** **Schedule from** (a day, today by default) and **Look ahead** (1 to 12 periods, 6 by
    default), with a hint naming them: "6 periods of 2 weeks: 17 Nov to 8 Feb."
  - The unit is shown, not chosen.
  - The footer: **Run** and **Cancel**, and "It changes no ticket: it writes draft changes you can
    review, compare and apply." In a scenario with earlier proposals: "Re-running replaces the
    auto-scheduler's 180 proposals here. Your 3 drafts stay, and it plans around them." While it
    runs, **Run** reads "Scheduling…" and is off, a `role="status"` line says "Scheduling 2,140
    tickets.", and the dialog closes only once the run has answered.
- **After the run** the page opens that scenario's **Changes** tab with a **result panel**
  (`ScheduleResult.tsx`, new) on top, a `section` headed "Auto-schedule" that takes focus:
  - "180 placed, 14 kept, 9 not placed, 22 earlier proposals removed. 3 of your drafts stay.";
  - three filter buttons with `aria-pressed`: **Placed**, **Not placed**, **Kept**; each row a
    key and summary as a link, and the reason in words;
  - **Compare with main** (or **with Live** when the open scenario is main, or no main exists):
    the Scenarios tab with `a=` and `b=` (`address.ts:150`) and the existing comparison;
  - **Run again…** and a disclosure "Its choices" in sentences ("From 17 Nov, 6 periods; tickets
    in progress kept; Bugs left out").
- **Change list rows** of origin `scheduler` (`PlanChangesPage.tsx:297` already says "Proposed by
  the auto-scheduler") gain the run's **why** sentence while the page holds the result, and a
  warning after "Note:", in words, never colour alone.
- **Timeline and Calendar:** a bar or chip whose draft is the auto-scheduler's says "Draft,
  auto-scheduled" in text, from `DraftMark.origin`, with stage 6's dashed edge. Dragging it says
  "Your draft now: a re-run will plan around it."
- **Capacity in the scenario** is unchanged code: its heading names the scenario and its loads
  include the drafted due days, which is how a person checks the fill.
- **Words** come from `scheduleWords.ts` (new, beside `changeWords.ts`), one sentence per reason
  and warning, for example: "Placed in 1 to 14 Dec: Atlas had 8 of 20 points free after 4
  higher-ranked tickets.", "Starts 9 Dec, the day after SPA-10 ends; SPA-10 blocks it.", "Placed
  early because it blocks SPA-3.", "Kept: your draft in this scenario.", "Kept: you may not
  schedule tickets in OPS.", "Not placed: no estimate.", "Not placed: Cirrus has no capacity set.",
  "Not placed: bigger than Atlas's 20 points in any period.", "Not placed: in a circle with SPA-3
  and SPA-4.", "Not placed: waits on a ticket this plan does not show you.", "Not placed: no room
  for Atlas up to 8 Feb.", "Note: due 9 days after its release 2.1 (1 Dec)."
- **Everywhere:** glass per ADR-114, strings under `schedule.*` in both catalogues
  (`pnpm i18n:check` clean, the `en-XA` test passing), 44 px targets under a coarse pointer, no
  sideways scrolling at 360 px, and stories with axe for the dialog (ready, not ready, re-run,
  running) and the panel, at phone width too. `scenarioClient.ts` gains `readiness()` and
  `schedule()` with `ScheduleReadiness` and `ScheduleResult`; `scenarioFixtures.ts` gains
  scheduler-origin changes and a result.

#### Events, audit and records

Each event is emitted in the run's transaction with the plan as its subject and is audited, as
`plan.*` events are; webhooks get none. Payloads hold ids, days and numbers, never names or query
text.

- `plan.drafts_set` (`events/catalogue.ts:1179`), unchanged in shape, with origin `scheduler`, in
  chunks of 1,000 entries.
- `plan.schedule_ran` (new): `{ scenarioId, created, from, periods, leftOut: { typeIds,
  releaseIds, query: boolean }, keep: { inProgress, inActiveSprint, query: boolean }, counts }`.
- `plan.scenario_created` when the run made the scenario, as `POST /scenarios` emits it.

The data download and erasure gain nothing: a run stores no row of its own, and the drafts are
stage 6's. A copy of a plan takes no drafts (stage 6 question 18).

#### Limits and performance

| Limit | Value | Refusal |
|---|---|---|
| Movable tickets a run places | 10,000 (`MAX_DRAFTED_TICKETS`) | `too_many_to_schedule` |
| Open tickets a run reads | 50,000 (PLN-001's plan) | `plan_too_large` |
| Periods a run looks ahead | 1 to 12 (Capacity's `MAX_PERIODS`), 6 by default | `invalid_fields` |
| Ticket types and releases left out | 20 each | `invalid_fields` |
| A query condition | 2,000 characters | `invalid_fields` |
| Drafted tickets in the scenario after a run | 10,000 | `too_many_drafts`, all rolled back |
| Scenarios, when the run makes one | 20 | `too_many_scenarios` |
| A run while an apply holds the scenario | 0 | `apply_in_progress` |
| Changes per `writeDrafts` call | 2,000 | |
| Entries per `plan.drafts_set` event | 1,000 | |
| Tickets listed in the answer | 2,000, the rest counted | |

Runs on one scenario take turns on its row lock, which is held only while writing. PLN-012's bar,
by `expectWithinBudget`: the engine alone on 10,000 tickets, 20,000 links, 50 teams, 300 people
and 12 periods under 300 ms (`plans/scheduler.large.test.ts`); a whole run over 10,000 tickets
under 5 s and readiness under 1 s (`plans.large.test.ts`). The engine is O((V + E) log V + V × P ×
S) for V tickets, E links, P periods and S subjects a ticket. Enforcing the budgets waits for the
user's 2026-11-14 hold on benchmarking.

#### Seams left for later stages

- The engine's input is plain data: sprints as buckets, velocity as capacity, Team values as
  subjects or working days change `scheduleInputs.ts` and the fit and days steps, not the route.
- A `sprint` draft kind still needs a migration widening 0110's field check, a sprint expression in
  `draftOverlay`, and a row in apply's mapping of fields to requests (`plan-scenarios.ts:1117-1119`)
  that calls `POST /sprints/:id/tickets`.
- A Team-value proposal writes `cf:<teamField>` drafts, which `writeDrafts` already takes.
- A stored report would be one table keyed by scenario, filled from the answer as it is.

#### What the manual says

When built, `docs/manual/use/multi-track.md` gains **Auto-scheduling**, linked from "Scenarios and
draft changes": what a run does and does not change; where its result goes; readiness; what it
keeps, leaves out and never moves; how it orders work, fills periods and starts a ticket after its
blockers; each reason in the app's words; release dates as a warning; that a re-run replaces only
its own proposals on tickets you are shown; and who may run it. "Not yet in plans" loses "The
auto-scheduler comes in a later version." and says what this stage leaves out, and `sources` stay
current.

#### Tests

PLN-004 as it should read when built: *Taskmoor shall let a plan's editors auto-schedule the
plan's open level-0 tickets they are shown into the plan's periods, as draft changes of start and
due days in a scenario: in rank order with blockers first; within the capacity set for each person
and plan team in the plan's unit, counting their other work as the Capacity view does; never
starting a ticket on or before the day a blocker of it ends; keeping the days of tickets a rule
keeps and leaving out the tickets a run leaves out; and saying of each ticket why it was placed,
kept or not placed, and which end after their target release. A plan gives no access: a run reads
only what its runner may see, and a blocker the runner may not see keeps the ticket where it is
without being named.* Acceptance: (1) with a capacity of 20 points in every period, 60 points of
ranked work fill three periods in rank order; (2) no ticket a run places starts on or before the
day a blocker of it ends, and a ticket whose blocker the runner may not see is not moved; (3)
tickets kept by a rule (a person's draft, may not be scheduled by the runner, in progress, in an
active sprint, or matching the run's keep condition) and tickets left out are not moved; (4) a
second run on unchanged tickets changes no draft, and every ticket a run does not place is listed
with its reason.

The spec's PLN-004 row and `requirements-index.csv` move to M1 with this wording; it drops
"velocity", "sprints" as the buckets and release dates as a limit (questions 1, 2 and 15).

- `plans/scheduler.test.ts` (new, pure), `[PLN-004]`: (1) six 10-point tickets, a team at 20
  points a period, land in periods 1, 1, 2, 2, 3, 3; 8, 7 and 5-point tickets keep rank order and
  leave room unused. (2) `[PLN-004] [PLN-006]`: a low-ranked blocker goes first and its blocked
  ticket starts the day after it ends; a kept dated blocker pushes; an undated one leaves the
  ticket not placed; a closed one holds nothing; a hidden one leaves the ticket not placed; a 2-,
  a 3-ticket circle and a self-link are `cycle`; a chain behind a blocker not placed. (3) kept and
  left-out tickets never appear among the placed. Each reason and warning has a case: `too_big`
  against `no_room`, the run's last period, a person in two teams loading both, a team's capacity
  from its members, a capacity of 0, a zero estimate, hundredths that would round wrongly as
  floats, rank strings that `localeCompare` would order differently. fast-check properties with
  `fc` from `@taskmoor/testkit/property`: (a) to (e) above, the shuffled input included. `isLate`
  against the web's `dependencyState` cases, from one shared table.
- `routes/plan-schedule.test.ts` (new; the harness of `plan-scenarios.test.ts:81-210`),
  `[PLN-004] [PLN-002]`: a run into a new scenario (made main when it is the first; a copy keeps
  origins) and into the open one; people's drafts kept and planned around; a re-run with changed
  capacity replaces and withdraws only scheduler drafts; a second run on unchanged tickets writes
  nothing and emits no `plan.drafts_set`; a proposal over an earlier one takes the live value when
  drafted; a ticket changed between the read and the write is `changedMeanwhile`; applying
  scheduler drafts through stage 6, with `refusalOf` unchanged; 2,500 placed tickets written in
  chunks. `[PLN-004] [PLN-005]`: after a run, `GET .../capacity?scenario=` as the runner has no
  cell over that the run filled, with work elsewhere and closed work in the periods.
  `[PLN-004] [PLN-006]`: after a run, the Timeline with `scenario=` has no late link between
  placed tickets. `[PLN-004] [QRY-008]`: four viewers with sentinel keys, summaries and days on
  hidden tickets and a hidden blocker, which appear in no answer and shape no day; readiness counts
  only the reader's tickets; a second editor who sees less leaves the hidden proposals, counted.
  Refusals: 403 `edit_plan`, 404 word for word, `too_many_scenarios`, `apply_in_progress`,
  `too_many_to_schedule`, `plan_too_large`, `too_many_drafts` rolled back, `invalid_query`, a
  ticket the runner may not schedule kept.
- `routes/plan-capacity.test.ts`, `routes/plan-scenarios.test.ts` and
  `routes/plan-dependencies.test.ts` pass unchanged after the moves; `plan-scenarios.test.ts` adds
  a change list and `draftMarks` that say `scheduler`.
- `scopes.test.ts`, `[IAM-007]`: the two routes' classes. `contract.test.ts`, `[AUT-010]`:
  `plan.schedule_ran` and a scheduler-origin `plan.drafts_set`. `audit/subscriber.test.ts`:
  `plan.schedule_ran` audited. `plans.large.test.ts` and `plans/scheduler.large.test.ts`: the
  budgets above.
- Web: `AutoScheduleDialog.test.tsx` (readiness sentences, Run off with its reason, choices sent,
  the re-run notice, the running status, a sheet with `setViewportWidth()` at 360),
  `ScheduleResult.test.tsx` (counts in words, filters, focus, compare link), `scheduleWords.test.ts`
  (every reason and warning in both catalogues), additions to `PlanChanges.test.tsx` (the why line),
  `ScenarioBar.test.tsx` (the button for editors only), `TimelineView.test.tsx` ("Draft,
  auto-scheduled"); stories with axe.
- e2e `plan-schedule.spec.ts`, desktop and phone: run into a new scenario, read the result, open
  the Timeline, drag one bar, run again and see that bar kept, compare with main, make main, apply
  three; the Not placed list with a reason.

#### Asked by the spec or nearby, not built here

- Velocity from history (decisions.csv keeps it for 2.0, T-089j), and capacity in days.
- Sprints as the buckets, other boards' sprints, and drafting sprint membership, Team values,
  assignees or rank.
- Backfilling room an earlier ticket left, splitting a ticket across periods, keeping a ticket's
  own length, working days and holidays.
- Release dates as a hard limit, and section 1's warning "ticket outside its sprint or release
  dates" on the Timeline; the run's `after_release` covers only its own placements.
- Exclusion rules and "Keep its dates" stored on the plan, and a stored report of the last run.
- Running by itself when capacity changes (stage 3's note), as a background job, or on a schedule.
- Discarding only the auto-scheduler's drafts in one action; a re-run, or Discard, does it.
- Resource levelling and saved snapshots of dates (PLN-011, T-089a).

#### As built (T-089f)

Built on 2026-11-14 in `plans/scheduler.ts` (the engine), `plans/scheduleInputs.ts` (its reads),
`routes/plan-schedule.ts`, the moves of "Shared code" (`plans/capacity.ts`, `plans/drafts.ts`,
`plans/dependencies.ts`, `plans/sprints.ts`), and on the web `AutoScheduleDialog.tsx`,
`ScheduleResult.tsx`, `scheduleWords.ts`, `scenarioClient.ts`, `ScenarioBar.tsx`,
`PlanScenariosPage.tsx`, `PlanChangesPage.tsx`, `PlanPage.tsx`, `TimelineView.tsx` and
`CalendarView.tsx`, with the manual's "Auto-scheduling" section. No migration. Where this differs
from the design above, or settles what it left open:

- **The engine's input** is plain data: `ScheduleInput { from, periods, tickets, links, teams,
  people, leaveOut: { typeIds, releaseIds }, keep: { inProgress, inActiveSprint } }`. The two
  queries arrive as per-ticket flags (`leftOutByQuery`, `keptByQuery`), and a blocker outside the
  plan or hidden from the runner only as `hiddenBlocker`. A person's `load` is Capacity's count for
  the scenario less every ticket passed; the engine adds those back at their due days. A blank
  query is no query.
- **Rounding:** the engine's `hundredths` rounds half up from the decimal (1.005 gives 101), so
  floats decide no fit. Capacity's own `round`, moved unchanged to `plans/capacity.ts`, is still
  `Math.round(n * 100) / 100` for what the Capacity tab shows.
- **Choices the design left open:** the effective rank passes only through movable tickets, and
  the members of a circle share their best rank; circles are found over every link between open
  tickets the runner is shown, kept ones included. A placed ticket's reason is the first of
  `already`, `after_blocker`, `after_higher_ranked`, `first_for_blocked` and `fits`. When a team
  and its member tie, a reason names the team; `no_room` names the subject with the least room
  left over the periods it could use; `no_capacity` names the assignee's plan teams.
- **Ids, not keys, in `args`:** `cycle` names up to five other members by id with the circle's
  `size`, and `late_against_kept` is one warning a ticket with up to five ids and a count. The page
  says the keys of tickets the answer lists and "another ticket" for the rest, so nothing hidden is
  named.
- **`over_where_kept`** goes to any ticket the run could not place (`no_room` or
  `blocker_not_placed`) whose load, at its due day, takes a cell over capacity after placed work
  went into that cell.
- **Left-out tickets** are counted by reason (`level`, `type`, `release`, `query`), never listed.
- **The answer's counts:** `placed` counts the tickets whose proposal now stands, so those changed
  meanwhile are not in it; `unchanged` those whose drafts the run did not touch; `withdrawn`
  those whose earlier proposal went entirely; `notShown` distinct tickets with scheduler drafts the
  runner is not shown. A listed ticket left out of the write carries `changedMeanwhile: true`.
  `too_many_to_schedule` is checked after the engine (it takes about 0.1 s), from its counts.
- **An earlier proposal stays on any ticket a person drafted a day of** under the lock, not only on
  those kept for `person_draft` (a ticket left out by the run can have one). Since the review this
  arises only from drafts written before it: a person's day draft takes over the ticket's other
  day (below).
- **Changed meanwhile, with what follows it** (review): under the lock the run also reads again
  the blockers of the tickets it places, and leaves out of the write every proposal placed after a
  ticket that changed meanwhile, directly or through other proposals, so no late link is written.
  `changedMeanwhile` counts all of them, and the page lists them apart from the placed. A
  changed ticket's load can still sit in a cell the run filled, until the next run.
- **The answer's scenario** is read inside the run's transaction, under its lock, so it is never
  null.
- **Refusals:** a query that does not compile answers 400 `{ error: 'invalid_fields', fields:
  { 'keep.query' | 'leaveOut.query': 'invalid_query' }, messages }`; `into.newScenario.from` of
  another plan answers 400 `{ 'into.newScenario.from': 'not_found' }`; readiness with `scenario=`
  missing or of another plan answers 404 word for word as a missing id, as a run into one does
  (built as 400 at first; fixed in review). The open tickets are counted first, with `LIMIT
  50,001`, before `plan_too_large`.
- **Drafts:** `clearSchedulerDrafts` also clears the refusal of a ticket that lost a draft, as
  `writeDrafts` does; `createScenario` returns `main` too; `MAX_DRAFT_WRITE` (2,000) is the chunk
  size. `sprintDay` and `inActiveSprint` read the ticket as `k`.
- **A dragged proposal:** a person who moves one end of a proposed bar resends the other day
  unchanged, or does not send it (the Calendar's start chip). `writeDrafts` with origin `person`
  therefore turns the auto-scheduler's drafts of the days of every ticket a person drafts a day of
  into the person's (fixed in review: before, the run read only the moved day while the scenario
  kept the scheduler's other one, so what it blocked could be placed before it ended, and the bar
  said "Draft, auto-scheduled" beside "Your draft now"). The change emits nothing more: the values
  do not change.
- **The web app:** the dialog remembers its choices per plan in `localStorage`
  (`taskmoor.autoSchedule.<planId>`), apart from the first day and the target; it is the target
  "This scenario" by default only when the plan holds 20 scenarios. Escape does not close it while
  a run works. "Its choices" is built from the request the dialog sent, never read back from
  storage, and names the types and releases left out. The lists count and remember only what
  readiness still offers. Run is off until readiness answers for the choices as they are, and
  says it is running with `aria-disabled`, keeping the focus; a refusal naming a field moves the
  focus there. The result is kept per scenario while the plan page is open. Readiness sends
  `types` (of the reader's open level-0 tickets, at most 200) and `releases` (those they target,
  neither shipped nor archived, of tracks the reader browses, as the views show releases); a run's
  answer sends `names` (the plan's teams, people and releases its reasons name, and the keys of
  tickets named but not listed). `ScheduleEntry.summary` is still not sent, so result rows show
  keys without summaries.
- **Words:** the panel says "N drafts people made stay" and a kept ticket "Kept: a person drafted
  its days in this scenario.": scenarios are shared, so the drafts are anyone's (review).
- **Measured** on this machine, budgets not enforced (the user's hold on benchmarking): the engine
  alone on 10,000 tickets, 20,000 links, 50 teams, 300 people and 12 periods, 87 ms; readiness's
  median 26 ms and a whole run over 10,000 tickets 503 ms (`plans.large.test.ts`). At the 100,000
  size the whole plan is refused with `plan_too_large` before the engine (the open tickets are
  counted first), so the case then measures a run over nine of the tracks, 45,000 tickets, which
  ends in `too_many_to_schedule`; not yet run at that size.
- **The e2e** departs from "Tests": the run makes the plan's first scenario, Proposal, so it is
  main from the start; the result compares it with Live and nobody makes a scenario main. Both runs
  set **Schedule from** to the day the fixture computed, so a test that crosses midnight still
  plans the weeks it checks.

#### Questions for the user (the design takes the first answer each time)

1. **What a run fills:** the plan's periods, with the capacity set on the Capacity tab (PLN-004
   says sprints and is reworded); or the sprints of each team's Scrum board (`board.team_id`), with
   capacity per sprint; or both, chosen per run.
2. **Velocity** (PLN-004 says "capacity or velocity"; velocity from history went to 2.0, T-089j):
   capacity only, and PLN-004 drops the word; or a board's velocity where a team has no capacity
   set; or reopen velocity for 1.0.
3. **What a run drafts in 1.0:** start and due days only; or the Team value too; or sprint
   membership too (a migration, applied through the sprint route).
4. **What keeps a ticket's days:** rules per run (a person's draft, may not be scheduled by the
   runner, in progress, in an active sprint, a keep query); or a "Keep its dates" mark per plan
   (a migration); or a shared checkbox field named "Fixed dates"; or a label.
5. **Which tickets a run may move:** every open level-0 ticket not kept or left out, dated or
   not; or only tickets without days.
6. **Which levels:** level 0 only, parents rolling up; or levels chosen per run; or every level.
7. **Whose capacity a ticket uses:** its assignee's and every plan team's the assignee is in, as
   the Capacity tab counts; or its Team value's team, as program boards place it; or the Team value
   when set, else the assignee's teams.
8. **Tickets without an estimate:** not placed, with the reason; or a default size chosen per run;
   or placed with no load.
9. **Tickets without an assignee:** not placed, with the reason; or placed by a chosen Team field
   (Capacity would then need loads by Team value).
10. **People's work elsewhere:** counted by whole weeks, as the Capacity tab does; or not counted.
11. **Order:** rank, with a blocker pulled forward to the best rank it holds up; or strict rank
    (a low-ranked blocker waits its turn, and what it blocks with it); or the earliest target
    release first, then rank.
12. **Room an earlier ticket could not use:** stays unused, so each person's and team's work lands
    in rank order; or a smaller, lower-ranked ticket may fill it.
13. **The days a placed ticket gets:** start as early as allowed in its period, due on the
    period's last day; or its own length, ending on the period's last day; or a share of the
    period sized by its estimate, after the work before it.
14. **A blocker the runner may not see:** the ticket is not placed, with a reason naming nothing;
    or the ticket is placed as if it had no blocker.
15. **Target release dates:** a warning on tickets proposed after them; or a limit, leaving a
    ticket that cannot make its date not placed; or ignored.
16. **Where a run writes:** a new scenario by default, or the one open; or always a new one; or
    always main.
17. **A re-run:** replaces only the auto-scheduler's own proposals on tickets the runner is shown,
    keeping people's drafts and planning around them; or replaces every draft in the scenario.
18. **The run's report:** in its answer, kept on the page while the plan is open; or stored with
    the scenario (a migration), so its reasons show later and to others.
19. **A run's choices:** made per run, the dialog starting from the last ones used in this browser;
    or stored per plan (a migration) and shared.
20. **How far a run looks:** 6 periods by default, at most 12, one Capacity view; or more.
21. **Which days count:** calendar days, as the rest of plans; or working days.
22. **Who may run it:** the plan's owner and site administrators, who draft today; or everyone who
    sees the plan, into a scenario of their own.
23. **Its name:** "Auto-schedule"; or "Schedule work"; or "Suggest dates".
24. **A runner who sees more than the plan's other viewers** (asked after the build, 2026-11-14):
    their proposals may start the day after a blocker the others cannot see, as built; or a run
    treats as hidden every blocker some viewer of the plan may not see (fewer placements, and the
    plan's viewers read on every run); or the proposals record what their runner saw and other
    viewers see them only as a count.

### Stage 9 (T-089a): baselines, the critical path and levelling

**Designed on 2026-11-14; built the same day (see "As built (stage 9)" below for where the build
differs).**
PLN-011 moves to M1 with this stage, as a Must, reworded to what will be built (the wording is
under "Tests"); the user brought it into 1.0 on 2026-11-13 (`docs/plan/decisions.csv`, "Hierarchy
grid and baselines"). The new wording narrows the spec's in five ways: delay and slack are counted
in calendar days (question 10); a baseline holds own and sprint days, never roll-ups, and each
reader sees only their share of it (questions 7 and 15); "fixed-date tickets" are the tickets the
auto-scheduler's keep rules hold (question 3); levelling moves only level-0 tickets, later, by the
plan's periods as Capacity counts them (questions 2, 4 and 6); and its output is draft changes in a
scenario, never live tickets (question 2). Two designs were made for this stage and judged against
the spec, privacy, the earlier stages and the code. This one takes the smaller one's storage and its
"a mode of the auto-scheduler" (one migration, two tables; stage 7's route, reads, keep rules and
writer reused), and grafts in the larger one's safer pieces: the critical path computed on the
server over the whole plan (`unfiltered`), never over the view's filters, so a filter cannot change
the plan's end; a separate pure engine beside `schedule()`, which shares only the sorting of
tickets and the graph code, so the fill rules are not touched; a move undone as a whole when a push
would reach a ticket that may not move; and the promise "every cell within capacity, or reported",
which holds where "no cell becomes over" did not. The questions at the end are the user's; the
design takes the first answer each time.

A **baseline** is a named, frozen copy of the days of a plan's tickets at one moment: for each
ticket its capturer is shown, its own start and due days, or else its sprint's days, and which of
the two it was. It is taken from the tickets as they are (**Live**) or from a scenario. **Delay** is
a ticket's end now less its end in the baseline, in calendar days; a ticket has **slipped** when its
delay is above 0. A ticket's **end** is read by the one bar rule: its due day, else its start day,
else its sprint's end (`barDays`, `apps/server/src/plans/scheduler.ts:273`, the server's twin of
the web's `barOf`). **Slack** is how many days a ticket's end can move later before the plan's end
moves or one of its dependencies becomes late; the **critical path** is the open dated tickets
with slack of 0 or less. **Evening out load** (levelling, in the spec and in this record) is a
second kind of auto-schedule run: it moves only the tickets that put a person or team over capacity
in a period, later, by as little as it can, each keeping its own length, and never moves a ticket a
keep rule holds.

**On the words:** the interface says **Baseline**, **Capture baseline**, **Compare with
baseline**, "N days later", "N days earlier", **Critical path**, **slack**, **Even out load** and
"moved later" (question 1). It never says "level", "levelling", "resource levelling",
"optimise", "AI" or "Gantt": "level" already names a hierarchy level in Taskmoor
(`docs/specs/00-terminology.md`), which is also why stage 7 avoided it. Stage 6 kept "baseline" out
of its interface so that this stage could use it (stage 6, "On the words"); this stage uses it only
for stored copies of days, never for the main scenario.

#### What is stored (migration: the next free number, 0111 today)

One migration, numbered when built: the next free number, claimed in `COORDINATION.md` Messages
first (0111 on `main` at 91a354b0; the Mac's next would also be 0111, so the claim decides). The
critical path and evening out store nothing.

- **`plan_baseline` (new):** `id` serial; `workspace_id`; `plan_id` references `plan` ON DELETE
  CASCADE; `name` text, 1 to 100 characters; `source` text CHECK IN (`'live'`, `'scenario'`);
  `scenario_name` text NULL, the scenario's name copied at capture so the list can say "from
  Faster" after it is renamed or gone (NULL exactly when `source` is `'live'`); `tickets` int, how
  many rows it holds; `created_by` references `app_user` NOT NULL; `created_at` timestamptz;
  `updated_at` timestamptz; `version` int. A unique index on `(plan_id, id)`, as
  `plan_scenario_plan_idx` (`0110_plan_scenarios.ts:33`), and an index on `created_by`.
- **`plan_baseline_day` (new):** `workspace_id`; `plan_id`; `baseline_id`; `ticket_id` references
  `ticket` ON DELETE CASCADE; `start_date` date NULL; `due_date` date NULL; `dated` text NULL CHECK
  IN (`'own'`, `'sprint'`), NULL exactly when both days are; `closed` boolean. PRIMARY KEY
  `(baseline_id, ticket_id)`, a foreign key `(plan_id, baseline_id)` to `plan_baseline (plan_id,
  id)` ON DELETE CASCADE, and an index on `ticket_id`, for a ticket's purge.
- A row is kept for **every** ticket of the plan the capturer is shown, at every level, closed
  ones included, dated or not, so a comparison can tell a ticket added since from one that had no
  days then. Keys, summaries and roll-ups are never stored.
- In the same change: the table types in `packages/db/src/schema.ts`, the schema golden file, and
  a row of each in `packages/db/src/upgrade-fixtures.ts`.
- **The data download** (`apps/server/src/privacy/export.ts`, beside `plan_scenario` at `:390`)
  gains `planBaselines`: the baselines a person captured, as id, plan id, name, source and time,
  without days, since the plan or its tickets may be hidden from them now, as for scenarios.
  **Erasure rewrites nothing:** `created_by` keeps the account's id, which then names the
  placeholder, as `plan_scenario.created_by` does (stage 6, "Events, audit and records").
- **A copy of a plan** (`POST /plans/:id/duplicate`, `routes/plans.ts:538`) takes no baselines, as
  it takes no scenarios (question 14). A deleted plan takes its baselines with it.

#### Routes and token scopes

All are internal in the API document (`x-taskmoor-stability: internal`), and scopes follow the
method. A plan the person may not see, and a baseline or scenario of another plan, answer 404 word
for word as a missing id. Writes are for the plan's editors, its owner and site administrators;
anyone else gets `forbidden` with `edit_plan`. That rule is written three times today
(`mayManage`, `routes/plans.ts:191`; the write check of `opened()`, `routes/plan-scenarios.ts:235`;
`editable` in `visiblePlan`, `routes/plan-schedule.ts:322`). The first stage built lifts it into one
`planEditable(request, ownerId)` in a new `apps/server/src/plans/access.ts`, which the three then
call (moved, not changed). The baseline routes live in a new `apps/server/src/routes/plan-baselines.ts`,
registered beside `registerPlanScenarioRoutes` (`app.ts:612`).

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/plans/:id/baselines` | read | Anyone who sees the plan: `{ baselines: [{ id, name, source, scenarioName, tickets, createdAt, createdBy: { id, name }, version }], editable, limits }`, newest first |
| `POST /api/v1/plans/:id/baselines` | write | `{ name, scenarioId? }`; 201 with the baseline |
| `PATCH /api/v1/plans/:id/baselines/:bid` | write | `{ name, version }`; renames |
| `DELETE /api/v1/plans/:id/baselines/:bid?version=` | write | Deletes it and its rows |
| `GET /api/v1/plans/:id/baselines/:bid/compare?scenario=&<plan filters>&show=&after=` | read | The comparison, below |
| `GET /api/v1/plans/:id/critical-path?scenario=&<plan filters>` | read | The path, in "The critical path" below; in `routes/plan-views.ts` |
| `GET /api/v1/plans/:id/schedule` and `POST /api/v1/plans/:id/schedule` | read, write | Stage 7's, with `mode` (see "Evening out load") |

**Refusals:** 400 `invalid_fields` (a name out of bounds; `scenarioId` missing or of another plan:
`{ scenarioId: 'not_found' }`; a bad filter, `show` or cursor); 409 `too_many_baselines { limit:
10 }`, `plan_too_large { limit: 50000 }` (the plan's tickets are counted first with `LIMIT
50,001`) and `version_conflict`; 404 as above; a search that runs too long answers as
`searchRefusal` (`routes/search.ts:102`) does, 503 `query_timeout`.

#### Capturing a baseline

One transaction, under `lockPlan` (`plans/drafts.ts:451`), so two captures take turns and the
limit of 10 holds:

1. The plan's tickets for the capturer are counted through `planTickets(...)` and its `unfiltered`
   condition (`plans/query.ts:244`): the whole plan as they are shown it, never the views' filters,
   never the trash. More than 50,000 refuse with `plan_too_large`.
2. One `INSERT INTO plan_baseline_day ... SELECT` over `ticket k` WHERE that condition, with the
   days through `draftOverlay(scenarioId, unfiltered)` (`plans/drafts.ts:219`) when a scenario is
   named, else the live `start_date` and `due_date`, and the sprint's days through `sprintDay`
   (`plans/sprints.ts:14`) for a ticket with no day of its own, `dated` saying which. `closed` is
   `status.stage = 'closed'`. It is a single statement, so Postgres's limit on bound values does not
   apply, as it does to stage 7's draft writes.
3. `plan.baseline_captured` is emitted.

The name is prefilled on the page ("Baseline 14 Nov"); names need not be unique.

#### Comparing (acceptance 1)

`GET .../baselines/:bid/compare` is a sibling of stage 6's `GET /plans/:id/compare`
(`routes/plan-scenarios.ts:1189`) and is built from the same pieces: `shownTo` (`:214`) with the
page's filters, `viewScenario` (`:146`) for `scenario=`, and `draftOverlay` for the days now. It is
one read-only statement (`readOnly`, `search/run.ts:208`) over the reader's plan tickets (`where`:
the plan with the page's filters) LEFT JOIN `plan_baseline_day` on its primary key, plus one count
of the baseline's rows whose ticket is not in the reader's `unfiltered` plan.

- **The answer:** `{ baseline: { id, name, source, scenarioName, createdAt }, against: 'live' |
  { scenario }, counts, planEnd, tickets, next }`.
- **`counts`:** `compared` (dated on both sides), `slipped` (delay above 0), `earlier`, `same`,
  `addedSince` (no row in the baseline), `undatedThen` (a row without days), `undatedNow` (days
  then, none now), and `notShown`: rows whose ticket the reader is not shown in the plan now,
  hidden or gone from the plan, as one number that never says which (decisions row 134). Tickets
  the page's filters leave out are simply not compared.
- **`planEnd`:** `{ then, now, delay }`, the latest end on each side over the tickets compared.
- **`tickets`:** 200 a page, `show=slipped` (the default), `earlier`, `added` or `all`, ordered by
  delay, largest first, then rank and id; each `{ id, key, summary, level, closed, then: { start,
  due, dated }, now: { start, due, dated }, delay, startShift }`, where `startShift` is the start's
  difference in days. `next` is an opaque cursor.
- Delay is `dayNumber(end now) − dayNumber(end then)` (`plans/periods.ts:17`), the same for open
  and closed tickets; a closed one is marked (question 10).

#### The critical path

A new pure function, `criticalPath(input)`, in a new `apps/server/src/plans/criticalPath.ts`, with
no database: `input = { tickets: { id, start, end }[] (day numbers), links: { from, to }[] }`;
answer `{ planEnd, slack: Map<id, number>, critical: id[], chains: id[][], cycles: id[] }`.

1. **What it runs over:** the plan's open tickets the viewer is shown (`unfiltered`, never the
   page's filters), at any level, with a bar of their own or of their sprint, read with the
   scenario's days when `scenario=` is set. Closed tickets are left out and constrain nothing, as in
   stage 7. A parent dated only by its children's roll-up is not on the path; its children are.
2. **Links:** `blockingLinks(trx, ws, ids, options)` (`plans/dependencies.ts:87`): blocking links
   and the types the plan chose (`dependencyOptions`, `:47`), one per pair, the source finishing
   first. A link from a ticket outside that set is dropped: a closed blocker holds nothing, and a
   blocker outside the plan or hidden from the viewer is counted on the route (`waitsElsewhere`),
   never named.
3. **Plan end:** the latest end among the tickets read.
4. **Slack**, in reverse topological order: a ticket's latest end is the least of the plan's end
   and, for each ticket it blocks, that ticket's latest start less one day; its slack is its latest
   end less its end, where a ticket's latest start is its latest end less its length. Negative
   slack means a dependency on that chain is already late, which the Timeline already shows (PLN-006).
5. **Circles:** strongly connected components (`stronglyConnected`, below); members of a circle
   get no slack and are counted in `cycles`, with words.
6. **Chains:** the critical tickets joined through the links where the gap equals the difference
   of their slack, each listed from its first ticket to the one at the end, the longest first.

**The route** `GET /api/v1/plans/:id/critical-path?scenario=&<plan filters>` (in
`routes/plan-views.ts`, for anyone who sees the plan) reads the open tickets in one statement
(`plan_too_large` above 50,000, `MAX_OPEN_READ`, `scheduler.ts:30`), runs the engine, and answers
`{ planEnd, chains: [{ tickets: [{ id, key, summary, start, end, slack }] }] (500 tickets at most,
the rest counted in more), counts: { critical, cycles, undated, waitsElsewhere }, listed: [{ id,
slack }] }`. `listed` gives the slack of the tickets the Timeline lists with the same filters (its
first 10,000 by rank, `LISTED`, `plans/model.ts:20`), so the page marks its own bars while the path
belongs to the whole plan. Two viewers who are shown different tickets can get different paths, a
different plan end and different slack; the page says the path covers "the tickets this plan shows
you".

#### Evening out load (levelling)

**A mode of stage 7's run, with an engine of its own** (question 2). `scheduleBody`
(`scheduler.ts:50`) gains `mode: 'fill' | 'even_out'`, `'fill'` by default, so every existing
caller is unchanged. Reused as they are: the route `POST /api/v1/plans/:id/schedule` and its
readiness `GET`, `readScheduleInputs` and `readReadiness` (`plans/scheduleInputs.ts`: capacity,
load, `maySchedule`, `hiddenBlocker`, people's drafts through `draftOverlay(..., { origin: 'person'
})`), the leave-out and keep choices, the whole write path (`createScenario`, `lockScenario`, the
re-read under the lock, the diff, `writeDrafts` with origin `scheduler` in chunks of
`MAX_DRAFT_WRITE`, `clearSchedulerDrafts`, `TooManyDrafts`, `plan.drafts_set`), and stage 6's
preview, compare, make main, apply and discard. **No migration:** 0110's origin check already
allows `scheduler` (`0110_plan_scenarios.ts:47`). Not reused: the fill loop in `schedule()`
(`scheduler.ts:342`), which re-places every movable ticket from the first day, drops each
ticket's own length and keeps a cursor per subject. Evening out wants the opposite (move the
fewest, by the least, keeping length), and a mode flag inside that loop would tangle two rule sets
that each have their own property tests.

The engine is a new pure function, `evenOut(input: ScheduleInput): ScheduleOutput`, in a new
`apps/server/src/plans/evenOut.ts`, with stage 7's input and output shapes. The rules, in the order
a person can follow:

1. **Sort the tickets** with `classify` (stage 7's classes, below). **Fixed-date tickets** are the
   kept ones: a person's draft, may not be scheduled by the runner, the keep query, in progress, in
   an active sprint (question 3). Closed and left-out tickets never move, and no level but 0.
   A movable ticket in a circle, or with a blocker the runner is not shown (`hiddenBlocker`), does
   not move either (`cycle`, `hidden_blocker`), as in stage 7. A movable ticket with no due day
   carries no load in any period (Capacity counts it as unscheduled, `plan-capacity.ts:241`), so
   it is never a candidate.
2. **Start where things are:** each subject's load per period is `person.load` plus every ticket
   passed, at the period of its due day: the numbers the Capacity tab shows for the scenario. A cell
   (a subject in a period of the run) is **over** when a capacity is set there and the load is above
   it (`over: limit !== null && load > limit`, `plan-capacity.ts:285`).
3. **Order of work:** over cells in period order, then teams before people, then by id.
4. **Candidates** in an over cell: movable tickets due in that period that carry that subject, with
   an estimate above 0, **lowest-ranked first** (rank by UTF-16 code unit, descending, then id,
   descending) (question 4). They are taken one at a time until the cell fits.
5. **One move:** the first later period `q` of the run where every capped subject of the ticket
   has load + estimate ≤ capacity. Both days shift by `q`'s first day less the due day, the least
   shift that puts the due day in `q`, so the ticket keeps its length (question 6). Its load leaves
   the cell and enters `q`.
6. **What it blocks:** each ticket it blocks that would now start on or before its new end
   (`isLate`, `scheduler.ts:265`) is pushed later by the least amount (new start = blocker's end +
   1, its length kept), along the chain in topological order, its load moving with it. If a push
   would reach a ticket that may not move (kept, left out and open, in a circle, sprint-dated
   without days of its own) or would take any ticket past the run's last day, the whole move is
   undone, the candidate gets `would_make_late`, naming that ticket when the runner is shown it, and
   the next candidate is tried (question 5). A pushed ticket's new cell is checked when that cell's
   turn comes: pushes land only after the period being worked on, so the order of rule 3 reaches
   them.
7. **No room:** a cell with no candidate left that can move stays over. Its remaining candidates
   get `still_over`; the cell is listed in `overLeft: [{ subject, periodStart, over }]` with
   `only_fixed` when every ticket in it is fixed.

**Reasons** (added to stage 7's lists, `scheduler.ts:165-192`, with a sentence each in
`scheduleWords.ts` in both catalogues and the contract scenario updated): placed `moved_off_over`
`{ subject, fromPeriod, days }` and `pushed_by_move` `{ blockerId, days }`; not placed `still_over`
and `would_make_late` `{ ticketId? }`; `ScheduleOutput` gains an optional `overLeft`. Every other
movable ticket is placed with `already`, so nothing is drafted for it, and the writer's diff removes
an earlier auto-scheduler proposal on it, as a re-run does. A fill run and an even-out run in the
same scenario therefore replace each other's proposals, and both start from live days plus people's
drafts, never from an earlier run's result; the dialog and the manual say so.

**What the rules promise** (fast-check properties in `plans/evenOut.test.ts`):

- (a) No kept, closed or left-out ticket, and no ticket of another level, gets a draft
  (acceptance 2).
- (b) No ticket moves earlier, and each moved ticket keeps its length.
- (c) No link between tickets in the input that was not late before is late after.
- (d) After the run every cell of the run is within capacity, or is listed in `overLeft`
  (acceptance 3).
- (e) The output does not depend on the order of the input, and a second run on its own output
  changes nothing.
- (f) A plan with no over cell gets no draft.

Termination: moves and pushes only go later, never past the run's last day, and cells are visited
once in period order, so each ticket moves at most once per period of the run.

**Readiness** gains `overCells`, how many cells of the run are over now, over the reader's
tickets. `plan.schedule_ran` gains `mode` and `overLeft` (a count).

#### Shared code (moved, not changed)

These moves keep behaviour as it is; stage 7's tests and golden files prove it by passing
unchanged.

- **`apps/server/src/plans/graph.ts` (new):** `stronglyConnected(n, out)`, Tarjan's components
  lifted from inside `schedule()` (`scheduler.ts:493-544`), and the `Heap` class (`:299`).
  `schedule()`, `evenOut()` and `criticalPath()` import them.
- **`classify(input)`**, exported from `scheduler.ts`: the `klass` mapping at `:444-458`, which
  `schedule()` then calls. The arrays of load and capacity and `addLoadAtDue` (`:476`) stay inside
  `schedule()`: they hold changing state, and `evenOut()` keeps its own.
- **`apps/server/src/plans/access.ts` (new):** `planEditable`, above.

#### Who sees what

- **A baseline holds only what its capturer was shown,** and a reader sees its days only on
  tickets the plan shows them now: every read joins the baseline's rows to the reader's
  `where`/`unfiltered`, never the reverse. For a baseline from Live those days are ones the
  ticket's history already tells anyone who sees the ticket; for one from a scenario they are
  drafted days, which stage 6 already shows to every viewer of the plan on tickets they are shown.
  So a reader learns nothing about a ticket they may see that the plan did not already tell them.
- **Roll-ups are never stored,** because a stored roll-up would carry the capturer's hidden
  descendants to another reader.
- **Rows on tickets a reader is not shown** are one count, `notShown`, never keyed or dated.
- **The critical path** runs only through tickets the viewer is shown, and blockers it may not see
  are only counted. Its plan end and slack are the viewer's.
- **Evening out** follows stage 7's rules, including its question 24: a runner who sees more can
  push a ticket after a blocker others cannot see. Moving a ticket later never makes its own
  hidden blocker's link late; a hidden ticket it blocks may become late without the runner
  knowing, and the manual says so.

#### The pages, on a desktop and on a phone

- **A Baselines section** (a new `{ id: 'baselines', path: '/baselines', labelId:
  'plans.section.baselines' }` in `PLAN_SECTIONS`, `apps/web/src/plans/address.ts:5`, after
  Scenarios), `PlanBaselinesPage.tsx` (new): the list (name, "from Live" or "from Faster", who and
  when); **Capture baseline…** for editors, a dialog with the name prefilled and the source, "What
  the Timeline shows now: Live" or the open scenario; rename and delete (`shell/DangerAction`).
  At 10 the button is off, with the reason in words.
- **The comparison** (`BaselineCompare.tsx`, new, laid out as `ScenarioCompare.tsx`), opened from
  the list and kept in the address (`baseline=`, with `scenario=` and the filters): a sentence first,
  "12 tickets end later than in Kick-off, by up to 14 days; 3 earlier; 40 the same. The plan ends 9
  days later (21 Feb, was 12 Feb). 4 tickets in this baseline are not shown to you."; then filter
  buttons with `aria-pressed` (**Later**, **Earlier**, **Added since**, **All**) and a list, never
  a table at phone width: key and summary as a link, "9 days later: due 21 Feb, was 12 Feb",
  "(closed)" where it is. **Show more** pages; **Download CSV** goes through `planExport.ts` and
  `packages/webconfig/src/csv.ts`.
- **The Timeline** (`TimelineView.tsx`): a **Critical path** toggle among its tools
  (`critical=1` in the address, so a link keeps it). Critical bars get a heavy outline and a
  marker shape, never colour alone, and their description says "On the critical path"; other bars
  say "N days of slack". A tight link between two critical tickets is drawn heavier in the SVG
  overlay. A legend entry (`legendEntries`, `:973`). `CriticalPathList.tsx` (new, beside
  `DependencyList.tsx`) gives the chains in words for the keyboard, screen readers and phones:
  "SPA-3 ends 4 Dec, then SPA-7 starts 5 Dec … ends 12 Feb, the plan's end." The image
  (`planImage.ts`) draws the same outline when the toggle is on, and the Timeline's CSV gains
  "Slack (days)" and "Critical" (stage 8: the two drawings stay in step).
- **The auto-schedule dialog** (`AutoScheduleDialog.tsx`): a radio group **What the run does**:
  **Place work in rank order** (the default, stage 7) or **Even out load** ("Moves only work that
  puts someone over capacity, later, by as little as it can, keeping each ticket's length."). The
  keep choices are headed "Kept tickets never move (fixed dates)". Readiness adds "4 periods are
  over capacity now." `ScheduleResult.tsx` and `scheduleWords.ts` gain sentences: "Moved 2 weeks
  later, from 1–14 Dec to 15–28 Dec: Atlas was 6 points over.", "Moved 3 days later after SPA-10,
  which was moved.", "Not moved: moving it would make kept SPA-4 late.", "Still over: no room for
  Atlas up to 8 Feb." and the over-left list.
- **Everywhere:** glass per ADR-114, strings under `baselines.*`, `critical.*` and
  `schedule.evenOut.*` in both catalogues (`pnpm i18n:check` clean), 44 px targets under a coarse
  pointer, no sideways scrolling at 360 px, a sheet for each dialog on a phone, and stories with
  axe in both skins.

#### Events, audit and records

Each is emitted in its transaction with the plan as subject and is audited, as `plan.*` events
are; webhooks get none. Payloads hold ids and counts, never names, days or keys.

- `plan.baseline_captured` `{ baselineId, source, tickets }`, `plan.baseline_renamed`
  `{ baselineId }`, `plan.baseline_deleted` `{ baselineId }` (new, in `events/catalogue.ts`).
- `plan.schedule_ran` gains `mode` and `overLeft`.
- Comparing and the critical path are reads and emit nothing.

#### Limits and performance

| Limit | Value | Refusal |
|---|---|---|
| Baselines per plan | 10 | `too_many_baselines` |
| Tickets a capture holds | 50,000 (PLN-001's plan) | `plan_too_large` |
| Open tickets the critical path reads | 50,000 | `plan_too_large` |
| Comparison page | 200 tickets | |
| Tickets listed in the path's chains | 500, the rest counted | |
| A baseline's name | 1 to 100 characters | `invalid_fields` |
| Evening out | stage 7's limits (10,000 movable, 1 to 12 periods, 10,000 drafted) | stage 7's |

Budgets, by `expectWithinBudget` in `plans.large.test.ts` and the engines' own large tests:
a capture of 50,000 tickets under 3 s; a comparison over 50,000 under 1 s; `criticalPath` on
50,000 tickets and 100,000 links under 200 ms, the route under 1.5 s; `evenOut` on 10,000 movable
tickets, 20,000 links, 300 people and 12 periods under 300 ms. Measured, not enforced, while the
user's 2026-11-14 hold on benchmarking lasts. The critical path is O(V + E); evening out is bounded
by V × P moves, each with its pushes. At most 500,000 baseline rows per plan.

#### Seams left for later stages

- **Ghost bars:** the Timeline route can take `baseline=` and give each item `baseline: { start,
  due, dated } | null`, with a parent's baseline span rolled up per reader from the captured rows
  of the descendants that reader sees (the roll-up CTE, `plan-views.ts:459-474`), never stored.
  The lane, the legend and `planImage.ts` then draw a thin bar under each bar.
- **A baseline as a side of stage 6's compare** (`a=baseline:<id>`), and automatic baselines on
  make main, on apply or at a period's start.
- **Slack in the engine:** `criticalPath()` is pure, so evening out could prefer tickets with the
  most slack, and a web twin could share a table of cases as `late-rule.json` does.
- **Days, not periods:** a working week and evening out by day need capacity counted by day.

#### What the manual says

When built, `docs/manual/use/multi-track.md` gains **Baselines** (capturing, from Live or a
scenario, who may, the comparison and its counts, what "not shown to you" means, delay in calendar
days) and **Critical path** (what it covers, slack, why it can differ between people), and
**Auto-scheduling** gains **Evening out load** (what it moves, what it never moves, "kept tickets
never move (fixed dates)", that a fill run and an even-out run replace each other's proposals and
both start from live days and people's drafts, and that work moves by periods). "Not yet in plans"
says what this stage leaves out, and `sources` stay current.

#### Tests

PLN-011 as it should read when built: *Taskmoor shall let a plan's editors capture named baselines
of the days of the plan's tickets, from the tickets as they are or from a scenario, and anyone who
sees the plan compare a baseline with the days now, listing each ticket that ends later with its
delay in calendar days; show the critical path through the plan's dependencies, with each ticket's
slack in days; and let an auto-schedule run even out load, moving movable level-0 tickets out of
periods where a person or plan team is over capacity, later and keeping their length, as draft
changes in a scenario, never moving a ticket a keep rule holds. A plan gives no access: a viewer
sees a baseline's days only on tickets the plan shows them, and the rest only as a count, and the
critical path runs only through tickets they are shown. Ghost bars on the Timeline, baselines of
roll-ups, automatic baselines, working days, a stored fixed-dates mark, and evening out by day or
above level 0 are not in this requirement (ADR-122, stage 9).* Acceptance: (1) A baseline
comparison lists the tickets that end later with their delay in calendar days, and the plan's end
then and now. (2) Evening out never drafts a ticket a keep rule holds (fixed dates), nor a closed
or left-out one, and makes no dependency late between tickets it reads. (3) After evening out,
every period's load is within capacity or the over-full period is reported. (4) On a chain of
dependencies that ends the plan, with no dependency late, every ticket has slack 0 and is on the
critical path, and a ticket beside the chain shows its slack in days.

The spec's PLN-011 row and `requirements-index.csv` move to M1 with this wording, as a Must, and
the title becomes "Baselines, critical path and levelling"; it drops "Gantt", "resource" and
"unconstrained" for the defined terms above.

- `plans/evenOut.test.ts` (new, pure), `[PLN-011]`: an over cell emptied by moving the
  lowest-ranked ticket one period later with its length kept; a kept ticket never moved and the
  cell reported `only_fixed`; a push through a chain of two; a push that would reach a kept, an
  open left-out and a sprint-dated ticket undoes the move (`would_make_late`) and tries the next;
  no room up to the run's end (`still_over`); a team and its member both over; a capacity of 0;
  properties (a) to (f) with `fc` from `@taskmoor/testkit/property`, the shuffled input included.
- `plans/criticalPath.test.ts` (new, pure), `[PLN-011]`: a chain ending the plan is all slack 0;
  a parallel ticket's slack; sprint-dated tickets; a circle counted; a closed blocker holding
  nothing; ties. Property: with no late link, delaying a ticket of slack 0 by one day and pushing
  what it blocks delays the plan's end by exactly one day, and delaying a ticket of slack s ≥ 0 by
  s days leaves it unchanged (the generator makes no late link, since a late one can move the end
  by more).
- `plans/graph.test.ts` (new); `plans/scheduler.test.ts` and its large test unchanged.
- `routes/plan-baselines.test.ts` (new; the harness of `plan-scenarios.test.ts`), `[PLN-011]`:
  capture from Live and from a scenario; own and sprint days; the delay across a month's end and a
  year's end; every count; paging; rename and delete with `version`; `too_many_baselines`,
  `plan_too_large`, `not_found`, 403 `edit_plan`, 404 word for word. `[PLN-011] [QRY-008]`: four
  viewers with sentinel keys, summaries and days on hidden tickets, on each read that touches
  `plan_baseline_day` (the comparison and the list): a baseline captured by
  an administrator shows a member no hidden ticket's key or day, only `notShown`; the critical path
  never names a hidden blocker.
- `routes/plan-schedule.test.ts` gains `mode: 'even_out'`: drafts with origin `scheduler`, a fill
  run after it replacing them, people's drafts kept; after the run `GET .../capacity?scenario=` has
  no over cell that is not reported. `routes/plan-dependencies.test.ts` gains the critical-path
  route: chosen link types count, a scenario's days are read, and the page's filters change
  `listed` but never the path.
- `scopes.test.ts` `[IAM-007]`, `contract.test.ts` `[AUT-010]` (the three baseline events, the new
  reasons, `mode`), `audit/subscriber.test.ts`, `privacy.test.ts` (the download's
  `planBaselines`; erasure keeps them), the migration test and upgrade fixtures, and
  `plans.large.test.ts` (the budgets above).
- Web: `PlanBaselinesPage.test.tsx` and `BaselineCompare.test.tsx` (the sentence, filters,
  paging, a list at `setViewportWidth(360)`), `CriticalPathList.test.tsx`, `TimelineView.test.tsx`
  (the toggle, outline and descriptions), `AutoScheduleDialog.test.tsx` and
  `scheduleWords.test.ts` (the mode and every new reason in both catalogues), `planExport.test.tsx`;
  stories with axe in both skins; the `en-XA` test.
- e2e `plan-baselines.spec.ts`, desktop and phone: capture a baseline, drag a bar in a scenario,
  compare and read "N days later", turn on the critical path and read the list, run Even out load
  and see a kept ticket stay.

#### Building it

Three pieces, in this order, each gated on its own if the wave must be cut:

1. **Baselines** (the migration; `routes/plan-baselines.ts`, `plans/access.ts`, the download,
   events; `PlanBaselinesPage.tsx`, `BaselineCompare.tsx`, `address.ts`, a client and fixtures).
2. **The critical path** (`plans/graph.ts` and `classify` moved; `plans/criticalPath.ts`; the
   route in `plan-views.ts`; `TimelineView.tsx`, `CriticalPathList.tsx`, `planImage.ts`,
   `planExport.ts`).
3. **Evening out** (`plans/evenOut.ts`, `scheduleBody`'s `mode`, `routes/plan-schedule.ts`,
   `scheduleInputs.ts`' readiness count; `AutoScheduleDialog.tsx`, `ScheduleResult.tsx`,
   `scheduleWords.ts`). It alone touches stage 7's route and dialog, so it can follow later
   without reopening the migration.

#### Asked by the spec or nearby, not built here

- Ghost bars on the Timeline and in its image, and baselines of parents' roll-ups (see "Seams").
- Automatic baselines; baselines of estimates, Team values, sprints or releases.
- Working days and holidays for delay and slack (stage 7, question 21).
- Evening out by day, moving tickets earlier, backfilling, splitting a ticket, levels above 0,
  moving sprint-dated tickets or sprint membership, and preferring tickets with slack.
- A stored "Keep its dates" mark or a shared "Fixed dates" field (stage 7, question 4).
- A critical path that counts capacity, or one through parents' roll-ups.

#### As built (stage 9)

Built on 2026-11-14 on `wave19/t089a-hierarchy-baselines`, in the three pieces of "Building it":
baselines (migration `0111_plan_baselines`, `plans/access.ts`, `routes/plan-baselines.ts`, the
download, the events; `PlanBaselinesPage.tsx`, `BaselineCompare.tsx`, `baselineClient.ts`,
`baselineFixtures.ts`, `baselineExport.ts`, `address.ts`, `PlanPage.tsx`), the critical path
(`plans/graph.ts`, `classify` exported, `plans/criticalPath.ts`, the route in `plan-views.ts`;
`TimelineView.tsx`, `timeline/critical.ts`, `CriticalPathList.tsx`, `criticalFixtures.ts`,
`PlanTimelinePage.tsx`, `planExport.ts`, `planImage.ts`) and evening out (`plans/evenOut.ts`,
`scheduler.ts`, `routes/plan-schedule.ts`, `scheduleInputs.ts`; `AutoScheduleDialog.tsx`,
`ScheduleResult.tsx`, `scheduleWords.ts`, `scenarioClient.ts`), with the manual's sections. Where
the build differs from the design above, or settles what it left open:

- **`then` is `was`** in the comparison's answer (`tickets[].was`, `planEnd.was`): Biome's
  `noThenProperty` refuses a property named `then`, since it makes an object look like a promise.
  `was` is null for a ticket added since, rather than an object of nulls.
- **The comparison answers more:** `mostLater` (the largest delay, for "by up to N days"),
  `query` and `show`. Each ticket's `level` is `{ rank, kind }`, as on the Timeline, and `closed` is
  the ticket's state now; the `closed` flag stored at capture is kept but not answered. `show` is
  the page's state, not in its address; `baseline=` is (`PlanView.baseline`, written only on the
  Baselines tab and not part of `planViewKey`).
- **The comparison's file** holds every page of the list chosen, reading at most 250 pages of 200
  (a whole plan of 50,000), through `planExport`'s `csvText`; its first lines name the baseline and,
  when any, `notShown`.
- **`planEditable`** replaced `mayManage` in `routes/plans.ts` and the `editable` of `visiblePlan`
  in both `routes/plan-scenarios.ts` and `routes/plan-schedule.ts`; behaviour is unchanged.
- **The page reuses** the Scenarios tab's list, card and dialog classes and the filter chips, so no
  stylesheet changed for baselines.
- **The critical path's open choices:** `waitsElsewhere` counts the dated open tickets with at
  least one blocker outside the plan or hidden from the viewer. Links into or out of a circle
  constrain nothing. Each critical ticket is in exactly one chain: a ticket with two tight links
  onward follows the longer, and the other starts a chain of its own; chains come longest first,
  then by their first start, then id. The cut at 500 tickets can end partway through a chain.
  `undated` counts open tickets with no bar of their own or of their sprint, parents dated only
  by their children included. The answer carries `scenario` when one is read.
- **The critical path on the page** shows only where the page's client reads it
  (`PlanClient.criticalPath`, optional), so pages and stories built on `fakePlanClient` show no
  toggle. A path that ends partway through a late chain says, on each ticket of slack below 0, "(a
  dependency before it is N days late)". The Timeline's CSV gains **Slack (days)** and
  **Critical** only while the toggle is on, and the image a legend line; the page reads the path
  afresh for each file.
- **Evening out's answer shapes:** `moved_off_over` carries `{ subject, fromPeriod, fromPeriodEnd,
  toPeriod, toPeriodEnd, days, over }`, where after several moves `fromPeriod` is the first period
  and `days` the whole shift; `would_make_late` carries `{ ticketId?, why, until }`, `why` being
  `kept`, `left_out`, `cycle`, `hidden_blocker`, `sprint` or `past_end`; `overLeft` is `[{ teamId
  | userId, periodStart, periodEnd, over, onlyFixed }]`, a boolean decided in the final pass (true
  when the cell ends holding only tickets that do not move). `DayProposal` lets a proposal keep a
  null day: a day a ticket does not have stays null. `countOverCells` is exported for readiness.
- **Evening out's outcomes:** every other movable ticket is placed with `already` and the page
  never lists those; tickets in a circle or behind a hidden blocker are listed as not placed
  (`cycle`, `hidden_blocker`), as in stage 7. `still_over` is left only on the candidates of a
  cell that stays over (rule 7): a ticket whose try failed before a later candidate's move made its
  cell fit stays where it is, with `already`. `would_make_late` stays on its ticket (rule 6), since
  it still says why it did not move. Within a cell, a size no later period could take is not
  searched again for the same assignee until a move pushes a ticket, which frees room in a later
  period; this keeps the large case inside its budget.
- **Pushes can raise the number of over cells.** Rule 5 checks room only for the moved ticket; a
  pushed ticket lands where the push puts it and its cell is worked when its turn comes. Promise
  (d) holds, since every cell left over is listed, but in the large synthetic plan (packed full,
  then capacity cut by 20%) 161 over cells became 511 after a run. Counting the pushes' load when
  choosing where to move would change rule 5; the user's to decide (question 17).
- **Readiness's `overCells`** counts the reader's tickets of the plan by their live days and
  people's drafts in the scenario (never the auto-scheduler's), closed work due then and work
  elsewhere included, in one more read-only statement; readiness now passes the scenario's
  overlay through. `diffProposals` takes nullable days. `plan.schedule_ran` gains `mode` and
  `overLeft` (a count), as designed, in `events/catalogue.ts`.
- **The dialog** remembers `mode` with its other choices in this browser, and a run in rank order
  sends no `mode`. The keep choices sit in a nested fieldset with the legend "Kept tickets never
  move (fixed dates)", styled by the existing `.auto-schedule-choices`; the note that the two kinds
  of run replace each other's proposals shows when Even out load is chosen.
- **Measured, not enforced** (the user's hold on benchmarking): `evenOut` alone on 10,000 tickets,
  20,000 links, 300 people and 12 periods, about 200 ms (`evenOut.large.test.ts`).
- **Not yet done:** the budgets in `plans.large.test.ts` (a capture and a comparison of 50,000
  tickets; `criticalPath` on 50,000 tickets and 100,000 links, and its route); the e2e
  `plan-baselines.spec.ts`; a contract scenario with `mode: 'even_out'` (the existing one checks the
  new payload fields with `'fill'`); `fakeScenarioClient`'s run ignores `mode`; a `TimelinePage`
  story with the critical marks on. `docs/api` lists the five baseline routes and the critical
  path's, all internal.

#### Questions for the user (the design takes the first answer each time)

1. **What evening out is called** ("level" already names a hierarchy level): **Even out load**;
   or "Fix over-capacity"; or "Level resources", accepting the clash.
2. **Evening out and the auto-scheduler:** a second mode of the same run (same route, reads, keep
   rules and drafts with origin `scheduler` into a scenario), with an engine of its own; or a
   separate action with its own draft origin (a migration widening 0110's origin check); or a step
   inside the fill run that repairs over-full periods.
3. **What a fixed-date ticket is:** a ticket the run's keep rules hold (a person's draft, may not
   be scheduled by the runner, in progress, in an active sprint, the keep query); or a "Keep its
   dates" mark per plan and ticket (a migration); or a shared checkbox field named "Fixed dates";
   or any ticket with both days of its own.
4. **Which ticket leaves an over-full period first:** the lowest-ranked; or the one with the most
   slack (the critical path inside the engine); or the smallest estimate.
5. **A move that would make a ticket it blocks late:** the blocked ticket is pushed too, keeping
   its length, and the move is undone when the push reaches a ticket that may not move; or blocked
   tickets are never pushed and the link becomes late, with a warning; or every move that needs a
   push is refused.
6. **How far a ticket moves:** the least shift that puts its due day in the first later period
   with room, keeping its length; or whole periods; or onto the first day with room (needs
   capacity by day).
7. **What a baseline holds:** each plan ticket's own days, or else its sprint's, as its capturer
   is shown them, from Live or the open scenario, with roll-ups computed when read; or roll-ups
   stored too (they would carry hidden work to other readers); or Live only.
8. **How baselines are made:** by hand, named, up to 10 per plan; or up to 20; or also
   automatically when a scenario is made main or applied; or one per plan, replaced on capture.
9. **Who may capture, rename and delete:** the plan's editors (owner and site administrators),
   while everyone who sees the plan reads them; or everyone who sees the plan, their own.
10. **Delay:** calendar days between the end then and the end now (due, else start, else the
    sprint's end), the same for closed tickets, marked closed; or working days (needs a working
    week, kept for 2.0); or, for a closed ticket, the day it closed against the baseline's due day.
11. **Where a comparison shows:** a Baselines section with the list of tickets that end later; or
    that and ghost bars on the Timeline with parents' spans; or inside the Scenarios compare.
12. **What the critical path runs through:** open tickets with days of their own or of their
    sprint, over blocking links and the plan's chosen types, with parents dated only by roll-ups
    left off; or parents included by their roll-ups; or blocking links only.
13. **Where it is computed:** on the server over the whole plan the viewer is shown, the page's
    filters leaving it unchanged; or in the browser over the Timeline's listed rows, so a filter
    changes it.
14. **A copy and the download:** a copy of a plan takes no baselines, and the data download lists
    the baselines a person captured without days; or a copy takes them; or the download holds the
    days by ticket id.
15. **Whose view a baseline holds:** what its capturer was shown, each reader seeing only the
    tickets they are shown now and the rest as a count; or only tickets every viewer of the plan
    may see.
16. **Where the critical path shows:** a toggle on the Timeline with a list in words, marked in
    its image and CSV; or also on the program board; or only as a list.
17. **Pushes that fill later periods** (asked after the build, 2026-11-14): a move checks room only
    for the ticket it moves, the tickets it pushes are worked when their period's turn comes, and
    every cell left over is listed, as built; or a move counts its pushes' load too and is undone
    when they would take a later cell over (fewer moves, more cells left over where they are); or
    pushed tickets may move again past the run's periods.

### Stage 10 (T-089a): the hierarchy grid

**Designed on 2026-11-14; not built yet.**
PLN-010 moves to M1 with this stage, reworded to what will be built (the wording is under "Tests");
the user brought it into 1.0 on 2026-11-13 (`docs/plan/decisions.csv`, "Hierarchy grid and
baselines"). The new wording narrows the spec's in six ways: a grid lives inside a plan and starts
from the plan's tickets (questions 1 and 2); its steps come in a fixed order, one of each kind at
most except grouping and links (question 23); grouping takes single-valued fields only (question
20); a ticket appears once per structure (question 4); one row moves at a time (question 10); and
inside a scenario the grid shows live values and is read-only (question 16). "Any depth" is the
depth of the hierarchy: the ladder has no gaps and a parent sits exactly one level up
(`parentLevelAllowed`, `apps/server/src/tickets/hierarchy.ts:204`, with `DEFAULT_PARENT_RULES`
at `:201`), so children go as deep as the levels the administrators made. Two designs were made
for this stage and judged against the spec, privacy, the earlier stages and the code. This one
takes the larger one's shape (one insert step, a columnar skeleton with `inPlan`, `via`,
`notShown` and `elsewhere`, rows placed by a link not draggable, a new row-window hook that leaves
the Timeline untouched, a visited set besides the depth guard, cells in view fetched again after an
edit because stored formula fields change on the server) and grafts in the smaller one's
corrections: live values inside a scenario, as the plan List; keys, field types, today and the
working week in the skeleton, so rows have names before their cells load and formula columns can
compile in the browser; an unsaved default structure; an explicit refusal when the read runs too
long; the grid's own row limit beside the views' 10,000; and hidden linked tickets counted as well
as hidden children. The questions at the end are the user's; the design takes the first answer
each time.

The **Grid** is a section of a plan that shows its tickets as a tree. A **structure** is a saved,
named recipe for that tree, kept with the plan: its **steps** and its **columns**. It holds no
tickets: the rows are built for each viewer when read, so two viewers can see different rows. The
steps are **Add tickets** (the plan's tickets, maybe narrowed by a query), **Group by** (a field),
**Add children** (by parent, down every level) and **Add linked tickets** (by a link type and a
direction). A **row** is a ticket row or a group row. **Total** columns add up, or count, the
rows below a row; **Formula** columns compute a value per row in the formula field language.

**On the words:** the interface says **Grid**, **structure**, the four step names, **Total**,
"total of the rows below", **Formula**, **Move under…**, "Not in this plan" and "+N not shown"
(question 25). It uses the administrators' names of hierarchy levels, read from `GET
/api/v1/hierarchy-levels` (`routes/ticket-types.ts:311`): this is the one Plans page where level
names belong. It never says "generator", "epic", "issue", "folder" or "baseline" (stage 9's word),
nor any other product's name.

#### What a structure is

A zod `structureSpec` (new, in a new `apps/server/src/plans/structures.ts`): `{ steps, columns }`.
The steps apply in this order, whatever order they are stored in:

1. **Add tickets** (exactly one): `{ kind: 'insert', query?: text ≤ 2,000 }`. It reads the plan's
   tickets for the viewer through `planTickets()` (`plans/query.ts:244`) and its `where` (the plan
   with the page's filters), the one permission-safe way to them (stage 1). The query only narrows
   them: it is compiled by `compileCondition` (`boards/data.ts:261`) in the plan's scope and ANDed,
   as the auto-scheduler's queries are. A query a viewer cannot run makes the structure `broken`
   for that viewer, with the reason, as a saved-search source is marked (`viewerSources`). Tickets
   are taken by rank, then id, up to `GRID_ROWS` (100,000). An inserted ticket whose parent is
   also inserted sits under it, as `timelineRows()` (`apps/web/src/timeline/rows.ts:18`) nests
   rows; a parent the viewer may not see reads as none.
2. **Group by** (0 to 2): `{ kind: 'group', field }`: track, assignee, status, type or priority
   (the plan's own groupings), or a custom select, user, team or release field whose `multiple` is
   false (`FieldTable.multiple`, `packages/db/src/schema.ts:1659`), so no ticket falls in two
   groups. Values come from `parseAxis` (`reports/general.ts:144`) and `axisValues` (`:159`, then
   exported, unchanged). Grouping applies to top rows; their rows below follow them. Two steps nest.
   Groups are ordered by their label, "No value" last.
3. **Add children** (0 or 1): `{ kind: 'children' }`: every descendant by `ticket.parent_id` that
   the viewer may see, in the plan or not, down to the leaves. A visited set stops any loop that
   bad or imported data could make, and a guard stops at 32 levels (`CASCADE_LEVELS`,
   `fields/formulas.ts:52`); the Timeline's depth of 10 is not used.
4. **Add linked tickets** (0 to 2): `{ kind: 'links', linkTypeId, direction: 'outward' |
   'inward', depth: 1 to 3 }`: under each ticket row present at that point, the tickets it links
   to by that type in that direction, then theirs, up to `depth`. Only tickets the viewer may see
   are added; a ticket already on the path stops it.

**Placing rules:**

- **A ticket appears once,** where the steps first reach it, in step order, then breadth first by
  row order (question 4). A later reach adds to that row's `elsewhere` count ("2 linked tickets are
  shown elsewhere").
- **Tickets outside the plan** that a children or links step reaches, and that the viewer may see,
  are rows marked "Not in this plan" (`inPlan` false; question 3). This is the reach of the
  Timeline's roll-ups (stage 1).
- **A hidden ticket is never a row.** A row counts its hidden live children and its hidden linked
  tickets of the steps' types in `notShown`, shown "+N not shown" (decisions row 134); a count
  never says which.
- Past 100,000 rows the structure stops and says "Shows the first 100,000 rows" (question 18).

**Columns** (at most 30; 10 totals and 5 formulas among them):

- **Ticket columns:** any of `SYSTEM_COLUMNS` or `cf[N]` (`apps/web/src/search/columns.ts`). They
  edit in place where `cellEditor` (`:155`) gives an editor, and are read-only otherwise. `parent`
  stays read-only in a cell: a row moves with Move under.
- **Totals:** `{ kind: 'total', fn: 'sum' | 'min' | 'max' | 'count' | 'progress', of? }`. `sum`
  takes original estimate, remaining estimate, time spent, and number fields and formula fields of
  number, currency, percentage or duration output; `min` and `max` also take start, due and date
  fields; `count` and `progress` take no field.
- **Formulas:** `{ kind: 'formula', name, expression, output, decimals }`, in the formula field
  language (`packages/formula`), checked on save by `compileFormula(expr, { resolve, output })`
  with `formulaResolver(catalog, null)` (`fields/formulas.ts:185`), shared fields only, and stored
  by id, as a formula field is (`rewrite.ts`). A field deleted later makes the column `broken`,
  which shows its error while the rest of the structure works.

**The default:** a plan with no saved structure shows an unsaved one: Add tickets, then Add
children, with key, summary, status and assignee, a count total and a progress total (question 21).

#### Totals and formulas (acceptance 3)

At a row with rows below it, a total is computed from its **child rows**: `sum` adds their totals,
`min` and `max` take theirs, and a leaf gives its own value; so at every row a sum total equals the
sum of its child rows' values, by construction. The row's own value is **not** added (question 6):
it stays in its ticket column beside the total, and the column's header says "Total of rows
below", so an editor reading a middle level is not surprised. `count` is every ticket row below,
at any depth. `progress` is how many ticket rows below are in a status of the closed stage, out of
how many, ADR-120's definition (not the Timeline's `closed_at`), shown as "3 of 8 closed" with a
bar, never a percentage (decisions row 157). Empty values are skipped, and "5 of 8 have a value"
says so (spec 03 section 1, partial roll-ups). Group rows total their rows; a last row totals the
top rows. Only rows the viewer is shown enter a total; a row with `notShown` says "+4 not shown"
beside it. Totals are never stored.

A **formula column** runs `evaluate(program, input)` per row, where `field(id)` reads the row's
values, `children(id)` and `childCount()` read its child rows in the grid (whichever step added
them), and `today` and `workingWeek` come with the skeleton (`EvalInput`,
`packages/formula/src/evaluate.ts:14-25`). Group rows show nothing. Nothing is stored, so these
columns are not searchable or sortable. `sum(children.{X})` equals the sum total of X only where X
is itself a total of its rows below, or where every child row is a leaf: `children.{X}` reads each
child's own value, while the total reads each child's total.

Totals and formulas are computed **in the browser** by one pure module, `apps/web/src/plans/grid/
compute.ts` (new). An edit or a move recomputes only the chains of rows above the changed ones, in
O(depth), so 100,000 rows never need the server again to refresh a total. `apps/web` gains a
workspace dependency on `@taskmoor/formula`, which has none of its own.

**Stored formula fields** shown as ticket columns keep their stored values, which count every
child that is not deleted, seen or not (`loadChildren`, `fields/formulas.ts`). So a stored
`children.{Estimate}` and a Total over the same rows can differ, and the manual says why.

#### What is stored (migration: the next free number when built)

One migration, numbered when built: the next free number after stage 9's, claimed in
`COORDINATION.md` Messages first (0112 if stage 9 takes 0111).

- **`plan_structure` (new):** `id` serial; `workspace_id`; `plan_id` references `plan` ON DELETE
  CASCADE; `name` text, 1 to 100 characters, unique per plan ignoring case; `spec` jsonb, checked by
  `structureSpec` on every write; `created_by` and `updated_by` reference `app_user` NOT NULL;
  `created_at`, `updated_at`, `version` int. A unique index on `(plan_id, lower(name))`.
- In the same change: the table type in `schema.ts`, the schema golden file and a row in
  `upgrade-fixtures.ts`.
- **The data download** gains `planStructures`: the structures a person created, by plan id and
  name. **Erasure rewrites nothing**, as for scenarios.
- **A copy of a plan** (stage 8) copies its structures, as plan settings (question 15). Collapsed
  rows are remembered per viewer in the browser only (`taskmoor.grid.<planId>.<structureId>`, read
  and written in `try`, never needed).

#### Routes and token scopes

All are internal in the API document (`x-taskmoor-stability: internal`), and scopes follow the
method. A plan the person may not see, and a structure of another plan, answer 404 word for word as
a missing id. Writes are for the plan's editors (`planEditable`, stage 9's `plans/access.ts`; this
stage lifts it if it is built first); anyone else gets `forbidden` with `edit_plan`. They live in a
new `apps/server/src/routes/plan-structures.ts`, registered beside `registerPlanScenarioRoutes`.

| Route | Scope | What |
|---|---|---|
| `GET /api/v1/plans/:id/structures` | read | `{ structures: [{ id, name, updatedAt, version, broken }], editable, limits }` |
| `POST /api/v1/plans/:id/structures` | write | `{ name, spec }`; 201 |
| `PATCH /api/v1/plans/:id/structures/:sid` | write | `{ name?, spec?, version }` |
| `DELETE /api/v1/plans/:id/structures/:sid?version=` | write | |
| `GET /api/v1/plans/:id/structures/:sid/rows?<plan filters>` | read | The skeleton, below; `default` in place of `:sid` reads the default structure |
| `POST /api/v1/plans/:id/grid/tickets` | read | `{ ids: ≤ 500, fields }`: the rows in view, below |

**The skeleton** is columnar, to stay small at 100,000 rows: `{ generation, total, more, today,
workingWeek, fields: [{ ref, type }], rows: { ticket: int[] (0 for a group row), key: string[],
parent: int[] (a row index, −1 at the top), depth: int[], level: int[] (the level's rank), track:
int[], inPlan: bool[], via: int[] (0 inserted, 1 child, 2 + n the nth links step), closed: bool[],
notShown: int[], elsewhere: int[] }, groups: [{ row, field, label }], values: { [ref]: (number |
string | null)[] } }`. `values` holds only the fields that totals and formulas read; `fields`
gives each one's type, so the browser can compile a formula column; `today` and `workingWeek` come
from `formulaEnv` (`fields/formulas.ts:487`), the viewer's day.

**Reading it** (one read-only transaction, `readOnly`, `search/run.ts:208`, with the plan views'
statement timeout):

1. `planTickets()`, then the ids of `where` ANDed with the step's query, by rank and id, `LIMIT
   100,001`.
2. Children: one `WITH RECURSIVE` over `ticket.parent_id` under the viewer's ticket filter, as the
   Timeline's roll-up reads it (`seen`, `plan-views.ts:411` and `:459-474`), with a visited path and
   the depth guard; then one count of the live children the viewer may not see, per row.
3. Links: per step, one recursive query over `ticket_link` joined to `link_type`, under the same
   filter, with a count of the hidden ones per row.
4. The pure step, `buildStructure(input)` in a new `apps/server/src/plans/structureTree.ts`: nest,
   drop repeats (counted), group the top rows, order siblings by rank then id, and give the rows in
   preorder.
5. Values: one SELECT over `ticket` and the side tables (`fields/storage.ts`) for the refs read;
   `closed` is `status.stage = 'closed'`.

A read that runs too long refuses as `searchRefusal` (`routes/search.ts:102`) does, 503
`query_timeout`, never with part of an answer. `generation` lets the page drop an older answer that
arrives after a newer one.

**The rows in view:** `POST .../grid/tickets` answers the tickets in the search route's shape,
through `searchViews(db, catalogs, request, ids, filter)` (`routes/search.ts:196`) and `project()`
(`:182`), both exported already, with the viewer's ticket filter applied again: an id the viewer
may not see is left out silently, the same as a missing one, so the route says nothing about which
tickets exist. Each ticket carries `version`, so an edit keeps the 409. The limit of 500 ids
matches `POST /search/format-rules` (`routes/list-views.ts:30`).

**No new write route:** an edit and a move are the ticket's own `PATCH /api/v1/tickets/:id` with
`version` (`routes/tickets.ts:1361`), which keeps every check: the hierarchy lock
(`shareHierarchy`), `lockParent` (`:495`), `placementProblem` (`:510`: `required`, `wrong_level`,
`other_track`), `edit_tickets`, the edit layout and field rules, the per-status edit locks, the 409,
history, events, and the stored formula roll-ups of the old and new parents.

**Refusals:** 400 `invalid_fields` with the path of the bad step or column (a formula that does not
check returns the body of `GET /api/v1/formulas/check`, `routes/fields.ts:1410`), `invalid_query`;
409 `too_many_structures { limit: 20 }`, `name_taken`, `version_conflict`; 404 as above; 503
`query_timeout`.

#### Editing and moving (acceptance 2)

- **Cells** reuse `Cell` and `CellInput` (`apps/web/src/search/ResultTable.tsx:272` and `:455`),
  exported where they are and not changed, with `cellEditor` and `cellChange` (`columns.ts:155`,
  `:258`). A refusal shows on the cell, as in search results. After a save the answer replaces the
  ticket in the cache and its values in the skeleton; the totals above recompute, and cells in view
  of the rows above are fetched again, since the server recomputed their stored formula fields.
- **Moving a row** with everything below it: a drag handle on the tree cell, and **Move under…**
  in the row's menu (Shift+F10 or the menu key, and on phones), with a ticket picker. Allowed
  targets come from the levels: a ticket row exactly one level up, in the same track when the row
  is a subticket, as `placementProblem` rules; other targets say why on hover, in its words. A
  group row is not a target ("A group is not a parent"; question 13). A row placed by a links step
  cannot be dragged: its place comes from a link, not its parent (question 12). **Remove from
  parent** sends `parent: null`, which the server refuses where a parent is `required`.
- **The confirmation** (`MoveUnderDialog.tsx`, new): "Move ABC-12 under DEF-3? Its parent changes
  from GHI-1 to DEF-3. 6 rows move with it." **Move** sends `PATCH { parent, version }`. On success
  the rows move in the page and the skeleton is read again behind; on a refusal or 409 the dialog
  says why and nothing moves.
- **One row at a time** (question 10). Moving under a ticket of another track needs only what a
  move needs today, `edit_tickets` on the moved ticket and a parent the mover may see (question 11).
- **Inside a scenario** the Grid shows live values, is read-only and says "The grid shows live
  values" (`plans.list.live`), as the plan List does (`PlanListPage.tsx:122-129`; question 16).

#### Who sees what

- **Rows are only tickets the viewer may see:** the insert through `planTickets()`, the other
  steps through the viewer's ticket filter. A hidden parent breaks the path: its visible children
  become top rows, as on the Timeline.
- **Hidden tickets below a row are a count only,** never keyed, valued or added into a total.
- **Group labels** name only values on rows shown.
- **The rows-in-view route** answers only for tickets the viewer may see. Writes are the ticket
  route's own.
- **Stored formula fields** keep their stored value, which may count hidden children: that is how
  formula fields work today, and the manual says so.

#### The pages, on a desktop and on a phone

- **The section:** `{ id: 'grid', path: '/grid', labelId: 'plans.section.grid' }` in
  `PLAN_SECTIONS` (`apps/web/src/plans/address.ts:5`), after List; `PlanGridPage.tsx` (new), with
  the structure chosen in the address (`structure=`), a picker, **Refresh**, **Expand all**,
  **Collapse all** and, for editors, **New structure…** and **Edit structure…**
  (`StructureDialog.tsx`, new: the steps in their fixed order, then the columns, each with its
  check in words).
- **Desktop:** a `role="treegrid"` with `aria-rowcount` of the rows shown, and on each row drawn
  `aria-rowindex`, `aria-level`, `aria-expanded`, `aria-setsize` and `aria-posinset`; the header
  row and the tree column stay in view. Rows are drawn in a window by a new hook,
  `apps/web/src/plans/grid/rowWindow.ts`, on the Timeline's pattern (fixed 44 px rows, an overscan
  of 20, padding above and below, the focused row kept drawn); `TimelineView.tsx` is not changed. A
  new `visibleRows(skeleton, collapsed)` in `plans/grid/tree.ts` maps what is shown to skeleton rows
  in one pass on each expand or collapse. Every row opens expanded (question 22).
- **Cells load by window:** debounced 100 ms, 500 ids a request, about 5,000 tickets kept; a row
  not yet loaded shows its key and a quiet line.
- **Keyboard:** arrows move; Right and Left expand and collapse; Enter edits; Escape cancels; Home
  and End go to a row's ends, Ctrl+Home and Ctrl+End to the grid's.
- **Phones** (below the compact width, ADR-033): a windowed list of cards, each with a 44 px
  expand button, an indent of 12 px a level up to 4 levels and then the level's name in words, key
  and summary, and the first two columns as label and value. Tapping a card opens a sheet with
  every column, where the cell editors work and Move under is offered. No drag on touch, no
  sideways scrolling.
- **Everywhere:** glass per ADR-114, strings under `grid.*` in both catalogues (`pnpm i18n:check`
  clean), 44 px targets under a coarse pointer, and stories with axe in both skins.

#### Events, audit and records

`plan.structure_created`, `plan.structure_changed` and `plan.structure_deleted` (new), with the
plan as subject, audited, no webhooks, payloads of ids and the name. Edits and moves emit the
ticket's own events and history.

#### Limits and performance

| Limit | Value | Refusal |
|---|---|---|
| Structures per plan | 20 | `too_many_structures` |
| Rows | 100,000 (`GRID_ROWS`; `LISTED`, `plans/model.ts:20`, stays 10,000 for the other views) | cut, `more: true` |
| Steps | 1 insert, 2 group, 1 children, 2 links | `invalid_fields` |
| Link depth | 1 to 3 | `invalid_fields` |
| Columns | 30, of which 10 totals and 5 formulas | `invalid_fields` |
| A step's query | 2,000 characters | `invalid_fields` |
| Ids per rows-in-view read | 500 | `invalid_fields` |
| A name | 1 to 100 characters | `invalid_fields` |

Budgets, by `expectWithinBudget` in a new `plan-structures.large.test.ts` (10,000 rows in every
gate, 100,000 with `TASKMOOR_LARGE_PLANS=1`): a skeleton of 100,000 rows under 3 s and under 4 MB
before compression; 500 rows in view under 300 ms; a recompute after one edit under 16 ms; a
scroll frame under 16 ms. The backlog's "50k-row frame budget" (M2-005) becomes 100,000. Measured,
not enforced, while the user's 2026-11-14 hold on benchmarking lasts.

#### Shared code (moved, not changed)

- `Cell` and `CellInput` exported from `ResultTable.tsx`, where they are.
- `axisValues` exported from `reports/general.ts`.
- `planEditable` from stage 9's `plans/access.ts`, or lifted here if this stage is built first.

#### Seams left for later stages

- Moving several rows at once, through the backlog's ticket-by-ticket loop
  (`routes/backlog-planning.ts:257`) or a bulk operation's `edit.parent`.
- Dropping on a group row to set its field; ranking by drag; sorting siblings by a column.
- Drafts in the Grid: 0110's field check widened to `parent` and more fields.
- Live updates through the program board's channel.
- CSV of a structure through `packages/webconfig/src/csv.ts`; format rules, since
  `POST /search/format-rules` already takes 500 ids.
- An "under this Outcome" query condition, so a total can link to its search.
- Structures outside plans; grouping by labels or other multi-valued fields.

#### What the manual says

When built, `docs/manual/use/multi-track.md` gains **Grid**: structures and who may change them;
each step; "Not in this plan", "+N not shown" and "shown elsewhere"; totals as "total of the rows
below" and why they can differ from a stored formula field; progress by closed stage; formula
columns; moving a row and what it checks; live values in a scenario; the 100,000-row stop; and the
phone's cards. "Not yet in plans" says what this stage leaves out, and `sources` stay current.

#### Tests

PLN-010 as it should read when built: *Taskmoor shall show a plan's tickets as a tree in a Grid
built from saved structures that the plan's editors keep: the plan's tickets, maybe narrowed by a
query, grouped by up to two single-valued fields, then extended by children at every level of the
hierarchy and by tickets linked by chosen link types, across tracks; with ticket columns edited in
place through the ticket's own change, total columns (sum, min, max, count, and progress by closed
stage) over the rows below, and formula columns in the formula field language; and moving one row
under another parent, by dragging or a Move under action, after confirmation. A plan gives no
access: a viewer is shown only tickets they may see, and hidden tickets below a row are only
counted. Drafts in the Grid, moving several rows at once, dropping on a group, sorting by a column
and downloading a structure are not in this requirement (ADR-122, stage 10).* Acceptance: (1) A
structure of 100,000 rows scrolls to its last row and saves an edit there without an error. (2)
Moving a row under another parent changes its parent only after confirmation, through the
ticket's own checks, and a refusal says why. (3) On every row with rows below it, a sum total
equals the sum of its child rows' values, a leaf's being its own. (4) A ticket the viewer may not
see is never a row, never named and never in a total; it is only counted.

The spec's PLN-010 row and `requirements-index.csv` move to M1 with this wording; it drops
"generators" for steps, "any depth" for the hierarchy's depth, and adds acceptance (4).

- `plans/structureTree.test.ts` (new, pure), `[PLN-010]`: nesting, repeats counted, grouping,
  preorder; fc properties: every ticket at most once, parents before children, the same output
  for a shuffled input, the stop at 100,000.
- `apps/web/src/plans/grid/compute.test.ts` (new), `[PLN-010]`: fc property over random trees that
  a sum total equals the sum of the child rows' values at every row (acceptance 3); min, max, count,
  progress and partial values; the rows above an edit recomputed; a formula `sum(children.{X})`
  equal to the sum total on trees of depth 1.
- `routes/plan-structures.test.ts` (new), `[PLN-010]`: create, change and delete; `version`;
  limits; `name_taken`; a formula that does not check; a query that does not compile; a broken
  source and a deleted field; 403 `edit_plan`, 404 word for word; the default structure; a slow
  read refused, never partial. Moves through `PATCH`: `wrong_level`, `other_track`, `required`,
  `forbidden`, 409. `[PLN-010] [QRY-008]`: four viewers with sentinel keys on a hidden child, a
  hidden parent, a hidden linked ticket and a child outside the plan: none appears in rows, keys,
  groups, values or the rows-in-view answer; `notShown` only counts.
- `scopes.test.ts` `[IAM-007]`, `contract.test.ts` `[AUT-010]` (the three events),
  `audit/subscriber.test.ts`, `privacy.test.ts`, the migration test and upgrade fixtures,
  `plan-structures.large.test.ts`.
- Web: `PlanGridPage.test.tsx` (a fake 100,000-row skeleton scrolled to its end and its last row
  edited, with no console error and the drawn rows within the window, `[PLN-010]` (1); treegrid
  roles; keyboard; live values in a scenario), `MoveUnderDialog.test.tsx` (`[PLN-010]` (2)),
  `StructureDialog.test.tsx`, cards at `setViewportWidth(360)`; stories with axe in both skins;
  `pnpm conformance formula` unchanged (the same language).
- e2e `plan-grid.spec.ts`, desktop and phone: save a structure, edit a cell, move a row after
  confirming and see the totals change, and Move under on a phone.

#### Building it

Four pieces; 1 and 2 can be built at once, then 3, then 4:

1. **The model and storage:** the migration, `plans/structures.ts`, `plans/structureTree.ts`,
   `routes/plan-structures.ts` (the CRUD and the skeleton), `axisValues` exported, the download,
   events.
2. **The browser engine:** `apps/web/src/plans/grid/compute.ts` and `tree.ts`, with
   `@taskmoor/formula` added to `apps/web/package.json`.
3. **The page:** `PlanGridPage.tsx`, `plans/grid/rowWindow.ts`, `plans/grid/client.ts`,
   `StructureDialog.tsx`, `address.ts`, `Cell` and `CellInput` exported, the rows-in-view route.
4. **Moving:** `MoveUnderDialog.tsx` and the drag and menu actions. If the wave runs short, links
   steps keep depth 1 and formula columns wait, before any privacy or acceptance test is cut.

#### Asked by the spec or nearby, not built here

Every item under "Seams", and: percentages and estimate-weighted progress (decisions row 157);
skip-level parents (`ParentRules.skipLevels` stays off, so moves need no cycle walk); links
steps deeper than 3; a structure's own filters beyond the plan's.

#### Questions for the user (the design takes the first answer each time)

1. **Where a structure lives:** inside a plan, as its Grid section, shared with whoever sees the
   plan; or on its own, saved and shared like a saved search; or both.
2. **The insert step's query:** only narrows the plan's tickets; or runs like any search, so a
   structure can start outside the plan.
3. **Children and linked tickets outside the plan:** rows, marked "Not in this plan"; or only
   counted, like hidden ones.
4. **A ticket reached twice:** shown once, where first reached, the other places counting it; or
   at every place, each counted in totals; or at every place, counted once.
5. **Hidden tickets below a row:** a count beside it ("+4 not shown"), never in a total; or left
   out with no count.
6. **What a total at a parent adds up:** its rows below (a leaf gives its own value); or its own
   value too; or a choice per column.
7. **Progress:** "3 of 8 closed" with a bar, by tickets in a closed stage; or weighted by an
   estimate; or a percentage (with decisions row 157, in 2.0).
8. **Count:** every ticket row below, at any depth; or the direct children only.
9. **A formula column:** an expression in the formula field language kept with the structure,
   where children means the row's child rows, computed in the browser; or only existing formula
   fields shown as columns.
10. **Rows moved at once:** one with everything below it, confirmed each time; or several chosen
    rows with one confirmation, ticket by ticket (up to 1,000, as the backlog's action); or a bulk
    operation (needs `bulk_change`).
11. **Moving under a ticket of another track:** the rule of today, edit permission on the moved
    ticket and a parent the mover may see; or also edit permission on the new parent's track.
12. **A row placed by a link:** cannot be dragged, its place being a link's; or can be, changing
    its parent and not the link.
13. **Dropping on a group row:** not a target; or it sets that group's field, after confirmation.
14. **Who saves structures:** the plan's editors, everyone who sees the plan using them; or anyone,
    as personal structures beside the shared ones.
15. **A copy of a plan:** copies its structures; or starts with the default.
16. **Inside a scenario:** live values, read-only, as the List; or drafted days, read-only; or
    edits written as drafts (needs drafts of more fields).
17. **Other people's changes:** a Refresh button and the stale-edit notice; or live, through the
    program board's channel.
18. **Past 100,000 rows:** the first 100,000, saying so; or refused.
19. **Sibling order:** rank, then id; or sorted by any column.
20. **Group by fields:** single-valued fields only; or also labels and other multi-valued fields,
    a ticket repeated under each value.
21. **A plan with no saved structure:** a default (the plan's tickets and their children, with
    key, summary, status, assignee, a count and a progress total); or an empty Grid asking for one.
22. **How a structure opens:** every row expanded, collapsed rows remembered in the browser; or
    the top level only.
23. **Steps:** one insert, then up to two groupings, one children step and two links steps of
    depth 1 to 3, in that order; or steps in any order and number.
24. **Phones:** cards with a sheet and Move under, no drag; or no Grid on phones.
25. **The words:** Grid, structure, Add tickets, Group by, Add children, Add linked tickets,
    Total, Formula; or "Hierarchy", "view" and "generators".
26. **Downloading a structure in 1.0:** not in 1.0, the List and Timeline downloads remaining; or
    CSV of the rows with totals.

### Later stages

Each stage adds its section above when it starts. Releases across tracks (stage 4), duplicating,
linking and exporting (stage 8), the program board with dependency options (stage 5), draft
changes and scenarios (stage 6), the auto-scheduler (stage 7) and baselines, the critical path
and levelling (stage 9, built on 2026-11-14) are designed and built above. The hierarchy grid
(stage 10), which like stage 9 is T-089a and which the user brought into 1.0 on 2026-11-13, is
designed above and not built yet. PLN-002 to PLN-011 move to M1 in the spec with their stage: PLN-006 moved
with stage 2, PLN-005 and PLN-009 with stage 3, PLN-007 with stage 4, PLN-008 and PLN-013 with
stage 5, which builds PLN-013 with the program board as the user decided on 2026-11-13 (T-089i),
PLN-002 and PLN-003 with stage 6, and PLN-004 with stage 7. PLN-011 and PLN-010 move with stages 9
and 10 when these are designed, before they are built, because the user's decision of 2026-11-13
asked for their wording and milestones to be updated now; until then nothing listed a requirement
for 1.0 before its stage existed. With them every requirement of Plans (PLN-001 to PLN-014) is in
M1.

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
