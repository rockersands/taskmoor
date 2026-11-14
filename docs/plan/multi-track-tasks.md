# Multi-track: tasks

One plan that brings together work from several tracks and saved searches, so someone leading
several teams can see it in one place without changing how those teams work. All of it is in 1.0
(the user's decision, 2026-11-03, `docs/plan/decisions.csv` rows "Multi-track scope" and
"Multi-track first rules"), and since 2026-11-13 the hierarchy grid (PLN-010) and baselines,
the critical path and levelling (PLN-011) too (row "Hierarchy grid and baselines"). ADR-122 holds
the decisions, with a section per stage.

## Handoff (2026-11-03, third stage built)

**State: MT-01 (T-088) and MT-02 (T-089) are on `main`. MT-03 (T-089b, teams and capacity) is
built on `wave5/t089b-plan-capacity`, waiting for the coordinator's gate and merge.** MT-04 to
MT-08 (T-089c to T-089g) have not started.

- **Done (MT-03):** migration `0102_plan_capacity` (the plan's unit and periods as columns of
  `plan`; `plan_team`; `plan_capacity`); PLN-005 and PLN-009 reworded to what is built and moved
  to M1 (spec and `requirements-index.csv`); ADR-122's stage 3 section. Server:
  `routes/plan-capacity.ts` (`GET` and `PUT /plans/:id/capacity`), `plans/periods.ts`; teams,
  unit and periods in `PATCH /plans/:id`; one `plan.capacity_set` event, audited, with its
  contract scenario; scope classes read and write; capacity in the data download and deleted on
  erasure. Web: the plan's **Capacity** tab (`PlanCapacityPage`, a table on a desktop, a card per
  row on a phone), `CapacityDialog`, `TeamPicker` and **Teams and capacity** in Settings. Manual:
  the Teams and capacity section of `docs/manual/use/multi-track.md`, and capacity in the data
  download and erasure of `docs/manual/admin/people-and-groups.md`.
