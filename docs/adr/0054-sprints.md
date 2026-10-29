# ADR-054: Sprints owned by a board, membership rows and scope-change rows

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-044

## Context

AGL-010 asks for the sprint lifecycle of spec 01b section 3.2: states future, active and closed;
create, edit name, goal and dates, reorder future sprints, start, add or remove tickets while
active (logged as scope change), complete (unfinished tickets to the backlog, a future sprint or
a new sprint; "done" is the board's rightmost column), reopen, delete including completed
sprints (which then leave reports while their tickets keep their history). AGL-011 asks for
several active sprints per board and shared sprints, where completing carries over only the
completing board's tickets. AGL-007 asks each Scrum board to choose its estimation statistic
(points or the original time estimate) and time tracking (none, or remaining estimate and time
spent): switching changes card estimates and sprint totals, and logging time lowers the
sprint's remaining total. The next tasks read what this one stores: sprint query functions and
`sprint = <id>` (M1-045), drag and drop (M1-046), burndown and the report event store
(M1-059, M1-062).

## Decision

- **A sprint belongs to one board** (`sprint.board_id`, migration 0052) with a `sequence` that
  orders the board's sprints; reordering renumbers the future ones after every started one.
  Sprints exist on Scrum boards only (409 `not_scrum`).
- **Membership is a table, history is another.** `sprint_ticket` holds which tickets are in
  which sprint; `open` is true while the sprint is future or active, and a partial unique index
  keeps a ticket in one open sprint at most. A closed sprint keeps its rows (`open = false`), so
  a ticket carried over is in both, as `sprint = 1 AND sprint = 2` and `openSprints()` need.
  Leaving an open sprint deletes the membership row. `sprint_change` records every change with
  its time, author and the ticket's estimate then (`original_estimate`, `remaining_estimate`,
  `points` for the board's number field): `added`, `removed`, `committed` (one per ticket at the
  start), `completed` and `carried_over` (one per ticket at completion, with `to_sprint_id`).
  `after_start` marks scope change.
- **The report is computed from those rows**, by the board's current statistic: per ticket the
  estimate at entry (committed or added) and at the end (the completion row, the removal row, or
  the live ticket while active); totals committed, added after start, removed, completed, not
  completed and the estimate change; the remaining estimate of unfinished tickets while active
  and time tracking is on. Only tickets the viewer may see appear.
- **Done is the board's rightmost column** (ADR-049), read at completion and in the backlog.
- **Shared sprints**: tickets of a sprint that the completing board's query no longer matches
  (whoever may see them) go to the backlog; only the board's own unfinished tickets carry over.
- **Deleting**: a future sprint is deleted outright (its tickets return to the backlog); an
  active one is refused (409); a closed one gets `deleted_at` and leaves lists and reports
  while its rows stay.
- **Board settings** `board.sprint_settings` (JSON, validated): `estimation.statistic`
  (`ticketCount`, `originalEstimate` or `field` with a number field's id), `timeTracking`
  (`none`, `remainingEstimate`) and `parallelSprints` (off by default: starting a second sprint
  answers 409 `sprint_active`). They are written by the board's PATCH as `sprintSettings`.
- **Rights**: managing sprints (create, edit, reorder, start, complete, delete) needs "Manage
  sprints" in the board's track or the right to configure the board; adding and removing
  tickets needs "Schedule tickets" or "Edit tickets" in each ticket's track, and the ticket must
  be on the board for the caller.
- **Events**: `sprint.created`, `.updated`, `.reordered`, `.started`, `.completed`, `.deleted`
  (audited) and `.tickets_added`, `.tickets_removed` (not audited: planning activity whose
  history is in `sprint_change`); one per route, in its transaction. A completion that makes a
  new sprint names it in `sprint.completed` (`toSprintId`) rather than emitting a second event.
- **Board view**: `GET /boards/:id/data?sprints=active` limits the cards to the active sprints'
  tickets; the web Scrum board asks for it. `GET /boards/:id/backlog` gives the sprint sections
  and the backlog (unfinished tickets in no open sprint) in rank order with totals.

## Auto-rolling cycles (M1-045; AGL-012)

- **Setting**: `sprintSettings.cycle` on a Scrum board, `{ lengthDays (1 to 91), timeZone
  (default UTC) }` or null. Refused with parallel sprints (`not_with_parallel_sprints`): a cycle
  rolls over the board's one active sprint.
- **The worker** runs `rollSprintCycles` every minute (`apps/server/src/sprints/cycles.ts`).
  For each board with a cycle and an active sprint: the next sprint is ready (the first future
  one in the board's order, or one made from the active sprint's end for the cycle's length);
  once the end has passed, the active sprint is completed into it and it starts, both at the
  scheduled boundary, so the history reads as planned even after downtime; the worker then
  catches up one cycle at a time. A next sprint the team dated keeps its dates.
- **Days on the wall clock** of the cycle's time zone (`addWall`, as QRY-006 counts days): a
  sprint that ends at 09:00 still ends at 09:00 after a change of summer time.
- **Nobody** rolls a cycle: the events and `sprint_change` rows have no actor. The first sprint
  of a cycle is started by a person; without an active sprint nothing happens.
- **Concurrency**: each roll is a transaction that takes the board's lock without waiting (`FOR
  UPDATE SKIP LOCKED`); a board someone is changing is left for the next pass, and two workers
  never roll a board twice.
- **One lifecycle**: creating, starting and completing a sprint are functions
  (`sprints/lifecycle.ts`) that the routes and the worker share; they take an actor instead of
  the request.
- **Not yet**: the web UI for sprint settings (API only, as the rest of M1-044's settings).

## Options considered

| Option | For | Against |
|---|---|---|
| Membership table plus change rows (chosen) | Queries read membership directly; reports and burndown replay the rows | Two writes per change |
| A multi-valued sprint field on the ticket | One place, like an imported Jira field | History only through the change log; no index for `sprint = <id>` |
| Rows written by an event subscriber | Routes stay thin | Subscribers run after the transaction, at least once; the report could miss or double a change |
| Estimates read only from the change log at report time | No copies | Every report replays field history; points fields stored in JSON need per-field reads |

## Consequences

- Measured on this loaded 4-CPU machine (`routes/sprints.large.test.ts`,
  `TASKMOOR_LARGE_SPRINTS=1`, a member on a 20,000-ticket Scrum board): adding 500 tickets
  73 to 82 ms, the backlog (2,000 rows) p95 55 to 59 ms, the report of a 1,000-ticket sprint
  p95 57 to 60 ms, completing it into the next sprint 162 to 230 ms.
- M1-045 added `sprint` to the query catalogue over `sprint_ticket` and `openSprints()`,
  `closedSprints()`, `futureSprints()` over `sprint.state`, without a schema change (ADR-010,
  "Functions (M1-045)").
- M1-062 (burndown) needs estimate changes during the sprint over time: the ticket change log
  (M1-031) has them with their times; `sprint_change` gives the scope at each moment.
- The estimate snapshot keeps the original and remaining estimate and the board's number field
  at the time; switching the statistic to a different number field mid-sprint reads entry values
  that were taken for the old field (they show as no estimate).
- Not built: reopening a closed sprint, linking a wiki page, the completion block while done
  tickets have unfinished subtickets (spec says "verify"), sprints on more than one board as a
  stored relation (sharing is by the tickets a board's query shows), per-team velocity
  (AGL-011 (3), with the velocity chart), auto-rolling cycles (AGL-012, M1-045).
