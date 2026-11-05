# ADR-095: The Data Center import of boards, sprints, rank, releases and areas: queries translated and checked, rank keys that keep the order

- Status: Accepted
- Date: 2026-10-31
- Backlog: M1-093

## Context

M1-093 maps the agile part of a Data Center backup (IMP-004; spec 02a section 3, 01b section
3): boards, including a board whose filter spans several projects, their columns and quick
filters, sprints with their issues, the rank that orders every board and backlog, and the
projects' versions and components. It is done when every board and sprint of the golden
fixture matches.

Until now the synthetic backup held only the board and sprint rows (M1-087), and the importer
counted them as `not_imported_yet`. A board's filter is a saved filter (`SearchRequest`) whose
query is in the Jira-compatible dialect; saved filters themselves are M1-094's, built at the
same time. In a backup an issue's sprints are values of the agile plugin's sprint custom field,
and its rank a row of the plugin's rank table for the rank custom field, a string that orders
issues when compared as text (format notes 02d). M1-095 (ADR-094) added the framework kinds
`board` and `sprint` for the Cloud importer; native boards (M1-043, ADR-049) take their own
query, a sub-filter and board filters; ranks are fractional keys over 62 digits (AGL-009);
releases and areas are M1-014's.

## Decision

- **The fixture grows, in our own words** (`dc-backup/agile.ts`, `agile-format.ts`; notes 02d,
  every shape **Verify** or **Our choice**): versions and components per project, the issues'
  fix and affected versions and components (`NodeAssociation` rows from the issue), the plugin's
  sprint and rank fields, sprint values on the issues (closed sprints, sprints carried over, one
  open sprint at most), a rank row per issue in an order unlike the issue ids, columns with
  their statuses and limits, quick filters (one of them needing an app's function), Kanban
  sub-queries, and three boards more: a Scrum board across the first two projects with sprints
  of its own, a Kanban board of one component, and a Kanban board per business project. Every
  part draws from a seed stream of its own, so the facts earlier tasks generated stay as they
  were; their reports' goldens change only by the new kinds and counts. The validator checks the
  new references and counts the new cases (`validate-agile.ts`).
- **A stage part of its own** (`dc-backup/stage-agile.ts`). Versions, components, boards,
  columns, quick filters, sub-queries and sprints are small and kept in memory; the board's
  saved filter is read for its query but the element stays M1-094's. The rows that belong to an
  issue (its associations and rank row) go into the issue part's ticket buckets as extras and
  are folded into its ticket record when its bucket is joined, through two small hooks in
  `stage-issues.ts` (`extra`, `IssueResolve.extend`); the sprint field's values are taken out of
  the issue's custom values there and become the sprints' member lists, the only thing kept per
  issue (one entry per issue in a sprint). The active-objects reader now reads row values.
  `STAGE_VERSION` is 5.
- **Boards: the first project the filter names is where the board lives.** The filter's query
  is parsed and its `project` clauses read for keys, earlier keys, names or ids. A board whose
  filter names no project the backup holds fails with its reason. A board across two projects
  stays one board of the first track with the whole query, so it shows the same tickets.
  Sprints enabled make a Scrum board, otherwise Kanban.
- **Queries are translated, then checked against the target** (IMP-006). The mapper reads each
  query (the filter, a Kanban board's sub-query as the board's sub-filter, each quick filter as
  a board filter) in the Jira-compatible dialect and writes it in Taskmoor's names (`toNative`,
  then `printQuery`); ORDER BY is left out because a board orders by rank. A clause that names a
  saved filter or a sprint by the backup's id is refused in the mapper, since those ids mean
  nothing in the target yet. Custom fields keep the backup's ids, listed on the command, and the
  board loader writes the target's ids in their place. A custom field named by name is named by
  the backup's id first (2026-11-05, T-195): the stage keeps, per board, the ids of the backup's
  custom fields with each name its queries use, and the mapper puts `cf[<id>]` in place of a name
  no system field has. Left as a name, it would be read against the target's fields, where it can
  be another field: the Points every workspace starts with, when the backup's own Points holds
  text and arrived as "Points (imported)". A name several of the backup's fields have stays a
  name, and the command lists those fields with it: a field joins one here of its name and type,
  so two "Team" select fields usually become one, and the loader then names that one field. Only
  when they became different fields (one of them arrived as "Team (imported)", say) does the
  loader leave the query out (`query_names_ambiguous_field` with the name), since which one the
  source read cannot be told. Saved filters refuse such a name in either case (ADR-096): they are
  kept with the problem, where a board's query is left out. Then the loader binds
  every query as a board would read it with no viewer (a viewer id nobody has, so
  `currentUser()` resolves and finds no one); a query that does not resolve (an app's field or
  function, a value that did not import) is left out with a warning that names the filter and
  what it uses, as IMP-006 (2) asks. A dry run only parses, since what queries name may not exist yet. The board's query
  falls back to its track's tickets, as for Cloud boards.
