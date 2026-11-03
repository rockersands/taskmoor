# ADR-116: One place per track, one board per track, and a column is a status

- Status: Accepted (the user's decisions, 2026-11-03)
- Date: 2026-11-03
- Tasks: `docs/plan/ui-overhaul-tasks.md` (UI-T04, UI-T16)

## Context

The user tested the board on the demo and asked for simpler rules: every track is one place with
its own sections, a track has one board, a column's name is the status itself, and moving a ticket
between columns is seamless, with any reason written in a comment. They confirmed the word "Track"
stays. ADR-049 (boards) and ADR-079 (board-managed workflows) stand where this ADR does not change
them.

## Decision

- **A track's sections** share one tab bar: Summary, Board, Backlog, List, Calendar, Timeline,
  Outcomes, Releases, Files and links, Statistics (Outcomes added 2026-11-03, below). List and Releases were not in the user's list of sections;
  they stay because those pages exist and nothing replaces them. The sidebar has "Tracks" and no
  "Boards". "Tracks" opens the directory and expands with the current track, then the latest
  opened, up to eight, with a link to all of them; it collapses when the person leaves every track.
  **2026-11-03: the user replaced that list with one plain link to the directory, because there
  could be many tracks.** "Tracks" no longer expands; it shows as current inside a track, on a
  ticket and on a board.
- **One board per track, none outside a track,** enforced by the server and by the unique index
  `board_one_per_track_idx` (migration 0088).
  - A track gets its board from its template, or the first time anyone who can see it opens it
    (`GET /api/v1/tracks/:id/board`). A board made that way has no board administrators; the track's
    administrators configure it.
  - `POST /api/v1/boards` refuses a second board (`409 track_has_board`), a board with no track and
    a board across tracks. Scrum or Kanban stays a setting of the board.
  - A query in the API may narrow within the track (`track = KEY AND ...`), since it cannot show
    another track; the web app offers only board filters.
  - Boards from before the rule are not removed. A board whose query is exactly one track becomes
    that track's board if it has none; the others stay readable, kept by a person.
  - An import keeps a track's first board and makes the others saved searches, listed in the
    fidelity report. The Jira-compatible Agile API only reads boards.
- **A column is a status,** one to one, on a track's own board:
  - Where nobody else shares the workflow and nobody configured guards, checks or rules on it, the
    board manages it (ADR-079): a new column makes a status, renaming a column renames its status
    (or gives the column a status of its own when other workflows use that one), any card moves to
    any column.
  - A workflow other tracks share never changes by itself. The board read says which column no card
    can reach, the settings name the tracks affected, and someone allowed to edit workflows can add
    the status and steps as a new version (`POST /api/v1/boards/:id/columns/:columnId/path`). Others
    see who can.
  - Mapping several statuses to one column remains for boards that do not manage their workflow:
    it is reachable in board settings and through the API, and imported boards rely on it.
- **Moves are seamless by default.** The workflow a new site starts with (migration 0089) lets any
  ticket go to any status with nothing asked. Entering Closed sets the close reason Completed;
  leaving it clears the reason. A workflow an administrator edited, and any imported one, keeps its
  rules. Only such a rule brings up a form or a refusal, in plain words. A ticket's status is one
  control on its page.
- **A board stays inside its track** after it is made. A saved search a track's board stands on
  cannot be changed to a query that leaves the track (`409 board_outside_track`, naming the boards).
  An import writes a track's board only with a query confined to it: anything else becomes
  `track = KEY`, with the warning `board_query_narrowed_to_track` holding the source's query.
- **Statistics** is every report of the track in one place: flow, sprints, releases and outcomes,
  and its tickets. The ticket reports reuse the dashboard widgets' data and views through
  `GET /api/v1/tracks/:id/statistics/:kind`, which takes no query: it is the track, read through the
  viewer's filter. A board's report addresses lead into the track's tabs. A board an upgrade left
  outside a track keeps the page at its own address.
- **A Kanban track has no Backlog at all** (the user, 2026-11-03: it must not show, not greyed out).
  This replaces AGL-014 (1), the optional Kanban backlog, which was never built.
  - The track's `backlog` and `sprints` toggles (CORE-002) fit this and are what the rule uses, with
    one addition. Until now nothing read them, and a change of kind left them as they were. Now a
    board's kind sets both, when the board is made and when its kind changes, in the same transaction
    (`track.updated`); migration 0094 aligned existing tracks.
  - `GET /api/v1/tracks/:id` answers `sections: { backlog, sprints }`: a Scrum board and the toggle on.
    The board's kind is still checked there because a Blank track's toggles are on before its first
    board, which will be Kanban, and because someone can set a toggle by hand through the API.
  - On such a track the Backlog tab and links are gone, and so are the Sprints and Releases groups of
    Statistics (all five reports answer `not_scrum` on the server), sprint widgets on a customized
    Summary and in its editor, and sprint bands and dates on the timeline and calendar. The backlog's
    address says the track has none and leads to the board. An old link to a sprint report says what
    it needs. Sprints are kept and come back with Scrum.
  - The web app's tab bar reads the sections on each change of section, and the board's settings tell
    it at once when the kind changes. Someone else's change reaches a person's next page, not their
    open one.
  - Tickets that were in a Scrum backlog stay on the board as Kanban, as a Kanban board reads every
    ticket of its query and no sprint.
  - A running sprint has to be completed first, whichever way sprints go off (AGL-010): a board
    does not change to Kanban, and a track's `sprints` toggle is not turned off by hand, while one
    of its sprints is active (`409 sprint_running`, naming the first by id; every one of them with
    parallel sprints). The refusal writes nothing and records no event. From the other side, a
    planned sprint does not start on a Kanban board (`not_scrum`) or on a track whose sprints are
    off (`sprints_off`). Both sides take the board's lock, the toggle before the track's, the same
    order as a change of kind, so neither slips past the other. Administration > Tracks shows the
    toggle and the refusal in plain words, with a link to the board to complete the sprint (T-192).
  - The `sprints` toggle does not go on by hand for a track whose board is Kanban or that has no
    board yet (`409 not_scrum`, with `boardId` or `null`), so the stored toggle never disagrees with
    the kind. Administration > Tracks offers the toggle only on a track with a Scrum board and says
    why elsewhere, with a link to the board; the backlog hides **Start sprint** while the track's
    sprints are off and says why.
- **Summary** works as a dashboard the track's owner and administrators can customize, using the
  existing widgets, and that everyone else who can see the track reads as it is.
  - A track has at most one customized Summary, in its own table (`track_summary_layout`, migration
    0090), not a dashboard: a dashboard has an owner and shares, while this belongs to the track, and
    no rule about owners, sharing or the Dashboards list has to make an exception for it.
  - Until someone customizes it the page shows the default numbers; `Customize` starts from them as
    a widget (`track-summary`, allowed nowhere else). `Back to the default` removes the row.
  - The server holds the rule: only those who may administer the track and its owner change it, and
    not while the track is archived. A site administrator holds every track's rights; a configuration
    administrator does not, by that alone.
  - Each widget is read as the viewer. An empty query means the track, and the viewer's own lists
    (assigned, followed) stay inside it. A query someone wrote is used as written and still goes
    through the viewer's filter, so it never shows what they may not see.
- **The closing column** of a board that manages its workflow is the rightmost by default, and
  follows it as columns move. The people who manage the board can choose another or none, and a
  choice stays with its column. Tickets already closed keep their close reason and history. A
  status other workflows share keeps its stage.

- **Outcomes** (T-079, the user's decision of 2026-11-03; AGL-024) lists the track's outcomes
  with their progress, on Scrum and Kanban tracks alike. How a Kanban track manages its outcomes
  (T-082) is still the user's question; this section only lists them.
  - `GET /api/v1/tracks/:id/outcomes` reads a page of up to 100 in one statement: the outcomes and,
    in a second common table expression of the same statement, the counts under them. The person's
    ticket filter is in both, as in search (QRY-008), so a hidden outcome is not listed and a hidden
    ticket under one counts for nothing. It is an internal route like the track's other sections,
    needs a read token, and emits nothing.
  - Order: open outcomes first, then closed ones, each by rank, the order the backlog's outcome panel
    uses. Rank is unique in a workspace, so a cursor of (closed, rank) pages without gaps or repeats.
  - Done is one definition everywhere progress shows: a direct child in a status of the closed stage
    (ADR-120), in one function, `childProgress`. The backlog's outcome panel counted tickets with a
    close reason until now; it uses the same function, so the panel and this section always agree.
    On a workflow that sets a close reason on entering Closed, as the default one does, nothing
    changes.
  - Each row leads to the ticket's own address, which opens it in the ticket pop-up. With none, the
    section says what an outcome is and names the outcome-level types the track offers, or says
    that an administrator can add one.
  - Measured on 2026-11-03: a page of a track with 1,000 outcomes and 100,000 tickets, median 21 ms
    (budget 100 ms, `track-outcomes.test.ts`). No index was added.

## Options considered

| Option | For | Against |
|---|---|---|
| One board per track (chosen) | One place to look; columns can be the statuses | Boards across tracks and personal boards go; many tests and an importer change |
| Free boards, hidden from the sidebar | No migration | A column cannot be a status when several boards map one workflow |
| A new "environment" level above tracks | The user's first word for it | A second concept for what a track already is |

## Consequences

- Reports across tracks on one board no longer exist; release and outcome reports still cross
  tracks.
- On the default workflow, a report by close reason counts closed tickets as Completed, unless a
  person sets another reason by hand.
- Filters on `stage = closed` follow the column's status: when the closing column moves, tickets
  closed before keep their reason but leave that filter. Revisit if that surprises people.
- RPT-006 now asks for one customizable Summary per track, as the user decided (the wording is still
  being confirmed with them). Dashboards shared with a track remain for more.
- Revisit if teams ask for a board across tracks again; a saved search or dashboard covers that now.
