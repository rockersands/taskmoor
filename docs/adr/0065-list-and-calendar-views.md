# ADR-065: List and calendar views over search, format rules as query conditions

- Status: Accepted
- Date: 2026-10-30
- Backlog: M1-049

## Context

AGL-016 asks for a spreadsheet-like list of a track with inline create and edit, sort, filter,
group, rank, selectable columns and conditional format rules for cells and rows: a rule
"due < now() and stage != closed" colours overdue rows red, and grouping by assignee shows
counts per group. AGL-017 asks for a calendar by start and due day with sprints and releases,
drag to reschedule (a ticket dragged to another day is due there) and an iCal feed per saved
view. M1-049's done-when: inline edit of 50 rows and drag-to-reschedule e2e green, format rule
tests green. The search results table already edits cells in place through the ticket route
(ADR-052), the two-dimensional report counts tickets per field value (ADR-059), and the
timeline reads a track's sprints and releases (ADR-064).

## Decision

- **The list is search**: `#/tracks/<KEY>/list` runs `track = KEY [AND (filter)] ORDER BY ...`
  through the search route, fifty tickets at a time, in the search results' table (inline edit
  included). Sorts: newest, recently updated, due date, priority. **Groups** come from the
  two-dimensional report with the field as rows and the track as the one column, so each
  group's count is exact; each group lists its own tickets with its condition added (`field =
  id`, `field IS EMPTY`; values beyond the report's fifty are counted as "other" and not
  listed). A ticket is made at the end of the list from its summary.
- **Format rules are query conditions** checked by the server:
  `POST /api/v1/search/format-rules` takes the ids shown (at most 500) and the rules (at most
  20) and answers, per rule, the ids its condition matches, compiled through the search
  compiler with the viewer's ticket filter, so a rule can say anything a search can and never
  reveals a ticket the viewer may not see. A condition that does not compile comes back as that
  rule's error; the others still apply. A rule colours the row or one column in one of four
  tones, and its name stands beside the ticket's key, so colour is never the only sign.
- **Kept per person in the browser**: the list's columns and rules live in `localStorage` per
  track, as the search page's columns do (ADR-052); shared views are AGL-020's, later.
- **Calendar**: `GET /api/v1/tracks/:keyOrId/calendar?from=&to=` (at most 100 days) gives the
  viewer's tickets of the track with a start or due day in the range (at most 1,000), and the
  sprints of boards in the track's space and its releases that overlap it.
  `#/tracks/<KEY>/calendar` shows a month in weeks from Monday: each ticket on its due day,
  and on its start day when that differs (marked as a start); sprints as bands named on their
  first day and on Mondays, releases on their day, today marked. Dragging a ticket's due entry
  to another day moves its due day there and its start along (the same length); dragging a
  start moves the start (and the due day along if it would come first). Alt with the arrows
  moves a focused entry by a day or a week; choosing it opens both days in a panel (the phone's
  way). Every move is `PATCH /tickets/:key`, so the Schedule permission and history apply.
- **Phones**: the list's table scrolls inside its region; the calendar becomes a list of the
  month's days. Since T-162b (2026-11-04; ADR-114, section 12) a drag is pointer events, not the
  browser's own: a finger drags an entry by its grip, which pressed also opens a menu of the moves
  the keys make, and a mouse drags the entry itself.

## Options considered

| Option | For | Against |
|---|---|---|
| Rules as query conditions on the server (chosen) | Any search condition; the viewer's filter; one meaning everywhere | A round trip per change of rows or rules |
| Rules evaluated in the browser on the loaded fields | No server call | A second evaluator of the query language; fields not loaded cannot be tested |
| Group counts from the loaded rows | No extra call | Wrong once a group has more tickets than were loaded |
| Rules and columns stored on the server now | Shared, follow the person | That is saved views (AGL-020), a ticket of its own |

## Consequences

- Not built here: ranking in the list (rank is not a query field; boards and the backlog rank),
  AGL-016 (3) (10,000 rows scrolled without blank frames: the list pages by fifty), the iCal
  feed (AGL-017 (2)), saved and shared views (AGL-020), inline create inside a group.

## As built: ordering by type, key and the headings (T-330, 2026-11-17)

The user asked to order a list by priority, last updated, type or key, and chose both ways in:
**Type** and **Key** join the **Sort by** menu, and a click on a column's heading sorts by it,
again for the other way. It applies to a track's List and a plan's List (PLN-012), which share it.

- **One order, a column and a direction** (`apps/web/src/list/order.ts`), for the menu and the
  headings. The search results table gets an opt-in `onSort`: only the columns the query language
  can order by become buttons inside their `th` (labels, the track and the parent stay words); the
  `th` keeps `aria-sort` and the arrow, and the button is named by the heading's words. Search
  passes no `onSort`, so its headings are unchanged. Phones show stacked rows with no headings, so
  there the menu orders; on a touch screen a heading's button is 44 px.
- **Each column's own direction**, taken by the menu's entries and a first click: times past
  (created, updated, closed) newest first, start and due soonest first, priority and votes highest
  first, the key by ticket number within a track (`ORDER BY key` is the track's key, then the
  number as an integer, so ABC-9 comes before ABC-10), and names, types, statuses and releases
  from the start of their order (types by name, A to Z). Ties go by id, as every search.
- **The menu shows the truth with one control.** Its entries stay orders (Newest created first,
  Recently updated, Due date, Priority, Type, Key). When a heading chose an order it has no entry
  for, another column or one reversed, an extra first entry names it in the words search uses,
  "Summary, ascending" or "Updated, earliest first", and goes away once an entry is chosen. We did
  not split the menu into a column and a direction control: two controls for one choice on every
  list, where the reversed order is mainly the headings' business.
- **The address holds it** as the query language names it: `sort=key`, with `order=asc` or
  `order=desc` only when it goes against the column's own way, and nothing for the default. The
  addresses made before (`sort=priority`, `sort=due` on a plan's List) open as they did. A
  track's List now keeps its order in its address too (`#/tracks/KEY/list?sort=key`).
- **The plan's file follows it** (PLN-014): `GET /plans/:id/export` takes `sort` as any field the
  List can order by (or `cf[N]`) and `order=asc|desc`; without `order` a field goes its own way, so
  an old link's file is unchanged. Anything else is refused with 400.
