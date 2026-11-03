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
  Releases, Files and links, Statistics. List and Releases were not in the user's list of sections;
  they stay because those pages exist and nothing replaces them. The sidebar has "Tracks" and no
  "Boards". "Tracks" opens the directory and expands with the current track, then the latest
  opened, up to eight, with a link to all of them; it collapses when the person leaves every track.
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
- **The closing column** of a board that manages its workflow is the rightmost by default, and
  follows it as columns move. The people who manage the board can choose another or none, and a
  choice stays with its column. Tickets already closed keep their close reason and history. A
  status other workflows share keeps its stage.

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
- Revisit if teams ask for a board across tracks again; a saved search or dashboard covers that now.
