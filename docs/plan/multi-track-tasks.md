# Multi-track: tasks

One plan that brings together work from several tracks and saved searches, so someone leading
several teams can see it in one place without changing how those teams work. All of it is in 1.0
except the hierarchy grid (PLN-010) and baselines (PLN-011) (the user's decision, 2026-11-03,
`docs/plan/decisions.csv` rows "Multi-track scope" and "Multi-track first rules"). ADR-122 holds
the decisions, with a section per stage.

## Handoff (2026-11-03, second stage built)

**State: MT-01 (T-088) is on `main`. MT-02 (T-089, dependencies) is built on
`wave4/t089-plan-dependencies`, waiting for the coordinator's gate and merge.** MT-03 to MT-08
(T-089b to T-089g) have not started.

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
- **Still M2 in the spec:** PLN-002 to PLN-005, PLN-007 to PLN-009 and PLN-013 (PLN-006 moved with
  MT-02). Each moves to M1 with its stage, so nothing lists them for 1.0 before they exist.

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

### Tickets, in order

Each is its own commit and ADR-122 section, with a one-line note to the coordinator when done. Clean
room: our own spec only, no Atlassian site, product or connection. A plan gives no access in any part.

| Ticket | Backlog | What | Spec | Migration | State |
|---|---|---|---|---|---|
| MT-01 | T-088 | Plans with sources and sharing; Summary, Timeline, List and Calendar; group and filter in the address; the size limit; sidebar entry. PLN-001 moved to M1, PLN-012 added | PLN-001, PLN-012 | 0101 | On `main` |
| MT-02 | T-089 | Dependencies view: lines and badges, late ones red, blockers outside the plan | PLN-006 | none | Built on `wave4/t089-plan-dependencies`, waiting for the gate |
| MT-03 | T-089b | Teams and capacity, individual capacity | PLN-005, PLN-009 | next free | To do |
| MT-04 | T-089c | Releases across tracks | PLN-007 | next free | To do |
| MT-05 | T-089d | Program board, edited in real time with the existing sync and Yjs tools where they fit | PLN-008 | next free | To do |
| MT-06 | T-089e | Draft changes and scenarios | PLN-002, PLN-003 | next free | To do |
| MT-07 | T-089f | Auto-scheduler, previewed as draft changes | PLN-004 | none expected | To do |
| MT-08 | T-089g | Duplicate a plan, a link to any view, CSV and image export | our own wording | none expected | To do |

PLN-010 (hierarchy grid) and PLN-011 (baselines) are not in this scope unless the user says so.
Migration numbers: take the next free one on `main` when each stage starts (0102 and 0103 were held
for this ticket and not used).

**Every ticket delivers:** spec, ADR section, routes with events, contract scenarios, audit
decisions and scope classes, tests citing requirement IDs, en and es strings, shared glass styles and
motion tokens (respecting reduced motion), stories with axe in both skins, phones, an e2e spec, and
the manual page (`docs/manual/use/multi-track.md`).
