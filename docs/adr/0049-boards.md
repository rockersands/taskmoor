# ADR-049: Boards on a query, read through the search compiler, moved through the ticket routes

- Status: Accepted
- Date: 2026-10-29
- Backlog: M1-043

## Context

AGL-001 to AGL-006, AGL-013 and AGL-014 (spec 01b section 3.1) ask for Scrum and Kanban boards
on a saved search covering one or more tracks, with a location and board admins; columns that
map several statuses each, an unmapped panel and min and max WIP limits whose counts include
tickets a board filter hides; swimlanes by queries (first match wins, an undeletable catch-all),
by assignee, by parent and none; board filters that combine with AND; card colours by the
first matching rule and up to 10 extra fields; days in column; a sub-filter that hides finished
work; no 5,000-ticket cap. Saved searches (M1-063) do not exist yet. M1-037 built the search
compiler with the viewer's ticket filter in every statement (QRY-008), and a ticket's workflow
depends on its type through its track's workflow map (ADR-045). Sprints (M1-044), the Kanban
backlog column and estimation (AGL-007, AGL-014 (1)) and the full board UI with drag and drop
(M1-046) come later.

## Decision

- **A board stores its query on itself** (`board.filter_query`, `board.sub_filter_query`,
  migration 0047). The API names it `source: {query}` and `subFilter: {query} | null`. M1-063
  adds `saved_search_id` beside `filter_query`, with a check that exactly one of the two is set,
  and `source: {savedSearchId}` in the API; the board then reads the saved search's query at
  each read (with its cycle detection), and existing boards keep their own query until someone
  points them at a saved search. Nothing else in the board model changes.
- **Configuration is validated JSON on the board** (`columns`, `swimlanes`, `board_filters`,
  `card_rules`; schemas in `apps/server/src/boards/model.ts`), written whole by a PATCH with an
  optional `version`. Items carry short ids the server gives (`c1`, `l1`, `f1`, `r1`) and clients
  keep, so a move names its column and a request names its active board filters. Status ids in
  columns are not foreign keys: a status deleted later maps nowhere. Board admins are a table
  (`board_admin`) so people leaving remove their rows.
- **Location and rights.** A board sits in a track (seen by those who browse it) or with the
  person who made it (seen by them and its board admins); site and configuration
  administrators see all. Board admins, the location track's administrators and those
  administrators change and delete it (AGL-001 (2)). Sharing beyond that arrives with saved
  searches.
- **Board queries resolve against the whole workspace**, not the viewer's own catalogue: they
  are shared configuration, checked against the editor's catalogue when saved. A viewer who
  does not browse one of a three-track board's tracks still sees the other two; what anyone
  sees is decided by the ticket filter in the statement alone.
- **One read, three statements** (`boards/data.ts`, read-only under the search timeout):
  1. counts per status over the board's tickets (filter query AND sub-filter AND the viewer's
     ticket filter), before board filters: column counts, WIP state and the unmapped panel
     (AGL-002 (2), AGL-003 (2));
  2. the cards: the same AND the active board filters AND a mapped status, `ORDER BY k.rank`
     (the global rank is unique per workspace), with query lanes and query colours as `CASE`
     expressions in the same statement, so the first matching lane or rule wins (AGL-004 (1),
     AGL-006 (1)); `limit` defaults to 5,000 cards and goes to 50,000, `truncated` says more
     matched;
  3. the cards' tickets again with the filter: plain joins when the card rules ask only for
     assignee, priority and dates, the ticket list's view otherwise (custom fields `cf[N]`).
  Assignee and parent lanes group the cards in the server; parent lanes follow the parents'
  rank, and a parent the viewer may not see counts as no parent. Days in column comes from the
  cards' status history: the last change from a status of another column (AGL-006 (2)).
  ORDER BY in any board query is ignored. A lane or colour query the workspace no longer reads
  matches nothing and adds a warning; a broken filter query or sub-filter answers 400.
- **A move runs the ticket routes** (`POST /api/v1/boards/:id/moves`): the board finds the
  transitions the ticket offers (the `GET /tickets/:id/transitions` handler) whose target is in
  the column; one runs, several answer 409 `transition_choice` with the list unless
  `transitionId` picks one, none answers 409 `no_transition`. Then `before` or `after` runs
  the rank handler. Handlers are called as `ticketRoutes()` plain handlers (M1-021), so every
  check, layout field, event, history row and lock is the ticket routes' own; the move route
  has no event of its own. The transition and the rank are two writes: a refused rank leaves
  the transition done and says so (`transitioned: true` in the refusal).
