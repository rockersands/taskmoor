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
  searches.
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

The terminology file maps the other product's "Plans" to our "roadmaps". The user named the
feature Multi-track and calls one a plan; "plan" is ordinary English for it, the feature's name is
our own, and the terminology file now lists Multi-track. If the user prefers another word for one
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
  its sources are hidden from them, never which. A plan with no visible source finds nothing:
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
  view once there are more than 200 (rows are a fixed 44px), for the track's timeline too.
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
- A refusal says why in plain words, from the ticket route's codes: no permission to schedule,
  an archived track, a ticket gone or hidden, dates that are not valid.

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

### Later stages

Each adds its section here when it starts: dependencies (T-089; PLN-006), teams and capacity
(T-089b; PLN-005, PLN-009), cross-track releases (T-089c; PLN-007), the program board (T-089d;
PLN-008), draft changes and scenarios (T-089e; PLN-002, PLN-003), the auto-scheduler (T-089f;
PLN-004), duplicating a plan, a link to a view and exports (T-089g). PLN-002 to PLN-009 move to M1
in the spec with their stage, so nothing lists them for 1.0 before they exist.

## Options considered

| Option | For | Against |
|---|---|---|
| The plan's tickets as text composed per viewer (chosen) | One compiler and one permission filter for every view; numbers equal their searches; the List is the search | A long text for a plan of hundreds of tracks; each view binds it again |
| The plan's tickets as SQL joined from sources | No text to build | A second way to read saved searches, outside the search's checks; no link to a search |
| Board sources | As PLN-001 first said | Each board belongs to one track; the track does the same |
| Filters with several values each | Fewer clicks for some views | The user chose one value at first |
| Group by outcome in the List | Asked in the first plan | The query language cannot yet say "under this outcome", so a group could not link to its search |
| A stored list of the plan's tickets | Fast to read | Out of date at once, and the same for every viewer |

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
