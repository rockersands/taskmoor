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
  - **2026-11-04, the user's decision: free moving is the default wherever a workflow starts.** That
    is a new site (0089, and 0104 for the default workflows 0089 passed over because a seeded status
    was renamed or a draft was open), a board-managed workflow, a workflow created with no
    transitions (`POST /api/v1/workflows` with none builds a global transition into each status), a
    status added in the editor to a workflow that moves freely, a column given a path on a shared
    workflow (a closed-stage status sets Completed), and the sample data of `pnpm demo` and the AI
    evals, whose tracks now use the default workflow (`seedEvalDataset` sets its chosen close reasons
    by hand after the close; a demo seeded earlier has its tracks put back on the default map when it
    starts). A drag to a column several free transitions lead to takes the column's first status, with
    no question; the question stays where a candidate has a rule. A close reason a workflow sets
    cannot be deleted without a replacement (`409 used_by_workflow`), and the replacement goes into
    the workflow. Rules someone adds on purpose, and imported workflows, stay as they are.
  - **What "Completed" means when it was renamed or replaced.** One answer on the server
    (`closingReasonId`): the reason named Completed, else what the default workflow's published
    version sets on entering a closed-stage status, which follows it through a rename and a
    replacement; only with neither is a Completed made. The editor asks the server for it
    (`POST /api/v1/workflows/:id/completed-reason`) when it adds a closing status to a workflow that
    moves freely, rather than matching a name in a list that may be late or unreadable. If the
    request fails the status is not added and the editor says why.
  - **A definition cannot name a deleted reason.** Saving a draft, creating a workflow, restoring a
    version and publishing all refuse one (`unknown_close_reason`). Earlier versions stay as they
    were written, so a version from before a replacement cannot be restored, the same rule as a
    version naming a deleted status: we considered swapping in the replacement on restore, but no
    record says which reason replaced which. Migration 0105 repairs the sites where a reason was
    deleted before this rule: a published version or draft that names a missing reason now names
    Completed.
  - **2026-11-05: the edges the T-207 review found (T-209, T-210, T-234).** A free move here is a
    global transition with no guard, check, field or rule whose only effect sets or clears the close
    reason.
    - *A status that changes stage takes its free moves along* (T-209). Changing a status's stage
      (allowed only while no ticket is in it) rewrites the free moves into it on every workflow whose
      published version or draft has one: entering a status made closed-stage sets the reason free
      moves close with, so the ticket gets its Closed time, as a new closing column does; entering
      one that left the closed stage clears the reason. A changed published version becomes a new
      published version and the draft is rewritten in place or moved above it, as when a close
      reason is replaced. The status's one event, `status.updated`, names those workflows
      (`workflowIds`). A move with a rule, another effect or a reason someone chose stays as it is,
      and so does a board-managed workflow, whose board says which column closes, its draft included
      (one saved through the API may leave the board out). With no reason to close with, nothing
      changes. We considered
      deciding the effect at move time from the status's stage, with nothing rewritten; rejected
      because the definition, the editor and an exported file would then say something other
      than what happens.
    - *Lock order: the status list, then workflows, then statuses* (T-209). Every path that holds
      a workflow row and a status row in one transaction takes the workflow first:
      - a ticket write holds its workflow (key share) before the status it enters, and a draft
        save holds its workflow (no key update) before the statuses it names. *2026-11-06
        (T-237):* the draft save reads the stage of a status it gives a free move only with that
        status held too (key share, which it took anyway to write the version's statuses, now
        before the read). A stage change holds its status (update) while it rewrites the
        workflows that have it; a draft adding the status is not among them, and read without
        the lock it saw the stage from before the change and gave a move into a status made
        closed-stage no close reason. Held, it waits for the change and sees the new stage.
        Creating a workflow with no transitions reads its statuses the same way;
      - a stage change holds every workflow whose published version or draft has the status, in
        id order (no key update, so it never waits for a ticket write; it moves no ticket), then
        the status. Holding the status first deadlocked with a draft save. It holds no workflow
        after the status: when a draft saved while it waited for the status gave it another
        workflow to rewrite, it starts again (up to five times) and holds that workflow first;
      - a board's sync (management turned on, a column added without a status, a managed board's
        columns or closing column changed, the track's own board made) holds the status list, then
        its track's own workflow (update), and
        only then renames a column's status, makes one or settles their stages. It used to rename
        the status first and hold the workflow only to publish; a stage change holding that
        workflow and waiting for the status then deadlocked with it (`40P01`, a 500), so the stage
        change left board-managed workflows out, which missed a board taking over a workflow that
        had no board yet. With the sync holding the workflow first, the stage change holds
        board-managed workflows too and leaves them as they are on the row it holds. *2026-11-06
        (T-238):* whether a board may take its track's workflow over (no other track uses it, no
        guard, check or rule on it) is read after those two locks, not before: a check published
        between a read without them and the sync's new version was replaced by the board's
        columns. When the answer is no, the locks stay to the end of the board's change, as they
        would after a takeover. A column's path on a workflow the board does not manage holds the
        list (when the column needs a status made), then the workflow, and builds the new version
        on the published one read after that, so a version published meanwhile is kept;
      - the status list (`lockList`) comes before both: a workflow import holds it before the
        workflow, and deleting or reordering statuses before the statuses, so a sync that renamed
        a status and then waited for the list (to make a column's status) deadlocked with those.
    - *A status added through the draft API gets its free move* (T-210). Saving a draft
      (`PUT /api/v1/workflows/:id/draft`) on a workflow that moves freely, with a draft that still
      does, gives each status the draft adds and no transition reaches its global transition, as the
      editor's Add a status does. A draft with no transitions, or one saved on a workflow left with
      none, gets one into every status no transition reaches, as a new workflow does. New
      transitions number above every id any version of the workflow used. A closing status gets one
      only when there is a reason to set; no reason is made here, so the save stays one event. We
      chose this over a warning in the draft's answer because WF-008 (4) names any status added to a
      workflow that moves freely, not only the editor's. The server only adds: a status that was
      already in the workflow, a step someone drew, any draft with a rule and a board-managed
      workflow's draft (its board says which columns there are) stay as sent. An old workflow
      with no transitions gets its moves when its next draft is saved, or from the operator's
      repair below. The web editor saves with `transitionsAsSent`: its Add a status already gives
      a new status its free move, so a move missing from a draft that has transitions was deleted
      on purpose, and the server adds none (a draft with no transitions at all still gets them, as
      a new workflow does). Without it, a free move deleted from a status just added came back on
      the first save, and Publish, which saves first, could publish it.
    - *An old workflow left with no moves* (T-237, 2026-11-06). A workflow made empty before free
      moving was the rule (or imported from a file with no transitions, or published from an
      empty version restored as its draft: imports and restores keep what they hold) has a
      published version with no transitions, so no ticket in it can move, until someone saves its
      next draft. The operator's command `cli.mjs workflow-moves` lists them, one JSON line per
      workspace, and with `--repair` gives each a global transition into every status, as a new
      workflow gets, as a new published version: one transaction and one `workflow.published` by
      the system (no person) per workflow, holding it as a publish does, then its statuses, and
      checking it again under the lock, so one given transitions meanwhile stays as it is. A
      closing status takes the reason free moves close with; with none to name it gets no move,
      and no reason is made. Its draft stays as its author saved it, above the new version, as
      migration 0104 left drafts; saving it gives it its free moves. A workflow with a rule, or
      one a board manages, gets nothing and stays listed, and the command then exits with 1. We
      considered:
      - *a migration*, which would do the same at the next upgrade with nobody running anything.
        Not now: this wave may take no migration number, every site holding one from before the
        rule is a pre-release one, and an import or a restore can still make one after any
        migration, which the command, run when needed, covers too. A migration before 1.0 can
        reuse `repairWorkflowMoves` if wanted;
      - *the moves at read time*, when a ticket asks for its transitions: built in memory, the
        definition, the editor and an exported file would say something other than what happens
        (rejected for the same reason in T-209); written then, a read would publish a version,
        and a ticket write holds its workflow with key share, so two writes raising it to update
        at once would deadlock;
      - *the moves at the next publish*: only a draft is published, so a workflow with no draft
        stays as it is, and the editor's Publish saves first, which gives them already.
    - *A reason named Completed made after Completed was replaced* (T-234): open, for the user.
      The reason free moves close with (`closingReasonId`) stays as it was: the reason named
      Completed, else what the default workflow's published version sets on entering a
      closed-stage status. Replacing Completed rewrites every move that set it, so the free moves
      already there close with the replacement; a reason named Completed made afterwards takes the
      free moves made from then on, two reasons for one rule until the default workflow is
      published with one of them. Putting the default workflow's reason first was tried and
      dropped in review: a site whose default workflow closes some step with Not planned or
      Duplicate while Completed exists (its Close step asking for the reason and setting none)
      then had every new free move, closing column and status made closed-stage record done work
      as not planned. The ways out change what a site's tickets are closed with, so they wait on
      the user: the replacement stays the reason for good, chosen by the replacement itself rather
      than by the default workflow; or the new Completed takes the old free moves too, which
      means rewriting workflows when a reason is made or renamed.
    - *A default workflow's draft from the strict seed* (T-234). Migration 0104 left an open draft as
      its author saved it, so the editor showed the first, strict steps, and publishing them brought
      the old rules back. When the default workflow's draft still has the five seeded steps exactly
      as seeded (Start, Send to review, Back to active, Close with its required close reason, and
      Reopen), the editor says so and offers to replace them with the free moves the published
      version has, numbered as the steps they replace, with the reason free moves close with. Steps
      the author drew stay; when the rest moves freely too, a status no transition reaches gets its
      free move. It is an offer, not done on opening, because version 1 restored as the draft is a
      deliberate choice; nothing changes until the draft is saved. Another workflow with those steps
      is a copy someone made, and keeps them.
- **A board stays inside its track** after it is made. A saved search a track's board stands on
  cannot be changed to a query that leaves the track (`409 board_outside_track`, naming the boards).
  An import writes a track's board only with a query confined to it: anything else becomes
  `track = KEY`, with the warning `board_query_narrowed_to_track` holding the source's query.
- **Statistics** is every report of the track in one place: flow, sprints, releases and outcomes,
  its tickets, and the time and workload on them (below, "Summary and Statistics finished"). The ticket reports reuse the dashboard widgets' data and views through
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

- **Summary and Statistics finished** (T-075, T-076; RPT-001, RPT-002, RPT-005, RPT-006). Of the
  reports the spec gives a track, six were missing: time since, single level group by, time
  tracking, user workload, release workload and the workload pie chart, and the outcome report.
  Created vs closed and two-dimensional statistics, which the ticket named, were already there.
  - **The missing general reports are widget kinds**, not a second kind of report: `time-since`
    (shown as **Tickets by date**), `group-by` (**Grouped tickets**), `workload` and
    `time-tracking`. So the track's Statistics, its Summary and any dashboard read them the same
    way, and the track owner can put any of them on the Summary. Statistics reads them through
    `GET /tracks/:id/statistics/:kind`, still with no query; the pie chart joined that list.
  - **One workload kind, three reports.** Workload by person (the open tickets' remaining estimate
    by assignee), a release's workload (the same for the tickets that target a release) and the
    workload pie chart (any time measure by any field) are one kind with settings: `field`,
    `statistic`, `open`, `release` and `view`. The spec's user workload spans tracks; inside a
    track it is by person, and a dashboard with a query covers more than one track.
  - **Done is the closed stage** in the new reports (grouped tickets' done count, the workload's
    open tickets), the one definition progress uses (ADR-120), so `stage = closed` finds the same
    tickets. The reports from history keep their own rule: created vs closed, time to close and
    average age count a close reason set or cleared (ADR-059), so a reopened ticket's past stays
    as it was; on the default workflow both rules agree.
  - **Time tracking** adds up each ticket's own time spent, which is the sum of its time entries,
    those the person may not read included, as the ticket page shows it. It says when time
    tracking is off rather than showing zeros.
  - **The outcome report** (`GET /boards/:id/reports/outcome-report`) is the release report's
    chart for an outcome, from the first day a ticket came under it, with its tickets as they
    stand: done, still open, and open without an estimate. Like the other release and outcome
    reports it follows the Scrum board's estimation and done columns, so a Kanban track does not
    list it; how a Kanban track manages outcomes is still the user's question (T-082).
  - **Every number equals a search.** `track-reports.test.ts` checks each count against the search
    API, and each sum against the tickets that search finds, as two people a visibility level
    tells apart, on a Scrum and a Kanban track; and that a Summary widget with no query reads
    exactly what its report reads.
  - **Speed.** Average age looked into the history once per ticket and period; it now reads the
    spans each close reason was set in and keeps the tickets outside them, one anti-join. Measured
    on 2026-11-03 on a Mac, a track of 100,000 tickets read by a member, median of three reads:
    every report between 25 and 274 ms (average age 1,283 ms before), the Summary's numbers 84 ms,
    against a budget of 1,000 ms each (RPT-002 (3) asks 3 s at a million tickets). Every gate
    reads a track of 10,000; `TASKMOOR_LARGE_TRACK_REPORTS=1` reads 100,000. No index or migration
    was needed.
  - **Not done:** RPT-006 says members "view and filter" the Summary. Members read it as the
    owner set it; a filter of their own over all its widgets is not built, as the user's decision
    names only customizing by the owner. Numbers in the new reports are not links to their
    searches yet, unlike the default Summary's.

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