- **Default configuration**: one column per status stage of the board's workflows (statuses of
  every workflow the board's tracks' maps name, for every type), the lane "Expedite" with
  `priority = Urgent` (shown when the mode is queries), board filters "Only my tickets" and
  "Recently updated", type colours, assignee and priority on cards.

## Options considered

| Option | For | Against |
|---|---|---|
| Query on the board, later beside a saved search reference (chosen) | Boards work now; M1-063 adds a column and a check, no data migration | Two ways to name a board's tickets until old boards move |
| A stub saved-search table now | One shape from the start | Builds half of M1-063 (sharing, cycles, subscriptions) without its spec work |
| Columns, lanes and filters as tables | Foreign keys to statuses | Many tables and writes for configuration edited as a whole; no gain for reads |
| Lanes by running one query per lane | Simple | One statement per lane over the same tickets; first-match-wins needs exclusion lists |
| A move route with its own transaction | One event, atomic | Duplicates the transition engine's checks, layouts and locks outside the ticket routes |
| Moves made by the client (transition, then rank) | No new route | Each client re-implements choosing the transition for a column |

## Consequences

- Measured on this loaded 4-CPU machine (`routes/boards.large.test.ts`,
  `TASKMOOR_LARGE_BOARD=1`): a member reading 5,000 cards of a 50,000-ticket board with a query
  lane, query colours and days in column: p95 304 to 321 ms; with "Only my tickets" 249 to
  353 ms; all 50,000 cards at once 1.8 to 2.0 s (AGL-013 (2): loads without errors). The cards
  statement sorts the board's matches by rank; at millions of tickets per board, a board query
  that names its tracks walks `ticket_track_rank_idx`.
- Every new rule of the ticket routes reaches board moves for free. A route that changes a
  ticket's status outside a transition must not be added to moves without its own checks.
- M1-044 (sprints) adds the Scrum backlog and sprint sections; M1-046 the drag-and-drop UI on
  the same move route, virtualised rendering and the 5,000-card render budget; M1-063 the saved
  search reference; M1-093 imports boards, their filters and board filters into this model.
- Revisit the JSON configuration if boards need per-column policies that other features query
  (for example the "done" column for sprint reports: today it is the rightmost column).

## Drag and drop (M1-046)

- **The browser's own drag and drop**, no library: a card is draggable; a cell takes the drop
  and shows where it would land (the cell outlined, a line above the card it would go before:
  the pointer in a card's top half means before it, the bottom half after it). A drop sends the
  same move as the keyboard and the Move menu: one request with the column and `before` or
  `after`, so the transition, its checks, the "which transition" question and the rank all come
  from the move route. A drop where the card already is sends nothing. Lanes do not change on a
  drop (a lane by assignee or query is not a place to move to).
- **Phones** move cards with the Move menu and the keyboard: touch dragging in browsers is
  uneven and would fight scrolling the columns.
- **Rendering**: the cards are grouped by cell once per render, with each card's place, instead
  of filtering the list per card. 5,000 cards render in 455 to 458 ms after the data arrives
  (Chromium, `FiveThousandCards` story, two runs in each skin; budget 1 s), so no virtualised
  list was needed; revisit at the 50,000-card load of AGL-013 (2).

## Filtering by person (AGL-005 (3))

- **One way of filtering:** `GET /api/v1/boards/:id/data?people=me,none,12` becomes one more board
  filter, `assignee IN (currentUser(), 12) OR assignee IS EMPTY`, and runs in the same compiler with
  the viewer's ticket filter. Filtering in the browser would miss cards past the 5,000 limit, and
  a second code path could widen what someone sees. Column counts stay whole, as for any board
  filter.
- **Who to offer** comes with the data read, one statement over the viewer's tickets in a mapped
  status, before any filter, so choosing a person does not empty the list. Up to 500 names; the
  answer says when there are more. Reading the cards instead would miss those past the limit, and a
  card only carries its assignee when the card rules ask for it.
- **The address** holds the choice (`?people=`), per viewer, so a filtered board can be shared.
  `me` means whoever opens the link. An id with no tickets the viewer sees shows no name: nothing
  says who that id is.