- **Board settings the backup does not describe take the defaults** a new board gets
  (swimlanes, card rules, sprint settings); the quick filters replace the default board filters.
  Column limits are rounded to whole numbers, and a minimum above the maximum is dropped.
- **Sprints keep what the backup says.** State from the started and closed flags, the planned
  start and end, the completion time, the goal and the order (`SEQUENCE`); the planned start
  stands in for when a sprint was started, as the backup keeps nothing else. The sprint loader
  (ADR-094) keeps a closed sprint's tickets closed and a ticket in one open sprint at most.
- **Rank keys keep the order without sorting.** Each character of the backup's rank (`0`-`9`,
  `:`, `a`-`z`, `|`, compared as text) becomes the next rank digit in the same order, after the
  integer part `a1`, so the keys compare exactly as the ranks do, and no key ends with the digit
  0 (`rankKey`). The ticket loader keeps a source rank when no other ticket holds it, so a
  second import keeps them, and moves the rank sequence past them. Nothing is sorted and nothing
  per issue is kept for it, so it costs nothing at a million issues.
- **Versions become releases and components areas**, by name within the track, in their order;
  released and archived versions are shipped or archived on their release date (the backup keeps
  no other moment); the component's assignee type becomes the area's default assignee. The
  issue's fix versions, affected versions and components become its target and found releases
  and its areas; an association to another project's version is left out and counted.
- **The plugin's sprint and rank fields are not fields here.** They are skipped with the reasons
  `sprint_field_as_sprints` and `rank_field_as_rank`, so the report names them.
- **Scopes.** `configuration` imports releases, areas and boards; sprints, the rank table and the
  issues' associations are counted as `configuration_only`. `tickets` and `all` import them all.
- **A golden test reads the boards as people see them** (`dc-agile.test.ts`, 2,000 issues, seed
  93, six projects): every board's kind, track, query, sub-filter, columns, limits and board
  filters equal the fixture's in Taskmoor's names; every sprint's state, dates, goal, order and
  members; every ticket's rank order; every release, area and ticket association. Then each
  board is read through `GET /api/v1/boards/:id/data`, without and with each board filter, card
  by card in rank order and column, against what the fixture says it must show; and the
  cross-track board's backlog through `GET /api/v1/boards/:id/backlog`. A second import changes
  nothing.

## Options considered

| Option | For | Against |
|---|---|---|
| Rank digits for the backup's characters (chosen) | Order kept exactly; no sort; nothing in memory; stable on a second run | Imported keys sit among the target's early keys; a rank outside the alphabet falls to the bottom |
| Sort every issue by rank and give fresh keys | Short keys | A sort of a million issues in the stage, or a spill and merge; keys change when the backup does |
| A board per project of a cross-project filter | Each board in one track | Two boards where people had one; sprints would have to be split |
| A personal board for cross-project filters | No track chosen | The board's people lose it unless they own it; Cloud boards live in a project too |
| Translate only, check at read time | Simpler loader | A quick filter that names an app's function fails when someone clicks it, instead of in the report |
| Translate and check in the loader (chosen) | Every stored query resolves; IMP-006 (2) lists what does not | The loader reads the query catalogue once per batch |
| Sprint fields as read-only text | No special case | Sprints lose their tickets; the values are ids |
| Keep the board's saved filter as a saved search | One source of truth | M1-094's; a board query stored now still works if the saved filter is later edited apart |

## Consequences

- Measured on the golden fixture (2,000 issues, seed 93, six projects): 8 boards (6 Scrum, 2
  Kanban, one across two tracks), 22 sprints in every state, 33 columns, 31 quick filters (every
  one but the four that need an app's function imported, and reported), 19 releases, 20 areas,
  and every one of 2,000 tickets' rank order, releases and areas equal the fixture; each board
  read through the board route matches card by card with each of its filters. The test file runs
  in about 60 s here.
- At 100,000 issues (seed 1): generation 86 s and validation 29 s, staging 74 s (M1-091 measured
  69 s), RSS 637 MB, under a load average near 20 from other work; the active-objects file grows
  to 32 MB, most of it rank rows.
- Saved filters, dashboards and subscriptions are M1-094's; once saved filters import, a board
  could point at its saved search instead of a copy of its query. Swimlanes, card colours and
  layout, the estimation field, working days, board administrators and the board's owner are not
  generated or read yet (their tables would be counted as `not_imported_yet`). Sprint and rank
  changes in history are still left out (`history_field_not_mapped`).
- The rank alphabet, the sprint field's value column, the column limits as doubles and every
  other agile shape are **Verify** until a design partner's backup confirms them; the readers stay
  lenient (a sprint id in `stringvalue`, ranks of any field when no rank field row is there).