- **Rules:** a ticket counts whole in the period of its due day, for its assignee and each plan
  team they are in; every count equals its search (row, period and the plan's query ANDed); a
  team member's other work due then (outside the plan, filtered out or hidden) counts against
  their capacity as one number, never named; over capacity is red and says so in words.
- **Tests:** `plan-capacity.test.ts` (10: numbers equal their searches for three viewers, hidden
  work only counted, filters, months, hours, an empty team, the anchor, teams leaving),
  `privacy.test.ts` (download and erasure), the contract and scope tests,
  `PlanCapacity.test.tsx` (8), stories `Plans/PlanPage` `Capacity`, `CapacityOnAPhone`,
  `CapacityWithoutTeams`, `Settings` and `Plans/CapacityDialog` (axe, both skins), e2e
  `plan-capacity.spec.ts` (desktop and phone). The size test reads Capacity too: 8 ms at
  10,000 tickets, 23 ms at 100,000 (`TASKMOOR_LARGE_PLANS=1`).
- **Kept, not built (an open question for the user, in ADR-122 stage 3):** velocity from
  history, other teams' sprints as external iterations, days and percent with a working week,
  allocations to outcomes and free-text entries, bulk copy, paste and fill, CSV import, and
  re-running scheduling previews (with the auto-scheduler, MT-07). They need a requirement ID of
  their own, which this stage was not given.
- **Half-done:** nothing.

### Second stage (MT-02, on `main`)

- **Done (MT-02):** PLN-006 reworded to what is built and moved to M1 (spec and
  `requirements-index.csv`); ADR-122's stage 2 section. Server: `GET /plans/:id/timeline` reads
  every blocking link into a listed ticket in one statement and answers `blockersElsewhere`
  (per blocked ticket: `outside`, outside the plan or hidden, never named; `unlisted`, the plan's
  own left out by filters or the 10,000); `planTickets` also gives `unfiltered`. No migration,
  route, event or permission. Web: `apps/web/src/timeline/dependencies.ts` (the late rule, one for
  lines, badges and list), badges in `TimelineView` (prop `dependencies`, plus `tools`),
  `DependencyList` below the plan's Timeline with a button that focuses it, the side panel's late
  and counted blockers. Manual: the Dependencies section of `docs/manual/use/multi-track.md`, one
  line in `views.md` (a track's lines follow the same late rule now).
- **Tests:** `plan-dependencies.test.ts` (visibility of blockers: hidden ones only counted, never
  named; the trash and other link types left out; filters counted apart), `dependencies.test.ts`,
  `DependencyList.test.tsx`, `PlanDependencies.test.tsx`, stories `Timeline/DependencyList` and
  `Plans/PlanPage` `TimelineDependencies` (axe, both skins), e2e `plan-dependencies.spec.ts`
  (desktop and phone). The size test now carries about 8,000 links at 10,000 tickets and 80,000 at
  100,000, plus a blocker the first 10,000 leave out and one outside the plan, both checked:
  Timeline 136 ms, filtered 30 to 42 ms at 100,000.
- **Kept, not built:** other link types as dependencies, and flagging dependencies within one
  sprint (both were in PLN-006's first wording, which the user put in 1.0) are now PLN-013, M2 in
  the spec, in no stage yet. Outside blockers are a count only (the coordinator's brief), not
  "with its track and status" as the first wording said. Both wait for the user's answer in
  `decisions.csv` ("Dependency options"); Claude recommends PLN-013 with the program board (MT-05).
- **Half-done:** nothing.

### First stage (MT-01, on `main`)

- **Done (MT-01):** migration `0101_plans` (`plan`, `plan_source`, `plan_share`); ADR-122 Accepted
  with the stage 1 section; PLN-001 reworded (no board sources, a plan gives no access) and moved to
  M1; PLN-012 added (views, grouping, filters, rescheduling) for M1; the terminology file lists
  Multi-track. Server: `apps/server/src/plans/` (model, per-viewer query), `routes/plans.ts`
  (CRUD, choices), `routes/plan-views.ts` (summary, timeline, calendar); three `plan.*` events,
  audited; plans in the data download. Web: `apps/web/src/plans/`, the sidebar entry
  **Multi-track** under "Plan and track", `TimelineView` and `CalendarView` shared with the track
  pages. Manual: `docs/manual/use/multi-track.md`.
- **Measured:** a plan of 20 tracks and 100,000 tickets, medians of five reads:
  page 3 ms, summary 53 ms, timeline 126 ms, calendar 40 ms, filtered timeline 28 ms, choices
  32 ms, the List's search 6 ms and its groups 66 ms (`plans.large.test.ts` with
  `TASKMOOR_LARGE_PLANS=1`; every gate runs the same at 10,000 tickets).
- **Half-done:** nothing.
- **Not measured:** PLN-001 (1), 300 tracks and 50,000 tickets in under 3 s. The 20-track
  measurement above suggests it holds; `plans.large.test.ts` takes the size as constants.
- **Still outside M1 in the spec:** nothing. PLN-006 moved to M1
  with MT-02, PLN-005 and PLN-009 with MT-03, PLN-007 with MT-04, PLN-008 and PLN-013 with MT-05,
  PLN-002 and PLN-003 with MT-06 and PLN-004 with MT-07. Each moved to M1 with its stage, so nothing
  listed them for 1.0 before they existed. PLN-010 (from M2) and PLN-011 (from M4) moved to M1 as
  Musts with ADR-122's stages 10 and 9 when they were designed (2026-11-14), reworded to what is
  built; PLN-011 is built as MT-09 and PLN-010 as MT-10.

### Open question for the user (not blocking)

- The terminology file mapped the other product's "Plans" to our "roadmaps". The user named the
  feature Multi-track and calls one a plan, so the UI says "plan". If the user prefers another word
  for one plan, it is the UI strings and the manual; tables and routes can keep `plan`.

### What the code gives the next stages

- **One way to a plan's tickets:** `planTickets()` in `apps/server/src/plans/query.ts` composes the
  viewer's query (tracks they may search, saved searches that run for them) and compiles it with
  their filter. Every later view reads through it, so no stage can widen access.
- **Sources:** `plan_source.kind` takes new kinds (`team`?) without a new table.
- **Settings:** `plan` takes columns (working days, estimation units, financial year start).
- **Timeline:** `TimelineView` takes `groupOf`, draws only the rows in view past 200, and its items
  carry `links` (blocking, with direction). Since MT-02 it also takes `dependencies` (badges) and
  `tools`; `dependenciesOf` and `dependencyState` hold the late rule, which the program board
  (MT-05) and the auto-scheduler (MT-07) can reuse.
- **Rescheduling** is `client.reschedule` on the plan page; scenarios (MT-06) replace it with a
  draft change.
- **Refusals in plain words:** `apps/web/src/timeline/refusal.ts`.
- **Grouping by outcome** waits for a query condition "under this outcome" (the dialect already
  maps `parentEpic` to `parentOutcome`, which the search does not implement yet): then the List can
  link each group to its search. The Timeline already puts outcomes above their children.
- **Capacity** (MT-03): `plan_capacity` and `apps/server/src/plans/periods.ts` hold capacity per team and person
  and the plan's periods; the auto-scheduler (MT-07) and the program board (MT-05) can read them.
  `GET /plans/:id/capacity` counts work by due day; a team's sprints as periods, and velocity,
  would be a new `period_kind`.

### Tickets, in order

Each is its own commit and ADR-122 section, with a one-line note to the coordinator when done. Clean
room: our own spec only, no Atlassian site, product or connection. A plan gives no access in any part.

| Ticket | Backlog | What | Spec | Migration | State |
|---|---|---|---|---|---|
| MT-01 | T-088 | Plans with sources and sharing; Summary, Timeline, List and Calendar; group and filter in the address; the size limit; sidebar entry. PLN-001 moved to M1, PLN-012 added | PLN-001, PLN-012 | 0101 | On `main` |
| MT-02 | T-089 | Dependencies view: lines and badges, late ones red, blockers outside the plan | PLN-006 | none | On `main` |
| MT-03 | T-089b | Teams and capacity, individual capacity: a Capacity view per team, person and period, capacity per team and person for every period or one, over capacity in red and in words, hidden work only counted | PLN-005, PLN-009 | 0102 | Built on `wave5/t089b-plan-capacity`, waiting for the gate |
| MT-04 | T-089c | Releases across tracks | PLN-007 | 0106 | Built on `wave8/multi-track-stages`, waiting for the coordinator's gate and merge |
| MT-05 | T-089d | Program board, edited in real time with the existing sync and Yjs tools where they fit | PLN-008 | next free | To do |
| MT-06 | T-089e | Draft changes and scenarios | PLN-002, PLN-003 | 0110 | Built on `wave15/t089e-scenarios`, waiting for the gate and merge |
| MT-07 | T-089f | Auto-scheduler, previewed as draft changes: a run places a plan's open level-0 tickets in its periods within capacity, blockers first, as scheduler drafts in a scenario, with a reason per ticket. PLN-004 reworded and moved to M1 | PLN-004 | none | Built on `wave18/t089f-auto-scheduler`, waiting for the gate and merge |
| MT-08 | T-089g | Duplicate a plan, a link to any view, CSV and image export | PLN-014 | none | Built on `wave8/multi-track-stages`, waiting for the coordinator's gate and merge |
| MT-09 | T-089a | Baselines, the critical path and levelling (ADR-122 stage 9): named baselines of a plan's own and sprint days, from Live or a scenario, compared with the days now in calendar days; the critical path with each ticket's slack, over the whole plan the viewer is shown; and Even out load, a mode of the auto-scheduler's run that moves only work putting someone over capacity, later, keeping its length. PLN-011 reworded and moved to M1 | PLN-011 | 0111 | Built on `wave19/t089a-hierarchy-baselines`, waiting for the gate and merge |
| MT-10 | T-089a | The hierarchy grid (ADR-122 stage 10): a plan's Grid section, built for each viewer from structures the plan's editors save (Add tickets, up to two Group by, Add children down every level, up to two Add linked tickets), with ticket columns edited in place, totals of the rows below and formula columns computed in the browser, up to 100,000 rows; one row moved under another parent by dragging or Move under, after confirmation, through the ticket's own change; live and read-only in a scenario; hidden tickets only counted. PLN-010 reworded and moved to M1 | PLN-010 | 0112 | Built on `wave20/t089a-hierarchy-grid`, waiting for the gate and merge |

Migration numbers: take the next free one on `main` when each stage starts (MT-03 took 0102).

**Every ticket delivers:** spec, ADR section, routes with events, contract scenarios, audit
decisions and scope classes, tests citing requirement IDs, en and es strings, shared glass styles and
motion tokens (respecting reduced motion), stories with axe in both skins, phones, an e2e spec, and
the manual page (`docs/manual/use/multi-track.md`).
