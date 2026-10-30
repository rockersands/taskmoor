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
  month's days.

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
